# Gate registry, part 1 (Ask parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the gate registry, the per-project gate settings store and routes, and a single permission-mode resolver, with preset Ask only, so that nothing an agent can or cannot do changes and a committed golden fixture proves it.

**Architecture:** A pure shared contract (`src/shared/gates-registry.ts`) lists every gate with its family and per-preset default. A pure function (`src/core/permission-mode.ts`) turns an agent's mode plus a preset into the run's mode. A small core module (`src/core/gates-settings/`) keeps the owner's preset choices in memory, persists them under `<dataDir>/gates/` like the away store does, and serves admin-only routes. The engine's three mode reads go through one resolver. In this PR the store accepts only `ask`; Accept edits, Smart and Bypass arrive in part 2.

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes), Node's `node:test` and `node:assert/strict`, the existing core module and route system.

**Spec:** `docs/superpowers/specs/2026-10-14-goal-and-gates-design.md` (revision 3, approved). This plan covers spec section 10, PR 1: sections 4.1, 4.2 (rules 1, 4, 5; the `ask` preset), and test 9.1 and 9.2.

## Global Constraints

- No `package.json` or `package-lock.json` change.
- Preset Ask reproduces 0.3.0 exactly (spec 4.3, "Ask reproduces 0.3.0 exactly").
- A damaged or unreadable gates file reads as `{ preset: 'ask' }` (spec 4.1).
- Gates files are written only by the core through admin routes, tmp-then-rename; the `gates` folder is a protected path (spec 4.1).
- Routes are admin-only by the default-deny gate: a bearer token gets 403, nobody gets 401, none is a client route (pattern: `test/away-routes.test.ts`).
- Ceiling always wins over any preset (spec 4.2 rule 1).
- Commits carry no Co-Authored-By or Claude trailer. Never name the reference agent in code, comments or commit messages.
- Copy rules for any string a person can read: plain words, no em dashes.
- Shell: `rg`, `fd`, `sd` instead of grep, find, sed.
- Test one file: `npm run build:ts && node --test dist/test/<name>.test.js`. Full suite only in CI.

## Review Focus

1. **An agent promoted or demoted mid-run.** Today `effective()` re-reads the store on every call (`engine.ts:1451`). The resolver must keep re-reading on every call, not snapshot at run start. Pinned in Task 5 (test "resolver re-reads the agent's mode on every call").
2. **A task with no project.** The resolver must fall back to the app preset, not throw. Pinned in Task 5.
3. **A gates file a person or a shell edited into nonsense** (wrong JSON, unknown preset, unknown gate ids, a huge file). It must read as Ask, keep the bad file aside, and never throw at start. Pinned in Task 3.
4. **A project deleted while its gates file remains.** `prune` removes it at start, as the away store does. Pinned in Task 3.
5. **A PATCH asking for `bypass` in this PR.** Refused with 400 and a plain reason, so a UI or script built ahead of part 2 cannot loosen anything. Pinned in Task 4.

---

## File structure

| File | Responsibility |
|---|---|
| `src/shared/gates-registry.ts` (new) | Types `Preset`, `GateFamily`, `GateValue`, `GateDef`, `GateSettings`; the `GATES` list; pure `gateValue()` |
| `src/core/permission-mode.ts` (new) | Pure `effectiveMode()` |
| `src/core/gates-settings/store.ts` (new) | `GatesStore`: in-memory settings, load with validation, debounced tmp-then-rename writes, prune |
| `src/core/gates-settings/index.ts` (new) | `createGatesCore()`, `createGatesModule()`: routes, `protectedPaths`, `ModeResolver` |
| `src/core/engine.ts` (modify ~1426, ~1452, ~1591) | Read the mode through `EngineDeps.modes` when present |
| `src/bin/legion-core.ts` (modify ~97-160) | Build the gates core before the engine, pass the resolver, add the module |
| `scripts/dev/gen-gate-parity.mjs` (new) | Writes the golden fixture from today's functions |
| `test/fixtures/gate-parity-0.3.0.json` (new, generated) | The 0.3.0 decision table |
| `test/gates-registry.test.ts`, `test/permission-mode.test.ts`, `test/gates-store.test.ts`, `test/gates-routes.test.ts`, `test/gate-parity.test.ts` (new) | Tests |

---

### Task 1: The registry contract

**Files:**
- Create: `src/shared/gates-registry.ts`
- Test: `test/gates-registry.test.ts`

**Interfaces:**
- Produces: `type Preset = 'ask' | 'accept-edits' | 'smart' | 'bypass'`; `PRESETS: readonly Preset[]`; `type GateFamily = 'permission' | 'qa' | 'rail'`; `type GateValue = boolean | { on: true; limit: number }`; `interface GateDef`; `GATES: readonly GateDef[]`; `type GateId`; `interface GateSettings { preset?: Preset; overrides?: Partial<Record<GateId, GateValue>>; shellFloorOff?: boolean; version: 1 }`; `function gateValue(id: string, ctx: { project?: GateSettings; app: GateSettings }): GateValue`; `function isPreset(v: unknown): v is Preset`.

- [ ] **Step 1: Write the failing test**

