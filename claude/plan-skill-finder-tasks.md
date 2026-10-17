# Skill finder: implementation tasks

Design and constraints: `claude/plan-skill-finder.md`. Exact integration lines: the workspace
`code-facts.md`. Tasks run in order. Every task: TDD, typecheck, its own test files only.

### Task 1: Finder core (pure): documents, BM25, gates, the note

Files to create: `src/core/armory/finder/doc.ts`, `bm25.ts`, `rank.ts`, `note.ts`, `defaults.ts`.
Test: `test/finder-core.test.ts`.

- **`doc.ts`**
  - `export interface FinderDoc { id: string; name: string; description: string; whenToUse: string; headings: string; source: SkillSource; thirdParty: boolean }`.
  - `export function docFromEntry(e: CatalogEntry, read?: (p: string) => string | null): FinderDoc`.
    - Reads at most 64 KB of `e.path` (null path: no file).
    - `whenToUse` is the frontmatter `when_to_use` value (single line or a YAML `>`/`|` block, max 1536 chars).
    - `headings` is every markdown heading line of the body (`#`..`###`), joined with spaces, max 2000 chars.
    - An unreadable file gives empty strings.
    - `thirdParty = THIRD_PARTY.has(e.source)`.
    - The read is injectable for tests.
- **`bm25.ts`** (BM25F, written fresh; reuse only `tokenize` from `src/core/kg/text.ts`)
  - `buildIndex(docs: FinderDoc[]): FinderIndex` and `scoreIndex(ix, query: string): Map<string, { score: number; matched: string[] }>`.
  - Field weights come from `defaults.ts`: name 3 (the id tokens count as name, split on `:`, `-` and `_`), description 1.5, whenToUse 1.5, headings 0.5. `K1 = 1.2`, `B = 0.75`.
  - Only docs with score > 0 are returned. `matched` = the query tokens that hit, deduped.
- **`rank.ts`**
  - `export interface RankOpts { k: number; minScore: number; deadlineMs: number; boost?: (id: string) => number; now?: () => number }`.
  - `export interface Ranked { id: string; score: number; bm25: number; matched: string[]; boost: number }`.
  - `rank(ix, query, opts): { results: Ranked[]; timedOut: boolean }`.
    - The final score is `bm25 * boost(id)` (default boost 1).
    - Sort by score descending, then id ascending.
    - Drop results under `minScore`, then cut to `k` (clamp k to 1..5).
    - If `now()` minus start exceeds `deadlineMs` at any check, return no results and `timedOut: true`.
    - An empty or whitespace query returns no results.
- **`note.ts`**
  - `buildNote(results: Ranked[], docs: Map<string, FinderDoc>): string | undefined`. No results gives undefined.
  - Text exactly:
    - first line `Skills that may fit this request:`
    - then one line per result: `- <id>: <description, one line, max 200 chars>` for the owner's own and built-in skills, and `- <id> (third-party)` with no description for third-party skills;
    - then the last line `Load one with the Skill tool if it applies.`
  - `buildProviderNote` is the same, except the last line is `Load one with armory_skill if it applies.`
- **`defaults.ts`**
  - The field weights, K1/B, and `THRESHOLDS = { strict: 4, balanced: 2, eager: 0.8 }` (provisional; Task 11 tunes them).
  - `DEADLINE_MS = 50`, `RERANK_DEADLINE_MS = 2000`, `DEFAULT_K = 3`.
- **Tests (each with a negative):**
  - `when_to_use` block parsing, and headings.
  - The id/name weight beats a description-only hit.
  - The threshold drops weak hits, and k clamps.
  - The deadline (with a fake `now`) gives `timedOut` and no results.
  - A third-party doc's description never appears in the note.
  - Use invented skills only.

### Task 2: Eval harness and Set A

Files to create: `scripts/skill-finder-eval.mjs`, `test/fixtures/skill-finder/{skills.json,cases.jsonl}`.
Test: `test/finder-eval.test.ts`.

- **Gold set builder.** `node scripts/skill-finder-eval.mjs build --transcripts <dir> --out claude/skill-finder-private/`
  reads `*.jsonl` Claude Code transcripts under `<dir>` (default `~/.claude/projects`).
  - For each assistant `tool_use` with `name === "Skill"` it takes the closest earlier real user prompt in the same file. A real prompt is a user message with string or text content that is not a tool_result, not a `<command-name>` or `<local-command` block, not a `<system-reminder>`-only block and not a `<task-notification>`.
  - It drops calls where that user message starts with `/<skill>` (the user typed it).
  - It puts calls whose prompt contains the skill's name into subset `named`.
  - **Negatives:** real prompts with no Skill call before the next real prompt. Sample at most 300, deterministic (seeded).
  - **Output:** `setA.jsonl` (`{prompt, skill, subset}`) and `negatives.jsonl`, both in the private folder. The output folder must be under `claude/skill-finder-private/`; refuse any other path.
