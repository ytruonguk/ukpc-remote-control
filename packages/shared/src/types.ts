export type Tier = 'READY' | 'DEGRADED' | 'NOT_READY' | 'OFFLINE';

export type KnoxState = 'licensed' | 'unlicensed' | 'unsupported';
export type ProjectMedia = 'allow' | 'default' | 'blocked';
export type EntryPoint = 'hmdm_deeplink' | 'rc_console' | 'api';
export type SessionState = 'probing' | 'starting' | 'active' | 'closed' | 'failed';
export type OperatorRole = 'admin' | 'supervisor' | 'operator';

export type BlockerCode =
  | 'NO_CAPTURE_PATH'
  | 'NO_INPUT_PATH'
  | 'NO_BG_ACTIVITY_START'
  | 'AGENT_OUTDATED'
  | 'NEEDS_REPROVISIONING';

export type BlockerFix = 'reprovision' | 'selfheal' | 'update';

export interface Blocker {
  code: BlockerCode;
  fix: BlockerFix;
}

export interface Caps {
  projectMedia: ProjectMedia;
  a11y: boolean;
  knox: KnoxState;
  overlay: boolean;
  secureSettings: boolean;
  encoder?: { name: string; hw: boolean };
}

export interface Volatile {
  screenOn: boolean;
  charging: boolean;
  batteryPct: number;
  net: string;
  rssi: number;
}

export interface DeviceState {
  online: boolean;
  agentVer: string;
  caps: Caps;
  volatile: Volatile;
  needsReprovisioning?: boolean;
}

export interface Readiness {
  tier: Tier;
  blockers?: Blocker[];
  warns?: string[];
}

export interface StateMsg {
  online?: boolean;
  agentVer?: string;
  androidId?: string;
  caps?: Caps;
  volatile?: Partial<Volatile>;
  ts: number;
}

export const MIN_AGENT_VER = '1.2.0';

export const TTL = {
  device: 180,
  session: 7200,
  tokenUsed: 120,
  relayLoad: 30,
} as const;
