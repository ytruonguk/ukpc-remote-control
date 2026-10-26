/** Chẩn đoán kết nối MQTT: parse sự kiện $SYS của EMQX và nhật ký kết nối do agent gửi. Dữ liệu từ máy là không tin cậy. */

const SYS_RE = /^\$SYS\/brokers\/[^/]+\/clients\/(.+)\/(connected|disconnected)$/;

export function parseSysClientTopic(topic: string): { clientId: string; kind: 'connected' | 'disconnected' } | null {
  const m = SYS_RE.exec(topic);
  return m ? { clientId: m[1], kind: m[2] as 'connected' | 'disconnected' } : null;
}

export interface BrokerConnEvent {
  kind: 'connected' | 'disconnected';
  reason: string | null;
  connectedAt: number | null;
  at: number;
  ip: string | null;
  keepalive: number | null;
}

function clean(s: string, max: number): string {
  return s.replace(/\u0000/g, '').slice(0, max);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** `payload` là JSON của $SYS/brokers/<node>/clients/<id>/(connected|disconnected). */
export function normalizeBrokerEvent(kind: 'connected' | 'disconnected', raw: unknown): BrokerConnEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const at = num(kind === 'disconnected' ? o.disconnected_at : o.connected_at) ?? num(o.ts);
  if (at === null) return null;
  return {
    kind,
    reason: kind === 'disconnected' && typeof o.reason === 'string' ? clean(o.reason, 64) : null,
    connectedAt: num(o.connected_at),
    at,
    ip: typeof o.ipaddress === 'string' ? clean(o.ipaddress, 64) : null,
    keepalive: typeof o.keepalive === 'number' && Number.isFinite(o.keepalive) ? Math.trunc(o.keepalive) : null,
  };
}

const AGENT_DETAIL_NUM = ['attempt', 'upMs', 'rssi', 'delayMs', 'code'] as const;
const AGENT_DETAIL_STR = ['net', 'phase', 'by'] as const;

export interface AgentConnEntry {
  ts: number;
  ev: string;
  reason: string | null;
  detail: Record<string, number | string>;
}

/** Một dòng nhật ký kết nối của agent (`conn` trong phản hồi hw.dump): chỉ giữ trường đã biết. */
export function normalizeAgentConn(raw: unknown): AgentConnEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts <= 0) return null;
  if (typeof o.ev !== 'string' || !o.ev) return null;
  const detail: Record<string, number | string> = {};
  for (const k of AGENT_DETAIL_NUM) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) detail[k] = v;
  }
  for (const k of AGENT_DETAIL_STR) {
    const v = o[k];
    if (typeof v === 'string') detail[k] = clean(v, 64);
  }
  return {
    ts: o.ts,
    ev: clean(o.ev, 24),
    reason: typeof o.reason === 'string' ? clean(o.reason, 200) : null,
    detail,
  };
}

/** Gợi ý nguyên nhân thường gặp cho từng `reason` của EMQX (hiển thị trên giao diện). */
export const CONN_REASON_HINT: Record<string, string> = {
  discarded:
    'Một kết nối mới dùng cùng clientId đã thay thế kết nối này. Nếu lặp liên tục: hai máy trùng device_id, hoặc agent tự nối lại chồng lên chính nó.',
  takenover: 'Giống discarded nhưng phiên được giữ lại (clean_start=false).',
  kicked: 'Bị quản trị viên hoặc ACL đá ra.',
  keepalive_timeout:
    'Broker không nhận gói nào trong 1,5 × keepalive. Thường do mạng chập chờn, NAT/proxy cắt kết nối rảnh, hoặc máy tiết kiệm pin làm agent không gửi ping kịp.',
  tcp_closed: 'Kết nối TCP bị đóng đột ngột: mạng đứt, đổi Wi-Fi/4G, proxy cắt, hoặc agent bị kill.',
  sock_closed: 'Socket bị đóng phía thiết bị hoặc đường truyền.',
  idle_timeout: 'Kết nối mở nhưng không hoàn tất CONNECT kịp thời.',
  ssl_error: 'Lỗi TLS (chứng chỉ, giờ hệ thống sai, hoặc proxy).',
  normal: 'Agent chủ động ngắt (disconnect). Nếu nhiều: agent tự gọi nối lại, ví dụ do đẩy cấu hình MDM hoặc wake.',
};
