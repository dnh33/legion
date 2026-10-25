/**
 * Small pure pieces of an agent host run, kept out of engine.ts: what a card says, which Legion mode maps to which agent mode,
 * which tool calls are Legion's own route, and where the agent keeps its home.
 */
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { MAX_TIMER_MS } from '../away/policy.js';
import type { AcpEntry } from '../../shared/acp-view.js';
import type { RunMode } from '../../shared/types.js';
import type { MappedPermission } from './map.js';
import { RUN_TOOL_WAIT_MAX_S } from './run-tools.js';

/** Hermes denies a request nobody answers after this long (acp_adapter/permissions.py timeout). */
export const HERMES_SELF_DENY_MS = 300_000;

/** The agent mode Legion sets when the owner asked it to match Legion's mode. Full and Bypass are both `full` here; Ask-like modes ask. */
export function agentModeFor(mode: RunMode): 'default' | 'accept_edits' | 'dont_ask' {
  if (mode === 'full') return 'dont_ask';
  if (mode === 'auto-edits') return 'accept_edits';
  return 'default'; // ask, smart and smart-edits: the agent keeps asking (it has no mode that asks only about risk)
}

const WIN_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'<>|,;:)]*/g;
const POSIX_PATH = /(?:~(?=\/)|\/(?:Users|home|root|var|opt|tmp|private|usr|etc|mnt|srv|Library))(?:\/[^\s"'<>|,;:)]*)?/g;

/** Text from Hermes or the system with every local path (a drive path, a network path, a home or system folder, `~/...`) replaced by `[path]`: an error shown to a person or an outside client must not name where things live on the computer. */
export function stripPaths(text: string): string {
  return text.replace(WIN_PATH, '[path]').replace(POSIX_PATH, '[path]');
}

/** A tool call on Legion's own route: Hermes names such a call `mcp__editor_legion_<tag>__<tool>`. The route already wrote its rows. */
export const isRouteTool = (name: string): boolean => /^mcp__editor_legion_[0-9a-z]+__/.test(name);

/** The most characters of one command, path or change a card shows. The card scrolls, so ordinary text is always shown whole; only text past this is cut. */
export const CARD_TEXT_MAX = 20_000;

/** The pieces of text a card for one request shows, in order. */
function cardParts(r: MappedPermission): string[] {
  const parts: string[] = [];
  const command = typeof r.input.command === 'string' ? r.input.command : undefined;
  const description = typeof r.input.description === 'string' ? r.input.description : undefined;
  if (command) parts.push(command);
  if (description && description !== command) parts.push(description);
  if (r.diff) parts.push(r.diff.path, r.diff.newText);
  else if (!command) {
    const path = typeof r.input.file_path === 'string' ? r.input.file_path : undefined;
    if (path) parts.push(path);
    if (r.text) parts.push(r.text);
  }
  return parts;
}

/** How many characters of the request the card cannot show. When this is above 0 the owner cannot read all of what would be allowed. */
export function cardHidden(r: MappedPermission): number {
  return cardParts(r).reduce((n, p) => n + Math.max(0, p.length - CARD_TEXT_MAX), 0);
}

/**
 * The text of a card for one request: the lead lines first (a settings line, why Legion asks), then the command or the file and its change, whole.
 * Text past CARD_TEXT_MAX is cut and the card says how much, on its own last line.
 */
export function cardSummary(r: MappedPermission, lead: readonly string[] = []): string {
  const lines: string[] = [...lead];
  for (const p of cardParts(r)) lines.push(p.length > CARD_TEXT_MAX ? p.slice(0, CARD_TEXT_MAX) : p);
  if (lines.length === lead.length) lines.push(r.title);
  const hidden = cardHidden(r);
  if (hidden > 0) lines.push(`(${hidden.toLocaleString('en-US')} more characters not shown)`);
  return lines.join('\n');
}

/** True when the command text holds the whole path of `target` (either slash, any case). A word the path merely shares with the command is not enough. */
export function commandNamesPath(command: string, target: string): boolean {
  const norm = (x: string): string => x.split('\\').join('/').toLowerCase().replace(/\/+$/, '');
  const t = norm(target);
  return t.length > 0 && norm(command).includes(t);
}

/** The longest a card waits, in ms: the longest wait Legion's own cards are given (the timer limit, less the minute the engine adds). A longer setting is cut to this, never passed on to a timer that would fire at once. */
export const MAX_CARD_WAIT_MS = MAX_TIMER_MS - 120_000;

/** The card's wait for an agent's request, in ms: what the owner's setting gives (a number or a function read at each request), else the agent's default. Never above MAX_CARD_WAIT_MS. */
export function permissionWaitOf(setting: number | ((entry: AcpEntry) => number | undefined) | undefined, entry?: AcpEntry): number {
  let ms: number | undefined;
  try { ms = typeof setting === 'function' ? setting(entry as AcpEntry) : setting; } catch { ms = undefined; }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_CARD_WAIT_MS) : HERMES_SELF_DENY_MS;
}

/**
 * How long a card raised inside an agent's tool call may stay open, in ms: what the setting gives (a number, or a function read at each run), else 270 s,
 * the margin below the 300 s the agent allows a tool call. Never above MAX_CARD_WAIT_MS.
 */
export function toolWaitOf(setting: number | ((entry: AcpEntry) => number | undefined) | undefined, entry?: AcpEntry): number {
  let ms: number | undefined;
  try { ms = typeof setting === 'function' ? setting(entry as AcpEntry) : setting; } catch { ms = undefined; }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_CARD_WAIT_MS) : RUN_TOOL_WAIT_MAX_S * 1000;
}