- **Scorer.** `node scripts/skill-finder-eval.mjs score --set <file> [--negatives <file>] --catalog <skills.json|legion> [--threshold balanced] [--k 3]`
  - It imports the compiled finder (`dist/src/core/armory/finder/*.js` via `pathToFileURL`).
  - `--catalog legion` builds the owner's real catalog read-only: `buildCatalog({ dataDir: ~/.legion, inheritClaudeCode: true })` and every entry with `state === 'on'`. It never writes.
  - **Output:** per-set recall@1/3/5, MRR, the false-note rate on negatives (a negative that gets any note), p95 latency, and per-skill recall. The report goes to stdout. `--json` writes a machine-readable file.
  - Prompts are never printed; only counts and skill ids are.
- **Public fixture:** 12 invented skills and 30 invented cases.
- **Test:** runs the scorer on the fixture and asserts the output shape and that recall@5 on the fixture is greater than 0.

### Task 3: Usage record and load events

Files to modify: `src/core/modules.ts` (`onToolUse` gets an optional 4th arg `input?: unknown`), `src/core/engine.ts` (pass `input` at the existing call, code-facts section 5).
Files to create: `src/core/armory/finder/usage.ts`.
Test: `test/finder-usage.test.ts`.

- **`usage.ts`**
  - A per-agent JSON store at `<dataDir>/skill-finder/usage.json`: `{ [agentId]: { [skillId]: { loads: number; suggested: number; ignored: number; lastAt: string } } }`.
  - Atomic write, size cap 1 MB, keep at most 500 skills per agent, newest first.
  - `noteSuggested(agentId, ids)`, `noteLoaded(agentId, id)`, `noteIgnored(agentId, ids)`.
  - `boostFor(agentId) => (id) => number` = `1 + 0.15 * ln(1 + loads) - 0.05 * min(ignored, 6)`, floored at 0.7.
- **The Skill id from a load:** Claude `Skill` input `{skill}` and provider `armory_skill` input `{id}`, resolved with `resolveName` from `catalog.ts`. An ambiguous or unknown name is ignored.
- **Tests:** the boost formula, the cap, a corrupt file (starts empty and is never thrown), and the onToolUse input passthrough (fake module).

### Task 4: Finder settings (armory.json) and per-agent override

Files to modify:
- `src/core/armory/store.ts`: `ArmoryFile.finder`, clamped in `clean()`.
- `src/core/armory/index.ts`: the `POST /api/armory/finder` route and `finder` in `overview()`.
- `src/shared/armory-view.ts`: `ArmoryData.finder`.
- `src/shared/types.ts`: `AgentProfile.skillFinder?: 'inherit' | 'on' | 'off'`, plus `skillFinderK?: number`.
- The agent validation where `skills` is validated (find it via `AgentProfile.skills`).

Test: `test/finder-settings.test.ts`.

- **Shape:** `finder: { suggest: boolean; searchTool: boolean; subagents: boolean; ranker: 'keyword' | 'local' | 'provider'; providerId?: string; providerModel?: string; rerank: boolean; rerankMonthlyUsd: number; slimListing: boolean; k: number; threshold: 'strict' | 'balanced' | 'eager'; chatLine: boolean; noticeSeen: boolean }`.
  - **Defaults:** suggest true, searchTool true, subagents true, ranker 'keyword', rerank false, rerankMonthlyUsd 1, slimListing false, k 3, threshold 'balanced', chatLine true, noticeSeen false.
  - `clean()` keeps only known keys and strict types, clamps k to 1..5 and the monthly USD to 0..50.
  - **Ranker fallback:** 'local' falls back to 'keyword' while the model is not installed; 'provider' falls back when no provider matches. Both are decided at use time, not in `clean()`.
- **Route:** admin-only like `allow-shell` (code-facts section 6). Partial patch. A bad type is a 400 naming the field. It returns the full block.
- **Helper:** `finderFor(file, agent)` gives the effective settings. Per-agent 'off' disables suggest/search/subagents for that agent; 'on' forces suggest on; `skillFinderK` overrides k.
- **Tests:** defaults, clamping, the route on armoryRig, and the per-agent merge.

### Task 5: Claude path wiring

