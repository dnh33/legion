# Skill finder: tracker

Plan: `claude/plan-skill-finder.md` (approved by the owner 2026-10-17). Branch `feat/skill-finder`,
worktree `D:/bots/legion-wt-finder`, base `main` 47582700.

## Resume here
Next step: **P1, the eval before any code.** Read the plan's P1 and its gate. If recall@3 is below
0.70 on either set, stop and ask the owner before P2.

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
| P2 finder.ts | not started | |
| P3 Claude path | not started | first verify that `UserPromptSubmit` fires for SDK prompts |
| P4 provider path | not started | |
| P5 settings + UI | not started | |
| P6 review + live check + PR | not started | |

## Numbers (figures only; never paste prompts here)
_none yet_
