# Task 6 report: the engine reads gates; the floor stays always on; smart-edits

Commit 6ab592a3 (base 66c9df92). No trailer. No stash, no push, no subagents. No process left running. Nothing under ~/.legion, %APPDATA%/legion or %LOCALAPPDATA%/Programs/Legion was read; no Electron.

## Failing counts first
The new files did not exist before, so "red" is shown by mutation of the built engine (each restored, `cmp` clean):
- remove the `tool-cards` switch-off line: 1 of 10 fails (tool-cards override test)
- stop computing the Smart consequence: 3 of 10 fail (Smart project, Smart folder, Accept-edits-in-Smart)
- stop honoring `gate-rules-ask`: 1 of 10 fails
- first run of the rails test (before the engine change) failed on the 'engine reads gates by id' and smart-edits cases; the first engine-presets run failed the Accept-edits-in-Smart test (`resolver gave 'ask'`, not `'smart-edits'`).
Existing tests that asserted the old meet (Smart x Accept edits = Ask) were updated on purpose: approvals-presets, mode-readers (3 assertions).

## Final counts
`npm run typecheck` clean. `npm run build:ts` then 29 files (engine-presets 11, rails 6, gate-parity, bsv-review-tripwire, engine-mode-resolver, mode-readers, data-folder-engine, approvals-presets, plus the Task 3 24-file set, gates-registry, gates-ipc, gates-describe, engine): 659 tests, 659 pass, 0 fail.

## What changed
- `EngineDeps.gates?: Pick<GatesCore, 'gate' | 'switchedOff'>` (the `modes` dep stays). `gateOn(job, id)` helper reads the gate for the START project.
- `toolDecider`: `decideGate(..., gateOn('gate-rules-ask') ? mode : 'full', capped)`; shell floor unchanged and before everything; then tool-cards switch-off returns allow; then gate allow; then `needsApproval(mode, tool, { capped, consequence })` where consequence is computed for `smart` and `smart-edits` with the same `askExtras` classifier call the card uses.
- Fifth internal mode `smart-edits` (Task 3 re-review DESIGN RULE): `RunMode` in `src/shared/types.ts`; `stricterMode` (ask wins, equal gives itself, full gives the other, any other pair gives smart-edits, unknown gives ask); `needsApproval('smart-edits')` = edits card at level 3 or above, every other non-read non-Legion call cards; `decideGuard('smart-edits')` cards (default branch); `agent-facts` has a plain line for it. Readers that test only `=== 'full'` need no change; `=== 'ask'` readers (capped) no longer fire for an internal Smart x Accept-edits chain (was an over-restriction).
- `shellFloor()` is NOT edited (Strike). No `shellFloorOn`, no switch. The Bypass-start branch is unchanged: its demoted hook already runs `toolDecider` for every non-full mode, Smart included (test proves a demotion cards).
- `test/gates-rig.ts` (new, shared) and `test/away-rig.ts` passes `gates: core` to the Engine.

