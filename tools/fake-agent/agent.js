import { readFileSync, existsSync } from 'node:fs';
import mqtt from 'mqtt';
import { WebSocket } from 'ws';
import { buildFrames, pack, sleep } from './annexb.js';
import { syntheticH264 } from './synthetic-h264.js';

export const FULL_CAPS = {
  projectMedia: 'allow',
  a11y: true,
  knox: 'licensed',
  overlay: true,
  secureSettings: true,
};

function loadFrames(videoPath) {
  const raw = videoPath && existsSync(videoPath) ? readFileSync(videoPath) : syntheticH264();
  return buildFrames(raw);
}

const live = new Set();

export class FakeAgent {
  constructor(opts) {
    this.deviceId = opts.deviceId;
    this.broker = opts.broker ?? 'mqtt://127.0.0.1:1883';
    this.caps = { ...FULL_CAPS, ...(opts.caps ?? {}) };
    this.heartbeatMs = (opts.heartbeat ?? 120) * 1000;
    this.probeDelay = opts.probeDelay ?? 0;
    this.dropKeyframe = Boolean(opts.dropKeyframe);
    this.ignoreViewerJoin = Boolean(opts.ignoreViewerJoin);
    this.slowWs = opts.slowWs ?? 0;
    this.noReconnect = Boolean(opts.noReconnect);
    this.androidId = opts.androidId ?? `and-${this.deviceId}`;
    this.agentVer = opts.agentVer ?? '1.2.0';
    this.inputLog = [];
    this.currentBitrate = 1_500_000;
    this.forceKeyframeNext = false;
    this.frames = loadFrames(opts.video);
    this.volatile = { screenOn: true, charging: true, batteryPct: 87, net: 'wifi', rssi: -58 };
    this.onSelfHealCb = opts.onSelfHeal;
    this.autoStream = opts.autoStream !== false;
    this.pendingSession = null;
    this.streamStartedAt = 0;
  }

  static start(deviceId, opts = {}) {
    const agent = new FakeAgent({ deviceId, ...opts });
    return agent.connect();
  }

  onSelfHeal(cb) {
    this.onSelfHealCb = cb;
  }

  setCaps(caps) {
    this.caps = { ...this.caps, ...caps };
    this.publishState(true);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.broker, {
        clientId: this.deviceId,
        username: this.deviceId,
        clean: false,
        keepalive: 60,
        reconnectPeriod: this.noReconnect ? 0 : 2000,
        will: {
          topic: `rc/state/${this.deviceId}`,
          payload: JSON.stringify({ online: false, ts: Math.floor(Date.now() / 1000) }),
          qos: 1,
          retain: true,
        },
      });
      this.client.once('error', reject);
      this.client.on('connect', () => {
        live.add(this);
        this.client.subscribe(`rc/cmd/${this.deviceId}`, { qos: 1 });
        this.publishState(true);
        this.startHeartbeat();
        resolve(this);
      });
      this.client.on('message', (_topic, payload) => {
        void this.onCmd(payload.toString());
      });
    });
  }

  publishState(full) {
    const msg = full
      ? {
          online: true,
          agentVer: this.agentVer,
          androidId: this.androidId,
          caps: this.caps,
          volatile: this.volatile,
          ts: Date.now(),
        }
      : { volatile: this.volatile, ts: Date.now() };
    this.client.publish(`rc/state/${this.deviceId}`, JSON.stringify(msg), { qos: 1, retain: full });
  }

  startHeartbeat() {
    this.hbTimer = setInterval(() => this.publishState(false), this.heartbeatMs);
  }

  async onCmd(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'probe') {
      await sleep(this.probeDelay);
      this.client.publish(`rc/probe/${this.deviceId}`, JSON.stringify({ ok: true, ts: Date.now() }), { qos: 1 });
      return;
    }
    if (msg.type === 'selfheal') {
      this.onSelfHealCb?.();
      return;
    }
    if (msg.type === 'session.start') {
      this.pendingSession = msg;
      if (this.autoStream) await this.openStream(msg.wsUrl, msg.token);
    }
  }

  async openStream(wsUrl, token) {
    const url = `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {});
    this.ws.on('message', (raw) => this.onWsMessage(raw));
    try {
      await new Promise((resolve, reject) => {
        this.ws.once('open', resolve);
        this.ws.once('error', reject);
        this.ws.once('close', () => reject(new Error('agent ws closed')));
      });
    } catch {
      return;
    }
    void this.stream();
  }

  onWsMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === 'viewer.join' && !this.ignoreViewerJoin) this.forceKeyframeNext = true;
    if (m.t === 'quality') this.currentBitrate = m.bitrate;
    if (['touch', 'key', 'text', 'scroll', 'pointer', 'hello'].includes(m.t)) this.inputLog.push(m);
  }

  async stream() {
    const frames = this.frames;
    if (!frames.length || !this.ws) return;
    const FRAME_US = 33_333;
    let i = 0;
    let pts = 0;
    const t0 = Date.now();
    this.streamStartedAt = t0;
    const lastIdr = frames.findLastIndex?.((f) => f.type === 0x02) ?? frames.findIndex((f) => f.type === 0x02);
    const cfg = frames.find((f) => f.type === 0x01);
    if (cfg) this.ws.send(pack(0x01, 0, cfg.data), { binary: true });

    while (this.ws?.readyState === WebSocket.OPEN) {
      if (this.forceKeyframeNext && lastIdr >= 0) {
        i = lastIdr;
        this.forceKeyframeNext = false;
      }
      const f = frames[i % frames.length];
      if (f.type === 0x02 && this.dropKeyframe) {
        i++;
        continue;
      }
      if (f.type !== 0x01) {
        this.ws.send(pack(f.type, pts, f.data), { binary: true });
        pts += FRAME_US;
      }
      i++;
      if (this.slowWs) await sleep(this.slowWs);
      const target = t0 + pts / 1000;
      await sleep(Math.max(0, target - Date.now()));
    }
  }

  killSocket() {
    this.client?.stream?.destroy();
  }

  async stop() {
    live.delete(this);
    clearInterval(this.hbTimer);
    const socket = this.ws;
    this.ws = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      try {
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      } catch {
        /* already closed */
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      try {
        this.client?.end(true, {}, () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

export async function stopAllAgents() {
  await Promise.all([...live].map((a) => a.stop()));
}
