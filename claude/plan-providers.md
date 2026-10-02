# Plan: multi-provider support (OpenAI, Codex models, OpenRouter, OpenCode-style and custom endpoints)

Branch `claude/providers` (from `integration/v1`). Owner decision 2026-10-02: build in v0.2.0, planned and built in one session, isolated from the BSV, Blender and docs sessions. Status of this plan: approved to build. Nothing here is verified against a real provider; only the owner's real-key checks (last section) can show that.

## 0. What changes, what does not

Claude stays the default and its code path is untouched. A provider run is a second, separate path that is chosen only when an agent's model value names a configured provider (`<providerId>:<model>`, for example `openrouter:anthropic/claude-sonnet-4.5` or `ollama:llama3.1`). Every agent that exists today keeps `model: "auto" | "sonnet" | ...` and runs exactly as before. All existing tests must pass unchanged; any edit to an existing test file is a defect in this work.

Files I will touch outside new files, and why (each a few lines; none in `src/core/bsv`, `src/core/blender`, `test/bsv-*`, `test/blender-*`, `test/hedge-*`, README, docs/BSV, docs/BLENDER, `test/bsv-scan.ts` rules):

| File | Change |
|---|---|
| `src/core/engine.ts` | optional `providers` dep; one early branch in `runOnce`; one method that builds the host object; the `canUseTool` closure moved into a private method so both paths call the same code (behaviour-neutral); a clamp after `routeModel` |
| `src/core/model-cap.ts` | `overrideAllowed` refuses a request whose provider differs from the agent's; provider-prefixed ids are ranked by exact match only |
| `src/shared/config.ts` | `providers` in `CoreConfig`, `normalizeProviders` called from `loadConfig`, `redactConfig` covers it |
| `src/shared/types.ts` | additive optional fields on `Task` (`provider`, `tokenUsage`) |
| `src/bin/legion-core.ts` | construct the runtime, pass it to the engine |
| `src/core/server.ts` | register the provider routes through the module route hook (a `CoreModule`, no server.ts edit if possible) |
| `src/core/mcp-tools.ts` | `legion_create_agent` / `legion_run` refuse provider models for token clients (C21) |
| `test/bsv-scan.ts` | ONE new `ALLOWLIST` entry (path, kinds, reason). No rule changes. In this tree the allowlist is by file path with a written reason; there is no content hash, so "pinned hash" means the exact path and kinds, and a test that nothing else under `src/core/providers/` is allowed |
| `src/electron/provider-ipc.ts` (new) + 3 lines in `main.ts`/`preload.cjs` | native-confirmed key/endpoint changes (section 5). The three-line hook is its own last commit so the orchestrator can re-apply it if the BSV UI branch conflicts |
| `ui/src/settings` area | one import and one panel entry in `Settings.tsx`; the rest is new files under `ui/src/providers/` |
| `CHANGELOG.md` | a new "Providers" heading under `[Unreleased]` |

## 1. The provider seam

New directory `src/core/providers/`:

- `types.ts`: `ProviderEntry` (config), `ProviderAdapter`, `ProviderHost` (what the engine hands an adapter), normalized stream events.
- `config.ts`: `normalizeProviders(raw)`. Shape: `providers: { version: 1, entries: Record<id, ProviderEntry>, maxTurns, maxToolCallsPerTurn }`. `ProviderEntry = { kind: 'openai-compat', label, baseUrl, enabled, models?: string[], keyless?: boolean, allowPrivateNetwork?: boolean, prices?: { [model]: { inputPerMTok, outputPerMTok } } }`. Ids are `[a-z][a-z0-9-]{1,31}`, never `claude`, never `legion`. `kind: 'cli'` is reserved and refused (section 3.3).
- `presets.ts`: data only (no network use): OpenAI, OpenRouter, Ollama, LM Studio, vLLM and a blank Custom, each with a base URL, a "needs key" flag and a few suggested model ids. Suggestions are labelled suggestions; the owner can type any id.
- `secrets.ts`: key store (section 5).
- `http.ts`: the ONLY file that uses `fetch` (section 6).
- `openai-compat.ts`: the adapter (section 3.1).
- `tool-loop.ts`: Legion's own tool loop (section 4).
- `runtime.ts`: `ProviderRuntime`: `resolve(model)`, `clamp`, `assertModelAllowed`, `run`, `status`, `listModels`.
- `routes.ts`: HTTP routes as a `CoreModule` (admin only).

Selection: `parseProviderModel(value)` returns `{ providerId, model }` when `value` matches `^([a-z][a-z0-9-]{1,31}):(.+)$` AND `providerId` is a registered entry; anything else (including a value with a colon that names no provider) is the Claude path exactly as today. The existing router already passes any non-`auto` choice through, so `agent.model = "openai:gpt-4.1"` reaches `runOnce` as the decided model with no router change.

The engine hook in `runOnce`:

```ts
const pr = this.providers?.resolve(model);
if (pr) return runProviderTurn(this.providerHost(job, agent, act, prompt), pr);
```

Provider runs skip the Claude-only parts of `execute` that cannot match: escalation only triggers for the alias `sonnet`, so a provider model never escalates. A provider failure ends the task as an error; Legion never retries it on Claude or on another provider (C2): that would send the owner's data to a service they did not choose for that agent.

Who may choose a provider (confused-deputy rule, C3, C21):
- The owner in the app (admin) may set any agent's model to a provider model, and may type `/model provider:model` in their own message.
- A model chosen by anyone else (a bot through `ask`/`tell`/`room_post`, a room wake, an MCP client) may never move a run to a different provider than the agent's own setting, in either direction. `overrideAllowed` returns false when the providers differ; for the same provider only the identical model id is allowed (no price ordering is known). After `routeModel`, a clamp resets any bot-picked or overridden decision whose provider differs from the agent's to the agent's own model, which also covers an override of `auto` on a provider agent.
- Token clients (Claude Code, Cowork, curl via `/mcp` or `POST /api/tasks`) cannot set a provider model on `legion_create_agent`, `legion_run` or `POST /api/tasks` (400 with a plain sentence). They can still run an agent the owner already configured for a provider, under the existing `ask` ceiling.

## 2. Adapters: what is built and what is not

| Adapter | Built in this session | How |
|---|---|---|
| OpenAI (API key) | yes, against a fake server | `openai-compat`, `https://api.openai.com/v1`, chat completions |
| OpenRouter | yes, against a fake server | same adapter, `https://openrouter.ai/api/v1`; model ids contain `/` |
| Custom endpoint | yes | same adapter, owner-typed base URL |
| Ollama, LM Studio, vLLM (local) | yes, against a fake server | same adapter on `http://127.0.0.1:<port>/v1` or `localhost`; keyless allowed |
| Codex | models only | The OpenAI API models that accept chat completions work through the OpenAI entry. Models that are Responses-only will fail with the provider's own error shown plainly. The `codex` CLI and a ChatGPT-subscription login are NOT supported (see 3.3) |
| OpenCode | not built | see 3.3. Anything the owner runs that speaks the OpenAI chat-completions dialect (for example a local gateway) works as a Custom endpoint |
| Responses API | built after the first pass (`wire: 'responses'`, per provider) | was reserved in the first pass. Reason: chat completions is the one dialect OpenAI, OpenRouter, Ollama, LM Studio and vLLM all serve; a second dialect doubles the parser and test surface for no new capability in v1 |

### 3.1 The OpenAI-compatible adapter

