# Investigation: what the agent-to-agent bridge actually costs (measured)

Builder, 2026-10-06. Read-only on the repo at `24d2567`. Every number below comes from one of these sources:
- `~/.legion/state.json`: 14 tasks.
- `~/.legion/messages/*.jsonl`.
- The Claude Code session transcripts that each task's `sessionId` points to: `~/.claude/projects/C--Users-Danie--legion-workspaces-<agent>/<sessionId>.jsonl`. They hold per-API-call `usage`, plus `cost-state` records with `totalCostUSD` and per-model `costUSD`.

The analysis scripts are in `D:\bots\tmp-cost\` (an.js, an2.js, an3.js, an4.js), outside the repo. Re-run them to reproduce the numbers. The data set is small (14 tasks, 74 runs, 5–6 Oct). Treat medians as indicative, not as a benchmark.

## 0. The headline: the cost Legion shows is inflated 4.4x

| | USD |
|---|---|
| Sum of `costUsd` in state.json (what the app shows) | **129.47** |
| Sum of the sessions' own final `cost-state.totalCostUSD` | **29.76** (lower bound, see §5) |

Mechanism:
- `engine.ts:1160` adds each run's `result.total_cost_usd` to the task's `costUsd`.
- On a resumed session, the SDK's `total_cost_usd` is the **cumulative session total**, not the cost of that run. Evidence: the `cost-state` records in every transcript rise monotonically across runs, with the same `startTime` for the whole session. Example: da70eeed rises 0.21 → 0.26 → 0.52 → … → 5.37 over 26 runs.
- So each run adds the whole history again. For 11 of 14 tasks, state.json `costUsd` equals the **sum of the cumulative snapshots** to four decimals.
- Worst case: Zealot's task_ce18c7d7e1ce shows **$66.42**, but its session cost is **$5.37** (12.4x).

The more turns a thread has, the worse the inflation. So the feature meant to save money, resumed pair threads, is exactly what makes Legion **look** expensive. This is a measurement bug, not spend. It likely explains the owner's "Legion costs more?" question in task_a9fffff5110c.

## 1. What usage Legion stores

| Field | Where | Claude runs | Provider runs |
|---|---|---|---|
| `costUsd` | state.json task | yes, but over-counted (§0), `engine.ts:1160` | yes, `engine.ts:983` |
| `turns` | state.json task | yes (summed `num_turns`), `engine.ts:1161` | yes |
| input / output tokens | `task.tokenUsage` | **no** | yes, `engine.ts:980` |
| cache-read / cache-creation tokens | – | **no** (only the live `contextTokens` progress value, `engine.ts:1122`, not stored) | no |
| per-model split | – | no | – |

Token and cache data for Claude runs exist only in Claude Code's own transcripts. Legion keeps no copy.

## 2. Per task (from the transcripts)

cw = cache-write tokens, cr = cache-read tokens. "True $" is the session's last `cost-state.totalCostUSD`. "Snaps" counts runs that wrote a cost-state.

| Task | Agent | Source | Runs | API calls | cw | cr | out | cr share | state.json $ | true $ | snaps | inflation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| task_90079577a083 | zealot | ui | 2 | 41 | 303,148 | 8,135,835 | 53,693 | 96.4% | 6.37 | 6.37 | 1/2 | 1.0x |
| task_da5c9a3305c1 | zealot | ui | 12 | 72 | 401,327 | 10,138,287 | 49,502 | 96.2% | 27.25 | 3.59 | 5/12 | 7.6x |
| task_7f31ed0f1e0d | exorcist | ui (from zealot) | 2 | 52 | 181,516 | 7,245,509 | 25,560 | 97.6% | 8.20 | 4.13 | 2/2 | 2.0x |
| task_2c6280394346 | exorcist | agent | 3 | 22 | 115,510 | 1,587,752 | 6,806 | 93.2% | 1.00 | 0.80 | 2/3 | 1.2x |
| task_ce18c7d7e1ce | zealot | ui | 26 | 66 | 473,305 | 6,870,864 | 43,993 | 93.6% | 66.42 | 5.37 | 26/26 | 12.4x |
| task_0bb3d7599e6a | scout | agent | 7 | 25 | 323,431 | 2,020,970 | 18,680 | 86.2% | 4.63 | 2.06 | 7/7 | 2.2x |
| task_cde99ca5ed89 | builder | agent | 4 | 91 | 601,563 | 16,216,532 | 61,667 | 96.4% | 1.00 | 0.58* | 2/4 | – |
| task_223849ed110d | inquisitor | agent | 3 | 27 | 137,484 | 2,787,941 | 18,982 | 95.3% | 4.42 | 2.04 | 3/3 | 2.2x |
| task_d36508cc4153 | archivist | ui (from zealot) | 5 | 16 | 89,179 | 1,431,600 | 8,002 | 94.1% | 2.75 | 0.72 | 5/5 | 3.8x |
| task_ea32339a25ca | preceptor | agent | 3 | 14 | 84,297 | 1,197,002 | 10,101 | 93.4% | 4.04 | 1.50 | 3/3 | 2.7x |
| task_b080b3f8ad65 | zealot | agent (from archivist) | 1 | 3 | 65,742 | 129,556 | 986 | 66.3% | 0.57 | 0.57 | 1/1 | 1.0x |
| task_77139bb4cd6b | scribe | agent | 2 | 16 | 78,533 | 1,303,148 | 7,795 | 94.3% | 1.69 | 0.65 | 2/2 | 2.6x |
| task_e5c827d4f4ee | archivist | agent | 1 | 4 | 52,784 | 215,731 | 3,337 | 80.3% | 0.29 | 0.29 | 1/1 | 1.0x |
| task_a9fffff5110c | zealot | ui | 3 | 11 | 148,245 | 668,930 | 7,193 | 81.9% | 0.84 | 1.08 | 3/3 | (run still open) |

\* Builder's runs 2 and 3, including this one, have no cost-state yet (one was interrupted). The real cost is higher than $0.58.

The cache-read share is 81–98% on every multi-run thread, so prompt caching works as designed.

## 3. By run: cold vs. warm, bridge vs. direct (74 runs)

A run starts each time a real prompt arrives. "Warm" means the first call read at least 80% of the previous context from the cache. The run $ column is the difference between consecutive cumulative snapshots, so it is exact. n$ is the number of runs that have a snapshot.

| Run state | n | median first-call cw | median first-call cr | median run $ | sum $ (n$) |
|---|---|---|---|---|---|
| cold, new session | 14 | 56,326 | 8,332 | **0.44** | 15.78 (13) |
| warm resume | 49 | **1,756** | 108,738 | **0.136** | 9.25 (42) |
| cold resume (cache lost) | 11 | 71,002 | 0 | **0.59** | 4.74 (8) |

| Run kind | n | cold-new / warm / cold-resume | median calls | median first-call context | median run $ | sum $ known |
|---|---|---|---|---|---|---|
| owner message (direct) | 30 | 4 / 22 / 4 | 2 | 144,914 | 0.169 | 13.66 |
| bridge request (ask/tell into target) | 25 | 10 / 10 / 5 | 6 | 68,316 | 0.365 | 12.87 |
| reply delivery (caller re-run) | 18 | 0 / 16 / 2 | 2 | 108,564 | 0.122 | 3.10 |
| task notification | 1 | 0 / 1 / 0 | 5 | 91,887 | 0.136 | 0.14 |

Cold-start context size is the same for bridge and direct sessions:
- Bridge: median **65,174** tokens. Range 63,720–66,164 across 10 sessions.
- Direct (owner): median **64,078** tokens across 4 sessions.

The bridge adds no prompt overhead of its own. When a session starts within the cache TTL of another agent's session on the same model, the first 16,664–18,128 tokens come from the cache. Examples: cde99ca5, 2c628039, e5c827d4, archivist and scribe sessions. That shared prefix is the Claude Code system prompt plus tools.

## 4. Fixed overhead of a cold run that does nothing

Measured total: **63,720–66,965 input tokens** on the first call of every new session (table in §3). For example, task_b080b3f8ad65 cost **$0.57** on Opus for a 3-call reply.

Content inventory of that first request, from the transcript's `prompt_snapshot` and the attachments sent before the first call (Scout, session 7a7bba12, 64,912 tokens):

| Part | Chars | ≈ tokens (est.)† | Comes from |
|---|---|---|---|
| Inline tool schemas (17 tools; PowerShell alone 17,077 chars, Workflow 8,958, ScheduleWakeup 7,893) | 70,851 | ~21,600 | Claude Code built-ins + `legion__agents/ask/tell` (2,883 chars) |
| `agent_listing_delta` (every subagent type from your plugins) | 65,988 | ~20,200 | **inherited user settings / plugins** |
| `skill_listing` | 39,881 | ~12,200 | **inherited user settings / plugins** |
| System prompt (13 blocks) | 15,058 | ~4,600 | of which **Legion's appended part is 8,081 chars ≈ 2,500 tokens** (`LEGION_PREAMBLE` + module preambles + persona, `engine.ts:818-829`) |
| `instructions` (~/.claude/CLAUDE.md + AGENTS.md) | 12,657 | ~3,900 | **inherited** (`settingSources` user/project/local, `engine.ts:831`, config `inheritClaudeCodeSettings: true`) |
| superpowers SessionStart hook context + hook record | 7,657 | ~2,300 | **inherited plugin hook** |
| deferred-tool name list | 3,140 | ~1,000 | Claude Code |
| env, model, date, session context, etc. | ~1,400 | ~400 | Claude Code |
| the bridge prompt itself | 248 | ~80 | Legion |

† Estimate. The total chars (~212K) are spread over the measured 64,912 tokens at a uniform ~3.3 chars/token. Only the total is measured, not the split.

Deferred vs. sent:
- **Deferred (not sent until ToolSearch loads them): all 42 tools of `legion_kg`, `legion_board`, `legion_comms`, `legion_house` and `legion_browser`.** Source: the `deferred_tools_delta` attachment lists them, and the inline tool list holds only `mcp__legion__agents/ask/tell`.
- Their full schemas enter the context only after a `ToolSearch` (the `deferred_tools_record` attachment), for example `legion_board__create/list` in d85067dc.
- Legion's own MCP servers therefore cost about 1K tokens of names per cold run, not their schemas.

**Legion's own share of a cold start is about 3.5K of ~65K tokens (~5%).** About 38K tokens (~58%) come from the inherited Claude Code user setup: plugins' agent list, skill list, CLAUDE.md and the superpowers hook. Not measured: whether `inheritClaudeCodeSettings: false` (`settingSources: []`) removes all of it.

Baseline for comparison: 40 native Claude Code subagent transcripts on this PC (`~/.claude/projects/*/*/subagents/*.jsonl`, mostly in D:\bots\legion):
- Median first-call context **72,105** tokens, of which **35,174 read from the parent's cache**, so ~37K written per spawn.
- A Legion cold start writes **47–67K** (median first-call cw 56,326), because it shares only a 16.6–18.1K prefix and only when another agent ran recently on the same model.
- **A Legion cold start costs more than a native subagent spawn. A warm Legion resume (median 1,756 tokens written, $0.136/run) costs less.** Native subagents are always cold, because every Agent call is a new context.

## 5. Confirmed leaks

1. **Displayed cost is over-counted (bug, not spend).**
   - Location: `engine.ts:1160` sums cumulative `total_cost_usd`.
   - Measured: $129.47 shown vs $29.76 real (§0). It grows with the number of runs per thread.
   - Fix direction: store the delta (`total_cost_usd − previous session total`), or overwrite instead of adding when resuming the same `sessionId`.
2. **A long message makes an `auto` caller switch to Opus for good.**
   - Mechanism: `router.ts:13` (`LONG_PROMPT_CHARS = 1800`) and `router.ts:39` ("continuing on opus"). A bridge reply can be up to 4,000 chars plus a header (`bridge.ts:11`, `:370`), and 16 of 18 reply deliveries were over 1,800 chars (median 4,072).
   - The first long reply routed Zealot from Sonnet to Opus: task_ce18c7d7e1ce run 4 and task_a9fffff5110c run 2.
   - Every later run in that thread then stayed on Opus. All 20 remaining ce18 runs were Opus, owner chit-chat included.
   - The switch also throws away the cache, because the cache is per model:
     - ce18 run 4: 68,397 tokens rewritten, **$0.61** vs a median warm reply of $0.12.
     - a9ff run 2: 64,706 rewritten, **$0.58**.
     - cde99ca5 run 2: a 2,240-char bridge request flipped Builder to Opus, 83,171 rewritten.
   - Also measured: 2 bridge requests over 1,800 chars sent `auto` agents to Opus (7f31ed0f Exorcist, cde99ca5 Builder). Preceptor and Inquisitor were already set to Opus.
3. **An owner message in a bridge thread orphans it, and the next ask/tell starts a new cold session.**
   - Mechanism: continuing a task overwrites `source` with the owner's `'ui'` (`engine.ts:265`), while `findPair` only matches `source === 'agent'` (`bridge.ts:284-286`).
   - Seen twice:
     - Exorcist: task_7f31ed0f1e0d became `ui`, then a new thread task_2c6280394346 cold-started at **$0.20**.
     - Archivist: task_d36508cc4153 became `ui`, then a new thread task_e5c827d4f4ee cold-started at **$0.29**, 14 minutes after the old thread's last run (inside the 1h cache TTL).
   - A warm run in these threads cost $0.02–0.15.
4. **Cache expiry between runs (1h TTL).**
   - All cache writes are `ephemeral_1h` (the usage records). 7 of 11 cold resumes are gaps over 60 minutes: 71, 124, 205, 212, 502, 505 and 628 min.
   - Each one rewrites the whole thread: 47K–234K tokens; $0.26–$1.26 where priced.
   - Long threads make each expiry dearer (ce18 run 24: 156,443 tokens, **$1.26** for a one-line answer).
5. **Each reply runs the caller again.**
   - 18 reply-delivery runs. Each re-read a median of **105,896** cached tokens.
   - Totals: 201,850 tokens written, 4,730,244 read, **$3.10**, median $0.122 per reply.
   - That is 10% of the real spend in this data set. No batching was observed: every reply was its own run, 0 queued prompts merged.
6. **The 4,000-char truncation cuts real content.**
   - 12 truncated replies or results, losing 10–2,592 chars each (12,189 chars in total), counted from `[truncated: N more chars]` markers in the transcripts.
   - Not measured: whether that caused re-asks.
7. **One unexplained cold resume.** ce18 run 3: same model, 2 minutes after run 2, yet only 21,816 of 65,537 tokens were read. The prefix changed between runs. The transcript has no system-prompt snapshot for both runs, so the cause (dynamic preamble, a settings change) is not shown.

Not leaks in this data:
- `fresh: true` was used **0 times** (searched all ask/tell inputs in `messages/*.jsonl`).
- Per-task model overrides were used 3 times (opus once, sonnet twice).
- Escalation (`engine.ts:636-642`) happened **0 times**: no task has `escalated: true`.
- Haiku side calls (titles) cost ~$0.001 per session.

## 6. What I could not measure

- **The true cost of runs that wrote no `cost-state`**: Builder runs 2–3, 2c628039 run 2, 90079577 run 1. Totals for those tasks are lower bounds.
- **Opus prices.** Sonnet fits exactly at $2/M input, 2x for 1h cache writes, 0.1x for reads, $10/M output (max error $0.00000 over 29 snapshots). The same model does not fit Opus (max error $0.24). Opus run costs above therefore use snapshot differences only, never my own pricing.
- **The per-part token split of the fixed overhead**: chars were measured, tokens were estimated (§4).
- **Savings from `inheritClaudeCodeSettings: false`**: no run with it off exists in the data.
- **The dollar cost of native subagents**: their transcripts carry tokens but no per-subagent cost-state. The subagent output token counts also look incomplete (single-digit to hundreds), so I compared input context only.
- **Concurrency effects**: no two replies landed in the same run, so batching could not be observed either way.
- **Whether truncated replies caused follow-up questions.**
- **Provider-path runs**: none in this data.

## 7. Addendum: which cache TTL Legion's SDK runs get, and how often resumes land after it expires

The question came from Scout's `claude/investigation-cost-claude-way.md` (lines 35–41, 78, 100). Per that file, Claude Code gives subagents a 5-minute TTL and the main conversation 1 hour on a subscription. Writes cost 1.25x base input at 5 minutes and 2x at 1 hour; reads cost 0.1x.

**TTL actually used: 1 hour, on every write.** The `usage.cache_creation` field is recorded on every API call in the transcripts. Over all 14 sessions (468 deduplicated calls):

| | tokens | calls |
|---|---|---|
| `ephemeral_1h_input_tokens` | **3,069,552** (Opus 1,751,726, Sonnet 1,317,826) | all with writes |
| `ephemeral_5m_input_tokens` | **0** | 0 |

Legion runs through the Agent SDK as a *main conversation*, so it gets the subscription's 1-hour TTL, not the subagent 5-minute bucket. No Legion setting asks for it: `engine.ts` has no `subagentPromptCacheTtl` or TTL option. It is Claude Code's default for this login (`auth: claude-login`).

The behaviour matches the TTL. Resumes are bucketed by the gap between the previous run's last call and the next run's first call, across all 62 resumes on the same thread (script `D:\bots\tmp-cost\an5.js`):

| Gap since previous run | Resumes | Warm (cache read) | Cold (cache rewritten) |
|---|---|---|---|
| under 5 min | 45 | 42 | 3 (2 model switches, 1 unexplained prefix change, §5.7) |
| 5–60 min | 10 | **9** | 1 (model switch, cde99ca5 run 2, 20.9 min) |
| over 60 min | 7 | 0 | **7** |

- The 9 warm resumes at 5.2–24.7 minutes are proof the TTL is longer than 5 minutes. They read 1,211,022 cached tokens in total. Under a 5-minute TTL all 9 would have been cold.
- Every gap over 60 minutes was cold.
- All resume gaps (minutes): 45 under 5, then 5.2, 6.2, 6.7, 8.2, 13.3, 15.3, 16.2, 20.2, 20.9, 24.7, 70.8, 123.8, 205.2, 212.3, 501.6, 504.8, 627.6.

**How often a pair-thread resume lands after the TTL expired:**
- Bridge-driven resumes (bridge request into the target's thread, reply delivery or notification into the caller's): **36, of which 4 (11%) came after more than 60 minutes**.
- Bridge requests into the target's pair thread only: **16 resumes, 3 after the TTL** (2c628039 at 628 min, 0bb3d759 at 505 and 212 min), plus 2 cold for other reasons. cde99ca5 runs 2–3 were a model switch and a 205-minute gap.
- So in this data, "resume is cheap" held for **11 of 16** pair-thread resumes (69%) and **32 of 36** bridge-driven resumes (89%).
- It fails when a lead comes back to a peer hours later. That is when the thread is longest, so the rewrite is largest: 47K–237K tokens.

**Is 1 hour cheaper than 5 minutes here? Not in this data (an estimate).**
- Paying 2x instead of 1.25x on all 3.07M written tokens cost an estimated **$7.26** more.
- That uses $2/M base input for Sonnet (fitted exactly, §6) and $4/M for Opus. The Opus price is taken from Scout's file, line 41, not measured here.
- The 1-hour TTL saved the 9 warm 5–60-minute resumes from being cold: an estimated **$3.75** (1,211,022 tokens × (1.25 − 0.1) × base).
- On this traffic, which is mostly short gaps (45 of 62 under 5 minutes) plus a few multi-hour gaps that no TTL covers, a 5-minute TTL would have been about $3.5 cheaper.
- This is not under Legion's control in the current code, and the sample is two days of one owner's use.

Not measured:
- Whether the SDK honours `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for a main-conversation session.
- Whether an API-key login (`auth: api-key`) gets 5 minutes, as Scout's source says. No such runs are in the data.
