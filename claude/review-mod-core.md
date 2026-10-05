# G3 review: Legion Mod Phase 1 core

**Verdict: NOT SAFE TO SHIP.** I found 8 bugs with evidence, 3 that appear under conditions, and 1 missing required test.

- **What I reviewed:** commit `4a552b2`, which was HEAD when the task started. I reviewed it as a `git archive` export, because other sessions were editing `legion.tsx`, `index.d.ts` and the UI during the review. HEAD then moved to `2e8e2d8` (4 commits: 2D Order, Zealot as lead, "delegate inside the Order"). Where a later commit changes a finding, the finding says so.
- **Scratch tests:** `<scratchpad>/review-ws/head/mod/test/review/*.spec.ts` and `.../test/plugin/review-*.test.tsx`.

## Gates (re-run by me)
| Gate | `4a552b2` export | `2e8e2d8` export | working tree (in-flight art) |
|---|---|---|---|
| node specs | 153/153 | 191/191 | 184/184 |
| `plugin test mod` / `mod-runner` | 23/23 (3 files) / 4/4 | 27/27 / 4/4 | 23/23 / 4/4 |
| tsc node / runner | 0 / 0 errors | 0 / runner unchanged | 0 / 0 |
| validate mod / runner | pass / pass, 0 `$.process` and 0 `$.http` calls | mod pass, 0 `$.process` and 0 `$.http` calls | same |

- **Vendor:** `node scripts/build-mod.mjs` leaves `git status` clean. All 14 files are byte-equal after the `.js→.ts` transform, and no unlisted files exist. The committed test, run from a `dist/test` junction in scratch, passes 16/16. A 1-line drift makes 1 test fail.
- **Runner calls:** spawn, `session.send`, `tool.call(TaskStop)` and `state`. A spawn requires `/^legion-mod:…$/`. Resume and stop do not check the agent type (P4).

