/**
 * Download, verify and stage one release package. Nothing is extracted before the streamed sha256 and the size equal the SIGNED values.
 * Extraction goes through the strict zip reader (src/core/blender/zip.ts, imported unchanged) into a fresh folder under <install>/.update/staging,
 * then the content is checked. Any failure removes the staging folder and leaves the live install untouched.
 */
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { extractZip, ZipError, type ZipSink, type ZipSource } from '../blender/zip.js';
import { CODE_SET, removeOwned, UPDATE_DIR } from './apply.js';
import { assetUrl, LIMITS, type UpdateSource } from './config.js';
import type { Manifest } from './manifest.js';
import { downloadFile, NetError, type FetchLike } from './net.js';

export class StageError extends Error {
  constructor(public readonly code: 'disk' | 'hash' | 'zip' | 'content' | 'full-install' | 'net' | 'unsafe', message: string) { super(message); }
}
export interface Staged { version: string; treeDir: string; zipSha256: string }
export interface StageOptions {
  installDir: string; source: UpdateSource; manifest: Manifest; version: string;
  /** sha256 of the INSTALLED package-lock.json (undefined: unreadable, treated as a mismatch). */
  installedLockSha256?: string;
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

/** Content checks on the extracted tree (plan section 4, steps 8-9). Throws StageError. */
export function checkTree(treeDir: string, m: Manifest, installedLockSha256: string | undefined): void {
  for (const n of readdirSync(treeDir)) if (!CODE_SET.includes(n)) throw new StageError('content', `the package contains "${n}", which is not part of the update set`);
  for (const must of ['dist/src/electron/main.js', 'dist/src/bin/legion-core.js', 'dist-ui/index.html', 'package.json', 'package-lock.json']) {
    if (!existsSync(join(treeDir, must))) throw new StageError('content', `the package is missing ${must}`);
  }
  let pkg: { version?: unknown };
  try { pkg = JSON.parse(readFileSync(join(treeDir, 'package.json'), 'utf8')) as typeof pkg; } catch { throw new StageError('content', 'package.json in the package is not valid JSON'); }
  if (pkg.version !== m.version) throw new StageError('content', 'package.json does not carry the signed version');
  const lock = sha256(readFileSync(join(treeDir, 'package-lock.json')));
  if (lock !== m.depsSha256) throw new StageError('content', 'the dependency lock in the package differs from the signed one');
  if (m.requiresFullInstall || installedLockSha256 !== lock) throw new StageError('full-install', 'this release changes dependencies: it needs a full install (download the source of the release and run setup.cmd)');
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
    checkTree(treeDir, m, o.installedLockSha256);
    writeFileSync(join(work, 'stage.json'), JSON.stringify({ version: o.version, zipSha256: dl.sha256, at: Date.now() }));
    return { version: o.version, treeDir, zipSha256: dl.sha256 };
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

/** Whether a staged package of this version is complete on disk (stage.json written last). */
export function stagedTree(installDir: string, version: string): string | null {
  const work = join(stagingRoot(installDir), version);
  try {
    const j = JSON.parse(readFileSync(join(work, 'stage.json'), 'utf8')) as { version?: string };
    const tree = join(work, 'x', `legion-${version}`);
    return j.version === version && existsSync(join(tree, 'package.json')) ? tree : null;
  } catch { return null; }
}
