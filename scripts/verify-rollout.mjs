#!/usr/bin/env node
// Verifies an agent rollout against the backend. Exit code 0 ONLY when every device in the inventory is on the
// target version (or newer), online and healthy; 1 when something is still pending or unhealthy; 2 on a usage,
// login or API error. Safe to run repeatedly; it only reads.
//
//   RC_API_URL=https://rc.example.com RC_USER=admin RC_PASSWORD=... node scripts/verify-rollout.mjs --target 1.4.8
//   ... --wait 90            poll every 30 s for up to 90 minutes, stop as soon as the rollout is complete
//   ... --expect 150         also fail unless exactly 150 devices are visible (guards against an incomplete inventory)
//   ... --json               machine readable output
//
// Credentials come from the environment (RC_TOKEN, or RC_USER + RC_PASSWORD): never put them on the command line.

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const API = (process.env.RC_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const TARGET = opt('target');
const WAIT_MIN = Number(opt('wait', '0'));
const AS_JSON = flag('json');
const EXPECT = opt('expect') === undefined ? null : Number(opt('expect'));
if (EXPECT !== null && !(Number.isInteger(EXPECT) && EXPECT > 0)) die('--expect must be a positive whole number');

const BUCKETS = [
  ['done', 'updated, online and healthy'],
  ['updatedUnhealthy', 'UPDATED BUT UNHEALTHY'],
  ['updatedOffline', 'UPDATED, NOW OFFLINE (cannot verify)'],
  ['pendingOnline', 'ONLINE BUT NOT UPDATED'],
  ['pendingOffline', 'OFFLINE, NOT UPDATED'],
  ['unknown', 'NO VERSION REPORTED'],
];

function die(msg) {
  console.error(`verify-rollout: ${msg}`);
  process.exit(2);
}

if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(TARGET ?? '')) die('pass --target <version>, for example --target 1.4.8');
if (args.some((a) => /^--(password|token|user)/.test(a))) die('credentials must come from the environment (RC_TOKEN or RC_USER/RC_PASSWORD), not the command line');

async function token() {
  if (process.env.RC_TOKEN) return process.env.RC_TOKEN;
  if (!process.env.RC_USER || !process.env.RC_PASSWORD) die('set RC_TOKEN, or RC_USER and RC_PASSWORD');
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.RC_USER, password: process.env.RC_PASSWORD }),
  }).catch((e) => die(`cannot reach ${API}: ${e.message}`));
  if (!res.ok) die(`login failed (${res.status})`);
  return (await res.json()).token;
}

async function get(path, tok) {
  const res = await fetch(`${API}/api${path}`, { headers: { authorization: `Bearer ${tok}` } }).catch((e) => die(`cannot reach ${API}: ${e.message}`));
  if (!res.ok) die(`${path} -> ${res.status}`);
  return res.json();
}

const ago = (ms) => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? 'now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

async function once(tok) {
  const r = await get(`/fleet/rollout?target=${encodeURIComponent(TARGET)}`, tok);
  const details = {};
  for (const [b] of BUCKETS) {
    if (b === 'done' || !r.counts[b]) continue;
    details[b] = (await get(`/fleet/dashboard/${encodeURIComponent(`rollout:${b}:${TARGET}`)}`, tok)).rows;
  }
  return { r, details };
}

function print({ r, details }) {
  if (AS_JSON) {
    console.log(JSON.stringify({ target: TARGET, complete: r.complete, total: r.total, counts: r.counts, percentDone: r.percentDone, details }, null, 2));
    return;
  }
  console.log(`\nRollout to ${TARGET}: ${r.counts.done}/${r.total} devices done (${r.percentDone}%)${r.complete ? '  -- COMPLETE' : ''}`);
  for (const [b, label] of BUCKETS) console.log(`  ${String(r.counts[b]).padStart(4)}  ${label}`);
  console.log(`  versions: ${r.versions.map((v) => `${v.version} x${v.count}`).join(', ')}`);
  for (const [b, label] of BUCKETS) {
    const rows = details[b];
    if (!rows?.length) continue;
    console.log(`\n${label} (${rows.length})`);
    for (const d of rows.slice(0, 200)) {
      const why = d.reasons?.length ? `  [${d.reasons.join(', ')}]` : '';
      console.log(`  ${d.label || d.deviceId}${d.label ? ` (${d.deviceId})` : ''}  v${d.agentVer ?? '?'}  seen ${d.online ? 'now' : ago(d.lastSeenMs)}${why}`);
    }
    if (rows.length > 200) console.log(`  ... and ${rows.length - 200} more`);
  }
  if (r.total === 0) console.log('\nNo devices visible to this account: nothing was verified.');
}

const tok = await token();
const deadline = Date.now() + WAIT_MIN * 60_000;
let result = await once(tok);
print(result);
while (!result.r.complete && Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, 30_000));
  result = await once(tok);
  if (!AS_JSON) console.log(`\n[${new Date().toLocaleTimeString()}] ${result.r.counts.done}/${result.r.total} done`);
}
if (WAIT_MIN > 0) print(result);
// "complete" only means every device the backend knows about is done. If the inventory itself is short, say so.
const wrongSize = EXPECT !== null && result.r.total !== EXPECT;
if (wrongSize) console.error(`\nINVENTORY MISMATCH: expected ${EXPECT} devices but the backend shows ${result.r.total}. The rollout cannot be called complete.`);
process.exit(result.r.complete && !wrongSize ? 0 : 1);
