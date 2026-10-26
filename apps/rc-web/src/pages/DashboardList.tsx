import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { DISPLAY_LABEL, MISSING_LABEL, REASON_LABEL, ago, duration, metaFor, type Col } from './dashboardMeta';

type Brief = {
  deviceId: string;
  label: string | null;
  group: string | null;
  online: boolean;
  tier: string;
  lastSeenMs: number | null;
  agentVer: string | null;
  missing: string[] | null;
  drops24h: number;
  lastSessionMs: number | null;
  batteryPct: number | null;
  charging: boolean | null;
  net: string | null;
  rssi: number | null;
  hw: Record<string, number | string> | null;
  hwEvents24h: string[];
  /** Chỉ có ở danh sách rollout: vì sao máy đã cập nhật nhưng chưa khỏe. */
  reasons?: string[];
};
type Resp = { key: string; count: number; generatedAt: number; rows: Brief[] };

const HEAD: Record<Col, string> = {
  status: 'Status', group: 'Group', lastSeen: 'Last seen', agent: 'Agent', missing: 'Missing permissions', lag: 'Main lag',
  ram: 'RAM free', disk: 'Disk free', temp: 'Battery temp', panel: 'Panel', touch: 'Touch devices', uiIdle: 'UI static for',
  battery: 'Battery', net: 'Network', drops: 'Drops (24 h)', lastSession: 'Last remote session', events: 'Events (24 h)', reasons: 'Problems',
};

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Giá trị dùng để sắp xếp (số hoặc chuỗi); null luôn xếp cuối. */
function sortVal(b: Brief, c: Col): number | string | null {
  const hw = b.hw ?? {};
  switch (c) {
    case 'status': return b.tier;
    case 'group': return b.group;
    case 'lastSeen': return b.lastSeenMs;
    case 'agent': return b.agentVer;
    case 'missing': return b.missing ? b.missing.length : null;
    case 'lag': return num(hw.mainLagMs);
    case 'ram': return num(hw.memAvailMb);
    case 'disk': return num(hw.diskFreeMb);
    case 'temp': return num(hw.battTempC);
    case 'panel': return num(hw.display);
    case 'touch': return num(hw.touchDevs);
    case 'uiIdle': return num(hw.uiIdleMs);
    case 'battery': return b.batteryPct;
    case 'net': return b.rssi;
    case 'drops': return b.drops24h;
    case 'lastSession': return b.lastSessionMs;
    case 'events': return b.hwEvents24h.length;
    case 'reasons': return b.reasons?.length ?? 0;
  }
}

function text(b: Brief, c: Col, now: number): string {
  const hw = b.hw ?? {};
  switch (c) {
    case 'status': return b.tier;
    case 'group': return b.group ?? '';
    case 'lastSeen': return b.online ? 'now' : ago(b.lastSeenMs, now);
    case 'agent': return b.agentVer ?? '—';
    case 'missing': return b.missing === null ? 'not reported' : b.missing.length ? b.missing.map((m) => MISSING_LABEL[m] ?? m).join(', ') : 'none';
    case 'lag': return hw.mainLagMs !== undefined ? `${hw.mainLagMs} ms` : '—';
    case 'ram': return hw.memAvailMb !== undefined ? `${hw.memAvailMb} MB` : '—';
    case 'disk': return hw.diskFreeMb !== undefined ? `${hw.diskFreeMb} MB` : '—';
    case 'temp': return hw.battTempC !== undefined ? `${hw.battTempC} °C${hw.thermal ? ` · thermal ${hw.thermal}` : ''}` : '—';
    case 'panel': return typeof hw.display === 'number' ? (DISPLAY_LABEL[hw.display] ?? String(hw.display)) : '—';
    case 'touch': return hw.touchDevs !== undefined ? String(hw.touchDevs) : '—';
    case 'uiIdle': return duration(num(hw.uiIdleMs));
    case 'battery': return b.batteryPct === null ? '—' : `${b.batteryPct}%${b.charging ? ' ⚡' : ''}`;
    case 'net': return b.net ? `${b.net}${b.rssi ? ` ${b.rssi} dBm` : ''}` : '—';
    case 'drops': return String(b.drops24h);
    case 'lastSession': return ago(b.lastSessionMs, now);
    case 'events': return b.hwEvents24h.join(', ') || '—';
    case 'reasons': return (b.reasons ?? []).map((r) => REASON_LABEL[r] ?? r).join(', ') || '—';
  }
}

