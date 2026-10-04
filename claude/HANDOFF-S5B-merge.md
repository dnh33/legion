# HANDOFF — `fix/s5b-full-access-approval-card` (SUPERSEDED: this work is merged)

> **STATUS UPDATE — read this first.** This branch is **fully merged into `main`** as
> `4cd05ea merge: one rule for full access - a guard never cards (fix/s5b-full-access-approval-card)`.
> It is **0 commits ahead of `main` and ~33 behind**. **There is no reconciliation work left** — an earlier
> version of this file said the branch was behind and needed merging; that is no longer true. The scenario
> below is kept for the verification evidence and the traps, which still matter.

## What this was

Two independent fixes plus one test-infra fix:

| Commit | What | Touches |
|---|---|---|
| `79759dd` | `fix(approvals)`: full access never cards — one rule for every guard (S5b) | 9 src, 5 test |
| `6907c7e` | `fix(browser)`: stop redirecting `USERPROFILE` so Chromium can launch | 1 src, 1 test |
| `7f2df8f` | `docs`: tracking, Phase B plan, this handoff | 3 md |

Each commit stands alone. If a review wants one dropped, it can be.

## Why S5b was not what the tracker said

The tracked suspect was `approvalCeiling` capping a `full` agent down to `ask`. **Both suspects were wrong.**

- `needsApproval('full', …)` was correct as written (now asserted against the real function).
- A UI-started `full` agent gets `bypassPermissions` and **no `canUseTool`**, so it cannot card through the
  generic path. A ceiling exists only for runs an MCP client or another bot started, and capping those is the
  confused-deputy guard working as designed.

The real cause: four module guards called `approvals.request()` directly and were never handed the agent's
mode — Blender `exec`, Blender asset, the comms room tools, and the board `delete`. The browser module already
threaded the mode correctly, which proved the pattern was known and one wire was missing.

Owner ruling (2026-10-04): **one rule, no exceptions — in `full` a guard never shows a card**, all five seams.

## Verification performed (evidence, not assertion)

- `npm run build:ts`, `npm run typecheck`, `npm run build:ui` — all exit 0.
- Full suite on the branch: 200 files in 5 batches — 2,450 tests, 2 failures, both pre-existing.
- **The merge with `main` was tested, not assumed.** `git merge-tree` reported clean, and the merged tree was
  then built and tested in a throwaway worktree — 215 files, 0 compile errors, only the same two pre-existing
  failures. **A clean textual merge is not proof of a working merge; this one was checked.**
- **Red-green verified** for the S5b regression test: with `src/` reverted the full-access case fails and the
  `ask` case passes (so the test discriminates); with the fix both pass. Restored `src/` diffed byte-identical.
- Current `main` after the merge: fixes present (`guardAsk` present, `USERPROFILE` absent), 144/144 on key tests.

### Failures that are NOT this work's — do not chase them

| Test | Status |
|---|---|
| `export-scrub` — "export-public produces a scrubbed single-commit publishable snapshot" | fails on clean `main` too; needs git identity/network |
| `perf-l-store` F1 — "kg.updated about unrelated nodes…" | fails on clean `main` too; tracker item S5 |
| `library-review2-graph` — "R2-G10 lock: stale / crashed lock states…" | **load-sensitive flake**: fails under batch load, passes alone |

## Traps on this host — these will bite you

1. **Never run this suite backgrounded or redirected.** `node --test ... > file` and backgrounding both emit a
   single line, `stdin is not a tty`, and run nothing. Across four such runs the exit codes were **0, 0, 0, 1**
   for identical empty output — **the exit code is not a signal.** The only working shape is foreground piped
   to grep:
   `node --test $(cat /tmp/batch.txt) 2>&1 | grep -E "^(✖|ℹ (tests|pass|fail))"`
   Require the `ℹ pass N` / `ℹ fail N` lines before believing anything.
   **The default reporter is NOT TAP** — `grep "^not ok"` matches zero lines trivially and makes a broken run
   look clean. That mistake was made and caught during verification.
2. **The suite exceeds one foreground call.** Batch it:
   `ls dist/test/*.test.js | sed -n '1,45p' > /tmp/m1.txt` then `node --test $(cat /tmp/m1.txt) …`
3. **Never run a build and a gate at once.** Two concurrent builds writing `dist/` give meaningless results.
   A stale backgrounded build was found racing the gate during this session.
4. `npm run build:ts` must not be piped or redirected or npm itself dies (see the repo's `START-HERE.md`).
5. `git worktree add /d/bots/foo` creates a literal `D:\d\bots\foo`. **Always pass native `D:/...` paths.**
6. `D:\bots\legion` is itself a linked worktree; the main repo lives at `D:\bots\legion-dev\.git`.
7. **`main` moves while you work, and other agents work in parallel.** It advanced twice during this session and
   four more worktrees appeared that were not mine. Re-check
   `git fetch cloud && git rev-list --count HEAD..main` before starting, and re-verify after.

## Deliberately NOT done

- **`/bug` was dropped** by owner decision — see `PHASE-B-SLASH-COMMANDS.md`. Do not re-propose it.
- **`browser_status` still reports config, not a live process.** It claimed healthy while nothing could launch,
  which is what made the original browser diagnosis misleading. Separate change, still open.
- **The stale sequencer on `main`** — an abandoned cherry-pick from 2026-10-03 left
  `.git/…/legion-review/sequencer` with two picks (`77fefea`, `d6cea12`, README/branding) that never landed.
  No `CHERRY_PICK_HEAD`, so an orphaned flag. **Check whether this still holds**; `main` has moved a lot since.
  Work in a worktree rather than clearing someone else's state.
- **Phase B (B1–B4) is planned, not built.** `/steer` is gated behind a spike: Legion's SDK has no mid-run text
  injection (`Query.interrupt()` kills; there is no `streamInput`), so `/steer` cannot be built the way Hermes
  builds it.

## Related reading

- `claude/S5B-TRACKING.md` — the investigation, seam triage, owner ruling, and the discarded mirror test.
- `claude/PHASE-B-SLASH-COMMANDS.md` — `/steer` `/goal` `/subgoal` research and the B1–B4 plan.
- Skills written for this work: `guard-consistency-audit`, `legion-env-scrub-breaks-chromium`,
  `node-test-runner-windows-tty`.