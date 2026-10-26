import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Tile, type Tone } from './Tile';
import { REASON_LABEL } from './dashboardMeta';

type Attention = { deviceId: string; label: string | null; group: string | null; score: number; reasons: string[] };
type Dash = {
  generatedAt: number;
  total: number;
  connectivity: { online: number; offline: number; offlineOver24h: number; neverSeen: number };
  tiers: Record<'READY' | 'DEGRADED' | 'NOT_READY' | 'OFFLINE', number>;
  permissions: { complete: number; incomplete: number; unknown: number; missingSecureSettings: number; missingA11y: number; missingOverlay: number };
  performance: { lagging: number; hot: number; lowMem: number; lowDisk: number; panelOff: number; touchGone: number; noHwData: number };
  interaction: { uiIdle6h: number; uiIdle24h: number; noSession7d: number };
  battery: { low: number; notCharging: number };
  network: { wifi: number; cellular: number; ethernet: number; unknown: number; weakSignal: number };
  versions: { version: string; count: number }[];
  outdated: number;
  stability: { flapping: number; drops24h: number };
  events24h: { code: string; devices: number }[];
  lists: Record<string, string[]>;
  names: Record<string, string>;
  attention: Attention[];
};



export function DashboardPage() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api<Dash>('/fleet/dashboard');
      if (mine !== seq.current) return;
      setD(r);
      setErr('');
    } catch (ex) {
      if (mine === seq.current) setErr(`Failed to load dashboard: ${(ex as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  if (!d) return <div className="card">{err || 'Loading…'}</div>;
  const pct = (n: number) => (d.total ? Math.round((n / d.total) * 100) : 0);

  const tone = (n: number, bad: Tone = 'bad'): Tone => (n > 0 ? bad : 'good');
  const c = d.connectivity;
  const p = d.permissions;
  const f = d.performance;
  const tierTotal = Math.max(1, d.total);

  return (
    <div className="grid hw-page">
      <div className="row">
        <h2 style={{ margin: 0 }}>Fleet dashboard</h2>
        <span className="hw-muted">{d.total} devices · updated {new Date(d.generatedAt).toLocaleTimeString()}</span>
        <button type="button" className="secondary" onClick={() => void load()}>Refresh</button>
        <span className="hw-muted">Click a number to see the devices behind it.</span>
      </div>
      {err && <div className="err">{err}</div>}

      <div className="card">
        <h3>Readiness</h3>
        <div className="stack" role="img" aria-label="readiness">
          {(['READY', 'DEGRADED', 'NOT_READY', 'OFFLINE'] as const).map((t) =>
            d.tiers[t] ? (
              <Link key={t} className={`seg ${t}`} style={{ width: `${(d.tiers[t] / tierTotal) * 100}%` }} title={`${t}: ${d.tiers[t]}`} to={`/dashboard/${encodeURIComponent(`tier:${t}`)}`}>
                {d.tiers[t]}
              </Link>
            ) : null,
          )}
        </div>
        <div className="hw-muted">READY {d.tiers.READY} · DEGRADED {d.tiers.DEGRADED} · NOT_READY {d.tiers.NOT_READY} · OFFLINE {d.tiers.OFFLINE}</div>
      </div>

      <div className="card">
        <h3>Connectivity</h3>
        <div className="tiles">
          <Tile total={d.total} title="Connected" value={c.online} listKey="online" tone="good" />
          <Tile total={d.total} title="Disconnected" value={c.offline} listKey="offline" tone={tone(c.offline, 'warn')} />
          <Tile total={d.total} title="Offline > 24 h" value={c.offlineOver24h} listKey="offlineOver24h" tone={tone(c.offlineOver24h)} />
          <Tile total={d.total} title="Never seen" value={c.neverSeen} listKey="neverSeen" tone="neutral" hint="Devices known to the MDM that never reported" />
          <Tile total={d.total} title="Dropping connection" value={d.stability.flapping} listKey="flapping" tone={tone(d.stability.flapping)} hint="5 or more drops in 24 h" />
        </div>
        <div className="hw-muted">{d.stability.drops24h} connection drops in the last 24 h across the fleet.</div>
      </div>

      <div className="card">
        <h3>Permissions</h3>
        <div className="tiles">
          <Tile total={d.total} title="All permissions" value={p.complete} listKey="permissionsComplete" tone="good" />
          <Tile total={d.total} title="Missing permissions" value={p.incomplete} listKey="permissionsIncomplete" tone={tone(p.incomplete, 'warn')} />
          <Tile total={d.total} title="No WRITE_SECURE_SETTINGS" value={p.missingSecureSettings} listKey="missingSecureSettings" tone={tone(p.missingSecureSettings, 'warn')} />
          <Tile total={d.total} title="No accessibility" value={p.missingA11y} listKey="missingA11y" tone={tone(p.missingA11y)} />
          <Tile total={d.total} title="No overlay" value={p.missingOverlay} listKey="missingOverlay" tone={tone(p.missingOverlay, 'warn')} />
          <Tile total={d.total} title="Not reported yet" value={p.unknown} listKey="permissionsUnknown" tone="neutral" />
        </div>
        <div className="hw-muted">Permissions can only be granted with ADB at provisioning time (pm grant / appops).</div>
      </div>

      <div className="card">
        <h3>Performance (online devices)</h3>
        <div className="tiles">
          <Tile total={d.total} title="Lagging" value={f.lagging} listKey="lagging" tone={tone(f.lagging)} hint="Main thread lag of 1.5 s or more" />
          <Tile total={d.total} title="Panel off while on" value={f.panelOff} listKey="panelOff" tone={tone(f.panelOff)} />
          <Tile total={d.total} title="Touch lost" value={f.touchGone} listKey="touchGone" tone={tone(f.touchGone)} />
          <Tile total={d.total} title="Hot" value={f.hot} listKey="hot" tone={tone(f.hot)} hint="Battery 47 °C or more, or thermal status 3+" />
          <Tile total={d.total} title="Low RAM" value={f.lowMem} listKey="lowMem" tone={tone(f.lowMem, 'warn')} hint="Under 250 MB free" />
          <Tile total={d.total} title="Low disk" value={f.lowDisk} listKey="lowDisk" tone={tone(f.lowDisk, 'warn')} hint="Under 300 MB free" />
          <Tile total={d.total} title="No hardware data" value={f.noHwData} listKey="noHwData" tone="neutral" hint="Agent older than 1.4.7" />
        </div>
      </div>

      <div className="card">
        <h3>Interaction</h3>
        <div className="tiles">
          <Tile total={d.total} title="UI static ≥ 6 h (incl. 24 h+)" value={d.interaction.uiIdle6h} listKey="uiIdle6h" tone="neutral" />
          <Tile total={d.total} title="UI static ≥ 24 h" value={d.interaction.uiIdle24h} listKey="uiIdle24h" tone={tone(d.interaction.uiIdle24h, 'warn')} />
          <Tile total={d.total} title="No remote session in 7 d" value={d.interaction.noSession7d} listKey="noSession7d" tone="neutral" />
        </div>
        <div className="hw-muted">
          “UI static” means no change on the device screen (accessibility events); a kiosk page that never changes is static by design.
          Real finger touches are not reported by the agent yet.
        </div>
      </div>

      <div className="card">
        <h3>Battery and network</h3>
        <div className="tiles">
          <Tile total={d.total} title="Low battery (unplugged)" value={d.battery.low} listKey="lowBattery" tone={tone(d.battery.low)} />
          <Tile total={d.total} title="Not charging" value={d.battery.notCharging} listKey="notCharging" tone={tone(d.battery.notCharging, 'warn')} />
          <Tile total={d.total} title="Wi-Fi" value={d.network.wifi} listKey="wifi" tone="neutral" />
          <Tile total={d.total} title="Cellular" value={d.network.cellular} listKey="cellular" tone="neutral" />
          <Tile total={d.total} title="Ethernet" value={d.network.ethernet} listKey="ethernet" tone="neutral" />
          <Tile total={d.total} title="Weak cellular signal" value={d.network.weakSignal} listKey="weakSignal" tone={tone(d.network.weakSignal, 'warn')} />
        </div>
      </div>

      <div className="card">
        <h3>Agent versions</h3>
        {d.versions.map((v) => (
          <div key={v.version} className="row">
            <Link to={`/dashboard/${encodeURIComponent(`ver:${v.version}`)}`} style={{ minWidth: 70 }}><b>{v.version}</b></Link>
            <div className="bar"><span style={{ width: `${pct(v.count)}%` }} /></div>
            <span className="hw-muted">{v.count}</span>
          </div>
        ))}
        {d.outdated > 0 && (
          <Link className="chip bad" to="/dashboard/outdated">{d.outdated} below the minimum supported version</Link>
        )}
      </div>

      <div className="card">
        <h3>Hardware events (last 24 h)</h3>
        {d.events24h.map((e) => (
          <div key={e.code} className="hw-line"><b>{e.code}</b> · {e.devices} device{e.devices === 1 ? '' : 's'}</div>
        ))}
        {!d.events24h.length && <div className="hw-muted">No hardware events.</div>}
      </div>

      <div className="card">
        <h3>Needs attention</h3>
        {d.attention.map((a) => (
          <div key={a.deviceId} className="row attn">
            <Link to={`/hw/${encodeURIComponent(a.deviceId)}`}><b>{a.label || a.deviceId}</b></Link>
            <span className="hw-muted">{a.group}</span>
            <span className="chips">
              {a.reasons.map((r) => <span key={r} className="chip bad">{REASON_LABEL[r] ?? r}</span>)}
            </span>
          </div>
        ))}
        {!d.attention.length && <div className="hw-muted">Nothing needs attention.</div>}
      </div>
    </div>
  );
}
