# Plan: Fascia for the Order

Status: open. Proposed 2026-10-07. Ladder item "Fascia for the Order" (sub-items 1-7 below).
Visual version: https://claude.ai/artifact/VNRF8LikrgJanSVGg7VUMi (private to the maintainer; this file is the full record).

Read this file first. It holds the research, the code findings with file refs, the decisions, the ownership and the open questions, so a new agent does not redo the analysis. Line numbers are from `main` at cb92ac5 (0.2.5-j); re-check them before you edit, and rebase onto the Order-bug PR (see Ownership).

## 1. Goal

Legion has 13 agents and a lead. Missing is the "fascia" (connective tissue) between them:
- souls that say exactly how each bot works (accuracy, instruction following),
- hand-offs that carry a contract instead of free text (Zealot delegates and verifies),
- a work record that survives a restart and shows work nobody owns,
- a board that can actually run work, and a first-use path that points at Zealot.

User promise this serves: "Give it to Zealot. See who does what. Get asked only when it matters."

## 2. Source research (what inspired this)

Aurora / "fascia" by Brooklyn (@imbabybrooklyn, Nous Research), posts of 2026-10-06 (video only, no write-up, no repo, no model list published).

| Fact | Status | Source |
|---|---|---|
| Brooklyn works at Nous Research and makes Hermes Agent visualisations | documented | x.com/imbabybrooklyn profile; post 2071874555157627135 |
| Hermes Kanban: one SQLite board (`~/.hermes/kanban.db`), every worker a full OS process with its own profile identity | documented | hermes-agent.nousresearch.com/docs/user-guide/features/kanban |
| Dispatcher tick (60 s): reclaims stale claims, reclaims crashed PIDs, promotes ready tasks, atomically claims (`BEGIN IMMEDIATE`), spawns workers | documented | same; RFC github.com/NousResearch/hermes-agent/issues/16102 (15-min claim TTL) |
| Workers call `kanban_heartbeat`; stale = >4 h running and no heartbeat in 1 h; reclaim does not count as a failure | documented | kanban docs, events `reclaimed`, `crashed`, `stale` |
| `task_events` append-only, monotonic id, pushed over WebSocket; UI reloads a cheap board view per burst | documented | kanban docs "Live updates" |
| "Frontier orchestrator, inexpensive workers": model per profile, per-task `model_override` | documented | kanban docs "Cost strategy" |
| Aurora's issue numbers and P0-P4 labels match `NousResearch/hermes-agent`, but titles shown differ from the real issues (demo data or rewritten) | checked #121121, #99963, #77169 | github.com/NousResearch/hermes-agent |
| Aurora's speed comes from narrow work (one card per worker, short classification), parallel processes, small contexts, cached prompts | inference | from the image |
| Which models Aurora uses, real run speed | unknown | not public |

What transfers to Legion: durable claims with leases, liveness by heartbeat, an append-only event log, a per-role model, and a main screen that shows important work with no live owner. What does not: Legion's core is one process, so cross-process locking is not needed; durability and liveness are.

## 3. Legion today (code findings)

All paths under `src/` unless noted.