## Deviations (and why)
1. New `GatesCore.switchedOff(id, projectId)` (true when the gate is off while the preset's own value is on). The brief's plain `gateOn('tool-cards')` makes Bypass (preset default off) skip the card for an agent set to Ask, which its own test 'an agent set to Ask explicitly in a Bypass project stays Ask' forbids. Only an owner override that turns the cards off removes them for every agent. `gate-rules-ask` uses the plain gate (under Bypass an own-Ask agent still cards through the baseline, so no difference).
2. The tool-cards switch-off does NOT apply when the run carries a ceiling (`job.origin.approvalCeiling`): a project setting must not lift a ceiling from an outside app or another bot (rail-ceiling). Test: 'tool-cards off does not lift a ceiling'.
3. Brief test 'rails: every rail has no switch except the shell floor' follows the Strike: no gate is `expert`, every rail is `always`, and the store refuses an override on `rail-shell-floor` and a `shellFloorOff` body (400). The revision's 'rg of src for shellFloorOff is empty' cannot hold: Task 4's store keeps the refusal text, so the test walks src outside `gates-settings` for `shellFloorOn|shellFloorOff|floorOn`.
4. No `shell-floor.test.js` in Step 4 (F24).

## Precedent
Opened and read: Hermes `tools/approval_detection.py` (HARDLINE at 107, "never bypassable" at 200) and `approval_floors.py` (98, 23): the floor fires before yolo and before allow rules; our `shellFloor` already sits before the gate allow and the baseline in both the decider and the Full hook, unchanged. Codex `core/src/exec_policy.rs:777-830`: danger check first, approval policy second (same order as ours); `is_dangerous_command.rs:38` unwraps `bash -c` wrappers (depth 8): our test list includes `bash -c "rm -rf ~"` and `sh -c 'rm -rf /'` and both are refused in all four presets, so Legion's floor does unwrap. Claude Code permission-modes (bypass, most restrictive wins) is the source of the either-card rule. Differences: Legion has a fifth internal mode to carry the "either" rule in single-value fields (ceilings, hub batches), where the references have one linear order. Claude Code doc page not re-opened in this task (the rule came from the Task 3 re-review).

## Shared helpers in test/gates-rig.ts
Built now: `gatesRig(opts)` (real core, one idle run, project preset/limit/own/follow/overrides/ceiling), `call`, `run` (decision plus whether a card was raised, answered "no"), `hook` (Claude-path PreToolUse hooks), `pending`, `answer`, `tick`, `setMode`, `setRules`, `projectDir`, `setGateOverride`, `noteUse`, `advanceApprovalTimeout` (needs the rig built with `approvalTimeoutMs`), `noKeyStore`, `keyedStore`, `idle`, `pause`.
Stub list for later tasks (not written, they need code that does not exist yet): `rulesFile` (T16 rules file), `useNoKeyCore` (needs an away-rig `keyless` option; T17), `activityRead` (T10 activity log), `noteSecretRead` (T17/T24), `browserOpenNeedsCard` (T20), HTTP `answer(...)` returning a Response (T20 builds it on its own route).

## Concerns
- `smart-edits` is persisted in `TaskOrigin.approvalCeiling` like `smart` (rollback note N2 of the Task 3 re-review now covers both).
- Smart x Accept edits as a project cap or bridge ceiling now cards less than the old Ask meet (in-project edits run); never looser than either mode (tested per call against `smart || auto-edits`).
- The UI package was not touched; `ui` typecheck clean, no UI code reads `RunMode` literals beyond what compiled.
- The data-folder guard and the Task 5 preview are unchanged.

## Drift check
Stayed inside Task 6 files (engine, gates-settings index, approvals, permission-mode, types, agent-facts, three test files, two touched test rigs/tests). Context well under the 150k stop. Ask unchanged: gate-parity green (552-row fixture).

## Fix round 1

Fixed in order, each test written first and seen red on 6ab592a3.
- **I3:** the `tool-cards` allow in `toolDecider` now applies only when the gate verdict is not `ask`. An ask rule on Read and on Bash still cards with tool cards off.
- **I1 and M1:** a new `asksSkipped(job)` uses `switchedOff('gate-rules-ask')` and is exempt on a run with an outside ceiling. A Bypass preset alone keeps the ask rules of an agent that keeps its own Ask or Accept edits. Only an explicit owner override turns them off. `gateOn` had no callers left and was removed. Side effect: an override of `false` inside a Bypass project equals the preset default, so `switchedOff` is false and ask rules stay. That is stricter, and it is inert for agents that follow Bypass (they judge as full). The Bypass dialog line "Your ask rules are skipped" is registry text per gate. It is true for agents that follow the project and over-warns for own-mode agents, so I left it.
- **I2:** `gates: gatesCore` added to `new Engine({...})` in `src/bin/legion-core.ts` and `scripts/harness/core-entry.mjs`. New test in `armory-wiring.test.ts` checks both lines (modes and gates). Verified by source check, not a boot.
- **M2:** agent facts print "Accept edits with Smart checks" and keep the provenance suffix. **M3:** rig `ceiling?: RunMode`.

Tests: engine-presets (3 new), armory-wiring (1), agent-instructions (1). Run via dist: agent-instructions, armory-wiring, gate-parity, bsv-review-tripwire, engine-presets, mode-readers, approvals-presets, engine: 231 of 231. Typecheck clean.

Precedent: kept the Task 6 references (Hermes hardline floor, Codex danger check, Claude Code most-restrictive-wins). The fixes follow the repo's own `switchedOff` pattern for tool cards. No new outside mechanism.
