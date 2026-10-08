/**
 * Download, verify and stage one release package. Nothing is extracted before the streamed sha256 and the size equal the SIGNED values.
 * Extraction goes through the strict zip reader (src/core/blender/zip.ts, imported unchanged) into a fresh folder under <install>/.update/staging,
 * then the content is checked. Any failure removes the staging folder and leaves the live install untouched.
 */
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { extractZip, ZipError, type ZipSink, type ZipSource } from '../blender/zip.js';
import { CODE_SET, FULL_PACKAGE_SET, removeOwned, UPDATE_DIR } from './apply.js';
import { assetUrl, fullAssetUrl, LIMITS, type UpdateSource } from './config.js';
import type { Manifest } from './manifest.js';
import { downloadFile, NetError, type FetchLike } from './net.js';

export class StageError extends Error {
  constructor(public readonly code: 'disk' | 'hash' | 'zip' | 'content' | 'full-install' | 'net' | 'unsafe', message: string) { super(message); }
}
export interface Staged { version: string; treeDir: string; zipSha256: string; /** 'code': the app package (code set only). 'full': the full package (code set + node_modules + runtime). */ kind: 'code' | 'full' }
export interface StageOptions {
  installDir: string; source: UpdateSource; manifest: Manifest; version: string;
  /** sha256 of the INSTALLED package-lock.json (undefined: unreadable, treated as a mismatch). */
  installedDepsHash?: string;
  freeBytes?: (dir: string) => number;
  onProgress?: (bytes: number, total: number) => void;
  fetchImpl?: FetchLike;
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const stagingRoot = (installDir: string): string => join(installDir, UPDATE_DIR, 'staging');

function defaultFree(dir: string): number { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); }

function fileSource(path: string): ZipSource & { close(): void } {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  return {
    size,
    read: async (offset, length) => { const b = Buffer.alloc(length); const n = readSync(fd, b, 0, length, offset); return b.subarray(0, n); },
    stream: (start, end) => createReadStream(path, { start, end, autoClose: true }),
    close: () => { try { closeSync(fd); } catch { /* ignore */ } },
  };
}
const fileSink: ZipSink = {
  mkdirp: (d) => { mkdirSync(d, { recursive: true }); },
  openWrite: (f) => createWriteStream(f, { flags: 'wx' }),
};

/** Whether <install>/.update/staging exists as a real directory (not a link) or can be created as one. */
function ensureStagingRoot(installDir: string): string {
  const up = join(installDir, UPDATE_DIR);
  mkdirSync(up, { recursive: true });
  const root = stagingRoot(installDir);
  mkdirSync(root, { recursive: true });
  for (const p of [up, root]) if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory()) throw new StageError('unsafe', 'the update folder is not a plain directory');
  return root;
}

/**
 * The hash that decides whether a release changes dependencies.
 *
 * `depsSha256` in the signed manifest is the hash of the WHOLE `package-lock.json` file, and that hash necessarily changes
 * on every release because the file carries its own `version` field (npm rewrites it on every bump). Comparing that raw hash
 * against the installed one therefore reported "this release changes dependencies" for EVERY patch, forcing a full reinstall
 * and making self-update impossible in practice (owner hit exactly this on 2026-10-03).
 *
 * So compare the DEPENDENCY CONTENT instead: the lock with its own version fields blanked out. A release that only bumps its
 * own version hashes identically to the installed lock and self-applies; a release that actually adds, removes or bumps a
 * dependency still differs, and still requires a full install.
 */
export function dependencyHash(lockJson: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(lockJson); } catch { return sha256(Buffer.from(lockJson, 'utf8')); } // unparseable: fall back to the raw bytes
  // Only the top-level lock `version` and the root package entry's `version` are the lock's own; a dependency's "version" is
  // load-bearing and must stay in the hash.
  return sha256(Buffer.from(JSON.stringify(strippedRoot(parsed)), 'utf8'));
}

