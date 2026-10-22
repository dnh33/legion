/**
 * Small pure pieces of an agent host run, kept out of engine.ts: what a card says, which Legion mode maps to which agent mode,
 * which tool calls are Legion's own route, and where the agent keeps its home.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpEntry } from '../../shared/acp-view.js';
import type { RunMode } from '../../shared/types.js';
import type { MappedPermission } from './map.js';

/** Hermes denies a request nobody answers after this long (acp_adapter/permissions.py timeout). */
export const HERMES_SELF_DENY_MS = 300_000;

/** The agent mode Legion sets when the owner asked it to match Legion's mode. Full and Bypass are both `full` here; Ask-like modes ask. */
export function agentModeFor(mode: RunMode): 'default' | 'accept_edits' | 'dont_ask' {
  if (mode === 'full') return 'dont_ask';
  if (mode === 'auto-edits') return 'accept_edits';
  return 'default'; // ask, smart and smart-edits: the agent keeps asking (it has no mode that asks only about risk)
}

/** A tool call on Legion's own route: Hermes names such a call `mcp__editor_legion_<tag>__<tool>`. The route already wrote its rows. */
export const isRouteTool = (name: string): boolean => /^mcp__editor_legion_[0-9a-z]+__/.test(name);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The text of a card for one request: the settings line first when it applies, then the command or the file and its change. */
export function cardSummary(r: MappedPermission, protectedName: string | undefined): string {
  const lines: string[] = [];
  if (protectedName) lines.push(`This touches Legion's own settings: ${protectedName}`);
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
  if (lines.length === (protectedName ? 1 : 0)) lines.push(r.title);
  return lines.join('\n').slice(0, 1500);
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