function csv(rows: Brief[], cols: Col[], now: number): string {
  // Excel/Sheets chạy ô bắt đầu bằng = + - @ (tên/nhóm máy do MDM đặt): thêm dấu nháy để thành văn bản thuần.
  const esc = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  const head = ['device', 'label', ...cols.map((c) => HEAD[c])].map(esc).join(',');
  const body = rows.map((b) => [b.deviceId, b.label ?? '', ...cols.map((c) => text(b, c, now))].map(esc).join(','));
  return [head, ...body].join('\n');
}

export function DashboardListPage() {
  const { key = '' } = useParams();
  const meta = useMemo(() => metaFor(key), [key]);
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ col: Col | 'device'; desc: boolean }>({ col: meta.sort ?? 'device', desc: meta.desc ?? false });
  const seq = useRef(0);

  useEffect(() => {
    setData(null);
    setErr('');
    setQ('');
    setSort({ col: meta.sort ?? 'device', desc: meta.desc ?? false });
  }, [key, meta]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api<Resp>(`/fleet/dashboard/${encodeURIComponent(key)}`);
      if (mine !== seq.current) return;
      setData(r);
      setErr('');
    } catch (ex) {
      if (mine !== seq.current) return;
      setErr((ex as { status?: number }).status === 404 ? 'Unknown metric.' : `Failed to load: ${(ex as Error).message}`);
    }
  }, [key]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const now = data?.generatedAt ?? Date.now();
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.rows ?? []).filter(
      (b) => !needle || b.deviceId.toLowerCase().includes(needle) || (b.label ?? '').toLowerCase().includes(needle) || (b.group ?? '').toLowerCase().includes(needle),
    );
    const dir = sort.desc ? -1 : 1;
    return [...list].sort((a, b) => {
      const x = sort.col === 'device' ? (a.label || a.deviceId) : sortVal(a, sort.col);
      const y = sort.col === 'device' ? (b.label || b.deviceId) : sortVal(b, sort.col);
      if (x === null && y === null) return a.deviceId.localeCompare(b.deviceId);
      if (x === null) return 1;
      if (y === null) return -1;
      if (x < y) return -1 * dir;
      if (x > y) return 1 * dir;
      return a.deviceId.localeCompare(b.deviceId);
    });
  }, [data, q, sort]);

  function toggle(col: Col | 'device') {
    setSort((s) => (s.col === col ? { col, desc: !s.desc } : { col, desc: false }));
  }

  function download() {
    const blob = new Blob([csv(rows, meta.cols, now)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${key.replace(/[^a-z0-9]+/gi, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const arrow = (c: Col | 'device') => (sort.col === c ? (sort.desc ? ' ▼' : ' ▲') : '');
  const cols = ['device', ...meta.cols] as const;

  return (
    <div className="grid hw-page">
      <div className="row">
        <Link to="/dashboard">← Dashboard</Link>
        <h2 style={{ margin: 0 }}>{meta.title}</h2>
        {data && <span className="hw-muted">{data.count} device{data.count === 1 ? '' : 's'}</span>}
      </div>
      {meta.note && <div className="hw-muted">{meta.note}</div>}
      {err && <div className="err">{err}</div>}
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter by name, id or group" aria-label="filter" />
        <button type="button" className="secondary" onClick={() => void load()}>Refresh</button>
        <button type="button" className="secondary" disabled={!rows.length} onClick={download}>Export CSV</button>
        {data && q && <span className="hw-muted">{rows.length} of {data.count} shown</span>}
      </div>
      <div className="card">
        <div className="dl-scroll">
          <table className="dl">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>
                    <button type="button" className="th" onClick={() => toggle(c)}>
                      {c === 'device' ? 'Device' : HEAD[c]}{arrow(c)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.deviceId}>
                  <td>
                    <Link to={`/hw/${encodeURIComponent(b.deviceId)}`}><b>{b.label || b.deviceId}</b></Link>
                    {b.label && <div className="hw-muted">{b.deviceId}</div>}
                  </td>
                  {meta.cols.map((c) => (
                    <td key={c}>
                      {c === 'reasons' && b.reasons?.length ? (
                        <span className="chips">{b.reasons.map((m) => <span key={m} className="chip bad">{REASON_LABEL[m] ?? m}</span>)}</span>
                      ) : c === 'missing' && b.missing && b.missing.length ? (
                        <span className="chips">{b.missing.map((m) => <span key={m} className="chip bad">{MISSING_LABEL[m] ?? m}</span>)}</span>
                      ) : c === 'status' ? (
                        <span className={`tier ${b.tier}`}>{b.tier}</span>
                      ) : (
                        text(b, c, now)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !rows.length && <div className="hw-muted">{q ? 'No device matches the filter.' : 'No devices in this list.'}</div>}
        {!data && !err && <div className="hw-muted">Loading…</div>}
      </div>
    </div>
  );
}
