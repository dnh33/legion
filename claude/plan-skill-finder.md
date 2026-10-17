# Legion Skill Finder: plan

## Context
In Legion, the Armory already sends each Claude agent an explicit list of the skills that are
on for it. Settings warns when an agent would get more than about 40. The owner's own Armory
(`~/.legion/armory/armory.json`, read 2026-10-17) has **104 skills on**: 12 built-in, 91
from plugins, 1 his own. All 104 go into Claude Code's skill listing. That listing is capped at
1% of the context window. When it overflows, the descriptions of the least-used skills are
dropped, so many skills reach the model as bare names and seldom fire. Provider agents
must call `armory_skills` to see any skills at all.

The owner's idea: the agent finds the right skills for each turn, instead of carrying all of them.
Build it natively in Legion, on its own worktree, so a later agent can implement it from this plan.

Outcome:
- Owners can turn on many skills without paying the listing cost.
- On each turn, the 1 to 3 skills that fit the prompt reach the model with their description.
- Skills that never fire today start firing.
- Every part is an option the owner can turn off.

## What exists (Legion `main` 47582700, read 2026-10-17 in D:\bots\legion)
- **Armory already owns skills.** `src/core/armory/` holds `catalog.ts` (CatalogEntry: id, name,
  description, path, source; `access(entry, agent)`), `discover.ts` and `index.ts`
  (`claudeSkills` :193, `skillGate` :206, catalog cache :91). The plan is in `claude/plan-armory.md`.
- **Claude path.** `buildOptions` is at `src/core/engine.ts:1530-1594`. It passes an explicit
  `skills` list (`moduleSkills` :1272), `settings` (:1567) and `PreToolUse` hooks (:1570),
  including the Skill gate (:1578). There is no `UserPromptSubmit` hook yet. The SDK 0.3.296
  types `UserPromptSubmitHookSpecificOutput.additionalContext` (`sdk.d.ts:598`).
- **Provider path.** `src/core/armory/tools.ts` gives provider agents `armory_skills` (the full
  list) and `armory_skill` (load the body). Third-party text taints the run (:48, :69).
- **Prompt cache risk, already present.** `modulePreamble` puts per-prompt knowledge-graph
  recall hits into the system prompt `append` (`engine.ts:1537`; `kg/index.ts`). The finder
  must not inject there. P1 measures whether this already breaks the cache.
- **Search.** BM25 tokenize and stemming are in `src/core/kg/text.ts:13-33`, in-process. Legion
  has no embeddings and no Haiku side-calls.
- **Tests.** `node:test`, under `test/`. Representative: `test/armory-engine.test.ts`,
  `test/armory-provider.test.ts`, `test/engine.test.ts`.
- **Eval data.** The owner's local Claude Code transcripts hold about 450 real Skill calls across
  40+ skills. One skill accounts for 156, mostly typed by the owner. These stay private (see P0).

## Prior art (opened sources, 2026-10-17; the full report with sources is in the owner's private notes)
- **Claude Code.** A flat listing with a budget (1%, `skillListingBudgetFraction`,
  `skillListingMaxDescChars`). MCP tools are deferred and found with ToolSearch. It has no skill search.
- **Other established harnesses.** One has a 2% budget for its listing and no search. Another has
  three levels (list, view, view one reference file), with the index fixed in the system prompt
  for cache stability and no local search.
- **Model-driven tool search (API).** The model searches deferred tools itself with BM25 or regex.
  Vendor-reported results: accuracy up about 9 points, context down from about 77K to 9K tokens.
- **Community routers.** One uses a local embedding model, with recall@3 of 0.83 against 0.73
  for its BM25 hybrid. It injects at most 3, needs a score of at least 0.55 and has a 300 ms
  deadline. Advisory wording works better than "REQUIRED". Keyword trigger files drift away from the skill text.
- **One established harness:** not researched yet (see P1).
- **Flag (benchmark rule):** per-turn automatic suggestions are in no established harness, only
  in community plugins. The model-driven search tool is established practice. So both ship as separate options.

## Design
**1. Two ways to find a skill, each switchable.**
- **Suggest each turn (automatic).** Before the model reads the prompt, Legion ranks the agent's
  enabled skills against it. The top matches go in as a short advisory note: "Skills that may
  fit this request: X: <description>. Load one with the Skill tool if it applies."
- **Search tool (the model asks).** A new tool `armory_find(query)` returns the top 5 with
  descriptions. On the Claude path it is a `legion_armory` tool. On the provider path it sits
  next to `armory_skills` and `armory_skill`.

**2. Where the note goes (cache-safe).**
- **Claude path:** an SDK `UserPromptSubmit` hook returns `additionalContext`. The note travels
  with the user turn, not in the system prompt.
- **Provider path:** the note is prepended to that turn's user prompt (`host.prompt`), never to `systemPrompt`.
- **Bot-to-bot runs:** rank `decision.prompt` only, not the sender header.

**3. Candidates = what the Armory already allows.** The finder ranks only the skills that are
'on' for that agent: `access(e, agent) === 'on'`, the same set as `moduleSkills` and
`providerSkills`. It can never suggest an off or manual skill. This is a security test.