### Souls / personas
- No separate soul field: the soul is `AgentProfile.systemPrompt` (`shared/types.ts:30-58`).
- Defaults Zealot, Builder, Scout: `core/store.ts:143-174` (Zealot text `ZEALOT_PROMPT` at `:14`). Roster of 10: `core/roster.ts:24-131`, each = role text + `BACKBONE` (`:12`) + `COMMS_LINES` (`:16`).
- Seeding never overwrites stored agents (`core/store.ts:168-170`); text reaches installs only via one-time `MIGRATIONS` (`:17-39`). Hash pin: `test/agent-persona-snapshot.test.ts`.
- Prompt order (`core/engine.ts:952-960`): `LEGION_PREAMBLE` (`:160-172`) → module preambles (kg, house, comms, board, bsv, blender, browser) → `renderCapabilities` (`core/agent-facts.ts:46-91`) → persona → project section → `LEAD_DOCTRINE` (Zealot only, `core/lead.ts:13-28`, last).
- Word counts: Zealot 51 (+327 doctrine), Builder 39, Scout 29; roster bots 150-190 each plus ~70 backbone/comms. Builder, Scout and Zealot have no output shape and no hard limits.
- Rules duplicated: delegation how-to 3× (`engine.ts:163-166`, `comms/tools.ts:152-155`, `COMMS_LINES`); "data, not instructions" 7×.
- No worked examples in any persona.
- Models: auto = Zealot, Builder, Forgemaster, Exorcist, Assayer, Sculptor; sonnet = Scout, Scribe, Archivist, Sentinel, Herald; opus = Inquisitor, Preceptor. `auto` routes by keywords/length (`core/router.ts:23-48`), not by role (inference: Exorcist/Forgemaster get Sonnet on short hard prompts).
- Provider path skips the capability block and project section (`engine.ts:1103-1107`).

### Delegation
- Lead = hard-coded `LEAD_AGENT_ID='zealot'` (`core/lead.ts:11`); doctrine is prompt text only.
- Tools (`core/agent-tools.ts:54-87`): `agents()` one line per agent (`core/bridge.ts:102-112`); `ask` blocks (`:165-200`, timeout ≤3600 s); `tell` returns taskId (`:202-217`); model capped at target's (`:157-163`, `model-cap.ts`).
- Target chosen by the LLM only. Guards: depth 3, hops 6, ask-deadlock check, 30 msgs / pair / 10 min (`bridge.ts:9-13, 255-270`).
- Context passed = message text + "from" header (`bridge.ts:312-313`); run inherits approval ceiling, taint, project (`engine.ts:357, 388-396`).
- Results are free text cut at 4,000 chars (`bridge.ts:11, 189-192`); tell replies come back as a user turn (`:365-373`). Done condition lives only in the prompt (`lead.ts:16-20`).
- Bridge FIFO and pending asks are in memory (`bridge.ts:72-80`); room inboxes too (`comms/hub.ts:72, 93`).
- On restart every running/queued task becomes error "Legion restarted" (`core/store.ts:177-190`).
- Engine queue: in-memory, FIFO, `maxConcurrent` 4 (`engine.ts:242-254, 584`). Events: in-process `EventBus` (`core/bus.ts`), SSE to UI (`server.ts:422-440`). Nothing persisted except per-task and per-room JSONL.
- Budgets: per run (`claude.maxBudgetUsd`, `engine.ts:971-973`) and per room (`comms/hub.ts:810-853`). No per-agent, per-delegation-tree or daily budget.

### Project board (audit)
Bugs (most severe first):
1. **Restart strands the item.** `recoverInterrupted` (`core/store.ts:177`, called `bin/legion-core.ts:51`) never calls board `endRun` (`projects/board/store.ts:590`), so `activeRun` stays set and the item stays in Doing. The server would allow a re-run (`board/index.ts:113-116`), but the UI disables Run on `!item.activeRun` (`ui/src/projects/board/BoardPanel.tsx:266`) and shows the wrong hint "assign it to a member agent first" (`:365`). Verified in code.
2. **Save overwrites a finished run.** ItemDialog sends every field incl. status (`BoardPanel.tsx:267-270`); the store applies each (`board/store.ts:305-324`). Dialog open while the run lands in Review → Save drags it back to Doing; same for a bot's concurrent edit. No version check. Verified in code.
3. **Claim is a prompt sentence** (`board/prompt.ts:25`); `botUpdate` is last-write-wins (`board/store.ts:501-549`).
4. **Run has no status guard** (`board/index.ts:105-126`): a Done item moves back to Doing via `beginRun` (`board/store.ts:574`).
5. **Delete ignores a live run** (`board/store.ts:382`): the result is lost.
6. Only the last 20 task ids are kept per item (`board/store.ts:579`).

