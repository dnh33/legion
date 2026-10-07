# Comms efficiency: where a bridge run's tokens go (measured)

Exorcist, 2026-10-06. Measurement and design only. No code in the repo was changed.

Method:
- Real API runs through the Agent SDK 0.3.285 that Legion ships, on the owner's Claude login. No API key is set, so `count_tokens` was not available.
- Each run: `maxTurns: 1`, prompt "Reply with just OK.", `strictMcpConfig: true`, cwd = Scout's workspace. Tokens = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of the first API call.
- Part texts were extracted verbatim from a real cold bridge start (Scout, session 7a7bba12, 64,912 tokens).
- Each part was measured as a delta: a 463-token floor run (own one-line system prompt, `tools: []`, `settingSources: []`), then the floor plus that part's text.
- Scripts and raw results: `D:\bots\tmp-cost\measure\` (`run.mjs`, `results.jsonl`, `cluster.js`), outside the repo. The test runs cost about $1.20.

## 1. Cold-start A/B (measured)

| Run | Sonnet | Opus |
|---|---|---|
| preset + Legion append, `settingSources: ['user','project','local']` (current) | **62,263** | **62,343** |
| same, `settingSources: []` | **23,721** | **23,759** |
| **inherited Claude Code settings** | **38,542 (61.9%)** | **38,584 (61.9%)** |

- The 58% estimate in investigation-cost-bridge.md is confirmed, and slightly low: the measured share is 62%.
- The two models count the same tokens to within 0.2%.
- The test runs had no Legion MCP servers. A real cold start is about 2.6K tokens higher: 64.9K in the transcript vs 62.3K here. That gap is the Legion tool schemas and the deferred Legion tool names.

## 2. Per part (measured unless marked)

| Part | Tokens | Method | Needed by a bridge target? |
|---|---|---|---|
| Inline tool schemas, built-in (Read, Edit, Bash, PowerShell, Agent, Skill, ToolSearch, Workflow, ScheduleWakeup, AskUserQuestion, ReportFindings…) | **18,420** | A/B: preset with `settingSources: []` minus `tools: []` | **Partly.** File, shell and search tools: yes. Workflow (needs explicit owner opt-in), ReportFindings (code-review UI), AskUserQuestion (no human on the bridge) and ScheduleWakeup: no. These four are 9,351 tokens as JSON text, est. **~6.7K** as real schemas (scaled by the measured 18.4K/25.7K ratio). |
| Agent list (`agent_listing_delta`, 150+ plugin subagent types) | **22,553** | floor delta | **No.** A target answering a peer almost never spawns a plugin subagent. The 5 built-in types are enough. |
| Skill list (353 skills) | **11,060** | floor delta | **Partly.** A few skills carry method (systematic-debugging, TDD, verification). Most are marketing, SEO or design and unused on the bridge. |
| CLAUDE.md + AGENTS.md (user + C:\Users\Danie) | **4,949** | floor delta | **Partly.** The owner's writing rules are signal. The Rune identity ("You are Rune") contradicts the Legion persona. The fa-tornby facts are noise here. |
| superpowers SessionStart hook | **1,294** | floor delta | **No.** "1% chance → MUST invoke a skill" drives extra Skill calls, so extra turns. It works against a short answer. |
| Legion append (preamble, modules, capabilities, persona) | **2,718** (A/B: 2,727) | floor delta and A/B | **Yes.** It carries the approval, taint and comms rules and the persona. |
| Claude Code built-in system prompt + env/date attachments | **~2,111** | `tools: []` preset minus floor | **Yes.** |
| Deferred tool name list | **715** | floor delta | **Partly.** It lets ToolSearch find the board, KG and comms tools. |
| `mcp__legion__agents/ask/tell` schemas | 1,486 as JSON text, **est. ~1.1K** real | floor delta, scaled | **Yes.** |
| Bridge header `[From X (Legion agent) via the bridge…]` | **39** | floor delta | **Yes.** It is the only provenance signal the target sees. |
| Floor (harness minimum) | 463 | measured | – |

The inherited parts add up to 39,856 tokens (agents + skills + instructions + hook), within 3.4% of the A/B difference of 38,542. Some built-in tools (Skill, Agent) shrink once plugins are gone, so the parts overlap slightly.

Cost of the inherited 38.5K (estimate, using the Sonnet price fitted in the bridge investigation: $2/M base, 1h cache write 2x, read 0.1x; Opus is about 2x that):
- Per cold start: about $0.15 on Sonnet, $0.31 on Opus.
- Per later API call: 38.5K tokens re-read, about $0.008 on Sonnet, $0.015 on Opus.
- The 2-day data set has 25 cold starts and 468 API calls. About $3.9 of writes plus $3.6 of reads: about **$7.5 of the $29.76 real spend (~25%)** on Sonnet pricing, more on Opus.

## 3. Tell-reply path (measured, runs.json, 76 runs)

19 reply-delivery runs. Each was its own caller run; `extraPrompts` = 0, so no reply was merged.

| Reply landed within N min of the previous reply run (start to start) | Runs | Their cost | Cache tokens re-read |
|---|---|---|---|
| ≤ 1 min | **7** | $0.90 | 2,274,524 |
| ≤ 2 min | 8 | $1.20 | 2,958,349 |
| ≤ 5 min | 12 | $1.56 | 3,834,726 |

- 18 of 19 deliveries were in Zealot's task_ce18c7d7e1ce. That was a fan-out: several tells, then replies arriving 0.24–4.3 minutes apart.
- With a 60 s coalescing window, 7 runs (37% of reply deliveries) would have merged into the run before them.
- The saving is that run's context re-read plus its own output: about $0.90 in this data, which is 29% of the reply path's $3.10. Each merged reply's own text is still written once (~1.3K tokens per 4K-char reply).

## 4. The 4,000-char cap (measured)

- `bridge.ts:11` sets `RESULT_MAX_CHARS = 4000`. `truncate()` at `:65` is applied at `:192` (ask) and `:214` (tell reply).
- The full text stays in the target task's `result`, but the caller has no tool to fetch it.
- 12 distinct truncations cut 10, 48, 62, 755, 845, 870, 881, 932, 1,320, 1,579, 2,295 and 2,592 chars: **12,189 in total**. The longest original reply was 6,592 chars.
- Measured prose ratio: about 3.0 chars/token (Legion append: 8,080 chars → 2,718 tokens).

| Option | Extra tokens | Signal |
|---|---|---|
| A. Raise the inline cap to 12,000 chars | **~4.1K tokens over all 12 replies** (avg ~340, max ~860 per reply), written once, then re-read at 0.1x | Lossless for every reply seen so far (max 6,592) |
| B. Head + pointer: keep 4,000 inline, add `result(taskId, offset)` to `mcp__legion__` | The same ~4.1K, **plus one extra API call per fetch** (median caller context ~105K cache read, about $0.02 Sonnet / $0.04 Opus) | Lossless, but only if the caller decides to fetch |
| A + B. Inline up to 12,000; above that, head + pointer | ~4.1K here; the cost is bounded for outliers | **Recommended** |

- Option B alone costs more than inlining for every reply in this data: one fetch turn costs more than the 860 tokens it recovers.
- Precondition: `router.ts:13` `LONG_PROMPT_CHARS = 1800` already flips an `auto` caller to Opus on most replies (16 of 18 were over 1,800 chars). Exempt bridge replies from that rule before raising the cap, or the change will cost model upgrades, not 4K tokens.

## 5. Savings proposals, ranked

| # | Proposal | Tokens saved | Risk to signal |
|---|---|---|---|
| 1 | Bridge targets (`source: 'agent'` runs) start with `settingSources: []`, or with plugins off | **−38.5K per cold start; −38.5K re-read on every API call** (~25% of spend, est.) | Medium if done alone: skills and the owner's style rules disappear. Pair it with #2. |
| 2 | Move the ~10 lines of owner style rules (plain language, answer first, no padding) from CLAUDE.md into `LEGION_PREAMBLE` | +~300 (est.) | Lowers the risk of #1 to low. It also removes the Rune / persona identity clash. |
| 3 | Per-agent skill allowlist (SDK `plugins` / skills option): for example Exorcist keeps systematic-debugging, TDD and verification | the skill list drops from 11K to ~0.5–1K (est.) | Low: keeps the method skills the persona relies on. |
| 4 | `disallowedTools` for bridge targets: Workflow, ReportFindings, AskUserQuestion, ScheduleWakeup | **~6.7K per call (est.)** | Low. None of them fits a peer answer. Workflow needs owner opt-in, and nobody can answer AskUserQuestion. This also sidesteps the ScheduleWakeup taint bug for targets. |
| 5 | Coalesce reply deliveries: hold a caller's reply run 60 s and deliver all replies that arrive in that window as one prompt, each with its own header | 7 of 19 reply runs; ~2.27M cache-read tokens; **~$0.90 (29% of the reply path)** | Low: up to 60 s of latency, no content lost. Skip the hold when it is the last outstanding tell. |
| 6 | Reply cap: 12,000 chars inline + a `result(taskId, offset)` pointer above that, with bridge replies exempt from `LONG_PROMPT_CHARS` | **Costs** +~4.1K tokens over 12 replies; avoids Opus flips | **Gains** signal: 12,189 lost chars recovered |

Do not cut: the Legion append (2.7K), the bridge header (39) or the Claude Code base prompt (2.1K). They carry the rules, provenance and tool semantics.

## 6. Not measured

- Answer quality with each cut. Only the token side is measured. To check it, A/B #1+#2 on 5–10 real bridge asks from `messages/*.jsonl` and compare the answers blind.
- Real schema tokens for the tool subsets in #4 and for the Legion tools. These are JSON-text deltas scaled by the measured ratio, labelled est.
- Whether the SDK's `plugins`/skills options can filter per agent while `settingSources` stays on (#3).
- Re-asks caused by truncation.
- Data set: 2 days, one owner, 18 of 19 reply runs in one task. Treat the percentages as indicative.