Files to modify:
- `src/core/armory/index.ts`: a finder index cached with the catalog; candidates = the exact ids of `claudeSkills(agent).skills`, built by one shared helper that `claudeSkills` also uses.
- `src/core/modules.ts`: a new `CoreModule.turnNote?(agent, ctx: { prompt: string; taskId: string; runtime: 'claude' | 'provider'; subagentType?: string }): Promise<TurnNote | undefined>`, with `TurnNote = { text: string; suggested: string[]; why: Ranked[] }`.
- `src/core/engine.ts`, `src/core/armory/tools.ts`, `src/shared/types.ts` (`Task.skillTurns`).

Test: `test/finder-claude.test.ts`.

- **Rank the right text.** `execute` keeps `sendText` (code-facts section 1) on `act.rankText`. The finder ranks `act.rankText`, never the header.
- **`UserPromptSubmit` hook** in `buildOptions`, set the way `SessionStart` is set (code-facts section 1).
  - For each `input.prompt`: the first fire uses `act.rankText`; later fires (a mid-run user message) use `input.prompt`.
  - It calls each module's `turnNote` and returns `{ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }` when there is a note, otherwise `{ continue: true }`.
  - Errors are caught and give `{ continue: true }`.
- **Subagents.**
  - A `PreToolUse` hook with matcher `Agent|Task` records `{ subagent_type, prompt }` from `tool_input` in a per-run FIFO on `act` (max 20).
  - The `SubagentStart` hook takes the first FIFO entry with the same `agent_type` (falling back to `act.rankText`), ranks it, and returns `additionalContext`.
  - Only when `finder.subagents` is on.
- **Slim listing:** when on, `settings` gets `skillListingBudgetFraction: 0.002` and `skillListingMaxDescChars: 120`. Off: neither key is present.
- **`armory_find(query, limit?)`.**
  - It ranks the same candidates and returns `<id> (score): description`, with third-party skills as `<id> (third-party)` and no description, then marks the run tainted if any returned line carried third-party text. With this rule, no line carries third-party text, so the tool never taints. Assert that.
  - Claude runs get a `legion_armory` server that has ONLY `armory_find` (`mcpServers` today returns `{}` for claude). Provider runs get it next to the existing two tools.
  - It is gated by `finder.searchTool`.
- **Turn records:** each note is recorded as `Task.skillTurns` (max 50, oldest dropped) `{ at, suggested, loaded: [], why }`. A Skill load in the same run appends to `loaded` of the last turn and calls `usage.noteLoaded`. At run end, suggested-but-not-loaded ids call `usage.noteIgnored`.
- **Tests:**
  - The hook exists only when suggest is on.
  - `additionalContext` names a matching on-skill.
  - An off skill and a manual skill are never named.
  - The header text is not ranked.
  - The system prompt `append` is byte-identical with the finder on and off.
  - Slim-listing settings appear only when on.
  - `SubagentStart` uses the FIFO prompt.
  - `armory_find` never returns an off skill.
  - Third-party skills appear without a description.
  - `skillTurns` gets updated and capped.

### Task 6: Provider path wiring

Files to modify: `src/core/engine.ts` (`runProvider`: prepend the provider note plus `\n\n` to the `prompt` passed to `host`, code-facts section 2) and `src/core/armory/tools.ts` (`armory_find` added to the provider server).
Test: `test/finder-provider.test.ts`, using `providers-harness`/`providers-fakes` as `armory-provider.test.ts` does.

- **Tests:**
  - The fake server's last user message starts with the note, and the stored message has the raw prompt only.
  - The system message is unchanged.
  - A run whose only matches are third-party stays untainted.
  - `armory_find` on a provider run returns no off skill.
  - Taint follows the existing rule for `armory_skills`.

### Task 7: Local runtime spike (report only, no product code)

Decide how a local embedding model runs inside Legion's packaged Electron main process, on Windows x64, without new npm dependencies if possible.
- **Candidates:**
  - (a) A WASM ONNX runtime plus a tokenizer, downloaded on request, pinned sha256, loaded from `<dataDir>/skill-finder/runtime/`.
  - (b) `onnxruntime-node` as an npm dependency (a dependency-change release).
  - (c) Any other in-process option found.
- **Models:** compare at least two small multilingual embedding models (size, licence, a Danish to English match check).
- **Measure:** query embed time, memory, the download size, the licence of each file, the exact URLs, and the sha256 of each file.
- **Output:** a written recommendation to `.superpowers/sdd/plan-skill-finder/task-7-report.md` with the exact pin values for Task 8.
- Scratch code only in the workspace. Nothing committed.

### Task 8: Embeddings (local download and provider) and fusion

