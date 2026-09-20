import { MouseEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Device = {
  deviceId: string;
  label: string | null;
  model: string | null;
  group: string | null;
  stale?: boolean;
  readiness: { tier: string; blockers?: { code: string }[]; warns?: string[] };
};

export function DevicesPage() {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [stale, setStale] = useState('');
  const [items, setItems] = useState<Device[]>([]);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (tier) qs.set('tier', tier);
      if (stale) qs.set('stale', stale);
      setItems(await api<Device[]>(`/devices?${qs}`));
      setErr('');
    } catch {
      setErr('Failed to load device list');
    }
  }

  async function remove(deviceId: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete ${deviceId}? This cannot be undone.`)) return;
    setBusyId(deviceId);
    try {
      await api(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      setItems((cur) => cur.filter((d) => d.deviceId !== deviceId));
    } catch (ex) {
      setErr(String((ex as Error).message));
    } finally {
      setBusyId(null);
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
  }, [q, tier, stale]);

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
        <select value={stale} onChange={(e) => setStale(e.target.value)}>
          <option value="">all devices</option>
          <option value="false">in inventory</option>
          <option value="true">removed from MDM</option>
        </select>
        <button type="button" onClick={() => void load()}>Filter</button>
      </div>
      {err && <div className="err">{err}</div>}
      {items.map((d) => (
        <div key={d.deviceId} className="card row">
          <Link to={`/d/${d.deviceId}`} style={{ textDecoration: 'none', color: 'inherit', flex: 1 }} className="row">
            <strong>{d.label || d.deviceId}</strong>
            <span>{d.model}</span>
            <span>{d.group}</span>
            <span className={`tier ${d.readiness.tier}`}>{d.readiness.tier}</span>
            {d.stale && <span className="tier OFFLINE">removed</span>}
          </Link>
          <button
            type="button"
            className="secondary"
            disabled={busyId === d.deviceId}
            onClick={(e) => void remove(d.deviceId, e)}
          >
            {busyId === d.deviceId ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      ))}
      {!items.length && <div className="card">No devices yet. Wait for an MQTT agent or Headwind sync.</div>}
    </div>
  );
}
