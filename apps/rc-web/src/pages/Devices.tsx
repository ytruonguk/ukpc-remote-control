import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Device = {
  deviceId: string;
  label: string | null;
  model: string | null;
  group: string | null;
  readiness: { tier: string; blockers?: { code: string }[]; warns?: string[] };
};

export function DevicesPage() {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [items, setItems] = useState<Device[]>([]);
  const [err, setErr] = useState('');

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (tier) qs.set('tier', tier);
      setItems(await api<Device[]>(`/devices?${qs}`));
    } catch {
      setErr('Failed to load device list');
    }
  }

  useEffect(() => {
    void load();
    const onShow = () => void load();
    window.addEventListener('focus', onShow);
    const t = setInterval(() => void load(), 4000);
    return () => {
      window.removeEventListener('focus', onShow);
      clearInterval(t);
    };
  }, [q, tier]);

  return (
    <div className="grid">
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search deviceId / label" />
        <select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">all tiers</option>
          <option>READY</option>
          <option>DEGRADED</option>
          <option>NOT_READY</option>
          <option>OFFLINE</option>
        </select>
        <button type="button" onClick={() => void load()}>Filter</button>
      </div>
      {err && <div className="err">{err}</div>}
      {items.map((d) => (
        <Link key={d.deviceId} to={`/d/${d.deviceId}`} className="card row" style={{ textDecoration: 'none', color: 'inherit' }}>
          <strong>{d.label || d.deviceId}</strong>
          <span>{d.model}</span>
          <span>{d.group}</span>
          <span className={`tier ${d.readiness.tier}`}>{d.readiness.tier}</span>
        </Link>
      ))}
      {!items.length && <div className="card">No devices yet. Wait for an MQTT agent or Headwind sync.</div>}
    </div>
  );
}
