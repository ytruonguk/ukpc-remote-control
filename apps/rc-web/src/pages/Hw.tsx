import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';

type Sample = {
  source: 'hb' | 'dump';
  ts: number;
  phase?: string;
  thermal?: number | null;
  battTempC?: number | null;
  memAvailMb?: number | null;
  diskFreeMb?: number | null;
  cpuPct?: number | null;
  gpuPct?: number | null;
  display?: number | null;
  touchDevs?: number | null;
  mainLagMs?: number | null;
  fgPkg?: string | null;
  dimmed?: boolean;
  anomaly?: string[];
};
type HwEvent = { code: string; msg: string | null; ts: number; at: number };
type Device = {
  deviceId: string;
  label: string | null;
  agentVer: string;
  hw: Record<string, number | string> | null;
};

type ConnInfo = {
  hours: number;
  connects: number;
  disconnects: number;
  avgSessionSec: number | null;
  shortestSessionSec: number | null;
  byReason: { reason: string; count: number; hint: string | null }[];
  events: { source: string; event: string; reason: string | null; at: number; ip: string | null; detail: Record<string, unknown> | null }[];
};

const DISPLAY: Record<number, string> = { 1: 'OFF', 2: 'ON', 3: 'DOZE', 4: 'DOZE_SUSPEND', 5: 'VR', 6: 'ON_SUSPEND' };
const WINDOWS = [
  { label: '1 h', minutes: 60 },
  { label: '6 h', minutes: 360 },
  { label: '24 h', minutes: 1440 },
  { label: '7 d', minutes: 10080 },
];

