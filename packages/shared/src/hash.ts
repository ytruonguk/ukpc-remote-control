import { createHash } from 'node:crypto';
import type { Caps } from './types';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function capsHash(caps: Caps, agentVer: string): string {
  return createHash('sha1')
    .update(stableStringify(caps) + agentVer)
    .digest('hex');
}

export function capsDiff(prev: Caps | null, next: Caps): Record<string, [unknown, unknown]> {
  if (!prev) return { initial: [null, next] };
  const changed: Record<string, [unknown, unknown]> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof Caps>;
  for (const k of keys) {
    const a = JSON.stringify(prev[k]);
    const b = JSON.stringify(next[k]);
    if (a !== b) changed[k] = [prev[k], next[k]];
  }
  return changed;
}