function strippedRoot(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const clone = structuredClone(parsed) as Record<string, unknown>;
  delete clone.version;
  const pkgs = clone.packages as Record<string, unknown> | undefined;
  if (pkgs && typeof pkgs === 'object') {
    const rootEntry = pkgs[''];
    if (rootEntry && typeof rootEntry === 'object') { const e = { ...(rootEntry as Record<string, unknown>) }; delete e.version; pkgs[''] = e; }
  }
  return clone;
}

/** Content checks on the extracted tree (plan section 4, steps 8-9). Throws StageError. */
export function checkTree(treeDir: string, m: Manifest, installedDepsHash: string | undefined): void {
  for (const n of readdirSync(treeDir)) if (!CODE_SET.includes(n)) throw new StageError('content', `the package contains "${n}", which is not part of the update set`);
  for (const must of ['dist/src/electron/main.js', 'dist/src/bin/legion-core.js', 'dist-ui/index.html', 'package.json', 'package-lock.json']) {
    if (!existsSync(join(treeDir, must))) throw new StageError('content', `the package is missing ${must}`);
  }
  let pkg: { version?: unknown };
  try { pkg = JSON.parse(readFileSync(join(treeDir, 'package.json'), 'utf8')) as typeof pkg; } catch { throw new StageError('content', 'package.json in the package is not valid JSON'); }
  if (pkg.version !== m.version) throw new StageError('content', 'package.json does not carry the signed version');
  const lock = sha256(readFileSync(join(treeDir, 'package-lock.json')));
  if (lock !== m.depsSha256) throw new StageError('content', 'the dependency lock in the package differs from the signed one');
  // Fail closed: if we cannot tell what the installed dependencies are, we must NOT assume they match. An unknown installed
  // dependency hash means "treat as changed", so an unreadable install is notify-only rather than silently overwritten.
  if (m.requiresFullInstall || installedDepsHash === undefined || installedDepsHash !== dependencyHash(readFileSync(join(treeDir, 'package-lock.json'), 'utf8')))
    throw new StageError('full-install', 'this release changes dependencies: it needs a full install (download the source of the release and run setup.cmd)');
}

