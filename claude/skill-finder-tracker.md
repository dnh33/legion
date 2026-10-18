# Skill finder: tracker and handoff

Plan: `claude/plan-skill-finder.md`, with its tasks in `claude/plan-skill-finder-tasks.md`. Branch `feat/skill-finder`, worktree
`D:/bots/legion-wt-finder`, based on `cloud/main` f05e910b. The eval branch `eval/catalog-sweep` lives in worktree `D:/bots/legion-wt-sweep`.

## Owner rule for this work (2026-10-18)
Nothing from this work merges into `main` in the session that built it. The build session finishes, pushes both branches and stops.
The next agent owns the PR, the merge and the release.

## Resume here (for the next agent)
1. **Defaults are decided** (owner, 2026-10-18, from the 11g result: "Best accuracy"):
   - the search tool is on;
   - Claude runs with search get `SEARCH_HINT` in the system prompt;
   - the full skill list stays (`slimListing` false);
   - the short list (with `SLIM_SEARCH_HINT`) is one switch away;
   - suggestions start off.

   **Correction (2026-10-18, accuracy rounds 1 to 3):** the 11e to 11g runs were confounded. Every arm carried a probe line ("Use a skill
   only if one clearly fits; otherwise answer briefly") that Legion never sends. Without it (round 1), `SEARCH_HINT` shows no measured
   gain over no hint (74 against 69 accepted at 100 skills, not significant). The hint is harmless but unproven.

   The measured winner is **MSL**: a middle hint plus a per-turn top-5 shortlist with a pick-one-or-none step. It exists only in the eval
   harness so far. On 267 fresh prompts at 100 skills it scored +16.9 points (95% CI 11.5 to 22.2, p < 0.0001), with precision going
   from 90.2 to 94.0 percent. But it made 6 wrong loads against 3 on 159 no-skill prompts, which fails the pre-set limit by one load.

   The owner paused here to iterate later ("until we hit 100%"). The MSL default decision is pending. The full record, the exact
   strings and the next steps are in Aetherkeep `06-projects/legion/skill-finder/accuracy-RESUME-2026-10-18.md` and on branch
   `eval/catalog-sweep`.
2. Do the packaged-app walk (`legion-live-render-check`), with a fresh LEGION_HOME and one real Claude run. It must show:
   - the local-model helper forks under packaged Electron (Get model, approval card, ready, Remove);
   - the first UserPromptSubmit fire has source `user` or `sdk`, so the library briefing arrives;
   - a SubagentStart note;
   - armory_find called by a real agent;
   - the Armory Skill finder section and the Suggested chat line, in light and dark;
   - the 9b "Show which" list.
3. Run `legion-update-path-check`. This is a code-only release: the local runtime and model download at runtime on approval, so there
   are no new install dependencies.
4. Open the PR from `feat/skill-finder` and follow the release skill. `eval/catalog-sweep` is evaluation tooling. Bring its scripts to
   `main` only if wanted, and if so, make it import `SLIM_SEARCH_HINT` from the finder instead of its own copy.

## What is built (all on `feat/skill-finder`)
- **Search tool** `armory_find` on the Claude and provider paths: on by default, switchable globally and per agent. A third-party skill
  shows its id only and never taints.
- **Suggest each turn:** off by default (Off / On / Only with the local model), with subagent suggestions, k, threshold, and a quiet
  Suggested line in chat with a why popover. It is a cache-safe user-turn note: the UserPromptSubmit hook, or a provider prompt prepend.
- **Rankers:** keyword (BM25F), plus an optional local model (opt-in download with an approval card, pinned hashes checked at every
  load, a child process that exits after 5 idle minutes), or provider embeddings.
- **Optional Haiku rerank** with a monthly cap. It fails closed when its spend record cannot be used, and pauses visibly.
- **Search hint:** with the search tool on, a Claude run's system prompt gets `SEARCH_HINT` (full list) or `SLIM_SEARCH_HINT` (short
  list). These are static lines, so the prompt cache holds. A provider run gets neither.
- **Short skill list** (off by default; Never / Always / above WARN_ABOVE skills).
- **Armory UI:** the Skill finder section and a test box. **Agent editor:** a Skill finder choice.
- **Task 10:** the library briefing and the project board digest moved from the system prompt to the first user turn, so the prompt
  cache holds.
