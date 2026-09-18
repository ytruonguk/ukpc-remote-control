import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { computeReadiness, keys, mqttTopics, TTL, type EntryPoint } from '@rc/shared';
import { config } from '../config';
import { DevicesService } from '../devices/devices.service';
import { HmdmClient } from '../hmdm/hmdm.client';
import { MqttService, PgService, RedisService } from '../infra/infra.module';

@Injectable()
export class SessionsService {
  constructor(
    private readonly devices: DevicesService,
    private readonly redis: RedisService,
    private readonly pg: PgService,
    private readonly mqtt: MqttService,
    private readonly jwt: JwtService,
    private readonly hmdm: HmdmClient,
  ) {}

  async start(deviceId: string, operatorId: number, entry: EntryPoint, peerIp?: string) {
    await this.devices.assertGroupAccess(operatorId, deviceId);

    const sid = randomUUID();
    const occupied = await this.redis.set(
      keys.activeSession(deviceId),
      sid,
      'EX',
      TTL.session,
      'NX',
    );
    if (!occupied) throw new ConflictException({ code: 'DEVICE_BUSY' });

    try {
      const state = await this.devices.getState(deviceId);
      const readiness = computeReadiness(state);
      if (readiness.tier === 'NOT_READY' || readiness.tier === 'OFFLINE') {
        throw new UnprocessableEntityException({
          code: readiness.tier,
          blockers: readiness.blockers ?? [],
        });
      }

      await this.pg.pool.query(
        `INSERT INTO sessions (id, device_id, operator_id, relay_node, state, entry_point, peer_ip)
         VALUES ($1, $2, $3, $4, 'probing', $5, $6::inet)`,
        [sid, deviceId, operatorId, 'pending', entry, peerIp ?? null],
      );

      const probe = await this.devices.probe(deviceId, 3000);
      if (!probe) {
        const woke = await this.hmdm.wake(deviceId);
        if (!woke || !(await this.devices.probe(deviceId, 8000))) {
          return this.fail(sid, deviceId, 'device_unreachable');
        }
      }

      const node = await this.pickLeastLoaded();
      const agentJti = randomUUID();
      const agentToken = this.jwt.sign(
        { sid, did: deviceId, node },
        { expiresIn: config.agentJwtExpiresIn(), audience: 'agent', jwtid: agentJti },
      );
      const viewerToken = this.jwt.sign(
        { sid, did: deviceId, uid: operatorId, node },
        { expiresIn: 1800, audience: 'viewer' },
      );

      await this.pg.pool.query(
        `UPDATE sessions SET state = 'starting', relay_node = $2 WHERE id = $1`,
        [sid, node],
      );
      await this.redis.hset(keys.session(sid), {
        deviceId,
        operatorId: String(operatorId),
        node,
        state: 'starting',
        startedAt: String(Date.now()),
      });
      await this.redis.expire(keys.session(sid), TTL.session);

      const wsScheme = config.relayWsScheme();
      const host = config.relayPublicHost();
      await this.mqtt.publish(
        mqttTopics.cmd(deviceId),
        {
          type: 'session.start',
          sessionId: sid,
          wsUrl: `${wsScheme}://${host}/agent`,
          token: agentToken,
        },
        { qos: 1 },
      );

      return {
        sessionId: sid,
        wsUrl: `${wsScheme}://${host}/viewer`,
        token: viewerToken,
      };
    } catch (err) {
      await this.redis.del(keys.activeSession(deviceId));
      throw err;
    }
  }

  async close(id: string, operatorId: number) {
    const { rows } = await this.pg.pool.query<{ device_id: string; operator_id: number }>(
      `SELECT device_id, operator_id FROM sessions WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException();
    if (rows[0].operator_id !== operatorId) {
      const admin = await this.pg.pool.query(`SELECT role FROM operators WHERE id = $1`, [operatorId]);
      if (admin.rows[0]?.role !== 'admin') throw new NotFoundException();
    }
    await this.pg.pool.query(
      `UPDATE sessions SET state = 'closed', ended_at = now() WHERE id = $1 AND state <> 'closed'`,
      [id],
    );
    await this.redis.del(keys.activeSession(rows[0].device_id), keys.session(id));
    await this.mqtt.publish(
      mqttTopics.cmd(rows[0].device_id),
      { type: 'session.stop', sessionId: id },
      { qos: 1 },
    );
    return { ok: true };
  }

  async list(filters: { deviceId?: string; operatorId?: string; from?: string; to?: string }) {
    const { rows } = await this.pg.pool.query(
      `SELECT id, device_id, operator_id, relay_node, state, entry_point,
              requested_at, connected_at, ended_at, fail_reason, bytes_out, input_events, peer_ip
       FROM sessions
       WHERE ($1::text IS NULL OR device_id = $1)
         AND ($2::int IS NULL OR operator_id = $2)
         AND ($3::timestamptz IS NULL OR requested_at >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR requested_at <= $4::timestamptz)
       ORDER BY requested_at DESC
       LIMIT 200`,
      [
        filters.deviceId ?? null,
        filters.operatorId ? Number(filters.operatorId) : null,
        filters.from ?? null,
        filters.to ?? null,
      ],
    );
    return rows;
  }

  private async pickLeastLoaded(): Promise<string> {
    const nodes = await this.redis.smembers(keys.relayNodes);
    if (!nodes.length) return config.relayNode();
    const pipe = this.redis.pipeline();
    for (const n of nodes) pipe.get(keys.relayLoad(n));
    const loads = (await pipe.exec()) ?? [];
    let best = nodes[0];
    let bestLoad = Number.POSITIVE_INFINITY;
    nodes.forEach((n, i) => {
      const load = Number(loads[i]?.[1] ?? 0);
      if (load < bestLoad) {
        best = n;
        bestLoad = load;
      }
    });
    return best;
  }

  private async fail(sid: string, deviceId: string, reason: string) {
    await this.pg.pool.query(
      `UPDATE sessions SET state = 'failed', fail_reason = $2, ended_at = now() WHERE id = $1`,
      [sid, reason],
    );
    await this.redis.del(keys.activeSession(deviceId));
    throw new UnprocessableEntityException({ code: 'FAILED', failReason: reason, sessionId: sid });
  }
}
