/**
 * Folder trust for the settings and skills a repository carries (security finding H1).
 *
 * The problem. Claude Code asks "do you trust this folder?" before it runs a repository's hooks. A `claude -p` run or an SDK session never asks.
 * Official source (opened 2026-10-18): code.claude.com/docs/en/permissions, "What runs before you trust a folder": for the SDK, with the folder never
 * trusted, hooks in settings files, the `env` block, helper commands such as `apiKeyHelper`, and a project skill's hooks and `allowed-tools` are all
 * "Used". Its advice for a repository you did not write: read the settings without the project source. So Legion scans before it starts a run and,
 * unless the owner trusted what it found, runs with the user source only.
 *
 * What is scanned (code.claude.com/docs/en/agent-sdk/claude-code-features, the setting-sources table, opened 2026-10-18):
 *  - `<cwd>/.claude/settings.json` and `<cwd>/.claude/settings.local.json` only. The docs: "Project settings.json and hooks load only from
 *    <cwd>/.claude/ with no parent-directory fallback", so a settings file in a parent folder is not counted.
 *  - skills, commands and subagents (their frontmatter `hooks` and `allowed-tools`) from <cwd> and every parent folder up to the repository root, plus the
 *    `.claude/skills`, `.claude/commands` and `.claude/agents` folders of each added directory. A folder with no repository root above it is walked up to
 *    the user's home folder (or the drive root outside home): the docs do not say where the SDK stops there, so Legion fails closed.
 *  The user's own configuration folder (`~/.claude`, or CLAUDE_CONFIG_DIR) is never scanned as project content: it is the `user` source, which still loads.
 *
 * What counts as executable. Everything except a short list of settings that cannot run or loosen anything (INERT). An unknown key is executable; a file
 * that cannot be read or parsed is executable; a skill whose frontmatter is odd or mentions hooks or allowed tools is executable. Fail closed.
 *
 * The fingerprint is a sha256 over the sorted (path, canonical executable content) of every source that carried something executable. It is worked out
 * at every run start. Environment VALUES go into the hash and nowhere else: every line this module returns names variables, never their values.
 *
 * Reading the instructions as text (`readInstructions`): when the settings are held back the repository's CLAUDE.md files and `.claude/rules` are still
 * given to the run, as plain text in the prompt, so the project's instructions survive without its settings.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface TrustedFolder { folder: string; digest: string }
export type SettingSourceName = 'user' | 'project' | 'local';

/** One folder's scan. `lines` are plain, labelled, control-free sentences for a card, a dialog or the activity log; no environment value is ever in them. */
export interface FolderScan {
  /** The real path of the folder: what a trust record is keyed by. */
  folder: string;
  executable: boolean;
  /** sha256 over the canonical executable content of every source that carried some. Constant for a folder with none. */
  digest: string;
  lines: string[];
  /** Lines left out of `lines` because there were too many. */
  more: number;
}

/**
 * Settings that cannot run a command, load code, widen what a tool may do, or move the run elsewhere. Source: code.claude.com/docs/en/settings-reference
 * (opened 2026-10-18), where each of these is a display or housekeeping key. A key that is not listed is executable here, so a newer Claude Code
 * that adds a key is held back until the owner looks.
 */
export const INERT_SETTINGS: readonly string[] = [
  '$schema', 'theme', 'language', 'spinnerTipsEnabled', 'prefersReducedMotion', 'cleanupPeriodDays', 'includeCoAuthoredBy', 'attribution',
  'editorMode', 'verbose', 'syntaxHighlightingDisabled', 'terminalProgressBarEnabled', 'showTurnDuration', 'alwaysThinkingEnabled',
];
/** Under `permissions`, only the rules that ask or deny can only tighten (docs: permissions.ask "always prompt", permissions.deny "blocked"). allow, defaultMode and additionalDirectories widen. */
const INERT_PERMISSION_KEYS = new Set(['deny', 'ask']);
/** Settings whose value is a command string (or an object with one). Any other key that ends the same way is treated the same. */
const COMMAND_KEYS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'statusLine', 'subagentStatusLine', 'fileSuggestion', 'policyHelper', 'processWrapper']);
const COMMAND_KEY_RE = /(Helper|Refresh|Export|Command)$/;

