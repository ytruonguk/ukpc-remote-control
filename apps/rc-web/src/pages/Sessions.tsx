import { useEffect, useState } from 'react';
import { api } from '../api';

type Session = {
  id: string;
  device_id: string;
  operator_id: number;
  state: string;
  requested_at: string;
  fail_reason: string | null;
};

export function SessionsPage() {
  const [items, setItems] = useState<Session[]>([]);
  useEffect(() => {
    const load = () => {
      void api<Session[]>('/sessions').then(setItems).catch(() => setItems([]));
    };
    load();
    const t = setInterval(load, 4000);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', load);
    };
  }, []);
  return (
    <div className="grid">
      {items.map((s) => (
        <div key={s.id} className="card row">
          <code>{s.id.slice(0, 8)}</code>
          <span>{s.device_id}</span>
          <span className={`tier ${s.state}`}>{s.state}</span>
          <span>{s.fail_reason}</span>
        </div>
      ))}
      {!items.length && <div className="card">Chưa có session audit.</div>}
    </div>
  );
}
