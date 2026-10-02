/**
 * Export copy-back shared by both runners (the cloud VM in sandbox.ts and headless Blender on this computer in local.ts).
 * One place holds the rules: known extensions only, plain names, 20 files, 15 MB each, the destination folders must be real folders
 * inside the workspace with no links planted in them, files are written without following links, and a .blend (which can carry
 * runnable code) is set aside in <workspace>/blender-quarantine/<task>/<name>.blend.untrusted, never in blender-exports.
 */
import { basename, dirname, join } from 'node:path';
import { findLink, isInside, resolveFolder, safeWriteFile } from './fs-safe.js';

export const SANDBOX_EXPORT_EXT = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'png', 'jpg', 'jpeg', 'exr', 'blend', 'usd', 'usdc', 'usda', 'usdz', 'abc', 'dae', 'svg', 'mp4', 'webp']);
/** Exports in these formats are set aside, never put in the live export folder: a .blend carries text blocks, drivers and handlers that run when it is opened. */
export const QUARANTINE_EXT = new Set(['blend']);
export const QUARANTINE_SUFFIX = '.untrusted';
export const MAX_EXPORT_BYTES = 15 * 1024 * 1024;
export const MAX_EXPORT_FILES = 20;
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$/;

/** Folder segment for a task id: letters, digits, dash, underscore only. */
export const safeSegment = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'task';

export interface ExportedFile { name: string; path: string; bytes: number; quarantined?: boolean }

export interface CollectRequest {
  /** The agent's workspace folder; files land in <it>/blender-exports/<task>/ (or blender-quarantine). */
  workspace: string;
  taskId: string;
  /** Candidate files in the source (name and size). Anything may be listed; the rules below filter. */
  list: () => Promise<Array<{ name: string; bytes: number }>> | Array<{ name: string; bytes: number }>;
  /** Reads one listed file from the source. */
  read: (name: string) => Promise<Buffer> | Buffer;
  /** Writes a file locally; the default writes without following links (temp file, rename). Tests may pass a fake. */
  write?: (path: string, data: Buffer) => void;
}

export async function collectExports(req: CollectRequest): Promise<{ files: ExportedFile[]; problems: string[] }> {
  const out: ExportedFile[] = [];
  const problems: string[] = [];
  let listed: Array<{ name: string; bytes: number }>;
  try { listed = await req.list(); } catch { return { files: out, problems }; }
  const seg = safeSegment(req.taskId);
  const dest = join(req.workspace, 'blender-exports', seg);
  const qdest = join(req.workspace, 'blender-quarantine', seg);
  const write = req.write ?? ((p: string, data: Buffer) => { safeWriteFile(dirname(p), basename(p), data); });
  // host folders must be real folders inside the workspace, with no links planted in them
  const okDest = (dir: string): boolean => {
    const r = resolveFolder(dir);
    const w = resolveFolder(req.workspace);
    if (!r.ok || !w.ok) { problems.push(`Exports were not copied: ${r.ok ? (w.ok ? '' : w.error) : r.error}`); return false; }
    if (!isInside(r.dir, w.dir)) { problems.push(`Exports were not copied: ${dir} resolves outside the workspace (${r.dir}).`); return false; }
    const link = findLink(r.dir);
    if (link) { problems.push(`Exports were not copied: ${link} is a symbolic link.`); return false; }
    return true;
  };
  const okDirs = new Map<string, boolean>();
  for (const { name, bytes } of listed.slice(0, MAX_EXPORT_FILES)) {
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    if (!SAFE_NAME.test(name) || name !== basename(name) || !SANDBOX_EXPORT_EXT.has(ext)) continue;
    if (!Number.isFinite(bytes) || bytes > MAX_EXPORT_BYTES) continue;
    const quarantine = QUARANTINE_EXT.has(ext);
    const dir = quarantine ? qdest : dest;
    if (!okDirs.has(dir)) okDirs.set(dir, okDest(dir));
    if (!okDirs.get(dir)) continue;
    try {
      const data = await req.read(name);
      if (data.length > MAX_EXPORT_BYTES) continue;
      const path = join(dir, quarantine ? name + QUARANTINE_SUFFIX : name);
      write(path, data);
      out.push({ name, path, bytes: data.length, ...(quarantine ? { quarantined: true } : {}) });
    } catch (e) { problems.push(`${name} could not be copied: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { files: out, problems };
}