```ts
// test/gates-registry.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATES, PRESETS, gateValue, isPreset } from '../src/shared/gates-registry.js';
import type { GateSettings } from '../src/shared/gates-registry.js';

const app: GateSettings = { version: 1 };

test('every gate has a unique id, a family, plain copy and a value for every preset', () => {
  const ids = new Set<string>();
  for (const g of GATES) {
    assert.ok(!ids.has(g.id), `duplicate ${g.id}`); ids.add(g.id);
    assert.ok(['permission', 'qa', 'rail'].includes(g.family));
    for (const s of [g.label, g.protects, g.ifOff]) { assert.ok(s.length > 0); assert.ok(!s.includes('—'), `em dash in ${g.id}`); }
    if (g.family === 'rail') assert.equal(g.defaults, 'always', `${g.id} is a rail`);
    else for (const p of PRESETS) assert.ok(typeof g.defaults === 'object' && p in g.defaults, `${g.id} lacks ${p}`);
  }
});

test('only the shell floor is an expert switch', () => {
  assert.deepEqual(GATES.filter((g) => g.expert).map((g) => g.id), ['rail-shell-floor']);
});

test('an unknown gate id is on', () => {
  assert.equal(gateValue('no-such-gate', { app }), true);
});

test('rails are on whatever the preset or overrides say', () => {
  const project: GateSettings = { version: 1, preset: 'bypass', overrides: { 'rail-ceiling': false } as never };
  assert.equal(gateValue('rail-ceiling', { app, project }), true);
});

test('the project preset beats the app preset; an override beats both', () => {
  const appBypass: GateSettings = { version: 1, preset: 'bypass' };
  assert.equal(gateValue('github-write-card', { app: appBypass }), false);
  assert.equal(gateValue('github-write-card', { app: appBypass, project: { version: 1, preset: 'ask' } }), true);
  assert.equal(gateValue('github-write-card', { app, project: { version: 1, overrides: { 'github-write-card': false } } }), false);
});

test('Ask keeps every permission gate as 0.3.0 has it', () => {
  for (const g of GATES.filter((x) => x.family === 'permission')) {
    const v = gateValue(g.id, { app });
    assert.notEqual(v, false, `${g.id} is off in Ask`);
  }
});

test('isPreset accepts the four names and nothing else', () => {
  for (const p of PRESETS) assert.equal(isPreset(p), true);
  for (const v of ['', 'full', 'Ask', null, 3]) assert.equal(isPreset(v), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:ts && node --test dist/test/gates-registry.test.js`
Expected: the build fails with "Cannot find module '../src/shared/gates-registry.js'".

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/gates-registry.ts
/**
 * Every gate Legion has, in one list: what it protects, what can happen with it off, and its value under each preset
 * (spec docs/superpowers/specs/2026-10-14-goal-and-gates-design.md, section 4). Pure: no I/O, safe in the window and the core.
 * Permission gates follow the preset; QA gates follow a goal's care level (part 3); rails are always on, and only the shell
 * floor has a switch (an expert one, read from the app settings, not from here).
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
  expert?: true;
}

const all = (v: GateValue, bypass: GateValue = v): Record<Preset, GateValue> => ({ ask: v, 'accept-edits': v, smart: v, bypass });

export const GATES = [
  { id: 'tool-cards', family: 'permission', scope: 'project', label: 'Ask before tools run', protects: 'An agent runs a command or changes files only after you say yes, as its own setting says.', ifOff: 'Agents run commands and change files without asking.', defaults: all(true, false) },
  { id: 'github-write-card', family: 'permission', scope: 'project', label: 'Ask before every GitHub write', protects: 'Every issue, comment, pull request, review or CI action an agent sends to GitHub waits for your yes.', ifOff: 'Agents write to GitHub without asking. Merge, push and delete are still never offered to them.', defaults: all(true, false) },
  { id: 'board-delete-card', family: 'permission', scope: 'project', label: 'Ask before a board item is deleted', protects: 'An agent deletes a board item only after you say yes.', ifOff: 'The lead agent deletes board items without asking.', defaults: all(true, false) },
  { id: 'module-cards', family: 'permission', scope: 'project', label: 'Ask before browser, Blender and room actions', protects: 'The browser, Blender and room tools ask before they act, as the agent setting says.', ifOff: 'These tools act without asking.', defaults: all(true, false) },
  { id: 'digest-hold', family: 'permission', scope: 'project', label: 'A few seconds to take back an Allow', protects: 'An Allow on the project page waits 5 or 10 seconds with Undo.', ifOff: 'An Allow is sent at once.', defaults: all(true, false) },
  { id: 'ask-timeout-deny', family: 'permission', scope: 'project', label: 'No answer means no', protects: 'A card nobody answers is refused after 10 minutes.', ifOff: 'Not used: without this, an unanswered card would wait forever.', defaults: all(true) },
  { id: 'update-consent', family: 'permission', scope: 'global', label: 'Ask before an update installs', protects: 'An update installs only after you say yes.', ifOff: 'Updates install by themselves when Legion is idle and no goal is running.', defaults: all(true, false) },
  { id: 'attempt-caps', family: 'permission', scope: 'project', label: 'Limit retries on one item', protects: 'An item is tried at most twice per agent and four times in all.', ifOff: 'An item can be retried without limit.', defaults: all({ on: true, limit: 4 }, { on: true, limit: 8 }) },
  { id: 'stall-ladder', family: 'permission', scope: 'project', label: 'Stop runs that stall', protects: 'A run with no progress for 8 minutes is stopped; after two stalls the item waits for you.', ifOff: 'A stalled run keeps going.', defaults: all(true) },
  { id: 'goal-caps', family: 'permission', scope: 'project', label: 'Limit the size of a goal', protects: 'A goal pauses at 12 steps, 3 re-splits, 4 dispatches per step or 3 checks per step.', ifOff: 'A goal can grow without limit.', defaults: all({ on: true, limit: 12 }, { on: true, limit: 24 }) },
  { id: 'budget-stop', family: 'permission', scope: 'project', label: 'Stop at the budget', protects: 'When a budget you set is reached, new runs wait.', ifOff: 'Runs start even past the budget.', defaults: all(true) },
  { id: 'proposals-inbox', family: 'permission', scope: 'project', label: 'Agent proposals wait in the Inbox', protects: 'Work an agent proposes waits until you accept it.', ifOff: 'Proposals go straight to the Backlog.', defaults: all(true, false) },
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
  { id: 'rail-protected-paths', family: 'rail', scope: 'global', label: 'Agents cannot edit Legion own settings', protects: 'Gates, goals and the Armory are changed by you only.', ifOff: '', defaults: 'always' },
  { id: 'rail-house-trust', family: 'rail', scope: 'global', label: 'Only house files you adopted load', protects: 'A changed house file is not loaded until you adopt it.', ifOff: '', defaults: 'always' },
  { id: 'rail-browser-url', family: 'rail', scope: 'global', label: 'The browser stays on the open web', protects: 'The browser cannot reach private or reserved addresses.', ifOff: '', defaults: 'always' },
  { id: 'rail-shell-floor', family: 'rail', scope: 'global', label: 'Commands that wipe a drive are refused', protects: 'Commands that wipe a drive, a system folder or your home folder never run.', ifOff: 'An agent can run commands that wipe a drive, a system folder or your home folder. Commands Legion cannot read will run in Bypass.', defaults: 'always', expert: true },
] as const satisfies readonly GateDef[];

export type GateId = (typeof GATES)[number]['id'];

export interface GateSettings {
  preset?: Preset;
  overrides?: Partial<Record<GateId, GateValue>>;
  shellFloorOff?: boolean;
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
```

Note on copy: labels avoid apostrophes on purpose in this file only where a possessive reads badly without one; the UI copy pass in part 2 may restore "Legion's". Keep every string free of em dashes (the test checks).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:ts && node --test dist/test/gates-registry.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/gates-registry.ts test/gates-registry.test.ts
git commit -m "gates: the registry contract (every gate, its family and its preset values)"
```

---

### Task 2: `effectiveMode`

**Files:**
- Create: `src/core/permission-mode.ts`
- Test: `test/permission-mode.test.ts`

**Interfaces:**
- Consumes: `Preset` (Task 1); `ApprovalMode` from `src/shared/types.ts:20`.
- Produces: `type RunMode = ApprovalMode | 'smart'`; `type GoalAutonomy = 'track' | 'suggest' | 'check-once' | 'own' | 'full'`; `function effectiveMode(a: { agentMode: ApprovalMode; preset: Preset; goalAutonomy?: GoalAutonomy; ceiling?: ApprovalMode }): RunMode`.

- [ ] **Step 1: Write the failing test**

```ts
// test/permission-mode.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMode } from '../src/core/permission-mode.js';
import type { ApprovalMode } from '../src/shared/types.js';

const MODES: ApprovalMode[] = ['ask', 'auto-edits', 'full'];

test('Ask returns the agent own mode for every mode', () => {
  for (const m of MODES) assert.equal(effectiveMode({ agentMode: m, preset: 'ask' }), m);
});

test('a ceiling wins over everything, Full autonomy included', () => {
  for (const m of MODES) {
    assert.equal(effectiveMode({ agentMode: m, preset: 'bypass', ceiling: 'ask' }), 'ask');
    assert.equal(effectiveMode({ agentMode: m, preset: 'ask', goalAutonomy: 'full', ceiling: 'ask' }), 'ask');
  }
});

test('a ceiling looser than the agent mode does not loosen it', () => {
  assert.equal(effectiveMode({ agentMode: 'ask', preset: 'ask', ceiling: 'full' }), 'ask');
});

test('Full autonomy gives full', () => {
  for (const m of MODES) assert.equal(effectiveMode({ agentMode: m, preset: 'ask', goalAutonomy: 'full' }), 'full');
});

test('presets loosen and never tighten', () => {
  assert.equal(effectiveMode({ agentMode: 'ask', preset: 'accept-edits' }), 'auto-edits');
  assert.equal(effectiveMode({ agentMode: 'full', preset: 'accept-edits' }), 'full');
  assert.equal(effectiveMode({ agentMode: 'ask', preset: 'smart' }), 'smart');
  assert.equal(effectiveMode({ agentMode: 'auto-edits', preset: 'smart' }), 'smart');
  assert.equal(effectiveMode({ agentMode: 'full', preset: 'smart' }), 'full');
  for (const m of MODES) assert.equal(effectiveMode({ agentMode: m, preset: 'bypass' }), 'full');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:ts && node --test dist/test/permission-mode.test.js`
Expected: the build fails with "Cannot find module '../src/core/permission-mode.js'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/permission-mode.ts
/**
 * The mode a run's tool calls are judged by (spec section 4.2). Pure. Order: a ceiling (a run an outside app or another bot
 * started) always wins; then a goal at Full autonomy gives full; then the preset loosens the agent's own mode and never
 * tightens it, so the Ask preset is exactly 0.3.0.
 */
