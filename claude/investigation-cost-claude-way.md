# Investigation: how "the Claude way" bills multi-agent work

Researched 2026-10-06 by Scout. Every row cites a page fetched in this run. Anything not found is marked **unsourced**.

Source keys:
- **SA** = https://code.claude.com/docs/en/sub-agents
- **AT** = https://code.claude.com/docs/en/agent-teams
- **CO** = https://code.claude.com/docs/en/costs
- **PC** = https://code.claude.com/docs/en/prompt-caching
- **API-PC** = https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- **MAR** = https://www.anthropic.com/engineering/multi-agent-research-system

Note: SA and PC were read through WebFetch, which summarises with a small model. Quotes are as returned, not byte-checked against the raw page.

## (a) Context a subagent starts with, and what returns

| Claim | Detail | Source |
|---|---|---|
| Non-fork subagent starts with a fresh, isolated context window | Contains: its own system prompt plus appended environment details (not the Claude Code system prompt), the delegation prompt, CLAUDE.md hierarchy (incl. AGENTS.md), git status snapshot, preloaded skills, sibling roster | SA, "What loads at startup" |
| Built-in Explore and Plan skip CLAUDE.md | `omitClaudeMd: true` frontmatter drops user/project/local CLAUDE.md for custom agents; managed policy still loads | SA |
| Does NOT receive | parent conversation history, output style, auto memory | SA |
| Fork is the exception | Inherits whole conversation, system prompt, tools, model. Started with `/subtask` | SA, fork vs non-fork table |
| What returns to parent | Only the subagent's final summary. Its tool calls and file reads stay in its own context. Final report is scanned for instruction-shaped patterns | SA, "What returns" |
| Agent-team teammate context | Loads CLAUDE.md, MCP servers, skills, plus the spawn prompt. Lead's history does not carry over | AT, "Context and communication" |
| Subagent description overhead | Startup warning when combined subagent descriptions exceed 15,000 tokens | SA |

## (b) Cache sharing, TTL and pricing

| Claim | Number | Source |
|---|---|---|
| Non-fork subagent does NOT read the parent's cache (prefixes differ); warms its own across its turns | n/a | PC, "Subagents and the cache" |
| Parent's cache is unaffected by spawning | n/a | PC |
| Fork reads the parent's cache on its first request (identical system prompt, tools, history) | n/a | PC; SA |
| Resumed subagent's first request can read the cache the original run warmed | n/a | PC |
| Subagents, teammates, forks, compaction fall in the "everything else" TTL bucket | n/a | PC, "Which TTL each request gets" |
| Default TTL: main conversation 1 h on a subscription within plan usage; 5 min on API key, cloud provider or usage credits. "Everything else" 5 min | 5 m / 1 h | PC |
| Override TTL | `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` (v2.1.242+); per-agent `experimental.cacheTtl` (v2.1.248+) | PC |
| 5 min cache write | 1.25x base input | API-PC |
| 1 h cache write | 2x base input | API-PC |
| Cache read | 0.1x base (standard); 0.05x for Opus 5.5; 0.025x for Fable 5.1 / Mythos 5.1 | API-PC |
| Opus 5.5 example | base $4, 5m write $5, 1h write $8, hit $0.20 per MTok | API-PC |
| Minimum cacheable prompt | 512 tokens on the Claude 5-family models; 4,096 on Haiku 4.5 | API-PC |
| Each model has its own cache; model switch = full re-read | n/a | PC, "Switching models" |
| Cache scope | Same directory and machine share prefixes. Parallel sessions in the same dir read each other's cache | PC, "Cache scope" |
| Workflow fan-outs hold all but the first agent up to 5 s so they read the first agent's cache | 5 s | PC |

## (c) Published multipliers and cost guidance

| Claim | Number | Source |
|---|---|---|
| Agents vs chat | about 4x tokens | MAR |
| Multi-agent vs chat | about 15x tokens | MAR |
| Token usage alone explains | 80% of BrowseComp performance variance (95% with tool calls and model choice) | MAR |
| Agent teams vs a standard session, teammates in plan mode | approx. 7x tokens | CO, "Manage agent team costs" |
| Agent-team cost scaling | "roughly proportional to team size"; "significantly more tokens"; subagents "lower: results summarized back" | CO, "Agent team token costs"; AT, comparison table |
| Agent teams are experimental, off by default | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Interactive sessions only; not in `-p` or Agent SDK | AT |
| Team guidance | Use Sonnet for teammates; 3-5 teammates; shut down finished teammates (idle ones keep consuming) | CO; AT |
| Enterprise average | about $13 per developer per active day; $150-250 per month; under $30 per active day for 90% | CO |
| Subagent requests count toward the same usage limits as the main conversation | n/a | SA, "Usage limits" |
| Concurrent subagent cap | 20 by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) | SA |

