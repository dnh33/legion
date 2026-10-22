/**
 * Small pure pieces of an agent host run, kept out of engine.ts: what a card says, which Legion mode maps to which agent mode,
 * which tool calls are Legion's own route, and where the agent keeps its home.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
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

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The text of a card for one request: the lead lines first (a settings line, why Legion asks), then the command or the file and its change. */
export function cardSummary(r: MappedPermission, lead: readonly string[] = []): string {
  const lines: string[] = [...lead];
  const command = typeof r.input.command === 'string' ? r.input.command : undefined;
  const description = typeof r.input.description === 'string' ? r.input.description : undefined;
  if (command) lines.push(clip(command, 1000));
  if (description && description !== command) lines.push(clip(description, 300));
  if (r.diff) lines.push(clip(r.diff.path, 300), clip(r.diff.newText, 600));
  else if (!command) {
    const path = typeof r.input.file_path === 'string' ? r.input.file_path : undefined;
    if (path) lines.push(clip(path, 300));
    if (r.text) lines.push(clip(r.text, 600));
  }
  if (lines.length === lead.length) lines.push(r.title);
  return lines.join('\n').slice(0, 1500);
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
  try { ms = typeof setting === 'function' ? (entry ? setting(entry) : undefined) : setting; } catch { ms = undefined; }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_CARD_WAIT_MS) : HERMES_SELF_DENY_MS;
}

/**
 * How long a card raised inside an agent's tool call may stay open, in ms: what the setting gives (a number, or a function read at each run), else 270 s,
 * the margin below the 300 s the agent allows a tool call. Never above MAX_CARD_WAIT_MS.
 */
export function toolWaitOf(setting: number | ((entry: AcpEntry) => number | undefined) | undefined, entry?: AcpEntry): number {
  let ms: number | undefined;
  try { ms = typeof setting === 'function' ? (entry ? setting(entry) : undefined) : setting; } catch { ms = undefined; }
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
const V4A_FILE = /^\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*([^\n]+)/;
const V4A_MOVE = /^\*\*\*\s*Move\s+File:\s*([^\n]+)/;

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
      if (arrow > 0) paths.push(rest.slice(0, arrow).trim(), rest.slice(arrow + 2).trim());
      else paths.push(rest.trim()); // no arrow: Hermes rejects it, and the one path it names is still checked
      continue;
    }
    const f = V4A_FILE.exec(line);
    if (f) paths.push(f[1]!.trim());
  }
  return { paths };
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
    for (const piece of [raw, ...raw.split(',')]) {
      const t = piece.trim();
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

/** The folders that hold the agent's own settings: its home, the platform default when none is set, and any home the entry sets. */
export function hermesHomes(entry: AcpEntry, override: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const out = new Set<string>();
  if (override) out.add(override);
  const set = entry.env?.HERMES_HOME ?? env.HERMES_HOME;
  if (set && set.trim()) out.add(set.trim());
  if (!override && !(set && set.trim())) {
    // Hermes's own default (hermes_constants.py get_hermes_home): %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere
    const local = env.LOCALAPPDATA?.trim();
    out.add(platform === 'win32' ? join(local || join(homedir(), 'AppData', 'Local'), 'hermes') : join(homedir(), '.hermes'));
  }
  return [...out];
}
