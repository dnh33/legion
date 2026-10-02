/** Plain MAJOR.MINOR.PATCH only (no pre-release, no build metadata): the channel is stable-only in v1. */
export const isPlainSemver = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(v);

/** Numeric compare of two plain semvers: negative, 0, positive. Throws on anything else (never compares strings). */
export function compareSemver(a: string, b: string): number {
  if (!isPlainSemver(a) || !isPlainSemver(b)) throw new Error('not a plain semver');
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}