## Verdicts
| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1a | legion-mod never spawns, resumes or stops a run itself | HELD | grep of `mod/` finds no `agent.spawn`, `session.send`, `TaskStop` or `$.tool.call`; validate agrees. A tell reply uses `$.session.append`, which appends a row and starts no loop (d.ts:2668-2677). |
| 1b | Forwarding a Legion agent's Agent call through legion-mod's `tool.call` `next(e)` does not blind legion-mod | UNVERIFIABLE-here | Evidence for: d.ts:149-154 sets `spawnedBy` only for `$.agent.spawn` or a plugin's own Agent `$.tool.call`, "absent when the model or the person did"; live E2E (2) adopted a model-started run. **Missing test:** plan §2.1's "ask/tell-started run's Bash still gets a card, negative = inline spawn". No `tool.check` test exists. |
| 2a | No spec carries `bypassPermissions` | HELD | `permissionModeFor` returns only default, acceptEdits or auto; `buildAgentSpec` is the only path. |
| 2b | `tool.check` only adds asks | CONFIRMED-defect | Bug 1 below. |
| 2c | The `extraAsk` table matches the desktop | HELD | It equals desktop `needsApproval` (approvals.ts:94-102) minus VM, browser and Blender. |
| 2d | Legion's ask is a card for you under `fullMode: 'auto'` | UNVERIFIABLE-here | d.ts:11904-11906 says an `ask` goes to the auto-mode classifier, so the bridge ceiling there is decided by the classifier. |
| 3a | Bridge constants and guard order equal the desktop | HELD | 3/6/30/10 min/4000 and the order match desktop bridge.ts:9-13, :234-267. |
| 3b | The deadlock guard works | CONFIRMED-defect | Bug 6. |
| 3c | A denied ask really denies | HELD | `return {deny}` refuses the call. A throw earlier in the hook fails open (P3). |
| 4a | The runner acts once per id | HELD | runner tests and code reasoning |
| 4b | The runner never acts on stale requests | CONFIRMED-defect | It skips them but drops them silently (bug 4). |
| 4c | The runner refuses foreign types | HELD for spawn | Resume and stop are not checked (P4). |
| 4d | A legion-mod hot reload causes no double spawn | HELD | A reload cancels timers (d.ts:3195) and fires `session.start` again (d.ts:3984-3990); `boot` re-applies the queue and results. |
| 4e | A legion-mod reload never duplicates a task | CONFIRMED-defect | Bug 3(b). |
| 4f | A runner reload mid-spawn does not spawn twice | UNVERIFIABLE-here | If `spawn` resolved but `record()` died with the old environment, the new tick spawns again (a double spend). The same happens if `RESULTS_KEPT=200` slices off a result whose request is still queued. Fix: write an in-flight marker before `perform`; on boot, answer an in-flight request with no result `ok:false` "outcome unknown". |
| 5a | Concurrent appends, compaction during refresh, double adoption, tombstone order and a torn tail lose and repeat nothing | HELD | ADV2 and ADV3 pass. Negatives: M5 (segment-log.ts:580 removed, adopter drops the dead writer's records) fails ADV2; M3 (stores.ts:48 delete always dropped) fails ADV3 ("resurrected on disk"); both reverted. |
| 5b | Two windows with the same session id | CONFIRMED-defect (conditional) | Bug 9 (ADV1) |
| 5d | A kill during a segment rewrite | CONFIRMED-defect (conditional) | Bug 10 (ADV4) |
| 6 | Secrets and paths | HELD | Env reads are only `HOME`, `USERPROFILE` and `LEGION_MOD_HOME`. All paths pass `safeRelPath`, `SAFE_ID` and `checkSessionId`. Nothing touches `~/.legion`. |
| 7a | The turn limit uses this run's turns, and Continue resets it | HELD | legion.tsx:647 passes `runTurns`; runs.ts:131 and :134 reset it; ADV6 passes. |
| 7b | Steps that come before a resume result is applied count toward the limit | UNVERIFIABLE-here | Those steps are reset away. Bug 3's fix covers it. |
| 8 | No error is swallowed silently | CONFIRMED-defect | Bugs 2, 4, 5, P1, P2. |

## Bugs, ranked by impact (line numbers on `4a552b2`; fix)
1. **A person's deny rule becomes an ask.** `tool.check` returns `ask` (legion.tsx:594-595) or `allow` (:589) without `next(e)`, and d.ts:11937-11942 says "the last word up the chain is the decision". Proof: "G3 check: deny rule on Edit" receives `ask`. Plan §2.1 says "proved by S3", but §1b records no S3 result, and S3's pass line ("we only escalate to ask") is exactly this escalation. Fix: `const v = await next(e); if (v.decision === 'deny') return v`, then ask only when `v.decision === 'allow'` and `needsApproval(effective)`. This uses the engine's real verdict instead of the `engineAsks` model.
2. **The pane says "stopped" while the agent runs and spends.** :199 ignores a failed stop. A `/stop` on a queued task while the runner is mid-spawn: :179 drops the request, :191-192 ignores the result, and the run is adopted as a new task. Fix: on a failed stop, post a band error and restore `running`; when a spawn result arrives for a cancelled request, queue a stop for that run.
3. **Ghost duplicate tasks stuck "running" forever.** (a) The spawned run's first step or tool call comes before the runner result; proof "G3 race" ends with 2 tasks. (b) Events during `boot` before `byRun` is rebuilt (:260-266). Fix: `adopt` returns undefined while `!isReady`; if `info.spawnedBy === 'legion-mod-runner'`, bind to the pending spawn with `req.name === info.name`; `onResult` does not re-apply `started` (that resets `runTurns`). Proven: the test passes with this fix.
4. **A request can stay queued forever with no word to you.** A failed spawn: :200 sends `runId: ''`, which runs.ts:148 ignores because `'' !== undefined` (ADV5: stays `queued`). A stale request: register.ts:93 writes no result, so the runner polls at 200 ms forever. Fix: add a `failed` event; the runner records stale requests as `ok:false`; legion-mod times out pending requests and says the runner is missing.
5. **Stored thread replies are overwritten after a hot reload.** Row ids come from `rows.length` (runs.ts:194, :213, :231). After a reload, `apply` starts from `[]` (:97), and `openTask` (:317) never loads the stored rows. ADV7 loses "reply one". Fix: take ids from the event (a uuid or `newId`), or load the thread before the task's first event.
6. **The deadlock guard never fires.** legion.tsx:564 passes run ids (:567); bridge.ts:112 tests task ids. Proof: "G3 deadlock". Consequence: extra runs bounded by depth 3, not a hang; still dead on `2e8e2d8`. Fix: map run ids to task ids. Proven: the test passes with this fix.
7. **The approval ceiling could be laundered through a non-Legion agent.** `adopt` checks only the direct parent (:223). **Fixed for Legion callers on `2e8e2d8`**, which refuses non-`legion-mod:` types.
8. **Missing test:** the §2.1 card test, with its inline-spawn negative (see 1b).
9. **Conditional: same session id in two windows loses records** (ADV1), for example `claude --resume <id>` twice. Fix: writer id = session id plus a random suffix kept in `$.state`.
10. **Conditional: a kill during a segment rewrite loses up to 1 MiB** (ADV4). The d.ts does not promise atomic writes. Fix: a smaller active segment, or a ping-pong pair.
11. **Conditional: a runner reload mid-spawn spawns twice** (4f).

## Polish
- P1. A failed `boot` leaves "still starting" forever (:421, :508). Keep and show the error.
- P2. Errors from `refresh` (:302) and the runner tick (register.ts:97) go to the debug log only.
- P3. A throw in `adopt` or `apply` before the guard skips the hook (d.ts:3658-3660), so the guard fails open. Fail closed for `legion-mod:` targets.
- P4. Runner resume and stop act on any run id. Check `agent.list` type `legion-mod:` first.
- P5. The `liveAt` throttle is global (:620), so concurrent streams starve each other.
- P6. `/say` into an old task adds no user row. `toolRun` and `applied` never shrink. Agent types are not re-registered when `maxTurns` or `fullMode` change. `TaskStore.refresh` does not refold on removal only.
- P7. `$.settings.read()` reads the whole settings object, `env` included, for `theme` alone (:271).
- P8. The `allow` branch for `agents` is unreachable, because its own `tool.call` answers first. Answered plugin tools skip the permission core, so Phase 2 write tools need their own check. `mod-vendor.test.ts` works only from `dist/test`.

## Needs a real PC
Add each to `claude/tracker-pc-checks.md` (safety class: none, a few cents of tokens each): (1) Continue wakes a completed agent (`session.send`, `isDelivered`); (2) `maxTurns` per resumed run; (3) `TaskStop` through `$.tool.call` prompts or not; (4) a tell reply appended mid-tool-call keeps the tool_use/tool_result order; (5) `--resume` twice shares the session id; (6) kill the terminal during writes; (7) bug 3's race on the real engine (20 `/to` runs, then check `tasks/`); (8) dialogs for deny and ask under ask, auto-edits and full (S1, S2, S3).
