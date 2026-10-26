import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ROLLOUT_TEXT } from './dashboardMeta';
import { Tile, type Tone } from './Tile';

type Bucket = 'done' | 'updatedUnhealthy' | 'updatedOffline' | 'pendingOnline' | 'pendingOffline' | 'unknown';
type Rollout = {
  target: string;
  suggestedTarget: string | null;
  generatedAt: number;
  total: number;
  counts: Record<Bucket, number>;
  percentDone: number;
  complete: boolean;
  versions: { version: string; count: number }[];
};

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const ORDER: { key: Bucket; tone: (n: number) => Tone }[] = [
  { key: 'done', tone: () => 'good' },
  { key: 'updatedUnhealthy', tone: (n) => (n ? 'bad' : 'good') },
  { key: 'updatedOffline', tone: (n) => (n ? 'bad' : 'good') },
  { key: 'pendingOnline', tone: (n) => (n ? 'warn' : 'good') },
  { key: 'pendingOffline', tone: (n) => (n ? 'warn' : 'good') },
  { key: 'unknown', tone: () => 'neutral' },
];

export function RolloutPage() {
  const [params, setParams] = useSearchParams();
  const urlTarget = params.get('target') ?? '';
  const [input, setInput] = useState(urlTarget);
  const [d, setD] = useState<Rollout | null>(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api<Rollout>(`/fleet/rollout${urlTarget ? `?target=${encodeURIComponent(urlTarget)}` : ''}`);
      if (mine !== seq.current) return;
      setD(r);
      setErr('');
      setInput((cur) => cur || r.target);
    } catch (ex) {
      if (mine !== seq.current) return;
      setErr((ex as { status?: number }).status === 400 ? 'Target must look like 1.4.8.' : `Failed to load: ${(ex as Error).message}`);
    }
  }, [urlTarget]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const valid = VERSION_RE.test(input);
  const apply = () => {
    if (valid) setParams({ target: input }, { replace: true });
  };

  if (!d && !err) return <div className="card">Loading…</div>;
  const target = d?.target ?? urlTarget;
  const bad = d ? d.counts.updatedUnhealthy + d.counts.updatedOffline : 0;
  const waiting = d ? d.counts.pendingOnline + d.counts.pendingOffline + d.counts.unknown : 0;

  return (
    <div className="grid hw-page">
      <div className="row">
        <h2 style={{ margin: 0 }}>Agent rollout</h2>
        {d && <span className="hw-muted">{d.total} devices · updated {new Date(d.generatedAt).toLocaleTimeString()}</span>}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <label htmlFor="target">Target version</label>
        <input id="target" value={input} onChange={(e) => setInput(e.target.value.trim())} placeholder="1.4.8" aria-invalid={!valid && input !== ''} style={{ width: 110 }} />
        <button type="submit" disabled={!valid}>Check</button>
        {d?.suggestedTarget && d.suggestedTarget !== target && (
          <button type="button" className="secondary" onClick={() => { setInput(d.suggestedTarget!); setParams({ target: d.suggestedTarget! }, { replace: true }); }}>
            Use newest in fleet ({d.suggestedTarget})
          </button>
        )}
        <span className="hw-muted">Devices on this version or newer count as updated.</span>
      </form>
      {err && <div className="err">{err}</div>}

      {d && (
        <>
          <div className="card">
            <div className="stack" role="img" aria-label="rollout progress">
              {d.counts.done > 0 && <span className="seg READY" style={{ width: `${(d.counts.done / d.total) * 100}%` }}>{d.counts.done}</span>}
              {bad > 0 && <span className="seg NOT_READY" style={{ width: `${(bad / d.total) * 100}%` }}>{bad}</span>}
              {waiting > 0 && <span className="seg DEGRADED" style={{ width: `${(waiting / d.total) * 100}%` }}>{waiting}</span>}
            </div>
            <div className={d.complete ? 'banner ok' : 'banner wait'} role="status">
              {d.complete
                ? `Rollout complete: all ${d.total} devices are on ${target} or newer, online and healthy.`
                : d.total === 0
                  ? 'No devices visible to this account.'
                  : `${d.percentDone}% done (${d.counts.done} of ${d.total}). ${bad ? `${bad} updated but needs checking. ` : ''}${waiting ? `${waiting} not updated yet.` : ''}`}
            </div>
          </div>

          <div className="card">
            <h3>Where every device is</h3>
            <div className="tiles">
              {ORDER.map(({ key, tone }) => (
                <Tile
                  key={key}
                  total={d.total}
                  title={ROLLOUT_TEXT[key].title}
                  value={d.counts[key]}
                  listKey={`rollout:${key}:${target}`}
                  tone={tone(d.counts[key])}
                  hint={ROLLOUT_TEXT[key].note}
                />
              ))}
            </div>
            <div className="hw-muted">
              “Done” means on the target version <b>and</b> online <b>and</b> healthy. A device that updated and then went offline is not done: it may be broken by the update.
            </div>
          </div>

          <div className="card">
            <h3>Versions in the fleet</h3>
            {d.versions.map((v) => (
              <div key={v.version} className="row">
                <Link to={`/dashboard/${encodeURIComponent(`ver:${v.version}`)}`} style={{ minWidth: 70 }}><b>{v.version}</b></Link>
                <div className="bar"><span style={{ width: `${(v.count / Math.max(1, d.total)) * 100}%` }} /></div>
                <span className="hw-muted">{v.count}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
