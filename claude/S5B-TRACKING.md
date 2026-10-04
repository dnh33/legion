# S5b — live defect: a bot set to full access still gets a "Needs your OK" card

**Status:** INVESTIGATING (Phase 1). Not fixed. No code changed in `src/` yet.
**Branch/worktree:** `fix/s5b-full-access-approval-card` @ `D:\bots\legion-s5b` (from `main` = `d2926d6`)
**Owner report (2026-10-04):** "cause it still shows when a bot has full access perms as i mentioned earlier"

## What "Needs your OK" actually is

`ui/src/components/ApprovalCard.tsx:49` — `<span>Needs your OK</span>` is the header of **EVERY** approval card,
whatever tool it is. So the owner's symptom = an agent with `approval: 'full'` produced at least one
`approval.requested` event it should not have. It is NOT a distinct "full access" card type.

## Phase 1 findings (evidence, not theory)

### The tracker's suspect is INNOCENT
`needsApproval('full', …)` is correct as written. Asserted green in `test/s5b-full-access-card.test.ts` S5b-2.

### The `approvalCeiling` "cap" cannot fire on a UI-started run
- `TaskOrigin.approvalCeiling` is only set for runs started by *someone else*:
  `engine.ts:306 mcpOrigin()` (source `mcp`) or `engine.ts:313 bridgeOrigin()` (another bot).
  A UI-started run has `source: 'ui'` (`server.ts:288`) → **no ceiling**.
- With no ceiling, `engine.ts:732` gives a `full` agent `permissionMode: 'bypassPermissions'` and sets **no
  `canUseTool` at all** → structurally zero cards.
- Therefore a UI-started full agent **cannot** produce a card through the generic path.
- If the owner's failing run *did* carry a ceiling (`ask`), the cap is the confused-deputy guard working as
  designed (`engine.ts:674`), and the real question becomes "why did a full run carry a ceiling".

### Remaining suspects: modules that call `approvals.request()` DIRECTLY
These bypass `needsApproval` and never receive the agent's mode.

| # | Seam | Call site | Mode-aware? | Prior test coverage in `full` |
|---|------|-----------|-------------|------------------------------|
| 1 | browser first page | `browser/tools.ts:83` | **No** — asks in every mode | YES — `browser-tools.test.ts:93` test C9 asserts it deliberately |
| 2 | Blender `exec` | `blender/guard.ts:326` | **No** — no mode argument | none found |
| 3 | Blender asset | `blender/guard.ts:574` | **No** | none found |
| 4 | comms room request | `comms/hub.ts:698 askUser()` | **No** — no mode argument | none found |
| 5 | board `askOwner` | `projects/board/index.ts:54` | **No** | none found |

The browser module is the one place that DOES thread the mode through (`tools.ts:48 mode()`, and
`tools.ts:59/86/156` honour it) — proof the pattern is known and the other four just never got it.

## TIGHT LOOP — RED on the real code

`test/s5b-full-access-card.test.ts`. **The first draft was wrong and was discarded**: it tested a local
`decides()` mirror of the engine, so green proved only self-consistency. It now drives the **real**
`BlenderGuard` and the **real** `needsApproval`.

```
✔ S5b-A  needsApproval returns false for full on every tool it knows (real function)
✔ S5b-B  the confused-deputy cap is real and must survive the fix
✖ S5b-C  DEFECT: blender_exec asked for 1 card(s) from a FULL agent   <-- RED, the owner's bug
✔ S5b-D  ask and auto-edits keep their card (no regression)
✔ S5b-E  a full-mode run still writes its audit record (no record, no run)
```

**S5b-C reproduces the owner's symptom against production code.** `BlenderGuard.exec` calls
`approvals.request(...)` at `guard.ts:326` with no mode argument, so a `full` agent is carded.

## Seam triage (evidence, after reading each call site)