Files to create: `src/core/armory/finder/embed.ts` (`Embedder` interface `embed(texts: string[], signal): Promise<Float32Array[]>`, cosine, a vector cache keyed by sha256 of the doc text in `<dataDir>/skill-finder/vectors.json`), `local-model.ts`, `provider-embed.ts`, `get-model.ts` (download).
Files to modify: `src/shared/finder.ts` (the pin, from the Task 7 report), `src/core/armory/finder/rank.ts` (fusion), `test/bsv-scan.ts` ALLOWLIST (a new network file only if needed).

- **Download.** Copy the Blender flow (code-facts section 8): ports, pinned sha256, an approval card through `deps.approvals.request` with address, size, hash, folder and licence, temp file, hash check before use, staging, then the record.
  - Routes: `POST /api/armory/finder/model/get`, `GET /api/armory/finder/model` (status: not installed / downloading / ready / error) and `DELETE /api/armory/finder/model` (removes the files).
  - Admin-only.
  - Never started by an agent.
- **Provider embeddings:** `providerRequest(target, '/embeddings', { method: 'POST', body: { model, input }, accept: 'json' })` (code-facts section 10). Export a small target builder from `providers/runtime.ts`. It is used only when the ranker is 'provider'.
- **Fusion:** `score = w * cosineNorm + (1 - w) * bm25Norm`, with both normalised to 0..1 over the candidates and `w` from `defaults.ts` (provisional 0.6). The threshold applies to the fused score when embeddings are on (separate presets in `defaults.ts`). Any embedder failure or timeout falls back to BM25 for that turn.
- **Tests:** a fake embedder for fusion and fallback, the vector cache re-embedding only changed docs, the download flow with fake ports (hash mismatch deletes the file, no approval means no download), and the routes being admin-only.

### Task 9: Haiku rerank

Files to create: `src/core/armory/finder/rerank.ts`.
Files to modify: the finder state for spend, in `<dataDir>/skill-finder/spend.json`, by month.

- **Trigger:** only when `finder.rerank` is on and `top1.score - top3.score <= margin` (provisional 0.15 on the normalised scale, `defaults.ts`).
- **The call:** a single `query()` mirroring the `handshake.ts` options (code-facts section 10: `settingSources: []`, `strictMcpConfig`, `persistSession: false`, `disableAllHooks`, `env: buildChildEnv`, abort controller), plus `model: 'haiku'`, `maxTurns: 1`, no tools, and `disallowedTools` covering every built-in.
  - The prompt holds the user text and the top 8 candidates (id plus description; third-party descriptions are allowed here because the call is isolated and returns ids only). It asks for a JSON array of up to k ids.
- **The answer:** parse strictly. Ids outside the candidate set are dropped. Invalid JSON, a timeout (2000 ms) or a cost cap reached means the fused order stands.
- **Spend:** read `total_cost_usd`, add it to the month, and skip the rerank once over `rerankMonthlyUsd`. `queryFn` is injectable (like `ProbeQueryFn`).
- **Tests:** the margin trigger, a forged id dropped, invalid JSON, the timeout, the cap, and that the options carry no tools.

### Task 9b: Armory keeps your skill choices when Claude Code's listing fails

The owner folded this into the branch (2026-10-17). Diagnosis: 104 'on' records, 68 of whose ids the disk discovery never finds (whole plugins such as every `design:*` and `engineering:*`). It is not an id-format mismatch. The logs show 0 listing failures so far.

Files to modify: `src/core/armory/index.ts` (`refresh`/`ensure`, code-facts: index.ts 97-134), `src/core/armory/store.ts` (or a new `listing-cache.ts`), `src/shared/armory-view.ts`, `ui/src/armory/ArmorySection.tsx` (Discovery line).
Test: `test/armory-listing-cache.test.ts`.

- **Every successful SDK listing is saved** to `<dataDir>/armory/sdk-listing.json`: `{ at, inherit, skills: DiscoveredSkill[], cli: string[] }`. Atomic write, 2 MB cap.
- **When the SDK listing fails**, use the saved listing if its `inherit` matches. The mode is `'sdk-cached'`, and the reason says "Using the skill list Claude Code gave on <date>; the live listing failed: <why>". Read the disk only when no saved listing exists.
- **`overview()`** adds `unmatchedOn`: how many 'on' records match no listed skill. The Discovery line shows "N of your switched-on skills were not found in the current list, so agents do not get them" when N > 0, with the existing Refresh action.
- **Tests:**
  - A failed probe with a saved listing keeps every 'on' choice, and `claudeSkills` returns them.
  - A failed probe without one reports `unmatchedOn`.
  - A successful probe overwrites the saved listing.
  - A corrupt file is ignored.
  - An `inherit` mismatch ignores the cache.

