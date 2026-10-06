/**
 * The merged list of skills and the one rule that says what an agent gets from it.
 *
 * `access` is the single decision used everywhere: the `skills` list passed to a Claude run, the refusal of a typed /command, the
 * provider tools, the house drill filter and the "effective skills" screen. A skill is:
 * - 'off'    not offered, and Legion's chat refuses to send `/<id>` to the agent;
 * - 'manual' not offered to the agent's own judgement, but `/<id>` still runs. Also what a skill that is 'on' but not granted to this
 *            agent (its `agents` list, or the agent's own `skills` list) becomes: the owner can still ask for it by name;
 * - 'on'     offered to the agent: it sees the description and decides.
 */
import type { AgentProfile } from '../../shared/types.js';
import { agentSkillsAllow } from '../../shared/skill-ids.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findHiddenChars, hasShellPreprocessing } from './files.js';
import { BUILTIN_SKILLS, claudeHomeDir, discoverClaudeCode, scanArmoryDir } from './discover.js';
import type { DiscoveredSkill, SkillSource } from './discover.js';
import { defaultState, readArmoryFile, sha256Of, skillsDir } from './store.js';
import type { AgentGrant, ArmoryFile, SkillState } from './store.js';

export interface CatalogEntry extends DiscoveredSkill {
  state: SkillState;
  stateIsDefault: boolean;
  agents: AgentGrant;
  /** The file holds Claude Code shell preprocessing (same detector as the import refusal). Built-ins: false. */
  runsCommandsOnLoad: boolean;
  /** The skill file or one of its .md references holds hidden or direction-changing characters (same detector as the import review). Built-ins: false. */
  hiddenText: boolean;
}

const MAX_SCAN = 512_000;

/** Skills Legion keeps off whatever file defines them: applied by id AFTER the merge, so a personal skill with the same name stays locked. */
const LOCKED: ReadonlyMap<string, string> = new Map(BUILTIN_SKILLS.filter((b) => b.offReason).map((b) => [b.id, b.offReason!] as const));

function fileHash(path: string): string | undefined {
  try { return sha256Of(readFileSync(path)); } catch { return undefined; }
}

/** Reads the whole skill file (capped) and runs the one shell-preprocessing detector. An unreadable file is false. */
function runsOnLoad(path: string | null): boolean {
  if (!path) return false;
  try { return hasShellPreprocessing(readFileSync(path, 'utf8').slice(0, MAX_SCAN)); } catch { return false; }
}

/** Hidden characters in SKILL.md or an .md file beside it (a shallow, capped read, the same detector as the import review). Unreadable is false. */
function hasHiddenText(path: string | null): boolean {
  if (!path) return false;
  try {
    if (findHiddenChars(path, readFileSync(path, 'utf8').slice(0, MAX_SCAN)).length) return true;
    const dir = dirname(path);
    let n = 0;
    const visit = (d: string, depth: number): boolean => {
      for (const name of readdirSync(d)) {
        if (++n > 100) return false;
        const p = join(d, name);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (depth < 3 && visit(p, depth + 1)) return true; continue; }
        if (!/\.md$/i.test(name) || p === path || st.size > MAX_SCAN) continue;
        try { if (findHiddenChars(p, readFileSync(p, 'utf8')).length) return true; } catch { /* unreadable */ }
      }
      return false;
    };
    return visit(dir, 0);
  } catch { return false; }
}

export interface CatalogOptions {
  dataDir: string; inheritClaudeCode: boolean; claudeHome?: string; file?: ArmoryFile;
  /** The Claude Code skills the SDK listed (handshake). Absent: read the disk (the fallback). */
  claudeSkills?: DiscoveredSkill[];
}

