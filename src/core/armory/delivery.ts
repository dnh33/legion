/**
 * What a Claude run is given from the Armory: a plugin folder that LEGION builds, never the folder an agent or a download can write to.
 *
 *   source    <dataDir>/armory/plugin/legion-armory/skills/<name>/...     (the store: imports and the owner's skills land here)
 *   delivery  <dataDir>/armory/delivery-<hash>/legion-armory/skills/<name>/...   (what the SDK is told to load)
 *
 * The delivery folder is versioned: <hash> is a short hash of the content. A rebuild writes a NEW folder and only then prunes old ones, so
 * the path a run was given is never deleted under it (a run that started a moment before a skill changed keeps reading what it was given).
 * The newest two folders are kept; older ones are removed on the next rebuild, and a folder that cannot be removed is left for next time.
 *
 * Claude Code loads a plugin folder whole: hooks/hooks.json, .mcp.json, agents/, commands/ and .claude-plugin/plugin.json would all take
 * effect. So the delivery folder holds ONLY `skills/<name>/SKILL.md` (header rewritten from an allowlist, see files.ts) and `.md`
 * reference files that Legion copied itself. Whatever else is found in the source folder is ignored, logged and counted (`foreign`).
 * The delivery folder is compared with what it should hold on every run and rebuilt when anything differs, so a change made to it by
 * hand does not survive the next run.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ARMORY_PLUGIN, SKILL_NAME_RE } from '../../shared/skill-ids.js';
import { ARMORY_LIMITS, sanitizeSkillMd } from './files.js';
import { armoryDir, pluginRoot } from './store.js';

const VERSION_DIR = /^delivery-[0-9a-f]{12}(?:-[0-9a-z]+)?$/;
const KEEP_VERSIONS = 2;

/** File operations the pruning uses; a test replaces `rm` to make a removal fail. */
export const deliveryOps = { rm: (p: string): void => rmSync(p, { recursive: true, force: true }) };

const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/** The delivery folder a run would be given now: the newest version that exists (a placeholder name when none has been built). */
export function deliveryRoot(dataDir: string): string {
  const base = armoryDir(dataDir);
  let names: string[] = [];
  try { names = readdirSync(base).filter((n) => VERSION_DIR.test(n) && existsSync(join(base, n, ARMORY_PLUGIN))); } catch { /* none */ }
  names.sort((a, b) => mtime(join(base, b)) - mtime(join(base, a)) || (a < b ? 1 : -1));
  return join(base, names[0] ?? 'delivery-none', ARMORY_PLUGIN);
}

/** Removes versions older than the newest two (the one just used always stays), and the old unversioned folder. Never throws. */
function pruneOld(dataDir: string, keep: string): void {
  const base = armoryDir(dataDir);
  let names: string[];
  try { names = readdirSync(base); } catch { return; }
  const versions = names.filter((n) => VERSION_DIR.test(n) && n !== keep).sort((a, b) => mtime(join(base, b)) - mtime(join(base, a)) || (a < b ? 1 : -1));
  const doomed = [...versions.slice(KEEP_VERSIONS - 1), ...names.filter((n) => n === 'delivery' || (/^delivery-.*\.build-\d+$/.test(n) && !n.endsWith(`.build-${process.pid}`)))];
  for (const n of doomed) {
    try { deliveryOps.rm(join(base, n)); } catch { /* in use or locked: it is tried again on the next rebuild */ }
  }
}

const MAX_REF_FILES = 200;
const MAX_DEPTH = 6;

export interface SourceScan {
  /** Skill folder name -> relative path (forward slashes) -> text. Only plain `.md` files. */
  skills: Map<string, Map<string, string>>;
  /** Paths (relative to the plugin folder) that are not `skills/<name>/**.md` regular files: ignored, never delivered. */
  foreign: string[];
}

const walk = (dir: string, rel: string, depth: number, out: { rel: string; abs: string; kind: 'file' | 'dir' | 'other' }[]): void => {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return; }
  for (const n of names) {
    const abs = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    let st;
    try { st = lstatSync(abs); } catch { out.push({ rel: r, abs, kind: 'other' }); continue; }
    if (st.isSymbolicLink()) out.push({ rel: r, abs, kind: 'other' });
    else if (st.isDirectory()) { if (depth >= MAX_DEPTH) out.push({ rel: r, abs, kind: 'other' }); else { out.push({ rel: r, abs, kind: 'dir' }); walk(abs, r, depth + 1, out); } }
    else if (st.isFile()) out.push({ rel: r, abs, kind: 'file' });
    else out.push({ rel: r, abs, kind: 'other' });
  }
};

