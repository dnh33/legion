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


## Scope: the full thing (owner, 2026-10-17)
The owner wants the complete feature built. Nothing below is "later, if the numbers allow".
The eval measures and tunes defaults and thresholds. It never decides whether a part is built.
The one sequencing rule is the updater: a new native dependency ships in its own release
(see "Releases").

## Design
**1. Three ways to find a skill, each switchable.**
- **Suggest each turn (automatic).** Before the model reads the prompt, Legion ranks the agent's
  enabled skills against it. The top matches go in as a short advisory note: "Skills that may
  fit this request: X: <description>. Load one with the Skill tool if it applies."
- **Search tool (the model asks).** `armory_find(query, limit?)` returns the top matches with
  descriptions and scores. It is on the `legion_armory` server for both the Claude and provider paths.
- **Subagents.** A `SubagentStart` hook gives each subagent its own suggestions for its task
  (subagents ignore the `skills` list; the Skill gate at `engine.ts:1578` still applies).

**2. Where the note goes (cache-safe).**
- **Claude path:** an SDK `UserPromptSubmit` hook returns `additionalContext`, so the note
  travels with the user turn. The system prompt stays byte-identical across turns.
- **Provider path:** the note is prepended to that turn's user prompt (`host.prompt`), never `systemPrompt`.
- **Bot-to-bot runs:** rank `decision.prompt` only, not the sender header.
- **Knowledge-graph recall, same fix:** today `modulePreamble` puts per-prompt KG hits in the
  system prompt (`engine.ts:1537`). If P1 confirms it breaks the cache, move the per-prompt part
  of the KG briefing to the same user-turn channel. The stable part stays in the system prompt.

**3. Candidates = what the Armory allows.** Rank only skills 'on' for that agent
(`access(e, agent) === 'on'`, the same set as `moduleSkills` and `providerSkills`). An off or
manual skill is never suggested or returned. Security test on both paths.

**4. The ranker: three stages, all built.**
- **Stage 1: BM25 (always on, in-process).**
  - Reuse `kg/text.ts` tokenize and stemming.
  - **Fields:** id/name (high weight), description, `when_to_use` (parse it in the catalog), headings of the SKILL.md body (low weight).