/** A network path to a drive's administrative share (two separators, a host, then C$ and so on): the same folder as a local path, by a name the path rules do not fold. */
export const isAdminShare = (p: string): boolean => /^[\\/]{2}[^\\/]+[\\/][a-z]\$(?:[\\/]|$)/i.test(p);

/**
 * A Windows path in its plain spelling. The long-path (backslash backslash question mark backslash), device (the same with a dot) and NT object
 * (backslash question question backslash) prefixes name the same file as the plain path but are not folded by the path rules, so a guard that
 * compares plain paths misses them. The long-path UNC form becomes a plain network path (two backslashes, host, share).
 * Undefined when the prefix names something Legion cannot turn into a drive or network path (a volume name, a device): such a path is never trusted.
 */
export function plainWindowsPath(p: string): string | undefined {
  const m = /^(?:[\\/]{2}[?.][\\/]|\\\?\?\\)(.*)$/s.exec(p);
  if (!m) return p;
  const rest = m[1]!;
  const unc = /^UNC[\\/](.+)$/is.exec(rest);
  if (unc) return '\\\\' + unc[1]!;
  return /^[a-z]:(?:[\\/]|$)/i.test(rest) ? rest : undefined;
}

// How Hermes applies a V4A patch (tools/patch_parser.py:52-55, opened 2026-10-22): one header per line, matched from the start of the line, with no
// space needed after the stars. Legion reads the same headers, line by line, so no pattern can run long on a line of white space.
// Python's \s also matches \x1c to \x1f and \x85, which JavaScript's does not, so the class below names them and strip() trims them.
const V4A_FILE = /^\*\*\*[\s\x1c-\x1f\x85]*(?:Update|Add|Delete)[\s\x1c-\x1f\x85]+File:[\s\x1c-\x1f\x85]*([^\n]+)/;
const V4A_MOVE = /^\*\*\*[\s\x1c-\x1f\x85]*Move[\s\x1c-\x1f\x85]+File:[\s\x1c-\x1f\x85]*([^\n]+)/;
const isSpace = (c: string): boolean => /[\s\x1c-\x1f\x85]/.test(c);
/** Python's str.strip(): the white space at both ends, \x1c to \x1f and \x85 included. A loop, so a long run of white space costs one pass. */
function strip(text: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && isSpace(text[a]!)) a++;
  while (b > a && isSpace(text[b - 1]!)) b--;
  return text.slice(a, b);
}

/** The most of a patch Legion reads, and the most of one header line. A patch or a header beyond them is not read, and the caller fails closed. */
export const MAX_PATCH_SCAN = 1_048_576;
export const MAX_HEADER_LINE = 8_192;

/** The paths a patch names, or why it could not be read. Linear in the length of the patch. */
function patchPaths(patch: string): { paths: string[]; unreadable?: string } {
  if (patch.length > MAX_PATCH_SCAN) return { paths: [], unreadable: 'the patch is too long to read safely' };
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('***')) continue;
    if (line.length > MAX_HEADER_LINE) return { paths, unreadable: 'a line of the patch is too long to read safely' };
    const mv = V4A_MOVE.exec(line);
    if (mv) {
      const rest = mv[1]!;
      const arrow = rest.indexOf('->', 1);
      if (arrow > 0) paths.push(strip(rest.slice(0, arrow)), strip(rest.slice(arrow + 2)));
      else paths.push(strip(rest)); // no arrow: Hermes rejects it, and the one path it names is still checked
      continue;
    }
    const f = V4A_FILE.exec(line);
    if (f) paths.push(strip(f[1]!));
  }
  return { paths };
}

const MAX_JOIN_PIECES = 64;

/**
 * Where a path of a request points when the agent opens it: `~` and `~/x` are in the home folder, any other path is from the session folder.
 * Undefined for `~name` (another user's home folder, which the agent's shell expands and Legion cannot read): the caller fails closed.
 */
export function expandRequestPath(p: string, cwd: string, home: string = homedir()): string | undefined {
  if (p === '~') return home;
  if (p.startsWith('~')) return p[1] === '/' || p[1] === '\\' ? join(home, p.slice(2)) : undefined;
  return resolve(cwd, p);
}

