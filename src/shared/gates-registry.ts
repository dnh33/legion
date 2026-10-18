/**
 * Every gate Legion has, in one list: what it protects, what can happen with it off, and its value under each preset
 * (spec docs/superpowers/specs/2026-10-14-goal-and-gates-design.md, section 4). Pure: no I/O, safe in the window and the core.
 * Permission gates follow the preset; QA gates follow a goal's care level (part 3); rails are always on and have no switch.
 */
export const PRESETS = ['ask', 'accept-edits', 'smart', 'bypass'] as const;
export type Preset = (typeof PRESETS)[number];
export type GateFamily = 'permission' | 'qa' | 'rail';
export type GateValue = boolean | { on: true; limit: number };

export interface GateDef {
  id: string;
  family: GateFamily;
  scope: 'global' | 'project';
  label: string;
  protects: string;
  ifOff: string;
  defaults: Record<Preset, GateValue> | 'always';
}

const all = (v: GateValue, bypass: GateValue = v): Record<Preset, GateValue> => ({ ask: v, 'accept-edits': v, smart: v, bypass });

/** What a command still asks about in Bypass, and what the file tools never change in any mode: one list, in plain words, for every place that says it. */
export const PROTECTED_FILES_TEXT = "your gate settings, Legion's settings file, your agents' settings or your projects";

