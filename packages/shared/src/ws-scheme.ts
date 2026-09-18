export function relayWsScheme(env: { RELAY_WS_SCHEME?: string; NODE_ENV?: string } = process.env): 'ws' | 'wss' {
  if (env.RELAY_WS_SCHEME === 'wss' || env.RELAY_WS_SCHEME === 'ws') return env.RELAY_WS_SCHEME;
  return 'ws';
}
