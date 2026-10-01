/**
 * Markdown vault interop (Obsidian-style): export one .md per node, import .md files as notes.
 * YAML frontmatter is handled by a tiny hand parser/writer; no dependencies.
 * Import is read-only on the vault and idempotent; vault content never decides scope or authorship.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { KG_LIMITS } from '../../shared/kg.js';
import type { KgNode, KgSource } from '../../shared/kg.js';
import type { Graph } from './graph.js';
import { oneLine } from './text.js';
import { HUMAN, isNodeType, KgError } from './types.js';
import type { Actor, ExportReport, ImportReport } from './types.js';

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
      }
    }
    data[key] = items.length ? items : null;
  }
  return { data, body: src.slice(m[0].length) };
}

const q = (s: string): string => JSON.stringify(s);

function frontmatterFor(n: KgNode): string {
  const l = ['---', `id: ${q(n.id)}`, `type: ${n.type}`, `title: ${q(n.title)}`, `tags: [${n.tags.map(q).join(', ')}]`,
    `scope: ${q(n.scope)}`, `createdBy: ${q(n.createdBy)}`, `updatedAt: ${q(n.updatedAt)}`];
  if (n.confidence !== undefined) l.push(`confidence: ${n.confidence}`);
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

export function exportVault(graph: Graph, actor: Actor, dir: string): ExportReport {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const nodes = graph.allNodes(actor).sort((a, b) => a.id.localeCompare(b.id));
  const titleCount = new Map<string, number>();
  for (const n of nodes) titleCount.set(oneLine(n.title).toLowerCase(), (titleCount.get(oneLine(n.title).toLowerCase()) ?? 0) + 1);
  const wanted = new Map<string, string>(); // safe id -> new file name
  let written = 0;
  for (const n of nodes) {
    const parts = [frontmatterFor(n), '', n.body.replace(/\s+$/, '')];
    const links: string[] = [];
    for (const e of graph.edgesOf(actor, n.id, 'out')) {
      const t = graph.getNode(actor, e.to);
      if (!t) continue;
      const text = linkText(t.title);
      const ambiguous = (titleCount.get(oneLine(t.title).toLowerCase()) ?? 0) > 1 || text !== oneLine(t.title);
      links.push(`- ${e.rel}:: [[${text}]]${ambiguous ? ` <!-- id:${t.id} -->` : ''}`);
    }
    if (links.length) parts.push('', '## Links', '', ...links);
    const name = vaultFileName(n);
    writeFileSync(join(root, name), parts.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', 'utf8');
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

// ------------------------------------------------------------------ import

interface ParsedFile {
  rel: string;
  title: string;
  body: string;
  tags: string[];
  type: KgNode['type'];
  confidence?: number;
  sources: KgSource[];
  fmId?: string;
  links: Array<{ rel: string; target: string; idHint?: string }>;
}

function walk(root: string, skipped: ImportReport['skipped']): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
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
  return {
    rel, title, body, tags, type: isNodeType(data.type) ? data.type : 'note',
    ...(confidence !== undefined ? { confidence } : {}),
    sources, ...(typeof data.id === 'string' ? { fmId: data.id } : {}), links,
  };
}

export function importVault(graph: Graph, dir: string, actor: Actor = HUMAN): ImportReport {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new KgError('invalid', `Not a directory: ${root}`);
  const report: ImportReport = { files: 0, created: 0, updated: 0, unchanged: 0, edges: 0, stubs: 0, skipped: [] };

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
  for (const f of parsed) {
    try {
      let target = byVaultPath.get(f.rel);
      if (!target && f.fmId && !claimed.has(f.fmId)) target = byId.get(f.fmId);
      if (!target) { const s = stubs.get(oneLine(f.title).toLowerCase()); if (s && !claimed.has(s.id)) target = s; }
      if (target && claimed.has(target.id)) target = undefined;
      const baseProps = { ...(target?.props ?? {}) };
      delete baseProps.stub;
      const props = { ...baseProps, vaultPath: f.rel };
      const res = graph.upsertNode(actor, {
        ...(target ? { id: target.id } : {}), type: f.type, title: f.title, body: f.body, tags: f.tags, props,
        sources: f.sources, ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        ...(target ? {} : { scope: 'shared' as const }),
      });
      claimed.add(res.node.id);
      idOfFile.set(f.rel, res.node.id);
      if (f.fmId) idOfFmId.set(f.fmId, res.node.id);
      vaultTitles.set(oneLine(f.title).toLowerCase(), vaultTitles.get(oneLine(f.title).toLowerCase()) ?? res.node.id);
      if (res.created) report.created++; else if (res.changed) report.updated++; else report.unchanged++;
    } catch (e) { report.skipped.push({ path: f.rel, reason: e instanceof Error ? e.message : String(e) }); }
  }

  // ---- pass 2: links, creating entity stubs for unresolved titles
  const resolveTarget = (l: ParsedFile['links'][number], rel: string): string | undefined => {
    if (l.idHint) {
      const hinted = idOfFmId.get(l.idHint) ?? graph.getNode(actor, l.idHint)?.id;
      if (hinted) return hinted;
    }
    const k = oneLine(l.target).toLowerCase();
    const inVault = vaultTitles.get(k);
    if (inVault) return inVault;
    const found = byTitle.get(k) ?? graph.findByTitle(actor, l.target)[0];
    if (found) return found.id;
    const stub = graph.upsertNode(actor, { type: 'entity', title: l.target.slice(0, KG_LIMITS.titleChars), scope: 'shared', props: { stub: true }, sources: [{ ref: rel }] });
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