const GATE_LIST = [
  { id: 'tool-cards', family: 'permission', scope: 'project', label: 'Ask before tools run', protects: 'An agent runs a command or changes files only after you say yes, as its own setting says.', ifOff: 'Agents run commands and change files without asking.', defaults: all(true, false) },
  { id: 'github-write-card', family: 'permission', scope: 'project', label: 'Ask before every GitHub write', protects: 'Every issue, comment, pull request, review or CI action an agent sends to GitHub waits for your yes.', ifOff: 'Agents write to GitHub without asking. Merge, push and delete are still never offered to them.', defaults: all(true, false) },
  { id: 'board-delete-card', family: 'permission', scope: 'project', label: 'Ask before a board item is deleted', protects: 'An agent deletes a board item only after you say yes.', ifOff: 'The lead agent deletes board items without asking.', defaults: all(true, false) },
  { id: 'module-cards', family: 'permission', scope: 'project', label: 'Ask before browser, Blender and room actions', protects: 'The browser, Blender and room tools ask before they act, as the agent setting says.', ifOff: 'These tools act without asking.', defaults: all(true, false) },
  { id: 'digest-hold', family: 'permission', scope: 'project', label: 'A few seconds to take back an Allow', protects: 'An Allow on the project page waits 5 or 10 seconds with Undo.', ifOff: 'An Allow is sent at once.', defaults: all(true, false) },
  { id: 'ask-timeout-deny', family: 'permission', scope: 'project', label: 'No answer means no', protects: 'A card nobody answers is refused after 10 minutes.', ifOff: 'Not used: without this, an unanswered card would wait forever.', defaults: all(true) },
  { id: 'attempt-caps', family: 'permission', scope: 'project', label: 'Limit retries on one item', protects: 'An item is tried at most twice per agent and four times in all.', ifOff: 'An item can be retried without limit.', defaults: all({ on: true, limit: 4 }, { on: true, limit: 8 }) },
  { id: 'stall-ladder', family: 'permission', scope: 'project', label: 'Stop runs that stall', protects: 'A run with no progress for 8 minutes is stopped; after two stalls the item waits for you.', ifOff: 'A stalled run keeps going.', defaults: all(true) },
  { id: 'goal-caps', family: 'permission', scope: 'project', label: 'Limit the size of a goal', protects: 'A goal pauses at 12 steps, 3 re-splits, 4 dispatches per step or 3 checks per step.', ifOff: 'A goal can grow without limit.', defaults: all({ on: true, limit: 12 }, { on: true, limit: 24 }) },
  { id: 'budget-stop', family: 'permission', scope: 'project', label: 'Stop at the budget', protects: 'When a budget you set is reached, new runs wait.', ifOff: 'Runs start even past the budget.', defaults: all(true) },
  { id: 'proposals-inbox', family: 'permission', scope: 'project', label: 'Agent proposals wait in the Inbox', protects: 'Work an agent proposes waits until you accept it.', ifOff: 'Proposals go straight to the Backlog.', defaults: all(true) },
  { id: 'env-scrub', family: 'permission', scope: 'project', label: 'Keep keys and passwords out of commands', protects: 'Variables that look like keys, tokens or passwords are not passed to the commands an agent runs, except the ones you chose to keep. Settings that make a program load other code (PYTHONPATH, NODE_OPTIONS, LD_LIBRARY_PATH and the like) are held back too. The agent is told which names were held back.', ifOff: 'Commands an agent runs get your keys, tokens and passwords from your environment, and the settings that make a program load other code.', defaults: all(true) },
  { id: 'protected-path-cards', family: 'permission', scope: 'project', label: 'Ask before changing Git, hooks and agent settings', protects: 'A change to Git (hooks included), editor and agent settings, shell startup files and package manager settings waits for your yes.', ifOff: 'An agent can plant a Git hook or change agent settings without asking. The next commit can then run it.', defaults: all(true, false) },
  { id: 'secret-file-reads', family: 'permission', scope: 'project', label: 'Ask before reading password and key files', protects: 'Reading .env, .pem, .key, SSH, cloud and .npmrc files, and the key files in Legion\'s own data folder, waits for your yes. After one is read, every web call in that run asks.', ifOff: 'An agent can read your password and key files without asking. Web calls still ask after a read while the website check is on.', defaults: all(true, false) },
  { id: 'web-reads', family: 'permission', scope: 'project', label: 'Check which websites agents read', protects: 'Stops an agent reading a site you did not approve, or hiding your data in the address it asks for.', ifOff: 'Agents can read any website without asking, and an address can carry your data out.', defaults: all(true, false) },
  { id: 'gate-rules-ask', family: 'permission', scope: 'project', label: 'Your "ask" rules', protects: 'Your Gates rules set to ask raise a card.', ifOff: 'Your ask rules are skipped. Your deny rules still apply.', defaults: all(true, false) },
  { id: 'qa-harness-check', family: 'qa', scope: 'project', label: 'Legion runs the checks itself', protects: 'A step counts as checked only when Legion ran its checks in a clean copy of the repo.', ifOff: 'A step can count as checked without its checks being run.', defaults: all(true) },
  { id: 'qa-fail-first', family: 'qa', scope: 'project', label: 'A check must fail before the work', protects: 'A check that already passes proves nothing, so it is flagged.', ifOff: 'A check that always passes is accepted.', defaults: all(true) },
  { id: 'qa-freeze-checks', family: 'qa', scope: 'project', label: 'Checks are frozen', protects: 'A step that changes its own checks is stopped.', ifOff: 'An agent can change the checks that judge it.', defaults: all(true) },
  { id: 'qa-evidence', family: 'qa', scope: 'project', label: 'Evidence with every result', protects: 'Each result keeps the command, its exit code, its output and the commit.', ifOff: 'Results are kept without proof.', defaults: all(true) },
  { id: 'qa-regression', family: 'qa', scope: 'project', label: 'Run the whole test suite after shared changes', protects: 'A change to shared code runs the project tests, not only the step check.', ifOff: 'Only the step checks run.', defaults: all(true) },
  { id: 'qa-fresh-reviewer', family: 'qa', scope: 'project', label: 'A separate reviewer', protects: 'A fresh reviewer judges the work from the diff and the evidence, not from the worker report.', ifOff: 'No second look.', defaults: all(true) },
  { id: 'qa-goal-checks', family: 'qa', scope: 'project', label: 'The goal checks run on the finished work', protects: 'The goal own checks run on the merged result before it reaches you.', ifOff: 'Only the step checks run.', defaults: all(true) },
  { id: 'rail-injection-guard', family: 'rail', scope: 'global', label: 'Text an agent read cannot start work', protects: 'Words in a web page, a file or an issue never start a run.', ifOff: '', defaults: 'always' },
  { id: 'rail-ceiling', family: 'rail', scope: 'global', label: 'An outside app or another bot cannot borrow an agent rights', protects: 'A run started by an outside app or another bot always asks.', ifOff: '', defaults: 'always' },
  { id: 'rail-mcp-no-connectors', family: 'rail', scope: 'global', label: 'Runs started by an outside app cannot use GitHub', protects: 'Only runs you start can reach GitHub.', ifOff: '', defaults: 'always' },
  { id: 'rail-web-egress-card', family: 'rail', scope: 'global', label: 'Your GitHub data does not leave by the web unasked', protects: 'A run that read your GitHub data asks before it goes to the web.', ifOff: '', defaults: 'always' },
  { id: 'rail-loopback', family: 'rail', scope: 'global', label: 'Other programs on your network cannot drive Legion', protects: 'Legion only answers your own computer.', ifOff: '', defaults: 'always' },
  { id: 'rail-signed-updates', family: 'rail', scope: 'global', label: 'Only signed updates install', protects: 'An update installs only when Legion release key signed it.', ifOff: '', defaults: 'always' },
  { id: 'rail-secret-scrub', family: 'rail', scope: 'global', label: 'Secrets are masked', protects: 'Keys and tokens are hidden in results and messages.', ifOff: '', defaults: 'always' },
  { id: 'rail-root-confine', family: 'rail', scope: 'global', label: 'File tools stay in your folders', protects: 'File tools only touch the folders you allowed.', ifOff: '', defaults: 'always' },
  { id: 'rail-protected-paths', family: 'rail', scope: 'global', label: 'Agents cannot edit Legion own settings', protects: `File tools cannot change these, or the Armory, in any mode: ${PROTECTED_FILES_TEXT}. In Bypass or Full, a command that changes any of them still asks you first.`, ifOff: '', defaults: 'always' },
  { id: 'rail-house-trust', family: 'rail', scope: 'global', label: 'Only house files you adopted load', protects: 'A changed house file is not loaded until you adopt it.', ifOff: '', defaults: 'always' },
  { id: 'rail-browser-url', family: 'rail', scope: 'global', label: 'The browser stays on the open web', protects: 'The browser cannot reach private or reserved addresses.', ifOff: '', defaults: 'always' },
  { id: 'rail-shell-floor', family: 'rail', scope: 'global', label: 'Commands that wipe a drive are refused', protects: 'Commands that wipe a drive, a system folder or your home folder never run.', ifOff: '', defaults: 'always' },
] as const satisfies readonly GateDef[];

