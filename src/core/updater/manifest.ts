/** Strict manifest parsing and the downgrade/replay policy. Call parseManifest ONLY on bytes whose signature already verified. */
import { assetNameFor, fullAssetNameFor, LIMITS, UPDATER_GENERATION } from './config.js';
import { compareSemver, isPlainSemver } from './semver.js';

export interface Manifest {
  schema: 1; product: 'legion'; channel: 'stable'; version: string; publishedAt: string;
  asset: { name: string; size: number; sha256: string };
  /**
   * Present only when the release changes its dependency tree (`requiresFullInstall`): the signed name, size and sha256 of
   * the full package (`legion-<version>-win-x64.zip`), which carries `node_modules` and `runtime`. Without it the release is
   * notify-only. Optional so every existing manifest parses unchanged.
   */
  fullAsset?: { name: string; size: number; sha256: string };
  depsSha256: string; requiresFullInstall: boolean; notes: string;
  /** Lowest updater generation (config.ts UPDATER_GENERATION) that may apply this release itself. Absent = any. */
  minUpdater?: number;
  /**
   * A code-only release an older updater may apply first, signed here so no one can swap it. Meaningful only with minUpdater:
   * a client below minUpdater applies this instead, then finds the real release on its next check.
   */
  steppingStone?: { version: string; publishedAt: string; depsSha256: string; asset: { name: string; size: number; sha256: string } };
}
export class ManifestError extends Error {}

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseManifest(bytes: Buffer): Manifest {
  if (bytes.length > LIMITS.manifestBytes) throw new ManifestError('the manifest is too large');
  let j: unknown;
  try { j = JSON.parse(bytes.toString('utf8')); } catch { throw new ManifestError('the manifest is not valid JSON'); }
  if (!isObj(j)) throw new ManifestError('the manifest is not an object');
  if (j.schema !== 1) throw new ManifestError('unsupported manifest schema');
  if (j.product !== 'legion') throw new ManifestError('the manifest is for another product');
  if (j.channel !== 'stable') throw new ManifestError('only the stable channel is supported');
  if (!isPlainSemver(j.version)) throw new ManifestError('the version is not a plain MAJOR.MINOR.PATCH');
  const t = typeof j.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(j.publishedAt) ? Date.parse(j.publishedAt) : NaN;
  if (!Number.isFinite(t)) throw new ManifestError('publishedAt is not a UTC timestamp');
  const a = j.asset;
  if (!isObj(a) || a.name !== assetNameFor(j.version)) throw new ManifestError('the asset name is not the expected one for this version');
  if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0 || a.size > LIMITS.packageBytes) throw new ManifestError('the asset size is missing or over the limit');
  if (typeof a.sha256 !== 'string' || !HEX64.test(a.sha256)) throw new ManifestError('the asset sha256 is not 64 hex characters');
  if (typeof j.depsSha256 !== 'string' || !HEX64.test(j.depsSha256)) throw new ManifestError('depsSha256 is not 64 hex characters');
  if (typeof j.requiresFullInstall !== 'boolean') throw new ManifestError('requiresFullInstall must be true or false');
  // The full package is optional and only ever used for a requiresFullInstall release. When present it is validated just
  // as strictly as the app asset: the exact `legion-<version>-win-x64.zip` name (which carries the version, so it cannot be
  // swapped for another release's file), a positive integer size within the full-package cap, and a 64-hex sha256. A wrong
  // fullAsset fails the whole manifest rather than being ignored, so the owner cannot publish a mis-hashed full package.
  let fullAsset: { name: string; size: number; sha256: string } | undefined;
  if (j.fullAsset !== undefined) {
    const fa = j.fullAsset;
    if (!isObj(fa) || fa.name !== fullAssetNameFor(j.version)) throw new ManifestError('the full-package asset name is not the expected one for this version');
    if (typeof fa.size !== 'number' || !Number.isInteger(fa.size) || fa.size <= 0 || fa.size > LIMITS.fullPackageBytes) throw new ManifestError('the full-package asset size is missing or over the limit');
    if (typeof fa.sha256 !== 'string' || !HEX64.test(fa.sha256)) throw new ManifestError('the full-package sha256 is not 64 hex characters');
    fullAsset = { name: fa.name, size: fa.size, sha256: fa.sha256 };
  }
  // minUpdater and steppingStone are generation 2 additions. Both are optional and a 0.2.7 parser ignores them (it reads only the
  // fields it knows), so adding them breaks nothing there. When present they are as strict as the rest: a wrong one fails the manifest.
  let minUpdater: number | undefined;
  if (j.minUpdater !== undefined) {
    if (typeof j.minUpdater !== 'number' || !Number.isInteger(j.minUpdater) || j.minUpdater < 1 || j.minUpdater > 1000) throw new ManifestError('minUpdater must be a whole number from 1 to 1000');
    minUpdater = j.minUpdater;
  }
  let steppingStone: Manifest['steppingStone'];
  if (j.steppingStone !== undefined) {
    const st = j.steppingStone;
    if (!isObj(st) || !isPlainSemver(st.version)) throw new ManifestError('the stepping stone has no plain version');
    const sat = typeof st.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(st.publishedAt) ? Date.parse(st.publishedAt) : NaN;
    if (!Number.isFinite(sat)) throw new ManifestError('the stepping stone publishedAt is not a UTC timestamp');
    const sa = st.asset;
    if (!isObj(sa) || sa.name !== assetNameFor(st.version)) throw new ManifestError('the stepping stone asset name is not the expected one for its version');
    if (typeof sa.size !== 'number' || !Number.isInteger(sa.size) || sa.size <= 0 || sa.size > LIMITS.packageBytes) throw new ManifestError('the stepping stone asset size is missing or over the limit');
    if (typeof sa.sha256 !== 'string' || !HEX64.test(sa.sha256)) throw new ManifestError('the stepping stone asset sha256 is not 64 hex characters');
    if (typeof st.depsSha256 !== 'string' || !HEX64.test(st.depsSha256)) throw new ManifestError('the stepping stone depsSha256 is not 64 hex characters');
    steppingStone = { version: st.version, publishedAt: st.publishedAt as string, depsSha256: st.depsSha256, asset: { name: sa.name, size: sa.size, sha256: sa.sha256 } };
  }
  const notes = j.notes === undefined ? '' : j.notes;
  if (typeof notes !== 'string' || notes.length > LIMITS.notesChars) throw new ManifestError('the notes are not text or are too long');
  return { schema: 1, product: 'legion', channel: 'stable', version: j.version, publishedAt: j.publishedAt as string, asset: { name: a.name, size: a.size, sha256: a.sha256 }, ...(fullAsset ? { fullAsset } : {}), ...(minUpdater !== undefined ? { minUpdater } : {}), ...(steppingStone ? { steppingStone } : {}), depsSha256: j.depsSha256, requiresFullInstall: j.requiresFullInstall, notes };
}