import { stricterMode } from './approvals.js';
import type { Preset } from '../shared/gates-registry.js';
import type { ApprovalMode } from '../shared/types.js';

export type RunMode = ApprovalMode | 'smart';
export type GoalAutonomy = 'track' | 'suggest' | 'check-once' | 'own' | 'full';

const RANK: Record<RunMode, number> = { ask: 0, 'auto-edits': 1, smart: 2, full: 3 };
const looser = (a: RunMode, b: RunMode): RunMode => (RANK[a] >= RANK[b] ? a : b);

export function effectiveMode(a: { agentMode: ApprovalMode; preset: Preset; goalAutonomy?: GoalAutonomy; ceiling?: ApprovalMode }): RunMode {
  if (a.ceiling) return stricterMode(a.agentMode, a.ceiling) === 'full' && a.ceiling === 'full' && a.preset === 'ask' && !a.goalAutonomy
    ? stricterMode(a.agentMode, a.ceiling)
    : stricterMode(a.ceiling === 'full' ? a.agentMode : stricterMode(a.agentMode, a.ceiling), a.ceiling);
  if (a.goalAutonomy === 'full') return 'full';
  switch (a.preset) {
    case 'ask': return a.agentMode;
    case 'accept-edits': return looser(a.agentMode, 'auto-edits');
    case 'smart': return looser(a.agentMode, 'smart');
    case 'bypass': return 'full';
  }
}
```

The ceiling branch above is deliberately verbose; simplify it in the refactor step to the equivalent `return stricterMode(a.agentMode, a.ceiling);`. Reason: today `effective()` is `ceiling ? stricterMode(mode, ceiling) : mode` (`engine.ts:1453`), and a ceiling is only ever `ask` in practice; with a ceiling present, presets and goals must not loosen anything.

- [ ] **Step 4: Refactor and run the test**

Replace the `if (a.ceiling) ...` statement with:

```ts
  if (a.ceiling) return stricterMode(a.agentMode, a.ceiling);
