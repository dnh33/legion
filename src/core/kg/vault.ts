/**
 * Markdown vault interop (Obsidian-style): export one .md per node, import .md files as notes.
 * YAML frontmatter is handled by a tiny hand parser/writer; no dependencies.
 * Import is read-only on the vault and idempotent; vault content never decides scope or authorship.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { KG_LIMITS } from '../../shared/kg.js';
import type { KgNode, KgSource } from '../../shared/kg.js';
import type { Graph } from './graph.js';
import { isUntrusted, oneLine, statusOf } from './text.js';
import { HUMAN, isNodeType, KgError, WM_PREFIX } from './types.js';
import type { Actor, ExportReport, ImportReport } from './types.js';

/** The only folder inside a vault that Legion writes to. */
export const LIBRARY_DIR = 'legion';
/** Dropped into the mirror folder: import skips any folder that holds it, wherever the folder was moved or renamed to. */
export const MIRROR_MARKER = '.legion-mirror';

/**
 * Writes a file without ever writing THROUGH a link: the text goes to a new file (exclusive create, so an existing name,
 * a planted link included, is never opened) and is then renamed over the target, which replaces a link at the target
 * name instead of following it.
 */
export function writeFileNoFollow(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o644);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
export const VAULT_MAX_FILES = 5_000;
export const VAULT_MAX_FILE_BYTES = 200 * 1024;

// ------------------------------------------------------------------ frontmatter

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