const MAX_FILE = 256 * 1024;
const FRONTMATTER_READ = 64 * 1024;
const MAX_FILES = 3000;
const MAX_LINES = 40;
const MAX_DEPTH = 5;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const caseFold = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => { const x = p.replace(/[\\/]+$/, ''); return caseFold ? x.toLowerCase() : x; };
const fwd = (p: string): string => p.replace(/\\/g, '/');

/** A fixed, short, single-line piece of repository text: no control or bidi characters, no line breaks, cut to `max`. */
export function plain(v: unknown, max = 240): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sortedJson(v: unknown): string {
  const s = (x: unknown): unknown => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, y]) => [k, s(y)])) : Array.isArray(x) ? x.map(s) : x);
  return JSON.stringify(s(v));
}

export function realFolder(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}
export const sameFolder = (a: string, b: string): boolean => norm(a) === norm(b);

/** Is this folder on the owner's list with exactly this fingerprint? */
export function isTrusted(scan: FolderScan, trusted: readonly TrustedFolder[]): boolean {
  return trusted.some((t) => sameFolder(t.folder, scan.folder) && t.digest === scan.digest);
}

export interface ScanOptions {
  /** The user's home folder. Tests pass their own, so a scan never depends on the machine it runs on. Default: the real one. */
  home?: string;
  /** The user's Claude Code configuration folder (the `user` source). Default: CLAUDE_CONFIG_DIR, else ~/.claude. */
  configDir?: string;
}
function envOf(o: ScanOptions): { home: string; configDir: string } {
  const home = o.home ?? homedir();
  const cfg = o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  return { home: realFolder(home), configDir: realFolder(cfg) };
}
/** `<dir>/.claude` is the owner's own configuration folder, not project content. */
const isUserConfig = (dir: string, configDir: string): boolean => sameFolder(realFolder(join(dir, '.claude')), configDir);

/** The folders whose `.claude/skills|commands|agents` count: `dir` up to the repository root, else up to (not including) home, else to the drive root. */
function chainOf(dir: string, home: string): string[] {
  const up: string[] = [];
  for (let cur = dir; ; cur = dirname(cur)) { up.push(cur); if (dirname(cur) === cur) break; }
  const repo = up.findIndex((d) => existsSync(join(d, '.git'))); // a file counts too: a worktree's .git is a file
  if (repo >= 0) return up.slice(0, repo + 1);
  const h = up.findIndex((d) => sameFolder(d, home));
  return h >= 0 ? up.slice(0, h) : up;
}

interface Source { path: string; kind: 'settings' | 'skill'; content: string; lines: string[] }

function commandText(v: unknown): string {
  if (typeof v === 'string') return plain(v);
  if (isObj(v) && typeof v.command === 'string') return plain(v.command);
  return '(not a command string)';
}

function hookLines(where: string, hooks: unknown): string[] {
  if (!isObj(hooks)) return [`Hooks in ${where} (a shape Legion does not recognise, so it treats them as able to run commands)`];
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    const ev = plain(event, 40);
    const list = Array.isArray(groups) ? groups : [];
    if (!Array.isArray(groups)) out.push(`Hook ${ev} in ${where} (a shape Legion does not recognise)`);
    for (const g of list) {
      const inner = isObj(g) && Array.isArray(g.hooks) ? g.hooks : undefined;
      if (!inner) { out.push(`Hook ${ev} in ${where} (a shape Legion does not recognise)`); continue; }
      for (const h of inner) {
        if (!isObj(h)) { out.push(`Hook ${ev} in ${where} (a shape Legion does not recognise)`); continue; }
        const type = plain(h.type ?? 'command', 20);
        const what = typeof h.command === 'string' ? h.command : typeof h.url === 'string' ? h.url : typeof h.prompt === 'string' ? 'a prompt for a model' : typeof h.tool === 'string' ? `the MCP tool ${h.tool}` : typeof h.server === 'string' ? `the MCP server ${h.server}` : '(unknown)';
        out.push(`Hook ${ev} (${type}) in ${where} runs: ${plain(what)}`);
      }
    }
  }
  return out.length ? out : [`Hooks in ${where} (an empty list)`];
}

