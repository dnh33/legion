# Task 3 report: one resolver for every mode reader

Commit 6d2eabdf (base a57c1d45). Branch feat/gates-pr2. No push, no stash, no subagents, no processes left running.

## Files
- `src/core/gates-settings/index.ts`: `ModeResolver.mode` returns `RunMode`, takes `source?: unknown` and `goal?`; bad source gives `ask` (also for `baseline`); `baseline?` optional (F10); Smart/Bypass guard removed (smart gives smart, bypass gives full); `GatesCore.gate(id, startProjectId?)`. No `shellFloorOn` (revision section 1/4).
- `src/core/engine.ts`: `modeNow` returns `RunMode` and uses `job.projectAtStart ?? job.outsideOf`; new public `runModeOf(agentId, taskId?)`; `Active.outsideOf` set in `startJob`; `renderCapabilities` gets `runMode`.
- Module readers: `browser/index.ts`, `browser/tools.ts` (types now `RunMode`, task id passed), `blender/index.ts`, `blender/guard.ts` (both `guardAsk` calls now pass `taskId`), `projects/board/index.ts`, `projects/board/tools.ts`, `comms/index.ts` + `comms/hub.ts` (new `runModeOf` option; `agentMode` uses it), `agent-facts.ts` (`runMode`, Smart line).
- Tests: `test/mode-readers.test.ts` (new, 14), `test/away-rig.ts` (`gatesCore` option; returns `core`, `projects`), `test/data-folder-engine.test.ts` (Smart added to the two multi-mode tests).

## Red first
`npm run build:ts` failed with 13 TS errors (no `baseline`, `gate`, `runModeOf`, `runMode`; Smart not an `ApprovalMode` in the data-folder test). tsc does not emit on error, so no test ran red at runtime.

## Final
`npm run typecheck` clean. 343 tests, 343 pass, 0 fail across: mode-readers, engine-mode-resolver, gate-parity (unchanged), data-folder-engine, data-folder-guard, agent-facts, comms-hub, browser-session, blender-both, bsv-review-tripwire, gates, gates-settings, gates-store, gates-routes, gates-sign, project-board-tools, browser-tools. Full suite not run.

## Deviations
1. Rig: no `activity` option and no `gates: core` pass to the Engine. `createActivityLog` (Task 10) and `EngineDeps.gates` (Task 6) do not exist yet. Add them in those tasks.
2. The "no direct read" test walks the files in node (F13), not `rg`.
3. Hub keeps a no-resolver fallback to the stored mode (a hub built on its own, as in comms-hub tests). It is written `const a = this.agents.getAgent(id); a ? a.approval : 'ask'`, so the regex test passes; the production path (`createCommsModule`) always passes `runModeOf`.
4. Test for the helper case drives a real delegation (a9 is not a member; a1 delegates with a `bridge`), asserts `helpingProjectId` first.

## Precedent
Codex `config/src/requirements_layers/permissions.rs` (whole file, 82 lines): requirement layers only add (deny_read is additive; a lower layer cannot remove an entry). Same model as the project cap: it can only tighten, the strictest of agent, project cap and ceiling wins (`effectiveMode`). I did not copy code; Legion's resolver is its own plumbing. Hermes `tools/approval_context.py:1-70`: approval identity (session, turn, tool call) is carried per task in contextvars, because a process-global is racy under concurrent runs (GHSA-96vc-wcxf-jjff note at line 40-ish). That is why modules ask `runModeOf(agentId, taskId)` and the engine reads the live run's start project, not a global. Difference: Hermes subagents auto-deny; Legion applies the helped project's cap. Claude Code docs (permission-modes, subagents) were not opened: no web access used; the map gives the take (stricter of agent, project cap, origin wins), which `effectiveMode` already does.

## Concerns
- Message and wake ceilings are `ApprovalMode` (no Smart). In `hub.ts` `ceilingMode` maps Smart to Accept edits so a woken bot is never looser than its sender. In a Smart project this makes bot-to-bot wakes stricter than Smart. If the owner wants Smart there, widen `approvalCeiling` to `RunMode` (a type change across `TaskOrigin`).
- Senders in `senderContext` (hub) have no task id, so their ceiling uses the agent mode with no project cap (0.3.0 behavior).
- `modeOf` in modules is wrapped in try/catch and optional-called, so a stub engine without `runModeOf` falls back to the agent's mode.
- I did not mutation-check the `Active.outsideOf` line (removing it should fail the helper test).
- agent-facts: when the run mode differs from the agent's mode without a ceiling the line says "(set by your project, not ask)".