export interface RunningBuild { version: string; /** From build-info.json of a package-installed build; unknown for a source build. */ publishedAt?: string }
export type PolicyVerdict = { ok: true } | { ok: false; code: 'up-to-date' | 'downgrade' | 'older-build' | 'future-dated' | 'failed-before'; reason: string };

/** Downgrade and replay rules (plan section 4, step 6). */
export function checkPolicy(m: Manifest, ctx: { running: RunningBuild; nowMs: number; failedVersions: readonly string[] }): PolicyVerdict {
  const c = compareSemver(m.version, ctx.running.version);
  if (c === 0) return { ok: false, code: 'up-to-date', reason: 'already on this version' };
  if (c < 0) return { ok: false, code: 'downgrade', reason: `the release (${m.version}) is older than the running version (${ctx.running.version})` };
  const at = Date.parse(m.publishedAt);
  if (at > ctx.nowMs + 24 * 3600_000) return { ok: false, code: 'future-dated', reason: 'the release is dated more than a day in the future' };
  const built = ctx.running.publishedAt ? Date.parse(ctx.running.publishedAt) : NaN;
  if (Number.isFinite(built) && at < built) return { ok: false, code: 'older-build', reason: 'the release was published before the running build' };
  if (ctx.failedVersions.includes(m.version)) return { ok: false, code: 'failed-before', reason: `version ${m.version} failed its first start here and was rolled back` };
  return { ok: true };
}

export type UpdaterVerdict = { use: Manifest } | { use: null; reason: string };
/**
 * Which release THIS updater may apply, from the signed manifest alone. A manifest without minUpdater, or with one at or below
 * `generation`, is applied as it is. Above it, only the signed stepping stone (a code-only release) may be applied, and that is
 * offered as a manifest of its own, so the rest of the updater treats it like any other code-only release. Without a stone,
 * nothing is offered: a client that cannot apply a release must not be shown an Update button that would fail.
 */
export function manifestForUpdater(m: Manifest, generation: number = UPDATER_GENERATION): UpdaterVerdict {
  if (m.minUpdater === undefined || m.minUpdater <= generation) return { use: m };
  const s = m.steppingStone;
  if (!s) return { use: null, reason: `${m.version} needs a newer updater than this one, and no step update is available for it yet` };
  return {
    use: {
      schema: 1, product: 'legion', channel: 'stable', version: s.version, publishedAt: s.publishedAt, asset: s.asset,
      depsSha256: s.depsSha256, requiresFullInstall: false,
      notes: `A short step update. Legion ${m.version} installs after it, on its next check.`,
    },
  };
}