/** Downloads, verifies and extracts. Returns the staged tree, or throws StageError/NetError after removing the staging folder. */
export async function stagePackage(o: StageOptions): Promise<Staged> {
  const { installDir, manifest: m } = o;
  const free = (o.freeBytes ?? defaultFree)(installDir);
  if (free < m.asset.size * 3) throw new StageError('disk', `not enough free space: about ${Math.ceil((m.asset.size * 3) / 1e6)} MB are needed on the install drive`);
  const root = ensureStagingRoot(installDir);
  const work = join(root, o.version);
  removeOwned(installDir, work);
  mkdirSync(work, { recursive: true });
  const part = join(work, 'package.zip.part');
  const zip = join(work, 'package.zip');
  try {
    let dl;
    try {
      dl = await downloadFile(assetUrl(o.source, o.version), o.source.policy, part, { exactSize: m.asset.size, version: o.version, ...(o.onProgress ? { onProgress: (b: number) => o.onProgress!(b, m.asset.size) } : {}), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    } catch (e) {
      if (e instanceof NetError) throw new StageError(e.message === 'the disk is full' ? 'disk' : 'net', e.message);
      throw e;
    }
    if (dl.sha256 !== m.asset.sha256) throw new StageError('hash', 'the downloaded file does not match the signed sha256');
    renameSync(part, zip);
    const src = fileSource(zip);
    const extractTo = join(work, 'x');
    try {
      await extractZip(src, fileSink, extractTo, `legion-${o.version}`, { maxEntries: LIMITS.entries, maxUnpackedBytes: LIMITS.unpackedBytes });
    } catch (e) {
      if (e instanceof ZipError) throw new StageError('zip', e.message);
      if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new StageError('disk', 'the disk is full');
      throw e;
    } finally { src.close(); }
    const treeDir = join(extractTo, `legion-${o.version}`);
    walkCheck(treeDir);
    checkTree(treeDir, m, o.installedDepsHash);
    writeFileSync(join(work, 'stage.json'), JSON.stringify({ version: o.version, zipSha256: dl.sha256, kind: 'code', at: Date.now() }));
    return { version: o.version, treeDir, zipSha256: dl.sha256, kind: 'code' };
  } catch (e) {
    try { removeOwned(installDir, work); } catch { /* leftovers are inside .update and harmless */ }
    throw e;
  }
}

/** No links, no overlong paths, in what was extracted. */
function walkCheck(root: string): void {
  const walk = (d: string, depth: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = depth ? `${depth}/${n}` : n;
      if (rel.length > LIMITS.relPathChars) throw new StageError('content', 'a path in the package is too long for Windows');
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new StageError('content', 'the package contains a link');
      if (st.isDirectory()) walk(p, rel);
    }
  };
  walk(root, '');
}

/** The full package's own file list, and the two executables a Legion package must ship (mirrors scripts/lib/package-lib.mjs). */
const FULL_LIST = 'PACKAGE-FILES.json';
const FULL_REQUIRED_EXES: readonly string[] = Object.freeze([
  'runtime/electron/electron.exe',
  'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
]);

export interface FullStageOptions {
  installDir: string; source: UpdateSource; manifest: Manifest; version: string;
  freeBytes?: (dir: string) => number;
  onProgress?: (bytes: number, total: number) => void;
  fetchImpl?: FetchLike;
}

/**
 * Content checks on the extracted FULL package. The scope is broader than `checkTree`: `node_modules` and `runtime` are
 * allowed and REQUIRED, because that is the whole point of a dependency-change update. As with `checkTree`, the signed
 * whole-zip sha256 and the strict extractor already vouch for the bytes; this confirms the shape, the signed version, the
 * signed lock, and that the package's own file list names the runtime and the bundled claude.exe. An unsafe or empty full
 * package never reaches a swap.
 */
export function checkFullTree(treeDir: string, m: Manifest): void {
  const fa = m.fullAsset;
  if (!fa) throw new StageError('full-install', 'this release carries no signed full package');
  const allowed = [...FULL_PACKAGE_SET, FULL_LIST];
  for (const n of readdirSync(treeDir)) if (!allowed.includes(n)) throw new StageError('content', `the full package contains "${n}", which is not part of a Legion package`);
  for (const must of ['package.json', 'package-lock.json', 'dist/src/electron/main.js', 'dist/src/bin/legion-core.js', 'dist-ui/index.html', 'node_modules', 'runtime', FULL_LIST])
    if (!existsSync(join(treeDir, must))) throw new StageError('content', `the full package is missing ${must}`);
  let pkg: { version?: unknown };
  try { pkg = JSON.parse(readFileSync(join(treeDir, 'package.json'), 'utf8')) as typeof pkg; } catch { throw new StageError('content', 'package.json in the full package is not valid JSON'); }
  if (pkg.version !== m.version) throw new StageError('content', 'the full package does not carry the signed version');
  const lock = sha256(readFileSync(join(treeDir, 'package-lock.json')));
  if (lock !== m.depsSha256) throw new StageError('content', 'the dependency lock in the full package differs from the signed one');
  let list: { schema?: unknown; files?: unknown };
  try { list = JSON.parse(readFileSync(join(treeDir, FULL_LIST), 'utf8')) as typeof list; } catch { throw new StageError('content', 'the full package file list is not valid JSON'); }
  if (!list || list.schema !== 1 || !Array.isArray(list.files) || list.files.length === 0) throw new StageError('content', 'the full package file list has the wrong shape');
  const paths = new Set<string>();
  for (const f of list.files as Array<{ path?: unknown }>) {
    if (!f || typeof f.path !== 'string') throw new StageError('content', 'the full package file list has a malformed entry');
    paths.add(f.path);
  }
  for (const exe of FULL_REQUIRED_EXES) if (!paths.has(exe)) throw new StageError('content', `the full package file list does not name ${exe}`);
}

/**
 * Downloads, verifies and extracts the SIGNED full package for a dependency-change release. Same shape as `stagePackage`,
 * but the asset is `m.fullAsset` (`legion-<version>-win-x64.zip`), the caps are the full-package ones, and the tree is
 * allowed (and required) to carry `node_modules` and `runtime`. There is no installed-deps comparison here: this is the
 * path taken precisely when the dependencies changed.
 */
export async function stageFullPackage(o: FullStageOptions): Promise<Staged> {
  const { installDir, manifest: m } = o;
  const fa = m.fullAsset;
  if (!fa) throw new StageError('full-install', 'this release changes dependencies but carries no signed full package');
  const free = (o.freeBytes ?? defaultFree)(installDir);
  if (free < fa.size * 3) throw new StageError('disk', `not enough free space: about ${Math.ceil((fa.size * 3) / 1e6)} MB are needed on the install drive`);
  const root = ensureStagingRoot(installDir);
  const work = join(root, o.version);
  removeOwned(installDir, work);
  mkdirSync(work, { recursive: true });
  const part = join(work, 'package.zip.part');
  const zip = join(work, 'package.zip');
  try {
    let dl;
    try {
      dl = await downloadFile(fullAssetUrl(o.source, o.version), o.source.policy, part, { exactSize: fa.size, version: o.version, ...(o.onProgress ? { onProgress: (b: number) => o.onProgress!(b, fa.size) } : {}), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    } catch (e) {
      if (e instanceof NetError) throw new StageError(e.message === 'the disk is full' ? 'disk' : 'net', e.message);
      throw e;
    }
    if (dl.sha256 !== fa.sha256) throw new StageError('hash', 'the downloaded full package does not match the signed sha256');
    renameSync(part, zip);
    const src = fileSource(zip);
    const extractTo = join(work, 'x');
    try {
      await extractZip(src, fileSink, extractTo, `legion-${o.version}`, { maxEntries: LIMITS.entries, maxUnpackedBytes: LIMITS.fullUnpackedBytes });
    } catch (e) {
      if (e instanceof ZipError) throw new StageError('zip', e.message);
      if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new StageError('disk', 'the disk is full');
      throw e;
    } finally { src.close(); }
    const treeDir = join(extractTo, `legion-${o.version}`);
    walkCheck(treeDir);
    checkFullTree(treeDir, m);
    writeFileSync(join(work, 'stage.json'), JSON.stringify({ version: o.version, zipSha256: dl.sha256, kind: 'full', at: Date.now() }));
    return { version: o.version, treeDir, zipSha256: dl.sha256, kind: 'full' };
  } catch (e) {
    try { removeOwned(installDir, work); } catch { /* leftovers are inside .update and harmless */ }
    throw e;
  }
}

export interface StagedInfo { treeDir: string; kind: 'code' | 'full' }
/** The staged package of this version, whatever kind, or null (stage.json is written last, so its presence means complete). */
export function stagedInfo(installDir: string, version: string): StagedInfo | null {
  const work = join(stagingRoot(installDir), version);
  try {
    const j = JSON.parse(readFileSync(join(work, 'stage.json'), 'utf8')) as { version?: string; kind?: unknown };
    const treeDir = join(work, 'x', `legion-${version}`);
    if (j.version !== version || !existsSync(join(treeDir, 'package.json'))) return null;
    return { treeDir, kind: j.kind === 'full' ? 'full' : 'code' };
  } catch { return null; }
}

/** Whether a staged package of this version is complete on disk (stage.json written last). */
export function stagedTree(installDir: string, version: string): string | null {
  return stagedInfo(installDir, version)?.treeDir ?? null;
}
