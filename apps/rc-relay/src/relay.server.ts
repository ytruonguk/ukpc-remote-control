import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Server as HttpServer } from 'node:http';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { keys, shouldSendViewerJoin, TTL } from '@rc/shared';

type RelaySession = {
  id: string;
  deviceId: string;
  operatorId: number;
  agent?: WebSocket;
  viewer?: WebSocket;
  codecConfig?: Buffer;
  bytesOut: number;
  inputEvents: number;
  lastActivity: number;
  viewerGoneTimer?: NodeJS.Timeout;
};

const MAX_PAYLOAD = 4 * 1024 * 1024;
const IDLE_MS = 600_000;
const BACKPRESSURE_BYTES = 1_000_000;
const VIEWER_GONE_MS = 1_500;

@Injectable()
export class RelayServer implements OnModuleDestroy {
  private readonly log = new Logger(RelayServer.name);
  private readonly sessions = new Map<string, RelaySession>();
  private readonly node = process.env.RELAY_NODE ?? 'local';
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  private readonly pg = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://rc:rc@localhost:5432/rc',
  });
  private readonly lag = monitorEventLoopDelay({ resolution: 10 });
  private wss?: WebSocketServer;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly jwt: JwtService) {
    this.lag.enable();
  }

  attach(server: HttpServer) {
    server.on('connection', (socket) => socket.setNoDelay(true));

    this.wss = new WebSocketServer({
      server,
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD,
    });

    this.wss.on('connection', (ws, req) => {
      const early: Array<{ data: Buffer; isBinary: boolean }> = [];
      const stash = (data: RawData, isBinary: boolean) => {
        early.push({ data: toBuffer(data), isBinary });
      };
      ws.on('message', stash);
      void this.onConnection(ws, req.url ?? '/', early, stash);
    });

    this.timers.push(setInterval(() => this.tick(), 1000));
    this.timers.push(setInterval(() => this.reportLag(), 10_000));
    void this.redis.sadd(keys.relayNodes, this.node);
    this.log.log(`relay ${this.node} attached`);
  }

  async onModuleDestroy() {
    this.timers.forEach(clearInterval);
    this.wss?.close();
    await this.redis.srem(keys.relayNodes, this.node);
    await this.redis.quit();
    await this.pg.end();
  }

  private async onConnection(
    ws: WebSocket,
    url: string,
    early: Array<{ data: Buffer; isBinary: boolean }>,
    stash: (data: RawData, isBinary: boolean) => void,
  ) {
    const { pathname, searchParams } = new URL(url, 'http://relay.local');
    const token = searchParams.get('token') ?? '';
    const role = pathname.endsWith('/agent') ? 'agent' : pathname.endsWith('/viewer') ? 'viewer' : null;
    if (!role) {
      ws.close(1008, 'bad_path');
      return;
    }

    try {
      const payload = this.jwt.verify<{
        sid: string;
        did?: string;
        uid?: number;
        node?: string;
        aud: string;
        jti?: string;
      }>(token, { audience: role });

      if (payload.node && payload.node !== this.node) {
        ws.close(1008, 'wrong_node');
        return;
      }

      if (role === 'agent') {
        if (!payload.jti) {
          ws.close(1008, 'missing_jti');
          return;
        }
        const once = await this.redis.set(keys.tokenUsed(payload.jti), '1', 'EX', TTL.tokenUsed, 'NX');
        if (!once) {
          ws.close(1008, 'replay');
          return;
        }
      }

      ws.off('message', stash);
      const session = this.getOrCreate(payload.sid, payload.did ?? '', payload.uid ?? 0);
      if (payload.did) session.deviceId = payload.did;
      if (role === 'agent') {
        this.onAgentJoin(session, ws, payload.did ?? '');
        for (const m of early) this.onAgentMessage(session, m.data, m.isBinary);
      } else {
        this.onViewerJoin(session, ws);
        for (const m of early) this.onViewerMessage(session, m.data, m.isBinary);
      }
    } catch {
      ws.close(1008, 'unauthorized');
    }
  }

  private getOrCreate(id: string, deviceId: string, operatorId: number): RelaySession {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const created: RelaySession = {
      id,
      deviceId,
      operatorId,
      bytesOut: 0,
      inputEvents: 0,
      lastActivity: Date.now(),
    };
    this.sessions.set(id, created);
    return created;
  }

  private onAgentJoin(s: RelaySession, ws: WebSocket, deviceId: string) {
    s.agent = ws;
    if (deviceId) s.deviceId = deviceId;
    ws.on('message', (data, isBinary) => this.onAgentMessage(s, toBuffer(data), isBinary));
    ws.on('close', () => {
      if (s.agent === ws) this.closeSession(s, 'agent_disconnect');
    });
    if (shouldSendViewerJoin({ peer: 'agent', otherOpen: s.viewer?.readyState === WebSocket.OPEN })) {
      ws.send(JSON.stringify({ t: 'viewer.join' }));
    }
    this.markActive(s);
  }

  private onViewerJoin(s: RelaySession, ws: WebSocket) {
    if (s.viewerGoneTimer) {
      clearTimeout(s.viewerGoneTimer);
      s.viewerGoneTimer = undefined;
    }
    s.viewer = ws;
    if (s.codecConfig) ws.send(s.codecConfig, { binary: true });
    if (shouldSendViewerJoin({ peer: 'viewer', otherOpen: s.agent?.readyState === WebSocket.OPEN })) {
      s.agent?.send(JSON.stringify({ t: 'viewer.join' }));
    }
    ws.on('message', (data, isBinary) => this.onViewerMessage(s, toBuffer(data), isBinary));
    ws.on('close', () => {
      if (s.viewer !== ws) return;
      s.viewer = undefined;
      // ponytail: 1.5s grace so StrictMode remount / brief reconnect does not kill the agent
      s.viewerGoneTimer = setTimeout(() => {
        if (!s.viewer) this.closeSession(s, 'viewer_disconnect');
      }, VIEWER_GONE_MS);
    });
    this.markActive(s);
  }

  private onAgentMessage(s: RelaySession, data: Buffer, isBinary: boolean) {
    const binary = isBinary || data[0] === 0x01 || data[0] === 0x02 || data[0] === 0x03 || data[0] === 0x04;
    if (binary) {
      if (data[0] === 0x01) s.codecConfig = Buffer.from(data);
      s.bytesOut += data.length;
    } else {
      const txt = data.toString('utf8');
      if (txt.includes('"t":"log"')) this.log.log(`diag ${s.deviceId} ${txt.slice(0, 500)}`);
    }
    if (s.viewer?.readyState === WebSocket.OPEN) {
      s.viewer.send(data, { binary });
    }
    s.lastActivity = Date.now();
  }

  private onViewerMessage(s: RelaySession, data: Buffer, isBinary: boolean) {
    s.inputEvents += 1;
    if (s.agent?.readyState === WebSocket.OPEN) {
      s.agent.send(data, { binary: isBinary });
    }
    s.lastActivity = Date.now();
  }

  private tick() {
    void this.redis.set(keys.relayLoad(this.node), String(this.sessions.size), 'EX', TTL.relayLoad);
    void this.redis.sadd(keys.relayNodes, this.node);
    for (const s of this.sessions.values()) {
      const q = s.viewer?.bufferedAmount ?? 0;
      if (q > BACKPRESSURE_BYTES) {
        s.agent?.send(JSON.stringify({ t: 'quality', bitrate: 600_000 }));
      }
      if (Date.now() - s.lastActivity > IDLE_MS) this.closeSession(s, 'idle_timeout');
    }
  }

  private reportLag() {
    const p99 = this.lag.percentile(99) / 1e6;
    this.log.debug(`relay.loop_lag_p99_ms=${p99.toFixed(2)} sessions=${this.sessions.size}`);
    this.lag.reset();
  }

  private markActive(s: RelaySession) {
    if (s.agent?.readyState !== WebSocket.OPEN || s.viewer?.readyState !== WebSocket.OPEN) return;
    void this.pg
      .query(
        `UPDATE sessions
         SET state = 'active', connected_at = COALESCE(connected_at, now())
         WHERE id = $1 AND state IN ('probing','starting')`,
        [s.id],
      )
      .catch((err) => this.log.warn(`markActive skipped: ${String(err)}`));
  }

  private closeSession(s: RelaySession, reason: string) {
    if (s.viewerGoneTimer) {
      clearTimeout(s.viewerGoneTimer);
      s.viewerGoneTimer = undefined;
    }
    s.agent?.close();
    s.viewer?.close();
    this.sessions.delete(s.id);
    const toDel = [keys.session(s.id)];
    if (s.deviceId) toDel.push(keys.activeSession(s.deviceId));
    void this.redis.del(...toDel);
    void this.pg.query(
      `UPDATE sessions
       SET state = 'closed', ended_at = now(), fail_reason = $2, bytes_out = $3, input_events = $4
       WHERE id = $1 AND state IN ('probing','starting','active')`,
      [s.id, reason, s.bytesOut, s.inputEvents],
    );
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
