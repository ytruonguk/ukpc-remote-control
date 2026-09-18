import { useEffect, useState } from 'react';
import { api } from '../api';

type Health = {
  total: number;
  ready: number;
  degraded: number;
  notReady: number;
  offline: number;
  byBlocker: Record<string, number>;
};

export function FleetPage() {
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
