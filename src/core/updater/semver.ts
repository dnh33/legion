/**
 * MAJOR.MINOR.PATCH with an OPTIONAL single-letter patch suffix (owner directive 2026-10-03: lettered patch releases such as
 * `0.2.2-a`, a patch on top of an unreleased number).
 *
 * The suffix is deliberately narrow — exactly one lowercase letter. Everything node-semver calls a pre-release but we do not
 * (`-rc1`, `-beta.1`, `-a1`, `-ab`, uppercase, empty) stays REJECTED, so this cannot become a general pre-release channel.
 *
 * Ordering matters more than acceptance here: a suffix must rank BELOW its own plain release and ABOVE the previous one, or
 * the updater offers downgrades and refuses legitimate updates. That is exactly how node-semver orders a pre-release, and
 * test/updater-trust.test.ts pins both directions.
 */
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([a-z]))?$/;

/** Plain MAJOR.MINOR.PATCH, optionally with one lettered patch suffix. */
export const isPlainSemver = (v: unknown): v is string => typeof v === 'string' && VERSION_RE.test(v);

/** Numeric compare of two versions: negative, 0, positive. Throws on anything else (never compares strings). */
export function compareSemver(a: string, b: string): number {
  if (!isPlainSemver(a) || !isPlainSemver(b)) throw new Error('not a plain semver');
  const ma = VERSION_RE.exec(a)!;
  const mb = VERSION_RE.exec(b)!;
  for (let i = 1; i <= 3; i++) if (Number(ma[i]) !== Number(mb[i])) return Number(ma[i]) - Number(mb[i]);
  // Same MAJOR.MINOR.PATCH: the bare version ranks ABOVE its lettered variants, and letters order among themselves
  // (0.2.2 > 0.2.2-b > 0.2.2-a). A missing suffix therefore outranks a present one.
  const sa = ma[4];
  const sb = mb[4];
  if (sa === sb) return 0;
  if (sa === undefined) return 1;
  if (sb === undefined) return -1;
  return sa < sb ? -1 : 1;
}
