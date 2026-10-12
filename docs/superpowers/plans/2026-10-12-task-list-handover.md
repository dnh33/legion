# Task List Handover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One task list per conversation that survives compaction and a Claude ↔ provider switch. Legion owns it on provider runs; Claude runs use Claude Code's native Task tools, with Legion re-injecting and handing the list over.

**Architecture:** Legion's per-task file (`src/core/task-list.ts`, `<workspace>/.task-lists/<task>.json`) stays the store. Provider runs read and write it through `mcp__legion__todo_*` (built). Claude runs mirror their native Task calls into it (built). This plan adds three things:
- **Re-injection.** A fixed-format "task list" text block goes into the run's context at run start and after compaction. Provider runs get it in the system prompt and the summary row. Claude runs get it through the documented `SessionStart` hook (`source: compact`).
- **Handover.** When a provider run changed the list, or the Claude session is new, the next Claude run is given the list and told to reconcile its own (`SessionStart`, `source: startup|resume`).
- **A per-agent switch.** One setting turns Claude's native Task tools on or off. This is the documented opt-in via the SDK's `allowedTools`; 5.x models need it.

**Tech Stack:** TypeScript, Node 24, `@anthropic-ai/claude-agent-sdk` 0.3.285 (bundled Claude Code ≥ 2.1.268), `node --test` on `tsc` output, React UI (`ui/`).

