import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { portOpen, sleep } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(root, '.env') });

const kids = [];
const NEST_PORTS = [3000, 3001, 3002];

function start(cwd, extraEnv = {}) {
  const child = spawn('node', ['dist/main.js'], {
    cwd: join(root, cwd),
    env: {
      ...process.env,
      SESSION_RATE_LIMIT: '1000',
      API_RATE_LIMIT: '10000',
      RELAY_WS_SCHEME: 'ws',
      HMDM_BASE_URL: '',
      MQTT_USERNAME: process.env.MQTT_USERNAME || 'ingest',
      AGENT_JWT_EXPIRES_SEC: process.env.AGENT_JWT_EXPIRES_SEC ?? '2',
      ...extraEnv,
    },
    stdio: 'inherit',
  });
  kids.push(child);
  return child;
}

function killListen(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim();
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening */
  }
}

export async function stopSpawned() {
  const running = kids.splice(0);
  await Promise.all(
    running.map(
      (k) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          if (typeof k.once === 'function') k.once('exit', done);
          try {
            k.kill('SIGTERM');
          } catch {
            done();
            return;
          }
          if (typeof k.once !== 'function') done();
        }),
    ),
  );
}

export async function ensureWeb() {
  const port = Number(process.env.RC_WEB_PORT ?? 5174);
  killListen(port);
  await waitPortClosed(port);
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/d/')) {
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url)}` });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  kids.push({
    kill() {
      server.close();
    },
  });
}

export async function ensureStack() {
  for (const [name, port] of [
    ['postgres', 5432],
    ['redis', 6379],
    ['emqx', 1883],
  ]) {
    if (!(await portOpen(port))) {
      throw new Error(`${name} :${port} is not running. docker compose -f docker-compose.dev.yml up -d`);
    }
  }

  if (process.env.RC_TEST_RESTART === '1') {
    for (const port of NEST_PORTS) killListen(port);
    for (const port of NEST_PORTS) await waitPortClosed(port);
    start('apps/rc-api');
    start('apps/rc-relay');
    start('apps/rc-ingest');
  } else {
    if (!(await portOpen(3000))) start('apps/rc-api');
    if (!(await portOpen(3001))) start('apps/rc-relay');
    if (!(await portOpen(3002))) start('apps/rc-ingest');
  }

  await waitPort(3000);
  await waitPort(3001);
  await waitPort(3002);
}

async function waitPortClosed(port) {
  for (let i = 0; i < 40; i++) {
    if (!(await portOpen(port))) return;
    await sleep(100);
  }
  throw new Error(`port :${port} still in use after restart`);
}

async function waitPort(port) {
  for (let i = 0; i < 80; i++) {
    if (await portOpen(port)) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting :${port}`);
}

process.on('exit', () => {
  for (const k of kids) {
    try {
      k.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
});