`POST {baseUrl}/chat/completions` with `stream: true` and `stream_options: { include_usage: true }`; if the endpoint answers 400 for `stream_options` the adapter retries ONCE without it (some local servers reject it). Request: `model`, `messages` (system, user, assistant with `tool_calls`, `tool`), `tools` (function schemas), `tool_choice: "auto"`. Parser: SSE `data:` lines, `[DONE]`, text deltas into the existing `message.delta` bus event, `tool_calls` deltas accumulated by index, `finish_reason`, `usage`. A server that ignores `stream` and returns one JSON body is handled (same caps). Non-2xx: the provider's `error.message` (clipped, key-redacted) is the task error; 401/403/429 are named plainly ("the provider refused the key", "rate limited") and never escalate or retry beyond one 429 with the `Retry-After` value capped at 20 seconds.

What Legion does NOT assume: that a model supports tool calls. If a first request with tools returns a 400 mentioning tools, the run continues without tools and the task shows "this model did not accept tools: it can answer but cannot use Legion's tools" (a visible system message, not silent). Parallel tool calls are executed sequentially in the order received.

### 3.2 Per-agent choice

`AgentProfile.model` already is a free string. The picker writes `provider:model`. No new agent field, so downgrade is clean (section 11). The Task records `provider` (id) and `model` for display.

### 3.3 Codex and OpenCode as CLI adapters: decision

