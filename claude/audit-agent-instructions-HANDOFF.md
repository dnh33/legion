# HANDOFF: bot-instructions audit, PHASE 2 (written 2026-10-03; read this, then `claude/audit-agent-instructions.md`)

Branch: `claude/agent-audit` (push only there). Base merged in: `origin/integration/v1` 5da600d (browser merged, one engine = Edge/Chrome, Lightpanda gone). Phase 1 (audit) is done and approved; owner answers are in section 8 of the audit file. Nothing here is gated yet.

## Task (from the orchestrator)
Apply the minimal factual fixes, add the generated "What you can do right now" block (built from the real registered tools and gates), add four tests with negatives, keep every persona byte-identical except two owner-approved sentences. Do not touch the tripwire or hedge tests except to extend. Gate, then report in under 150 words: gate counts, removed test lines (should be none), what is not verified. No PR unless asked.

## Done (all committed in the push that carries this file)
- `src/core/agent-facts.ts` (new): `renderCapabilities(agent, {servers, ceiling?, vmEnabledForAgent})`, reads tool names from each in-process server's `instance._registeredTools`. Lines per server, VM line, browser lines (Herald: open/read/links only, told not to use browser_type/click/eval; others: cards in ask mode; all: Inbox line), BSV taint line (Assayer only, no numbers), Sentinel "scheduled runs are planned, not available yet", approvals line with ceiling. `INTENTIONALLY_HIDDEN` is empty on purpose.
- `src/core/engine.ts`: `buildOptions` computes `servers` once, inserts the block between module preambles and the persona (before the Projects block). NOT added to the provider path (providers are flag-gated off in 0.2.0): note it.
- Text fixes: roster Sculptor (default local; backup live-only) and Assayer (never choose the network, mainnet hard-off) sentences; README line 37 and docs/ARCHITECTURE.md Blender paragraph (local default, live backends, VM); browser preamble (`src/core/browser/tools.ts`) now says Edge or Chrome, text only, no screenshots.
- Already fixed by T4 (not touched): BSV seed pack, README/BSV-MODE/ARCHITECTURE "no spend tool" lines (S1, S8).
- Tests (all pass locally: 11 tests): `test/agent-facts-helpers.ts`, `test/agent-facts.test.ts` (coverage, gates, Herald, Assayer/Sentinel, limits), `test/agent-persona-snapshot.test.ts` (13 pinned hashes; only assayer and sculptor hashes changed vs integration/v1), `test/agent-stale-claims.test.ts`.
- Scratch mutations (each made a named test red, then reverted): persona byte change; "you choose the network"; drop the kg server line; Herald deny set emptied; BSV line shown to everyone (needed the extra `bsv_status` assertion, added); Sentinel line moved to scout; README "inside its VM" re-added; ceiling ignored.

## NOT done (do these, in order)
1. `rm -rf dist && npm ci && npm run build:ts && npm test && npm run typecheck && npm run build:ui`. Report exact counts. Fix any test that pins the old browser preamble text or the old roster sentences (none seen yet because the full suite has not run). Existing engine tests that inspect `systemPrompt.append` may need the block accounted for.
2. Removed test lines check: `git diff origin/integration/v1 -- test/ | grep '^-[^-]'` must be empty (only additions). Tripwire/hedge tests untouched; confirm the block text passes `test/bsv-hedge.test.ts` and `test/bsv-tripwire*.test.ts` (they are in the full suite).
3. Optional: one engine-level test that a run's `systemPrompt.append` contains the block before the persona (use the `setup()` helper pattern in `test/engine.test.ts`), with a negative.
4. Not changed on purpose: README.md:77 and docs/ARCHITECTURE.md:30/209 "Node 20.10 / system node" (S10): the prebuilt package docs were not verified; check against the shipped installer docs before touching, or list as open.
5. Commit with the trailer lines from the session attribution, push to `claude/agent-audit` only, then send the under-150-word report. Add "Needs a real PC" items to `claude/tracker-pc-checks.md` only if something here needs one (currently: none; all text, no real-PC behaviour; the model's actual behaviour with the block was never run against real Claude).

## Facts for the report
Block size about 1.3 KB (about 330 tokens) per run. Not verified: Windows run, real Claude behaviour with the block, the Edge/Chrome wording against a real PC (browser "not tried on a real PC"), provider path (no block there).