function Spark({ title, unit, samples, pick, minRange = 1 }: {
  title: string;
  unit: string;
  /** Biên độ tối thiểu của trục dọc: dao động nhỏ (0,5 °C) không được vẽ như biến động lớn. */
  minRange?: number;
  samples: Sample[];
  pick: (s: Sample) => number | null | undefined;
}) {
  const pts = samples
    .map((s) => ({ t: s.ts, v: pick(s) }))
    .filter((p): p is { t: number; v: number } => typeof p.v === 'number');
  if (pts.length < 2) {
    return (
      <div className="card">
        <strong>{title}</strong>
        <div className="hw-muted">{pts.length ? `${pts[0].v} ${unit}` : 'no data (device may not expose it)'}</div>
      </div>
    );
  }
  const t0 = pts[0].t;
  const span = Math.max(1, pts[pts.length - 1].t - t0);
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const range = Math.max(max - min, minRange);
  const lo = (max + min) / 2 - range / 2;
  const path = pts
    .map((p) => `${(((p.t - t0) / span) * 300).toFixed(1)},${(56 - ((p.v - lo) / range) * 52).toFixed(1)}`)
    .join(' ');
  return (
    <div className="card">
      <div className="row">
        <strong>{title}</strong>
        <span className="hw-muted">
          now {pts[pts.length - 1].v} {unit} · min {min} · max {max}
        </span>
      </div>
      <svg viewBox="0 0 300 60" width="100%" height="60" preserveAspectRatio="none" role="img" aria-label={title}>
        <polyline points={path} fill="none" stroke="#60a5fa" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/** Agent dùng -1 cho "không đọc được"; đừng hiện "touch -1". */
function val(v: number | string | null | undefined): string | number {
  return v === null || v === undefined || v === -1 ? '—' : v;
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString();
}

export function HwPage() {
  const { deviceId = '' } = useParams();
  const [device, setDevice] = useState<Device | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [events, setEvents] = useState<HwEvent[]>([]);
  const [conn, setConn] = useState<ConnInfo | null>(null);
  const [minutes, setMinutes] = useState(360);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Mỗi lần tải có số thứ tự: phản hồi chậm của cửa sổ/thiết bị cũ không được ghi đè dữ liệu mới.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = encodeURIComponent(deviceId);
    const mine = ++seq.current;
    try {
      const [d, s, e, c] = await Promise.all([
        api<Device>(`/devices/${id}`),
        api<Sample[]>(`/devices/${id}/hw?minutes=${minutes}&limit=2000`),
        api<HwEvent[]>(`/devices/${id}/hw/events?limit=50`),
        api<ConnInfo>(`/devices/${id}/conn?hours=24`),
      ]);
      if (mine !== seq.current) return;
      setDevice(d);
      setSamples(s);
      setEvents(e);
      setConn(c);
      setErr('');
    } catch (ex) {
      if (mine !== seq.current) return;
      setErr(`Failed to load: ${(ex as Error).message}`);
    }
  }, [deviceId, minutes]);

  // Đổi thiết bị: bỏ dữ liệu của thiết bị trước thay vì hiện nó cho tới khi tải xong.
  useEffect(() => {
    setDevice(null);
    setSamples([]);
    setEvents([]);
    setConn(null);
    setMsg('');
  }, [deviceId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  async function dump() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api<{ ok: boolean; count?: number; inserted?: number; reason?: string }>(
        `/devices/${encodeURIComponent(deviceId)}/hw/dump`,
        { method: 'POST', body: JSON.stringify({ n: 100 }) },
      );
      setMsg(r.ok ? `Got ${r.count} samples (${r.inserted} new)` : `No answer from device (${r.reason})`);
      await load();
    } catch (ex) {
      setMsg(`Dump failed: ${(ex as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const hw = device?.hw;
  const display = typeof hw?.display === 'number' ? hw.display : undefined;
  const bad = {
    display: display !== undefined && display !== 2,
    touch: hw?.touchDevs === 0,
    lag: typeof hw?.mainLagMs === 'number' && hw.mainLagMs >= 1500,
  };

  return (
    <div className="grid hw-page">
      <div className="row">
        <Link to="/devices">← Devices</Link>
        <h2 style={{ margin: 0 }}>{device?.label || deviceId} · hardware</h2>
        <span className="hw-muted">agent {device?.agentVer ?? '…'}</span>
      </div>
      {err && <div className="err">{err}</div>}

      {device && !hw && (
        <div className="card">This device has not reported hardware metrics (agent older than 1.4.7, or not seen yet).</div>
      )}

      {hw && (
        <div className="card hw-grid">
          <div className={bad.display ? 'hw-bad' : ''}>panel <b>{display !== undefined ? (DISPLAY[display] ?? display) : '—'}</b></div>
          <div className={bad.touch ? 'hw-bad' : ''}>touch devices <b>{val(hw.touchDevs)}</b></div>
          <div className={bad.lag ? 'hw-bad' : ''}>main lag <b>{hw.mainLagMs ?? '—'} ms</b></div>
          <div>thermal <b>{val(hw.thermal)}</b></div>
          <div>battery temp <b>{hw.battTempC ?? '—'} °C</b></div>
          <div>RAM free <b>{hw.memAvailMb ?? '—'} MB</b></div>
          <div>disk free <b>{val(hw.diskFreeMb)} MB</b></div>
          <div>foreground <b>{hw.fgPkg ?? '—'}</b></div>
        </div>
      )}

      <div className="row">
        {WINDOWS.map((w) => (
          <button
            key={w.minutes}
            type="button"
            className={w.minutes === minutes ? '' : 'secondary'}
            onClick={() => setMinutes(w.minutes)}
          >
            {w.label}
          </button>
        ))}
        <button type="button" disabled={busy} onClick={() => void dump()}>
          {busy ? 'Asking device…' : 'Dump now'}
        </button>
        {msg && <span className="hw-muted">{msg}</span>}
      </div>

      <Spark title="RAM free" unit="MB" samples={samples} pick={(s) => s.memAvailMb} minRange={300} />
      <Spark title="Battery temperature" unit="°C" samples={samples} pick={(s) => s.battTempC} minRange={10} />
      <Spark title="Main thread lag" unit="ms" samples={samples} pick={(s) => s.mainLagMs} minRange={500} />
      <Spark title="GPU" unit="%" samples={samples} pick={(s) => s.gpuPct} minRange={100} />
      <Spark title="CPU" unit="%" samples={samples} pick={(s) => s.cpuPct} minRange={100} />

      <div className="card">
        <h3>Events</h3>
        {events.map((e) => (
          <div key={`${e.code}-${e.ts}`} className="hw-line">
            <b>{e.code}</b> <span className="hw-muted">{fmt(e.ts)}</span>
            <div className="hw-muted">{e.msg}</div>
          </div>
        ))}
        {!events.length && <div className="hw-muted">No hardware events.</div>}
      </div>

      {conn && (
        <div className="card">
          <h3>Connection (last {conn.hours} h)</h3>
          <div className="hw-muted">
            {conn.disconnects} drops · {conn.connects} connects
            {conn.avgSessionSec !== null && ` · average session ${conn.avgSessionSec}s, shortest ${conn.shortestSessionSec}s`}
          </div>
          {conn.byReason.map((r) => (
            <div key={r.reason} className="hw-line">
              <b>{r.reason}</b> × {r.count}
              {r.hint && <div className="hw-muted">{r.hint}</div>}
            </div>
          ))}
          {!conn.byReason.length && <div className="hw-muted">No disconnects recorded.</div>}
          {conn.events.slice(0, 30).map((e) => (
            <div key={`${e.source}-${e.event}-${e.at}`} className="hw-row" style={{ gridTemplateColumns: '90px 60px 110px 1fr' }}>
              <span>{new Date(e.at).toLocaleTimeString()}</span>
              <span>{e.source}</span>
              <span>{e.event}</span>
              <span>{e.reason ?? ''}{e.ip ? ` · ${e.ip}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Recent samples ({samples.length})</h3>
        <div className="hw-table">
          <div className="hw-head">
            <span>time</span><span>src</span><span>panel</span><span>touch</span><span>RAM</span><span>°C</span><span>lag</span><span>flags</span>
          </div>
          {[...samples].reverse().slice(0, 40).map((s) => (
            <div key={`${s.source}-${s.ts}`} className={s.anomaly?.length ? 'hw-bad hw-row' : 'hw-row'}>
              <span>{new Date(s.ts).toLocaleTimeString()}</span>
              <span>{s.source}</span>
              <span>{s.display != null ? (DISPLAY[s.display] ?? s.display) : '—'}</span>
              <span>{val(s.touchDevs)}</span>
              <span>{val(s.memAvailMb)}</span>
              <span>{val(s.battTempC)}</span>
              <span>{val(s.mainLagMs)}</span>
              <span>{[...(s.anomaly ?? []), ...(s.dimmed ? ['dimmed'] : [])].join(' ')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
