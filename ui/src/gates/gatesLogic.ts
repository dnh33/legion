/**
 * The Gates view-model: sentences, chips, presets and the dry-run tester's model. Pure functions and constants
 * only, the same strings the Settings surface renders and stores as GateRule.label, so what the owner reads IS
 * the rule. The tester calls the real decideGate; it runs nothing.
 */
import { decideGate } from '../../../src/core/gates.js';
import { rememberWhen } from '../../../src/core/gate-remember.js';
import { AGENT_MODE_LABEL } from './presetsLogic.js';
import type { ApprovalMode, GateContext, GateRule, GateVerdict, GatesConfig, GateWhen } from '../../../src/shared/types.js';

/** Each agent's mode is named and explained by the agent editor's own words (mode first, gates on top): AGENT_MODE_LABEL and AGENT_MODE_HELP. */

/** The "What" chips: the tool groups a rule may name (see GATE_TOOL_GROUPS in src/core/gates.ts). */
export const TOOL_CHIPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'shell', label: 'Shell' },
  { id: 'edits', label: 'File edits' },
  { id: 'reads', label: 'File reads' },
  { id: 'tasks', label: 'Task list' },
  { id: 'web', label: 'Web' },
  { id: 'host', label: 'Host shell' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'blender', label: 'Blender' },
];

/** The "Where" context chips, each with the one line that explains what it means. */
export const CONTEXT_CHIPS: ReadonlyArray<{ id: GateContext; label: string; why: string }> = [
  { id: 'capped', label: 'Started by Claude Code or another bot', why: 'A run another program started. Rules can only make it stricter, never looser.' },
  { id: 'room-hop', label: 'Another agent asked for this', why: 'A run woken by a message from another agent.' },
  { id: 'tainted', label: 'After outside content', why: 'The run already touched text or results from outside Legion.' },
  { id: 'connector-data', label: 'After GitHub data', why: 'The run already read data through a connector.' },
];

const TOOL_LABEL: Record<string, string> = Object.fromEntries(TOOL_CHIPS.map((c) => [c.id, c.label.toLowerCase()]));
const CONTEXT_LABEL: Record<GateContext, string> = Object.fromEntries(CONTEXT_CHIPS.map((c) => [c.id, c.label.toLowerCase()])) as Record<GateContext, string>;

/** A fresh rule id: 'gr_' plus 12 hex characters, the shape shared/config.ts accepts. */
export function newGateId(): string {
  const hex = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  return `gr_${hex}`;
}

/** Add/remove one item in a chip list (the builder's only list operation). */
export function toggleIn(list: readonly string[], x: string): string[] {
  return list.includes(x) ? list.filter((v) => v !== x) : [...list, x];
}

const joinOr = (xs: readonly string[]): string => xs.map((p) => '`' + p + '`').join(' or ');

/** Command patterns as words: the pair Remember makes (`X` and `X *`) reads once, as "`X` with any arguments". */
function joinCommands(pats: readonly string[]): string {
  const set = new Set(pats);
  const words: string[] = [];
  for (const p of pats) {
    if (p.endsWith(' *') && set.has(p.slice(0, -2))) continue; // said with its bare form
    words.push(set.has(`${p} *`) ? '`' + p + '` with any arguments' : '`' + p + '`');
  }
  return words.join(' or ');
}

/**
 * The sentence a rule is stored AS and shown AS. Grammar holds for every shape: the verb form follows the
 * "what" (run/running, change/changing, use/using), so no combination reads broken. `projectOf` maps a project
 * id to the name the owner knows (default: the id itself).
 */
export function gateSentence(when: GateWhen, then: GateVerdict, nameOf: (id: string) => string, projectOf: (id: string) => string = (id) => id): string {
  const who = when.agents?.length ? when.agents.map(nameOf).join(', ') : 'Every agent';
  const pats = when.commands ?? [];
  const paths = when.paths ?? [];
  const tools = (when.tools ?? []).map((t) => TOOL_LABEL[t] ?? t);
  let base: string;
  let ing: string;
  if (pats.length) { base = 'run ' + joinCommands(pats); ing = 'running ' + joinCommands(pats); }
  else if (paths.length) { base = 'change files matching ' + joinOr(paths); ing = 'changing files matching ' + joinOr(paths); }
  else if (tools.length) { base = 'use ' + tools.join(', '); ing = 'using ' + tools.join(', '); }
  else { base = 'do anything'; ing = 'doing anything'; }
  let s = then === 'allow' ? `${who} may ${base}`
    : then === 'deny' ? `${who} may never ${base}`
      : `${who} needs your OK before ${ing}`;
  if (when.projects?.length) s += ' \u00b7 in ' + when.projects.map(projectOf).join(', ');
  if (when.contexts?.length) s += ' \u00b7 only when ' + when.contexts.map((c) => CONTEXT_LABEL[c]).join(' or ');
  return s;
}

/** A rule touches the agent shell only when its tools name the host group, a host glob, or a host tool exactly. */
export function ruleNeedsHost(when: GateWhen): boolean {
  return (when.tools ?? []).some((t) => t === 'host' || t.startsWith('mcp__host__'));
}

