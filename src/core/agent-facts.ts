/**
 * "What you can do right now": a short block appended to a run's system prompt, between the module preambles and the agent's own
 * prompt. It is built from the servers the run really has (the in-process tool registrations) and the gates in force, so it cannot go
 * stale the way hand-typed text does, and it works for installs whose stored personas never update. It never edits a persona.
 * Facts only, no voice. Pure: no I/O, no clock.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile, ApprovalMode } from '../shared/types.js';
import { stricterMode } from './approvals.js';

export const FACTS_HEADER = 'What you can do right now:';

/** Registered tools a bot is not shown in its block, with the reason. Empty on purpose: add a name here only with a reason, the coverage test reads it. */
export const INTENTIONALLY_HIDDEN: Readonly<Record<string, readonly string[]>> = {};

/** In-process Legion servers and the label their line carries. Anything else (the user's own MCP servers) is not described: its tools are unknown here. */
const SERVERS: ReadonlyArray<readonly [server: string, label: string]> = [
  ['legion', 'Agents and VM'],
  ['legion_comms', 'Bots and rooms'],
  ['legion_kg', 'Library (knowledge graph)'],
  ['legion_browser', 'Browser'],
  ['legion_blender', 'Blender'],
  ['legion_bsv', 'BSV wallet'],
];

/** Browser tools that can send something to a site (a form, a click that submits, a script). The Herald, who only drafts, is told not to use them. */
export const BROWSER_WRITE_TOOLS = ['browser_type', 'browser_click', 'browser_eval'] as const;
const DRAFT_ONLY_BOTS: ReadonlySet<string> = new Set(['herald']);

/** Names of the tools registered on an in-process server config, or undefined when they cannot be read (then the line is left out, never guessed). */
export function toolNamesOf(cfg: McpServerConfig | undefined): string[] | undefined {
  const reg = (cfg as { instance?: { _registeredTools?: Record<string, { enabled?: boolean }> } } | undefined)?.instance?._registeredTools;
  if (!reg || typeof reg !== 'object') return undefined;
  return Object.entries(reg).filter(([, t]) => t?.enabled !== false).map(([n]) => n).sort();
}

export interface FactsContext {
  /** The servers this run really gets (the engine's buildMcpServers result). */
  servers: Record<string, McpServerConfig>;
  /** A ceiling from whoever woke this run (an MCP client, or a bot). */
  ceiling?: ApprovalMode;
  /** Whether this run's agent has VM tools registered is read from `servers`; this only explains a missing one. */
  vmEnabledForAgent: boolean;
}

export function renderCapabilities(agent: AgentProfile, ctx: FactsContext): string {
  const lines: string[] = [];
  const names = new Map<string, string[]>();
  for (const [server] of SERVERS) {
    const n = toolNamesOf(ctx.servers[server]);
    if (n) names.set(server, n.filter((t) => !(INTENTIONALLY_HIDDEN[agent.id] ?? []).includes(t)));
  }
  const draftOnly = DRAFT_ONLY_BOTS.has(agent.id);
  for (const [server, label] of SERVERS) {
    const n = names.get(server);
    if (!n || n.length === 0) continue;
    if (server === 'legion_browser' && draftOnly) {
      const read = n.filter((t) => !(BROWSER_WRITE_TOOLS as readonly string[]).includes(t));
      lines.push(`- ${label} (${server}): ${read.join(', ')}. You draft only: you may open, read and list links, but do not use ${BROWSER_WRITE_TOOLS.join(', ')}; submitting a form is a message sent to someone else's service.`);
      continue;
    }
    lines.push(`- ${label} (${server}): ${n.join(', ')}.`);
  }
  if (!names.get('legion')?.some((t) => t.startsWith('vm_'))) {
    lines.push(ctx.vmEnabledForAgent
      ? '- VM tools: not available this run (no boat.dev key is set up).'
      : '- VM tools: not available to you (your VM is off).');
  } else {
    // only a run that really has the VM tools pays for the VM policy (it used to sit in every run's preamble)
    lines.push('- VM: an on-demand cloud VM that costs money while running. Start it only when needed (untrusted code, long jobs, GUI/browser work, heavy installs) and stop it with vm_stop when done. vm_claude hands a whole task to Claude Code inside the VM, which can also drive the VM desktop/browser. Treat desktop URLs as secrets and tell the user to open them.');
  }
  if (names.has('legion_browser') && names.get('legion_browser')!.length > 0) {
    // the mode in force, computed once below and reused for the approvals line
    const m = ctx.ceiling ? stricterMode(agent.approval, ctx.ceiling) : agent.approval;
    lines.push(draftOnly
      ? '- Notes you write after browsing wait in the owner\'s Inbox.'
      : `- Typing, clicking and scripts in a page need an approval card${m === 'full' ? ' in any mode but full — yours is full, so you will not be asked' : ' unless your mode is full'}. Notes you write after browsing wait in the owner\'s Inbox.`);
  }
  if (names.has('legion_bsv')) {
    lines.push('- bsv_status contacts a wallet and counts as outside content, so it marks the run tainted. A spend request from a tainted run needs a second native dialog on the owner\'s card. You never choose the network; mainnet is off unless the owner switches it on and arms it.');
  }
  if (names.has('legion_kg') && (names.get('legion_kg') ?? []).includes('kg_supersede')) {
    // One line, and only when the tool is really registered. A stale note is retired with kg_supersede rather than
    // replaced by a near-duplicate, and on a shared note that lands as a proposal the owner accepts - which is the
    // difference between a Library that stays true and one that accumulates contradictions.
    lines.push('- When a note is outdated, kg_supersede retires it instead of you capturing a near-duplicate. On a shared note it becomes a proposal the owner accepts, not a change you make.');
  }
  if (agent.id === 'sentinel') {
    lines.push('- Scheduling: checks run only while a task is running; scheduled runs are planned, not available yet.');
  }
  if (agent.id === 'quartermaster') {
    lines.push('- Scheduling: the supply watch runs only when the owner or another bot asks; scheduled runs are planned, not available yet.');
  }
  const mode = ctx.ceiling ? stricterMode(agent.approval, ctx.ceiling) : agent.approval;
  lines.push(`- Approvals: your mode is ${mode}${mode !== agent.approval ? ` (capped from ${agent.approval} by whoever woke you)` : ''}. A denied action stays denied; do not reroute it.`);
  return `${FACTS_HEADER}\n${lines.join('\n')}`;
}