### Task 10: KG per-prompt recall to the user turn (only if Task 11 confirms the cache break)

Measure first (Task 11 cache check). If cache reads drop on resumed turns because the knowledge-graph preamble changes:
- Split `kg/index.ts` `preamble` into a stable part (stays) and a per-prompt part, delivered through `turnNote` with the same `UserPromptSubmit`/provider-prompt channel.
- Engine test: the `append` is stable across two prompts.
- If the check shows no break, mark this task "not needed" in the ledger, with the numbers.

### Task 11: Eval round, tuned defaults and cache check

- **Set B:** the controller dispatches a Sonnet agent to write 30 to 50 long-tail prompts (enabled skills with zero Set A hits) into `claude/skill-finder-private/setB.jsonl`. The owner spot-checks 10.
- **Runs:** the scorer on Set A, Set B and the negatives for keyword, local, provider (when configured) and the rerank (sampled, at most $1).
- **Writes:** the tuned values into `defaults.ts` (thresholds, fusion weight, margin) and the slim-listing default rule result. Figures go in `claude/skill-finder-tracker.md`, never prompts.
- **Cache check:** DONE by the controller's live probe (ledger): a changing system prompt re-writes everything after the change point, so Task 10 is needed.
- **Set B** is already built to Anthropic's eval guidance: 463 prompts graded by Haiku (ledger). The scorer adds its subsets (longtail / ambiguous / long; an ambiguous case counts a hit on `skill` or `alt`).
- **Metrics:** report **note precision** (a shown note contains the gold skill) next to recall. It decides the default together with the false-note rate (pre-registered ruling in the ledger: keyword default ON only if false-note ≤ 0.15 and precision ≥ 0.50).
- **Raw-cosine floor:** with embeddings on, add an absolute raw-cosine floor next to the fused threshold. e5 cosines sit in a narrow band, so min-max alone always passes the top skill. Tune it on the negatives.
- **Outcome eval** (Anthropic: test with the models you plan to use).
  - 60 prompts (30 from Set A, 30 from Set B) and 20 negatives through the real SDK, with the owner's skill listing, on Haiku and Sonnet.
  - Condition A is the listing only. Condition B is the listing plus the finder note (tuned default ranker, and the local model in a temp data dir).
  - Measure the rate at which the first Skill call is the gold skill, and false Skill calls on the negatives.
  - `maxTurns` 1 (allow Skill only), a total cap of $5, and stop at the cap.
- **The owner sees** the tuned numbers and the resulting defaults in one question-UI message before release.

### Task 12: Armory UI: the Skill finder section and the test box

Files to create: `ui/src/armory/SkillFinder.tsx`.
Files to modify: `ArmorySection.tsx` (mount it between WhatAgentsSee and Advanced), `armoryStore.ts` (load/patch finder, optimistic with rollback like `setAllowShell`), `armory.css` (the `arm-` prefix, tokens only).

- **Route:** `POST /api/armory/finder/test` `{ query, agent? }` returns the ranked list with score, bm25, cosine, boost and the matched words, for the agent's candidates (or the Armory 'on' set). Admin-only.
- **Controls:** every switch in the plan's section 7.
  - The ranker select shows the local model state (Get model card / downloading / ready / Remove).
  - The provider select lists the configured providers.
  - The rerank switch shows the month's spend against the cap.
- **First-contact notice:** "Legion now suggests skills that fit each message. Keep / Turn off", once (`noticeSeen`).
- **State matrix for the shots:** defaults; everything on; local model not installed / downloading / ready / error; test box empty / results / no match; notice shown; narrow width; light and dark.

### Task 13: Agent editor control and the chat line

Files to modify: `ui/src/armory/AgentSkills.tsx` (or beside it in `AgentEditor.tsx`: Finder "Same as the Armory / On / Off" and suggestions-per-turn), `ui/src/components/MessageView.tsx` or `Thread.tsx` (code-facts section 7).

- **The chat line** under the assistant turn that follows a turn with `skillTurns`: `Suggested: a, b · loaded: a`.
  - Shown only when `finder.chatLine` is on.
  - Quiet text, no side stripe.
  - Clicking it opens a small popover with the why (matched words, scores).
  - Keyboard reachable.
- **State matrix:** no suggestions; suggestions none loaded; one loaded; popover open; long ids wrapping; narrow; light and dark.

### Task 14: Close

The controller runs the closing checks:
- `legion-adversarial-pr-review` (taint, download, rerank isolation, the routes being admin-only);
- `legion-live-render-check` for Tasks 12 and 13;
- `legion-update-path-check`;
- the live probe: a Claude agent loads a suggested skill, and the cache check holds;
- then the PR.
