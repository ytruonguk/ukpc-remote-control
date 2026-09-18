#!/usr/bin/env node
import { FakeAgent } from './agent.js';

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

async function main() {
  const count = Number(opt('count', 0));
  const prefix = opt('prefix', 'TAB-');
  const offset = Number(opt('offset', 0));
  const broker = opt('broker', 'mqtt://127.0.0.1:1883');
  const heartbeat = Number(opt('heartbeat', count ? 120 : 5));
  const video = opt('video', '');
  const caps = JSON.parse(opt('caps', 'null') ?? 'null') || undefined;
  const common = {
    broker,
    heartbeat,
    video: video || undefined,
    caps,
    probeDelay: Number(opt('probe-delay', 0)),
    dropKeyframe: flag('drop-keyframe'),
    ignoreViewerJoin: flag('ignore-viewer-join'),
    slowWs: Number(opt('slow-ws', 0)),
    noReconnect: flag('no-reconnect'),
  };

  if (count > 0) {
    const agents = [];
    for (let i = 0; i < count; i++) {
      const n = offset + i + 1;
      const delay = flag('no-jitter') ? 0 : Math.floor(Math.random() * 300_000);
      setTimeout(() => {
        void FakeAgent.start(`${prefix}${pad(n, 6)}`, common).catch((err) => {
          console.error(err);
        });
      }, delay);
      agents.push(n);
    }
    console.log(`spawning ${count} agents prefix=${prefix} offset=${offset} jitter=${!flag('no-jitter')}`);
    await new Promise(() => {});
    return agents;
  }

  const deviceId = opt('device-id', 'TAB-000001');
  const agent = await FakeAgent.start(deviceId, common);
  console.log(`fake-agent ${deviceId} connected ${broker}`);
  process.on('SIGINT', () => void agent.stop().then(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