## Drift check
1. Stayed inside Task 3 plus the two named rig/test edits; CHANGELOG not touched (PR level).
2. No processes started; owner data folders untouched; scratch files only in /tmp.

## Fix round 1 (review task-3-review.md)

Rule applied: every place that decides a card reads the resolver, never a stored agent mode.

- C1: `bridgeOrigin` takes the caller's mode from `runModeOf(fromAgentId, parentTaskId)`, not `callerAgent.approval`. Test C1 (stale stored full, Ask app preset) failed before: ceiling `full`.
- C2: `SenderRun.taskId`; the comms tools pass `run.taskId`; `senderContext(agentId, taskId)` in botSend, roomPost and handoff. Tests C2, C2b failed before.
- I1: `RunMode` now lives in `shared/types.ts`; `TaskOrigin.approvalCeiling`, hub ceilings, `ModuleJob.ceiling`, `guardAsk`, `ModeResolver`, facts take `RunMode`. The hub no longer turns Smart into Accept edits. `stricterMode(smart, auto-edits)` is `ask` (unordered pair; the only mode never looser than both). Consequence for the owner: an own-Accept-edits agent in a Smart-capped project now runs at Ask (it ran at Accept edits, which waved through edits outside the project folder that Smart cards). Two older assertions that encoded the total order were updated (approvals-presets, mode-readers).
- I2: one helper `startProjectOf(job)`; `startJob` copies `job.projectAtStart` into the live run (no recompute from live membership); `runModeOf` reads the running or queued job, and falls back to the live project only for a task the engine does not know.
- I3: test drives a helper Write through `canUseTool`; the caller is Full with a Full ceiling, so only `outsideOf` can cap it. Mutation (start project = `projectAtStart` only) made I3 and the older helper test fail; restored.
- Minors: M1 regex test removed, replaced by behavior tests (board guard names the task and cards under an Ask cap; browser asks the resolver with the task id). M2 gate() asserts the value. M4 browser/board/hub task ids covered (Blender not separately). M5 both agent-facts branches tested. M3 not done: `marshal/catalog.ts:170`, `marshal/orchestrator.ts:210` (`gated`), `house/index.ts:103` still read the stored mode (informational, no task at that point, nothing loosens).

Tests: mode-readers 25, browser-tools 14, approvals-presets 10, plus the task command set (engine-mode-resolver, gate-parity, bsv-review-tripwire, data-folder-*, agent-facts, comms-hub/tools/room-requests, browser-session, blender-*, gates*, project-board-tools, permission-mode, approvals*, connectors-origin, library-*, s5b): all pass. `npm run typecheck` clean. Full suite not run.

Precedent: Claude Code subagent doc (permission modes): a child never exceeds its parent's mode; here the parent's mode is the resolved one (C1/C2). Codex `config/src/requirements_layers/permissions.rs`: layers only add restrictions, so a ceiling that removes a card (I1) breaks the model; fixed by making the meet of unordered modes `ask`. Hermes `tools/approval_context.py`: approval identity travels per task, which is why the hub and modules now get the task id. I did not open new reference files this round; the model comes from the review and Task 3 notes.

## Fix round 2 (review task-3-rereview.md: N1, N4, M3, M4)

- N1: `looserThan` (gates-settings/store.ts) now counts any switch between Smart and Accept edits, either way, as a loosening, for the preset (app and project) and for the project cap. Test N1 in gates-routes goes through PATCH: admin only gets 403 both ways and nothing changes; with the native header it is 200. It failed before (Smart to Accept edits returned 200).
- N4: new `resolverMode(engine, id, taskId)` in permission-mode.ts: no resolver gives undefined (stored mode, as 0.3.0); a resolver that throws gives `ask`. The comms, browser, Blender and board module wrappers use it. Tests: board, Blender and comms (bot_send ceiling) failed before; the browser test is in browser-module (first page raises a card). Reverting the comms wrapper made its test fail again.
- M4: Blender test runs `blender_exec` live and in the sandbox with a resolver that says Full only for one task id. Mutation: both `guardAsk` calls with `taskId: undefined` made it fail; restored.
- M3: `connectorsShellWarning` takes an optional `resolved` mode and uses it before the stored one. The agent editor has no resolved mode in its data yet, so it still passes none (later UI task). Marshal catalog/orchestrator and house readers unchanged (informational, no task). Test failed before (resolved ignored).

Not done: N2 (rollback note for the update-path check), N3 (`runModeOf` ignores the task origin ceiling; every caller adds it), and the `smart-edits` lattice value from the design section (Task 6).