| # | Seam | Call site | Mode-aware? | Verdict |
|---|------|-----------|-------------|---------|
| 1 | **Blender `exec`** | `blender/guard.ts:326` | **No** | **DEFECT — proven red.** No comment, no test, no doc says this must always ask. |
| 2 | Blender asset | `blender/guard.ts:574` | **No** | same shape; a download. Card is arguably the only approval. |
| 3 | comms room tools | `comms/tools.ts:113` | No, **on purpose** | **NOT a bug.** The comment says the card is inside the handler *"so the agent's approval mode cannot skip it"*. Deliberate. |
| 4 | board `delete` | `board/tools.ts:97` | No, on purpose | **NOT a bug.** *"the owner sees an approval card for every delete: nothing is deleted unless they allow it."* |
| 5 | browser first page | `browser/tools.ts:83` | asks in every mode | **NOT a bug** — `browser-tools.test.ts:93` test C9 asserts it in every mode. BUT worth an owner ruling: it is the one place `full` still cards on a plain read. |
| 6 | browser new site / eval | `browser/tools.ts:86/156` | **Yes** (`mode()`) | correct; proves the pattern is known. |

So the mode-blind seams split cleanly: **#3 and #4 are documented, intentional refusals to let mode skip the card.
#1 is undocumented, untested, and red.** #1 is the defect.

## Root cause (Phase 1-3 complete)

`BlenderGuard` is handed `job: ModuleJob` which carries `ceiling`, and the agent profile carries `approval`, but
`exec()` never combines them the way `browser/tools.ts:48` does:

```ts
const mode = (): ApprovalMode => { const m = d.modeOf?.(agent.id) ?? agent.approval;
  return job?.ceiling ? stricterMode(m, job.ceiling) : m; };
```

`guard.ts` has no equivalent, so `approvals.request` fires unconditionally. The **tracker was wrong on both
counts**: `needsApproval` is innocent, and `approvalCeiling` is not capping anything on a UI-started run.

## OWNER RULING (2026-10-04) — the fix is specified

1. **One rule, no exceptions: in `full` a guard never shows a card.** All five seams, including the ones whose
   code comments claimed the mode *cannot* skip the card (comms `tools.ts:113`, board `delete`).
2. **One shared helper every guard must call**, so a future guard cannot forget the mode the way four did.
3. **Live store read on every guarded call** — promoting an agent to `full` mid-task stops its cards on the next call.

My earlier claim that the browser's "first page always cards" was deliberate policy was **wrong**, and the owner
caught it: the same module already skipped the card for a new site (`tools.ts:86`) and for a click (`tools.ts:59`)
in `full`, so asking on the first page was an inconsistency, not a policy. Test C9 had frozen it.

## The fix (all five seams)

| Seam | Change |
|------|--------|
| shared helper | `approvals.ts`: new `guardAsk()` + `decideGuard()`. `full` → no card. `ceiling` still wins. |
| Blender exec | `guard.ts` → `guardAsk`; new `GuardDeps.modeOf` (live read); wired in `blender/index.ts` |
| Blender asset | `guard.ts` → `guardAsk` |
| comms rooms | `hub.ts askUser()` → `decideGuard(mode)` with `ctx.origin?.approvalCeiling` |
| board delete | `board/tools.ts` → local `askOwner` wrapper honouring `modeOf` + ceiling; wired in `board/index.ts` |
| browser first page | `tools.ts:82` → `mode() === 'full' ? true : await ask(...)` |
| agent-facing text | preamble, `browser_open` description and `agent-facts.ts` no longer claim a card in `full` |

