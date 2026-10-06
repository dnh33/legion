/**
 * Finds the skills on this computer without calling a model: the Armory's own folder, the owner's Claude Code skills,
 * the skills and commands of installed Claude Code plugins, and the built-ins Claude Code ships.
 *
 * Layout (read from a real ~/.claude, 2026-10-06):
 * - `~/.claude/skills/<name>/SKILL.md` (often a symlink to a folder; statSync follows it) and flat `~/.claude/commands/*.md`.
 * - `~/.claude/plugins/installed_plugins.json`: `{ version, plugins: { "<plugin>@<marketplace>": [ { scope, installPath, ... } ] } }`.
 *   Only `scope: "user"` installs apply everywhere; `project` installs belong to one project path and are skipped.
 * - `~/.claude/settings.json` `enabledPlugins: { "<plugin>@<marketplace>": boolean }`: a plugin set to false is not loaded.
 * - A plugin's skills are `<installPath>/skills/<name>/SKILL.md` and its commands `<installPath>/commands/<name>.md`; both are
 *   addressed as `<plugin>:<name>`. The plugin name is `.claude-plugin/plugin.json` `name`, else the part before `@`.
 * Read-only: nothing here writes to ~/.claude. A missing or unreadable file means "nothing found", never an error.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { SdkSnapshot } from './handshake.js';
import { parseFrontmatter } from '../house/skills.js';
import { ARMORY_PLUGIN, DESCRIPTION_CAP, SKILL_NAME_RE, armoryId } from '../../shared/skill-ids.js';
import { sanitizeSkillMd } from './files.js';

export type SkillSource = 'yours' | 'imported' | 'claude-personal' | 'claude-plugin' | 'claude-builtin';

export interface DiscoveredSkill {
  /** The id Claude Code uses (see shared/skill-ids.ts). */
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  plugin?: string;
  /** Absolute path of the SKILL.md (or command file); null for a built-in, which has no file. */
  path: string | null;
  /** The skill's own frontmatter says `disable-model-invocation: true`. */
  manualOnlyInFrontmatter: boolean;
  /** Built-ins only. 'fit' = useful to a Legion agent; 'self' = acts on Claude Code itself. */
  fit?: 'fit' | 'self' | 'other';
  offReason?: string;
  /** The SDK tagged it as synced from the owner's claude.ai account (still third-party text: taint is unchanged). */
  origin?: 'claude-ai';
  /** Armory skills only: the header of this SKILL.md could not be read safely, so Legion does not deliver it. */
  unsafeReason?: string;
}

export const claudeHomeDir = (override?: string): string => override ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

const HEAD_BYTES = 16_384;

/** The first bytes of a file as text, or null when it is not a readable regular file. Follows symlinks. */
function readHead(path: string): string | null {
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to release */ } }
  }
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const listDir = (p: string): string[] => { try { return readdirSync(p).sort(); } catch { return []; } };
const oneLine = (s: string, max = DESCRIPTION_CAP): string => {
  const f = s.replace(/\s+/g, ' ').trim();
  return f.length > max ? `${f.slice(0, max - 1).trimEnd()}…` : f;
};
const truthy = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'true';
/** A name safe to show and to match on. Anything odd falls back to the folder or file name. */
const idName = (fm: string | undefined, fallback: string): string => (fm && /^[A-Za-z0-9][\w.-]{0,100}$/.test(fm) ? fm : fallback);

function fromFile(path: string, fallbackName: string): { name: string; rawName: string; description: string; manual: boolean } | null {
  const head = readHead(path);
  if (head === null) return null;
  const fm = parseFrontmatter(head);
  return { name: idName(fm.name, fallbackName), rawName: (fm.name ?? '').trim(), description: oneLine(fm.description ?? ''), manual: truthy(fm['disable-model-invocation']) };
}

/** Skills the owner put in the Armory's own folder. The source is decided by the caller (armory.json), not here. */
export function scanArmoryDir(skillsDir: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  for (const folder of listDir(skillsDir)) {
    if (!SKILL_NAME_RE.test(folder)) continue;
    const path = join(skillsDir, folder, 'SKILL.md');
    // Read with the same strict parser that builds what is delivered, so the list shows what an agent would be given (never a key the strict parser refuses).
    const head = readHead(path);
    if (head === null) continue;
    const san = sanitizeSkillMd(head);
    const base = { id: armoryId(folder), name: folder, source: 'imported' as const, plugin: ARMORY_PLUGIN, path };
    if (!san.ok) { out.push({ ...base, description: '', manualOnlyInFrontmatter: false, unsafeReason: san.reason }); continue; }
    out.push({ ...base, description: oneLine(san.description), manualOnlyInFrontmatter: san.manualOnly });
  }
  return out;
}