- **Task 9b:** the Armory keeps the last good SDK skill list when the live one fails.
- The CHANGELOG `[Unreleased]` entry is written.

## Reviews done
Every task had a task review plus fix rounds. The final whole-branch review and the adversarial security review were each followed by a
fix wave and a mutation-checked re-review. Accepted residuals:
- the Haiku rerank sees third-party descriptions (its output is filtered ids and it has no tools);
- a planted sdk-listing.json needs write access to the data folder;
- the window between the hash check and the import of the ONNX glue (documented);
- per-turn SDK cost totals that never fall look cumulative (the reservation covers it);
- raising the rerank cap after a damaged-ledger reset reopens that month.

## Open question for the owner
Claude Code's full listing shows plugin skill descriptions without tainting a run. Legion's search tool and note hide them to avoid
taint. With the short list on, plugin skills therefore lose their description everywhere. The 11g SFH120-TP arm puts the cost as small
(0 to -3 points against the full list + search). With the full list as the default, this matters only for owners who turn the short list on.

## Numbers (figures only; never paste prompts here)
- **Per-turn note (Task 11, the owner's 104 skills):** no keyword floor meets the bars (false-note <= 0.15, note precision >= 0.50).
  Graded by Sonnet, a shown note is right 37 percent of the time on real prompts and 56 percent on long-tail ones. It is wrongly shown on
  12 percent of prompts that need no skill. The note did not change which skill Haiku or Sonnet picked. So it starts off.
- **Short list without search, the owner's catalog (Task 11d, Haiku, 265 positives + 300 negatives):** gold 74 vs 70 (McNemar
  p 0.48), false calls 8 vs 9, input 21,085 to 13,514 tokens.
- **Short list without search, 400 public skills (Task 11e, run 39075354869):** lost 11 to 19 points at 40 to 100 skills
  (p 0.003 to 0.015); no significant loss at 200 and 400.
- **Short list with search (Task 11f, run 39080410547; gold vs the full list + search):**
  - without the hint: -6 to -9 points;
  - **with the hint (SFH120): +4.3, +5.0, +12.0 and +10.0 points at 40, 60, 100 and 200 skills, about 48 percent fewer input tokens.**
  - The hint raises search use from 36 to 46 percent.
  - Caveat: search hits carried every skill's description.
- **Follow-up (Task 11g, run 39085026746, $4.62).** Gold rate against AF (the full list + search), at 10 / 25 / 40 / 100 skills:
  - **AFH (the full list + search + hint):** -5.3 / +11.4 / +7.6 / **+13.0** points (p 0.004 at 100), about 10 percent more input
    tokens. The hint is the main accuracy lever.
  - **SFH120 (the short list + hint):** -10.5 / +11.4 / +7.6 / +4.0 points, 31 to 49 percent fewer tokens. Against AFH at 100 it is
    -9.0 (p 0.049).
  - **SFH120-TP (the same, with search showing third-party skills as an id only):** 0.0 / +6.8 / +4.5 / -3.0 points, 30 to 50 percent
    fewer tokens. It passes the pre-registered rule from 10. Showing plugin skills as an id only costs little.
  - Size 10 has only 19 positives.
- **The owner's choice:** best accuracy by default (the full list + the hint). The short list stays optional.
- **Caveat:** every number from 11e to 11g above was measured with a probe line Legion never sends. See the correction under "Resume
  here".
- **Accuracy rounds 1 to 3** (runs 39132308172, 39138820950 and 39144702797; no probe line; plugin search hits shown by id only):
  - **Round 1, at 100 skills:** the shipped hint scored 74 against 69 with no hint (not significant). A strong hint scored 85 but loaded
    a skill on 27 of 99 no-skill prompts. Plugin descriptions in search scored 74.
  - **Round 2:** MSL scored 80 against 73 (p 0.09), with wrong loads at C's level.
  - **Round 3, confirmatory, 267 fresh prompts:** MSL scored 82.0 against 65.2 (+16.9 points, CI 11.5 to 22.2). Wrong loads were 6
    against 3 of 159, failing the limit of at most C + 2. In 19 of MSL's misses the right skill was in the shortlist, shown only by its
    id, and was not loaded.