## (d) Model per subagent

| Claim | Detail | Source |
|---|---|---|
| `model` field values | `sonnet`, `opus`, `haiku`, `fable`, full model ID, or `inherit` | SA, "Choose a model" |
| Resolution order | per-invocation parameter, then frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then main model | SA |
| Force one model for all | `CLAUDE_CODE_SUBAGENT_MODEL` plus `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | SA |
| Docs recommend `model: haiku` for simple subagent tasks | n/a | CO, "Choose the right model" |
| Teammates: model chosen from spawn prompt, then definition, then env, then lead. Fixed at spawn | n/a | AT |

## (e) Cost pitfalls

| Pitfall | Detail | Source |
|---|---|---|
| Parallel subagents returning detailed results bloat the parent | Docs: "can consume significant context, and each subagent spends tokens of its own". Suggests separate sessions with cross-session messaging for long parallel work | SA, "Parallel context impact" |
| Resumed subagent keeps full history | "Resumed subagents retain full conversation history". Each resume re-sends that history, and is cheap only while its cache (5 min default) is warm. This is inferred from the two facts; no doc states the resume cost directly | SA; PC (inference) |
| 5-min default TTL for subagents | A pause of more than 5 min between SendMessage calls means a cold re-read of the whole subagent history, even on a subscription | PC |
| Each subagent re-reads files on its own | Subagent file reads stay in its own context. **No doc states** the duplicate-read cost across parallel subagents: unsourced. Follows from "fresh isolated context" | SA (inference) |
| Idle teammates and background triggers consume tokens | Idle goal check-ins, scheduled tasks, cross-session messages each send the full context | CO, "Why usage climbs" |
| Long sessions: full conversation re-sent every request | Billed at the cached rate when warm | CO |
| Compaction is itself a large request | Cheap if warm, expensive after a long idle | PC |
| Per-agent cost visibility | `Prompt cache (main)` in `/usage` covers the main conversation only, not subagents | CO |
| Not found | Published per-subagent startup token size (system prompt plus tool schemas): **unsourced** | n/a |
| Not found | Any figure for subagents specifically vs a single session (the 4x and 15x figures are chat-relative, from the research system) | n/a |

## What is the same as Legion, what differs

Legion's model, as described: each target agent is its own Agent SDK session, and repeat asks resume it to reuse the prompt cache.

**Same**
- Isolated context per agent. Only a summary or answer returns to the caller (SA).
- Each agent has its own cache, not shared with the caller (PC). Legion's separate-session model matches Claude's non-fork subagent.
- Resume continues full history and can reuse the cache while warm (SA, PC). This is the same mechanism as Legion's repeat-ask resume.
- Agents are billed as independent requests on top of the caller's (CO).
- Model can differ per agent and Haiku is allowed (SA).

**Differs**
- Claude subagents start from a fresh definition: own system prompt plus CLAUDE.md plus git status. Legion agents load a persistent agent identity and context. The startup size comparison is **unsourced** on the Claude side.
- Claude's default TTL for subagents is 5 min (PC). A Legion resume after more than 5 min is a cold read unless the session sets 1 h. Check which TTL Legion's SDK sessions get: **unverified here**, and the SDK is the "main conversation" bucket per PC, which would give it the 1 h subscription default.
- Claude has a fork mode that shares the parent's cache. Legion has no equivalent.
- Claude can address subagents by name (SendMessage) inside one process. Agent teams add a shared task list and mailbox, but are experimental, interactive-only, and not available via the Agent SDK (AT). So a "Claude way" baseline for headless or SDK use is subagents plus SendMessage, not teams.
- Claude's own advice for long parallel work is separate sessions with cross-session messaging (SA). That is closer to Legion's design than to nested subagents.

**Fair baseline suggestion:** compare a Legion ask against (1) a fresh Agent-tool subagent on the same model with the same task, and (2) a SendMessage resume, with TTL fixed at 5 min and then 1 h. Count `cache_creation` vs `cache_read` tokens in each, and price them with the multipliers above.