/** Reads the source plugin folder: the skills Legion may deliver, and everything else it found. */
export function scanSource(dataDir: string): SourceScan {
  const root = pluginRoot(dataDir);
  const all: { rel: string; abs: string; kind: 'file' | 'dir' | 'other' }[] = [];
  walk(root, '', 0, all);
  const skills = new Map<string, Map<string, string>>();
  const foreign: string[] = [];
  for (const e of all) {
    const parts = e.rel.split('/');
    if (e.kind === 'dir') continue;
    if (parts[0] !== 'skills' || parts.length < 3 || !SKILL_NAME_RE.test(parts[1]!) || e.kind !== 'file' || !/\.md$/i.test(e.rel)) { foreign.push(e.rel); continue; }
    const folder = parts[1]!;
    let size = 0;
    try { size = lstatSync(e.abs).size; } catch { foreign.push(e.rel); continue; }
    if (size > ARMORY_LIMITS.maxFileBytes) { foreign.push(e.rel); continue; }
    const map = skills.get(folder) ?? new Map<string, string>();
    if (map.size >= MAX_REF_FILES) { foreign.push(e.rel); continue; }
    let text: string;
    try { text = readFileSync(e.abs, 'utf8'); } catch { foreign.push(e.rel); continue; }
    const relInSkill = parts.slice(2).join('/');
    // the file name SKILL.md is matched exactly: skill.md or Skill.MD is a reference, not the skill
    map.set(relInSkill, text);
    skills.set(folder, map);
  }
  return { skills, foreign };
}

export interface DeliveryResult {
  /** Folder names that were delivered (a skill whose SKILL.md could not be read safely is left out). */
  delivered: Set<string>;
  /** Folder name -> why it was not delivered. */
  refused: Map<string, string>;
  foreign: string[];
  root: string;
  rebuilt: boolean;
}

function readTree(root: string): Map<string, string> | undefined {
  if (!existsSync(root)) return new Map();
  const all: { rel: string; abs: string; kind: 'file' | 'dir' | 'other' }[] = [];
  walk(root, '', 0, all);
  const out = new Map<string, string>();
  for (const e of all) {
    if (e.kind === 'dir') continue;
    if (e.kind !== 'file') return undefined;
    try { out.set(e.rel, readFileSync(e.abs, 'utf8')); } catch { return undefined; }
  }
  return out;
}

/**
 * Makes the delivery folder match the source: sanitised SKILL.md files and plain `.md` references, nothing else.
 * `include` names the skill folders to deliver (the catalog's owned, safe ones); anything else in the source is not copied.
 */
export function syncDelivery(dataDir: string, include: ReadonlySet<string>): DeliveryResult {
  const src = scanSource(dataDir);
  const want = new Map<string, string>();
  const delivered = new Set<string>();
  const refused = new Map<string, string>();
  for (const [folder, files] of [...src.skills].sort()) {
    if (!include.has(folder)) continue;
    const skillMd = files.get('SKILL.md');
    if (skillMd === undefined) { refused.set(folder, 'There is no SKILL.md in this folder.'); continue; }
    const s = sanitizeSkillMd(skillMd);
    if (!s.ok) { refused.set(folder, s.reason); continue; }
    delivered.add(folder);
    const named = sanitizeSkillMd(skillMd, { name: folder });
    want.set(`skills/${folder}/SKILL.md`, named.ok ? named.text : s.text);
    for (const [rel, text] of files) if (rel !== 'SKILL.md') want.set(`skills/${folder}/${rel}`, text);
  }
  const hash = createHash('sha256');
  for (const [k, v] of [...want].sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(`${k}\0${v.length}\0${v}\0`);
  const name = `delivery-${hash.digest('hex').slice(0, 12)}`;
  const base = armoryDir(dataDir);
  let root = join(base, name, ARMORY_PLUGIN);
  const have = readTree(root);
  const same = have !== undefined && have.size === want.size && [...want].every(([k, v]) => have.get(k) === v);
  if (same) {
    if (want.size) { try { const now = new Date(); utimesSync(join(base, name), now, now); } catch { /* ordering only */ } }
    return { delivered, refused, foreign: src.foreign, root, rebuilt: false };
  }
  // Build beside the live folders and move into place; nothing that exists under another name is touched.
  const tmp = `${join(base, name)}.build-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, ARMORY_PLUGIN), { recursive: true });
  for (const [rel, text] of want) {
    const p = join(tmp, ARMORY_PLUGIN, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  let finalName = name;
  if (existsSync(join(base, name))) {
    // Same content name but the folder was changed by hand: it is replaced (it is not what a run should read). If it cannot be removed, a new name is used.
    try { rmSync(join(base, name), { recursive: true, force: true }); } catch { finalName = `${name}-${Date.now().toString(36)}`; }
  }
  renameSync(tmp, join(base, finalName));
  root = join(base, finalName, ARMORY_PLUGIN);
  pruneOld(dataDir, finalName);
  return { delivered, refused, foreign: src.foreign, root, rebuilt: true };
}