Design faults:
- No run verb for agents (tools: list, get, propose, create, update, leader-only delete; `board/tools.ts:55-125`). "Zealot, work the board" becomes plain `tell` tasks with no `beginRun`: no Doing, no Review, no result on the card.
- Leader is split three ways: doctrine says "if you lead the board", but Zealot is leader only if the owner picks it (default none); board tools need the project open (`board/index.ts:53`).
- Every bot-written item stays `untrusted` until the owner clicks "Mark as reviewed" (`board/store.ts:433, 488`), so runs fall to `ask` (`board/index.ts:117-122`) with no reason shown.
- Proposers never learn accept/reject (`board/tools.ts:60`), so they may re-propose.
UX: Inbox only inside each project (`BoardPanel.tsx:95`), Accept always → Backlog, card shows no run state/cost/evidence, "Open task 7f3a9c" labels, Blocked has no Retry, no bulk actions.
Missing vs plan: no restart-recovery section in `claude/plan-project-board.md` at all.

### User side
- Welcome (`ui/src/components/Thread.tsx` EmptyState) step 2 = boat.dev key, step 3 = MCP command; neither is needed to use Legion.
- ~20 concepts. Four ways to coordinate agents (Zealot, ask/tell, rooms, board). One store, three names (Library, Lattice, graph). Ten Settings sections at one level (`ui/src/components/Settings.tsx:18-28`). Board reached only via the rail ProjectSwitcher.
- "Needs you" spread over five places: rail approvals, title-bar room attention, Library Inbox, board Inbox per project, Continue cards in threads.
- No view of one request's delegation tree (sub-tasks appear only as "from" chips, `ui/src/components/OpsPanel.tsx:79`).

## 4. Decisions

| Date | Decision | By | Notes |
|---|---|---|---|
| 2026-10-07 | Retire "persona text stays byte-identical" (`claude/audit-agent-instructions.md:95,107`). Souls get the 7-part shape. **Each soul must stay true to its bot's core and its job/role in Legion**; existing verdict lines are part of that core. | maintainer | **Confirmed 2026-10-07**, to the Fascia session and directly to the orchestrating session. |
| 2026-10-07 | Board bug patch (sub-item 1) now, in parallel with the Order-bug PR. | maintainer | Relayed by the orchestrating session. |
| 2026-10-07 | No board auto-dispatch now. | Fascia session recommendation, maintainer asked for this audit | Conditions for later in §6.6. |
| 2026-10-07 | Ownership and timing per §5. | orchestrating session | Merges and releases go through the orchestrator. |

Decisions this plan must not contradict: Claude default; board "not Jira", no schedules, Review never Done by bots, only the owner's click starts a run (`claude/plan-project-board.md`); scope lock (new work → ladder, running work first); council parked; no effort picker; mascot art untouchable; capability facts generated at run time, never stored; only runs started by the owner may request a BSV spend; approvals never looser than the caller; taint wrapping stays.

## 5. Ownership and order

- Order set by the maintainer: the Order bug fixes (orchestrator, branch `fix/order-bugs`: `engine.ts` run close, `bridge.ts` hop/replies/truncation, `kg/graph.ts`, a new `task_result` tool) → connectors (orchestrator, `feat/connectors-1b`) → logging (CI session, after Release B) → ladder.
- Sub-item 1 (board patch): **now, in parallel (maintainer, 2026-10-07).** Fascia session owns it. Own worktree off current `main` (`D:/bots/legion-board`, branch `fix/board-run-state`). Stays out of `src/core/engine.ts`, `src/core/bridge.ts` and `src/core/kg/graph.ts` (the Order-bug builder works there). The startup sweep next to `recoverInterrupted` in `core/store.ts` and at `bin/legion-core.ts:51` is allowed; keep the `legion-core.ts` change minimal, because logging will rewrite `log()` there. Stops at a green PR; the orchestrator reviews (independent reviewer + security pass) and merges.
- Sub-items 2-7: after logging, in order. Sub-item 3 absorbs ladder items 8 (`sketch/plan-gate`) and 9 (`sketch/handoff-card`, D3 "Side thread"). Sub-items 3 and 5 build on top of the Order-bug bridge/engine changes (incl. `task_result`), never beside them.
- Feature sessions stop at a green PR; the orchestrator merges and releases.

