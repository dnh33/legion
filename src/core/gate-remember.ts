/**
 * The shape of a remembered rule, built from one approval request: this agent, narrowed to the command's program (plus
 * its subcommand, `git status`) or to the file's folder, or to the tool. One source for the approval card's Remember
 * (ui/src/gates/gatesLogic.ts) and the learned suggestions (gate-suggestions.ts), so both always build the same rule.
 * Pure and browser-safe: the UI bundles it.
 */
import type { GateWhen } from '../shared/types.js';
import { allowSubcommands } from './gates.js';

/** Allows of the same kind before the learned suggestions offer the rule. */
export const SUGGEST_AFTER = 3;

/** A request as the card and the suggestions see it. */
export interface RememberCall { agentId: string; toolName: string; input: Record<string, unknown> }

/** Cards a rule must not decide: web reads (a site is allowed on its own card, never tool-wide), rails (a Blender script, a download, read and clicked every time) and room requests. */
const NO_REMEMBER = /^(?:WebFetch|WebSearch|mcp__legion_blender__blender_exec|mcp__legion_blender__blender_asset_get|legion_get_blender|mcp__legion_comms__room_(?:create|add_member|remove_member))$/;

/** Whether a rule may be remembered for this request at all. A card the core marks `noRemember` (a command it cannot read) never offers one. */
export function canRemember(a: { toolName: string; noRemember?: boolean }): boolean {
  return a.noRemember !== true && !NO_REMEMBER.test(a.toolName);
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** Programs that run whatever text follows them: shells, interpreters, package runners and wrappers. */
const RUNNERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'wsl',
  'python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'osascript',
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx',
  'sudo', 'doas', 'env', 'xargs', 'eval', 'exec', 'nohup', 'time', 'nice', 'timeout', 'watch', 'ssh', 'su', 'runas', 'start', 'call',
]);
const runsAnything = (prog: string): boolean => RUNNERS.has(prog.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, ''));

/**
 * Whether an "always allow" may be offered. Not for a line no allow can hold on (command substitution, an open quote),
 * and not for a runner whose exact command holds a wildcard: an exact-command rule is a glob pattern, so `python *.py`
 * would allow every script.
 */
export function canRememberAllow(a: { toolName: string; input: Record<string, unknown> }): boolean {
  if (!canRemember(a)) return false;
  const command = typeof a.input.command === 'string' ? a.input.command.trim() : '';
  // a download command reaches any site: sites are allowed one by one on the web card, never by a command rule
  if (/^(?:curl|wget|iwr|irm|invoke-webrequest)\b/i.test(command)) return false;
  if (!command) return true;
  const parts = allowSubcommands(command);
  if (!parts) return false;
  return !parts.some((p) => runsAnything(p.split(/\s+/)[0]!) && /[*?[\]]/.test(p));
}

/** One part of a command as patterns: a runner's exact text, else its program (and subcommand) with and without arguments. */
function partPatterns(part: string): string[] {
  const [prog, next] = part.split(/\s+/);
  // a shell, an interpreter or a wrapper runs whatever follows it: only this exact command is remembered
  if (runsAnything(prog!)) return [part.toLowerCase()];
  // a subcommand is a plain word (status, test, run); a flag, a path or a file name is not
  const prefix = (next && /^[a-z][a-z0-9-]*$/.test(next) ? `${prog} ${next}` : prog!).toLowerCase();
  return [prefix, `${prefix} *`];
}

/**
 * The `when` of the remembered rule. A chained line (`pwd; ls -la`) is judged per part by the gate, so the rule names
 * each part's program: one pattern for the whole line would never match it. A line no allow can hold on is remembered
 * as written (a block).
 */
export function rememberWhen(a: RememberCall): GateWhen {
  const when: GateWhen = { agents: [a.agentId], tools: [a.toolName] };
  const command = typeof a.input.command === 'string' ? a.input.command.trim() : '';
  const path = PATH_KEYS.map((k) => a.input[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (command) {
    const parts = allowSubcommands(command) ?? [command];
    when.commands = [...new Set(parts.flatMap(partPatterns))];
    delete when.tools; // the command scopes it; the same program is the same choice in Bash and the agent shell
  } else if (path) {
    const p = path.replace(/\\/g, '/');
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    when.paths = [dir ? `${dir}/**` : p];
  }
  return when;
}