/** One settings file: the lines to show and the canonical executable content to hash. Never throws. */
function settingsSource(path: string, label: string): Source | undefined {
  if (!existsSync(path)) return undefined;
  const unreadable = (why: string): Source => ({ path, kind: 'settings', content: `unreadable:${why}`, lines: [`Legion could not read ${label} (${why}), so it treats it as able to run commands`] });
  let raw: unknown;
  try {
    if (statSync(path).size > MAX_FILE) return unreadable('too big');
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (e) { return unreadable(e instanceof SyntaxError ? 'not valid JSON' : 'not readable'); }
  if (!isObj(raw)) return unreadable('not an object');
  const exec: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const [key, val] of Object.entries(raw)) {
    const k = plain(key, 60);
    if (INERT_SETTINGS.includes(key)) continue;
    if (key === 'disableAllHooks' && val === true) continue; // it only switches things off
    if (key === 'permissions') {
      if (!isObj(val)) { exec[key] = val; lines.push(`Permissions in ${label} (a shape Legion does not recognise)`); continue; }
      const widen: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(val)) {
        if (INERT_PERMISSION_KEYS.has(pk)) continue;
        widen[pk] = pv;
        if (pk === 'allow') lines.push(`Permission rules in ${label} allow tools without asking: ${Array.isArray(pv) ? pv.slice(0, 6).map((r) => plain(r, 80)).join(', ') + (pv.length > 6 ? ` and ${pv.length - 6} more` : '') : '(not a list)'}`);
        else if (pk === 'additionalDirectories') lines.push(`Permissions in ${label} add folders: ${Array.isArray(pv) ? pv.slice(0, 6).map((r) => plain(r, 80)).join(', ') : '(not a list)'}`);
        else lines.push(`Permission setting ${plain(pk, 60)} in ${label}`);
      }
      if (Object.keys(widen).length) exec[key] = widen;
      continue;
    }
    exec[key] = val;
    if (key === 'hooks') lines.push(...hookLines(label, val));
    else if (key === 'env') lines.push(isObj(val) ? `Environment variables set by ${label}: ${Object.keys(val).slice(0, 30).map((n) => plain(n, 60)).join(', ') || '(none)'}${Object.keys(val).length > 30 ? ` and ${Object.keys(val).length - 30} more` : ''} (values are not shown)` : `Environment settings in ${label} (a shape Legion does not recognise)`);
    else if (COMMAND_KEYS.has(key) || COMMAND_KEY_RE.test(key)) lines.push(`Helper command ${k} in ${label} runs: ${commandText(val)}`);
    else lines.push(`The setting ${k} in ${label}, which Legion does not know to be harmless`);
  }
  if (!Object.keys(exec).length) return undefined;
  return { path, kind: 'settings', content: sortedJson(exec), lines };
}

type Front = { kind: 'none' } | { kind: 'odd' } | { kind: 'block'; block: string };
function frontmatter(text: string): Front {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!t.startsWith('---')) return /^\s*---/.test(t) ? { kind: 'odd' } : { kind: 'none' };
  const open = /^---[ \t]*\n/.exec(t);
  if (!open) return { kind: 'odd' };
  const rest = t.slice(open[0].length);
  const end = /^(?:---|\.\.\.)[ \t]*$/m.exec(rest);
  return end ? { kind: 'block', block: rest.slice(0, end.index) } : { kind: 'odd' };
}
/** Any mention at all, in any spelling or nesting: a YAML parser's view is not trusted to agree with Claude Code's. */
const RISKY_FRONT = /hooks|allowed[-_ ]?tools|mcp[-_ ]?servers/i;

function readHead(path: string, max: number): { text: string; whole: boolean } {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return { text: buf.subarray(0, n).toString('utf8'), whole: n < max };
  } finally { closeSync(fd); }
}