export function buildCatalog(o: CatalogOptions): CatalogEntry[] {
  const file = o.file ?? readArmoryFile(o.dataDir);
  const found: DiscoveredSkill[] = [];
  const demoted = new Set<string>();
  for (const s of scanArmoryDir(skillsDir(o.dataDir))) {
    // A folder nobody recorded (dropped in by hand, or by a process) is treated as imported: off by default, and it taints.
    // A record that says 'yours' counts only while the file is still the bytes Legion wrote (the sha256 stored with the record): a record
    // can be forged, and the text it vouches for must not be text a third party wrote. A mismatch reads as imported (it taints).
    const rec = file.skills[s.id];
    const mine = rec?.source === 'yours' && !!rec.sha256 && !!s.path && fileHash(s.path) === rec.sha256;
    if (rec?.source === 'yours' && !mine) demoted.add(s.id);
    found.push({ ...s, source: mine ? 'yours' : 'imported' });
  }
  if (o.inheritClaudeCode) found.push(...(o.claudeSkills ?? discoverClaudeCode(claudeHomeDir(o.claudeHome))));
  found.push(...BUILTIN_SKILLS);
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const s of found) {
    if (seen.has(s.id)) continue; // first wins: Armory, then personal, then plugins, then built-ins
    seen.add(s.id);
    const rec = file.skills[s.id];
    // the owner's own choice for a skill that was 'yours' still stands after it is demoted to imported (only the source, and so the taint, changes)
    const applies = !!rec && (rec.source === s.source || demoted.has(s.id));
    const state = applies ? rec!.state : defaultState(s.source);
    const locked = !s.id.includes(':') ? LOCKED.get(s.id) : undefined;
    out.push({ ...s, ...(locked ? { offReason: locked } : {}), state, stateIsDefault: !applies, agents: rec?.agents ?? 'all', runsCommandsOnLoad: runsOnLoad(s.path), hiddenText: hasHiddenText(s.path) });
  }
  return out;
}

export type Access = 'on' | 'manual' | 'off';

export function access(e: CatalogEntry, agent: Pick<AgentProfile, 'id' | 'skills'>): Access {
  if (e.offReason || e.unsafeReason) return 'off';
  if (e.state === 'off') return 'off';
  if (e.state === 'manual') return 'manual';
  if (e.agents !== 'all' && !e.agents.some((a) => a === agent.id)) return 'manual';
  if (!agentSkillsAllow(agent.skills, e.id)) return 'manual';
  return 'on';
}

/** Sources whose text did not come from the owner's own hand: loading one taints the run. */
export const THIRD_PARTY: ReadonlySet<SkillSource> = new Set<SkillSource>(['imported', 'claude-plugin']);