**Spec:** the decisions Daniel made on 2026-10-12, plus the research in Aetherkeep `06-projects/legion/task-list-design-research-2026-10-12.md`:
- Provider runs: Legion owns the list.
- Claude runs: native list, per-agent setting.
- Sync to Claude: hand-over through documented surfaces only (no writes into Claude Code's own task folder).
- Re-inject: open items in full, plus done titles on one line.
- Task list and project board stay separate, with no auto-sync.

## Global Constraints

- Documented Claude Code / SDK surfaces only. No `CLAUDE_CODE_TASK_LIST_ID`, no writes under `~/.claude/tasks`.
- Native Task tool names: `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`. The old list tool is `TodoWrite`.
- Task tools are never carded and never taint a run (already true: approvals READ_ONLY, CLEAN_BUILTINS).
- The re-injected block opens with this exact header: `[Your task list for this conversation, kept by Legion]`.
- The block is bounded at 40 open items and 1500 characters of done titles. A longer list says how many items were left out.
- Default for the per-agent switch: on for the lead agent (`LEAD_AGENT_ID`, `zealot`), off for every other agent. An explicit `on`/`off` on the agent always wins.
- Commit messages carry no `Co-Authored-By` or Claude attribution lines.
- Shell commands: use `rg`, `fd` and `sd`; multi-line edits go through the Edit tool.

## Review Focus

1. **Empty list.** No block is injected at all: not even the header, and no "0 tasks" line.
2. **Claude agent with task tools off.** No handover and no injection: the agent has no tools to act on the list.
3. **A conversation that only ever ran on Claude.** No handover on its next run. Claude's own list is already right, and handing over would make it re-create its tasks.
4. **A forged block typed by a user** (the header pasted into a message). It must not be treated as Legion's state. Legion's state is read from the file, never parsed out of the transcript.
5. **A list larger than the caps.** The block stays bounded and says what it left out, so it never takes over the context it's meant to survive.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/task-list.ts` | Model and store | Add `renderForModel()`, the `handoverPending` flag, `renderHandover()` |
| `src/shared/task-list-setting.ts` | **new**: the per-agent default rule, shared by core and UI | `nativeTaskListOn(agent)` |
| `src/shared/types.ts` | Agent profile | `taskList?: 'on' \| 'off'` |
| `src/core/server.ts` | Agent field parsing | Parse `taskList` |
| `src/core/engine.ts` | Run wiring | Claude: allowed/disallowed tools, `SessionStart` hook. Provider: system-prompt block, `taskListText`, mark handover on a provider save |
| `src/core/providers/types.ts`, `tool-loop.ts` | Provider loop | `ProviderHost.taskListText?()` appended to the summary row in `compactMessages` and `compactOnce` |
| `src/core/agent-tools.ts`, `src/core/projects/board/prompt.ts` | Copy | One line separating the task list from the board |
| `ui/src/components/AgentEditor.tsx` | Settings | The "Task list (Claude)" checkbox |

---

### Task 1: The model text: `renderForModel` and `renderHandover`

**Files:**
- Modify: `src/core/task-list.ts`
- Test: `test/task-list.test.ts`

**Interfaces:**
- Produces:
  - `TASK_LIST_HEADER: string`
  - `renderForModel(list: TaskList): string | undefined` (undefined when the list is empty)
  - `renderHandover(list: TaskList): string | undefined`
  - `TaskList#handoverPending: boolean`, persisted in `toJSON`/`fromJSON`

- [ ] **Step 1: Write the failing tests**

```ts
import { renderForModel, renderHandover, TASK_LIST_HEADER } from '../src/core/task-list.js';

test('renderForModel: open items in full, done titles on one line, nothing for an empty list', () => {
  const l = new TaskList();
  assert.equal(renderForModel(l), undefined);
  l.create({ subject: 'Read the spec', description: 'all of it' });
  l.create({ subject: 'Write the test', description: '' });
  l.create({ subject: 'Ship', description: '' });
  l.update({ taskId: '1', status: 'completed' });
  l.update({ taskId: '2', status: 'in_progress' });
  l.update({ taskId: '3', addBlockedBy: ['2'] });
  assert.equal(renderForModel(l), [
    TASK_LIST_HEADER,
    '- [>] 2. Write the test (in progress)',
    '- [ ] 3. Ship (pending; waits for 2)',
    'Done: 1. Read the spec',
  ].join('\n'));
});

test('renderForModel stays bounded: at most 40 open items and 1500 chars of done titles, and says what it left out', () => {
  const l = new TaskList();
  for (let i = 0; i < 90; i++) l.create({ subject: `step ${i} ${'x'.repeat(60)}`, description: '' });
  for (let i = 1; i <= 40; i++) l.update({ taskId: String(i), status: 'completed' });
  const text = renderForModel(l)!;
  assert.equal(text.split('\n').filter((s) => s.startsWith('- [')).length, 40);
  assert.match(text, /10 more open tasks are not shown/);
  assert.ok(text.slice(text.indexOf('Done:')).length <= 1600);
  assert.match(text, /more done/);
});

test('a provider change marks the list for handover; the flag survives a save/load', () => {
  const l = new TaskList();
  l.create({ subject: 'a', description: '' });
  assert.equal(l.handoverPending, false);
  l.handoverPending = true;
  assert.equal(TaskList.fromJSON(JSON.parse(JSON.stringify(l))).handoverPending, true);
});

test('renderHandover tells Claude to make its own list match, in its own tools', () => {
  const l = new TaskList();
  assert.equal(renderHandover(l), undefined);
  l.create({ subject: 'carry me', description: '' });
  const t = renderHandover(l)!;
  assert.ok(t.startsWith(TASK_LIST_HEADER));
  assert.match(t, /TaskList/);
  assert.match(t, /TaskCreate/);
  assert.match(t, /TaskUpdate/);
});
```

- [ ] **Step 2: Run, and expect a FAIL** (`renderForModel` is not exported)

Run: `npx tsc -p tsconfig.json; node --test dist/test/task-list.test.js < /dev/null`

- [ ] **Step 3: Implement**

```ts
export const TASK_LIST_HEADER = '[Your task list for this conversation, kept by Legion]';
const MAX_OPEN_SHOWN = 40;
const MAX_DONE_CHARS = 1500;

/** The list as the model is shown it again: open items in full, done titles on one line. Undefined for an empty list. */
export function renderForModel(list: TaskList): string | undefined {
  const all = list.list();
  if (!all.length) return undefined;
  const open = all.filter((t) => t.status !== 'completed');
  const done = all.filter((t) => t.status === 'completed');
  const lines = [TASK_LIST_HEADER];
  for (const t of open.slice(0, MAX_OPEN_SHOWN)) {
    const waits = t.blockedBy.length ? `; waits for ${t.blockedBy.join(', ')}` : '';
    lines.push(`- [${t.status === 'in_progress' ? '>' : ' '}] ${t.id}. ${t.subject} (${t.status === 'in_progress' ? 'in progress' : 'pending'}${waits})`);
  }
  if (open.length > MAX_OPEN_SHOWN) lines.push(`${open.length - MAX_OPEN_SHOWN} more open tasks are not shown.`);
  if (done.length) {
    let line = 'Done: ';
    let shown = 0;
    for (const t of done) {
      const part = `${shown ? '; ' : ''}${t.id}. ${t.subject}`;
      if (line.length + part.length > MAX_DONE_CHARS) break;
      line += part; shown++;
    }
    if (shown < done.length) line += ` (and ${done.length - shown} more done)`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** The hand-over to a Claude run whose own list may be behind: the list, and how to make Claude's own list match. */
export function renderHandover(list: TaskList): string | undefined {
  const body = renderForModel(list);
  if (!body) return undefined;
  return `${body}\nThis conversation's task list changed while another model was working on it. Call TaskList, then make your own list match the one above: TaskCreate for each open task you do not have, TaskUpdate for any status that differs. Do this before other work.`;
}
```

In `TaskList`: add `handoverPending = false;`. Write it in `toJSON` (`{ nextId, handoverPending, tasks }`) and read it in `fromJSON` (`l.handoverPending = o.handoverPending === true`).

- [ ] **Step 4: Run, and expect PASS** (same command)
- [ ] **Step 5: Commit**: `task list: renderForModel / renderHandover and the handover flag`

---

### Task 2: Provider runs: the block at run start and after every compaction; provider saves mark the handover

**Files:**
- Modify: `src/core/providers/types.ts`, `src/core/providers/tool-loop.ts` (`compactMessages` ~l.478 and `compactOnce` ~l.548, after `renderSummaryRow`), `src/core/engine.ts` (`runProvider` system prompt and host; the provider `taskList.save` in `buildMcpServers`)
- Test: `test/provider-task-list.test.ts`

**Interfaces:**
- Consumes: `renderForModel`, `TaskList#handoverPending` (Task 1)
- Produces: `ProviderHost.taskListText?(): string | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
test('a continued provider run sees its open tasks in the system prompt from the first turn', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'c1', name: 'mcp__legion__todo_create', args: { subject: 'carry me', description: '' } }]); else replyText(res, 'done'); });
  try {
    const h = setup(f);
    const t = await run(h, 'one');
    await run(h, 'two', { continueTaskId: t.id });
    const sys = (f.requests.at(-1)!.body.messages as any[])[0].content as string;
    assert.match(sys, /\[Your task list for this conversation, kept by Legion\]/);
    assert.match(sys, /1\. carry me \(pending\)/);
  } finally { await f.close(); }
});

test('a provider run with no tasks gets no task-list block at all', async () => {
  const f = await startFake((_r, res) => replyText(res, 'ok'));
  try {
    const h = setup(f);
    await run(h);
    assert.doesNotMatch((f.requests[0]!.body.messages as any[])[0].content, /kept by Legion\]/);
  } finally { await f.close(); }
});

test('a provider todo change marks the list for handover to the next Claude run', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'c1', name: 'mcp__legion__todo_create', args: { subject: 'x', description: '' } }]); else replyText(res, 'done'); });
  try {
    const h = setup(f);
    const t = await run(h);
    const { TaskListStore } = await import('../src/core/task-list.js');
    const { join } = await import('node:path');
    assert.equal(new TaskListStore(join(h.config.workspaceDir, '.task-lists')).load(t.id).handoverPending, true);
  } finally { await f.close(); }
});
```