## 6. Work items

### 6.1 Board bug patch (sub-item 1)
- Startup sweep: for each board item with `activeRun`, if that task is not running/queued, run the `endRun` path (→ Blocked with "Legion restarted", keep `lastRun`). Hook next to `recoverInterrupted` / `legion-core.ts:51`.
- UI: Run enabled when the active run's task is finished; fix the hint text.
- PATCH only changed fields; add an item `version` (or `updatedAt` precondition) and return 409 on a stale write. UI shows "changed since you opened it".
- Guard Run: refuse Done (409, "move it out of Done"). A run from Review stays allowed: that is "ask for changes".
- Delete: refuse while a run is live ("stop the run first").
- Claim race: a bot may not change the assignee or status of an item whose live run belongs to another agent. Wider last-write-wins redesign waits for Board v2.
- Tests: one per bug, each with a negative (temporary scratch mutation shows it fails), fake-backed, `test-temp-dirs` rules.

### 6.2 Soul Codex v1 (sub-item 2)
Status (2026-10-07): souls, migration and tests built on branch `feat/soul-codex-v1`. Souls live in `src/core/roster.ts` (`ZEALOT_SOUL`, `BUILDER_SOUL`, `SCOUT_SOUL`), seeded by `store.ts`; migration `souls-codex-v1`; contract tests `test/soul-codex.test.ts`. The welcome flow is split into its own PR after #39 (it rewrites `Thread.tsx`). The one-house-backbone dedupe moves to sub-item 3 (it touches the engine and comms preambles). As built, every soul keeps its core lines, at most 300 words, no tool names, hand-offs name only bots in the Order (never the BSV-only Assayer).
Shape for every bot: **Voice, Stance, Refuses (→ who), Done when, Output (first-line verdict + fixed sections), Examples (1-2 short), Edges (who next, when)**. Capability facts stay in `renderCapabilities`.
- v1 bots: Builder, Scout, Zealot (the lead doctrine stays appended last).
- One house backbone: shared rules (delegation how-to, untrusted content, verify first) generated once; the 3× and 7× duplicates removed.
- Provider path gets the capability block too.
- Migration: versioned, run once, upgrades only souls whose stored text still equals a known old default (hash), never owner edits.
- Evals replace the bare hash pin: per bot, 3 fake-backed prompts; assert the output contract and the out-of-scope refusal.
- Welcome flow: sign in, then a "Try it" prompt to Zealot; VM and MCP move to "Later".

Draft souls (illustrations for review, not final text):