export const GATES: readonly GateDef[] = GATE_LIST;

export type GateId = (typeof GATE_LIST)[number]['id'];

export interface GateSettings {
  preset?: Preset;
  /** "Limit agents to this": the preset is also a ceiling on every agent in the project (spec 4.2). Absent with a preset means on. */
  limit?: boolean;
  overrides?: Partial<Record<GateId, GateValue>>;
  /** Sites agents may read without asking (app file only, at most 200). Adding one is a loosening. */
  allowedHosts?: string[];
  /** Environment variable names (or NAME* prefixes) that are not scrubbed from agent commands (app file only, at most 50). Adding one is a loosening. */
  envKeep?: string[];
  /** App file only: the owner answered the first-run screen "How should your agents ask?". Not a gate; written only by the core when the owner answers, signed with the rest. */
  firstRunChoice?: true;
  /** App file only: the owner dismissed the one-time notice that projects can now set how agents ask. Not a gate; signed with the rest. */
  noticeSeen?: true;
  version: 1;
}

export const isPreset = (v: unknown): v is Preset => typeof v === 'string' && (PRESETS as readonly string[]).includes(v);

const BY_ID: ReadonlyMap<string, GateDef> = new Map(GATES.map((g) => [g.id, g as GateDef]));

/** The value of one gate for a project. Unknown ids are on; rails are always on; an override beats the project preset, which beats the app preset. */
export function gateValue(id: string, ctx: { project?: GateSettings; app: GateSettings }): GateValue {
  const g = BY_ID.get(id);
  if (!g || g.defaults === 'always') return true;
  const o = ctx.project?.overrides?.[id as GateId];
  if (o !== undefined) return o;
  const preset: Preset = ctx.project?.preset ?? ctx.app.preset ?? 'ask';
  return g.defaults[preset];
}

/** The permission gates (the ones a preset or an override can switch): the only ids a change from the window may name. */
export const PERMISSION_GATE_IDS: readonly string[] = GATES.filter((g) => g.family === 'permission').map((g) => g.id);

/** The permission gates that have a limit (a number), not only on or off: the only ones a limit value may be set on. */
export const LIMIT_GATE_IDS: readonly string[] = GATES.filter((g) => g.family === 'permission' && g.defaults !== 'always' && Object.values(g.defaults).some((v) => typeof v === 'object')).map((g) => g.id);

/** One line per preset: the single copy source for the confirm dialogs and the Gates page. */
export const PRESET_LINES: Record<Preset, string> = {
  ask: 'Every action asks, as now.',
  'accept-edits': 'File edits run. Everything else asks.',
  smart: "Asks before anything that reaches the web, sends data out, deletes, spends, can't be undone, or that Legion can't classify.",
  bypass: `No permission cards, except for a command that changes ${PROTECTED_FILES_TEXT}. Your deny rules and Legion's safety rails still apply. Everything is logged.`,
};

/** Said in every confirm that loosens a preset, and on the Gates page: Legion does not confine the commands it runs. */
export const NO_SANDBOX_LINE = 'Legion has no sandbox for commands on your computer. A command you allow runs with your own rights.';

/** Said in every confirm that loosens: what a loosening never changes. */
export const DENY_LINE = "Your deny rules and Legion's safety rails still apply.";

/** The header main sends with a confirmed loosening: the digest of the settings the owner saw in the dialog. The core refuses the change if what it would apply differs. */
export const GATES_DIGEST_HEADER = 'x-legion-gates-digest';