For the summary row: add a unit test in `test/provider-compaction.test.ts`, following that file's existing `compactMessages` fixtures. Give the host a `taskListText: () => 'LIST'` and assert that the stored summary notice ends with `\n\nLIST`. Also add a host without `taskListText` and assert its row is unchanged.

- [ ] **Step 2: Run, and expect FAIL**
- [ ] **Step 3: Implement**
  - `types.ts` `ProviderHost`: `/** The task list as the model should see it after compaction (undefined: none). */ taskListText?(): string | undefined;`
  - `tool-loop.ts`, in both places, right after `const row = renderSummaryRow(...)`: `const list = host.taskListText?.(); if (list) row.content = \`${row.content ?? ''}\n\n${list}\`;`
  - `engine.ts runProvider`: add `+ (() => { const t = renderForModel(this.taskLists.load(taskId)); return t ? '\n\n' + t : ''; })()` to `systemPrompt` before the "You are running on …" line, and add `taskListText: () => renderForModel(this.taskLists.load(taskId))` to the host.
  - `engine.ts buildMcpServers`, provider `taskList.save`: set `l.handoverPending = true;` before `this.taskLists.save(taskId, l)`.
- [ ] **Step 4: Run, and expect PASS**: `provider-task-list`, `provider-compaction`, `providers-tools`, `engine`
- [ ] **Step 5: Commit**: `task list: provider runs see their list at run start and after compaction`

