/** Strict manifest parsing and the downgrade/replay policy. Call parseManifest ONLY on bytes whose signature already verified. */
import { assetNameFor, LIMITS } from './config.js';
import { compareSemver, isPlainSemver } from './semver.js';

export interface Manifest {
  schema: 1; product: 'legion'; channel: 'stable'; version: string; publishedAt: string;
  asset: { name: string; size: number; sha256: string };
  depsSha256: string; requiresFullInstall: boolean; notes: string;
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
  const notes = j.notes === undefined ? '' : j.notes;
  if (typeof notes !== 'string' || notes.length > LIMITS.notesChars) throw new ManifestError('the notes are not text or are too long');
  return { schema: 1, product: 'legion', channel: 'stable', version: j.version, publishedAt: j.publishedAt as string, asset: { name: a.name, size: a.size, sha256: a.sha256 }, depsSha256: j.depsSha256, requiresFullInstall: j.requiresFullInstall, notes };
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