**4. Ranker v1: BM25, no new dependencies.** It reuses `kg/text.ts` tokenize and stemming.
- **Fields:** id/name tokens (weight high), description, `when_to_use` (parse it in the catalog
  if it isn't parsed yet).
- **Usage prior:** skills this owner actually loads get a small boost, learned from Legion's own
  Skill tool events, stored locally.
- **Gates:** a score threshold (0 matches means no note), k ≤ 3, and a 50 ms deadline (on overrun, no note).
- **Pure module:** `src/core/armory/finder.ts`.
- Being code-only keeps the updater path simple. Embeddings (a deps release) and a Haiku rerank
  come later, and only if the P1 numbers show a gap.

**5. Taint (security). One rule on both paths.**
- The note carries a description only for the owner's own skills and for built-ins.
- Third-party skills (`THIRD_PARTY` in `catalog.ts`) appear as id plus "(third-party)", with no
  description text, so a suggestion never taints a run. This still holds when the slim listing
  is on and the note is the only place a description appears.
- `armory_find` taints exactly as `armory_skills` does when it returns third-party text.
- **Tests:**
  - With the slim listing on and only third-party matches, the note holds no third-party
    text and the run stays untainted, on both paths.
  - `armory_find` taints when it returns third-party text.

**6. A slim listing (optional, off until P1 proves it).** When this is on, Claude runs get a smaller
listing via `settings.skillListingBudgetFraction` / `skillListingMaxDescChars`. Names stay
listed. The finder carries the descriptions.

**7. Options (Settings → Armory → "Skill finder"), following the existing settings recipe.**
- **Suggest each turn:** on by default, with a one-time notice.
- **Search tool:** on.
- **Slim listing:** off.
- **Suggestions per turn:** 1 to 3, default 3.
- **Show suggestions in chat:** a quiet line under the turn, no side stripe.
- v1 is global. A per-agent override comes later.

## Steps
- **P0. Worktree and durable docs (first action after approval).**
  - **DONE 2026-10-17.** Worktree `D:/bots/legion-wt-finder`, branch `feat/skill-finder` off
    `main` 47582700. This plan and `claude/skill-finder-tracker.md` are committed.
  - **Legion is public, and the eval sets are the owner's own prompts.** They NEVER go in the repo.
    - Build them into `claude/skill-finder-private/`, which is gitignored on this branch.
    - Copy the finished sets to Aetherkeep `06-projects/legion/skill-finder/`.
    - The prior-art report with its sources is already at Aetherkeep
      `06-projects/legion/skill-finder/prior-art-2026-10-17.md`.
  - The repo gets only a small synthetic fixture (`test/fixtures/skill-finder/`), invented prompts only.
  - The "What exists" section above, verified on `main`, is the code map.
- **P1. Eval before code.**
  - A script `scripts/skill-finder-eval.mjs` builds the gold set from the transcripts. Each item is the
    user prompt before a Skill call the model chose. User-typed `/name` calls are excluded,
    and so are prompts that name the skill (those go in a separate subset). Negatives are
    prompts with no Skill call.
  - **Set B, the long tail.** Set A only holds skills the full listing already found, so it
    cannot show the core benefit. Set B has 30 to 50 prompts for enabled skills with zero
    invocations. A Sonnet agent writes them as realistic requests from each skill's
    description, without copying its keywords. The owner spot-checks 10 through the question UI.
  - **Metrics:** recall@1/3/5, MRR, false-note rate on negatives and p95 latency, reported
    separately for Set A and Set B.
  - **Cache check:** compare `cache_read_input_tokens` across resumed turns, to measure the
    knowledge-graph preamble's effect. Real runs only, ≤ $1, Haiku.
  - **Gate:** if BM25 recall@3 is below 0.70 on either set, stop and re-plan the ranker
    (embeddings) with the owner.
  - **Before P2:** close the gap on how the remaining established harness handles this (one opened source),
    under the big-four rule.
- **P2. `finder.ts` + unit tests:** ranking, threshold, deadline, never an off skill, `when_to_use` parsing.
- **P3. Claude path wiring:**
  - add the `UserPromptSubmit` hook in `buildOptions`;
  - add `armory_find` to the Armory server;
  - record the suggestions on the task;
  - write an engine test that asserts the hook is present and the system prompt `append` is unchanged by the finder.
  - A live probe confirms the hook fires for SDK prompts and that the note reaches the model (Haiku, ≤ $0.50).
- **P4. Provider path:** add the note to `host.prompt` and `armory_find`, with taint tests in `test/armory-provider.test.ts`.
- **P5. Settings and UI:**
  - add the fields to `shared/types.ts`, `shared/config.ts`, `core/settings.ts`, `ui/src/armory/ArmorySection.tsx` and `ui/dev/mock-server.mjs`;
  - show the suggestion line in chat.
- **P6. Review and live check:** `legion-adversarial-pr-review` (it touches taint),
  `legion-live-render-check` for the UI, `legion-update-path-check` (code-only), then the PR.
- **P7 (separate plan, if the numbers call for it):** embeddings ranker, Haiku rerank, the slim listing turned on by default.

## Verification
- `npm run typecheck` plus the touched test files locally. GitHub CI is the full gate.
- Eval report committed (public fixture numbers). Private-set numbers go in the tracker as figures only.
- Live: a Claude agent gets "make this page feel premium". The note names the design skills, and the
  agent loads one. Check Legion `logs/` after each run.
- Negative: an agent with impeccable off never sees it suggested. A provider run with only
  third-party matches stays untainted.
- Cache: turn 2 of a resumed task still shows `cache_read_input_tokens` > 0 with the finder on.

## Unverified now
- Whether the SDK fires `UserPromptSubmit` for `query()` prompts (P3 probe).
- Whether the catalog parses `when_to_use`.
- The real BM25 recall on the owner's prompts (P1).
- Whether the knowledge-graph preamble already breaks the cache (P1).
