/**
 * Asset downloads for the Sculptor (Poly Haven only in this version). Pure logic over two ports (a JSON GET and a file download), so tests use fakes
 * and this file holds no network code; the real ports are in system.ts (https only, public hosts only, host allowlist, size cap).
 *
 * Why Legion downloads and the community add-on does not: the add-on fetches and imports INSIDE Blender, where Legion cannot see what arrives, cannot
 * put it in a per-task folder, cannot record a hash and cannot limit its size. So the add-on's download, generator, export, telemetry and premium commands
 * are never offered, and Legion does the fetching itself:
 *   1. a plan (read-only listing from the Poly Haven API) names every file, its address, its size and the API's md5;
 *   2. the guard shows a card (what, from where, how big) and waits for the owner; nothing is fetched before Allow, and a denied card fetches nothing;
 *   3. the run is marked tainted (downloaded content is outside content);
 *   4. files land ONLY in <data dir>/blender/assets/<task>/<asset>/, plain relative names, an extension allowlist (no .blend, no scripts), per-file
 *      and total caps, md5 checked against the API, sha256 and size recorded in manifest.json next to them, links refused;
 *   5. Legion's own fixed import script loads the data (glTF or an HDRI image). Downloaded scripts are never run.
 * What this does not prove: Poly Haven's files are what they say they are (md5 comes from the same API); a glTF or an image can still be a
 * malformed file for Blender's importers; and the import runs inside the user's open Blender.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { POLYHAVEN_API, POLYHAVEN_HOSTS } from '../../shared/blender.js';
import type { AssetSource } from '../../shared/blender.js';
import { safeSegment } from './exports.js';
import { findLink, isInside, resolveFolder } from './fs-safe.js';

export const ASSET_KINDS = ['hdris', 'models'] as const;
export type AssetKind = typeof ASSET_KINDS[number];
/** Extensions that may land from an asset download. No .blend (it can carry runnable code), no .py, no archives. */
export const ASSET_EXT = new Set(['gltf', 'glb', 'bin', 'png', 'jpg', 'jpeg', 'exr', 'hdr']);
export const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_ASSET_FILES = 40;
export const RESOLUTIONS = new Set(['1k', '2k', '4k']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SEGMENT = /^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$))[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/i;

export interface AssetNet {
  /** GET a JSON document. Only api.polyhaven.com addresses are ever passed. */
  getJson(url: string): Promise<unknown>;
  /** Downloads a file to dest (a .part file renamed at the end); throws past maxBytes. */
  download(url: string, dest: string, opts: { maxBytes: number }): Promise<{ sha256: string; bytes: number }>;
}

export interface PlannedFile {
  rel: string; url: string;
  /** The size the API lists; when it lists none this is the per-file cap (worst case) and `sizeKnown` is false. */
  bytes: number; sizeKnown: boolean; md5: string;
}
export interface AssetPlan {
  source: AssetSource;
  id: string;
  kind: AssetKind;
  resolution: string;
  files: PlannedFile[];
  totalBytes: number;
  /** The file to import: a .gltf/.glb for a model, the image for an HDRI. */
  main: string;
  /** False when at least one file has no listed size: totalBytes is then an upper bound, not a measurement. */
  sizeKnown: boolean;
}
export interface FetchedFile { rel: string; bytes: number; sha256: string }
export interface AssetManifest { source: AssetSource; id: string; kind: AssetKind; resolution: string; fetchedAt: string; main: string; files: FetchedFile[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Is this address on a Poly Haven host (the host or a subdomain), https, with no credentials or odd port? */
export function polyhavenUrlOk(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase();
  return POLYHAVEN_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** A relative file name made of plain segments (no "..", no empty segment, no backslash, no colon), at most 3 deep, with an allowed extension. */
export function safeRel(rel: string): boolean {
  if (typeof rel !== 'string' || !rel || rel.length > 200 || rel.includes('\\') || rel.includes(':') || rel.includes('\0')) return false;
  const parts = rel.split('/');
  if (parts.length > 3 || parts.some((p) => !SEGMENT.test(p) || /[. ]$/.test(p) || p === '..')) return false;
  return ASSET_EXT.has((parts[parts.length - 1]!.split('.').pop() ?? '').toLowerCase());
}

export class AssetError extends Error {}

/** Builds the plan from the API's /files answer. Throws AssetError (plain text) for anything unexpected; nothing is downloaded here. */
export function planFromFiles(source: AssetSource, id: string, kind: AssetKind, resolution: string, files: unknown): AssetPlan {
  if (!isObj(files)) throw new AssetError('The Poly Haven answer was not in the expected shape.');
  const list: PlannedFile[] = [];
  const add = (rel: string, e: unknown): PlannedFile => {
    if (!isObj(e) || typeof e.url !== 'string' || typeof e.md5 !== 'string' || (e.size !== undefined && typeof e.size !== 'number')) throw new AssetError(`A file entry for "${rel}" is missing its address or md5, or its size is not a number.`);
    const sizeKnown = typeof e.size === 'number';
    const size = sizeKnown ? (e.size as number) : MAX_ASSET_FILE_BYTES;
    if (!polyhavenUrlOk(e.url)) throw new AssetError(`A file for "${rel}" is on an address Legion does not accept (${e.url.slice(0, 60)}).`);
    if (!safeRel(rel)) throw new AssetError(`A file name is not allowed: ${JSON.stringify(rel.slice(0, 60))} (plain names with a known image or glTF extension only).`);
    if (!Number.isFinite(size) || size < 0 || size > MAX_ASSET_FILE_BYTES) throw new AssetError(`"${rel}" is ${Math.round(size / 1e6)} MB, over the ${MAX_ASSET_FILE_BYTES / 1e6} MB limit per file.`);
    if (!/^[0-9a-f]{32}$/i.test(e.md5)) throw new AssetError(`The md5 for "${rel}" is not valid.`);
    const f = { rel, url: e.url, bytes: size, sizeKnown, md5: e.md5.toLowerCase() };
    list.push(f);
    return f;
  };
  let main: string;
  if (kind === 'hdris') {
    const byFmt = (files.hdri as Record<string, unknown> | undefined)?.[resolution];
    const fmt = isObj(byFmt) ? (['hdr', 'exr'] as const).find((f) => isObj(byFmt[f])) : undefined;
    if (!isObj(byFmt) || !fmt) throw new AssetError(`"${id}" has no ${resolution} HDRI in .hdr or .exr (${available(files, 'hdri')}).`);
    main = add(`${id}_${resolution}.${fmt}`, byFmt[fmt]).rel;
  } else {
    const gl = (files.gltf as Record<string, unknown> | undefined)?.[resolution];
    const entry = isObj(gl) && isObj(gl.gltf) ? gl.gltf : undefined;
    if (!entry) throw new AssetError(`"${id}" has no ${resolution} glTF model (${available(files, 'gltf')}).`);
    main = add(`${id}.gltf`, entry).rel;
    const inc = isObj(entry.include) ? entry.include : {};
    for (const [rel, e] of Object.entries(inc)) add(rel, e);
  }
  if (list.length > MAX_ASSET_FILES) throw new AssetError(`The asset has ${list.length} files, more than the limit of ${MAX_ASSET_FILES}.`);
  const total = list.reduce((a, f) => a + f.bytes, 0);
  if (total > MAX_ASSET_TOTAL_BYTES) throw new AssetError(`The asset is ${Math.round(total / 1e6)} MB in total, over the ${MAX_ASSET_TOTAL_BYTES / 1e6} MB limit. Try a lower resolution.`);
  const seen = new Set<string>();
  for (const f of list) { const k = f.rel.toLowerCase(); if (seen.has(k)) throw new AssetError(`The asset lists "${f.rel}" twice.`); seen.add(k); }
  return { source, id, kind, resolution, files: list, totalBytes: total, main, sizeKnown: list.every((f) => f.sizeKnown) };
}

const available = (files: Record<string, unknown>, key: string): string => {
  const v = files[key];
  return isObj(v) ? `available: ${Object.keys(v).slice(0, 8).join(', ') || 'none'}` : 'none published';
};

/** The card text: what, from where, how big, where it lands. Everything in it came from Legion or the API listing, never from the model. */
export function cardSummary(plan: AssetPlan, dir: string): string {
  const mb = (plan.totalBytes / (1024 * 1024)).toFixed(1);
  return `Download ${plan.kind === 'hdris' ? 'the HDRI' : 'the model'} "${plan.id}" (${plan.resolution}) from Poly Haven: ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}, ${plan.sizeKnown ? '' : 'up to '}${mb} MB${plan.sizeKnown ? '' : ' (Poly Haven lists no size for some files, so this is the most Legion will accept)'}, `
    + `from ${[...new Set(plan.files.map((f) => new URL(f.url).hostname))].join(', ')}. The files are saved in ${dir} (never in your workspace), checked against Poly Haven's md5, and imported by Legion's own fixed script as ${plan.kind === 'hdris' ? 'the world lighting' : 'a glTF model'} in your open Blender. `
    + 'No downloaded script is run. The result counts as outside content for the rest of this run.';
}

/** Where a task's asset lands. The task segment is the same hashed one as every other task folder. */
export const assetDir = (dataDir: string, taskId: string, assetId: string): string => join(dataDir, 'blender', 'assets', safeSegment(taskId), assetId);

/** Legion's own import script (fixed text; the only variable is a path Legion built). `main` is already validated by safeRel. */
export function importScript(plan: AssetPlan, dir: string): string {
  const p = JSON.stringify(join(dir, ...plan.main.split('/')));
  if (plan.kind === 'models') return `import bpy\nbpy.ops.import_scene.gltf(filepath=${p})\nprint("imported glTF model", ${JSON.stringify(plan.id)})\n`;
  return [
    'import bpy',
    'sc = bpy.context.scene',
    'w = sc.world or bpy.data.worlds.new("World")',
    'sc.world = w',
    'w.use_nodes = True',
    'tree = w.node_tree',
    'tree.nodes.clear()',
    'env = tree.nodes.new("ShaderNodeTexEnvironment")',
    `env.image = bpy.data.images.load(${p})`,
    'bg = tree.nodes.new("ShaderNodeBackground")',
    'out = tree.nodes.new("ShaderNodeOutputWorld")',
    'tree.links.new(env.outputs["Color"], bg.inputs["Color"])',
    'tree.links.new(bg.outputs["Background"], out.inputs["Surface"])',
    `print("set HDRI world", ${JSON.stringify(plan.id)})`,
    '',
  ].join('\n');
}

/**
 * A downloaded .gltf names its buffers and images by `uri`. Blender's importer would load whatever a uri points at, relative to the .gltf: a
 * "../" path or an absolute path would pull a file from outside the asset folder into the scene. So every uri must be a data: URI or a plain
 * relative path that is one of the files Legion itself downloaded (case-sensitive, after percent-decoding). Anything else refuses the whole asset.
 */
export function checkGltfRefs(gltfText: string, downloaded: ReadonlySet<string>): void {
  let doc: unknown;
  try { doc = JSON.parse(gltfText); } catch { throw new AssetError('The glTF file is not valid JSON.'); }
  if (!isObj(doc)) throw new AssetError('The glTF file is not a glTF document.');
  for (const key of ['buffers', 'images'] as const) {
    const list = doc[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new AssetError(`The glTF "${key}" is not a list.`);
    for (const item of list) {
      const uri = isObj(item) ? item.uri : undefined;
      if (uri === undefined) continue;
      if (typeof uri !== 'string') throw new AssetError(`A glTF ${key} entry has a uri that is not text.`);
      if (/^data:/i.test(uri)) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(uri); } catch { throw new AssetError(`A glTF ${key} uri is not valid.`); }
      if (!downloaded.has(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('/') || decoded.includes('\\') || decoded.split('/').includes('..')) {
        throw new AssetError(`The glTF refers to "${uri.slice(0, 80)}", which is not one of the files that were downloaded with it. Nothing was kept.`);
      }
    }
  }
}

export interface FetchResult { ok: boolean; manifest?: AssetManifest; dir?: string; problems: string[] }

const md5Of = (file: string): string => createHash('md5').update(readFileSync(file)).digest('hex');

/**
 * Downloads the planned files into `dir` and checks them. Any problem (a refused name, a size or md5 mismatch, a link in the folder) removes the
 * whole asset folder and reports why; nothing half-fetched is left to import. Returns the manifest that was also written to dir/manifest.json.
 */
export async function fetchPlan(net: AssetNet, plan: AssetPlan, dir: string, now: () => Date = () => new Date()): Promise<FetchResult> {
  const stage = `${dir}.partial`;
  const problems: string[] = [];
  const clean = (): void => { try { rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ } };
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const root = resolveFolder(parent);
  if (!root.ok) return { ok: false, problems: [`The asset folder cannot be used: ${root.error}`] };
  const link = findLink(root.dir);
  if (link) return { ok: false, problems: [`The asset folder holds a symbolic link (${link}); nothing was downloaded.`] };
  clean();
  const got: FetchedFile[] = [];
  try {
    let total = 0;
    for (const f of plan.files) {
      if (!polyhavenUrlOk(f.url) || !safeRel(f.rel)) throw new AssetError(`"${f.rel}" is not allowed.`);
      const dest = join(stage, ...f.rel.split('/'));
      if (!isInside(dest, stage)) throw new AssetError(`"${f.rel}" would land outside the asset folder.`);
      mkdirSync(dirname(dest), { recursive: true });
      const r = await net.download(f.url, dest, { maxBytes: Math.min(MAX_ASSET_FILE_BYTES, f.bytes + 1024) });
      total += r.bytes;
      if (total > MAX_ASSET_TOTAL_BYTES) throw new AssetError('The downloads passed the total size limit.');
      if (statSync(dest).size !== r.bytes) throw new AssetError(`"${f.rel}" changed while it was written.`);
      if (md5Of(dest) !== f.md5) throw new AssetError(`"${f.rel}" does not match the md5 Poly Haven lists. It was not kept.`);
      got.push({ rel: f.rel, bytes: r.bytes, sha256: r.sha256 });
    }
    if (plan.kind === 'models') {
      const mainPath = join(stage, ...plan.main.split('/'));
      if (statSync(mainPath).size > MAX_ASSET_FILE_BYTES) throw new AssetError('The glTF file is too large to check.');
      checkGltfRefs(readFileSync(mainPath, 'utf8'), new Set(plan.files.map((f) => f.rel)));
    }
    const inner = findLink(stage);
    if (inner) throw new AssetError(`A symbolic link appeared in the asset folder (${inner}).`);
    const manifest: AssetManifest = { source: plan.source, id: plan.id, kind: plan.kind, resolution: plan.resolution, fetchedAt: now().toISOString(), main: plan.main, files: got };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    rmSync(dir, { recursive: true, force: true });
    renameSync(stage, dir);
    return { ok: true, manifest, dir, problems };
  } catch (e) {
    clean();
    problems.push(e instanceof Error ? e.message : String(e));
    return { ok: false, problems };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Poly Haven: search and plan
// ---------------------------------------------------------------------------------------------------------------------------------

export interface AssetPort {
  readonly sources: readonly AssetSource[];
  search(source: AssetSource, q: { kind: AssetKind; query?: string; category?: string; limit?: number }): Promise<{ ok: boolean; text: string }>;
  plan(source: AssetSource, q: { id: string; kind: AssetKind; resolution: string }): Promise<{ ok: true; plan: AssetPlan } | { ok: false; error: string }>;
  retrieve(plan: AssetPlan, dir: string): Promise<FetchResult>;
}

export class PolyHavenAssets implements AssetPort {
  readonly sources = ['polyhaven'] as const;
  constructor(private readonly net: AssetNet, private readonly now: () => Date = () => new Date()) {}

  async search(_s: AssetSource, q: { kind: AssetKind; query?: string; category?: string; limit?: number }): Promise<{ ok: boolean; text: string }> {
    const params = new URLSearchParams({ type: q.kind });
    if (q.category && /^[A-Za-z0-9 &/_-]{1,80}$/.test(q.category)) params.set('category', q.category);
    try {
      const raw = await this.net.getJson(`${POLYHAVEN_API}/assets?${params.toString()}`);
      if (!isObj(raw)) return { ok: false, text: 'Poly Haven answered in a shape Legion does not understand.' };
      const needle = (q.query ?? '').trim().toLowerCase();
      const rows: string[] = [];
      for (const [id, info] of Object.entries(raw)) {
        if (!ID_RE.test(id) || !isObj(info)) continue;
        const name = typeof info.name === 'string' ? info.name.slice(0, 80) : id;
        const tags = Array.isArray(info.tags) ? info.tags.filter((t): t is string => typeof t === 'string').slice(0, 6).join(', ') : '';
        if (needle && !`${id} ${name} ${tags}`.toLowerCase().includes(needle)) continue;
        rows.push(`${id}: ${name}${tags ? ` [${tags}]` : ''}`);
        if (rows.length >= Math.min(50, Math.max(1, q.limit ?? 20))) break;
      }
      return { ok: true, text: rows.length ? rows.join('\n') : 'No Poly Haven assets matched.' };
    } catch (e) { return { ok: false, text: e instanceof Error ? e.message : String(e) }; }
  }

  async plan(source: AssetSource, q: { id: string; kind: AssetKind; resolution: string }): Promise<{ ok: true; plan: AssetPlan } | { ok: false; error: string }> {
    if (!ID_RE.test(q.id)) return { ok: false, error: 'The asset id may only hold letters, digits, dashes and underscores.' };
    if (!RESOLUTIONS.has(q.resolution)) return { ok: false, error: 'resolution must be 1k, 2k or 4k.' };
    try {
      const files = await this.net.getJson(`${POLYHAVEN_API}/files/${encodeURIComponent(q.id)}`);
      return { ok: true, plan: planFromFiles(source, q.id, q.kind, q.resolution, files) };
    } catch (e) { return { ok: false, error: e instanceof AssetError ? e.message : `Poly Haven could not be reached: ${e instanceof Error ? e.message : String(e)}` }; }
  }

  retrieve(plan: AssetPlan, dir: string): Promise<FetchResult> { return fetchPlan(this.net, plan, dir, this.now); }
}