/** True when no agent a rule affects has the host shell on, the card says so instead of pretending to act. */
export function ruleHostless(when: GateWhen, agents: readonly Pick<{ id: string; host?: { enabled?: boolean } }, 'id' | 'host'>[]): boolean {
  if (!ruleNeedsHost(when)) return false;
  const scope = when.agents?.length ? agents.filter((a) => when.agents!.includes(a.id)) : agents;
  return !scope.some((a) => a.host?.enabled === true);
}

/** The consequence line under "Then": computed from the rule and the agent's real mode, never a made-up number. */
export function consequenceLine(then: GateVerdict, mode: ApprovalMode): string {
  if (then === 'deny') return 'Applies in every mode, Full included. It is the one class that survives Full.';
  if (then === 'ask') return mode === 'full'
    ? 'This agent is on Full, so Ask rules are off here. Block rules still apply.'
    : 'Makes matching calls ask you, on top of this agent\'s mode (' + AGENT_MODE_LABEL[mode] + ').';
  return 'Lets matching calls run without asking. On Full it changes nothing (nothing asks there anyway); it never loosens a run another bot started.';
}

/** The shipped preset: a "never, whatever the mode" floor, offered (never auto-applied). */
export const GATE_PRESETS: ReadonlyArray<{ id: string; title: string; when: GateWhen; then: GateVerdict; label: string }> = [
  {
    id: 'destructive-block', title: 'Suggested: never rm -rf / sudo', then: 'deny',
    when: { commands: ['rm -rf *', 'sudo *', 'mkfs*', 'format *'] },
    label: 'No agent may ever run rm -rf, sudo, mkfs or format',
  },
];

/** The default rule list, stamped with the preset provenance. */
export function presetRule(p: { id: string; when: GateWhen; then: GateVerdict; label: string }): GateRule {
  return { id: newGateId(), enabled: true, then: p.then, when: structuredCloneSafe(p.when), label: p.label, source: 'preset' };
}

export { SUGGEST_AFTER, canRemember, canRememberAllow } from '../../../src/core/gate-remember.js';

/**
 * The rule the approval card's "Remember" saves (source 'card'): this agent and this tool, narrowed to the command's
 * program (plus its subcommand, `git status`) or to the file's folder. The owner reads the sentence before it is saved.
 */
export function rememberRule(a: { agentId: string; toolName: string; input: Record<string, unknown> }, then: 'allow' | 'deny', nameOf: (id: string) => string): GateRule {
  const when = rememberWhen(a);
  return { id: newGateId(), enabled: true, then, when, label: gateSentence(when, then, nameOf), source: 'card' };
}

/** structuredClone without assuming it exists in an old webview. */
function structuredCloneSafe<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** The tester's view of one call. */
export interface GateTestCall { toolName: string; input: Record<string, unknown>; agentId?: string; mode: ApprovalMode }

export interface GateTestResult {
  verdict: GateVerdict | 'baseline';
  /** Every rule whose `when` matched, labels included, for the "why" readout. */
  matched: GateRule[];
}

/**
 * The "Try it" tester: the SAME decideGate the engine calls, with the rules exactly as stored. It decides, prints
 * and runs NOTHING: a dry run of the real decision.
 */
export function gateTestResult(rules: readonly GateRule[], call: GateTestCall, capped = false): GateTestResult {
  const d = decideGate({ toolName: call.toolName, input: call.input, agentId: call.agentId }, rules, call.mode, capped);
  return { verdict: d.verdict, matched: d.ruleIds.map((id) => rules.find((r) => r.id === id)).filter((r): r is GateRule => !!r) };
}

/** Hermes agents (R71): only the owner's Block rules reach them, and a blocked request is refused with no card, in every mode (Full does not lift it). */
export function hermesGateResult(rules: readonly GateRule[], call: GateTestCall): GateTestResult {
  const d = decideGate({ toolName: call.toolName, input: call.input, agentId: call.agentId }, rules, 'full', false);
  if (d.verdict !== 'deny') return { verdict: 'baseline', matched: [] };
  return { verdict: 'deny', matched: d.ruleIds.map((id) => rules.find((r) => r.id === id)).filter((r): r is GateRule => !!r && r.then === 'deny') };
}

/** What the tester says for an agent on an agent host; `name` is the host's own name, so another host is never called Hermes. */
export const hostVerdictText = (name: string = 'Hermes') => ({
  deny: 'BLOCKED (the request is refused, no card)',
  baseline: `NOT BLOCKED (no Block rule matched; ${name} decides what to ask you)`,
}) as const;
export const HERMES_VERDICT_TEXT = hostVerdictText();

/** The verdict line the tester prints (exit-code style, consistent with allow / ask-approval / deny). */
export const VERDICT_TEXT: Record<GateTestResult['verdict'], string> = {
  allow: 'ALLOW (no card)',
  ask: 'ASK (a card appears)',
  deny: 'DENY (the call is blocked)',
  baseline: 'BASELINE (no rule matched; your agent\'s mode decides)',
};

/** The empty state's teaching line: mode first, gates on top. */
export const GATES_EMPTY = 'Your agents\' approval mode decides the default. Gates adjust it for one agent, one command or one project. Block rules apply even to Full; Ask rules do not.';