function skillSource(path: string, label: string): Source | undefined {
  let text: string; let whole: boolean;
  try { ({ text, whole } = readHead(path, FRONTMATTER_READ)); } catch {
    return { path, kind: 'skill', content: 'unreadable', lines: [`Legion could not read ${label}, so it treats it as able to run commands`] };
  }
  const f = frontmatter(text);
  if (f.kind === 'none') return undefined;
  if (f.kind === 'odd' || (f.kind === 'block' && !whole && f.block.length >= FRONTMATTER_READ - 1024)) {
    return { path, kind: 'skill', content: `odd:${createHash('sha256').update(text).digest('hex')}`, lines: [`${label} has a header Legion cannot read safely, so it treats it as able to run commands`] };
  }
  if (!RISKY_FRONT.test(f.block)) return undefined;
  const risky = f.block.split('\n').filter((l) => RISKY_FRONT.test(l) || /\bcommand\s*:/i.test(l)).slice(0, 4).map((l) => plain(l, 140));
  const extra = f.block.split('\n').filter((l) => /\bcommand\s*:/i.test(l)).length;
  return { path, kind: 'skill', content: f.block, lines: [`Skill file ${label} carries hooks or allowed tools: ${risky.join(' | ')}${extra > 4 ? ' | …' : ''}`] };
}

/**
 * Every .md file under `dir`. Whatever Legion cannot look at (a folder it cannot list, an entry it cannot stat, a folder nested deeper than it checks) is
 * added to `problems` with the path: the caller counts each one as executable, because a file it could not see could hold a hook.
 */
function listMd(dir: string, depth: number, out: string[], problems: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { problems.push(`${dir} (not readable)`); return; }
  for (const n of names.sort()) {
    if (out.length > MAX_FILES) return;
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { problems.push(`${p} (not readable)`); continue; }
    if (st.isDirectory()) { if (depth < MAX_DEPTH) listMd(p, depth + 1, out, problems); else problems.push(`${p} (nested deeper than Legion checks)`); } else if (/\.md$/i.test(n)) out.push(p);
  }
}

function shortPath(p: string, base: string): string {
  const a = fwd(p); const b = fwd(base).replace(/\/$/, '');
  return norm(a).startsWith(norm(b) + '/') ? a.slice(b.length + 1) : a;
}

/** Scans one folder (and what the SDK would read for it) for anything that can run. Never throws: a failure is itself executable content. */
export function scanFolder(folderIn: string, opts: ScanOptions = {}): FolderScan {
  const folder = realFolder(folderIn);
  try {
    const { home, configDir } = envOf(opts);
    const sources: Source[] = [];
    const userCfg = isUserConfig(folder, configDir);
    if (!userCfg) {
      for (const name of ['settings.json', 'settings.local.json']) {
        const s = settingsSource(join(folder, '.claude', name), `.claude/${name}`);
        if (s) sources.push(s);
      }
    }
    let seen = 0;
    for (const dir of chainOf(folder, home)) {
      if (isUserConfig(dir, configDir)) continue;
      for (const sub of ['skills', 'commands', 'agents']) {
        const root = join(dir, '.claude', sub);
        if (!existsSync(root)) continue;
        const files: string[] = []; const problems: string[] = [];
        listMd(root, 0, files, problems);
        for (const why of problems.slice(0, 5)) sources.push({ path: why, kind: 'skill', content: `unlisted:${why}`, lines: [`Legion could not check ${shortPath(why, folder)}, so it treats it as able to run commands`] });
        for (const f of files) {
          if (++seen > MAX_FILES) { sources.push({ path: root, kind: 'skill', content: 'too-many', lines: [`${shortPath(root, folder)} holds more than ${MAX_FILES} files, so Legion treats it as able to run commands`] }); break; }
          const s = skillSource(f, shortPath(f, folder));
          if (s) sources.push(s);
        }
      }
    }
    sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const all = sources.flatMap((s) => s.lines);
    const digest = createHash('sha256').update(JSON.stringify(sources.map((s) => [fwd(s.path), s.kind, s.content]))).digest('hex');
    return { folder, executable: sources.length > 0, digest, lines: all.slice(0, MAX_LINES), more: Math.max(0, all.length - MAX_LINES) };
  } catch (e) {
    // anything unforeseen: held back, and the fingerprint changes with the message so nothing was ever trusted for it
    return { folder, executable: true, digest: createHash('sha256').update(`scan-failed:${String(e)}`).digest('hex'), lines: ['Legion could not finish checking this folder, so it treats it as able to run commands'], more: 0 };
  }
}