function parseScalar(raw: string): YamlValue {
  const v = raw.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v) as string; } catch { return v.replace(/^"|"$/g, ''); } }
  if (v.startsWith("'")) return v.replace(/^'|'$/g, '').replace(/''/g, "'");
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1)).map(parseScalar);
  const bare = v.replace(/\s+#.*$/, '');
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (bare === 'null' || bare === '~' || bare === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  return bare;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else if (c === q) q = '';
    } else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** Splits `---\n...\n---` frontmatter from the body. Unparseable lines are ignored. */
export function parseFrontmatter(text: string): { data: Record<string, YamlValue>; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const lines = m[1]!.split('\n');
  const data: Record<string, YamlValue> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    if (kv[2]!.trim() !== '') { data[key] = parseScalar(kv[2]!); continue; }
    // block list: following lines that start with "- " or are indented continuation lines
    const items: YamlValue[] = [];
    const map: { [k: string]: YamlValue } = {};
    let cur: { [k: string]: YamlValue } | undefined;
    while (i + 1 < lines.length && /^(\s+\S|-\s)/.test(lines[i + 1]!)) {
      const l = lines[++i]!;
      const dash = /^\s*-\s*(.*)$/.exec(l);
      if (dash) {
        const inner = dash[1]!;
        const ikv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(inner);
        if (ikv) { cur = { [ikv[1]!]: parseScalar(ikv[2]!) }; items.push(cur); }
        else { cur = undefined; items.push(parseScalar(inner)); }
      } else if (cur) {
        const ckv = /^\s+([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(l);
        if (ckv) cur[ckv[1]!] = parseScalar(ckv[2]!);
      } else {
        // an indented "key: value" block (props): keys may be quoted
        const mkv = /^\s+("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(l);
        if (mkv) map[mkv[1]!.startsWith('"') ? (JSON.parse(mkv[1]!) as string) : mkv[1]!] = parseScalar(mkv[2]!);
      }
    }
    data[key] = items.length ? items : Object.keys(map).length ? map : null;
  }
  return { data, body: src.slice(m[0].length) };
}

const q = (s: string): string => JSON.stringify(s);

/** Props that describe where a note lives or how Legion treats it, not what it says: never written to or read from a file. */
const RESERVED_PROPS = new Set(['vaultPath', 'vaultHash', 'stub', 'reviewed', 'proposal', 'oldId', 'newId', 'keep', 'drop', 'resolved']);

function frontmatterFor(n: KgNode, mirror = false): string {
  const l = ['---', `id: ${q(n.id)}`, `type: ${n.type}`, `title: ${q(n.title)}`, `tags: [${n.tags.map(q).join(', ')}]`,
    `scope: ${q(n.scope)}`, `createdBy: ${q(n.createdBy)}`, `updatedAt: ${q(n.updatedAt)}`];
  if (mirror) l.push(`mirror: ${q(LIBRARY_DIR)}`);
  // a note that is not clean says so: import turns such a file into a held (pending, untrusted) note instead of a live human note
  if (statusOf(n) !== 'active') l.push(`status: ${q(statusOf(n))}`);
  if (isUntrusted(n)) l.push('trust: "untrusted"');
  if (n.origin?.tainted) l.push('tainted: true');
  if (n.confidence !== undefined) l.push(`confidence: ${n.confidence}`);
  const props = Object.entries(n.props ?? {}).filter(([k]) => !RESERVED_PROPS.has(k));
  if (props.length) {
    l.push('props:');
    for (const [k, v] of props) l.push(`  ${/^[A-Za-z0-9_-]+$/.test(k) ? k : q(k)}: ${typeof v === 'string' ? q(v) : String(v)}`);
  }
  if (n.sources?.length) {
    l.push('sources:');
    for (const s of n.sources) {
      l.push(`  - ref: ${q(s.ref)}`);
      if (s.licence) l.push(`    licence: ${q(s.licence)}`);
      if (s.untrusted) l.push('    untrusted: true');
    }
  }
  l.push('---');
  return l.join('\n');
}

// ------------------------------------------------------------------ export

const slug = (t: string): string =>
  t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
const fileSafeId = (id: string): string => id.replace(/[^A-Za-z0-9_.-]/g, '_');
export const vaultFileName = (n: Pick<KgNode, 'id' | 'title'>): string => `${slug(n.title)}--${fileSafeId(n.id)}.md`;

/** Link text that cannot break out of [[...]]; returns the id hint needed when the text differs from the title. */
const linkText = (t: string): string => oneLine(t).replace(/\[/g, '(').replace(/\]/g, ')').replace(/\|/g, '/').replace(/#/g, '');

/** A copy of the node with every text field scrubbed again: the mirror is where data leaves the log, and old log lines predate the scrub. */
function scrubbedForExport(graph: Graph, n: KgNode): KgNode {
  const s = (t: string): string => graph.scrubForExport(t);
  const out: KgNode = { ...n, title: oneLine(s(n.title)), body: s(n.body), tags: n.tags.map(s) };
  if (n.props) out.props = Object.fromEntries(Object.entries(n.props).map(([k, v]) => [s(k), typeof v === 'string' ? s(v) : v]));
  if (n.sources) out.sources = n.sources.map((x) => ({ ...x, ref: s(x.ref), ...(x.licence ? { licence: s(x.licence) } : {}) }));
  return out;
}

/** One node as a vault file: frontmatter, body and a `## Links` list. `linkable` can hide link targets (the library mirror shows only safe ones). */
function renderNodeFile(graph: Graph, actor: Actor, node: KgNode, titleCount: Map<string, number>, linkable: (t: KgNode) => boolean = () => true, mirror = false): string {
  const n = scrubbedForExport(graph, node);
  const parts = [frontmatterFor(n, mirror), '', n.body.replace(/\s+$/, '')];
  const links: string[] = [];
  for (const e of graph.edgesOf(actor, n.id, 'out')) {
    const t0 = graph.getNode(actor, e.to);
    if (!t0 || !linkable(t0)) continue;
    const t = { ...t0, title: oneLine(graph.scrubForExport(t0.title)) };
    const text = linkText(t.title);
    const ambiguous = (titleCount.get(oneLine(t0.title).toLowerCase()) ?? 0) > 1 || text !== oneLine(t.title);
    links.push(`- ${graph.scrubForExport(e.rel)}:: [[${text}]]${ambiguous ? ` <!-- id:${t.id} -->` : ''}`);
  }
  if (links.length) parts.push('', '## Links', '', ...links);
  return parts.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

export function exportVault(graph: Graph, actor: Actor, dir: string): ExportReport {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  // The BSV pack is bundled with the app and owned by the seeder: import never takes a file for it (it would add a second copy as shared
  // notes), so the export leaves it out and Export all then Import is a no-op for it.
  const nodes = graph.allNodes(actor).filter((n) => n.scope !== 'bsv').sort((a, b) => a.id.localeCompare(b.id));
  const titleCount = new Map<string, number>();
  for (const n of nodes) titleCount.set(oneLine(n.title).toLowerCase(), (titleCount.get(oneLine(n.title).toLowerCase()) ?? 0) + 1);
  const wanted = new Map<string, string>(); // safe id -> new file name
  let written = 0;
  for (const n of nodes) {
    const name = vaultFileName(n);
    try { writeFileNoFollow(join(root, name), renderNodeFile(graph, actor, n, titleCount)); } catch { continue; } // a folder or odd entry in the way: leave it
    wanted.set(fileSafeId(n.id), name);
    written++;
  }
  // a renamed node leaves its old "<old-slug>--<id>.md" behind; remove those so re-import cannot see two files for one id
  let removedStale = 0;
  for (const f of readdirSync(root)) {
    const m = /^.+?--(.+)\.md$/.exec(f);
    const keep = m ? wanted.get(m[1]!) : undefined;
    if (m && keep && keep !== f) { rmSync(join(root, f), { force: true }); removedStale++; }
  }
  return { dir: root, written, removedStale };
}

/** The notes the library mirror writes: live, shared, written by a bot in a clean run, no untrusted source, not already a vault file. */
export function isLibraryExportable(n: KgNode): boolean {
  return n.scope === 'shared' && statusOf(n) === 'active' && !isUntrusted(n) && n.origin?.tainted !== true
    && n.createdBy !== 'human' && n.createdBy !== 'system' && typeof n.props?.vaultPath !== 'string';
}

/**
 * One-way mirror of what the bots wrote into `<vault>/legion/<type>/<slug>--<id>.md`. It writes only active, non-untrusted,
 * shared bot notes and touches nothing outside `<vault>/legion/`; it also removes its own stale files (a renamed or retired
 * note) there. Your own notes are never written to or changed. Import skips the legion/ folder, so nothing loops back.
 */
export function exportLibrary(graph: Graph, dir: string): ExportReport {
  const root = resolve(dir);
  const lib = join(root, LIBRARY_DIR);
  // never follow a link out of the vault: legion/ and its type folders must be real folders
  const realDir = (p: string): void => {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new KgError('invalid', `${p} is a link, not a folder: the library mirror will not write through it.`);
  };
  realDir(lib);
  const inside = (p: string): boolean => resolve(p).startsWith(lib + sep);
  const all = graph.allNodes(HUMAN);
  const nodes = all.filter(isLibraryExportable).sort((a, b) => a.id.localeCompare(b.id));
  const titleCount = new Map<string, number>();
  for (const n of all) titleCount.set(oneLine(n.title).toLowerCase(), (titleCount.get(oneLine(n.title).toLowerCase()) ?? 0) + 1);
  const linkable = (t: KgNode): boolean => t.scope === 'shared' && statusOf(t) === 'active' && !isUntrusted(t);
  mkdirSync(lib, { recursive: true });
  try { writeFileNoFollow(join(lib, MIRROR_MARKER), `${MIRROR_HEADER} Import skips this folder.\n`); } catch { /* the folder name and the mirror frontmatter still protect it */ }
  const wanted = new Set<string>();
  let written = 0;
  for (const n of nodes) {
    const folder = join(lib, n.type);
    const file = join(folder, vaultFileName(n));
    if (!inside(file)) continue;
    realDir(folder);
    mkdirSync(folder, { recursive: true });
    // never through a link at the file name (a bot with a shell can predict "<slug>--<id>.md"): write aside, rename over it
    try { writeFileNoFollow(file, renderNodeFile(graph, HUMAN, n, titleCount, linkable, true)); } catch { continue; }
    wanted.add(resolve(file));
    written++;
  }
  let removedStale = 0;
  for (const folder of readdirSync(lib, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
    for (const f of readdirSync(join(lib, folder.name))) {
      const p = join(lib, folder.name, f);
      if (/^.+--.+\.md$/.test(f) && inside(p) && !wanted.has(resolve(p))) { rmSync(p, { force: true }); removedStale++; }
    }
  }
  return { dir: lib, written, removedStale };
}

// ------------------------------------------------------------------ import

interface ParsedFile {
  rel: string;
  title: string;
  body: string;
  tags: string[];
  type: KgNode['type'];
  confidence?: number;
  props?: Record<string, string | number | boolean>;
  sources: KgSource[];
  fmId?: string;
  /** The frontmatter says scope: bsv (a file an older export wrote for a pack note). */
  claimsBsv?: boolean;
  /** Carries a trigger:* tag: a standing rule for every bot, so it never lands live from a file. */
  trigger: boolean;
  /** The file says it came from a note that was pending, retired, untrusted or tainted: it comes back held, never live. */
  notClean: boolean;
  links: Array<{ rel: string; target: string; idHint?: string }>;
}

const MIRROR_HEADER = 'Written by Legion.';
function isMirrorMarker(p: string): boolean {
  try { return readFileSync(p, 'utf8').startsWith(MIRROR_HEADER); } catch { return false; }
}

function walk(root: string, skipped: ImportReport['skipped']): string[] {
  const files: string[] = [];
  const mirrorSkip = (p: string) => skipped.push({ path: relative(root, p).split(/[\\/]/).join('/') || '.', reason: 'Legion mirror folder (the bots\' notes): never imported back' });
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // a folder that holds Legion's own mirror marker is the mirror, wherever it was moved to or whatever it was renamed to.
    // A marker file with any other content is somebody else's file and protects nothing (a stray one must not hide a whole folder).
    if (entries.some((e) => e.name === MIRROR_MARKER && e.isFile()) && isMirrorMarker(join(dir, MIRROR_MARKER))) { mirrorSkip(dir); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      // (a folder that merely happens to be called Legion is the user's own folder: only the marker and the file front matter identify the mirror)
      if (e.isDirectory()) visit(p);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        if (files.length >= VAULT_MAX_FILES) {
          if (!skipped.some((s) => s.path === '*')) skipped.push({ path: '*', reason: `more than ${VAULT_MAX_FILES} files; the rest were not read` });
          return;
        }
        files.push(p);
      }
    }
  };
  visit(root);
  return files;
}

const TYPE_TAGS: Record<string, KgNode['type']> = { decision: 'decision', mistake: 'mistake', pattern: 'pattern', idea: 'idea' };

/** Inline `#tags` in the text (Obsidian style): not in code, not URL fragments or heading links, and not just a number. */
export function inlineTags(text: string): string[] {
  const plain = stripCode(text).replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\]\([^)]*\)/g, ' ');
  const out: string[] = [];
  for (const m of plain.matchAll(/(?<![\p{L}\p{N}_/&#.:=?%@(-])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu)) out.push(m[1]!.replace(/[-/]+$/, ''));
  return [...new Set(out.filter(Boolean))];
}

/** Text without fenced or inline code, so wikilinks inside code samples are not turned into edges. */
const stripCode = (s: string): string => s.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');

function splitLinksSection(body: string): { main: string; links: string[] } {
  const idx = body.search(/^##[ \t]+Links[ \t]*$/m);
  if (idx < 0) return { main: body, links: [] };
  const rest = body.slice(idx).split('\n').slice(1);
  // the section must be only list lines / blanks, otherwise it is ordinary content
  if (!rest.every((l) => !l.trim() || /^\s*-\s/.test(l))) return { main: body, links: [] };
  return { main: body.slice(0, idx), links: rest.filter((l) => l.trim()) };
}

function parseFile(rel: string, text: string): ParsedFile | string {
  const { data, body: afterFm } = parseFrontmatter(text);
  if (data.mirror === LIBRARY_DIR) return 'Legion mirror file (a bot\'s note): never imported back';
  const { main, links: linkLines } = splitLinksSection(afterFm);
  const body = main.replace(/^\n+/, '').replace(/\s+$/, '');
  let title = typeof data.title === 'string' ? oneLine(data.title) : '';
  if (!title) {
    const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(stripCode(body));
    title = h1 ? oneLine(h1[1]!) : '';
  }
  if (!title) title = oneLine(basename(rel).replace(/\.md$/i, ''));
  if (!title) return 'no usable title';
  if (title.length > KG_LIMITS.titleChars) return `title longer than ${KG_LIMITS.titleChars} chars`;
  if (body.length > KG_LIMITS.bodyChars) return `body longer than ${KG_LIMITS.bodyChars} chars`;

  let tags: string[] = [];
  const t = data.tags;
  if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === 'string');
  else if (typeof t === 'string') tags = t.split(/[,\s]+/);
  tags = tags.map((x) => x.trim()).filter(Boolean);
  const inline = inlineTags(main);
  tags = [...new Set([...tags, ...inline])];

  let props: ParsedFile['props'];
  if (data.props && typeof data.props === 'object' && !Array.isArray(data.props)) {
    props = {};
    for (const [k, v] of Object.entries(data.props)) {
      if (Object.keys(props).length >= 32) break;
      if (RESERVED_PROPS.has(k) || !k || k.length > 64) continue;
      if (typeof v === 'string' ? v.length <= 500 : typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean') props[k] = v as string | number | boolean;
    }
  }

  const sources: KgSource[] = [{ ref: rel }];
  if (Array.isArray(data.sources)) {
    for (const s of data.sources) {
      const ref = typeof s === 'string' ? s : s && typeof s === 'object' && !Array.isArray(s) && typeof s.ref === 'string' ? s.ref : '';
      if (!ref || ref === rel || sources.some((x) => x.ref === ref)) continue;
      const o = typeof s === 'object' && s && !Array.isArray(s) ? s : {};
      sources.push({
        ref, ...(typeof o.licence === 'string' ? { licence: o.licence } : {}), ...(o.untrusted === true ? { untrusted: true } : {}),
      });
    }
  }

  const links: ParsedFile['links'] = [];
  const seen = new Set<string>();
  const add = (relName: string, target: string, idHint?: string) => {
    const tt = oneLine(target.split('|')[0]!.split('#')[0]!);
    if (!tt) return;
    const key = `${relName}\u0000${tt.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ rel: relName, target: tt, ...(idHint ? { idHint } : {}) });
  };
  for (const l of linkLines) {
    const m = /^\s*-\s*([A-Za-z][A-Za-z0-9_ -]*?)::\s*\[\[([^\]]+)\]\](?:\s*<!--\s*id:(\S+?)\s*-->)?/.exec(l);
    if (m) add(m[1]!, m[2]!, m[3]);
  }
  for (const m of stripCode(main).matchAll(/(?<!!)\[\[([^\[\]]+)\]\]/g)) add('mentions', m[1]!);

  const confidence = typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : undefined;
  // an explicit type wins; otherwise #decision, #mistake, #pattern or #idea (inline or in the tags list) picks one
  const tagged = tags.map((t) => TYPE_TAGS[t.replace(/^#+/, '').toLowerCase()]).find(Boolean);
  return {
    rel, title, body, tags, trigger: tags.some((t) => /^#*trigger:/i.test(t)),
    notClean: (typeof data.status === 'string' && data.status !== 'active') || data.trust === 'untrusted' || data.tainted === true,
    type: isNodeType(data.type) ? data.type : tagged ?? 'note',
    ...(props ? { props } : {}), ...(confidence !== undefined ? { confidence } : {}),
    sources, ...(typeof data.id === 'string' ? { fmId: data.id } : {}), ...(data.scope === 'bsv' ? { claimsBsv: true } : {}), links,
  };
}

export interface ImportOptions {
  /**
   * True only for the import the human started from the app (the HTTP route). Files then become the human's own notes.
   * Without it (a script, a test, any other caller) every file lands as a pending, untrusted note that waits in the inbox,
   * because a vault is a folder on disk and a bot with a shell may have written into it.
   */
  userInitiated?: boolean;
}

/** Ids that belong to the engine (working memory, episodes): a file can never claim one, trusted import or not. */
const engineOwnedId = (id: string): boolean => id.startsWith(WM_PREFIX) || id.startsWith('ep:');

/**
 * Reads a vault folder into the graph. Whatever the options, a file never overwrites a note it did not create, never
 * claims an engine-owned id, and a trigger:* tag in a file only ever produces a PENDING note (a proposal in the inbox)
 * so a planted file cannot become a standing rule for every bot. The legion/ mirror is skipped wherever it sits.
 */
export function importVault(graph: Graph, dir: string, actor: Actor = HUMAN, opts: ImportOptions = {}): ImportReport {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new KgError('invalid', `Not a directory: ${root}`);
  const trusted = opts.userInitiated === true && actor.kind === 'human';
  const report: ImportReport = { files: 0, created: 0, updated: 0, unchanged: 0, edges: 0, stubs: 0, held: 0, skipped: [] };
  graph.snapshot();

  // ---- read
  const parsed: ParsedFile[] = [];
  for (const abs of walk(root, report.skipped)) {
    const rel = relative(root, abs).split(/[\\/]/).join('/');
    try {
      if (statSync(abs).size > VAULT_MAX_FILE_BYTES) { report.skipped.push({ path: rel, reason: `file larger than ${VAULT_MAX_FILE_BYTES / 1024} KB` }); continue; }
      const p = parseFile(rel, readFileSync(abs, 'utf8'));
      if (typeof p === 'string') report.skipped.push({ path: rel, reason: p }); else parsed.push(p);
    } catch (e) { report.skipped.push({ path: rel, reason: e instanceof Error ? e.message : String(e) }); }
  }
  report.files = parsed.length;

  // ---- lookups over what already exists
  const existing = graph.allNodes(actor);
  const byVaultPath = new Map<string, KgNode>();
  const byId = new Map<string, KgNode>();
  const stubs = new Map<string, KgNode>();
  const byTitle = new Map<string, KgNode>(); // preferred match per title: non-stub, then oldest
  for (const n of existing) {
    byId.set(n.id, n);
    if (typeof n.props?.vaultPath === 'string') byVaultPath.set(n.props.vaultPath, n);
    const k = oneLine(n.title).toLowerCase();
    if (n.props?.stub === true) { if (!stubs.has(k)) stubs.set(k, n); }
    const cur = byTitle.get(k);
    if (!cur || (cur.props?.stub === true && n.props?.stub !== true) || (!(n.props?.stub === true) && n.createdAt < cur.createdAt)) byTitle.set(k, n);
  }

  // ---- pass 1: notes
  const idOfFile = new Map<string, string>();
  const idOfFmId = new Map<string, string>();
  const claimed = new Set<string>();
  const vaultTitles = new Map<string, string>();
  const hasTrigger = (n: KgNode): boolean => n.tags.some((t) => t.startsWith('trigger:'));
  /** Notes an import may update in place: the human's own, not engine-owned, not private to a bot, not the BSV pack. */
  const owned = (n: KgNode): boolean => n.createdBy === 'human' && !engineOwnedId(n.id) && n.scope !== 'bsv';
  for (const f of parsed) {
    try {
      // a file an older export wrote for a note of the bundled BSV pack: the pack note is already there, a second copy would duplicate it
      if (f.claimsBsv && f.fmId && byId.get(f.fmId)?.scope === 'bsv') { report.skipped.push({ path: f.rel, reason: 'a note of the bundled BSV pack (already in the graph, not imported from files)' }); continue; }
      let held = !trusted || f.trigger || f.notClean;
      let target = byVaultPath.get(f.rel);
      if (target && !owned(target)) target = undefined;
      let viaId = false;
      if (!target && f.fmId && !claimed.has(f.fmId)) {
        // the id in a file is a hint for round trips, honoured only for a note this importer may touch, and only for a trusted import
        if (engineOwnedId(f.fmId)) held = true;
        else if (trusted) {
          let t = byId.get(f.fmId);
          // an accepted proposal replaced the note the file was exported from: follow the chain to the live one
          for (let hop = 0; t && statusOf(t) === 'superseded' && t.supersededBy && hop < 8; hop++) t = byId.get(t.supersededBy) ?? t;
          if (t && owned(t)) { target = t; viaId = true; }
        }
      }
      if (!target) { const s = stubs.get(oneLine(f.title).toLowerCase()); if (s && !claimed.has(s.id) && owned(s)) target = s; }
      if (target && claimed.has(target.id)) target = undefined;
      // a standing note is changed through a proposal, never straight from a file
      if (target && hasTrigger(target) && statusOf(target) === 'active') held = true;
      const baseProps = { ...(target?.props ?? {}) };
      delete baseProps.stub;
      // a file with a props: block is the truth for the note's props; one without leaves them alone
      const props = { ...(f.props ? {} : baseProps), ...(f.props ?? {}), vaultPath: f.rel };
      if (viaId && target) {
        // A file that names an existing note by id may be a round trip or something a bot planted. If it changes the note, the change
        // is a proposal the human reviews in the Inbox (with a diff), never a live overwrite; if it changes nothing, nothing happens.
        const probe = graph.upsertNode(actor, {
          id: target.id, type: f.type, title: f.title, body: f.body, tags: f.tags, props: { ...(f.props ? {} : baseProps), ...(f.props ?? {}) },
          // the importer adds the file path as a source of its own: only the sources the file itself lists count as content
          ...(f.sources.length > 1 ? { sources: f.sources.slice(1) } : {}), ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        }, { dryRun: true });
        if (!probe.changed) {
          claimed.add(target.id);
          idOfFile.set(f.rel, target.id);
          if (f.fmId) idOfFmId.set(f.fmId, target.id);
          vaultTitles.set(oneLine(f.title).toLowerCase(), vaultTitles.get(oneLine(f.title).toLowerCase()) ?? target.id);
          report.unchanged++;
          continue;
        }
        held = true;
      }
      const res = graph.upsertNode(actor, {
        ...(target ? { id: target.id } : {}), type: f.type, title: f.title, body: f.body, tags: f.tags, props,
        sources: f.sources, ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        ...(target ? {} : { scope: 'shared' as const }),
      }, held ? { held: true } : {});
      if (res.pending && (res.created || res.changed)) report.held = (report.held ?? 0) + 1;
      claimed.add(res.node.id);
      idOfFile.set(f.rel, res.node.id);
      if (f.fmId) idOfFmId.set(f.fmId, res.node.id);
      vaultTitles.set(oneLine(f.title).toLowerCase(), vaultTitles.get(oneLine(f.title).toLowerCase()) ?? res.node.id);
      if (res.proposalFor) { /* a proposal in the inbox: counted as held */ } else if (res.created) report.created++; else if (res.changed) report.updated++; else report.unchanged++;
    } catch (e) { report.skipped.push({ path: f.rel, reason: e instanceof Error ? e.message : String(e) }); }
  }

  // ---- pass 2: links, creating entity stubs for unresolved titles
  const resolveTarget = (l: ParsedFile['links'][number], rel: string): string | undefined => {
    if (l.idHint && !engineOwnedId(l.idHint)) {
      const hinted = idOfFmId.get(l.idHint) ?? (trusted ? graph.getNode(actor, l.idHint)?.id : undefined);
      if (hinted) return hinted;
    }
    const k = oneLine(l.target).toLowerCase();
    const inVault = vaultTitles.get(k);
    if (inVault) return inVault;
    const found = byTitle.get(k) ?? graph.findByTitle(actor, l.target)[0];
    if (found) return found.id;
    const stub = graph.upsertNode(actor, { type: 'entity', title: l.target.slice(0, KG_LIMITS.titleChars), scope: 'shared', props: { stub: true }, sources: [{ ref: rel }] }, trusted ? {} : { held: true });
    report.stubs++;
    byTitle.set(k, stub.node);
    return stub.node.id;
  };
  for (const f of parsed) {
    const from = idOfFile.get(f.rel);
    if (!from) continue;
    for (const l of f.links) {
      try {
        const to = resolveTarget(l, f.rel);
        if (!to || to === from) continue;
        if (graph.link(actor, { from, to, rel: l.rel }).created) report.edges++;
      } catch (e) { report.skipped.push({ path: f.rel, reason: `link "${l.target}": ${e instanceof Error ? e.message : String(e)}` }); }
    }
  }
  return report;
}
