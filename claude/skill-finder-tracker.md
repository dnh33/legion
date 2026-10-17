# Skill finder: tracker

Plan: `claude/plan-skill-finder.md` (approved by the owner 2026-10-17). Branch `feat/skill-finder`,
worktree `D:/bots/legion-wt-finder`, base `main` 47582700.

## Resume here
Next step: **P1, the eval harness.** It tunes defaults and thresholds. It does not gate scope:
build every step P1-P9 (owner, 2026-10-17: "the FULL AND COMPLETE THING").

## Rules for whoever implements this
- The owner's prompts never enter the repo. Use `claude/skill-finder-private/` (gitignored) and
  Aetherkeep `06-projects/legion/skill-finder/`. Commit only invented fixtures.
- Don't name reference projects in code, comments, the changelog or PRs.
- No `git stash` in this worktree (the stash list is shared across worktrees).
- Typecheck plus the touched test files locally. GitHub CI is the full gate.
- Security-relevant (taint): run `legion-adversarial-pr-review` before the PR.

## Status
| Step | State | Notes |
| --- | --- | --- |
| P0 worktree + docs | done 2026-10-17 | |
| P1 eval (Set A, Set B, cache check) | not started | |
| P2 finder core (BM25, usage, gates) | not started | |
| P3 embeddings (local + provider, hybrid) | not started | check whether the runtime can ship code-only |
| P4 Haiku rerank | not started | |
| P5 Claude path (hooks, armory_find, slim listing) | not started | first verify that the hooks fire for SDK prompts |
| P6 provider path | not started | |
| P7 KG recall to the user turn | not started | only if P1 confirms the cache break |
| P8 settings + UI | not started | |
| P9 review + live check + PR | not started | |

## Numbers (figures only; never paste prompts here)
_none yet_