/** Whether loading the skill with this id (as the Skill tool names it) taints the run. Unknown and ambiguous names taint. */
export function loadTaints(catalog: readonly CatalogEntry[], rawId: string): boolean {
  const id = String(rawId ?? '').trim().replace(/^\//, '');
  const exact = catalog.find((e) => e.id === id);
  if (!exact) return true;
  // A bare name that is also the short name of an imported or plugin skill is ambiguous: fail closed.
  if (!id.includes(':') && catalog.some((e) => THIRD_PARTY.has(e.source) && e.name === id)) return true;
  return THIRD_PARTY.has(exact.source);
}

/**
 * The /commands of Claude Code itself that a Legion task may start with (used when the SDK listing is not available; with it, the
 * SDK's own list of commands that are not skills is used instead). A /name that is neither one of these nor a skill the owner
 * left on or manual is refused: Claude Code would otherwise run whatever it finds under that name.
 */
export const CLI_COMMANDS: ReadonlySet<string> = new Set([
  'compact', 'clear', 'context', 'cost', 'usage', 'status', 'help', 'memory', 'todos', 'rewind', 'export', 'resume', 'init', 'review',
  'security-review', 'pr-comments', 'release-notes', 'model', 'vim',
  'config', 'mcp', 'agents', 'permissions', 'add-dir', 'hooks', 'login', 'logout', 'doctor', 'ide', 'terminal-setup', 'bug',
]);

/**
 * A first token that is a file path, not a command: it holds a dot (a file name; no skill id has one), or a backslash (a Windows path), or it
 * is the bare root of a path (/tmp, /home, /Users). Such a message is text for the agent. A skill or Claude Code command of that exact
 * name is still checked first, so a skill called "home" is not shadowed.
 */
const PATH_ROOTS: ReadonlySet<string> = new Set(['tmp', 'home', 'users', 'mnt', 'var', 'etc', 'usr', 'opt']);
export function looksLikePath(prompt: string): boolean {
  const raw = /^\s*\/(\S+)/.exec(String(prompt ?? ''))?.[1];
  if (!raw) return false;
  return raw.includes('.') || raw.includes(String.fromCharCode(92)) || PATH_ROOTS.has(raw.toLowerCase());
}

/**
 * The command a prompt starts with, exactly as sent (no prefix is stripped: the caller passes the text that will reach Claude Code,
 * after routeModel). Lower case. A token with a slash in it is a path, not a command. Undefined when the text is not a /command.
 */
export function typedCommand(prompt: string): string | undefined {
  const tok = /^\s*\/(\S+)/.exec(String(prompt ?? ''))?.[1];
  if (!tok || tok.includes('/')) return undefined;
  return /^[\w.:-]+/.exec(tok)?.[0]?.toLowerCase();
}

export type GroupKind = 'yours' | 'imported' | 'claude-personal' | 'claude-plugin' | 'claude-ai' | 'claude-builtin';

/** What the screen groups a skill under. claude.ai synced skills are their own group; their taint (source 'claude-plugin') is unchanged. */
export function groupKindOf(e: Pick<CatalogEntry, 'source' | 'origin'>): GroupKind {
  return e.source === 'claude-plugin' && e.origin === 'claude-ai' ? 'claude-ai' : e.source;
}

/** The slash form the owner can type, or null when none exists (an id with a space or other untypeable character cannot be typed). */
export function commandOf(e: Pick<CatalogEntry, 'id'>): string | null {
  return /^[\w.:-]+$/.test(e.id) ? e.id : null;
}

/**
 * Which skills a typed or loaded name means. An exact id decides alone (so the built-in `code-review` is not blocked because
 * `engineering:code-review` is off). Only a bare name that is not an exact id and is the short name of several skills is ambiguous.
 * The one rule for the typed /command check and the Skill-tool gate.
 */
export function resolveName(catalog: readonly CatalogEntry[], raw: string): { hits: CatalogEntry[]; ambiguous?: string } {
  const typed = String(raw ?? '').toLowerCase();
  const exact = catalog.filter((e) => e.id.toLowerCase() === typed);
  if (exact.length) return { hits: exact };
  if (typed.includes(':')) return { hits: [] };
  const byName = catalog.filter((e) => e.name.toLowerCase() === typed);
  if (byName.length <= 1) return { hits: byName };
  const ids = byName.map((e) => e.id);
  const shown = ids.slice(0, 5).join(', ') + (ids.length > 5 ? `, and ${ids.length - 5} more` : '');
  const eg = ids.find((i) => i.includes(':')) ?? ids[0]!;
  return { hits: byName, ambiguous: `/${typed} matches several skills: ${shown}. Type the full name, e.g. /${eg}.` };
}

/** A plain message when the prompt starts with a /command that this agent may not run, else undefined. Fails closed on an unknown name. */
export function refusedCommand(
  catalog: readonly CatalogEntry[], agent: Pick<AgentProfile, 'id' | 'skills'>, prompt: string, cliCommands: ReadonlySet<string> = CLI_COMMANDS,
): string | undefined {
  const typed = typedCommand(prompt);
  if (!typed) return undefined;
  const { hits, ambiguous } = resolveName(catalog, typed);
  if (ambiguous) return ambiguous;
  // A built-in the owner never touched, whose name is also one of Claude Code's own commands (/init, /security-review), is that command, not a switched-off skill.
  const off = hits.find((e) => access(e, agent) === 'off' && !(e.source === 'claude-builtin' && e.stateIsDefault && cliCommands.has(e.id)));
  if (off) return `/${typed} is switched off in the Armory (${off.id}). Turn it on in Settings > Armory, or set it to "Only when I ask".`;
  if (hits.length) return undefined;
  if (cliCommands.has(typed)) return undefined;
  if (looksLikePath(prompt)) return undefined;
  return `/${typed} is not a command Legion knows: it is not one of Claude Code's own commands and not a skill in the Armory. Check the name, or turn the skill on in Settings > Armory.`;
}
