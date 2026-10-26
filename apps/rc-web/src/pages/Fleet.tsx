import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Health = {
  total: number;
  ready: number;
  degraded: number;
  notReady: number;
  offline: number;
  byBlocker: Record<string, number>;
  missing?: { secureSettings: number; a11y: number; overlay: number };
};

type Conn = {
  hours: number;
  byReason: { reason: string; count: number; devices: number; hint: string | null }[];
  topDevices: { deviceId: string; label: string | null; disconnects: number; topReason: string }[];
};

export function FleetPage() {
  const [conn, setConn] = useState<Conn | null>(null);
  useEffect(() => {
    void api<Conn>('/fleet/connections?hours=24').then(setConn).catch(() => undefined);
  }, []);
  const [h, setH] = useState<Health | null>(null);
  useEffect(() => {
    void api<Health>('/fleet/health').then(setH);
  }, []);
  if (!h) return <div className="card">Loading…</div>;
  const ratio = h.total ? h.ready / h.total : 0;
  return (
    <div className="grid">
      <div className="card">
        <h2>Fleet health</h2>
        <p>ready_ratio = {ratio.toFixed(3)}</p>
        <p>total {h.total} · ready {h.ready} · degraded {h.degraded} · notReady {h.notReady} · offline {h.offline}</p>
      </div>
      {h.missing && (
        <div className="card">
          <h3>Online devices missing permissions</h3>
          <p>WRITE_SECURE_SETTINGS: {h.missing.secureSettings} · accessibility: {h.missing.a11y} · overlay: {h.missing.overlay}</p>
          <p className="hw-muted">Only ADB can grant these (pm grant / appops) at provisioning time.</p>
        </div>
      )}
      {conn && (
        <div className="card">
          <h3>Connection drops (last {conn.hours} h)</h3>
          {conn.byReason.map((r) => (
            <div key={r.reason} className="hw-line">
              <b>{r.reason}</b> · {r.count} drops · {r.devices} devices
              {r.hint && <div className="hw-muted">{r.hint}</div>}
            </div>
          ))}
          {!conn.byReason.length && <div className="hw-muted">No disconnects recorded.</div>}
          {conn.topDevices.length > 0 && (
            <>
              <h4>Most unstable devices</h4>
              {conn.topDevices.map((d) => (
                <div key={d.deviceId}>
                  <Link to={`/hw/${encodeURIComponent(d.deviceId)}`}>{d.label || d.deviceId}</Link> · {d.disconnects} drops ·{' '}
                  <span className="hw-muted">mostly {d.topReason}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      <div className="card">
        <h3>byBlocker</h3>
        {Object.entries(h.byBlocker).map(([k, v]) => (
          <div key={k}>{k}: {v}</div>
        ))}
        {!Object.keys(h.byBlocker).length && <div>No blockers.</div>}
      </div>
    </div>
  );
}
