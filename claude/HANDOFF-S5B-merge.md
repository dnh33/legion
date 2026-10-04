# HANDOFF — merge `fix/s5b-full-access-approval-card`

**For the agent picking this up.** Read this before touching anything.

## What this is

Two independent fixes plus one test-infra fix, on branch `fix/s5b-full-access-approval-card`
cut from `main` = `d2926d6`. Worktree: `D:\bots\legion-s5b`.

| Commit | What | Touches |
|---|---|---|
| `79759dd` | `fix(approvals)`: full access never cards — one rule for every guard (S5b) | 9 src, 5 test |
| `6907c7e` | `fix(browser)`: stop redirecting `USERPROFILE` so Chromium can launch | 1 src, 1 test |
| (docs) | Session records: tracking + Phase B plan | 2 md |

Each commit stands alone. If a review wants one dropped, it can be — they do not depend on each other.

## Verification actually performed (not assumed)

| Gate | Result |
|---|---|
| `npm run build:ts` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build:ui` | exit 0 |
| Full suite, 200 files, 5 batches | **2,450 tests, 2 failures — both pre-existing** |

The two failures are `export-scrub` ("export-public produces a scrubbed single-commit publishable
snapshot") and `perf-l-store` F1 ("kg.updated about unrelated nodes…"). **Both were re-run on clean
`main` in the same session and fail identically there.** The second is tracker item S5, already known.

**Red-green was verified for the S5b regression test.** With `src/` reverted, the full-access case
fails and the `ask` case passes (so the test discriminates, not just fails); with the fix, both pass.
The restored `src/` was diffed byte-for-byte against the verified copy.

## Traps you will hit

1. **Do not run the suite backgrounded or redirected.** `node --test ... > file` and backgrounding both
   produce a single line, `stdin is not a tty`, and nothing runs. Across four such runs the exit codes
   were 0, 0, 0, 1 for identical empty output — **the exit code is not a signal here.** The only working
   shape is foreground piped to grep:
   `node --test $(cat /tmp/batch.txt) 2>&1 | grep -E "^(✖|ℹ (tests|pass|fail))"`
   Require the `ℹ pass N` / `ℹ fail N` lines before believing anything.
2. **The suite exceeds a single foreground call.** Batch it, ~40 files per run:
   `ls dist/test/*.test.js | sed -n '1,40p' > /tmp/b1f.txt`
3. **Never run a build and a gate at the same time.** Two concurrent builds writing `dist/` give
   meaningless results. (A stale backgrounded build was found racing the gate during this session.)
4. `python3`/`npm` note: `npm run build:ts` must not be piped or redirected, or npm itself dies
   (documented in the repo's own `START-HERE.md`).

## Things deliberately NOT done

- **Nothing was pushed.** `main` is byte-identical to `cloud/main`. Pushing/PR needs the owner's
  explicit approval (standing instruction, 2026-10-04).
- **The stale sequencer on `main` was not touched.** `D:\bots\legion` cannot `git switch` because an
  abandoned cherry-pick from 2026-10-03 left `.git/…/legion-review/sequencer` with two picks
  (`77fefea`, `d6cea12` — README/branding docs) that **never landed in main**. No `CHERRY_PICK_HEAD`,
  so it is an orphaned flag. Owner's call. Work in a worktree instead.
- **`browser_status` still reports config, not a live process.** It claimed healthy while nothing could
  launch, which is what made the original diagnosis misleading. Separate change, not done.
- **`/bug` was dropped** by owner decision — see `PHASE-B-SLASH-COMMANDS.md`. Do not re-propose it.

## Worktree hygiene on this host

- `git worktree add /d/bots/foo` creates a literal `D:\d\bots\foo`. **Always pass native `D:/...` paths.**
- `D:\bots\legion` is itself a linked worktree; the main repo lives at `D:\bots\legion-dev\.git`.

## Related reading

- `claude/S5B-TRACKING.md` — the S5b investigation, the seam triage, the owner ruling, the fix.
- `claude/PHASE-B-SLASH-COMMANDS.md` — `/steer` `/goal` `/subgoal` research and the B1–B4 plan.
- Skills written for this work: `guard-consistency-audit`, `legion-env-scrub-breaks-chromium`,
  `node-test-runner-windows-tty`.