```

Run: `npm run build:ts && node --test dist/test/permission-mode.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/permission-mode.ts test/permission-mode.test.ts
git commit -m "gates: effectiveMode, the one rule for a run's permission mode"
```

---

### Task 3: The gates settings store

**Files:**
- Create: `src/core/gates-settings/store.ts`
- Test: `test/gates-store.test.ts`

**Interfaces:**
- Consumes: `GateSettings`, `isPreset`, `GATES`, `Preset` (Task 1).
- Produces: `class GatesError extends Error { status: number }`; `class GatesStore { constructor(dir: string, opts?: { allowed?: readonly Preset[] }); readonly folder: string; app(): GateSettings; project(id: string): GateSettings; patchApp(body: Record<string, unknown>): GateSettings; patchProject(id: string, body: Record<string, unknown>): GateSettings; prune(liveIds: string[]): void; reload(): void; view(ids: string[]): { app: GateSettings; projects: Record<string, GateSettings>; unreadable: string[] }; flush(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/gates-store.test.ts
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';

const dir = () => join(cleanupTemp('legion-gates-'), 'gates');

test('no files: the app and every project read as Ask', () => {
  const s = new GatesStore(dir());
  assert.deepEqual(s.app(), { version: 1 });
  assert.deepEqual(s.project('p_1'), { version: 1 });
});

test('a damaged file reads as Ask, is kept aside and is listed as unreadable', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'p_1.json'), '{not json');
  writeFileSync(join(d, 'app.json'), JSON.stringify({ version: 1, preset: 'yolo', overrides: { 'no-such': false } }));
  const s = new GatesStore(d);
  assert.deepEqual(s.project('p_1'), { version: 1 });
  assert.deepEqual(s.app(), { version: 1 });
  assert.ok(readdirSync(d).some((n) => n.startsWith('p_1.json.bad-')), 'the damaged file is kept aside');
  assert.deepEqual(s.view(['p_1']).unreadable.sort(), ['app', 'p_1']);
});

test('a file over 64 KB is treated as damaged', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'p_1.json'), JSON.stringify({ version: 1, pad: 'x'.repeat(70_000) }));
  assert.deepEqual(new GatesStore(d).project('p_1'), { version: 1 });
});