function personal(home: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  for (const folder of listDir(join(home, 'skills'))) {
    const path = join(home, 'skills', folder, 'SKILL.md');
    const f = fromFile(path, folder);
    if (f) out.push({ id: f.name, name: f.name, description: f.description, source: 'claude-personal', path, manualOnlyInFrontmatter: f.manual });
  }
  // ~/.claude/commands/*.md are run as /name too. Subfolders make namespaced commands; those are left out.
  for (const file of listDir(join(home, 'commands'))) {
    if (!/\.md$/i.test(file)) continue;
    const base = file.replace(/\.md$/i, '');
    const path = join(home, 'commands', file);
    const f = fromFile(path, base);
    if (f) out.push({ id: base, name: base, description: f.description, source: 'claude-personal', path, manualOnlyInFrontmatter: f.manual });
  }
  return out;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function plugins(home: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  const installed = readJson(join(home, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, unknown> } | undefined;
  const map = installed && typeof installed === 'object' && installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const settings = readJson(join(home, 'settings.json')) as { enabledPlugins?: Record<string, unknown> } | undefined;
  const enabled = settings && typeof settings === 'object' && settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  for (const key of Object.keys(map).sort()) {
    if (enabled[key] === false) continue;
    const list = Array.isArray(map[key]) ? map[key] as Array<{ scope?: unknown; installPath?: unknown }> : [];
    const entry = [...list].reverse().find((e) => e && (e.scope === 'user' || e.scope === undefined) && typeof e.installPath === 'string');
    if (!entry) continue;
    const root = entry.installPath as string;
    if (!isDir(root)) continue;
    const manifest = readJson(join(root, '.claude-plugin', 'plugin.json')) as { name?: unknown } | undefined;
    const fromKey = key.split('@')[0];
    const plugin = typeof manifest?.name === 'string' && /^[A-Za-z0-9][\w.-]{0,100}$/.test(manifest.name) ? manifest.name : fromKey;
    for (const folder of listDir(join(root, 'skills'))) {
      const path = join(root, 'skills', folder, 'SKILL.md');
      const f = fromFile(path, folder);
      if (f) out.push({ id: `${plugin}:${f.name}`, name: f.name, description: f.description, source: 'claude-plugin', plugin, path, manualOnlyInFrontmatter: f.manual });
    }
    for (const file of listDir(join(root, 'commands'))) {
      if (!/\.md$/i.test(file)) continue;
      const base = file.replace(/\.md$/i, '');
      const path = join(root, 'commands', file);
      const f = fromFile(path, base);
      if (f) out.push({ id: `${plugin}:${base}`, name: base, description: f.description, source: 'claude-plugin', plugin, path, manualOnlyInFrontmatter: f.manual });
    }
  }
  return out;
}

/** A manifest field that names folders or files (a string or a list of strings) as absolute paths inside `root`. Anything outside is dropped. */
function manifestPaths(manifest: unknown, key: string, root: string): string[] {
  const v = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>)[key] : undefined;
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const base = resolve(root);
  const out: string[] = [];
  for (const raw of list) {
    const abs = resolve(base, raw);
    if (abs.startsWith(base + sep)) out.push(abs);
  }
  return out;
}

interface SkillFile { path: string; folder: string }

/** The skill and command files of one plugin folder: the default folders, the folders its plugin.json names, and a SKILL.md at the root. */
function pluginFiles(root: string, manifest: unknown): { skills: SkillFile[]; commands: SkillFile[] } {
  const skills: SkillFile[] = [];
  const commands: SkillFile[] = [];
  const seen = new Set<string>();
  const addSkill = (path: string, folder: string): void => { if (!seen.has(path) && readHead(path) !== null) { seen.add(path); skills.push({ path, folder }); } };
  for (const dir of [join(root, 'skills'), ...manifestPaths(manifest, 'skills', root)]) {
    if (!isDir(dir)) continue;
    if (readHead(join(dir, 'SKILL.md')) !== null) { addSkill(join(dir, 'SKILL.md'), basename(dir)); continue; }
    for (const folder of listDir(dir)) addSkill(join(dir, folder, 'SKILL.md'), folder);
  }
  addSkill(join(root, 'SKILL.md'), basename(root));
  const seenCmd = new Set<string>();
  const addCmd = (path: string, folder: string): void => { if (!seenCmd.has(path)) { seenCmd.add(path); commands.push({ path, folder }); } };
  // commands/a/b.md is the command `a:b`: nested folders add a namespace (two levels at most)
  const walk = (dir: string, ns: string, depth: number): void => {
    for (const entry of listDir(dir)) {
      const full = join(dir, entry);
      if (/\.md$/i.test(entry)) addCmd(full, `${ns}${entry.replace(/\.md$/i, '')}`);
      else if (depth < 2 && isDir(full)) walk(full, `${ns}${entry}:`, depth + 1);
    }
  };
  for (const dir of [join(root, 'commands'), ...manifestPaths(manifest, 'commands', root)]) {
    if (isDir(dir)) walk(dir, '', 0);
    else if (/\.md$/i.test(dir)) addCmd(dir, basename(dir).replace(/\.md$/i, ''));
  }
  return { skills, commands };
}

const NO_DESCRIPTION = 'No description available';
/** The SDK appends where a skill came from to its description, e.g. "... (user)". Returns the text without it, and the tag. */
function splitSource(description: string): { text: string; tag: string } {
  const m = /\s*\(([^()]{1,40})\)\s*$/.exec(description);
  return m ? { text: oneLine(description.slice(0, m.index)), tag: m[1]! } : { text: oneLine(description), tag: '' };
}

/**
 * Skills as the Claude Code SDK lists them (see handshake.ts), with descriptions and paths read from the files.
 * - Plugins: the SDK's own plugin list (name and folder), not installed_plugins.json, so plugins the desktop app delivers are included
 *   and a plugin switched off in settings is absent. Each folder is read for skills and commands. An id is the SDK's name: whichever of
 *   `<plugin>:<frontmatter name>` or `<plugin>:<folder>` is in its list.
 * - Personal skills and commands: the owner's ~/.claude files, named the SDK's way when it spells the name differently.
 * - A skill the SDK lists with no file found is still listed (its description, else "No description available") so it can be switched.
 * A file the SDK does not list is dropped: the SDK does not load it.
 */
export function discoverFromSdk(home: string, snap: Pick<SdkSnapshot, 'skills' | 'commands' | 'plugins'>): DiscoveredSkill[] {
  const listed = new Map<string, string>(); // name -> description, skills and commands
  for (const c of snap.commands) listed.set(c.name, c.description);
  for (const c of snap.skills) listed.set(c.name, c.description);
  const builtinIds = new Set(BUILTIN_SKILLS.map((b) => b.id));
  const out: DiscoveredSkill[] = [];
  const have = new Set<string>();
  const push = (s: DiscoveredSkill): void => { if (!have.has(s.id)) { have.add(s.id); out.push(s); } };
  const pick = (candidates: string[]): string | undefined => candidates.find((c) => listed.has(c));

  for (const s of personal(home)) {
    const raw = s.path ? fromFile(s.path, s.name)?.rawName : '';
    const id = pick([s.id, ...(raw ? [raw] : [])]);
    if (id) push({ ...s, id, name: id });
  }
  const pluginNames = new Set(snap.plugins.map((p) => p.name));
  for (const p of snap.plugins) {
    if (!isDir(p.path)) continue; // built-in plugins have no folder
    const files = pluginFiles(p.path, readJson(join(p.path, '.claude-plugin', 'plugin.json')));
    for (const f of [...files.skills, ...files.commands]) {
      const info = fromFile(f.path, f.folder);
      if (!info) continue;
      const id = pick([`${p.name}:${info.name}`, `${p.name}:${f.folder}`, ...(info.rawName ? [`${p.name}:${info.rawName}`] : [])]);
      if (id) push({ id, name: id.slice(p.name.length + 1), description: info.description, source: 'claude-plugin', plugin: p.name, path: f.path, manualOnlyInFrontmatter: info.manual });
    }
  }
  // Listed by the SDK as a skill, no file found: name only.
  for (const c of snap.skills) {
    const name = c.name;
    if (have.has(name) || builtinIds.has(name)) continue;
    const { text, tag } = splitSource(c.description);
    const colon = name.indexOf(':');
    const prefix = colon > 0 ? name.slice(0, colon) : '';
    const plugin = prefix && pluginNames.has(prefix) ? prefix : pluginNames.has(name) ? name : undefined;
    const description = text || NO_DESCRIPTION;
    const base = { id: name, description, path: null, manualOnlyInFrontmatter: false };
    if (plugin) { push({ ...base, name: prefix && plugin === prefix ? name.slice(colon + 1) : name, source: 'claude-plugin', plugin }); continue; }
    if (tag === 'user') { push({ ...base, name, source: 'claude-personal' }); continue; }
    // A tag that is not "user" (the SDK shows "claude.ai sync" for skills synced from the owner's claude.ai account) is text from outside the
    // owner's own files: plugin-like, so it taints. The prefix before a colon names the group when there is one.
    if (tag) { push({ ...base, name: prefix ? name.slice(colon + 1) : name, source: 'claude-plugin', plugin: prefix || 'claude.ai', ...(/claude\.ai/i.test(tag) ? { origin: 'claude-ai' as const } : {}) }); continue; }
    // No tag and no plugin, and not in Legion's list of Claude Code's own skills: its origin is unknown, so it counts as outside text (taints).
    push({ ...base, name, source: 'claude-plugin', plugin: 'unknown' });
  }
  return out;
}

/** The owner's own Claude Code skills and the skills of the plugins Claude Code has installed and enabled. */
export function discoverClaudeCode(home: string): DiscoveredSkill[] {
  return [...personal(home), ...plugins(home)];
}

const SELF = 'Changes Claude Code itself (its settings, schedules or permissions), not the work an agent is doing, so Legion keeps it off.';
const b = (id: string, description: string, fit: 'fit' | 'self' | 'other', offReason?: string): DiscoveredSkill => ({
  id, name: id, description, source: 'claude-builtin', path: null, manualOnlyInFrontmatter: false, fit, ...(offReason ? { offReason } : {}),
});

/**
 * The skills Claude Code ships inside itself (measured with SDK 0.3.285: they are listed even with no settings sources).
 * They have no file on disk, so this is a constant. The descriptions are Legion's own one-line summaries.
 */
export const BUILTIN_SKILLS: readonly DiscoveredSkill[] = [
  b('deep-research', 'Research a question across many sources and write up what was found.', 'fit'),
  b('verify', 'Check that a change really works by running it, not only by reading it.', 'fit'),
  b('debug', 'Work through a bug or a failing test step by step.', 'fit'),
  b('code-review', 'Review a diff or a branch for bugs.', 'fit'),
  b('simplify', 'Tidy changed code for reuse, clarity and efficiency.', 'fit'),
  b('update-config', 'Edit Claude Code settings and hooks.', 'self', SELF),
  b('schedule', 'Create and manage scheduled Claude Code agents.', 'self', SELF),
  b('loop', 'Run a prompt again and again on an interval.', 'self', SELF),
  b('fewer-permission-prompts', 'Add allow rules to Claude Code settings to cut permission prompts.', 'self', SELF),
  b('doctor', 'Diagnose the Claude Code install.', 'self', SELF),
  b('design', 'Visual design work.', 'other'),
  b('slides', 'Build a slide deck.', 'other'),
  b('batch', 'Run a change across many files in parallel.', 'other'),
  b('claude-api', 'Reference for the Claude API and Anthropic SDK.', 'other'),
  b('workflow-authoring', 'Write a Claude Code workflow script.', 'other'),
  b('run', 'Launch the project app to see a change working.', 'other'),
  b('run-skill-generator', 'Generate a run skill for a project.', 'other'),
  b('dataviz', 'Make charts and dashboards.', 'other'),
  b('artifact-design', 'Design guidance for Claude artifacts.', 'other'),
  b('artifact-diagramming', 'Diagramming guidance for Claude artifacts.', 'other'),
  b('artifact-capabilities', 'Runtime capabilities of Claude artifacts.', 'other'),
  b('design-sync', 'Sync a design with code.', 'other'),
  // Claude Code's own skills the SDK lists with no source tag (they used to read as an unknown plugin).
  b('init', 'Start a CLAUDE.md for a project.', 'other'),
  b('security-review', 'Review the pending changes for security problems.', 'other'),
  b('plugin-authoring', 'Make a Claude Code plugin or mod.', 'other'),
  b('keybindings-help', 'Edit Claude Code keyboard shortcuts.', 'self', SELF),
];