Not built. The question was "only if their non-interactive modes make that safe". Reasons, stated as my judgement, not as a test result:
1. Both are agents with their own shell and file tools. Run non-interactively they would act outside Legion's `ApprovalBroker`, taint tracking and audit chain; Legion could only constrain them with the CLI's own sandbox flags, whose behaviour I cannot verify here (no CLI installed, no network downloads without the owner's go-ahead, no Windows).
2. Subscription login for either would mean Legion starting a process that reads the owner's CLI credential store. Legion's rule for Claude is that it never reads those credentials; the same rule would apply.
3. A child process may only be spawned in a file the tripwire lists; adding one is a deliberate review, not a side effect of a feature.
The seam leaves room: `kind: 'cli'` is reserved and refused by `normalizeProviders` with the sentence "CLI providers are not available in this version". Before one is built it must: be listed in the tripwire; use the existing spawn-port pattern (argument list, no shell, scrubbed env, PID-tree kill); run with the CLI's own tools disabled or read-only, proven by an owner-PC check; and treat everything it returns as tainted outside content. Owner-visible limit: no ChatGPT-subscription or Codex-CLI login in v1.

## 4. Legion's own tool loop for non-Claude providers

A provider model has none of Claude Code's built-in tools: no Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, Skill, no slash commands, no session resume, no context compaction, no claude.ai connectors. It gets only Legion's in-process tool servers for the run, built by the same `buildMcpServers` the Claude path uses, filtered to `type: 'sdk'` entries: `legion` (agents, ask, tell, and vm_* when the agent's VM is enabled), `legion_comms`, `legion_kg`, `legion_blender` and the BSV status tool for an agent that requires BSV, each exactly as registered today. User-configured external MCP servers (stdio/http/sse from Settings) are NOT offered: they need a spawn or a second egress path (section 6).

Mechanics: for each in-process server instance, an MCP `Client` connects over an in-memory linked transport pair (no socket, no process). `listTools` gives the JSON Schema; names are exposed to the model as `mcp__<server>__<tool>` mapped to OpenAI function names `<server>__<tool>` (the API restricts characters) and mapped back, so `isLegionTool`, `needsApproval`, `taintsRun` and every module's `onToolUse` see exactly the names they see for Claude.

Per tool call, in this order (the same order as Claude's PreToolUse then canUseTool):
1. The requested name must be in the offered set; otherwise the model gets an error result and nothing runs (C12). A hallucinated `Bash` is not a shell.
2. Arguments must be valid JSON within a size cap (C16); otherwise an error result.
3. `noteToolUse` (taint, workspace taint, module `onToolUse`) BEFORE execution (C14).
4. `authorize(toolName, input)` is the same function Claude's `canUseTool` uses: effective approval mode, ceiling, `needsApproval(mode, tool, { capped })`, `ApprovalBroker.request`, 10-minute timeout, the same denial messages (C13).
5. Call the tool on the in-process server. The tool's own gates (BSV native dialogs and policy, Blender approval card and guard, kg quotas, comms scrub and hub rules) are inside the handlers and are untouched. Admin-only HTTP routes are not reachable from the loop at all: it holds no token.
6. The result goes back to the model as a `tool` message only, text clipped to the existing tool-result limits, stored with `clipToolResult` like Claude's (C15). Tool text never enters the system prompt and is never given an instruction role.

Limits (config, with caps): `maxTurns` default 40 (cap 200), 16 tool calls per model turn, 64 KiB arguments, 12,000 chars per tool result handed back. A repeated identical failing call three times ends the run with an error ("the model kept repeating a failing tool call").

Session memory: no provider session id. A continued task rebuilds the conversation from the stored messages (user, assistant, tool call and clipped result pairs), newest 40 messages and at most 60,000 characters, dropping the oldest whole turns first. A continued task therefore remembers less than a resumed Claude session; the UI says so.

The system prompt is `LEGION_PREAMBLE` + module preambles + the agent's own system prompt + one provider line: "You are running on <model> through <provider>. You have only the tools listed in this request; you have no file, shell or web tools of your own."

### What each provider cannot do versus Claude (shown in the UI, in these words or shorter)

- no file editing, shell, web search or fetch of its own (it can use VM tools if the agent has a VM, and kg/comms/Blender/BSV status through Legion);
- no Claude Code skills, plugins, slash commands, sub-agents, plan mode or claude.ai connectors;
- no MCP servers you added in Settings (Legion's own tools only);
- shorter memory when a task is continued;
- tool use is only as reliable as the model: some models, especially small local ones, cannot call tools at all;
- cost is shown only when the provider returns token counts and you entered prices.

## 5. API keys

- Entry: Settings, Providers, a password field per provider. The renderer sends the key to the Electron main process over a new IPC channel (`legion:provider-key`, handled in `src/electron/provider-ipc.ts`). Main shows a native confirmation dialog worded from facts it reads itself from the core (provider label, host, "save key" / "remove key", never the key), then calls `PUT /api/providers/:id/key` with the admin secret AND the native secret. The window never has the native secret. A core that was not started by the app (no native secret) refuses key and endpoint changes (same rule as BSV policy).
- Endpoint binding (the exfiltration control): a key is stored with the origin (scheme, host, port) it was saved for. Changing `baseUrl` to a different origin deletes the stored key, and changing an endpoint is itself a native-confirmed change (C6). So a compromised window cannot point a key at its own server. Adding a custom non-loopback endpoint shows the host in the dialog.
- Storage: `<dataDir>/providers/keys.json`, written with the same atomic 0600 writer as config.json (`writeConfigFile`), a map `id -> { key, origin }`. Never in `config.json`, the repo, SSE, `GET /api/settings`, `GET /api/state`, `GET /api/providers` (which returns `keySet` and a 4-character hint like the existing secrets), logs, task messages, tool results, error text or the audit chain (C4). Honest limit: this is the same protection class as `config.json` today: other local users are kept out, a process running as the same user is not. No OS keychain in v1 (Electron `safeStorage` lives in the main process and would need the key to cross to the core; listed under Later).
- Process environment: provider keys are never put in any child process's env. `buildChildEnv` already drops the bearer token; a test asserts a provider key set in `process.env` of the core is not copied to Claude's env either (C4b).
- `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in the environment are NOT read (Claude's path reads `ANTHROPIC_API_KEY` only for `api-key` mode; for providers the owner types the key once, on purpose).
- Redaction: `scrubSecrets` already has the `sk-...` rule (it matches OpenAI and `sk-or-v1-...` shapes) and an `exact` list. Every string the provider layer stores or emits (errors, provider messages, tool text) goes through one `redact()` that applies `scrubSecrets` with the configured keys as `exact`, which also covers key formats without a prefix (C5).
- Keyless is allowed only for loopback endpoints (C7).

## 6. Network egress (the one new network file: `src/core/providers/http.ts`)

The tripwire is by file. The new file is added to `ALLOWLIST` with kind `fetch` and the reason "model provider client: only hosts of providers the owner configured and enabled; https required except loopback; no redirects". Because the tripwire checks files, not destinations, the destination rules are enforced in code and proven by the tests below. A `fetch`-allowed file may contain no non-loopback `http(s)://` literal, so the preset URLs live in `presets.ts`, which has no network use.

Rules, all in `guardedRequest` (the only place a request is made):
1. The URL must be `baseUrl + path` of an enabled entry; a model, a tool or a task can never supply a URL. Userinfo (`user:pass@`), a fragment, any scheme except `https:`, and `http:` for anything but `localhost`, `127.0.0.1` and `[::1]` are refused (C7).
2. A literal private, link-local or unique-local IP host (10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7) is refused unless the entry has `allowPrivateNetwork: true`, which only a native-confirmed change can set. Not covered: a hostname that resolves to a private address (no DNS check; DNS rebinding is out of scope and said so).
3. `redirect: 'manual'`: any 3xx is an error naming the status, and the `Location` is not followed or even fetched (C8). So the Authorization header can only ever reach the configured origin (C11).
4. Authorization is `Bearer <key>` only when the entry has a key; never sent on a request whose origin differs from the one the key is bound to (C11).
5. Timeouts: connect-to-headers 30 s, idle between stream chunks 60 s, whole request 10 min; cancel aborts the socket (C9, C17).
6. Size caps: request body 2 MiB; non-stream response 8 MiB; streamed text 4 MiB total; one SSE line 1 MiB; model list 1 MiB; a breach aborts the request with a plain error (C10).
7. Only `Content-Type: application/json` or `text/event-stream` responses are parsed.
8. Concurrency: at most 4 provider requests in flight in total (same as the engine's concurrency).
9. Owner-initiated model listing (`GET {base}/models`, button "Refresh models") uses the same function and caps. No call is made at startup, no background probes, no telemetry.

## 7. Taint and trust

- Everything a non-Claude model returns is model output: it is stored as an `assistant` message like Claude's, never executed except as a tool request that passes steps 1 to 5 of section 4, and never treated as instructions from a higher-trust source by any module.
- Tool results that bring outside content (`taintsRun` is unchanged: the VM tools taint, Legion's in-process tools do not) taint the run exactly as today, through the same `noteToolUse`, and the task keeps `tainted` after the run (C14). Origin taint, bridge taint and the approval ceiling are the engine's and apply the same way.
- The provider's own response is NOT counted as outside content by itself (owner decision: same treatment as Claude). Recorded as a point for the independent reviewer: a custom endpoint is a server Legion knows nothing about, so a stricter rule (start every non-Claude run tainted) is a one-line change if the reviewer wants it.
- Provider-run text that reaches other agents (ask/tell/rooms) goes through the same comms path, so the same scrub and taint wrapping apply.

## 8. Cost and tokens

- Where the API returns `usage` (`prompt_tokens`, `completion_tokens`), the Task records `tokenUsage: { inputTokens, outputTokens }`, summed over the run. If the API returns none, the Task records `tokenUsage: { unknown: true }`.
- `costUsd` is touched only when the owner entered prices for that model (`prices` in the provider entry: dollars per million input and output tokens, typed by the owner, empty by default). With no price the cost is "unknown" in the UI and `costUsd` is left as it is. Legion ships no price table and never infers one (C18). OpenRouter's returned cost is not used in v1 (it would be a provider-reported number; listed under Later).
- Room budgets (`budgetUsd`, default none) meter known costs only. A provider run with unknown cost adds nothing to a room's meter, so a budgeted room can exceed its budget through provider agents; the Providers panel and the room settings say so in one sentence. The default spend limit stays none.

## 9. UI

- Settings, Providers panel (new `ui/src/providers/`): a row per preset plus Custom; status text from facts only: "No key", "Key saved", "Not tested", "Last test: ok / failed: <reason>", "Local, no key needed". A "Test" button does one `GET /models` (owner-initiated). The panel never says a provider "works", "is supported" or "is verified"; it says what Legion did ("Legion's own test request was accepted at 14:02") and carries the list from section 4 ("What this provider cannot do").
- Per-agent model picker: the existing Claude choices first, then a group per enabled provider with its listed or suggested models and a free-text id. A provider agent shows a badge with the provider label; the agent card says "Runs outside Claude: Legion's own tools only".
- Chat header and task view show `provider:model`, token counts when known, and "cost unknown".
- Errors are the provider's own message, clipped and redacted. No mascot art is touched.

## 10. Failure modes (each handled and tested against fakes)

Provider unreachable, connection reset mid-stream, stalled stream, 401/403, 429 with and without `Retry-After`, 5xx, malformed JSON, malformed SSE, stream ends without `[DONE]`, tool call with broken JSON arguments, tool call naming an unknown tool, model that never stops calling tools (turn cap), oversized body, redirect, the model rejecting `tools` or `stream_options`, cancel while streaming, cancel while an approval is pending, agent pointing at a deleted or disabled provider (error before any request, naming the setting to fix), key removed mid-run (next request fails cleanly), model id empty.

## 11. Config migration and downgrade

- Upgrade: `config.json` without `providers` loads as `{ version: 1, entries: {} }`; nothing is written until the owner saves a provider. No agent, task or message needs migration. No one-time migration runs, so none can override a later manual choice.
- Normalization is the Blender/BSV pattern: whatever the file holds is reduced to the accepted shape on load (bad numbers clamped, unknown kinds dropped with a notice in the Providers panel, a `kind: 'cli'` entry refused).
- Downgrade to a version without providers: unknown config keys are preserved by the merge-and-save path (a test round-trips them); `keys.json` is ignored; an agent still set to `provider:model` makes the old Claude path fail loudly with the SDK's unknown-model error, so nothing is sent to a wrong service. The panel says this under "Going back to an older version".

## 12. Controls (each has a test and a mutation that must turn it red)

Mutation = a temporary edit of the production code, run, seen red, reverted. I record the exact edit and the failing test name in the final report.

| # | Control | Test (all new, `test/providers-*.test.ts`) | Mutation that must go red |
|---|---|---|---|
| C1 | A Claude agent never reaches the provider path or network, with providers configured | `providers-engine`: fake `queryFn` called, fake server sees 0 requests | `resolve` returns a provider for any model |
| C2 | A provider failure never falls back to Claude or another provider | `providers-engine`: server 500, `queryFn` 0 calls, task is `error` | add a fallback call in the hook |
| C3 | A bot, room or override cannot switch provider (either direction), including via `auto` | `providers-cap`, `providers-engine` | drop the provider check in `overrideAllowed` / the clamp |
| C4 | A saved key appears nowhere except `keys.json` (0600): not in config.json, settings view, state, providers view, SSE capture, task messages, error text, tool results, audit, store files | `providers-secrets` sets a marker-shaped fake key, greps every artefact | write the key into config; leave the key in a 401 error text |
| C4b | Legion never puts a stored provider key into a child process environment (weak test: it only shows `buildChildEnv` adds nothing; env vars the owner already has are passed through exactly as before, so an `OPENAI_API_KEY` in the owner's own environment still reaches Claude's tools) | `providers-secrets` | none meaningful: the property holds because no code path reads `keys.json` for an env |
| C5 | `redact()` removes configured keys (prefixed or not) and `sk-` shapes from every stored string | `providers-secrets` | skip the `exact` list |
| C6 | Key and endpoint changes need admin AND native; changing the origin deletes the key; no native secret = locked | `providers-routes` | drop the native check; keep the key on origin change |
| C7 | https required except loopback; userinfo, other schemes, private literals refused; keyless only on loopback | `providers-http` | allow `http:` for any host |
| C8 | A redirect is never followed, and a second server sees 0 requests | `providers-http` (two fake servers) | `redirect: 'follow'` |
| C9 | Header timeout, idle timeout, total timeout end the run in bounded time | `providers-http` with short test timeouts | remove the idle timer |
| C10 | Body, stream, line and list caps abort cleanly | `providers-http` | raise a cap to infinity |
| C11 | Authorization reaches only the bound origin; never on a mismatched origin | `providers-http`, `providers-routes` | send the header regardless of origin |
| C12 | Only the offered in-process tools can run; `Bash`, an unknown name and an external-MCP name are errors that execute nothing | `providers-tools` | accept any requested name |
| C13 | The tool path uses the same approvals: modes, ceiling, capped carded tools (`vm_exec`), deny and timeout results | `providers-tools` with a fake VM manager | skip `authorize` |
| C14 | `noteToolUse` runs before the tool: a tainting tool taints the run and the stored task | `providers-tools` | call `noteToolUse` after, or never |
| C15 | Tool results go back only as `tool` messages, never into the system prompt; clipped | `providers-tools` inspects the request the fake server received | move results into the system message |
| C16 | Turn cap, per-turn call cap, argument cap, broken-JSON handling, repeated-failure guard | `providers-tools` | remove the turn cap |
| C17 | Cancel aborts the HTTP request, cancels pending approvals, and no tool runs after cancel | `providers-engine` | ignore the abort signal |
| C18 | Tokens recorded when returned; cost only from owner-entered prices; no default price | `providers-usage` | add a default price |
| C19 | Config normalization: bad input clamped, `cli` refused, unknown provider id gives a clear error before any request, unknown keys round-trip | `providers-config` | accept `kind: 'cli'` |
| C20 | All `/api/providers/*` routes are admin-only; the bearer token gets 403 | `providers-routes` (the existing gate test also runs) | add a route to the client list |
| C21 | A token client cannot set a provider model on create or run | `providers-routes`, `mcp` | remove the check in `mcp-tools` |
| C22 | UI and doc strings carry no verification claim and no banned phrase | `providers-wording` (reads `hedge-phrases.ts`, does not edit it) | add "verified" to a status string |
| C23 | Tripwire: only `http.ts` may use the network; nothing under `providers/` spawns a process; the new allowlist entry is exactly one file; no non-loopback URL literal in `http.ts` | `providers-tripwire` + the existing `bsv-tripwire*` and `bsv-hedge` tests unchanged and green | add `fetch` to `openai-compat.ts` |
| C24 | Provider runs keep the audit and mascot behaviour of Claude runs (messages, `tool` rows with `resultFor`, mascot moods, task status) | `providers-engine` | skip `addMessage` for tool results |

## 13. Test method

Tests first, per area. Fake servers are `node:http` on `127.0.0.1` with port 0, written in `test/providers-fakes.ts` (a scripted chat-completions server: SSE, JSON, tool-call scripts, stall, redirect, oversize, 401, 429, usage on/off, captures every request body and header). No real provider, no real key (test keys are made from two pieces so the existing secret scanners match nothing), no contact with the owner's wallet port. The test runner is the existing `node --test "dist/test/*.test.js"`. Windows lessons applied: `fileURLToPath`, no file symlinks, `Path`/`PATH` case, no kill-by-name.

## 14. Order of work (small commits, pushed as I go)

1. This plan (pushed first).
2. `config.ts`, `presets.ts`, `secrets.ts` + tests (C4, C5, C19).
3. `http.ts` + allowlist entry + tests (C7 to C11, C23).
4. `openai-compat.ts` + usage + tests (C9, C10, C18).
5. `tool-loop.ts` + engine hook + `model-cap` + tests (C1 to C3, C12 to C17, C24).
6. Routes, native key IPC, `mcp-tools` check + tests (C6, C20, C21).
7. UI panel and picker; wording test (C22).
8. CHANGELOG "Providers", `claude/tracker-pc-checks-providers.md`, gates, mutation pass, final report.

## 15. Not in this plan (Later)

CLI adapters (Codex, OpenCode) (built in section 19); the Responses API; OS keychain storage; provider-reported cost (OpenRouter); external MCP servers for provider runs; streaming tool-argument display; per-provider rate limiting beyond the global 4 in flight; vision and image inputs; start-tainted option for custom endpoints.

## 16. Wording changes for the orchestrator (README and docs are NOT edited by this session)

Legion currently says Claude-only in public text. Replace after the owner's real-key checks pass; until then use the "built, not yet tried with a real key" form.

- `README.md:7` tagline: **"A local multi-agent bot for your desktop, built around Claude, with a VM for every agent when it needs one."**
- `README.md:19`: **"Legion is built around Claude. Every agent runs on a Claude model through the Claude Agent SDK unless you choose otherwise: an agent can instead use an OpenAI-compatible endpoint (OpenAI, OpenRouter, a local server such as Ollama or LM Studio, or one you type in). Those agents get Legion's own tools and the MCP servers you enable, not Claude Code's built-in file, shell or web tools. Provider support has been tested against Legion's own fake servers; it has not been tried against the real services yet."** After the owner's checks pass, replace the last sentence with the check ids that passed.
- `README.md:71`: add after the first sentence: **"Provider API keys are typed once in Settings, confirmed in a native dialog, and stored in a separate file in your Legion data folder; Legion never reads keys from your environment or from other tools' credential files."**
- `README.md:223` (Later): **"CLI agents such as Codex and OpenCode, and signing in with a ChatGPT subscription. Legion reaches other models through OpenAI-compatible HTTP endpoints only (chat completions or the Responses API)."**
- `docs/ARCHITECTURE.md:5`: **"Legion is a local, personal multi-agent bot built around Claude. It runs on one machine for one user. Agents run on Claude through the Claude Agent SDK by default; an agent may instead run on an OpenAI-compatible endpoint through Legion's own tool loop (see docs/PROVIDERS.md, to be written from this plan)."** It targets Windows first and also runs on macOS and Linux.
- `CLAUDE.md` line 3 and the "Decisions already made" sentence "Claude-only in v1 (Codex/ChatGPT listed under "Later")": **"Claude is the default and the full-featured path. Other providers are OpenAI-compatible HTTP endpoints only (v0.2.0, plan in claude/plan-providers.md); Codex and OpenCode as CLI agents are Later."**
- `SECURITY.md`: add a short section: **"Provider keys and egress. Legion's own code sends a provider key only to the https (or loopback) origin the key was saved for, follows no redirects, and stores keys in a separate owner-only file. This is Legion's own network client; it does not stop a provider from logging what you send it. An agent on a provider has Legion's tools only and the same approval cards."**
- Website brief (`legion-site`): replace any "Claude-only" with the README:19 sentence; keep "tested against fakes" until a check passes.
- New `docs/PROVIDERS.md` (docs session): derive from sections 3 to 9 of this plan.

## 17. Owner-only real-PC checks

Written to `claude/tracker-pc-checks-providers.md` in the intake row format (class `spends-money` or `account` where a key is typed; none for local servers; downloads for installing Ollama or LM Studio). Short list: PV-01 OpenAI key, one short task and one tool call; PV-02 OpenRouter key, a model with `/` in its id; PV-03 a local Ollama (or LM Studio) with a tool-capable model, keyless; PV-04 a custom endpoint (https) and the refusal of an `http://` remote host; PV-05 the native key dialog on Windows (cancel keeps the old key; confirm saves; the window never shows the key again); PV-06 key removed, endpoint changed (key deleted); PV-07 a provider agent asked to use `vm_exec` as a token client (card appears, nothing runs on deny); PV-08 token counts and "cost unknown" against the real response; PV-09 a Responses-only model (expected: a plain provider error); PV-10 turn cap and cancel on a slow real stream; PV-11 downgrade check on the installed older build. No check may be marked passed in any doc until its result is recorded in the plan.

## 18. Build status and deviations from this plan (written after the build)

Built and green against fake servers on Linux: the seam, `openai-compat` chat completions (stream, JSON fallback, usage, retries for `stream_options`, tools and one 429), the guarded http client, key store, tool loop, routes, native key and address confirmation (`src/electron/provider-ipc.ts` plus a hook of about 10 lines in `main.ts` and 4 in `preload.cjs`), Settings, Providers, the two model pickers and the thread header. Tests: `test/providers-*.test.ts` (config, http, engine, tools, routes, secrets, native, ui, tripwire, wording) with `test/providers-fakes.ts` and `test/providers-harness.ts`.

Deviations (each is deliberate; the plan text above is the intent, this is what exists):
1. **Model values for a deleted provider.** `resolve` treats a prefix as a provider when it is configured OR is a preset id (`openai`, `openrouter`, `ollama`, `lmstudio`, `vllm`). A deleted custom provider's id is not remembered, so such an agent's model string goes down the Claude path and fails with the SDK's unknown-model error (nothing is sent anywhere). The caps (`model-cap.ts`, the engine clamp) treat any lowercase `word:` prefix other than `arn:` as provider-shaped, whether or not it is configured.
2. **Native confirmation covers keys and address changes only** (address, private-network allowance, "no key"). Turning a provider on or off, model lists, prices and run limits need only the admin key. The key is also deleted when the address moves to another origin.
3. **Model value length.** The HTTP validator (`MODEL_RE`) now allows `/` (OpenRouter ids); the 80-character limit is unchanged, so a longer id cannot be set. The `/model` prefix in a message still cannot carry `/`.
4. **Streamed deltas are shown as received.** Stored text, tool results and errors are redacted (exact keys, `sk-` shapes); the live `message.delta` stream is not, because a key could be split across deltas. A provider has no way to know the key, so this only matters if the provider echoes it.
5. **Allowlist is by path.** `test/bsv-scan.ts` has no content hash in this tree; one `ALLOWLIST` entry (`src/core/providers/http.ts`, kind `fetch`) was added and `providers-tripwire.test.ts` pins it to exactly that file. No scan rule changed.
6. **Not built:** CLI adapters, Responses API, an OS keychain, provider-reported cost, a badge on the agent rail (the agent editor and thread header say it), a one-shot "start tainted" option, room-meter accounting for unknown cost.
7. **The room budget is not enforced for provider agents** with unknown cost (stated in the panel).

### Mutation results (a temporary edit to the production code, run, seen red, reverted)

| Control | Mutation (file) | Red test(s) |
|---|---|---|
| C1 | engine resolves `'fake:' + model` | providers-engine C1, provider run |
| C2 | fall through to Claude after a provider error | providers-engine C2, C19 |
| C3 | drop the provider check in `overrideAllowed`; disable the clamp (both directions); drop the MCP guard | providers-engine C3 |
| C4 | a persist that adds the keys to config.json; `redact` returns its input | providers-routes C4; providers-secrets |
| C5 | `scrubSecrets` without the exact list | providers-secrets |
| C6 | no native check on address change / key save; key kept on origin change; dialog result ignored; key put in dialog text | providers-routes C6 x3; providers-native x2 |
| C7 | allow `http:` for any host; private literal without the flag; keyless anywhere | providers-config, providers-http |
| C8 | `redirect: 'follow'` | providers-http C8 |
| C9 | no idle timeout | providers-http (file times out) |
| C10 | stream cap off; body cap off | providers-http C10 |
| C11 | key sent for any origin (http and key store) | providers-http C11; providers-config |
| C12 | run the first offered tool for any unknown name | providers-tools C12 |
| C13 | authorize always allows | providers-tools C13 |
| C14 | no `noteToolUse` | providers-tools C13/C14 |
| C15 | tool output appended to the system prompt | providers-tools C15 |
| C16 | turn cap, per-turn cap, repeated-failure guard each removed | providers-tools C16 |
| C17 | abort listener removed | providers-engine C17; providers-http |
| C18 | default price | providers-engine usage test |
| C19 | `kind: 'cli'` accepted; keyless widened | providers-config |
| C20 | `GET /api/providers` on the client route list | providers-routes C20 |
| C21 | MCP create-agent guard removed | providers-routes C21 |
| C22 | an overclaim in a preset note | providers-wording |
| C23 | `fetch` in another providers file | providers-tripwire, bsv-tripwire |
| C24 | tool results not stored | providers-tools, providers-engine history |
| in flight | limit 400 instead of 4 | providers-http |

### Update after the first build (same session)

- **Responses API: built.** `wire: 'responses'` per provider: `/responses`, `instructions` and typed input items, flat function tools, `store: false`, streamed output-text, function-call-argument and completed/failed/error events, a one-body fallback. Tests: `providers-responses.test.ts` (fake server). Mutations R1, R2 red. Not tried against OpenAI.
- **Settings MCP servers for provider runs: built** (reverses limitation 4 and "not offered" in section 4). `src/core/providers/external-mcp.ts`, on the tripwire list as one more path. stdio: the MCP SDK's stdio transport starts the owner's configured command with the SDK's default environment plus only the owner's env entries (not the core's environment), stderr dropped; http/sse: https or this computer (private-network literals allowed, they are the owner's own config), no redirect followed. Tools are named `mcp__<server>__<tool>`, are not Legion tools, so they need a card outside full mode and taint the run (same functions as Claude). Stricter than Claude on purpose: Claude's path lets a remote `http://` server through. Windows: the stdio transport handles `.cmd` launchers, but this was not run on Windows. Tests `providers-external.test.ts`; mutations E1-E5 red (E2b is a redundant second layer).
- **CLI adapters (Codex, OpenCode): still not built, and this is the one place I disagree with "run the same as Claude".** A Claude tool call passes through Legion's hooks (`PreToolUse`, `canUseTool`) before it runs, so Legion can taint, ask and refuse. A CLI agent runs its own shell and file tools inside its own process; Legion has no hook there, only a start and an end. Its read-only or sandbox flags are the CLI's promise, not Legion's control, and a read-only sandbox can still read the owner's files. A bot-woken run (rooms, ask/tell, MCP) would make that a confused-deputy path. The equivalent of today's `vm_claude` is the safe shape: run the CLI inside the boat.dev VM, where the VM is the boundary, as a `vm_*` tool with a card. That needs the owner's accounts and a real VM to check, so it is a decision for the owner, not something to build blind.

## 19. Second pass (branch `claude/providers-2`, from `integration/v1`)

Written after the build. Owner decisions for this pass: the independent review's findings are fixed; Codex and OpenCode adapters **are** built (this reverses the CLI paragraph at the end of section 18 and the CLI line in section 15; the disagreement noted there stands as a risk, see "What is not protected"); a lead agent may change a sub-agent's model or provider, but only from a list the owner grants. Nothing here was run against a real provider, a real Codex or a real OpenCode. Every CLI flag is **assumed** from the programs' public documentation, marked `TODO OWNER PC`, and listed in `claude/tracker-pc-checks-providers.md` (PV-13 to PV-26).

### 19.1 Part A: review findings

| # | Finding | What was built | Where |
|---|---|---|---|
| A1 | The MCP SDK started the owner's stdio servers inside the core, for every provider run, and killed only one process | A per-server opt-in **default off**. The approval is stored in `providers.stdioMcpAllow` as a hash of the server's exact command line (command, arguments, env names and values), so a later edit in Settings switches it off again. Allowing needs admin **and** the native secret (`PUT /api/provider-mcp/:name`, the app's dialog shows the command line read from the core; env values are never shown). The SDK's stdio client is no longer used: `stdio-transport.ts` runs the server through `proc.ts` with an allowlisted environment (case-insensitive on Windows, `PATHEXT`/`COMSPEC` added there), stderr dropped, and the whole PID tree is stopped on run end, on cancel and on a cancel during connect (`taskkill /PID /T /F` on Windows, a process-group kill on POSIX; never by name). Windows `.cmd`/`.bat` launchers run as `cmd.exe /d /s /c "<line>"` built by `resolveLaunch`: a piece holding `& \| < > ^ " % ! ( )`, a backtick or a line break is **refused, not escaped**; `.ps1` and other scripts are refused. | `providers/proc.ts`, `stdio-transport.ts`, `stdio-allow.ts`, `external-mcp.ts`, `routes.ts`, `engine.ts` (filter), `provider-ipc.ts` |
| A1 tripwire | | `proc.ts` is the **only** file under `src/core/providers` that may start a process (allowlist entry, kind `child-process`, with reasons). `providers-tripwire.test.ts` fails if any other providers file imports `child_process`, `cross-spawn`, `execa`, the SDK's stdio client or server transport, or if a file other than `external-mcp.ts` imports the http/sse clients; it also proves the scan is not a no-op by removing the `proc.ts` entry. | `test/bsv-scan.ts` (entry added, no rule loosened), `test/providers-tripwire.test.ts` |
| A2 | Streamed `message.delta` text was not redacted | `stream-redact.ts` holds back a tail of at least the longest saved key plus 48 characters, finds exact keys and `sk-` shapes in the whole held text (an `sk-` token still growing is held whole, however long), never cuts inside one, and flushes at the end of each turn. A key split into 1-character chunks does not appear in the live events or the stored message. Cost: text shows with a short delay (about the hold-back length), and a very short reply appears at the end of the turn. Not covered: a secret that is not a saved key and not `sk-` shaped (the same limit as stored text). | `providers/stream-redact.ts`, `tool-loop.ts` |
| A3 | A custom remote endpoint was trusted like a preset | `ProviderRuntime.startsTainted`: a CLI always; a custom endpoint (not a preset **at its own origin**, not loopback) unless the owner set `trusted` (admin **and** native). Presets and loopback stay untainted; a preset repointed at another host counts as custom. The engine sets the run tainted before the prompt and any tool, and patches the stored task, so bridged replies (`isTainted(fromTaskId)`) and the preamble see it. The Providers panel states the state per provider and has the trust box. | `runtime.ts`, `engine.ts`, `routes.ts`, UI |
| A4 | No spend limit on provider tokens; room budget gap invisible | Optional `tokenCapPerTask` and `tokenCapPerDay` per provider (default none, admin only, `null` clears). Enforced in the tool loop before every model turn (counting earlier runs of the task and a persisted per-day ledger, `providers/usage.json`: date and numbers only), and in the http layer as the request's output limit (`max_tokens` or `max_output_tokens` = the room left) plus a stream abort far past it. When the provider returns no counts the cap uses an estimate (characters / 4) and says so. The message is a visible system line and the task error. A turn already running can pass the limit by its input; the next turn is not started. The room header shows one sentence under any room budget: the meter counts only costs Legion knows. | `tool-loop.ts`, `openai-compat.ts`, `usage.ts`, `runtime.ts`, `ui/src/rooms/RoomHeader.tsx` |
| A5 | Windows semantics | What can be proved on Linux is in tests (pure functions with a `platform` argument): `.cmd` line building and refusals, `Path`/`PATH` and env-name case, one variable per name, owner env entries replace allowed ones whatever their case, `.ps1` refusal, POSIX leaves a file named `x.cmd` alone. Paths use `node:path`/`realpathSync`; no file symlinks in tests. Only a real Windows PC can show: `cmd.exe` quoting in practice, `taskkill /T`, `COMSPEC` fallback, which of `HOME`/`USERPROFILE` a CLI uses for its login, drive-letter and UNC checks (PV-13, PV-14, PV-20, PV-21, PV-26). | `proc.ts`, `cli.ts`, tests |
| A6 | This plan and the wording tables | This section and 19.5. | |

### 19.2 Part B: Codex and OpenCode

Flags known from public docs, quoted from the sources that could be read: OpenCode `run`: `--model/-m`, `--agent`, `--format default|json`, `--dir`, `--continue`, `--session`, `--file`, `--attach`, `--share`, `--auto` ("auto-approve permissions that are not explicitly denied"), env `OPENCODE_PERMISSION` ("inlined json permissions config"), `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`. Codex `exec` (from the public source of its CLI): `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--color always|never|auto`, `--json`, `--output-last-message/-o`, `--model`, `--dangerously_bypass_approvals_and_sandbox`, prompt `-` reads stdin. **Assumed, not read from a source here:** Codex `--sandbox read-only|workspace-write|danger-full-access` and its login location (`CODEX_HOME`, default under the user folder); the keys of the OpenCode permission object (`edit`, `bash`, `webfetch`, `external_directory`) and whether OpenCode honours it in `run`; that `opencode run` takes the prompt as its message argument; that Codex's own sandbox works inside the VM. All `TODO OWNER PC`.

**B1, inside the VM (recommended).** Tool `vm_cli` (`cli: codex|opencode`, `prompt`, optional `model`, `mode: read-only|workspace-write`, `timeoutSeconds`) next to `vm_claude`. The prompt is written to a file in the VM and read from it, so it can never change the command (tested with quotes, `$(...)`, backticks, newlines). The command checks `command -v <cli>`; if missing, the result says Legion does not install it and does not sign in (the login is the program's, made by the owner in the VM). Never installs, never logs in. Approval card in every mode except full access, and in any capped run (a bot or MCP-woken run needs the card even on full); the result is tainted outside content (`vm_cli` is in the tainting list, so the run is tainted before the tool runs); output has terminal escapes removed and is tail-truncated. Codex runs `--sandbox <mode>`, OpenCode `OPENCODE_PERMISSION` (VM default: edit and shell allowed, web fetch denied; read-only: all three denied). Tests use a fake VM manager (`providers-vmcli.test.ts`).

**B2, on this PC (opt-in, off by default).** Provider `kind: 'cli'` (`cli`, `executable` as a **full path** never looked up on PATH, `sandbox`, `allowedAgents`, `timeoutSeconds`). Everything below is enforced in code and tested with a fake CLI (`test/fixtures/fake-cli.mjs`, a node script run through the process port's test prefix; no real CLI exists in the tests):

- created disabled; every change to a CLI entry (program, sandbox, agents, on) needs admin **and** native, with a dialog that carries the plain warning; turning it off needs admin only; never lead-selectable, takes no key, has no model list;
- the child is started only in `proc.ts` (`spawnManaged`, argument list, `shell:false`, complete scrubbed environment, `windowsHide`, detached group on POSIX, PID-tree kill on cancel, time limit and a 1 MiB output cap);
- environment: `PATH`, home and temp variables, locale, `XDG_*`, and the program's own config home (`CODEX_HOME` for Codex); names that look like keys, tokens, secrets, passwords or auth are never passed; Legion never reads, copies, logs or names the program's credential store (a test scans the sources for the usual file names);
- working folder: the agent's own folder, created if missing, checked on its real path: not the home folder or any folder that contains it, not a drive root, not Legion's data folder (except inside an agent's workspace), not the Legion program or source folder;
- strictest flag: Codex `--sandbox read-only` (or `workspace-write` if the owner chose it), `--skip-git-repo-check --ephemeral --ignore-user-config --color never`, prompt on stdin; OpenCode `OPENCODE_PERMISSION` with edit, shell, web fetch and external directory denied (edit allowed only for `workspace-write`), `--dir <folder>`, `--format default`. A second layer refuses any command containing a bypass, auto-approve, search, config-override, extra-directory or approval flag; no network flag is ever built;
- the whole run is tainted (before it starts) and its text is stored as the assistant message with terminal escapes and control characters removed; usage is recorded as unknown;
- **only the owner in the app may start it**: the engine passes `ownerStarted` only when the task's source is the app and it has no bot origin and no bridge caller; a token client, a room wake, ask/tell and a bridge reply are refused before any card or process;
- a start card, every run and in every approval mode, shows the command (prompt replaced by its length), the folder, the sandbox flag and the warning; no answer in 10 minutes is a denial;
- limits: the program's time limit (default 15 minutes), the output cap, cancel and time-out kill the tree.

### 19.3 Part C: a lead may choose a sub-agent's model or provider

Control C3 stays (a bot can never move an agent to Claude or to another provider on its own) and gains one owner-granted exception. The owner keeps, in Settings, Providers, Lead choices, a list of `provider:model` values **per sub-agent**, and may mark a whole provider "lead-selectable" (default none; both need admin **and** native to add, admin to remove). `ask`, `tell`, `bot_send` and `room_post` accept `model` as `sonnet|opus|haiku|auto` (the cap rule as before) **or** a `provider:model` value. `ProviderRuntime.leadDecision` allows it only if: the provider exists and is on; it is not a CLI; the value is on that agent's list or the provider is lead-selectable; and, if the lead's task is tainted, the provider is not one whose runs start tainted (an untrusted custom endpoint). Anything else is refused with a sentence that names the setting ("Allow it in Settings, Providers, Lead choices"). The check runs in the bridge and hub (so the lead gets the sentence), again in `engine.startTask` (authoritative), and again when the run starts (a choice withdrawn meanwhile falls back to the agent's own setting). The sub-run keeps the lead's approval ceiling, origin and taint; the task records `modelOverride.allowedInSettings`, and the thread gets the line "This task runs on <value>, chosen by <lead>. You allowed that choice in Settings, Providers, Lead choices." (the task chip already says who chose). A token client (MCP/curl) is refused first and cannot name `modelOverrideBy`; "legion_run from a lead" is read as ask/tell and the room tools, because the MCP tools are the token client's and stay refused. No tool, route or message a bot or token client can reach edits the list (admin-only default-deny plus the native secret; tested).

**Delegate-only (optional, off by default, built because it stayed small).** Per-agent `delegateOnly`: a Claude agent loses its own `Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit` (SDK `disallowedTools`) so work really goes to the agents it asks. Read tools stay. A provider agent has no such tools anyway. Admin-level setting (it only removes power). Limit: the lead can still use MCP servers you gave it and, with a VM, `vm_exec`; delegate-only does not remove those.

### 19.4 Deviations, decisions, and what is not protected

1. **A bug in pass 1 was found and fixed**: the native dialog refused a provider that did not exist yet ("Unknown provider"), so "Add a custom endpoint" could not complete from the app. The dialog is now worded from the request for a new provider and the core still validates it (`providers-native2`).
2. **Settings stdio servers are off for provider runs** until allowed. This changes pass 1 behaviour (it started them); the two existing external tests were updated to set the opt-in.
3. **The SDK's stdio client is gone from the provider path.** Claude runs still start MCP servers through the Claude Code process as before; this pass does not touch them.
4. **Lead choices are per task**; the agent's own model setting is never changed by a lead.
5. **Stored taint on the lead's side** for a custom endpoint is unchanged: the provider's reply is not outside content by itself, except for an untrusted custom endpoint (A3).
6. Routes added (all admin-only, default deny, none on the token client list): `PUT /api/provider-mcp/:name`, `PUT /api/provider-lead/:agentId`; `PUT /api/providers/:id` accepts more fields.
7. Windows `.cmd` launchers: arguments with cmd metacharacters are refused, so a CLI prompt with a quote or `%` cannot be passed to a `.cmd` launcher; use the `.exe`, or the VM route.

**What is not protected (said plainly).**
- A CLI run on this PC: Legion cannot see or stop what Codex or OpenCode does with its own shell and file tools. The sandbox or permission flag is the program's promise. The core being killed leaves a detached stdio server or CLI process running (no parent-death signal on POSIX); a restart does not clean it up. Even `read-only` can read files outside the agent's folder that your user can read, including your home folder; Legion cannot show that it does not. The folder check stops Legion from *choosing* such a folder; it does not stop the program from leaving it. Taint and "only the owner can start it" limit what a prompt can reach, they do not limit the program. The VM route is the safer shape.
- The program's own login and any key it holds are outside Legion; a program that prints a secret it can read is not caught except by the `sk-` and saved-key redaction.
- A local MCP server you allowed has your user's rights while it runs. Legion limits its environment and stops its tree; it does not sandbox it.
- Token caps use the provider's counts or an estimate, can be passed by one turn's input, and say nothing about money unless you entered prices.
- A lead you allowed to choose a provider sends that agent's data there for that task; the dialog says so.
- Redaction covers saved keys and `sk-` shapes, not other secret formats.

### 19.5 Wording changes for the orchestrator (README and docs are NOT edited by this session)

- `README.md:223` (Later): replace with **"Signing in to Legion with a ChatGPT subscription. Codex and OpenCode can run inside an agent's VM, or, if you turn it on per agent, on your own computer, where Legion cannot see or stop their individual actions; their login stays with them."**
- `README.md:19`: append **"A lead agent can run another agent on a different provider or model only from a list you set in Settings."**
- `CLAUDE.md` "Decisions already made": replace the sentence about Codex and OpenCode with **"Codex and OpenCode run inside an agent's VM (vm_cli) or, opt-in per agent and native-confirmed, on this PC (CLI provider); Legion cannot see or stop a CLI agent's own actions."** Add a hard rule: **"The provider process file (`src/core/providers/proc.ts`) is the only providers file that starts a process; a CLI run can only be started by the owner in the app."**
- `SECURITY.md` provider section, add: **"Local MCP servers start in a provider run only after you allow the exact command line. A CLI agent on this computer runs outside Legion's per-tool approvals and taint tracking; Legion limits where and by whom it is started, not what it does."**
- `docs/PROVIDERS.md` (docs session): add sections from 19.1 to 19.3.
- Settings strings added (all scanned by `providers-wording`): the CLI warning (`CLI_WARNING`), the room budget note (`ROOM_BUDGET_NOTE`), the taint line, the token limit note, the Local MCP servers and Lead choices notes.

### 19.6 Mutation results (a temporary edit of the production code, run, seen red, reverted)

Every control below was broken by a one-line edit, the named test file was run, and the edit was reverted (the tree was clean afterwards). "timeout" means the broken code made the run hang on an unanswered card, which the harness counts as red. Two mutations first stayed green and led to new tests: the start-card fallback (a run with no way to ask for the card) and the drive-root rule.

| Control | Mutation (file) | Red test file |
|---|---|---|
| A2 stream | live deltas passed through unfiltered (`tool-loop.ts`); hold-back window cut to 1 (`stream-redact.ts`) | providers-stream (1 and 4) |
| A3 taint | start-tainted check disabled (`engine.ts`); `startsTainted` returns false (`runtime.ts`); relax without native (`routes.ts`) | providers-taint, providers-routes2 |
| A4 caps | cap check disabled; earlier runs of the task ignored; output limit not sent (`tool-loop.ts`, `openai-compat.ts`) | providers-caps |
| A1 opt-in | engine starts stdio servers without the opt-in; `stdioAllowed` always true; fingerprint ignores arguments; allow route without native | providers-stdio, providers-routes2 |
| A1 process | transport environment not scrubbed; tree kill a no-op; `.cmd` metacharacters not refused; Windows env names case-sensitive | providers-external, providers-stdio |
| A1 tripwire | a planted import of the SDK stdio client in `tool-loop.ts` | providers-tripwire |
| B2 who starts | owner-only check removed in `runCli`; engine `ownerStarted` always true | providers-cli |
| B2 card | start card skipped when no way to ask (new test); card answer ignored | providers-cli |
| B2 command | widening flag added (`--full-auto`) | providers-cli |
| B2 environment | environment not scrubbed | providers-cli |
| B2 folder | home-folder check removed; drive-root check removed (assertion on the rule's own reason) | providers-cli |
| B2 agents | allowed-agents check removed | providers-cli |
| B2 limits | output cap removed; time-out does not kill; cancel does not kill (tree checked by PID) | providers-cli (timeout) |
| B2 output | terminal escapes not stripped; stderr not redacted | providers-cli |
| B2 config | native not needed for a CLI change; CLI created already enabled; bare program name accepted | providers-routes2 |
| B1 | `vm_cli` needs no card; does not taint; prompt put into the command; widening flag in the VM command | providers-vmcli |
| C | list check removed; tainted-lead rule removed; CLI selectable by a lead; engine check removed; exec-time re-check removed; list route without native | providers-lead, providers-routes2 |
| C delegate | delegate-only not applied | providers-delegate |
| C22 | an overclaim in a dialog button | providers-wording |

Not covered by a test and said so: the hub path (`room_post`/`bot_send` carrying a provider choice) shares the engine's authoritative check, which is tested; the hub's early check itself is not separately tested. A real Windows PC is needed for everything in the PV-13 to PV-26 rows.

### 19.8 Experimental switch and shared-file hooks (owner decision: providers move to v0.2.1)

Everything the second pass **adds** works only when `config.json` holds `"experimental": { "providers": true }` (the boolean `true`; a string, a number or a missing key means off; there is no setting for it in the app; it is read live from the config object, `src/core/providers/flag.ts`). With it off: the routes `PUT /api/provider-mcp/:name` and `PUT /api/provider-lead/:agentId` answer 404 (also with admin and the native secret); `PUT /api/providers/:id` refuses the new fields (`kind`, `cli`, `executable`, `sandbox`, `allowedAgents`, `timeoutSeconds`, `trusted`, `tokenCapPer*`, `leadSelectable`) and any CLI entry with 404; `GET /api/providers` returns `experimental: false`, no CLI rows, no local-MCP list, no lead list, no CLI warning or room-budget sentence and none of the taint or cap fields; a CLI entry written into config.json by hand does not run; `vm_cli` is not offered and the per-task `model` parameter keeps the plain four-value list; a lead naming a provider is refused ("not available in this version"); delegate-only is ignored; the app's native dialogs refuse the new kinds before showing anything; and the Settings panels, the taint and token-limit lines, the CLI cards, the Local MCP and Lead choices panels, the delegate-only checkbox and the room budget sentence are not drawn. Tests: `test/providers-experimental.test.ts` (7 tests; the flag-on side of every check is covered by the other new test files, whose harness turns the flag on).

Kept unconditional on purpose, because they repair the pass-1 surface and only make it stricter: a Settings stdio MCP server is not started for a provider run unless allowed (with the flag off nothing can allow it, so it never starts), a custom remote endpoint starts tainted, streamed text is redacted, token counting. Pass-1 provider UI is hidden by the orchestrator's own switch, not by this one.

Shared files touched, each a small additive hook: `src/core/engine.ts` (the provider branch, `leadMayChoose`, the lead clamp, `delegateOnly` in `disallowedTools`, `vmCli`/`setProviderChoices` when building the tool servers, the `vm_cli` taint entry, one preamble line, a `cliCwd` helper), `src/core/agent-tools.ts` (`vm_cli`, `modelParamFor`, `setProviderChoices`), `src/core/comms/tools.ts` (uses `modelParamFor`), `src/core/comms/hub.ts` and `src/core/bridge.ts` (provider-shaped `model` values and the lead check), `src/core/model-cap.ts` (`isProviderValue`, `PROVIDER_VALUE_RE`, the lead query types), `src/core/approvals.ts` (the `vm_cli` card rule, two card summaries), `src/core/server.ts` (`delegateOnly` field, gated), `src/shared/types.ts` (`Task.modelOverride.allowedInSettings`, `AgentProfile.delegateOnly`), `src/shared/providers-view.ts` (view fields, two sentences), `src/bin/legion-core.ts` (`dataDir`, `usageFile`), `test/bsv-scan.ts` (one allowlist entry for `proc.ts`, one reason text narrowed for `external-mcp.ts`), `ui/src/components/AgentEditor.tsx` and `ui/src/rooms/RoomHeader.tsx` (a guarded checkbox and a guarded sentence), and four existing test files (`providers-config`, `providers-engine`, `providers-external`, `providers-routes`, plus `providers-fakes`/`providers-harness` helpers) updated for the intended behaviour changes listed in 19.4. No change to `src/core/bsv`, `src/core/blender`, the updater, README or docs.

### 19.9 Adversarial pass with the owner's skills (kodawari, security-and-hardening, error-handling-patterns, api-and-interface-design, mcp-builder, verification-before-completion)

Skipped for lack of tools: roast-and-council (its marketing agents and `SendUserMessage` do not fit a code change; I did the refuting pass myself, below), the dependency audit step of security-and-hardening (no network audit service was reachable), and a packaged-Electron or Windows render (Linux headless Chromium only).

**Trust boundaries walked** (who wrote the value, not which channel carried it): model output (tool names and arguments are checked against the offered list; `vm_cli` `cli`/`model`/`mode`/`timeoutSeconds` are enum or regex bound; the prompt travels in a file); a lead agent's `model` value (owner list, flag, taint, re-checked at run start); the CLI's own output and stderr (escapes stripped, redacted, tainted); the agent's folder (real path resolved before use); config.json values (`executable` must be an absolute path without shell metacharacters; entries are normalised on load); another process's view of Legion's child processes (see below).

**Found and fixed, red then green:** (1) a throwing process port or start-card request in `runCli` escaped as a raw exception and could carry a path or message from the OS; it is now a plain task error (`providers-cli`, "error handling"); (2) a failed save of the token ledger was swallowed, so a daily cap would silently restart from zero after a restart; the thread now says so (`providers-caps`).

**Found by looking at the rendered panel (headless Chromium, flag on at 1440 px and flag off) and fixed:** a doubled label on the CLI card ("Codex CLI codexcli Codex CLI on this computer"); doubled backslashes in the program-path placeholder; a room-budget sentence that began "This budget" and read wrongly inside Settings (reworded to "A room budget counts only..."); an "Allowed: stop allowing" button that read as a state and an action at once; token-limit fields that sent a request on every blur even when nothing changed. With the flag off the panel shows none of the new elements (screenshot compared by eye). The app is a three-column desktop app, so a 390 px render was not meaningful and is not claimed.

**Still imperfect, said plainly:**
- OpenCode takes the prompt as a command-line argument, so another local user can read it with a process listing while it runs (Codex reads it from stdin). Unchanged because the alternative flags could not be checked here (PV-19).
- The approvals for stdio servers, the allowed-agents list and the lead lists live in config.json: a process running as you that edits that file (and the flag) bypasses the native confirmations, the same class as for provider keys.
- Taint and ledger state are in-process or in the data folder; none of it survives a deliberate wipe.
- The panel is long with several providers; it was not redesigned.
- The hub's early lead check has no test of its own (the engine check behind it does).
- No real Windows, Codex, OpenCode or provider run was made; every flag is assumed (PV-13 to PV-26).

### 19.7 Gate (second pass)

`npm ci && npm run build:ts && node --test "dist/test/*.test.js"`: **1807 tests, 1805 pass, 0 fail, 2 skipped** (the skips are the suite's own). `npm run typecheck`: exit 0. `npm run build:ui`: exit 0. Provider tests alone: 133 tests in 23 files, all pass (up from 66 in 12 files before this pass). The first full run had two failures caused by this pass (the tool-name list and the comms `model` schema), fixed by putting the new surface behind the flag (19.8), and one pass-1 route test updated for the flag. The `server.test` "task archive / rename / delete" flake did not appear in the final run. Linux only: nothing was run on Windows or against a real CLI or provider.