test('in this part only Ask is accepted; anything else is a 400 with a plain reason', () => {
  const s = new GatesStore(dir(), { allowed: ['ask'] });
  assert.deepEqual(s.patchProject('p_1', { preset: 'ask' }), { version: 1, preset: 'ask' });
  assert.throws(() => s.patchProject('p_1', { preset: 'bypass' }), (e: unknown) => e instanceof GatesError && e.status === 400 && /not available yet/.test(e.message));
  assert.throws(() => s.patchApp({ preset: 'nonsense' }), (e: unknown) => e instanceof GatesError && e.status === 400);
  assert.throws(() => s.patchProject('p_1', { overrides: { 'github-write-card': false } }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('a write lands on disk through tmp and rename, and a fresh store reads it back', async () => {
  const d = dir();
  const s = new GatesStore(d);
  s.patchProject('p_1', { preset: 'ask' });
  await s.flush();
  assert.equal(JSON.parse(readFileSync(join(d, 'p_1.json'), 'utf8')).preset, 'ask');
  assert.ok(!readdirSync(d).some((n) => n.endsWith('.tmp')));
  assert.equal(new GatesStore(d).project('p_1').preset, 'ask');
});

test('the core trusts memory: a file changed on disk is ignored until reload', async () => {
  const d = dir();
  const s = new GatesStore(d);
  s.patchProject('p_1', { preset: 'ask' });
  await s.flush();
  writeFileSync(join(d, 'p_1.json'), JSON.stringify({ version: 1, preset: 'bypass' }));
  assert.equal(s.project('p_1').preset, 'ask');
  s.reload();
  assert.deepEqual(s.project('p_1'), { version: 1 }, 'bypass is not allowed in this part, so the reloaded file reads as Ask');
});

test('prune drops files for projects that no longer exist', async () => {
  const d = dir();
  const s = new GatesStore(d);
  s.patchProject('p_gone', { preset: 'ask' });
  await s.flush();
  s.prune(['p_1']);
  await s.flush();
  assert.equal(existsSync(join(d, 'p_gone.json')), false);
});

test('a project id that is not a plain id is refused', () => {
  const s = new GatesStore(dir());
  assert.throws(() => s.patchProject('../app', { preset: 'ask' }), (e: unknown) => e instanceof GatesError && e.status === 400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:ts && node --test dist/test/gates-store.test.js`
Expected: the build fails with "Cannot find module '../src/core/gates-settings/store.js'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/gates-settings/store.ts
/**
 * The owner's gate presets: <dataDir>/gates/app.json and <dataDir>/gates/<projectId>.json (spec section 4.1).
 * Same rules as the away store: the core keeps the settings in memory and the files are persistence, read at start and on
 * an explicit reload only, so a shell edit does nothing until the owner reloads from the Gates page. The folder is a
 * protected path for the file tools. A file that is not valid reads as Ask (0.3.0 behavior), is renamed aside, and is
 * listed as unreadable so the page can say so. Writes are debounced, tmp + rename.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATES, PRESETS, isPreset } from '../../shared/gates-registry.js';
import type { GateSettings, GateValue, Preset } from '../../shared/gates-registry.js';

export class GatesError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'GatesError'; }
}

const MAX_BYTES = 64 * 1024;
const ID = /^p_[A-Za-z0-9_-]{1,40}$/;
const DEBOUNCE_MS = 400;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PERMISSION_IDS = new Set<string>(GATES.filter((g) => g.family === 'permission').map((g) => g.id));
const blank = (): GateSettings => ({ version: 1 });

export class GatesStore {
  readonly folder: string;
  private appS: GateSettings = blank();
  private projects = new Map<string, GateSettings>();
  private unreadable = new Set<string>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly allowed: readonly Preset[];

  constructor(dir: string, opts: { allowed?: readonly Preset[] } = {}) {
    this.folder = dir;
    this.allowed = opts.allowed ?? PRESETS;
    this.reload();
  }

  app(): GateSettings { return { ...this.appS }; }
  project(id: string): GateSettings { return { ...(this.projects.get(id) ?? blank()) }; }

  view(ids: string[]): { app: GateSettings; projects: Record<string, GateSettings>; unreadable: string[] } {
    return { app: this.app(), projects: Object.fromEntries(ids.map((id) => [id, this.project(id)])), unreadable: [...this.unreadable] };
  }

  patchApp(body: Record<string, unknown>): GateSettings {
    this.appS = this.merge(this.appS, body, true);
    this.mark('app');
    return this.app();
  }

  patchProject(id: string, body: Record<string, unknown>): GateSettings {
    if (!ID.test(id)) throw new GatesError(400, 'That is not a project id.');
    this.projects.set(id, this.merge(this.project(id), body, false));
    this.mark(id);
    return this.project(id);
  }

  prune(liveIds: string[]): void {
    const live = new Set(liveIds);
    for (const id of [...this.projects.keys()]) if (!live.has(id)) { this.projects.delete(id); this.mark(id); }
  }

  /** Read both kinds of file again (the owner pressed Reload on the Gates page, or the core started). */
  reload(): void {
    this.unreadable.clear();
    this.projects.clear();
    this.appS = this.readOne('app') ?? blank();
    if (!existsSync(this.folder)) return;
    for (const n of readdirSync(this.folder)) {
      const m = /^(p_[A-Za-z0-9_-]{1,40})\.json$/.exec(n);
      if (!m) continue;
      const s = this.readOne(m[1]!);
      if (s) this.projects.set(m[1]!, s);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.writeDirty();
  }

  private merge(cur: GateSettings, body: Record<string, unknown>, isApp: boolean): GateSettings {
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'preset' && k !== 'overrides' && !(isApp && k === 'shellFloorOff'))) throw new GatesError(400, 'Only preset and overrides can be changed here.');
    const out: GateSettings = { ...cur, version: 1 };
    if ('preset' in body) {
      if (body.preset === null) delete out.preset;
      else if (!isPreset(body.preset)) throw new GatesError(400, 'That is not a preset. Use ask, accept-edits, smart or bypass.');
      else if (!this.allowed.includes(body.preset)) throw new GatesError(400, `The ${body.preset} preset is not available yet.`);
      else out.preset = body.preset;
    }
    if ('overrides' in body) {
      if (!isObj(body.overrides) || Object.keys(body.overrides).length > 0) throw new GatesError(400, 'Per-gate overrides are not available yet.');
    }
    if ('shellFloorOff' in body) throw new GatesError(400, 'The shell floor switch is not available yet.');
    return out;
  }

  private readOne(name: string): GateSettings | undefined {
    const file = join(this.folder, `${name}.json`);
    if (!existsSync(file)) return undefined;
    try {
      if (statSync(file).size > MAX_BYTES) throw new Error('too big');
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObj(raw) || raw.version !== 1) throw new Error('shape');
      const out: GateSettings = { version: 1 };
      if (raw.preset !== undefined) {
        if (!isPreset(raw.preset) || !this.allowed.includes(raw.preset)) throw new Error('preset');
        out.preset = raw.preset;
      }
      if (raw.overrides !== undefined) {
        if (!isObj(raw.overrides)) throw new Error('overrides');
        const ov: Record<string, GateValue> = {};
        for (const [k, v] of Object.entries(raw.overrides)) if (PERMISSION_IDS.has(k) && typeof v === 'boolean') ov[k] = v;
        if (Object.keys(ov).length) throw new Error('overrides not available yet');
      }
      return out;
    } catch {
      this.unreadable.add(name);
      try { renameSync(file, `${file}.bad-${Date.now()}`); } catch { /* left in place; still read as Ask */ }
      return undefined;
    }
  }

  private mark(name: string): void {
    this.dirty.add(name);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.writeDirty(); }, DEBOUNCE_MS);
  }

  private writeDirty(): void {
    if (!this.dirty.size) return;
    mkdirSync(this.folder, { recursive: true });
    for (const name of this.dirty) {
      const file = join(this.folder, `${name}.json`);
      const s = name === 'app' ? this.appS : this.projects.get(name);
      if (!s) { rmSync(file, { force: true }); continue; }
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2));
      renameSync(tmp, file);
    }
    this.dirty.clear();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:ts && node --test dist/test/gates-store.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/gates-settings/store.ts test/gates-store.test.ts
git commit -m "gates: settings store (memory first, damaged files read as Ask, tmp + rename)"
```

---

### Task 4: The gates module and its routes

**Files:**
- Create: `src/core/gates-settings/index.ts`
- Test: `test/gates-routes.test.ts`

**Interfaces:**
- Consumes: `GatesStore`, `GatesError` (Task 3); `effectiveMode` (Task 2); `CoreModule`, `ModuleDeps` from `src/core/modules.ts`; `HttpError`, `Ctx` from `src/core/server.ts`; `ProjectStore` from `src/core/projects/store.ts`.
- Produces: `interface ModeResolver { mode(agentMode: ApprovalMode, projectId: string | undefined, ceiling?: ApprovalMode): ApprovalMode }`; `interface GatesCore { store: GatesStore; resolver: ModeResolver }`; `function createGatesCore(o: { dataDir: string; projects?: ProjectStore }): GatesCore`; `interface GatesModule extends CoreModule { store: GatesStore }`; `function createGatesModule(deps: ModuleDeps, opts: { projects: ProjectStore; core: GatesCore }): GatesModule`. Routes: `GET /api/gates/settings`, `PATCH /api/gates/app`, `PATCH /api/gates/projects/:id`, `POST /api/gates/reload`.

- [ ] **Step 1: Write the failing test**

```ts
// test/gates-routes.test.ts
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isClientRoute } from '../src/core/admin.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';

const J = { 'Content-Type': 'application/json' };

async function boot() {
  const root = cleanupTemp('legion-gates-routes-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const p = projects.create({ name: 'Shop' });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const core = createGatesCore({ dataDir: data, projects });
  const mod = createGatesModule(deps, { projects, core });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const req = (headers: Record<string, string>) => (m: string, path: string, body?: unknown) =>
    fetch(s.base + path, { method: m, headers: { ...headers, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { mod, core, pid: p.id, call: req(AUTH), client: req(asClient), anon: req({}), close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('every gates route is admin-only', async () => {
  const r = await boot();
  try {
    const routes: Array<[string, string, unknown?]> = [['GET', '/api/gates/settings'], ['PATCH', '/api/gates/app', { preset: 'ask' }], ['PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' }], ['POST', '/api/gates/reload', {}]];
    for (const [m, path, body] of routes) {
      assert.equal(isClientRoute(m, path), false, `${m} ${path}`);
      assert.equal((await r.client(m, path, body)).status, 403, `${m} ${path} with a bearer token`);
      assert.equal((await r.anon(m, path, body)).status, 401, `${m} ${path} with nothing`);
    }
  } finally { await r.close(); }
});

test('settings round-trip, unknown project is 404, bypass is 400 in this part', async () => {
  const r = await boot();
  try {
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    const v = await (await r.call('GET', '/api/gates/settings')).json() as { projects: Record<string, { preset?: string }> };
    assert.equal(v.projects[r.pid]?.preset, 'ask');
    assert.equal((await r.call('PATCH', '/api/gates/projects/p_nope', { preset: 'ask' })).status, 404);
    const res = await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not available yet/);
  } finally { await r.close(); }
});

test('the gates folder is a protected path', async () => {
  const r = await boot();
  try { assert.deepEqual(r.mod.protectedPaths?.(), [r.core.store.folder]); } finally { await r.close(); }
});

test('the resolver returns the agent own mode under Ask, and the ceiling wins', async () => {
  const r = await boot();
  try {
    for (const m of ['ask', 'auto-edits', 'full'] as const) assert.equal(r.core.resolver.mode(m, r.pid), m);
    assert.equal(r.core.resolver.mode('full', undefined), 'full');
    assert.equal(r.core.resolver.mode('full', r.pid, 'ask'), 'ask');
  } finally { await r.close(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:ts && node --test dist/test/gates-routes.test.js`
Expected: the build fails with "Cannot find module '../src/core/gates-settings/index.js'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/gates-settings/index.ts
/**
 * The gates settings module (spec section 4): the owner's presets per project and for the app, and the one resolver every
 * permission check asks for a run's mode. Routes are admin-only by the gate's default deny (none is a client route).
 * Part 1 accepts only the Ask preset, so the resolver returns exactly the agent's own mode (0.3.0 behavior).
 */
import { join } from 'node:path';
import type { ApprovalMode, LegionEvent } from '../../shared/types.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { effectiveMode } from '../permission-mode.js';
import type { ProjectStore } from '../projects/store.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import { GatesError, GatesStore } from './store.js';

export { GatesStore, GatesError } from './store.js';

export interface ModeResolver {
  /** The mode a tool call is judged by right now. Called on every call, so a change takes effect on the next one. */
  mode(agentMode: ApprovalMode, projectId: string | undefined, ceiling?: ApprovalMode): ApprovalMode;
}
export interface GatesCore { store: GatesStore; resolver: ModeResolver }

/** Part 1: only Ask. Part 2 widens this list and teaches the callers about 'smart'. */
const PART_ONE_PRESETS = ['ask'] as const;

export function createGatesCore(o: { dataDir: string; projects?: ProjectStore }): GatesCore {
  const store = new GatesStore(join(o.dataDir, 'gates'), { allowed: PART_ONE_PRESETS });
  try { if (o.projects) store.prune(o.projects.list().map((p) => p.id)); } catch { /* the settings stay as they are */ }
  const resolver: ModeResolver = {
    mode(agentMode, projectId, ceiling) {
      const preset = (projectId ? store.project(projectId).preset : undefined) ?? store.app().preset ?? 'ask';
      const m = effectiveMode({ agentMode, preset, ...(ceiling ? { ceiling } : {}) });
      // 'smart' cannot occur while only Ask is allowed; part 2 removes this guard together with the callers' support for it
      return m === 'smart' ? agentMode : m;
    },
  };
  return { store, resolver };
}

export interface GatesModule extends CoreModule { store: GatesStore }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createGatesModule(deps: ModuleDeps, opts: { projects: ProjectStore; core: GatesCore }): GatesModule {
  const { store } = opts.core;
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) { if (e instanceof GatesError) throw new HttpError(e.status, e.message); throw e; }
  };
  const emit = (): void => { try { deps.bus.emit({ type: 'gates.updated' } as unknown as LegionEvent); } catch { /* advisory */ } };
  const must = (id: string | undefined): string => {
    if (!id || !opts.projects.get(id)) throw new HttpError(404, `Unknown project "${String(id).slice(0, 40)}"`);
    return id;
  };
  const body = (c: Ctx): Record<string, unknown> => { if (!isObj(c.body)) throw new HttpError(400, 'JSON object body required'); return c.body; };
  return {
    id: 'gates', store,
    protectedPaths: () => [store.folder],
    routes: (add) => {
      add('GET', '/api/gates/settings', () => store.view(opts.projects.list().map((p) => p.id)));
      add('PATCH', '/api/gates/app', (c) => { const r = wrap(() => store.patchApp(body(c))); emit(); return r; });
      add('PATCH', '/api/gates/projects/:id', (c) => { const id = must(c.params[0]); const r = wrap(() => store.patchProject(id, body(c))); emit(); return r; });
      add('POST', '/api/gates/reload', () => { store.reload(); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
    },
    dispose: async () => { await store.flush(); },
  };
}
```

If `LegionEvent` is a closed union and `gates.updated` is not a member, add `| { type: 'gates.updated' }` to the union in `src/shared/types.ts` (near `away.updated`, ~line 337) and drop the `as unknown as` cast. Check with `rg -n "away.updated" src/shared/types.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:ts && node --test dist/test/gates-routes.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/gates-settings/index.ts test/gates-routes.test.ts src/shared/types.ts
git commit -m "gates: settings module, admin routes and the mode resolver (Ask only)"
```

---

### Task 5: Route the engine's mode reads through the resolver

**Files:**
- Modify: `src/core/engine.ts` (`EngineDeps` ~82-95; the constructor ~384; the three reads at ~1426, ~1452, ~1591)
- Modify: `src/bin/legion-core.ts` (~97-160)
- Test: `test/engine-mode-resolver.test.ts` (new)

**Interfaces:**
- Consumes: `ModeResolver` (Task 4).
- Produces: `EngineDeps.modes?: ModeResolver`; private `Engine.modeNow(job: Job, agent: AgentProfile): ApprovalMode`.

- [ ] **Step 1: Write the failing test**

Use the away rig (`test/away-rig.ts`), which builds a real `Engine` over a fake store. Read its `setup()` signature first (`sed -n 30,80p test/away-rig.ts` is not allowed; use the Read tool or `rg -n "export function setup" -A 40 test/away-rig.ts`) and pass `modes` through to the `Engine` constructor by adding an optional `modes` to `setup`'s options.

```ts
// test/engine-mode-resolver.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './away-rig.js';
import type { ModeResolver } from '../src/core/gates-settings/index.js';

test('the engine asks the resolver for the mode on every tool call, with the task project', async () => {
  const calls: Array<[string, string | undefined, string | undefined]> = [];
  const modes: ModeResolver = { mode: (m, pid, ceiling) => { calls.push([m, pid, ceiling]); return m; } };
  const r = setup({ approval: 'ask', modes });
  try {
    await r.runOneToolCall('a1', 'Bash', { command: 'echo hi' }, { projectId: r.projectId });
    assert.ok(calls.length >= 1, 'the resolver was asked');
    assert.equal(calls[0]![1], r.projectId);
  } finally { await r.close(); }
});

test('resolver re-reads the agent mode on every call (a promotion mid-run takes effect)', async () => {
  const seen: string[] = [];
  const modes: ModeResolver = { mode: (m) => { seen.push(m); return m; } };
  const r = setup({ approval: 'ask', modes });
  try {
    await r.runToolCalls('a1', [['Bash', { command: 'echo 1' }], ['Bash', { command: 'echo 2' }]], { between: () => r.store.agents.get('a1')!.approval = 'full' });
    assert.deepEqual(seen.slice(0, 2), ['ask', 'full']);
  } finally { await r.close(); }
});

test('without a resolver the engine behaves exactly as before', async () => {
  const r = setup({ approval: 'full' });
  try {
    const d = await r.runOneToolCall('a1', 'Bash', { command: 'echo hi' });
    assert.equal(d.carded, false);
  } finally { await r.close(); }
});

test('a task with no project uses the resolver with projectId undefined', async () => {
  const calls: Array<string | undefined> = [];
  const r = setup({ approval: 'ask', modes: { mode: (m, pid) => { calls.push(pid); return m; } } });
  try {
    await r.runOneToolCall('a1', 'Bash', { command: 'echo hi' });
    assert.equal(calls[0], undefined);
  } finally { await r.close(); }
});
```

The helpers `runOneToolCall`, `runToolCalls`, `projectId` and `close` may not exist on the rig. Add them to `test/away-rig.ts` in this step if missing: `runOneToolCall(agentId, tool, input, opts?)` starts a task whose scripted model emits one `tool_use` for `tool` with `input`, resolves after the decision, and returns `{ carded: boolean }` by watching `approval.requested` events; `runToolCalls` does the same for a list, calling `between()` after the first decision. Model them on the rig's existing `script` option. Keep the additions in the rig file, not in production code.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:ts && node --test dist/test/engine-mode-resolver.test.js`
Expected: FAIL (the build fails on `modes` not being a known option, or the first test fails with "the resolver was asked").

- [ ] **Step 3: Write the implementation**

In `src/core/engine.ts`:

```ts
// EngineDeps (~line 82): add
  /** The gate presets' mode resolver (spec 4.2). Absent: the agent's own mode, as before. */
  modes?: import('./gates-settings/index.js').ModeResolver;
```

```ts
// class fields (~line 368): add
  private readonly modes?: import('./gates-settings/index.js').ModeResolver;
// constructor (~line 384): add
  this.modes = deps.modes;
```

```ts
// new private method, next to toolDecider:
  /** The mode a tool call of this run is judged by right now: re-read on every call (a promotion or a preset change applies on the next call). */
  private modeNow(job: Job, agent: AgentProfile): ApprovalMode {
    const own = this.store.getAgent(agent.id)?.approval ?? agent.approval;
    const ceiling = job.origin?.approvalCeiling;
    if (!this.modes) return ceiling ? stricterMode(own, ceiling) : own;
    return this.modes.mode(own, this.projectOf(job.taskId, agent.id)?.id, ceiling);
  }
```

Replace the body of each of the three `effective` closures (at ~1452 and ~1591; and the `mode` read at ~1426 inside the shell floor) so they call `this.modeNow(job, agent)`:

```ts
    const effective = (): ApprovalMode => this.modeNow(job, agent);
```

and at ~1426:

```ts
    const mode = this.modeNow(job, agent);
```

Leave the `agent.approval === 'full'` check at ~1596 (bypass choice at run start) unchanged in this part: under Ask the resolver returns the agent's own mode, so the run-start choice is unchanged. Part 2 changes it to `this.modeNow(job, agent) === 'full'`.

In `src/bin/legion-core.ts`, before `const engine = new Engine(...)`:

```ts
  // gate presets (spec 2026-10-14 goals and gates, part 1: Ask only, so every run keeps its agent's own mode)
  const gatesCore = createGatesCore({ dataDir: dataDir(), projects });
```

pass `modes: gatesCore.resolver` into the `Engine` constructor, and add the module to `modules` after `away`:

```ts
  const gates = createGatesModule(moduleDeps, { projects, core: gatesCore });
```

with the import `import { createGatesCore, createGatesModule } from '../core/gates-settings/index.js';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:ts && node --test dist/test/engine-mode-resolver.test.js dist/test/approvals.test.js dist/test/away-engine.test.js`
Expected: PASS for all three files.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/core/engine.ts src/bin/legion-core.ts test/engine-mode-resolver.test.ts test/away-rig.ts
git commit -m "gates: the engine reads a run's mode through the preset resolver"
```

---

### Task 6: The Ask parity fixture

**Files:**
- Create: `scripts/dev/gen-gate-parity.mjs`
- Create (generated): `test/fixtures/gate-parity-0.3.0.json`
- Test: `test/gate-parity.test.ts`

**Interfaces:**
- Consumes: `needsApproval`, `decideGuard`, `stricterMode` from `src/core/approvals.ts`; `createGatesCore` (Task 4).
- Produces: the committed fixture `{ inputs: {...}, rows: Array<{ mode: string; ceiling: string | null; tool: string; capped: boolean; needsApproval: boolean; guardCards: boolean }> }`.

- [ ] **Step 1: Write the generator and run it on 0.3.0 code**

The generator must run against the compiled 0.3.0 functions BEFORE Task 5's engine change matters (the functions it uses are not changed by this plan, so running it after Task 5 gives the same table; generate it now anyway and commit it before Step 3).

```js
// scripts/dev/gen-gate-parity.mjs
// Writes test/fixtures/gate-parity-0.3.0.json from the compiled 0.3.0 decision functions (run `npm run build:ts` first).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { needsApproval, decideGuard, stricterMode } = await import(join(root, 'dist', 'src', 'core', 'approvals.js'));

const MODES = ['ask', 'auto-edits', 'full'];
const CEILINGS = [null, 'ask', 'auto-edits', 'full'];
const TOOLS = [
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Bash', 'PowerShell', 'Monitor', 'mcp__host__shell',
  'mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop', 'mcp__legion__vm_status',
  'mcp__legion_board__board_delete', 'mcp__legion_connectors__github_issue_create',
  'mcp__someone__tool', 'UnknownTool',
];
const rows = [];
for (const mode of MODES) for (const ceiling of CEILINGS) for (const tool of TOOLS) for (const capped of [false, true]) {
  const eff = ceiling ? stricterMode(mode, ceiling) : mode;
  rows.push({ mode, ceiling, tool, capped, needsApproval: needsApproval(eff, tool, { capped }), guardCards: decideGuard(eff).needsCard });
}
const out = join(root, 'test', 'fixtures', 'gate-parity-0.3.0.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generatedFrom: '0.3.0 approvals.ts', inputs: { MODES, CEILINGS, TOOLS }, rows }, null, 1) + '\n');
console.log(`wrote ${rows.length} rows to ${out}`);
```

Run: `npm run build:ts && node scripts/dev/gen-gate-parity.mjs`
Expected: `wrote 552 rows to .../test/fixtures/gate-parity-0.3.0.json`.

Check: `test/fixtures` must be copied to `dist/test/fixtures` by the build, or the test must read it from the repo root. Read `scripts/copy-static.mjs` (Read tool) to see what it copies; if fixtures are not copied, resolve the path from the repo root in the test as below.

- [ ] **Step 2: Write the failing test**

```ts
// test/gate-parity.test.ts
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideGuard, needsApproval } from '../src/core/approvals.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import type { ApprovalMode } from '../src/shared/types.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const fx = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'gate-parity-0.3.0.json'), 'utf8')) as { rows: Array<{ mode: ApprovalMode; ceiling: ApprovalMode | null; tool: string; capped: boolean; needsApproval: boolean; guardCards: boolean }> };

test('the fixture is the full grid', () => {
  assert.equal(fx.rows.length, 552);
});

test('preset Ask reproduces every 0.3.0 decision, for a project run and for a run with no project', () => {
  const core = createGatesCore({ dataDir: join(cleanupTemp('legion-parity-'), 'data') });
  for (const pid of ['p_any', undefined]) {
    for (const r of fx.rows) {
      const eff = core.resolver.mode(r.mode, pid, r.ceiling ?? undefined);
      assert.equal(needsApproval(eff, r.tool, { capped: r.capped }), r.needsApproval, `needsApproval ${JSON.stringify(r)} project=${pid}`);
      assert.equal(decideGuard(eff).needsCard, r.guardCards, `guard ${JSON.stringify(r)} project=${pid}`);
    }
  }
});
```

- [ ] **Step 3: Run the test**

Run: `npm run build:ts && node --test dist/test/gate-parity.test.js`
Expected: PASS, 2 tests. (If it fails, the resolver changed a decision under Ask: fix the resolver, never the fixture.)

- [ ] **Step 4: Mutation check (proves the test can fail)**

Temporarily change `createGatesCore`'s resolver to `return 'full';`, rebuild, run the test, and confirm it FAILS on the first `needsApproval` row. Restore the line. Do not commit the mutation.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/gen-gate-parity.mjs test/fixtures/gate-parity-0.3.0.json test/gate-parity.test.ts
git commit -m "gates: Ask parity fixture generated from 0.3.0 and its test"
```

---

### Task 7: Close part 1

- [ ] **Step 1: Typecheck and run every test file this plan touched**

Run: `npm run typecheck && npm run build:ts && node --test dist/test/gates-registry.test.js dist/test/permission-mode.test.js dist/test/gates-store.test.js dist/test/gates-routes.test.js dist/test/engine-mode-resolver.test.js dist/test/gate-parity.test.js dist/test/approvals.test.js dist/test/away-engine.test.js dist/test/away-routes.test.js`
Expected: no type errors; every listed file passes.

- [ ] **Step 2: Em dash check on new files**

Run: `rg -n "—" src/shared/gates-registry.ts src/core/permission-mode.ts src/core/gates-settings/ test/gates-*.test.ts test/permission-mode.test.ts test/gate-parity.test.ts`
Expected: no matches.

- [ ] **Step 3: Open the PR**

Branch `feat/gates-registry-pr1` from `main`. PR title "gates: registry, settings and the mode resolver (Ask only, no behavior change)". Body: what it adds, the parity fixture as the proof of no change, that Accept edits, Smart and Bypass come in part 2, and the Claude Code line at the end. CI is the full gate; merge when green (non-release PR).

---

## Self-review notes

- Spec coverage for PR 1: 4.1 contract (Task 1), gates files and routes (Tasks 3, 4), `effectiveMode` (Task 2), rules 1, 4 and 5 of 4.2 (Tasks 2, 5), Ask parity (Task 6), damaged file as Ask and memory-first (Task 3), protected path (Task 4). Rules 2 and 3 of 4.2 are implemented in `effectiveMode` and tested (Task 2) but not reachable until part 2 allows other presets.
- Not in this plan (part 2): the `smart` run mode in `toolDecider` and `needsApproval`, the consequence rules for `npm test` and friends, the module `modeOf` providers (browser, Blender, board) switching to the resolver, the run-start bypass choice using the resolver, overrides, the shell floor switch, the Gates page, the first-run preset screen, the activity log, the GitHub card switch.
- Types used across tasks: `Preset`, `GateSettings`, `GateId` (Task 1); `RunMode`, `GoalAutonomy`, `effectiveMode` (Task 2); `GatesStore`, `GatesError` (Task 3); `ModeResolver`, `GatesCore`, `createGatesCore`, `createGatesModule` (Task 4); `EngineDeps.modes`, `Engine.modeNow` (Task 5). Names match across tasks.