/**
 * Every path an edit request names, in plain spelling, and why one could not be read. Hermes joins the paths of a multi-file patch with ", " into one
 * display string (edit_approval.py:106-126), so a field is checked whole and in pieces, and the patch text is read for its own headers.
 * What cannot be read (not a string, a NUL, a device or network spelling, an edit that names no file) is said in `unreadable`: the caller fails closed.
 */
export function requestPaths(r: Pick<MappedPermission, 'toolName' | 'input' | 'diff'>, platform: NodeJS.Platform = process.platform): { paths: string[]; unreadable?: string } {
  const paths = new Set<string>();
  let unreadable: string | undefined;
  const bad = (why: string): void => { unreadable ??= why; };
  const add = (raw: string): void => {
    if (raw.includes('\0')) { bad('a file name in it holds a character no file name has'); return; }
    // Hermes joins the paths with ", " and a path may hold a comma of its own: the field is checked whole, in pieces, and as every run of
    // neighbouring pieces put back together. The pieces are capped so the number of runs stays small; past the cap it fails closed.
    const pieces = raw.split(',');
    const candidates = [raw, ...pieces];
    if (pieces.length > MAX_JOIN_PIECES) bad('it names too many files to read safely');
    else for (let i = 0; i < pieces.length; i++) for (let j = i + 2; j <= pieces.length; j++) if (j - i < pieces.length) candidates.push(pieces.slice(i, j).join(','));
    for (const piece of candidates) {
      const t = strip(piece);
      if (!t) continue;
      const p = platform === 'win32' ? plainWindowsPath(t) : t;
      if (p === undefined) { bad('a file in it is named by a device path Legion cannot read'); continue; }
      if (platform === 'win32' && isAdminShare(p)) { bad('a file in it is named through a network path to a drive'); continue; }
      paths.add(p);
    }
  };
  for (const field of [r.input.file_path, r.input.path]) {
    if (field === undefined) continue;
    if (typeof field === 'string') add(field); else bad('a file name in it is not text');
  }
  if (r.diff?.path) add(r.diff.path);
  const patch = r.input.patch;
  if (typeof patch === 'string') {
    const read = patchPaths(patch);
    for (const p of read.paths) add(p);
    if (read.unreadable) bad(read.unreadable);
  }
  if (r.toolName === 'Write' && paths.size === 0) bad('it does not say which file it changes');
  return { paths: [...paths], ...(unreadable ? { unreadable } : {}) };
}

/**
 * A Hermes home as Hermes reads it: `os.path.expanduser(os.path.expandvars(path))` (hermes_constants.py:46-48). Python leaves a name it cannot find as written;
 * on Windows `$name`, `${name}` and `%name%` all expand and names match without case (ntpath.expandvars), elsewhere only `$name` and `${name}` do (posixpath.expandvars).
 * A leading `~` is the home folder; `~name` is another user's: ntpath swaps the last folder of the home for that name, posixpath asks the system, which Legion cannot, so it stays as written.
 */
export function expandHermesHome(raw: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const win = platform === 'win32';
  const look = (name: string): string | undefined => {
    if (!win) return env[name];
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
  };
  const vars = win ? /\$\{([^}]*)\}|\$([A-Za-z0-9_-]+)|%([^%]*)%/g : /\$\{([^}]*)\}|\$([A-Za-z0-9_]+)/g;
  let out = raw.replace(vars, (all: string, a?: string, b?: string, c?: string) => look((a ?? b ?? c) as string) ?? all);
  if (out.startsWith('~')) {
    const sep = win ? /[\\/]/ : /\//;
    const cut = out.slice(1).search(sep);
    const name = cut < 0 ? out.slice(1) : out.slice(1, 1 + cut);
    const rest = cut < 0 ? '' : out.slice(1 + cut);
    const userHome = win ? (look('USERPROFILE') ?? home) : (look('HOME') ?? home);
    if (!name) out = userHome + rest;
    else if (win) out = (name === look('USERNAME') ? userHome : win32.join(win32.dirname(userHome), name)) + rest;
  }
  return out;
}

/** The folders that hold the agent's own settings: its home, the platform default when none is set, and any home the entry sets. */
export function hermesHomes(entry: AcpEntry, override: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  const out = new Set<string>();
  const ex = (p: string): string => expandHermesHome(p, { ...env, ...(entry.env ?? {}) }, platform, home);
  if (override) out.add(ex(override));
  const set = entry.env?.HERMES_HOME ?? env.HERMES_HOME;
  if (set && set.trim()) out.add(ex(set.trim()));
  if (!override && !(set && set.trim())) {
    // Hermes's own default (hermes_constants.py get_hermes_home): %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere
    const local = env.LOCALAPPDATA?.trim();
    const suffix = entry.env?.HERMES_DATA_DIR_SUFFIX ?? env.HERMES_DATA_DIR_SUFFIX ?? ''; // hermes_constants.py:51-58, added to the name as it stands
    out.add(platform === 'win32' ? join(local || join(home, 'AppData', 'Local'), `hermes${suffix}`) : join(home, `.hermes${suffix}`));
  }
  return [...out];
}
