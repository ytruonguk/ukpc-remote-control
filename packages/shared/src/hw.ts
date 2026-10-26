import type { HwVolatile } from './types';

/** Mã event agent gửi trên rc/event/<id> (có tiền tố `HW_`). Xem docs/backend-hw-monitor.md ở repo agent. */
export const HW_EVENT_CODES = [
  'HW_THERMAL',
  'HW_LOW_MEM',
  'HW_DISK_LOW',
  'HW_PANEL_OFF',
  'HW_TOUCH_GONE',
  'HW_MAIN_LAG',
  'HW_GPU_PEGGED',
  'HW_CPU_PEGGED',
  'HW_ANR_DIALOG',
  'HW_FD_LEAK',
  'HW_THREAD_LEAK',
] as const;

export type HwEventCode = (typeof HW_EVENT_CODES)[number];

export function isHwEventCode(code: unknown): code is HwEventCode {
  return typeof code === 'string' && (HW_EVENT_CODES as readonly string[]).includes(code);
}

/** Các event khớp triệu chứng "màn hình vật lý đen/không chạm được mà remote vẫn dùng được": lấy ngay chuỗi trước lúc hỏng. */
export const HW_AUTO_DUMP_CODES: readonly HwEventCode[] = [
  'HW_PANEL_OFF',
  'HW_TOUCH_GONE',
  'HW_MAIN_LAG',
  'HW_ANR_DIALOG',
];

type Kind = 'number' | 'boolean' | 'string' | 'strings';

/** Trường của một mẫu trong `hw.dump`. `null` từ agent = không đọc được, được giữ nguyên. */
const SAMPLE_FIELDS: Record<string, Kind> = {
  phase: 'string',
  thermal: 'number',
  battTempC: 'number',
  zoneMaxC: 'number',
  memAvailMb: 'number',
  memTotalMb: 'number',
  lowMem: 'boolean',
  diskFreeMb: 'number',
  cpuPct: 'number',
  cpuKHz: 'number',
  gpuPct: 'number',
  gpuMHz: 'number',
  display: 'number',
  interactive: 'boolean',
  touchDevs: 'number',
  mainLagMs: 'number',
  appPssMb: 'number',
  threads: 'number',
  fds: 'number',
  fgPkg: 'string',
  uiIdleMs: 'number',
  lockTask: 'number',
  dimmed: 'boolean',
  anomaly: 'strings',
};

const MAX_STR = 128;
const MAX_ANOMALY = 16;

/** Postgres jsonb từ chối \\u0000; chuỗi từ thiết bị là dữ liệu không tin cậy. */
function clean(s: string): string {
  return s.replace(/\u0000/g, '').slice(0, MAX_STR);
}

export type HwSampleData = { ts: number } & Record<string, number | boolean | string | string[] | null>;

/**
 * Chuẩn hoá một mẫu từ máy (dữ liệu không tin cậy): chỉ giữ trường đã biết, đúng kiểu, chuỗi bị cắt.
 * Trả null nếu thiếu `ts` hợp lệ.
 */
export function normalizeHwSample(raw: unknown): HwSampleData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts <= 0) return null;
  const out: HwSampleData = { ts: o.ts };
  for (const [key, kind] of Object.entries(SAMPLE_FIELDS)) {
    const v = o[key];
    if (v === undefined) continue;
    if (v === null) {
      out[key] = null;
    } else if (kind === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
    } else if (kind === 'boolean' && typeof v === 'boolean') {
      out[key] = v;
    } else if (kind === 'string' && typeof v === 'string') {
      out[key] = clean(v);
    } else if (kind === 'strings' && Array.isArray(v)) {
      out[key] = v.filter((x): x is string => typeof x === 'string').slice(0, MAX_ANOMALY).map(clean);
    }
  }
  return out;
}

const VOLATILE_NUM = [
  'thermal',
  'battTempC',
  'memAvailMb',
  'diskFreeMb',
  'cpuPct',
  'gpuPct',
  'display',
  'touchDevs',
  'mainLagMs',
  'uiIdleMs',
] as const;

/** Agent dùng -1 (và display 0) cho "không đọc được": coi như vắng mặt, đừng hiện "disk free -1 MB". */
const UNKNOWN_IS_MINUS_ONE = new Set<string>(['thermal', 'diskFreeMb', 'touchDevs', 'uiIdleMs']);

const PREFIX = 'hw_';

export function volatileHasHw(v: object | undefined): boolean {
  if (!v) return false;
  return VOLATILE_NUM.some((k) => k in v) || 'fgPkg' in v;
}

/**
 * Patch cho hash `device:<id>`: `set` ghi, `del` xoá các trường tuỳ chọn vắng mặt.
 * Máy cũ (không có trường hw nào) → patch rỗng, không đụng dữ liệu đã có.
 */
export function hwLivePatch(v: HwVolatile | undefined): {
  set: Record<string, string>;
  del: string[];
} {
  if (!v || !volatileHasHw(v)) return { set: {}, del: [] };
  const set: Record<string, string> = {};
  const rec = v as Record<string, unknown>;
  for (const k of VOLATILE_NUM) {
    const x = rec[k];
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    if (x === -1 && UNKNOWN_IS_MINUS_ONE.has(k)) continue;
    if (k === 'display' && x === 0) continue;
    set[PREFIX + k] = String(x);
  }
  if (typeof v.fgPkg === 'string' && v.fgPkg) set[`${PREFIX}fgPkg`] = clean(v.fgPkg);
  // Mọi trường hw không còn trong heartbeat này phải bị xoá, kẻo số cũ (ví dụ touchDevs=0) nằm lại mãi.
  const del = [...VOLATILE_NUM, 'fgPkg'].map((k) => PREFIX + k).filter((k) => !(k in set));
  return { set, del };
}

/** Đọc lại từ hash Redis; null nếu máy chưa từng gửi chỉ số hw. */
export function hwFromHash(hash: Record<string, string>): HwVolatile | null {
  const out: Record<string, number | string> = {};
  for (const k of VOLATILE_NUM) {
    const raw = hash[PREFIX + k];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (hash[`${PREFIX}fgPkg`]) out.fgPkg = hash[`${PREFIX}fgPkg`];
  return Object.keys(out).length ? (out as HwVolatile) : null;
}
