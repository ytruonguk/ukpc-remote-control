import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import { Pool } from 'pg';
import {
  capsDiff,
  capsHash,
  deviceIdFromTopic,
  keys,
  liveHashPatch,
  mqttTopics,
  TTL,
  type Caps,
  type StateMsg,
} from '@rc/shared';

@Injectable()
export class IngestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(IngestService.name);
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  private readonly pg = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://rc:rc@localhost:5432/rc',
  });
  private client!: MqttClient;
  private tail = Promise.resolve();

  async onModuleInit() {
    this.client = mqtt.connect(process.env.MQTT_URL ?? 'mqtt://localhost:1883', {
      clientId: `rc-ingest-${process.pid}`,
      clean: true,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
    });

    this.client.on('connect', () => {
      const topics = [
        mqttTopics.shareState,
        mqttTopics.shareProbe,
        'rc/state/+',
        'rc/probe/+',
      ];
      this.client.subscribe(topics, { qos: 1 }, (err, granted) => {
        this.log.log(`mqtt sub err=${err?.message ?? 'ok'} granted=${JSON.stringify(granted)}`);
      });
    });
    this.client.on('error', (err) => this.log.error(err.message));

    this.client.on('message', (topic, payload) => {
      const raw = payload.toString();
      this.tail = this.tail
        .then(() => this.onMessage(topic, raw))
        .catch((err) => this.log.warn(`ingest: ${String(err)}`));
    });
  }

  onModuleDestroy() {
    this.client?.end(true);
    void this.redis.quit();
    void this.pg.end();
  }

  private async onMessage(topic: string, raw: string) {
    const deviceId = deviceIdFromTopic(topic);
    if (!deviceId) return;
    let msg: StateMsg;
    try {
      msg = JSON.parse(raw) as StateMsg;
    } catch {
      this.log.warn(`bad json on ${topic}`);
      return;
    }

    if (topic.includes('/probe/')) {
      await this.redis.lpush(`probe:wait:${deviceId}`, raw);
      await this.redis.expire(`probe:wait:${deviceId}`, 10);
      if (msg.caps && msg.agentVer) await this.onState(deviceId, msg);
      return;
    }

    await this.onState(deviceId, msg);
  }

  private async onState(deviceId: string, msg: StateMsg) {
    await this.ensureDevice(deviceId);

    if (msg.androidId) {
      const reset = await this.checkFactoryReset(deviceId, msg.androidId);
      if (reset) {
        await this.redis.hset(keys.device(deviceId), liveHashPatch(msg));
        await this.redis.expire(keys.device(deviceId), TTL.device);
        await this.pg.query(`UPDATE devices SET last_seen = now() WHERE device_id = $1`, [deviceId]);
        return;
      }
    }

    await this.redis.hset(keys.device(deviceId), liveHashPatch(msg));
    await this.redis.expire(keys.device(deviceId), TTL.device);
    await this.pg.query(`UPDATE devices SET last_seen = now() WHERE device_id = $1`, [deviceId]);

    if (!msg.caps || !msg.agentVer) return;

    const hash = capsHash(msg.caps, msg.agentVer);
    const cached = await this.redis.hget(keys.deviceCaps(deviceId), 'capsHash');
    if (cached === hash) return;

    const prev = await this.findCaps(deviceId);
    await this.upsertCaps(deviceId, msg.caps, msg.agentVer, hash);
    const changed = capsDiff(prev, msg.caps);
    if (Object.keys(changed).length) {
      await this.pg.query(
        `INSERT INTO capability_events (device_id, changed) VALUES ($1, $2::jsonb)`,
        [deviceId, JSON.stringify(changed)],
      );
    }
    await this.redis.hset(keys.deviceCaps(deviceId), {
      agentVer: msg.agentVer,
      projectMedia: msg.caps.projectMedia,
      a11y: String(msg.caps.a11y),
      knox: msg.caps.knox,
      overlay: String(msg.caps.overlay),
      secureSettings: String(msg.caps.secureSettings),
      capsHash: hash,
    });
    this.log.log(`caps changed ${deviceId} hash=${hash}`);
  }

  private async ensureDevice(deviceId: string) {
    await this.pg.query(
      `INSERT INTO devices (device_id, group_id)
       SELECT $1, id FROM device_groups WHERE name = 'default'
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId],
    );
  }

  private async checkFactoryReset(deviceId: string, reported: string): Promise<boolean> {
    const { rows } = await this.pg.query<{ android_id: string | null }>(
      `SELECT android_id FROM devices WHERE device_id = $1`,
      [deviceId],
    );
    const stored = rows[0]?.android_id;
    if (stored && stored !== reported) {
      this.log.warn(`factory reset suspected ${deviceId}`);
      await this.pg.query(
        `UPDATE devices SET android_id = $2, needs_reprovisioning = true WHERE device_id = $1`,
        [deviceId, reported],
      );
      await this.pg.query(
        `UPDATE device_capabilities
         SET a11y = false, overlay = false, secure_settings = false,
             project_media = 'blocked', knox = 'unlicensed', updated_at = now()
         WHERE device_id = $1`,
        [deviceId],
      );
      await this.redis.del(keys.deviceCaps(deviceId));
      return true;
    }
    await this.pg.query(`UPDATE devices SET android_id = $2 WHERE device_id = $1`, [deviceId, reported]);
    return false;
  }

  private async findCaps(deviceId: string): Promise<Caps | null> {
    const { rows } = await this.pg.query<{
      project_media: string;
      a11y: boolean;
      knox: string;
      overlay: boolean;
      secure_settings: boolean;
      encoder_name: string | null;
      encoder_hw: boolean | null;
    }>(`SELECT * FROM device_capabilities WHERE device_id = $1`, [deviceId]);
    const r = rows[0];
    if (!r) return null;
    return {
      projectMedia: r.project_media as Caps['projectMedia'],
      a11y: r.a11y,
      knox: r.knox as Caps['knox'],
      overlay: r.overlay,
      secureSettings: r.secure_settings,
      encoder: r.encoder_name ? { name: r.encoder_name, hw: Boolean(r.encoder_hw) } : undefined,
    };
  }

  private async upsertCaps(deviceId: string, caps: Caps, agentVer: string, hash: string) {
    await this.pg.query(
      `INSERT INTO device_capabilities
         (device_id, agent_ver, project_media, a11y, knox, overlay, secure_settings,
          encoder_name, encoder_hw, caps_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (device_id) DO UPDATE SET
         agent_ver = EXCLUDED.agent_ver,
         project_media = EXCLUDED.project_media,
         a11y = EXCLUDED.a11y,
         knox = EXCLUDED.knox,
         overlay = EXCLUDED.overlay,
         secure_settings = EXCLUDED.secure_settings,
         encoder_name = EXCLUDED.encoder_name,
         encoder_hw = EXCLUDED.encoder_hw,
         caps_hash = EXCLUDED.caps_hash,
         updated_at = now()`,
      [
        deviceId,
        agentVer,
        caps.projectMedia,
        caps.a11y,
        caps.knox,
        caps.overlay,
        caps.secureSettings,
        caps.encoder?.name ?? null,
        caps.encoder?.hw ?? null,
        hash,
      ],
    );
  }
}
