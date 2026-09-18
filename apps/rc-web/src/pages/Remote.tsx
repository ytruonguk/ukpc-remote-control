import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, dropSessionKeepalive } from '../api';
import { connectStream } from '../lib/decode';
import { attachPointer } from '../lib/pointer';

type Phase = 'checking' | 'connecting' | 'live' | 'blocked' | 'error' | 'disconnected';
type Blocker = { code: string; fix: string };

let pendingDropId: string | undefined;
let pendingDropTimer: ReturnType<typeof setTimeout> | undefined;
let liveSessionId: string | undefined;

function scheduleDrop(id: string) {
  pendingDropId = id;
  clearTimeout(pendingDropTimer);
  pendingDropTimer = setTimeout(() => {
    if (pendingDropId) dropSessionKeepalive(pendingDropId);
    pendingDropId = undefined;
    if (liveSessionId === id) liveSessionId = undefined;
  }, 400);
}

function flushDrop() {
  clearTimeout(pendingDropTimer);
  const id = pendingDropId || liveSessionId;
  if (id) dropSessionKeepalive(id);
  pendingDropId = undefined;
  liveSessionId = undefined;
}

async function createSession(deviceId: string, entryPoint: string) {
  try {
    return await api<{ sessionId: string; wsUrl: string; token: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ deviceId, entryPoint }),
    });
  } catch (e) {
    if ((e as { status?: number }).status !== 409) throw e;
    await new Promise((r) => setTimeout(r, 250));
    return api<{ sessionId: string; wsUrl: string; token: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ deviceId, entryPoint }),
    });
  }
}

async function dropSession(id: string) {
  try {
    await api(`/sessions/${id}`, { method: 'DELETE' });
  } catch {
    // already closed / race with StrictMode remount
  }
}

function labelPhase(phase: Phase) {
  switch (phase) {
    case 'checking': return 'đang kiểm tra';
    case 'connecting': return 'đang kết nối';
    case 'live': return 'live';
    case 'blocked': return 'chưa sẵn sàng';
    case 'error': return 'lỗi';
    case 'disconnected': return 'đã ngắt';
  }
}

export function RemotePage() {
  const { deviceId = '' } = useParams();
  const [params] = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [warns, setWarns] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'heal' | 'probe' | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | undefined;
    let stopPointer = () => undefined as void;
    let stream: ReturnType<typeof connectStream> | undefined;
    (async () => {
      try {
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
          params.get('src') === 'hmdm' ? 'hmdm_deeplink' : 'rc_console',
        );
        sessionId = session.sessionId;
        liveSessionId = session.sessionId;
        if (cancelled) {
          await dropSession(session.sessionId);
          return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
          await dropSession(session.sessionId);
          return;
        }
        stream = connectStream(session.wsUrl, session.token, canvas);
        stopPointer = attachPointer(canvas, (msg) => stream?.send(msg));
        stream.ws.addEventListener('open', () => {
          if (!cancelled) setPhase('live');
        });
        const onDead = () => {
          if (cancelled) return;
          setPhase('disconnected');
          if (sessionId) dropSessionKeepalive(sessionId);
        };
        stream.ws.addEventListener('close', onDead);
        stream.ws.addEventListener('error', onDead);
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
  }, [deviceId, params, epoch]);

  async function selfheal() {
    setBusy('heal');
    setErr('');
    setNote('Đang gửi self-heal…');
    try {
      await api(`/devices/${deviceId}/selfheal`, { method: 'POST' });
      setNote('Đã gửi self-heal. Đợi máy sửa rồi probe lại…');
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
    setNote('Đang probe (chờ máy ≤ 3s)…');
    try {
      const r = await api<{
        probed: boolean;
        readiness: { tier: string; blockers?: Blocker[]; warns?: string[] };
      }>(`/devices/${deviceId}/probe`, { method: 'POST' });
      setBlockers(r.readiness.blockers ?? []);
      setWarns(r.readiness.warns ?? []);
      if (!r.probed) {
        setNote('Máy không trả lời probe trong 3 giây (offline hoặc không nhận MQTT cmd).');
        return;
      }
      if (r.readiness.tier === 'NOT_READY' || r.readiness.tier === 'OFFLINE') {
        setNote(`Máy trả lời probe · ${r.readiness.tier} — vẫn chặn remote.`);
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
        <h2>Chưa sẵn sàng</h2>
        {blockers.map((b) => (
          <div key={b.code}>{b.code} — {b.fix}</div>
        ))}
        {note && <div>{note}</div>}
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button type="button" disabled={busy !== null} onClick={() => void selfheal()}>
            {busy === 'heal' ? 'Đang self-heal…' : 'Self-heal'}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void probeAgain()}>
            {busy === 'probe' ? 'Đang probe…' : 'Probe lại'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid">
      <div className="row">
        <strong>{deviceId}</strong>
        <span className={`tier ${phase}`}>{labelPhase(phase)}</span>
        {warns.map((w) => <span key={w} className="tier DEGRADED">{w}</span>)}
        {phase === 'disconnected' && (
          <button type="button" onClick={() => { setErr(''); setEpoch((n) => n + 1); }}>
            Kết nối lại
          </button>
        )}
      </div>
      {err && <div className="err">{err}</div>}
      <canvas ref={canvasRef} width={720} height={1152} />
    </div>
  );
}
