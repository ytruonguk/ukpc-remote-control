import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import { Pool } from 'pg';
import {
  capsDiff,
  capsHash,
  deviceIdFromTopic,
  HW_AUTO_DUMP_CODES,
  hwLivePatch,
  isHwEventCode,
  keys,
  liveHashPatch,
  mqttTopics,
  normalizeAgentConn,
  normalizeBrokerEvent,
  normalizeHwSample,
  parseSysClientTopic,
  TTL,
  type Caps,
  type StateMsg,
  volatileHasHw,
} from '@rc/shared';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_DUMP_SAMPLES = 200;

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Đồng hồ máy có thể lệch/hỏng: quá 1 ngày so với server thì dùng giờ server. */
function saneTs(ts: unknown, now = Date.now()): number {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 && Math.abs(n - now) < DAY_MS ? n : now;
}

type EventMsg = { code?: unknown; msg?: unknown; ts?: unknown };
type DumpMsg = { nonce?: unknown; conn?: unknown };

@Injectable()
export class IngestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(IngestService.name);
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  private readonly pg = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://rc:rc@localhost:5432/rc',
  });
  private client!: MqttClient;
  private tail = Promise.resolve();
  private pruneTimer?: NodeJS.Timeout;
  // Lưu mẫu heartbeat tối đa mỗi N giây/máy (0 = mọi heartbeat) để fleet lớn không ghi dồn.
  private readonly hbStoreSec = envNum('HW_HB_STORE_SEC', 90);
  private readonly autoDump = !['0', 'false'].includes(String(process.env.HW_AUTO_DUMP ?? '1').toLowerCase());
  // Ít nhất 1 ngày, số nguyên: 0 sẽ xoá sạch mỗi giờ, số thập phân làm câu SQL lỗi.
  private readonly sampleDays = Math.max(1, Math.floor(envNum('HW_SAMPLE_RETENTION_DAYS', 14)));
  private readonly connDays = Math.max(1, Math.floor(envNum('CONN_EVENT_RETENTION_DAYS', 30)));
  private readonly eventDays = Math.max(1, Math.floor(envNum('HW_EVENT_RETENTION_DAYS', 90)));

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
        mqttTopics.shareEvent,
        // Lý do ngắt kết nối do broker báo (cần quy tắc $SYS/# trong ACL). Không dùng $share: trùng lặp do UNIQUE chặn.
        '$SYS/brokers/+/clients/+/connected',
        '$SYS/brokers/+/clients/+/disconnected',
        'rc/state/+',
        'rc/probe/+',
      ];
      this.client.subscribe(topics, { qos: 1 }, (err, granted) => {
        this.log.log(`mqtt sub err=${err?.message ?? 'ok'} granted=${JSON.stringify(granted)}`);
      });
    });
    this.client.on('error', (err) => this.log.error(err.message));

    this.pruneTimer = setInterval(() => void this.prune(), HOUR_MS);
    this.pruneTimer.unref();

    this.client.on('message', (topic, payload) => {
      const raw = payload.toString();
      this.tail = this.tail
        .then(() => this.onMessage(topic, raw))
        .catch((err) => this.log.warn(`ingest: ${String(err)}`));
    });
  }

  onModuleDestroy() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.client?.end(true);
    void this.redis.quit();
    void this.pg.end();
  }

  private async onMessage(topic: string, raw: string) {
    if (topic.startsWith('$SYS/')) {
      await this.onSys(topic, raw);
      return;
    }
    const deviceId = deviceIdFromTopic(topic);
    if (!deviceId) return;
    let msg: StateMsg;
    try {
      msg = JSON.parse(raw) as StateMsg;
    } catch {
      this.log.warn(`bad json on ${topic}`);
      return;
    }

    if (topic.includes('/event/')) {
      await this.onEvent(deviceId, msg as unknown as EventMsg);
      return;
    }

    if (topic.includes('/probe/')) {
      // Trả lời hw.dump đi đường riêng: đẩy vào probe:wait sẽ làm API tưởng máy vừa trả lời probe.
      const hw = (msg as unknown as { hw?: unknown }).hw;
      if (Array.isArray(hw)) {
        await this.onHwDump(deviceId, msg as unknown as DumpMsg, hw);
        return;
      }
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
        await this.writeLive(deviceId, msg);
        await this.redis.expire(keys.device(deviceId), TTL.device);
        await this.pg.query(`UPDATE devices SET last_seen = now() WHERE device_id = $1`, [deviceId]);
        return;
      }
    }

    await this.writeLive(deviceId, msg);
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

  private async writeLive(deviceId: string, msg: StateMsg) {
    await this.redis.hset(keys.device(deviceId), liveHashPatch(msg));
    try {
      const hw = hwLivePatch(msg.volatile);
      if (Object.keys(hw.set).length) await this.redis.hset(keys.device(deviceId), hw.set);
      if (hw.del.length) await this.redis.hdel(keys.device(deviceId), ...hw.del);
      await this.storeHeartbeatSample(deviceId, msg);
    } catch (err) {
      // Chỉ số hw là phụ: lỗi ở đây không được chặn việc cập nhật caps/trạng thái.
      this.log.warn(`hw state ${deviceId}: ${String(err)}`);
    }
  }

  private async storeHeartbeatSample(deviceId: string, msg: StateMsg) {
    if (msg.online === false || !volatileHasHw(msg.volatile)) return;
    // Ngưỡng < chu kỳ heartbeat (2 phút) để jitter không làm rớt mẫu; đặt khoá SAU khi ghi thành công.
    if (this.hbStoreSec > 0 && (await this.redis.exists(keys.hwHeartbeat(deviceId)))) return;
    const ts = saneTs(msg.ts);
    const data = normalizeHwSample({ ...msg.volatile, ts });
    if (!data) return;
    await this.pg.query(
      `INSERT INTO device_hw_samples (device_id, source, sample_ts, data)
       VALUES ($1, 'hb', to_timestamp($2::double precision / 1000.0), $3::jsonb)
       ON CONFLICT (device_id, source, sample_ts) DO NOTHING`,
      [deviceId, ts, JSON.stringify(data)],
    );
    if (this.hbStoreSec > 0) await this.redis.set(keys.hwHeartbeat(deviceId), '1', 'EX', Math.ceil(this.hbStoreSec));
  }

  /** Giới hạn tần suất theo máy: máy lỗi/bị chiếm không được ghi tràn bảng. */
  private async allow(key: string, max: number, windowSec: number): Promise<boolean> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowSec);
    return n <= max;
  }

  /** Sự kiện connect/disconnect của EMQX: chỉ ghi cho máy đã biết (clientId của api/ingest/relay không phải thiết bị). */
  private async onSys(topic: string, raw: string) {
    const t = parseSysClientTopic(topic);
    if (!t) return;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return;
    }
    const e = normalizeBrokerEvent(t.kind, body);
    if (!e) return;
    // Máy kẹt vòng lặp nối lại có thể sinh hàng chục sự kiện mỗi phút: chặn ở mức hợp lý, đủ để thấy xu hướng.
    if (!(await this.allow(`conn:rl:${t.clientId}`, 600, 3600))) return;
    await this.pg.query(
      `INSERT INTO device_conn_events (device_id, source, event, reason, connected_at, at, ip, keepalive)
       SELECT $1, 'broker', $2, $3, to_timestamp($4::double precision / 1000.0),
              to_timestamp($5::double precision / 1000.0), $6, $7
       WHERE EXISTS (SELECT 1 FROM devices WHERE device_id = $1)
       ON CONFLICT (device_id, source, event, at) DO NOTHING`,
      [t.clientId, e.kind, e.reason, e.connectedAt, e.at, e.ip, e.keepalive],
    );
  }

  private async onEvent(deviceId: string, msg: EventMsg) {
    if (msg.code === 'MQTT_FLAP') {
      // Agent tự báo mình nối lại dồn dập; kèm tóm tắt các lý do gần nhất trong `msg`.
      if (!(await this.allow(`hw:rl:ev:${deviceId}`, 60, 600))) return;
      await this.ensureDevice(deviceId);
      const text = typeof msg.msg === 'string' ? msg.msg.replace(/\u0000/g, '').slice(0, 500) : null;
      await this.pg.query(
        `INSERT INTO device_conn_events (device_id, source, event, reason, at)
         VALUES ($1, 'agent', 'flap', $2, to_timestamp($3::double precision / 1000.0))
         ON CONFLICT (device_id, source, event, at) DO NOTHING`,
        [deviceId, text, saneTs(msg.ts)],
      );
      this.log.log(`mqtt flap ${deviceId}`);
      if (this.autoDump) await this.requestDump(deviceId, 100);
      return;
    }
    if (!isHwEventCode(msg.code)) return;
    if (!(await this.allow(`hw:rl:ev:${deviceId}`, 60, 600))) {
      this.log.warn(`hw event rate limit ${deviceId}`);
      return;
    }
    await this.ensureDevice(deviceId);
    const text = typeof msg.msg === 'string' ? msg.msg.slice(0, 500) : null;
    const res = await this.pg.query(
      `INSERT INTO device_hw_events (device_id, code, msg, ts)
       VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000.0))
       ON CONFLICT (device_id, code, ts) DO NOTHING`,
      [deviceId, msg.code, text, saneTs(msg.ts)],
    );
    this.log.log(`hw event ${deviceId} ${msg.code}`);
    if (res.rowCount && this.autoDump && HW_AUTO_DUMP_CODES.includes(msg.code)) {
      await this.requestDump(deviceId, 100);
    }
  }

  /** Lấy chuỗi chỉ số *trước* lúc hỏng; tối đa 1 lần / 10 phút / máy kẻo máy lỗi liên tục bị dồn lệnh. */
  private async requestDump(deviceId: string, n: number) {
    const first = await this.redis.set(keys.hwAutoDump(deviceId), '1', 'EX', 600, 'NX');
    if (!first) return;
    this.client.publish(
      mqttTopics.cmd(deviceId),
      JSON.stringify({ type: 'hw.dump', n, nonce: `auto-${randomUUID()}` }),
      { qos: 1 },
      // Gửi hỏng thì trả lại cooldown, kẻo event kế tiếp trong 10 phút cũng không lấy được dump.
      (err) => {
        if (err) void this.redis.del(keys.hwAutoDump(deviceId));
      },
    );
  }

  private async onHwDump(deviceId: string, msg: DumpMsg, raw: unknown[]) {
    // Chỉ nonce do API đăng ký mới có người chờ; máy không được tự tạo khoá Redis tuỳ ý.
    const nonce = typeof msg.nonce === 'string' && msg.nonce.length <= 64 ? msg.nonce : '';
    const waited = nonce !== '' && !nonce.startsWith('auto-') && (await this.redis.del(keys.hwDumpReq(nonce))) === 1;
    let count = 0;
    let inserted = 0;
    try {
      if (!(await this.allow(`hw:rl:dump:${deviceId}`, 12, 60))) {
        this.log.warn(`hw dump rate limit ${deviceId}`);
        return;
      }
      await this.ensureDevice(deviceId);
      const now = Date.now();
      // Bỏ mẫu có đồng hồ vô lý: to_timestamp báo "out of range" làm hỏng cả lô, mẫu tương lai chiếm chỗ mẫu thật.
      const samples = raw
        .slice(-MAX_DUMP_SAMPLES)
        .map(normalizeHwSample)
        .filter((x): x is NonNullable<typeof x> => x !== null && Math.abs(x.ts - now) < DAY_MS);
      count = samples.length;
      if (samples.length) {
        const res = await this.pg.query(
          `INSERT INTO device_hw_samples (device_id, source, sample_ts, data)
           SELECT $1, 'dump', to_timestamp((e->>'ts')::double precision / 1000.0), e
           FROM jsonb_array_elements($2::jsonb) AS e
           ON CONFLICT (device_id, source, sample_ts) DO NOTHING`,
          [deviceId, JSON.stringify(samples)],
        );
        inserted = res.rowCount ?? 0;
      }
      const conn = (msg as { conn?: unknown }).conn;
      if (Array.isArray(conn)) await this.storeAgentConn(deviceId, conn, now);
      await this.pg.query(`UPDATE devices SET last_seen = now() WHERE device_id = $1`, [deviceId]);
      this.log.log(`hw dump ${deviceId} samples=${count} new=${inserted}`);
    } finally {
      // Luôn trả lời người đang chờ, kể cả khi ghi lỗi: không để API chờ hết 6 giây rồi báo TIMEOUT sai.
      if (waited) {
        const key = keys.hwDump(nonce);
        await this.redis.lpush(key, JSON.stringify({ count, inserted }));
        await this.redis.expire(key, 30);
      }
    }
  }

  /** Nhật ký kết nối do agent giữ trên máy (phản hồi hw.dump): cho thấy phía máy thấy gì khi bị ngắt. */
  private async storeAgentConn(deviceId: string, raw: unknown[], now: number) {
    const rows = raw
      .slice(-100)
      .map(normalizeAgentConn)
      .filter((x): x is NonNullable<typeof x> => x !== null && Math.abs(x.ts - now) < DAY_MS * 7);
    if (!rows.length) return;
    await this.pg.query(
      `INSERT INTO device_conn_events (device_id, source, event, reason, at, detail)
       SELECT $1, 'agent', e->>'ev', e->>'reason', to_timestamp((e->>'ts')::double precision / 1000.0), e->'detail'
       FROM jsonb_array_elements($2::jsonb) AS e
       ON CONFLICT (device_id, source, event, at) DO NOTHING`,
      [deviceId, JSON.stringify(rows)],
    );
  }

  private async prune() {
    try {
      await this.pg.query(`DELETE FROM device_hw_samples WHERE received_at < now() - make_interval(days => $1::int)`, [
        this.sampleDays,
      ]);
      await this.pg.query(`DELETE FROM device_hw_events WHERE at < now() - make_interval(days => $1::int)`, [
        this.eventDays,
      ]);
      await this.pg.query(`DELETE FROM device_conn_events WHERE at < now() - make_interval(days => $1::int)`, [
        this.connDays,
      ]);
    } catch (err) {
      this.log.warn(`hw prune: ${String(err)}`);
    }
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
