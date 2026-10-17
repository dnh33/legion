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
| P3 embeddings (local opt-in download + provider, hybrid) | not started | Blender download pattern; one release |
| P4 Haiku rerank | not started | |
| P5 Claude path (hooks, armory_find, slim listing) | not started | first verify that the hooks fire for SDK prompts |
| P6 provider path | not started | |
| P7 KG recall to the user turn | not started | only if P1 confirms the cache break |
| P8 settings + UI | not started | |
| P9 review + live check + PR | not started | |

## Numbers (figures only; never paste prompts here)
Task 11 eval round (figures only; the full tables are in the SDD folder, task-11-report.md). Agent pool = the 104 switched-on skills.
- Keyword, no floor meets the bars (false-note <= 0.15, note precision >= 0.50). Best false-note-bounded floor (20): Set A recall@3 0.052, Set B 0.000, precision 0.161, false-note 0.077.
- Local model: the bars are met only at a note rate of about 1 percent (fused 0.95, weight 0.8, cosine floor 0.88): Set A 0.000, Set B 0.021, precision 0.667, false-note 0.010. Before tuning, with no cut: keyword 0.326 / 0.226, local 0.296 / 0.323.
- Rerank margin 0.2 (small gain). Outcome eval, first Skill call is the gold skill: Haiku A 7/30 (Set A) and 2/30 (Set B), the same with the note; Sonnet 12/30 and 6/26, the same with the note. False Skill calls on negatives: Haiku 1/20, Sonnet not run (cap).
- Defaults written: suggest 'auto' (on only with the local ranker and its model), slim listing stays off.
