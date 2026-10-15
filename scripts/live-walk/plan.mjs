// Pure logic of the live walk (scripts/live-walk/run-live-walk.mjs): which versions an install passes through on its way from `from` to `to`.
// The frozen client before the stepping stone reads only the OLD manifest name, which forever holds the stone, so an install older than the
// stone always lands on the stone first, then on the newest release through the second name (docs/SHIPPING.md, Stepping stones).
const PLAIN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export const isPlainVersion = (v) => typeof v === 'string' && PLAIN.test(v);
export function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
/** The hops, in order. Each is { version, manifest: 'old' | 'second' } (the manifest name the installed client reads for that hop). */
export function planHops({ from, to, stone }) {
  for (const [k, v] of Object.entries({ from, to, stone })) if (!isPlainVersion(v)) throw new Error(`${k} must be a plain version like 0.3.1, got "${v}"`);
  if (compareVersions(from, to) >= 0) throw new Error(`nothing to walk: ${from} is not older than ${to}`);
  if (compareVersions(from, stone) < 0 && compareVersions(to, stone) >= 0) {
    return compareVersions(to, stone) === 0 ? [{ version: stone, manifest: 'old' }] : [{ version: stone, manifest: 'old' }, { version: to, manifest: 'second' }];
  }
  return [{ version: to, manifest: compareVersions(from, stone) < 0 ? 'old' : 'second' }];
}
