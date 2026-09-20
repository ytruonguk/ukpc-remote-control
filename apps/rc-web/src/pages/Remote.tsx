import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, dropSessionKeepalive } from '../api';
import { connectStream } from '../lib/decode';
import { attachPointer } from '../lib/pointer';

type Phase = 'checking' | 'connecting' | 'live' | 'blocked' | 'error' | 'disconnected';
type Blocker = { code: string; fix: string };

type HeldSession = { deviceId: string; sessionId: string; wsUrl: string; token: string };

let pendingDropId: string | undefined;
let pendingDropTimer: ReturnType<typeof setTimeout> | undefined;
let held: HeldSession | undefined;
let inflight: Promise<HeldSession> | undefined;

function cancelDrop(id: string) {
  if (pendingDropId !== id) return;
  clearTimeout(pendingDropTimer);
  pendingDropId = undefined;
}

function scheduleDrop(id: string) {
  pendingDropId = id;
  clearTimeout(pendingDropTimer);
  pendingDropTimer = setTimeout(() => {
    if (pendingDropId !== id) return;
    dropSessionKeepalive(id);
    pendingDropId = undefined;
    if (held?.sessionId === id) held = undefined;
  }, 2000);
}

function flushDrop() {
  clearTimeout(pendingDropTimer);
  const id = pendingDropId || held?.sessionId;
  if (id) dropSessionKeepalive(id);
  pendingDropId = undefined;
  held = undefined;
}