export interface RunTrust {
  /** What the run passes as `settingSources`. */
  sources: SettingSourceName[];
  /** The folders whose settings or skills were held back (empty: nothing is held back). */
  held: FolderScan[];
}

/**
 * Which setting sources a run may use. Inherit off: none. Nothing executable in the run's folder or any added directory, or every such folder
 * trusted at exactly the content found now: user, project and local. Otherwise: the user source only.
 */
export function assessRun(o: { cwd: string; addDirs?: readonly string[]; trusted: readonly TrustedFolder[]; inherit: boolean } & ScanOptions): RunTrust {
  if (!o.inherit) return { sources: [], held: [] };
  const seen = new Set<string>();
  const held: FolderScan[] = [];
  for (const dir of [o.cwd, ...(o.addDirs ?? [])]) {
    const scan = scanFolder(dir, o);
    if (seen.has(norm(scan.folder))) continue;
    seen.add(norm(scan.folder));
    if (scan.executable && !isTrusted(scan, o.trusted)) held.push(scan);
  }
  return { sources: held.length ? ['user'] : ['user', 'project', 'local'], held };
}

export interface Instructions { text: string; files: string[]; cut: boolean }
const MAX_INSTR_FILE = 20_000;
const MAX_INSTR_TOTAL = 60_000;

/**
 * The repository's CLAUDE.md files and `.claude/rules/*.md`, read as plain text for a run whose settings were held back. The files the SDK would read
 * (feature docs, "CLAUDE.md load locations", opened 2026-10-18): `<cwd>/CLAUDE.md` or `<cwd>/.claude/CLAUDE.md`, `.claude/rules/*.md` and CLAUDE.md in
 * every parent folder, and CLAUDE.local.md in the folder and every parent. `@imports` inside them are not followed. Farthest folder first, so the
 * nearest instructions come last. The user's own configuration folder is skipped (it still loads as the user source).
 */
export function readInstructions(folderIn: string, opts: ScanOptions = {}): Instructions {
  const folder = realFolder(folderIn);
  const { configDir } = envOf(opts);
  const dirs: string[] = [];
  for (let cur = folder; ; cur = dirname(cur)) { dirs.push(cur); if (dirname(cur) === cur) break; }
  const sections: string[] = []; const files: string[] = [];
  let total = 0; let cut = false;
  for (const dir of dirs.reverse()) {
    const cfgHere = isUserConfig(dir, configDir);
    const candidates = [join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'), ...(cfgHere ? [] : [join(dir, '.claude', 'CLAUDE.md')])];
    if (!cfgHere) { const rules: string[] = []; listMd(join(dir, '.claude', 'rules'), 0, rules, []); candidates.push(...rules); }
    for (const f of candidates) {
      if (!existsSync(f)) continue;
      let body: string;
      try { if (!statSync(f).isFile()) continue; body = readHead(f, MAX_INSTR_FILE + 1).text; } catch { continue; }
      const over = body.length > MAX_INSTR_FILE;
      if (over) body = body.slice(0, MAX_INSTR_FILE);
      if (total + body.length > MAX_INSTR_TOTAL) { cut = true; continue; }
      total += body.length; cut = cut || over;
      files.push(f);
      sections.push(`Project instructions from ${fwd(dir)} (read as text; its settings were not loaded). File: ${plain(shortPath(f, dir), 120)}${over ? ' (cut: the file is longer)' : ''}\n${body.replace(/\r\n?/g, '\n').trim()}`);
    }
  }
  return { text: sections.join('\n\n'), files, cut };
}
