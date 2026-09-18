import { relayWsScheme } from '@rc/shared';

export function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

export const config = {
  databaseUrl: () => requiredEnv('DATABASE_URL', 'postgres://rc:rc@localhost:5432/rc'),
  redisUrl: () => requiredEnv('REDIS_URL', 'redis://localhost:6379'),
  mqttUrl: () => requiredEnv('MQTT_URL', 'mqtt://localhost:1883'),
  jwtSecret: () => requiredEnv('JWT_SECRET', 'change-me-in-production'),
  jwtExpiresIn: () => Number(process.env.JWT_EXPIRES_IN_SEC ?? 28800),
  agentJwtExpiresIn: () => Number(process.env.AGENT_JWT_EXPIRES_SEC ?? 60),
  relayNode: () => process.env.RELAY_NODE ?? 'local',
  relayPublicHost: () => process.env.RELAY_PUBLIC_HOST ?? 'localhost:3001',
  relayWsScheme: () => relayWsScheme(),
  hmdmBaseUrl: () => process.env.HMDM_BASE_URL ?? '',
  hmdmUsername: () => process.env.HMDM_USERNAME ?? '',
  hmdmPassword: () => process.env.HMDM_PASSWORD ?? '',
  hmdmAgentPackage: () => process.env.HMDM_AGENT_PACKAGE ?? 'com.you.rcagent',
  hmdmWakeAction: () => process.env.HMDM_WAKE_ACTION ?? 'com.you.rcagent.WAKE',
};