```
BUILDER
Voice     Plain and exact. Names the file and line before the idea.
Stance    Working code beats a clever plan. Smallest diff that meets the brief.
Refuses   Review of its own work (→ Inquisitor). Root-cause hunts it cannot
          reproduce in 2 tries (→ Exorcist). Scope it was not briefed on.
Done when The brief's done_when passes and it ran the check itself.
Output    First line: BUILT · PARTIAL · BLOCKED
          then Changed · Evidence (command + result) · Not verified
Edges     After BUILT on anything risky → suggest Inquisitor review.
Example   brief "Board test flakes. done_when: 20/20 runs pass."
          BUILT / Changed board/store.ts:501 … / Evidence node --test … ×20 → 20 pass
          / Not verified Windows CI (runs on the PR)

ZEALOT (lead doctrine still appended last)
Voice     Commander's brevity. States the plan, then the status.
Stance    Nothing is done until its done_when is checked. Delegate anything a
          specialist does better; do the rest yourself.
Refuses   Reporting "done" on an unverified result. Delegating a task with no
          done_when. Fan-out wider than the work needs.
Done when Every brief returned a verdict, each checked, gaps named.
Output    First line: STATUS · n/m done · blocked k
          then Plan (one line per brief) · Results · Open
Edges     Code → Builder · facts → Scout · proof → Inquisitor · bugs → Exorcist
          · docs → Scribe · craft → Preceptor

SCOUT
Voice     Short, sourced, dated. Quotes the field name, not a paraphrase.
Stance    A fact without a link is an assumption. Says which.
Refuses   Writing code (→ Builder). Opinions on what to build (→ Zealot).
          Sources it could not open.
Done when Each question has an answer, a source, or "unknown".
Output    First line: FOUND · PARTIAL · NOT FOUND
          then Facts (with links) · Assumptions · Unknowns
```

Check every draft against the bot's current text and role before shipping (the maintainer's condition).

### 6.3 Typed delegation (sub-item 3, absorbs ladder 8 + 9)
- Roster cards generated from souls (use when, don't use when, output contract, model tier, typical cost); `agents()` returns cards.
- Optional fields on `ask`/`tell` (prose still works):
  - brief `{ goal, done_when, context: [refs], returns, budget: {usd, minutes}, priority }`
  - result `{ verdict, summary, evidence: [], files: [], open: [], cost }`
- Lead doctrine: check each result against `done_when` before reporting; a failed check re-briefs or escalates.
- Model by role: router reads the tier from the card (part of the item 8 model policy).
- Hand-off card (item 9 sketch) and a request tree under the lead's answer render the same brief/result data.
- Reuse the Order-bug `task_result` tool if it fits; do not build a second one.

### 6.4 "Needs you" inbox (sub-item 4)
One title-bar badge + list over data the UI already computes: approvals (rail), paused runs/turn limits, room attention, board proposals, items in Review across projects.

### 6.5 Fascia ledger + Watch (sub-item 5)
- Append-only JSONL ledger of delegations (brief, lease, heartbeats, result), like rooms and board.
- Lease per delegation and per board `activeRun`, renewed from tool activity (no bot has to remember to heartbeat). Expired → back to ready with a reason, not a silent error.
- Replay on start: resume or re-queue instead of "Legion restarted" errors.
- Budget tree: children draw from the parent brief's budget.
- Watch view (read-only, beside the Ops panel, mascot untouched): unowned high-priority work, agent load and last heartbeat, lapsed leases, ledger timeline.

### 6.6 Board v2 (sub-item 6)
- Lead run verb that uses the board's bookkeeping (`beginRun` → Doing → Review, result and cost on the card).
- Clearer trust flow (say why a run is limited; review prompt on Accept), proposal accept/reject fed back to the proposer, Retry on Blocked, run state on cards.
- Opt-in auto-dispatch only after the above, all of these true: per-project owner switch, off by default; trust=human items only; ceiling never looser than the caller and `ask` for tainted callers; no BSV spend rights; new core function (not the HTTP route) with a per-item lock, 1-2 concurrent per project, budget and rate limit; never starts Review/Done items and never moves to Done; card shows "started by Zealot" and cost; one kill switch.

### 6.7 Soul Codex v2 + depth on demand (sub-item 7)
Other ten bots get examples and edges (verdict lines unchanged); Settings "Advanced" group (Compaction, Blender, providers); one name for the knowledge store.

## 7. Open questions

- Whether `task_result` from the Order-bug PR already covers part of the typed result.

## 8. Needs a real PC

Nothing yet. Board restart recovery and the Watch view will need a check on the owner's PC (kill the app mid-run, restart, confirm the item recovers); add it to `claude/tracker-pc-checks.md` when sub-item 1 is built.