**Preserved on purpose:** the audit record is written whether or not a card was shown (`guard.ts` "no record, no
run"), so skipping the card never means an unrecorded script. Confused-deputy ceiling untouched. Browser taint
untouched — a `full` run still reads outside content and is still tainted.

## Verification so far

`test/s5b-full-access-card.test.ts` — 5/5 green. `ask`/`auto-edits` regression asserted (S5b-D). Audit-record
invariant asserted (S5b-E). `browser-tools.test.ts` C9 rewritten to the new rule, keeping the capped-at-ask case.

**Which card did the owner actually see?** The card shows the tool name (`cardTool()` in `ApprovalCard.tsx:30`):
`Room request`, `Download Blender`, `Download asset`, `shortTool(name)` otherwise. The owner's answer
collapses the search space immediately. If the code proves it first, no need to ask.

## Loop status

`test/s5b-full-access-card.test.ts` — 5 tests, currently **green**. It is not yet red-capable: S5b-1..3 assert
the pure decision rules (which pass) rather than driving the four real module seams. Next step is to drive the
actual seams in `full` mode and assert the card count, so the loop goes red on the real symptom.

## STATUS: investigation + fix complete, NOTHING COMMITTED, NOTHING PUSHED

### HARD RULE (owner, 2026-10-04) — read this before any git write
**NO PUSH. NO FORCE-PUSH. NO MERGE TO `main`. NOTHING LEAVES THIS MACHINE WITHOUT THE OWNER'S EXPLICIT APPROVAL.**
Local-only work on the feature branch. `D:\bots\legion` (`main`) stays exactly as found.

### Second defect found and fixed in the same branch: THE BROWSER NEVER LAUNCHES
Owner + 2 agents, 3 hosts, identical error: `The browser did not start: it did not report its debugging port in time`.

**Root cause (reproduced on this machine with real Edge 154, then bisected one variable at a time):**
`buildBrowserEnv` set `USERPROFILE` to the run's temp folder. Edge resolves its own paths through that variable; with
it redirected, Edge logs `Failed to get path from PathService for key: 112` / `Can't retrieve app data directory`,
starts, stays alive, and never writes `DevToolsActivePort` — so the launcher burns its whole timeout and reports the
error. **The browser's own stderr named the cause.**

Probe results (real Edge, 8 variants, one variable each):

| Variant | Result |
|---|---|
| A shipped env (APPDATA/LOCALAPPDATA/USERPROFILE -> temp) | NO PORT |
| B + real LOCALAPPDATA | NO PORT |
| C + real APPDATA | NO PORT |
| **D + real USERPROFILE** | **PORT WRITTEN** |
| E + real APPDATA + LOCALAPPDATA | NO PORT |
| **F + all three real** | **PORT WRITTEN** |
| **G no USERPROFILE at all** | **PORT WRITTEN** |
| H real APPDATA/LOCALAPPDATA + host PATH | NO PORT |

Fix: stop setting `USERPROFILE` (`launcher.ts`). Isolation unchanged — `--user-data-dir` already points at the fresh
temp profile, and APPDATA/LOCALAPPDATA still point into the run folder. **Verified after the fix against real Edge:
port file written, `DevTools listening on ws://127.0.0.1:51698/...`, CDP CONNECT OK.**

## Constraints carried into the fix

- A `full`, **uncapped**, UI-started agent must produce **zero** cards.
- These must keep carding (they are deliberate, and some are owner-chosen wording):
  - browser first page (test C9, every mode) — *unless* the owner says otherwise;
  - any capped run (`ask` ceiling) — confused-deputy guard;
  - Blender downloads (`GET_BLENDER_TOOL`, `BLENDER_ASSET_TOOL`) — the card is the only approval.
- `guard.ts` requires: no record, no run. Any change must keep audit-before-execute.

## Environment notes (do not repeat these)

- `D:\bots\legion` is itself a **linked worktree**; the main repo is `D:\bots\legion-dev\.git`. START-HERE.md
  calls `legion` canonical, which is true for content but not for git-dir location.
- `git switch -c` on `D:\bots\legion` **fails**: a stale sequencer from an abandoned cherry-pick
  (`sequencer/todo`: picks `77fefea`, `d6cea12` — README/branding docs, **never landed in main**). No
  `CHERRY_PICK_HEAD`, so it is an orphaned flag. **Not mine to clear** — owner's call. Use a fresh worktree.
- `git worktree add /d/bots/...` creates a literal `D:\d\bots\...`. **Always pass native `D:/...` paths.**
- Uncommitted S2 WIP in `docs/COMPACTION.md` on `main`; backup at `$TMPDIR/s5b-backup/`. Left untouched.