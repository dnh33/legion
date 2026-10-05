# Plan: 0.2.5-c (owner 2026-10-05)

Base: `release/0.2.5-b` once merged. Branch: `fix/long-task-turn-limit`, rebased onto it and renamed `release/0.2.5-c`.
Scope (owner): the test-suite work already on the branch, and every gap the 0.2.5-b council found.
Agents: Sonnet 5.5 for well-bounded items, Haiku for mechanical checks. Each agent gets its own worktree, never
commits, and returns a diff plus evidence. The lead validates every diff (reads it, re-runs the gate, runs a scratch
mutation for each new test, renders any UI change) before committing. At most 3 agents run at once.

## A. Test suite (mostly done)

| # | Item | State | Who |
|---|---|---|---|
| A1 | Tripwires, browser waits, vault split: 319 s -> 208 s | done, committed | lead |
| A2 | `test:map` / `test:affected` (recorded map, opaque programs always run) | built; recorder fix for killed children awaiting the soundness proof | lead |
| A3 | Soundness proof: 8 deliberate breaks, every skipped file run, failures re-run alone (gap / flake / pre-existing) | running | lead |
| A4 | `installer-node-bootstrap` (191 s): run the powershell and pwsh groups concurrently | todo | Sonnet, lead measures before/after |
| A5 | Gate double-compile: `npm test` rebuilds what `build:ts` just built; add `test:run` (no build) for the gate | todo | lead (docs + AGENTS/CLAUDE gate line) |
| A6 | Opaque-program allowlist for programs that read no repo file (`taskkill /PID`, `reg query`, probes of missing .exe) | todo, needs proof re-run | lead |
| A7 | `store.test` 2 s debounce wait -> injected delay | todo | Haiku |

## B. Claude in Legion: the council's open findings

| # | Item | Design | Who |
|---|---|---|---|
| B1 | Live progress while a run works | Engine emits `task.progress` from the stream (turn = assistant message count this run, current tool, start time). Working row: "Working · turn 37 of 200 · Bash · 2m 14s". Cost only at the end (the SDK reports it in the result); the row says nothing about cost rather than a wrong number. | lead (engine) + Sonnet (UI) |
| B2 | Send messages while a run is going | SDK streaming input (`prompt` as AsyncIterable / `Query.streamInput`). Spike first: prove on the scripted model and read sdk.d.ts that a message sent mid-run starts a new turn in the same session. Then: a follow-up to a running Claude task is fed into the live run instead of 409 + queue. Providers keep the queue. | lead (spike + engine) |
| B3 | Missing session: Retry/Continue fail forever | Find the SDK's exact error for a resume of a missing session (sdk.d.ts, docs, then real transcripts). On it: clear `sessionId`, run again with the original request, and say so in the thread. | Sonnet research, lead implements |
| B4 | Approval timeout told Claude "the user denied this" | Say "No answer within 10 minutes; the action was not run." Distinguish denial from timeout in the broker result. | Sonnet |
| B5 | Thinking and TodoWrite | TodoWrite: a checklist (pending / in progress / done) pinned above the composer while the run is live, from the latest TodoWrite input. Thinking: a collapsed "Thinking…" line while a thinking block streams; content not stored. | Sonnet (UI), lead (engine fields) |
| B6 | Escalation message shows raw codes | Plain copy: "Sonnet could not finish this (it hit an error). Opus is continuing the same task." | Haiku (copy) + lead review |
| B7 | Context meter and spend cap | Spend cap: optional `claude.maxBudgetUsd` (Settings -> Claude), `error_max_budget_usd` gets the Paused card with its own text. Context meter: from the last assistant message's `usage` against the model window; shown in the thread header. | Sonnet (settings + UI), lead (engine) |
| B8 | Provider models keep a 40-turn cap (and a provider run that hits it gets the red "Run failed" card and a fault mascot instead of the Paused card: unify it with the Claude pause) | Raise `providers.maxTurns` default to 200 with the same one-time migration rule (only the untouched old default moves). | Sonnet |
| B9 | No Continue on cancelled tasks | A cancelled task whose run reached its session shows Continue next to "Cancelled". | Sonnet |

## Gates for 0.2.5-c (all, in order)

1. Every new test seen red by a scratch mutation, then reverted.
2. Full suite on the tree that becomes `main` (one gate at a time). Baseline: 0.2.5-b's own gate counts.
3. Typecheck, UI build, screenshot rig for every UI change (dark, light, 860 px).
4. Version `0.2.5-c` in three places, lockfile diff version-only.
5. CHANGELOG for the installed user only (A-items go to the tracker, not the changelog). Notes under 600 characters.
6. PC checks recorded in `claude/tracker-pc-checks.md` for what needs the real SDK (B2, B3, B7).
7. Package, manifest, then the owner signs, merges and publishes.

## Order

A3 -> A2 commit -> B6, B4, B8, B9 (small, parallel agents) -> B1 -> B7 -> B5 -> B3 -> B2 (largest, last, own spike) ->
A4-A7 -> gates.