async function createSession(deviceId: string, entryPoint: string) {
  if (held?.deviceId === deviceId) {
    cancelDrop(held.sessionId);
    return held;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const post = () =>
        api<{ sessionId: string; wsUrl: string; token: string }>('/sessions', {
          method: 'POST',
          body: JSON.stringify({ deviceId, entryPoint }),
        });
      let session: { sessionId: string; wsUrl: string; token: string };
      try {
        session = await post();
      } catch (e) {
        if ((e as { status?: number }).status !== 409) throw e;
        await new Promise((r) => setTimeout(r, 250));
        session = await post();
      }
      held = { deviceId, ...session };
      cancelDrop(held.sessionId);
      return held;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

function labelPhase(phase: Phase) {
  switch (phase) {
    case 'checking': return 'checking';
    case 'connecting': return 'connecting';
    case 'live': return 'live';
    case 'blocked': return 'not ready';
    case 'error': return 'error';
    case 'disconnected': return 'disconnected';
  }
}

export function RemotePage() {
  const { deviceId = '' } = useParams();
  const [params] = useSearchParams();
  const src = params.get('src');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [warns, setWarns] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'heal' | 'probe' | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [agentStats, setAgentStats] = useState('');
  const [viewStats, setViewStats] = useState('');

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | undefined;
    let stopPointer = () => undefined as void;
    let stream: ReturnType<typeof connectStream> | undefined;
    const attach = (session: HeldSession) => {
      sessionId = session.sessionId;
      cancelDrop(session.sessionId);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      stream = connectStream(session.wsUrl, session.token, canvas, (line) => {
        if (cancelled) return;
        if (line.startsWith('stats ')) setAgentStats(line);
        else if (line.startsWith('view:') && line.includes('fps')) setViewStats(line);
        setLogs((xs) => [...xs.slice(-39), line]);
      });
      stopPointer = attachPointer(canvas, (msg) => stream?.send(msg));
      stream.ws.addEventListener('open', () => {
        if (!cancelled) setPhase('live');
      });
      const onDead = () => {
        if (cancelled) return;
        setPhase('disconnected');
      };
      stream.ws.addEventListener('close', onDead);
      stream.ws.addEventListener('error', onDead);
    };
    (async () => {
      try {
        setLogs([]);
        setAgentStats('');
        setViewStats('');
        if (held?.deviceId === deviceId) {
          setPhase('connecting');
          attach(held);
          return;
        }
        const dev = await api<{
          readiness: { tier: string; blockers?: Blocker[]; warns?: string[] };
        }>(`/devices/${deviceId}`);
        if (cancelled) return;
        if (dev.readiness.tier === 'NOT_READY' || dev.readiness.tier === 'OFFLINE') {
          setBlockers(dev.readiness.blockers ?? []);
          setPhase('blocked');
          return;
        }
        setWarns(dev.readiness.warns ?? []);
        setPhase('connecting');
        const session = await createSession(
          deviceId,
          src === 'hmdm' ? 'hmdm_deeplink' : 'rc_console',
        );
        attach(session);
      } catch (e) {
        if (cancelled) return;
        const body = (e as { body?: { blockers?: Blocker[]; code?: string } }).body;
        if (body?.blockers) {
          setBlockers(body.blockers);
          setPhase('blocked');
          return;
        }
        setErr(String((e as Error).message));
        setPhase('error');
      }
    })();
    const onPageHide = () => flushDrop();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      cancelled = true;
      stopPointer();
      stream?.close();
      if (sessionId) scheduleDrop(sessionId);
    };
  }, [deviceId, src, epoch]);

  async function selfheal() {
    setBusy('heal');
    setErr('');
    setNote('Sending self-heal…');
    try {
      await api(`/devices/${deviceId}/selfheal`, { method: 'POST' });
      setNote('Self-heal sent. Wait for the device to recover, then probe again…');
      await probeAgain();
    } catch (e) {
      setErr(String((e as Error).message));
      setNote('');
      setBusy(null);
    }
  }

  async function probeAgain() {
    setBusy('probe');
    setErr('');
    setNote('Probing (wait ≤ 3s for the device)…');
    try {
      const r = await api<{
        probed: boolean;
        readiness: { tier: string; blockers?: Blocker[]; warns?: string[] };
      }>(`/devices/${deviceId}/probe`, { method: 'POST' });
      setBlockers(r.readiness.blockers ?? []);
      setWarns(r.readiness.warns ?? []);
      if (!r.probed) {
        setNote('Device did not answer probe within 3 seconds (offline or not receiving MQTT cmd).');
        return;
      }
      if (r.readiness.tier === 'NOT_READY' || r.readiness.tier === 'OFFLINE') {
        setNote(`Device answered probe · ${r.readiness.tier} — remote still blocked.`);
        return;
      }
      setNote('');
      setPhase('checking');
      setEpoch((n) => n + 1);
    } catch (e) {
      setErr(String((e as Error).message));
      setNote('');
    } finally {
      setBusy(null);
    }
  }

  if (phase === 'blocked') {
    return (
      <div className="card grid">
        <h2>Not ready</h2>
        {blockers.map((b) => (
          <div key={b.code}>{b.code} — {b.fix}</div>
        ))}
        {note && <div>{note}</div>}
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button type="button" disabled={busy !== null} onClick={() => void selfheal()}>
            {busy === 'heal' ? 'Self-healing…' : 'Self-heal'}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void probeAgain()}>
            {busy === 'probe' ? 'Probing…' : 'Probe again'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="remote-page">
      <div className="row">
        <strong>{deviceId}</strong>
        <span className={`tier ${phase}`}>{labelPhase(phase)}</span>
        {agentStats && <span className="tier DEGRADED">{agentStats}</span>}
        {viewStats && <span className="tier">{viewStats}</span>}
        {warns.map((w) => <span key={w} className="tier DEGRADED">{w}</span>)}
        {phase === 'disconnected' && (
          <button type="button" onClick={() => { setErr(''); held = undefined; setEpoch((n) => n + 1); }}>
            Reconnect
          </button>
        )}
        <button type="button" className="secondary" onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? 'Hide logs' : `Logs${logs.length ? ` (${logs.length})` : ''}`}
        </button>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="remote-stage">
        <canvas ref={canvasRef} width={720} height={1152} />
        {showLogs && (
          <pre className="remote-log">{logs.length ? logs.join('\n') : 'waiting for agent log…'}</pre>
        )}
      </div>
    </div>
  );
}
