export const keys = {
  device: (deviceId: string) => `device:${deviceId}`,
  deviceCaps: (deviceId: string) => `device:caps:${deviceId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  activeSession: (deviceId: string) => `device:activeSession:${deviceId}`,
  tokenUsed: (jti: string) => `token:used:${jti}`,
  relayLoad: (node: string) => `relay:${node}:load`,
  relayNodes: 'relay:nodes',
} as const;