---

### Task 3: The per-agent switch for Claude's native Task tools

**Files:**
- Create: `src/shared/task-list-setting.ts`
- Modify: `src/shared/types.ts` (`AgentProfile.taskList?: 'on' | 'off'`), `src/core/server.ts` (`parseAgentFields`), `src/core/engine.ts` (`buildOptions`)
- Test: `test/task-list.test.ts` (the rule), `test/engine.test.ts` (options), `test/server*.test.ts` (parse: follow the existing PATCH `/api/agents` test file)

**Interfaces:**
- Produces: `nativeTaskListOn(agent: Pick<AgentProfile, 'id' | 'taskList'>): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// task-list.test.ts
import { nativeTaskListOn } from '../src/shared/task-list-setting.js';
test('native task list: on for the lead by default, off for others, an explicit setting wins', () => {
  assert.equal(nativeTaskListOn({ id: 'zealot' }), true);
  assert.equal(nativeTaskListOn({ id: 'scout' }), false);
  assert.equal(nativeTaskListOn({ id: 'scout', taskList: 'on' }), true);
  assert.equal(nativeTaskListOn({ id: 'zealot', taskList: 'off' }), false);
});

// engine.test.ts
test('task list on: the native Task tools are opted in (allowedTools); off: they and TodoWrite are disallowed', async () => {
  const on = setup(() => happy(), { agent: { taskList: 'on' } });
  await on.engine.waitFor(on.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) assert.ok(on.calls[0]!.options.allowedTools.includes(t), t);
  const off = setup(() => happy(), { agent: { taskList: 'off' } });
  await off.engine.waitFor(off.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']) assert.ok(off.calls[0]!.options.disallowedTools.includes(t), t);
  assert.equal(off.calls[0]!.options.allowedTools, undefined);
});
```

Server: PATCH an agent with `{ taskList: 'on' }` → it's stored. `{ taskList: 'maybe' }` → 400 with a message naming `taskList`. `{ taskList: null }` → the setting is cleared back to the default.

- [ ] **Step 2: Run, and expect FAIL**
- [ ] **Step 3: Implement**

```ts
// src/shared/task-list-setting.ts
import { LEAD_AGENT_ID } from '../core/lead.js'; // if shared/ must not import core/, move LEAD_AGENT_ID to shared/ and re-export it from core/lead.ts
import type { AgentProfile } from './types.js';
/** Claude Code's own task tools for this agent's Claude runs: an explicit setting wins; otherwise on for the lead only. */
export function nativeTaskListOn(agent: Pick<AgentProfile, 'id' | 'taskList'>): boolean {
  if (agent.taskList === 'on') return true;
  if (agent.taskList === 'off') return false;
  return agent.id === LEAD_AGENT_ID;
}
```

In `engine.ts buildOptions`: `const native = nativeTaskListOn(agent);`. If `native`, set `options.allowedTools = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']`. If not, add those four plus `'TodoWrite'` to `disallowedTools`. In `server.ts parseAgentFields`, add `taskList: b.taskList === null ? null : oneOf(b.taskList, 'taskList', ['on', 'off'])`, and handle `null` the same way `host` clears.
- [ ] **Step 4: Run, and expect PASS**: `task-list`, `engine`, the server test file, `npm run typecheck`
- [ ] **Step 5: Commit**: `task list: per-agent switch for Claude's native Task tools`

---

### Task 4: Claude runs: hand-over at start, re-show after compaction (`SessionStart`)

**Files:**
- Modify: `src/core/engine.ts` (`buildOptions` hooks)
- Test: `test/engine.test.ts`

**Interfaces:**
- Consumes: `renderForModel`, `renderHandover`, `handoverPending` (Task 1), `nativeTaskListOn` (Task 3)

- [ ] **Step 1: Write the failing tests** (call the hook directly from `calls[0].options.hooks.SessionStart`)

