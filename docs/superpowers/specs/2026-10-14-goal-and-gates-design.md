# Goals and gates (Legion 0.3.x): design spec

Date 2026-10-14. Revision 3. Revision 2 answered an adversarial review of revision 1 (6 must-fix, 11 should-fix; section 13). Revision 3 makes parallel work, the goal branch and re-approval user options, after research on how established tools run agents in parallel and what their users report (section 3; vault note `goal-research-parallel-agents-2026-10-14.md`). Status: approved by the owner (2026-10-14). Base: `main` at 95b97a2 (0.3.0). Nothing in this spec is built yet. File:line references come from reads at 95b97a2; `~` marks an approximate line.

Sources (the owner's vault, `06-projects/legion/`): `goal-groundwork-2026-10-14.md` (code map), `gate-inventory-2026-10-14.md` (every gate), `goal-research-anthropic-done-2026-10-14.md` (Anthropic: long-running harnesses, building effective agents, agent evals, Claude Code best practices, multi-agent research, prompting guides), `goal-research-reference-and-skills-2026-10-14.md` (a reference agent's goal loop read from its source; the superpowers skill chain), `goal-council-synthesis-2026-10-14.md` (council of four and the owner's decisions).

## 1. Answer first

1. **One registry of gates, three families.** Every place Legion stops, asks, holds, caps or refuses gets an id, a plain description and a setting.
   - **Permission gates** ("may the agent do this?"): approval cards, holds, GitHub write cards, delete cards, update consent, attempt and stall limits, budgets. Fully optional.
   - **QA gates** ("is the result good?"): checks Legion runs itself, evidence, a fresh reviewer. On by default in every preset (kodawari). A goal can turn them down; its result then says plainly that nothing was checked.
   - **Rails** (keep outsiders from steering your agents): injection guard, ceiling, loopback-only server, signed updates, secret scrubbing, web-egress card, shell floor and the rest in 4.5. On in every preset and listed so you can see them. Only the shell floor has an expert switch.
2. **Four presets, named like Claude Code's permission modes:** **Ask** (exactly 0.3.0 behavior, the default), **Accept edits** (file edits run, the rest asks), **Smart** (asks only for actions that leave your computer, delete, spend, can't be undone, or that Legion can't classify; a fixed rule decides, never a model), **Bypass** (no permission cards). As in Claude Code, your own Gates deny rules still apply in Bypass. Rails apply in every preset. Per project, with per-gate overrides.
3. **`/goal`**: you type a goal and 1 to 4 "done when" checks. Legion splits it into board steps, agents work them, Legion runs the checks itself in a clean copy of the repo, and you give the final OK. Two dials per goal:
   - **How much Legion does on its own**: Track only, Suggest steps, Check once then run (default), Run on its own, Full autonomy.
   - **How carefully each step is done**: Quick, Normal, Thorough.
   - **How many steps run at once**: One at a time (default) or Side by side (independent steps, each in its own copy of the repo, up to 3 by default).
   Legion suggests all three from what the goal touches; the suggestion may raise care, never autonomy, and never turns on Side by side by itself.
4. **Never optional, because they never block:** the activity log and a Stop button on every goal and run.
5. **Costs stay optional.** No goal asks for a budget. A new app-wide "Show costs" switch hides every dollar figure.
6. **No `package.json` change.** TypeScript, zod, React and the `git` that running projects already need.

## 2. What exists today (read from the code)

| Piece | State | Where |
|---|---|---|
| Per-agent approval mode `ask` / `auto-edits` / `full`; `full` maps to SDK `bypassPermissions` at run start | Built | `src/shared/types.ts:20`, `src/core/approvals.ts:114` (`needsApproval`), `src/core/engine.ts:1449` (`toolDecider`), `:1596` (mode choice), `:1640` (`canUseTool`) |
| Ceiling: MCP-started or bot-woken runs capped at `ask` | Built | `engine.ts:645`, `:1450` |
| Gates rules (deny / ask / allow), deny survives `full` | Built, global | `src/core/gates.ts`, `engine.ts:1463` |
| Consequence levels (level 3 = leaves, deletes, spends, irreversible, unknown) | Built; `npm`, `pnpm`, `yarn` are level 3 unless the subcommand is listed | `src/shared/consequence.ts:146`, `:193` |
| Shell floor: refuses catastrophic commands; unreadable commands card in ask modes, refused in `full` | Built | `src/core/exec/shell-floor.ts:783`, `:951`; `engine.ts:1405-1441` |
| Protected paths for file tools (Armory, away policy) | Built; file tools only, not Bash | `engine.ts:1259` (`protectedDirs`), `:1574` |
| Tasks carry `projectId` | Built | `src/shared/types.ts:240` |
| Away per project (`<dataDir>/away/`): pause, budget, onSilence, notify | Built | `src/core/away/index.ts:105`, `ui/src/projects/page/SettingsTab.tsx` |
| Marshal: waves of 3, injection guard, verbFit, ledger caps, stall ladder | Built, off by default per project | `src/core/marshal/dispatch.ts:30-45`, `orchestrator.ts:157`, `:263`, `ledger.ts:18-22`, `match.ts:61` |
| Board: owner-only done; a finished run goes to Review (`endRun`); deps read from the sidecar | Built | `src/core/projects/board/store.ts:661`, `:705`, `:781`; `orchestrator.ts:147` |
| Brief (goal, 1-4 done_when) | Built | `src/core/brief.ts:17-34`, zod in `agent-tools.ts:25` |
| Slash commands, client-side | Built | `ui/src/commands.ts` |
| GitHub write card in every mode | Built, pinned by `test/connector-imports.test.ts` | `approvals.ts:57-61`, `connectors/github/write-tools.ts` |
| Shell exec limits, timeout 1-3600 s | Built | `src/core/exec/limits.ts:26`, `:39` |

Missing:

| Gap | Evidence |
|---|---|
| A finished run lands in Review and unblocks nothing; no code runs an item's done-when checks | `store.ts:781-790` (`endRun`), `orchestrator.ts:289` |
| Dependencies count only when the item is Done, which only the owner can set; nothing writes `deps` | `store.ts:310`, `:661`; `deps` is an untyped sidecar extra (`store.ts:167`) |
| Done-when limits disagree: ledger 6, Brief 4; `dispatchPrompt` passes the ledger list on unchecked | `ledger.ts:22`, `brief.ts:34`, `dispatch.ts:42` |
| No goal entity, decomposer, check runner, evidence store or clean worktree | `rg` for goal and worktree in `src` |
| No per-project or per-run permission mode; the mode comes only from the agent | `engine.ts:1451-1454`, `:1596` |
| No single place that knows every gate | gate inventory |
| No activity log product; `src/core/log/` is a runtime logger | `src/core/log/` |
| Dollar figures on about 20 UI surfaces, no switch | `ProjectPage`, `Overview`, `Sheet`, `Digest`, `TaskSwitcher`, `rooms/*`, `HistoryList`, `UsagePopover`, `Composer`, `OpsPanel`, `Settings`, `SpendingSection` |

## 3. Research (what the decisions rest on)

- **Make done a check that runs** ("Give Claude a check it can run", Claude Code best practices). A long-running harness keeps a JSON list where every item starts not passing and agents may only flip that flag (effective harnesses).
- **The worker never grades itself.** Code graders first, then a calibrated model grader, then a human (agent evals). A fresh-context reviewer sees only the diff and the criteria (best practices).
- **Prove the check.** A good check is one two experts judge the same way; a reference solution proves the check works (agent evals). The cheap version here: the check must fail before the work starts.
- **Clean environment per trial;** shared state correlates failures (agent evals).
- **End to end.** Unit tests and curl were not enough; testing "as a human user would" was (effective harnesses).
- **State outside the context:** JSON progress, a log, git checkpoints (prompting guide, harness article).
- **One verifiable item per session;** each brief has an objective, an output format and boundaries (multi-agent research).
- **Fail closed.** A reference agent's goal loop treats a judge error as "continue" and reads only the reply's tail; both are listed as not to copy.
- **Sonnet 5.5 at low effort can claim done without a real check** (Sonnet 5.5 prompting page); worker prompts say a syntax-only check does not count.
- **Parallel work is an option wherever it is offered, never forced.** Claude Code makes worktrees and agent teams opt-in ("start with 3-5"). superpowers runs implementation steps one at a time and allows parallel agents only for independent work, then checks for conflicts and runs the full suite. The reference agent ships worktree isolation off by default. Users report, most often: review overload (people cap at 2 to 4), missing `.env` and dependencies in new worktrees, disk use and stale worktrees (Claude Code issues #27744, #26725), worktrees nobody asked for (#12513; #21236 asks for an off switch), port clashes, cost that multiplies, and parallel work that later conflicts. Cursor advises against symlinking dependencies into worktrees.
- **Permission modes like Claude Code:** default, accept edits, bypass; deny rules apply in every mode. The reference agent adds a "smart" mode where a model approves; Legion takes the idea with its own rule-based risk levels instead of a model (owner decision).

## 4. Gate registry

### 4.1 Contract (`src/shared/gates-registry.ts`, new, written first)

```ts
export type GateFamily = 'permission' | 'qa' | 'rail';
export type Preset = 'ask' | 'accept-edits' | 'smart' | 'bypass';
export type GateValue = boolean | { on: true; limit: number };

export interface GateDef {
  id: GateId;                       // short slug, stable, never reused
  family: GateFamily;
  scope: 'global' | 'project';
  label: string;                    // plain words: "Other programs on your network can't drive Legion"
  protects: string;                 // one sentence: what it stops
  ifOff: string;                    // one sentence: what can happen with it off
  defaults: Record<Preset, GateValue> | 'always';   // rails: 'always'
  expert?: true;                    // only rail-shell-floor
}

export interface GateSettings {     // <dataDir>/gates/<projectId>.json and <dataDir>/gates/app.json
  preset?: Preset;                  // project file: absent = app preset; app file: absent = 'ask'
  overrides?: Partial<Record<GateId, GateValue>>;
  shellFloorOff?: boolean;          // app file only
  version: 1;
}

export function gateValue(id: GateId, ctx: { project?: GateSettings; app: GateSettings }): GateValue;
```

- `gateValue` is pure. Unknown ids are on. A damaged or unreadable file reads as `{ preset: 'ask' }` (fail safe toward 0.3.0 behavior), and the Gates page says the file could not be read.
- Files are written by the core only, through admin routes (tmp-then-rename, as `src/core/projects/board/store.ts:287`). The `gates` folder is added to `protectedPaths()`, so agents' file tools cannot write it. Protected paths do not cover Bash (`engine.ts:1574` says so); the core keeps the last value it wrote in memory and ignores an on-disk change it did not make until the owner reloads it from the Gates page.
- Global gates (`update-consent`, the shell floor) read the app file only.

### 4.2 Effective permission mode for a run

Today a run's mode is the agent's own (`engine.ts:1451`). New, in `src/core/permission-mode.ts` (pure):

```ts
type RunMode = 'ask' | 'auto-edits' | 'smart' | 'full';
export function effectiveMode(a: { agentMode: ApprovalMode; preset: Preset; goalAutonomy?: GoalAutonomy; ceiling: boolean }): RunMode;
```

Rules, in order:
1. `ceiling` (MCP-started or bot-woken run) gives `ask`. Ceiling always wins (it is a rail).
2. A goal at Full autonomy gives `full`.
3. Otherwise the preset loosens the agent's mode and never tightens it, so Ask reproduces 0.3.0:
   - `ask`: the agent's own mode.
   - `accept-edits`: the looser of the agent's mode and `auto-edits`.
   - `smart`: `full` if the agent is `full`, else `smart`.
   - `bypass`: `full`.
4. The run's preset is its project's (`task.projectId`), else the app preset.
5. The mode is chosen once at run start and decides `permissionMode` and `canUseTool` (`engine.ts:1596`, `:1640`). A preset change during a run applies through the existing demotion hook (`engine.ts:~1608`) only when it tightens; a loosening applies from the next run.

New run mode `smart` in `toolDecider`: edits run; other tool calls are classified with `consequence.ts`; level 3 cards; levels 1 and 2 run. An action Legion cannot classify is level 3.

### 4.3 Permission gates and presets

| id | Today (where) | Ask | Accept edits | Smart | Bypass |
|---|---|---|---|---|---|
| `tool-cards` | mode cards (`approvals.ts:114`) | per agent, as today | edits run; the rest asks | level 3 asks | off |
| `github-write-card` | one card per write in every mode (`approvals.ts:57`) | on | on | on (a write leaves your computer) | off |
| `board-delete-card` | `src/core/projects/board/tools.ts:107` | on | on | on | off |
| `module-cards` | browser, Blender, room tools (`approvals.ts:86`) | per agent mode | per agent mode | level 3 asks | off |
| `digest-hold` | 5 s / 10 s hold (`ui/src/projects/hold.ts`) | on | on | on | n/a |
| `ask-timeout-deny` | 10 min, then deny (`approvals.ts:179`) | on | on | on | on (rails' cards only) |
| `on-silence` | deny or park (`away/policy.ts:46`) | project | project | project | project |
| `update-consent` (global) | owner approves updates (`updater/index.ts:88`, `:245`, `:266`) | on | on | on | off: apply when idle |
| `attempt-caps` | 2 per bot, 4 per item (`ledger.ts:18-20`) | 2 / 4 | 2 / 4 | 2 / 4 | 4 / 8 |
| `stall-ladder` | 8 min, 2 stalls (`orchestrator.ts:28`) | on | on | on | on |
| `goal-caps` | new (5.6) | standard | standard | standard | raised |
| `budget-stop` | project budget (`engine.ts:909`) | if set | if set | if set | if set |
| `proposals-inbox` | bot proposals wait (`src/core/projects/board/store.ts:580`) | on | on | on | off: to Backlog |
| `gate-rules-ask` | Gates `ask` rules (`gates.ts`) | on | on | on | off |

- **Bypass means "no permission cards".** Two cards remain because they are rails: the web-egress card (`engine.ts:1381`) and, while the shell floor is on, the unreadable-command rule (refused in Bypass, as `full` does today). Gates deny rules still deny.
- **Smart and `npm`.** Today `npm`, `pnpm` and `yarn` are level 3 unless the subcommand is listed (`consequence.ts:193`), and `node` and `python` are not classified, so Smart would ask for `npm test`. PR 2 adds level 1 rules (local, read and build): `npm|pnpm|yarn test`; `npm|pnpm|yarn run <script>` where the script name is `test`, `build`, `lint`, `typecheck`, `check` or `format`; `npx tsc --noEmit`; `node --test`; `pytest`; `cargo test|build|check`; `go test|build|vet`. Everything else is unchanged. A test lists 40 common commands with their Smart verdict, so the copy matches the rule.
- **Update consent is global.** When off, an update applies only when the app is idle and no goal is running. A running goal holds the update.
- **`github-write-card` off:** the write still passes the gateway's other checks (repo ticked, agent granted, app signed in, argument limits, no destructive verbs offered). `test/connector-imports.test.ts` changes from "always cards" to "cards unless the registry says off", and a new test pins that only `gateValue` can say off.

### 4.4 QA gates

| id | What it does | Quick | Normal | Thorough |
|---|---|---|---|---|
| `qa-harness-check` | Legion runs the step's checks itself in a clean worktree | on | on | on |
| `qa-fail-first` | each command check must fail on the base commit | on | on | on |
| `qa-freeze-checks` | check list and check files hashed; a touched check blocks the step | on | on | on |
| `qa-evidence` | command, exit code, output tail and commit stored per verdict | on | on | on |
| `qa-regression` | the project's test command runs after a step that changed shared code | off | on | on |
| `qa-fresh-reviewer` | a reviewer with the diff and evidence, never the worker's report | sentence checks only | sentence checks only | every step |
| `qa-goal-checks` | the goal's own checks run on the merged result | on | on | on |

QA gates are the same in all four presets. The care level sets which a step gets. A goal can turn them down; the done review then shows "Not checked" in the warning colour for each check that did not run, and the log records it.

### 4.5 Rails

All on in every preset. Settings, Gates lists them with a plain label and what each protects. No switch except the shell floor.

| id | Label (UI) | Where |
|---|---|---|
| `rail-injection-guard` | Text an agent read (a web page, a file, an issue) can't start work | `marshal/match.ts:61`, `orchestrator.ts:167` |
| `rail-ceiling` | An outside app or another bot can't borrow an agent's rights | `engine.ts:645` |
| `rail-mcp-no-connectors` | Runs started by an outside app can't use GitHub | `connectors/gateway.ts` |
| `rail-web-egress-card` | A run that read your GitHub data asks before going to the web | `engine.ts:1381` |
| `rail-loopback` | Other programs on your network can't drive Legion | `net-guard.ts` |
| `rail-signed-updates` | Only updates signed by Legion's release key install | `updater/trust.ts` |
| `rail-secret-scrub` | Secrets are masked in results and messages | `comms/scrub.ts`, `connector-withhold.ts` |
| `rail-root-confine` | File tools stay inside the folders you allowed | `exec/host-tools.ts:213` |
| `rail-protected-paths` | Agents can't edit Legion's own settings, gates or goal records | `engine.ts:1259`, `:1574` |
| `rail-house-trust` | Only house files you adopted load | `house/trust.ts` |
| `rail-browser-url` | The browser can't reach private or reserved addresses | `browser/url-guard.ts` |
| `rail-shell-floor` (expert) | Commands that wipe a drive or a system folder are refused | `exec/shell-floor.ts:783`, `:951` |

The shell floor's expert switch:
- Lives under Settings, Gates, Expert, collapsed. The confirm says: "With this off, an agent can run commands that wipe a drive, a system folder or your home folder. Commands Legion can't read will run in Bypass." A second click on **Turn off**. Logged with the time.
- Off means two things, both named in the confirm: catastrophic commands are no longer refused (`refuseCatastrophic`), and unreadable commands follow the preset like any tool call (card in Ask, Accept edits and Smart; run in Bypass). The code splits the two checks so the switch covers exactly these.
- While it is off, a persistent title-bar marker reads "Shell safety floor off" and opens the Expert section. It never hides.

### 4.6 Never gates, never off

- **Activity log.** `<dataDir>/activity/<yyyy-mm-dd>.jsonl`, append-only, kept 30 days, written by the core. One line per run start and end, card asked and answered, goal state change, check verdict, and gate decision where a switched-off permission gate let an action through ("Would have asked: <action>, because <gate label> is off"). The would-have-asked line is computed only at the existing decision points (`toolDecider`, `guardAsk`, the GitHub gateway, board delete) by evaluating the same rule with the gate on; nothing else is classified. At most 2,000 lines per run; past that, one summary line. The folder is a protected path. The goal strip and the project page link to a filtered view.
- **Stop.** Every goal and run has Stop. Stop cancels the goal's in-flight runs, sets the goal to `stopped`, and never asks to confirm.
- **Done is the owner's.** Agents never set an item or a goal to done. Full autonomy's optional "Accept when every check passes" (5.2) writes done with a new board actor `{ kind: 'owner-standing'; goalId }`, recorded as your standing choice with the evidence attached.

## 5. `/goal`

### 5.1 The flow

1. **Type.** `/goal` or `/goal <text>` in the composer. New `LEGION_COMMANDS` entry `{ name: 'goal', argumentHint: '<what you want done>', needsArg: false }`. With no project open, the card asks for one first. A project that is not a git repository can use Track only; the card says "Goals that run need a git repository. Track only works without one."
2. **One card.** Goal text (up to 300 characters, `GOAL_MAX`). "Done when", 1 to 4 checks; Legion drafts them as commands and labels any sentence "Legion will turn this into yes/no checks". The dials, preset, with one line of reason, for example "Suggested: Check once, then run and Thorough, because this touches sign-in." Buttons **Start** and **Not now**. Enter on Start accepts everything.
3. **Split.** A "Splitting your goal" state, then the steps: title, its checks (the exact commands shown), its care level, "after step 2" for order, and with Side by side the files each step may change. Rows can be edited, removed and reordered. Primary **Approve and run N steps**; secondary **Add to Backlog only**. If the Marshal is off for the project: "This switches on the Marshal for this project. You can switch it off in Settings." The switch happens only on Approve. A later re-split (5.6) shows this card again at Check once, then run, unless you switched off "Approve again when the plan changes" for this goal.
4. **Running.** A goal strip at the top of the project Overview: title, "3 of 5 steps checked", a state word (Running, Waiting for you, Paused, Ready for your review, Stopped), **Pause**, **Stop**, a "Dials" popover and a link to the activity log. Steps appear on the board with a goal tag. No dollars.
5. **Done review.** "Ready for your review". Per check: pass, fail or Not checked; what ran ("ran `npm test`, 212 passed"); expandable output; who judged it ("run by Legion", "judged by a separate reviewer"). Failed checks first. A closing "Still imperfect" list from the reviewer. Buttons **Mark done**, **Send back** (a note that becomes a new step), **Keep open**. With a failing check, Mark done is disabled with the reason; **Mark done anyway** is available and logged.

### 5.2 Autonomy levels

| Level (UI words) | What happens | Remembered per project |
|---|---|---|
| **Track only** | Goal and checks stored. Nothing runs. You can run the checks from the strip. | yes |
| **Suggest steps** | The split lands in the board Inbox as proposals; you start each. | yes |
| **Check once, then run** (default) | One Approve before the first dispatch and before every re-split. You are called for asks, failures, caps and review. The project preset applies to every action. | yes |
| **Run on its own** | No split approval; the split shows in the strip and the log. The project preset applies. Every check must be a command. Extra stops (permission gates, overridable): `goal-scope-stop` (steps grow past 125% of the first split), `goal-protected-path-stop` (a change to check files, CI config or `.git`), `goal-verify-stop` (a second failed verification on one step), `goal-untrusted-stop` (a step fed by untrusted content). | no, per goal |
| **Full autonomy** | As Run on its own, and the goal's runs use mode `full` (4.2 rule 2). Rails and your deny rules still apply. Option "Accept when every check passes" (off by default), offered only when every goal check is a command and care is Thorough. | no, per goal |

### 5.3 Care levels, per step

| Level | What the worker is asked to do | QA gates (4.4) |
|---|---|---|
| **Quick** | Do it, run the checks | harness, fail-first, freeze, evidence |
| **Normal** | Plan first, write the failing test first, then the code | plus regression, reviewer for sentence checks |
| **Thorough** | A short written spec in the step's notes, a plan, test first | plus a reviewer for every step |

The level reaches the worker as a short preamble on its brief: the steps above and "A syntax-only check does not count. Keep working until the checks pass or you can say why they cannot." Agents already have the skills behind these steps (plan, TDD, review, verify); the preamble names them and adds no orchestration.

Browser and packaged-app checks are not in this release (section 12). A UI goal at Thorough gets its end-to-end proof from a command check when the repo has one (for example a Playwright script), and otherwise from a "You decide" check you tick in the done review.

### 5.3b How many steps run at once

| Level (UI words) | What happens | Default |
|---|---|---|
| **One at a time** | Steps run in order on the goal branch, in the project folder. No extra copies. | yes |
| **Side by side** | Steps with no order between them and no shared files run at the same time, each in its own worktree. Up to 3 at once by default; you can set 2 to 5. | no |

- **Never silent.** The first time you pick Side by side, one panel says what happens: "Each step gets its own copy of the repo. Legion copies the files you list, runs your setup command in each copy, merges finished steps one at a time and stops if two steps clash. Tokens are used about as many times faster as the number of steps running." Buttons **Use side by side** and **Keep one at a time**. You can switch it off any time in Settings, Goals.
- **Legion advises One at a time** (a line under the dial, never a block) when: steps share files, a lockfile or a migration; the project has no setup command; the project uses a fixed port with no override; free disk space is under 5 GB.
- **Best of N** (one step tried by 2 or 3 agents, you pick the winner) is out of scope for this release (section 12).

### 5.4 The suggestion

Computed in code, no model call. It never turns on Side by side. Signals: paths the split touches (updater, approvals, gates, connectors, money or data paths give Thorough), the number of steps, whether a test command exists, whether a step changes UI files. The suggestion may raise care; it never raises autonomy. When it differs from what you usually pick: "You usually pick Normal; suggested Thorough because this touches the updater."

### 5.5 Checks

```ts
export type CheckKind = 'command' | 'assert';
export interface Check {
  id: string;
  kind: CheckKind;
  text: string;                     // what you read, and what the worker's brief gets
  command?: string;                 // pass = exit 0, and `expect` if set
  expect?: string;                  // optional output pattern (plain substring)
  asserts?: string[];               // 2-5 yes/no assertions compiled once from a sentence
  by: 'you' | 'legion';             // who wrote it
}
```

- **Where they live.** In the goal record (5.7), not the ledger sidecar (2,000 characters, `store.ts:32`). The step's brief gets the checks' `text` lines (`dispatchPrompt`, `dispatch.ts:42`, still `string[]`).
- **Limits.** 1 to 4 per goal and per step. `MAX_DONE_WHEN` in `ledger.ts` drops from 6 to 4 and imports `DONE_WHEN_MAX` from `brief.ts`, so the two cannot drift. Ledger entries with 5 or 6 checks still read; new writes are capped at 4; the board route's message changes to 4.
- **Compile once.** A sentence becomes 2 to 5 yes/no assertions in the same model call as the split. A sentence that cannot be compiled comes back to you for rewording; Start waits.
- **Lint.** Refused: an empty command; `true`, `exit 0`, `echo`, `:`, `rem`; a command whose only effect is printing; a test file with no assertion; a sentence made only of words like "works", "good", "clean", "done". The card says which check and why.
- **Command shapes.** A check command Legion wrote must match an allowed shape: the project's own scripts (`npm|pnpm|yarn test`, `npm|pnpm|yarn run <script>` for scripts in `package.json`), `npx tsc --noEmit`, `node --test <path>`, `pytest`, `cargo test|check`, `go test|vet`, `git diff --exit-code -- <path>`. Commands you wrote yourself are not shape-checked. At Check once, then run, every command is shown on the Approve card.
- **How Legion runs a check.** Through the same path as an agent's shell call, so the shell floor and your Gates deny rules apply. The cwd is the clean worktree (5.8); the environment has no Legion tokens or keys; no network unless the check is yours and says so; the timeout comes from the exec limits (`limits.ts:26`, 120 s by default; a check may set up to 1,800 s).
- **Fail first.** Before the first dispatch, each command check runs on the base commit. A check that passes before any work is flagged ("This check already passes, so it proves nothing") and the step waits for you, unless `qa-fail-first` is off for this goal.
- **Verdict.** When a step's run ends, the step is in Review (`endRun`, unchanged). Legion records the commit, creates a clean worktree at it and runs the step's checks. The harness and, where the care level asks for one, the reviewer must both pass. A fail followed by a pass on one retry is labelled flaky and counts as one of the step's verification rounds. A pass needs evidence.
- **Reviewer.** A fresh run with a read-only prompt. Input: the check, the diff, the evidence. Not the worker's summary. Output: one JSON line `{ "pass": boolean, "reason": string, "imperfect": string[] }`. An error or an unparseable reply means not verified. Three unparseable replies pause the step.
- **Frozen.** The check list and the files the checks name are hashed at Approve (or at start for Run on its own). The core keeps the hash in memory and in the goal record. A mismatch with memory, or a diff touching those files, blocks the step unless the step says it may change them.

### 5.6 Goal caps (permission gate `goal-caps`)

| Cap | standard | raised (Bypass) | At the cap |
|---|---|---|---|
| Steps per goal | 12 | 24 | pause |
| Re-splits per goal | 3 | 6 | pause |
| Dispatches per goal | 4 per step | 8 per step | pause |
| Verification rounds per step | 3 | 5 | pause |

A pause has a plain reason and **Resume**. Resume resets the goal counters, not the ledger's per-item attempts. If the board's 200-item limit (`BOARD_LIMITS.itemsPerProject`, `src/shared/board.ts:~57`) would be passed, the split is refused with that reason before anything is created.

### 5.7 Data

- Goal records: `<dataDir>/goals/<projectId>.json`, one file per project, tmp-then-rename.
- Evidence: `<dataDir>/goals/<projectId>/<goalId>/evidence/<checkId>-<n>.json` (command, exit code, last 4 KB of scrubbed output, commit).
- Both are protected paths, written only by the core.

```ts
export type GoalAutonomy = 'track' | 'suggest' | 'check-once' | 'own' | 'full';
export interface Goal {
  id: string; projectId: string; text: string;
  autonomy: GoalAutonomy;
  care: 'quick' | 'normal' | 'thorough';      // default for its steps; each step can differ
  acceptWhenGreen?: boolean;                   // Full autonomy only (5.2)
  parallel: { mode: 'one' | 'side-by-side'; max: 2 | 3 | 4 | 5 };
  goalBranch: boolean;                         // "Work on a goal branch", default true
  reapproveOnResplit: boolean;                 // default true at Check once, then run
  qaOff?: QaGateId[];                          // QA gates you turned down for this goal
  status: 'draft' | 'splitting' | 'awaiting-approval' | 'running' | 'paused' | 'review' | 'done' | 'stopped';
  pauseReason?: 'cap' | 'conflict' | 'blocked' | 'check-broken' | 'reviewer-unparseable' | 'scope' | 'protected-path' | 'verify-failed' | 'untrusted' | 'restart' | 'board-full';
  checks: Check[];                             // goal level, 1..4
  steps: { itemId: string; care: Goal['care']; checks: Check[]; after: string[]; files?: string[]; worktree?: string; merged?: { commit: string; at: string }; checked?: { commit: string; at: string } }[];
  checksHash: string;
  baseCommit: string;
  branch: string;                              // legion/goal/<id>
  counters: { splits: number; dispatches: number };
  verdicts: { checkId: string; itemId?: string; at: string; result: 'pass' | 'fail' | 'flaky' | 'not-verified' | 'not-checked'; evidence?: string; by: 'harness' | 'reviewer' | 'you' }[];
  rulings: { at: string; text: string }[];     // decisions taken without asking
  marshalSwitchedOnByGoal?: boolean;
  version: number; createdAt: string; updatedAt: string;
}
```

**Restart.** On start, a goal in `running` whose steps have no live run moves to `paused` with reason `restart`. Nothing restarts by itself.

### 5.8 Running steps: branch, worktrees, order

- **Branch (option "Work on a goal branch", on by default).** On: a goal works on `legion/goal/<id>`, created from the project's current commit (`baseCommit`) at Approve. Off: the goal works on the branch you are on; Legion still records `baseCommit` for fail-first and the checks.
- **One at a time.** Steps run in the project folder on the goal branch; the goal sets its own wave size to 1.
- **Side by side.** Each running step gets a worktree at `<dataDir>/goals/wt/<goalId>-<step>` on branch `legion/goal/<id>/<step>`, created from the goal branch's current HEAD (never from the default branch, which would drop your unpushed work). The goal sets its wave size to the chosen number (2 to 5).
  - **Environment per worktree** (Settings, Goals, per project): a list of gitignored files to copy (default `.env*`); a setup command (default: the project's install command when Legion can tell it, for example `npm ci`); "Link dependency folders instead of installing" (off by default; its warning says it can break monorepos); a free port per worktree, passed as `LEGION_PORT`.
  - **File ownership.** The split lists the files each step may change. Steps whose lists overlap never run side by side; they get an order. A step that changes a file outside its list pauses with reason `scope`.
  - **Merge.** A step that passed its checks is merged into the goal branch, one at a time, in plan order. After each merge Legion runs the goal's regression command. A merge conflict pauses that step with reason `conflict` and asks you; Legion never resolves a conflict by itself.
  - **Review.** Finished steps reach you one at a time, never all at once.
  - **Cleanup.** A worktree is removed when its step is merged, or when it is clean with no commits. Otherwise it is kept and listed (count and size) in Settings, Goals with **Remove**. Stale worktree locks are swept at start.
- **Commits.** The worker's brief says to commit its work. After the run, Legion records `HEAD`. A run that left uncommitted changes gets one commit by Legion ("goal <id>: step <n>, uncommitted work") so the checks see exactly what the worker produced.
- **Clean worktree for checks** (both levels). `src/core/goals/worktree.ts` (new): `git worktree add --detach <dataDir>/goals/wt/<goalId>-<n> <commit>`, run the checks there, remove the worktree after the verdict. The project's install folders (`node_modules`) are linked read-only when present, so test commands work without a fresh install.
- **Order (dependencies).** A step waits for its `after` steps to be **checked**: in Review, with every check passed and recorded in `steps[].checked`. For goal steps, the Marshal context's `isDone` (`orchestrator.ts:147`) reads "done, or checked by its goal". Only the goal service writes `checked`, and only after a pass with evidence. Done stays the owner's.
- **Who creates steps.** The goal service, as a new board actor `{ kind: 'goal'; goalId }`. It is not an agent: bot rate limits (`botCreatesPerWindow` 10) do not apply; the goal caps and the board's 200-item limit do. Steps carry `labels: ['goal:<id>']` and get `trust: 'human'` only after your Approve (Check once) or at start (Run on its own, Full autonomy). An agent's edit to a step's text resets trust, as today (`tools.ts:93`).
- **Merge.** When the goal is done, Legion offers to merge `legion/goal/<id>` into the branch it started from. It never pushes. Pushing stays yours.

### 5.9 The split

- One model call, using the Marshal matcher's calling pattern (`marshal/matcher.ts:64`, `engineMatcher`). Input: the goal text, its checks, the project's file tree (paths only, at most 2,000 entries), the bots and their roles, and the project's `package.json` script names. Paths and script names are untrusted data: they are quoted as data in the prompt, never as instructions, and the output passes the injection guard rail.
- Output validated with zod: 1 to 12 steps (24 at raised caps), titles up to 120 characters, 1 to 4 checks each, a care level, `after` ids; cycles are refused in code.

### 5.10 What reaches you

| Event | Track | Suggest | Check once | Run on its own / Full |
|---|---|---|---|---|
| Split ready | | Inbox | the Approve card | log and strip |
| A step asks or questions | | ask card | ask card | ask card, unless the preset has no cards |
| A step fails twice or stalls | | digest row | desktop signal | desktop signal |
| A step passes | quiet | quiet | quiet | quiet |
| A cap or a stop | | | desktop signal | desktop signal |
| Ready for your review | optional | desktop signal | desktop signal | desktop signal, or closed by itself if Accept when green is on |

The project's notify level (problems, everything, nothing) still governs desktop signals. Failures, caps and review count as problems.

### 5.11 Settings, Goals (new section)

Switches: **Use goals**, **Allow side by side** (off hides the option), **Work on a goal branch** (the default for new goals), **Approve again when the plan changes**, the per-project worktree environment (5.8), (off hides `/goal` and the strip; existing goals stay readable), **Show the goal card when I type /goal** (off: the command uses the remembered dials), **Suggest dials**, **Let goals switch the Marshal on**, **Show goal progress on the project page**. These switches change behavior, not gates; gates are in Settings, Gates.

## 6. Settings, Gates (extended page)

- Top: a preset picker for the app default and per project, one line each: "Every action asks, as now" (Ask); "File edits run; everything else asks" (Accept edits); "Asks for anything that leaves your computer, deletes, spends, can't be undone, or that Legion can't classify" (Smart); "No permission cards. Your deny rules and Legion's safety rails still apply. Everything is logged." (Bypass).
- Below, three groups: permission gates (value per project, override switch); QA gates (what each care level includes); rails (label and what each protects; only the shell floor has a switch, under Expert, collapsed).
- The existing Gates rules (deny, ask, allow) stay on this page.
- Copy: no em dashes. The existing em dashes in `ui/src/gates/GatesSection.tsx` and `MarshalPanel.tsx` are replaced in PR 2, and a test fails on an em dash in any UI string under `ui/src/gates/` and `ui/src/goals/`.

## 7. Show costs (new switch)

Settings, Spending: **Show costs** (on by default). Off hides every dollar figure on every surface in section 2, hides the budget sections and makes budgets inactive (`budget-stop` reads it). Usage is still recorded, so turning it back on shows the full history. One UI hook, `useShowCosts()`; every component that formats money reads it. A test lists every component that formats money and fails if one does not read the hook.

## 8. Security

- **Bypass and Full autonomy act without asking.** The rails stay on (only the shell floor can be switched off); Gates deny rules apply; every would-have-asked is logged; Stop is always there; caps pause runaway work; GitHub still never offers merge, push, delete or branch to agents.
- **Check commands are a new execution path.** They pass the shell floor and deny rules, run in a clean worktree without tokens, have a timeout and, when Legion wrote them, must match an allowed shape. At Check once, then run, you see every command before anything runs.
- **The split as an injection path.** The inputs are your text plus paths and script names quoted as data; the output passes the injection guard; steps are capped; at Check once, then run, you approve the split.
- **Gamed checks.** Lint, allowed shapes, fail-first, a freeze hash kept in memory, harness-run checks in a clean worktree, evidence required, a reviewer without the worker's report, fail-closed grading.
- **Agents editing goal or gate data.** The `goals`, `gates` and `activity` folders are protected paths for file tools; the core trusts its in-memory copy over the disk and ignores changes it did not make; settings change only through admin routes, and a test pins that no agent tool reaches them.
- **Accept when green.** Offered only when every check is a command and care is Thorough; done is written by the `owner-standing` actor and logged.

## 9. Tests that must exist

1. **Ask parity (golden).** Before the refactor, a script generates a fixture from today's functions (`needsApproval`, `guardAsk`, `toolDecider`, the GitHub gateway's card decision, board delete) over these inputs: agent mode × tool class × consequence level × ceiling × tainted × gate verdict. After the refactor, preset Ask must reproduce the fixture exactly. The fixture is committed.
2. **`effectiveMode`:** every rule in 4.2, including ceiling over Full autonomy and loosening only.
3. **Each preset:** Accept edits runs edits and cards the rest; Smart cards exactly level 3, and the 40-command list gives the documented verdicts; Bypass cards nothing except the rails' cards; deny rules deny in Bypass; a damaged gates file reads as Ask; a gates file changed on disk by something other than the core is ignored until reloaded.
4. **GitHub:** with `github-write-card` off, a write goes through without a card and still fails on an unticked repo, an ungranted agent or an oversized argument; only `gateValue` can turn the card off.
5. **Rails:** every rail is on in every preset and has no switch, except the shell floor; its switch turns off exactly the two checks named in 4.5, shows the marker and is logged.
6. **Activity log:** a would-have-asked line for each action a switched-off permission gate let through; the per-run cap and its summary line.
7. **Checks:** lint refuses each trivial form; shapes refuse a Legion-written command outside the list; check commands pass the shell floor and deny rules; fail-first flags a check that passes on the base commit; a touched check file blocks the step; the harness runs in a clean worktree at the recorded commit; flaky counts as a round; a reviewer error or unparseable reply means not verified; three unparseable replies pause.
8. **Order:** a step whose `after` step is checked dispatches; one whose `after` step is only in Review (not checked) does not; only the goal service writes `checked`.
9. **Goal:** split validation (1 to 12 steps, no cycles, 1 to 4 checks each); the board's 200-item refusal; caps pause with the right reason; restart pauses running goals; agents cannot set a goal or step done; `owner-standing` writes done only when every check passed with evidence and the goal met the Accept when green conditions.
10. **Side by side:** steps with overlapping files are ordered, never parallel; a worktree starts from the goal branch HEAD; listed files are copied and the setup command runs; each worktree gets its own `LEGION_PORT`; merges happen one at a time in plan order with the regression command after each; a conflict pauses with reason `conflict`; a worktree is removed only when merged or clean with no commits; stale locks are swept at start; the first-use panel appears once and can be declined.
11. **Limits:** `MAX_DONE_WHEN` and `DONE_WHEN_MAX` are one constant; old ledger entries with 5 or 6 checks still read.
12. **Show costs:** off hides every money component (component list test); budgets are inactive; usage is still recorded.
13. **Copy:** no em dash in UI strings under `ui/src/gates/` and `ui/src/goals/`.
14. **End to end (kodawari, hands-on).** In the packaged app on a scratch git project: `/goal` at each autonomy level; One at a time and Side by side with 3 steps; one forced merge conflict; a step that fails; a check that passes before work; Stop mid-run; restart mid-goal; dark and light; a 300-character goal; an empty project. Screenshots read at full size; the activity log and the app logs read after every run.

## 10. Delivery (each its own PR)

| PR | Content | Merge gate |
|---|---|---|
| 1 | Registry contract, gates files and routes, `gateValue`, `effectiveMode` with Ask only, Ask parity fixture | tests 1, 2 |
| 2 | Accept edits, Smart (with the consequence rules), Bypass; overrides; the Settings, Gates page; rails list and the shell floor switch; activity log | tests 3-6, 13, hands-on |
| 3 | Goal core: record, store, split, checks (lint, shapes, fail-first, freeze, worktree, harness, reviewer), order, caps, restart, the `goal` and `owner-standing` actors, the goal branch option | tests 7-9, 11 |
| 3b | Side by side: worktree per step, environment, file ownership, merge in order, conflict pause, cleanup | test 10 |
| 4 | Goal UI: command, card, split review, strip, done review, Settings, Goals | test 14 |
| 5 | Show costs | test 12 |

**Dogfood.** PR 5 is built with `/goal` once PRs 3 and 4 are in, at Check once, then run and Normal care. What goes wrong feeds a follow-up list.

0.3.1 (dependency update, #96) ships separately and first.

## 11. Decisions taken (owner, 2026-10-14)

1. Presets named like Claude Code's permission modes, plus Smart: Ask, Accept edits, Smart, Bypass. Smart is a rule over Legion's risk levels, never a model.
2. Rails: on in every preset and listed; only the shell floor has an expert switch.
3. Full autonomy may close a goal by itself when every check passes: optional per goal, off by default.
4. Similarity to how Claude Code and the reference agent solve this is wanted; the reference agent is never named in code, comments, the changelog or PRs.

5. First run offers the choice of preset: one screen with Ask, Accept edits, Smart and Bypass, Ask preselected, each with its one line from section 6. Enter keeps Ask. Changeable later in Settings, Gates. Built in PR 2.

Status: approved by the owner on 2026-10-14 (revision 3).

## 12. Out of scope for this release

Browser and packaged-app checks run by Legion (a `flow` check kind), Best of N (one step tried by several agents or models), `/subgoal` (adding checks mid-run), calibrating the reviewer against your verdicts, wait states (on a process or a timer), goal templates, dependencies between goals, a per-goal budget, pushing a goal branch.

## 13. Changes from revision 1 (adversarial review, 2026-10-14)

| Finding | Change |
|---|---|
| Steps after another step could never run (deps need Done, only the owner sets Done, nothing writes deps) | A "checked" state written by the goal service satisfies order (5.8); steps carry `after` in the goal record |
| No clean worktree existed | Goal branch, serial steps, `goals/worktree.ts` for checks (5.8) |
| Check commands ran ungated | Shell floor, deny rules, clean worktree, no tokens, timeout, allowed shapes, shown on Approve (5.5) |
| No per-run preset | `effectiveMode` (4.2): ceiling first, then Full autonomy, presets loosen only, chosen at run start |
| No settings file or activity log | `<dataDir>/gates/*.json` (4.1); `<dataDir>/activity/*.jsonl` with scope and cap (4.6) |
| Smart would ask for `npm test` | New level 1 rules for test and build commands, a 40-command test, honest copy (4.3, 6) |
| Wrong paths and update consent lines | `src/core/projects/board/...`; `updater/index.ts:88`, `:245`, `:266` |
| Update consent was per project | Global; waits while a goal runs (4.3) |
| "No cards at all" in Bypass was false | "No permission cards"; the web-egress and unreadable-command rules are named (4.3) |
| Contract types | `defaults: Record<Preset, GateValue> \| 'always'`, numbers for caps (4.1) |
| Shell floor off was unspecified | Both checks named; behavior per preset (4.5) |
| Goal data editable by agents | `goals`, `gates` and `activity` are protected paths; the core trusts memory (4.1, 5.5, 8) |
| Steps vs board rate limits | New `goal` actor; the caps and the 200-item limit apply (5.6, 5.8) |
| Checks didn't fit the ledger | Checks in the goal record; the brief gets `text` lines; one done-when constant (5.5) |
| UI and browser checks undefined | `flow` cut from this release; "You decide" checks and command scripts instead (5.3, 12) |
| Accept when green vs owner-only done | The `owner-standing` actor, offered only with command checks at Thorough (4.6, 5.2) |
| (revision 3) Parallel steps were cut as out of scope | Side by side is a user option (5.3b, 5.8), designed from Claude Code, superpowers, the reference agent, Conductor, Cursor and users' reported problems |
| (revision 3) The goal branch and re-approval were fixed behavior | Both are options with defaults (5.1, 5.8) |
| Ambiguities | Approve before every re-split; harness and reviewer must both pass; flaky counts as a round; no-project runs use the app preset; presets sit on top of agent modes and only loosen; Stop cancels in-flight runs |
| Copy | Plain rail labels; an em-dash test for new UI strings |
| Golden test under-specified | A fixture generated from today's functions over named inputs (9.1) |