- **Stage 2: embeddings (hybrid with BM25).**
  - **Local model (opt-in download, off by default; nothing on the user's machine unless they ask):**
    - A small multilingual ONNX embedding model, so Danish prompts match English skills. The P1 eval picks it.
    - **Delivery reuses the Blender pattern** (`src/core/blender/get-blender.ts`):
      - pinned sha256 values in code, for the model and for the runtime that runs it;
      - an owner approval card naming the address, size, hash, folder and licence;
      - a download to a temp file, with the hash checked before anything is used;
      - the files live in `<dataDir>/skill-finder/`;
      - Remove deletes them.
    - Legion's install package does not change, so this is an ordinary code-only update.
    - Fallback if the runtime must be a bundled dependency instead: the updater already applies
      dependency-change releases through the signed full package (`docs/SHIPPING.md`), with no reinstall.
    - CPU only, run once per turn. Vectors are cached per skill content hash. No server.
  - **Provider embeddings (option):** an embeddings endpoint of a provider the owner already set
    up. Off by default; turning it on says plainly that prompts leave the machine.
  - **Fusion:** a weighted score, not plain rank fusion (a community router measured RRF worse
    than embeddings alone). The weights come from P1.
- **Stage 3: Haiku rerank (option).**
  - It runs only when the top scores are close (an ambiguity margin from P1), on the top 8, and returns the top 3.
  - It has a hard deadline, and on a timeout it falls back to stage 2.
  - The UI shows its cost per turn, with a monthly cap that comes from the existing spend controls.
- **Learning:**
  - Each agent keeps its own usage record, stored locally.
  - A suggested skill that is loaded gets a boost. One that is suggested and ignored again and again gets a small penalty.
  - Skills the owner loads by hand also count.
- **Gates:**
  - A score threshold (below it, no note).
  - k between 1 and 5.
  - Deadlines: 50 ms without the rerank, 2 s with it.
  - Any failure means no note, never a broken turn.
- **Index:** rebuilt with the Armory catalog (cache at `armory/index.ts:91`). Re-index only on content-hash change.
- **Module:** `src/core/armory/finder/` (`index.ts`, `bm25.ts`, `embed.ts`, `rerank.ts`, `usage.ts`), with pure functions where possible.

**5. Taint (security). One rule on both paths.**
- The note carries a description only for the owner's own skills and built-ins.
- Third-party skills (`THIRD_PARTY`, `catalog.ts`) appear as id plus "(third-party)", with no
  description text, so a suggestion never taints a run. This also holds with the slim listing on.
- `armory_find` taints exactly as `armory_skills` does when it returns third-party text.
- Haiku rerank input includes third-party descriptions: that call runs in its own isolated
  context with no tools, and its output is only skill ids (validated against the candidate set).
- **Tests:**
  - With the slim listing on and only third-party matches, the run stays untainted on both paths.
  - `armory_find` taints when it returns third-party text.
  - A rerank that returns an id outside the candidate set is dropped.

**6. Slim listing (built).** Claude runs get a smaller listing via
`settings.skillListingBudgetFraction` / `skillListingMaxDescChars`. Names stay listed; the finder
carries the descriptions. Its default (on or off) is set from P1: on if Set B recall@3 with the
finder is at least the full listing's.

**7. Options. Every behaviour is skippable on first contact and switchable off.**
- **Settings → Armory → "Skill finder" (global):**
  - Suggest each turn
  - Search tool
  - Subagent suggestions
  - Ranker (keyword / keyword + local embeddings / + provider embeddings)
  - Haiku rerank
  - Slim listing
  - Suggestions per turn (1 to 5)
  - Threshold (preset: strict / balanced / eager)
  - Show suggestions in chat
- **Agent editor → Skills → Finder:** "Same as the Armory" (default), or per-agent on/off and k.
- **Test box in the Armory:** type a prompt and see the ranked skills, the scores and why
  (matched words, embedding score, usage boost). The owner can tune it here, and it is the debug view.
- **Chat:** a quiet line under the turn ("Suggested: impeccable, ux-heuristics · loaded:
  impeccable"), no side stripe. Click it to see why.
- **First contact:** a one-time notice with Keep / Turn off. The local model download asks first and shows its size.

## Steps
- **P0. Worktree and durable docs.**
  - **DONE 2026-10-17.** Worktree `D:/bots/legion-wt-finder`, branch `feat/skill-finder` off
    `main` 47582700. This plan and `claude/skill-finder-tracker.md` are committed and pushed.
  - **Legion is public, and the eval sets are the owner's own prompts.** They NEVER go in the repo.
    - Build them into `claude/skill-finder-private/` (gitignored on this branch).
    - Copy the finished sets to Aetherkeep `06-projects/legion/skill-finder/`.
    - The prior art with its sources is at Aetherkeep `06-projects/legion/skill-finder/prior-art-2026-10-17.md`.
  - The repo gets only an invented fixture (`test/fixtures/skill-finder/`).
- **P1. Eval harness (an instrument, not a gate).**
  - `scripts/skill-finder-eval.mjs` builds the sets from the owner's transcripts.
    - **Set A:** the prompt before each Skill call the model chose. Exclude user-typed `/name` calls. Prompts that name the skill form their own subset.
    - **Set B (long tail):** 30 to 50 prompts for enabled skills that were never invoked. A
      Sonnet agent writes them from each skill's description without copying its keywords. The
      owner spot-checks 10 through the question UI.
    - **Negatives:** prompts with no Skill call.
  - **Metrics, per ranker stage and per set:** recall@1/3/5, MRR, false-note rate, p95 latency, Haiku cost per turn.
  - **Output:** the defaults (fusion weights, threshold presets, rerank margin, slim-listing default) are written to a committed config with the public-fixture numbers.
  - **Cache check:** `cache_read_input_tokens` across resumed turns, with and without the KG preamble (Haiku, ≤ $1).
  - Close the research gap on the remaining established harness (one opened source).
- **P2. Finder core** (`src/core/armory/finder/`): BM25, catalog `when_to_use` parsing, usage store, gates. Unit tests.
- **P3. Embeddings:**
  - Local runtime plus model download (checksum, size prompt, progress) and the vector cache.
  - The provider embeddings option.
  - Hybrid fusion.
  - Tests with a fake embedder.
  - A live check in the packaged Electron app (native module loads, model downloads, query < 50 ms).
- **P4. Haiku rerank:** isolated call, margin trigger, deadline, id validation, cost meter and cap. Tests with a fake model, plus a live probe (≤ $0.50).
- **P5. Claude path wiring:**
  - Add the `UserPromptSubmit` hook and the `SubagentStart` hook, `armory_find` on the Armory server, the slim-listing settings, and the suggestions recorded on the task.
  - Engine test: hooks present, system prompt `append` unchanged by the finder.
  - Live probe: the hook fires for SDK prompts and the agent loads a suggested skill.
- **P6. Provider path:** the note in `host.prompt` and `armory_find`. Taint tests in `test/armory-provider.test.ts`.
- **P7. KG recall to the user turn** (if P1 confirmed the cache break): move the per-prompt KG hits. Engine test plus a cache re-measure.
- **P8. Settings and UI:**
  - All the options in section 7, via the settings recipe: `shared/types.ts`, `shared/config.ts`, `core/settings.ts`, `ui/src/armory/ArmorySection.tsx`, the agent editor and `ui/dev/mock-server.mjs`.
  - The test box, the chat line with its "why", and the first-contact notice.
  - UI agents invoke `impeccable` first.
- **P9. Review and live check:**
  - `legion-adversarial-pr-review` (taint, download, rerank isolation).
  - `legion-live-render-check` for every UI piece.
  - `legion-update-path-check`.
  - The live walk before anything is marked Latest.

## Release (one; updater rule: users never reinstall)
- Everything ships in one release, including the local model option.
- The model and its runtime are owner-approved downloads into the data folder (Blender
  pattern), not package dependencies, so the release stays code-only.
- If P3 finds the runtime must be bundled after all, the release is a dependency-change
  release. The updater applies it through the signed full package, with a full-install
  rehearsal under `legion-update-path-check`. Still one release, still no reinstall.

## Verification
- `npm run typecheck` plus the touched test files locally. GitHub CI is the full gate.
- The eval report, committed with the public fixture numbers. Private numbers go in the tracker as figures only.
- **Live:**
  - A Claude agent gets "make this page feel premium". The note names the design skills, and the agent loads one.
  - A Danish prompt finds the same skills (embeddings on).
  - Check Legion `logs/` after each run.
- **Negative:**
  - An agent with impeccable off never sees it suggested.
  - A provider run with only third-party matches stays untainted.
  - A forged rerank id is dropped.
- **Cache:** turn 2 of a resumed task shows `cache_read_input_tokens` > 0 with every finder option on.

## Unverified now
- Whether the SDK fires `UserPromptSubmit` and `SubagentStart` for `query()` runs (P5 probe).
- Whether the catalog parses `when_to_use`.
- Which ONNX runtime loads in Legion's packaged Electron, and whether it can ship code-only (P3).
- Whether the KG preamble already breaks the cache (P1).