```ts
const sessionStart = (s: any) => s.calls[0]!.options.hooks.SessionStart?.flatMap((m: any) => m.hooks)[0];
const ctxOf = async (hook: any, source: string) => (await hook({ hook_event_name: 'SessionStart', source }))?.hookSpecificOutput?.additionalContext;

test('Claude run after provider changes: the list is handed over once, then the flag clears', async () => {
  const s = setup(hanging, { agent: { taskList: 'on' } });
  // seed: a list a provider run changed
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const store = new TaskListStore(join(s.config.workspaceDir, '.task-lists'));
  const l = store.load(t.id); l.create({ subject: 'from the provider', description: '' }); l.handoverPending = true; store.save(t.id, l);
  const hook = sessionStart(s);
  assert.match(await ctxOf(hook, 'resume'), /make your own list match/);
  assert.equal(store.load(t.id).handoverPending, false);
  assert.equal(await ctxOf(hook, 'resume'), undefined, 'once only');
  s.engine.cancel(t.id); await s.engine.waitFor(t.id, 3000);
});

test('after Claude compacts, the open tasks are shown again; an empty list adds nothing', async () => { /* source 'compact' → renderForModel text; empty list → undefined */ });
test('a Claude-only conversation (no flag, session resumed) gets no hand-over', async () => { /* source 'resume', handoverPending false → undefined */ });
test('task list off: no SessionStart hook is installed', async () => { /* options.hooks.SessionStart undefined */ });
```

Write the three stubs out in full, in the same shape as the first test.

- [ ] **Step 2: Run, and expect FAIL**
- [ ] **Step 3: Implement**, in `buildOptions`, only when `nativeTaskListOn(agent)`:

```ts
options.hooks!.SessionStart = [{ hooks: [async (input) => {
  if (input.hook_event_name !== 'SessionStart') return { continue: true };
  const list = this.taskLists.load(job.taskId);
  let text: string | undefined;
  if (input.source === 'compact') text = renderForModel(list);
  else if (list.handoverPending || (!resume && list.list().length > 0)) {
    text = renderHandover(list);
    if (text) { list.handoverPending = false; try { this.taskLists.save(job.taskId, list); } catch { /* shown again next run */ } }
  }
  return text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : { continue: true };
}] }];
```

- [ ] **Step 4: Run, and expect PASS**: `engine`, `task-list`
- [ ] **Step 5: Commit**: `task list: Claude runs get the list handed over and re-shown after compaction`

---

### Task 5: Task list ≠ board: copy, and the Settings switch

**Files:**
- Modify: `src/core/agent-tools.ts` (`todo_create` description), `src/core/projects/board/prompt.ts` (`BOARD_PREAMBLE`), `ui/src/components/AgentEditor.tsx`
- Test: `test/provider-task-list.test.ts` (description), the board prompt test file (preamble), `npm run typecheck` (UI)

- [ ] **Step 1: Write the failing tests**
  - The `todo_create` description includes `project board`.
  - `BOARD_PREAMBLE` includes `Your task list is your own working checklist`.
- [ ] **Step 2: Run, and expect FAIL**
- [ ] **Step 3: Implement**
  - Add to the `todo_create` description: ` It is private to this conversation; work other agents or the owner should see belongs on the project board.`
  - Add to `BOARD_PREAMBLE`: `'Your task list (TaskCreate…, or todo_*) is your own working checklist for this conversation; the board is shared work. Nothing moves between them by itself: put an item on the board on purpose when others need it.'`
  - AgentEditor:
    - add state `const [taskList, setTaskList] = useState(nativeTaskListOn(existing ?? { id: '' }));`
    - add it to the `fields` dirty-check array
    - add `taskList: taskList ? 'on' : 'off'` to the save body
    - add a fieldset with a check row: `Keep a task list on Claude (Claude Code's own task tools)`, and the note: `On by default for the lead. Newer Claude models plan without a written list; turn this on for agents that run long, multi-step work. Runs on other providers always have a task list.`
- [ ] **Step 4: Run, and expect PASS**, plus `npm run typecheck`
- [ ] **Step 5: Commit**: `task list: the board/task-list split in agents' instructions, and the Settings switch`

---

### Task 6: Verify end to end

- [ ] Full gate: `LEGION_LOCAL_GATE=1 npm test < /dev/null`. Expected: 0 failures (the BSV spend-flow and Blender dispose tests are known to flake under load; re-run alone if one fails).
- [ ] One cheap live Claude check (needs Daniel's OK; costs about a cent): a Sonnet 5.5 agent with `taskList: 'on'`, prompted to plan a 3-step task. Confirm the SDK stream has `TaskCreate` and the checklist fills.
- [ ] A whole-branch code review (one fresh reviewer, Opus); act on it.
- [ ] Update the vault note `06-projects/legion/task-list-design-research-2026-10-12.md` with the decision, then commit and sync the vault (local = origin = VPS).
