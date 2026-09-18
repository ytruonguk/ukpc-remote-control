export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch as T) ?? base;
  }
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}
