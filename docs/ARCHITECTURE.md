# Architecture

This document describes how Legion is put together and the contracts between its parts. Read it before changing the core, the HTTP API or the MCP tools. For setup and workflow, see [CONTRIBUTING.md](../CONTRIBUTING.md).

Legion is a local, personal, Claude-only multi-agent bot. It runs on one machine for one user. It targets Windows first and also runs on macOS and Linux.

## Design principles

1. **Credentials stay with Claude Code.** Legion never reads, copies, stores or proxies Claude OAuth tokens or credential files. In `claude-login` mode it lets the Claude Agent SDK use whichever account Claude Code is signed in to, and removes `ANTHROPIC_API_KEY` (and `ANTHROPIC_AUTH_TOKEN`) from the child environment so the login is used. In `api-key` mode it passes `ANTHROPIC_API_KEY` from config, and nothing else.
2. **Models are aliases.** Legion passes Claude Code aliases (`sonnet`, `opus`) or values taken from the live model catalog. It never hard-codes dated model ids.
3. **Local only.** The HTTP server binds `127.0.0.1`. Every route except `GET /health` needs the MCP-class bearer token, and every route outside a short client list also needs the per-launch admin secret (see Security model).
4. **Small dependency surface.** Runtime dependencies are `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk` and `zod`, plus Node built-ins. Think twice before adding another.
5. **Windows-safe.** Use `path.join`, avoid shell-specific commands, and never hard-code `/tmp` on the host.
6. **ESM with NodeNext.** Relative imports end in `.js`. Node 22.12 or newer (the lockfile's build tools and Electron need it).

## Process layout

```
Electron app (src/electron) --spawns/attaches--> Legion Core (src/bin/legion-core.ts, system Node)
   renderer UI (ui/) --HTTP + SSE (bearer)-->      Store       JSON files in the data dir
Claude Code --MCP streamable HTTP /mcp-------->    Engine      Claude Agent SDK query()
Cowork / Desktop --stdio--> legion-mcp-stdio --->  Router      auto Sonnet/Opus + escalation
                                                   Approvals   inline Allow/Deny broker
                                                   Catalog     slash commands + models
                                                   VmManager --> BoatClient --> boat.dev REST
                                                   EventBus --> SSE /api/events
```

- **Legion Core** is a plain Node process (`src/bin/legion-core.ts` is the composition root). It owns all state and all side effects.
- **The Electron app** is a thin shell. On start it checks `GET /health`; if Core is down it spawns it with the system `node` (`LEGION_NODE` overrides the binary) and logs to `core.log`. Closing the window hides it to the tray. Quit stops Core only if the app started it.
- **The renderer** (`ui/`) is Vite, React 19 and TypeScript with hand-written CSS. It talks to Core over HTTP and SSE only.
- **`legion-mcp-stdio`** is a stdio bridge for hosts that only speak stdio (Cowork, Claude Desktop). It proxies to Core's `/mcp` endpoint and starts Core headless if it is not running.

## Data directory

`~/.legion` (Windows: `%USERPROFILE%\.legion`). Override with `LEGION_HOME`.

| Path | Contents |
|---|---|
| `config.json` | Configuration, including the generated MCP-class bearer token and, in plaintext, `boat.apiKey` (and `claude.apiKey` in `api-key` mode). Created on first run, mode 0600. The admin secret is never written here or anywhere else. |
| `state.json` | Agents, tasks and VM records. Written debounced and atomically (temp file plus rename). A corrupt file is moved aside as `state.json.corrupt-<time>`. |
| `messages/<taskId>.jsonl` | Append-only chat log per task. |
| `workspaces/<agentId>/` | Default working directory for an agent's local file tools. |
| `projects.json` | Projects (own file, so an older build's rewrite of `state.json` cannot drop them). |
| `board/<projectId>.jsonl` | The project board: one JSON line per change, compacted with a temporary file and a rename. |
| `context/` | The house context layer: a copy of the shipped rules, ADRs, facts and skills (`src/core/house/`). Agents see it only through the `legion_house` tools. `context/.shipped.json` holds the hashes of what Legion shipped. |
| `.adopted.json`, `.house-switches.json` | The owner's approvals and on/off switches for the house layer. They sit in the data directory, one level above `context/`, and are changed only by admin routes. |
| `core.log` | Core log. |

Environment overrides: `LEGION_HOME`, `LEGION_PORT`, `LEGION_NODE`, `BOAT_API_KEY`, and `ANTHROPIC_API_KEY` (used only when `claude.auth` is `api-key`).

## Default agents

`Store.seedDefaults` creates these on first run without overwriting edits.

| id | name | model | approval | VM | purpose |
|---|---|---|---|---|---|
| `zealot` | Zealot | auto | `auto-edits` | enabled, default size | General-purpose lead. Cannot be deleted. |
| `builder` | Builder | auto | `full` | enabled, default size | Coding and building; prefers its VM for risky work. Not seeded as `large`: a free boat.dev trial refuses it. |
| `scout` | Scout | sonnet | `ask` | disabled | Research, reading and summarising. |

VM idle stop defaults to 15 minutes. `mcpServers` defaults to `['*']` (all configured servers).

## HTTP API

JSON over `127.0.0.1:<port>` (default 4747). Implemented in `src/core/server.ts`. Two classes of caller (`src/core/admin.ts`). The **MCP token** (`Authorization: Bearer <authToken>`) opens only `/mcp`, `GET /api/state|agents|catalog|tasks/:id(/wait)`, `POST /api/tasks` (always an MCP-origin task under the `ask` ceiling unless the admin header is present), `POST /api/tasks/:id/cancel`, `POST /api/bsv/policy/freeze` (stop-only) and the SSE stream `GET /api/events` (which also accepts `?token=`). `GET /api/state` leaves `result` out of its task list (it can be large and no client of that endpoint reads it); `GET /api/tasks/:id` still returns it. **Every other route** needs `X-Legion-Admin: <secret>` (default deny, decided before routing, so an unknown path is 403, not 404; a core without a secret answers `403 admin_unavailable: open the Legion app`; a wrong secret answers `403 admin_required`). Both secrets are compared in constant time. Every route table below except the client list above is admin-only.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | none | `{ok, version, pid, admin}` (no auth; `admin` says whether this core holds an admin secret, never the secret). With `?nonce=<16-128 hex>` a core that holds the secret adds `proof`, HMAC-SHA256(secret, nonce) as hex: the app's challenge to tell its own core from anything else on the port. |
| GET | `/api/state` | `?archived=1`, `?slim=1` | `StateSnapshot`. Plain: the newest 200 tasks. `slim=1` (what the app window sends): every queued or running task, per visible agent the newest 14 by creation and by update, and the newest 12 overall, so the snapshot stays small however long the history is |
| GET | `/api/tasks` | `?agentId=&projectId=&q=&cursor=&limit=&archived=1` | `{tasks, nextCursor}`. Admin only. One page of the history, newest first (default 50, at most 100), without each task's final text. `q` matches the start of title words and agent names (all words must match). `cursor` is opaque (updatedAt and id); a bad one is a 400. Tasks of hidden agents are in no page or search, and a hidden agent id answers like one that never existed. Backed by `src/core/task-index.ts` (an in-memory index the Store updates on every create, update and delete; not persisted, rebuilt at startup) |
| GET | `/api/config` | none | config with secrets redacted |
| GET | `/api/doctor` | none | `DoctorCheck[]` |
| GET | `/api/catalog?refresh=1` | none | `Catalog` (slash commands and models) |
| GET | `/api/mcp/status` | none | `McpStatusView`: per server `state` (`connected`, `failed`, `needs-auth`, `pending`, `disabled`, `not-seen`), `origin` and a plain `message`, from the latest run. Read-only, admin only (not on the client list, so the default-deny gate answers 403 to the MCP token). |
| GET | `/api/agents` | none | `AgentProfile[]` |
| POST | `/api/agents` | `Partial<AgentProfile> & {name}` | `AgentProfile` (201). The id is the slugified name, suffixed if taken. |
| PATCH | `/api/agents/:id` | `Partial<AgentProfile>` | `AgentProfile` |
| DELETE | `/api/agents/:id` | none | `{ok:true}`. The `zealot` agent is refused with 400. |
| POST | `/api/tasks` | `{agentId, prompt, model?, continueTaskId?}` | `Task` (201) |
| GET | `/api/tasks/:id` | none | `{task, messages}` |
| GET | `/api/tasks/:id/wait?timeoutMs=N` | none | `Task`. Long-poll; N is at most 600000, default 120000. |
| POST | `/api/tasks/:id/cancel` | none | `{ok}` |
| GET | `/api/vms` | none | `VmRecord[]` |
| POST | `/api/vms/:agentId/start` | none | `VmRecord` |
| POST | `/api/vms/:agentId/stop` | none | `VmRecord` plus `stopped`, `verified`, `message`, `usage`. With no sandbox: 200, `stopped:false`, `message:"No sandbox to stop…"`, and a stale `error` record goes back to `none`. |
| GET | `/api/vms/:agentId/usage` | none | `VmUsage` (`running`, `runtimeSeconds`, `todaySeconds`, optional `estimate`) |
| POST | `/api/boat/check` | none | `BoatHealthView`. Probes what the boat.dev key may do (reads and not-found probes; never creates a sandbox) |
| GET | `/api/boat/health` | none | `BoatHealthView`. Admin only. `GET /api/state` (as `boat`) and `boat.health` events carry it too, but a token-only client gets a stripped copy: no prices, no probe results, no refused-action list |
| POST | `/api/vms/:agentId/exec` | `{command, cwd?, timeoutSeconds?}` | `{exitCode, stdout, stderr}` |
| POST | `/api/vms/:agentId/desktop` | none | `{url}` (treat as a secret) |
| GET | `/api/vms/:agentId/screenshot` | none | `{format:'jpeg', data:<base64>}`; 409 if the VM is not running |
| GET | `/api/approvals` | none | pending `ApprovalRequest[]` |
| POST | `/api/approvals/:id` | `{allow:boolean}` | `{ok}` |
| GET | `/api/events` | none | SSE stream of `LegionEvent` as `data: <json>`, heartbeat comment every 15 s |
| POST, GET, DELETE | `/mcp` | MCP | MCP streamable HTTP, stateless: a new transport and server per request |

Errors are `{error: string}` with status 400, 401, 404, 405, 409, 413, 500, 502 or 503. A 503 means boat.dev is not configured; 502 is an upstream boat.dev failure. Request bodies are capped at 2 MB.

CORS allows origins `null`, `file://`, `http://localhost:5173` (the Vite dev server) and `http://127.0.0.1:*`. Methods are `GET, POST, PATCH, DELETE, OPTIONS`; allowed headers are `Authorization, Content-Type, mcp-session-id, mcp-protocol-version`.

The shared types (`AgentProfile`, `Task`, `ChatMessage`, `LegionEvent`, `VmRecord`, `Catalog`, and so on) live in `src/shared/types.ts`. The UI imports them directly, so change them deliberately.

## MCP tools for Claude Code and Cowork

`src/core/mcp-tools.ts` builds an MCP server named `legion`. All tools return text content, with structured results as pretty-printed JSON. The `agent` argument accepts an id or a name, case-insensitive.

| Tool | Purpose |
|---|---|
| `legion_list_agents` | Agents with id, name, description, model, approval mode and VM state. |
| `legion_models` | Models the signed-in account can use. `refresh` re-probes instead of using the cache. |
| `legion_create_agent` | `{name, description?, systemPrompt?, model?, vmEnabled?}`. New agents default to `ask` approval. |
| `legion_run` | `{agent, prompt, model?, wait?=true, timeoutSeconds?=600}`. Waits and returns the answer, task id, model and cost, or returns the task id immediately when `wait` is false. |
| `legion_continue` | `{taskId, prompt, wait?, timeoutSeconds?}`. Follow-up in the same Claude session. |
| `legion_status` | `{taskId}`. Task plus its last 20 messages, each clipped to 2000 characters. |
| `legion_cancel` | `{taskId}`. |
| `legion_vm` | `{agent, action: status\|start\|stop\|exec\|desktop\|usage, command?}`. |
| `legion_recent_tasks` | `{limit?=10}`. |

## Agent-side VM tools

`src/core/vm-tools.ts` gives each agent an in-process SDK MCP server, also named `legion`, so the model sees tools as `mcp__legion__<name>`. It is attached only when the agent has `vm.enabled` and a boat.dev key is configured.

- `vm_start`: create or resume this agent's VM and return its state, `usage` and, when relevant, `notes` (a trial fallback, `vm_claude` unavailable).
- `vm_exec`: run a shell command in the VM. Starts it if needed.
- `vm_write_file` and `vm_read_file`: file access inside the VM.
- `vm_claude` (left out of the tool list while Claude is known not to be set up on boat.dev, see VM manager): hand a whole task to Claude Code running inside the VM (boat.dev's `claude` provider, which uses the subscription you connected on boat's Agents dashboard). That Claude Code has boat's built-in computer-use tools.
- `vm_desktop`: return a desktop streaming URL. Treat it as a secret and tell the user to open it.
- `vm_stop`: stop the VM and snapshot it. Billing pauses. With nothing to stop it answers `{ok:true, stopped:false, message:"No sandbox to stop…"}`, never an error state.
- `vm_usage`: read-only. State, size, `runtimeSeconds` (this run) and `todaySeconds`; never starts the VM. `vm_start`, `vm_exec` and `vm_stop` results carry the same numbers.

Every `vm_*` call resets the VM's idle timer.

## Engine

`src/core/engine.ts` runs tasks through the Claude Agent SDK.

- `startTask` creates or continues a `Task` (status `queued`), stores the user message, emits events and queues the job. At most 4 runs execute at once; the rest wait in FIFO order.
- A run routes the model, then calls `query({prompt, options})` with:
  - `model` and `cwd` (`agent.cwd`, or `<workspaceDir>/<agentId>`, created if missing);
  - `resume: task.sessionId` for follow-ups;
  - `systemPrompt: {type:'preset', preset:'claude_code', append: preamble + agent.systemPrompt}`;
  - `settingSources: ['user','project','local']` when `claude.inheritClaudeCodeSettings` is true, otherwise `[]`;
  - `mcpServers`: the agent's selected entries from `config.mcpServers`, plus the `legion` VM tools when available. An entry that points at Legion's own `/mcp` (loopback, this port) is skipped, and Settings refuses to save one;
  - `strictMcpConfig: true` unless `claude.inheritMcp` is on (default off): the Claude Code process then ignores MCP servers from user, project and local settings, `.mcp.json` and plugins, and uses only the `mcpServers` above. `buildChildEnv` also sets `ENABLE_CLAUDEAI_MCP_SERVERS=false` so claude.ai connectors are not loaded (both names checked against `@anthropic-ai/claude-agent-sdk` 0.3.285 and its bundled CLI 2.1.285: the option is in `sdk.d.ts`, and the CLI reads the env var, treating `false`, `0`, `no` and `off` as off). The catalog probe and the Doctor probe are strict with connectors off whatever `inheritMcp` says. `settingSources` and every other inherited setting are unchanged by this switch. The SDK `plugins` option only adds local plugin directories; Legion does not pass it;
  - approvals: mode `full` uses `bypassPermissions`; `ask` and `auto-edits` use the default permission mode with a `canUseTool` callback that goes through the approval broker;
  - `maxTurns`, `includePartialMessages: true`, an `AbortController`, and a scrubbed child environment (see Security);
  - `pathToClaudeCodeExecutable` when `claude.executablePath` is set.
- Stream handling:
  - `system/init` stores the session id on the task and records its `mcp_servers` list in an in-memory `McpStatusTracker` (`src/core/mcp-status.ts`). When a server is `failed` or `needs-auth`, or `inheritMcp` is on, the engine also calls the query's `mcpServerStatus()` once for the error text. With `inheritMcp` on, an inherited server whose source is not `sdk` and that is named `legion` or points at Legion's own `/mcp` (for example after `claude mcp add legion http://127.0.0.1:4747/mcp`) is switched off for that run with `toggleMcpServer(name, false)`, so an agent never reaches Legion through Legion. Best effort: a failure there never touches the run.
  - `stream_event` text deltas become `message.delta` events.
  - `assistant` messages become one assistant `ChatMessage`; `tool_use` blocks become `tool` messages whose text is the compact JSON input, at most 500 characters.
  - `system/local_command_output` (from slash commands such as `/cost`) becomes an assistant message.
  - `result` updates the task's result, cumulative cost and turns, and status.
- Mascot moods follow the run: `thinking` at start, `hacking` on each tool call, `success` or `error` at the end, and `idle` four seconds after nothing is running.
- Cancel aborts the run, denies its pending approvals and sets status `cancelled`.
- Tasks left `queued` or `running` when Core last stopped are marked `error` ("Legion restarted") on startup by `Store.recoverInterrupted`.

The preamble tells the agent it is running inside Legion, that VM tools cost money while the VM runs, and to start the VM only when needed and stop it when done.

## Router

`src/core/router.ts`, pure functions.

- **Prefix overrides.** A prompt starting with `/opus` or `/sonnet` (case-insensitive) forces that model and the prefix is stripped. `/model <value>` forces any model; `/model auto` means "route this message normally".
- **Fixed choice.** A non-`auto` choice passes through verbatim as the SDK `model`, whether an alias or a full id from the catalog.
- **Auto.** Chooses Opus when any of these hold: the prompt is over 1800 characters; it contains two or more hard keywords (`architect`, `design a`, `refactor`, `debug`, `root cause`, `prove`, `proof`, `optimi`, `security`, `audit`, `migrate`, `migration`, `plan`, `strategy`, `complex`, `tricky`, `concurrency`, `race condition`, `algorithm`, `trade-off`, `tradeoff`, `review`); or it contains an explicit phrase (`think hard`, `ultrathink`, `be thorough`, `deep dive`). Otherwise Sonnet. A continued task that last ran on Opus stays on Opus.
- **Escalation.** `shouldEscalate` is true only when the model is `sonnet`, the run ended in `error_during_execution` or another error (never `error_max_turns`: that pauses the task for Continue on the same model), and the error text does not look like an auth, billing, rate-limit or overload problem (`/auth|login|credit|billing|rate.?limit|429|401|403|overloaded/i`). It happens at most once per task, and only Sonnet to Opus.
- **Continue, not restart.** A task is `resumable` from the moment its run's `init` arrives (the request is then in the session), and loses it when the run finishes or a new follow-up is queued. When the escalated Opus run or the app's Continue button resumes such a session, it sends `CONTINUE_PROMPT` (`src/shared/continue.ts`), never the original request again: the session already holds it, and sending it twice makes the model start the task over. A turn-limit stop is stored as an error whose text starts with `TURN_LIMIT_PREFIX`; the app shows it as an amber "Paused" card.
- **Validation.** API and editor inputs accept `auto` or a string of at most 80 characters matching `^[A-Za-z0-9._:\[\]-]+$`.

## Approvals

`src/core/approvals.ts`. `ApprovalBroker.request(taskId, agentId, toolName, input)` returns a promise, emits `approval.requested`, and settles when `resolve(id, allow)` is called (emitting `approval.resolved`). Requests auto-deny after 10 minutes. `cancelForTask` denies everything pending for a task; `pending()` lists what is waiting.

`needsApproval(mode, toolName)`:

- `full` never asks.
- Read-only tools are always allowed: `Read`, `Glob`, `Grep`, `LS`, `WebSearch`, `WebFetch`, `TodoWrite`, `Task`, `Agent`, and anything under `mcp__legion__`.
- `ask` also asks for `Write`, `Edit`, `MultiEdit` and `NotebookEdit`.
- `auto-edits` allows those edit tools.
- `Bash`, any other `mcp__*` tool and unknown tools ask in both `ask` and `auto-edits`.

`canUseTool` returns `{behavior:'allow', updatedInput}` or `{behavior:'deny', message:'The user denied this action.'}`. The card summary is the command for `Bash`, the path for `Write` and `Edit`, and otherwise compact JSON of at most 400 characters.

## Catalog

`src/core/catalog.ts`, `getCatalog(deps, {force?})`. Probes Claude Code the same way the Doctor's sign-in check does: it starts an idle streaming-input query, calls `supportedCommands()` and `supportedModels()` with a 20 second timeout, then closes it. No model call is made. Results are cached for 10 minutes and concurrent calls share one probe. On failure it returns `{commands: [], models: [], error}` and never throws.

The composer's slash menu and model picker are built from this catalog.

### Slash commands

A prompt starting with `/<name>` where `<name>` is not a Legion command goes to Claude Code verbatim. The SDK runs slash commands, skills and custom commands. Legion's own commands are handled in the UI and never sent: `/new`, `/model <value|auto>`, `/opus`, `/sonnet`, `/vm start|stop|desktop`, `/doctor`, `/agent <name>` and `/clear`.

## VM manager

`src/core/vm-manager.ts` owns the per-agent VM lifecycle on top of `BoatClient` (`src/core/boat.ts`, a small `fetch` client for the boat.dev REST API).

- `ensureRunning(agentId)` creates or resumes the agent's sandbox and waits until it is ready. New sandboxes get a TTL of `idleStopMinutes * 60 + 900` seconds as a safety net. Concurrent calls for one agent share a single promise.
- `stop` stops and snapshots the sandbox, then asks boat.dev what state the VM is really in and reports that: `archived` (stopped), still `archiving` (in progress), gone, still up (`stopped:false`, the run keeps counting, "may still be billing"), or could not be asked (`verified:false`). Starts and stops for one agent run through a per-agent queue, so a stop issued while a start is still creating the VM waits for it, and a start requested after a stop waits for that stop; a failed step does not block the queue.
- `exec`, `readFile`, `writeFile`, `claude` and `desktopUrl` auto-start the VM and touch the idle timer.
- `screenshot` requires a running VM, runs an ImageMagick `import` (falling back to `scrot`) inside it, and reads the JPEG back as base64. It deliberately does not touch the idle timer: watching is not using. The UI polls it every 2.5 seconds while the Ops panel shows a running VM and the window is visible.
- The reaper runs every minute. It refreshes stored state from boat.dev once at startup and stops VMs idle longer than their agent's `idleStopMinutes`.
- boat.dev states map onto `VmState`: `none`, `provisioning`, `ready`, `running`, `idle`, `archiving`, `archived`, `error`.
- **Size and plan limits.** Create and resume use the agent's configured size (`vm.size`, editable in the agent settings and by `PATCH /api/agents/:id`; `state.json` is rewritten from memory, so edits there do not stick). If boat.dev refuses a machine class on a free trial (`403 trial_machine_class_not_allowed`), Legion retries with `default`, records `size:'default'`, `requestedSize:'large'` and a plain `notice`, and remembers for an hour that the account is limited so the next start skips the failing call. A running VM is never destroyed because the setting changed: the record says when the new size applies. A failed or stale record (`error` with no sandbox, a sandbox boat.dev no longer has or reports as `error`) is never reused: the next start builds a fresh sandbox from the config.
- **Usage.** A run starts when the VM becomes usable and ends when it stops being so (`runStartedAt`, `usageDay`, `usageSeconds` on the record; the shared maths is `src/shared/vm-usage.ts`, also used by the UI). `runtimeSeconds` is the current run, `todaySeconds` the local day's total, including a run that crosses midnight. This is uptime as Legion measured it; boat.dev bills by its own rules. The numbers are memoised per agent and second (`createUsageMemo`). Money appears only as an estimate and only when `boat.rates` (`{small?, default?, large?}` hourly prices in `boat.currency`) is set; Legion has no built-in prices. The core reads the prices from the config on every call. A holder of a cached copy (the UI keeps the last `BoatHealthView`) must not use prices older than `RATES_TTL_MS` (10 minutes, judged by the view's `asOf`): `vmUsage` then returns `estimateNote` ("cost unknown") instead of an estimate, and the UI refetches.
- **boat.dev key and account health** (`src/core/boat-health.ts`, memory only, reset when the key changes). Learned from a probe (on key save and startup, on "Check again", and in Doctor the first time) and from real failed calls: `api_key_action_forbidden` (which action the key cannot do), `provider_not_configured` (Claude not set up on the Agents page; hides `vm_claude` for 5 minutes, then Legion tries again; a later success clears it), `trial_machine_class_not_allowed`. The probe has no permission endpoint to read, so it does `GET /me`, a cheap list, and each action (stop, resume, run commands, files, prompt) aimed at a sandbox id that cannot exist: a key without the action is refused with `api_key_action_forbidden`, a key with it gets "not found". It never creates a sandbox. "Allowed" means "not refused", not a guarantee. Failures are classified: only a 401 means the key was rejected (`keyOk:false`, `keyProblem.kind` `auth`); a dead network, a 429 or a 5xx leave `keyOk` null with `keyProblem` `network`, `rate_limit` or `server` and mark the affected actions `unknown` with a `reason` (a 429 stops the probe), and an unexplained 403 is `unknown`, never "allowed". Findings belong to the key: when the key or base URL changes or is removed the knowledge is dropped by itself (the health object notices the client changed), and a probe still running for the old key cannot write its result into the new state. `vm_claude` is also checked when it is called, not only when the tool list was built: if Claude has been found unconfigured since, it refuses before any VM is started. Results show in Settings, the Computer card, Doctor and `boat.health` events. Error messages name the problem in plain words, and the API key is scrubbed from any error text.

## Doctor

`src/core/doctor.ts`. Checks, each of which never throws:

- Node version is 20 or newer.
- `config.json` exists.
- Auth mode, and for `api-key` whether a key is present.
- Claude sign-in: an idle query plus `accountInfo()` with a 20 second timeout. It reports the account email and subscription type, and makes no model call. The fix text is "Run `claude` in a terminal and sign in with /login".
- boat.dev: if a key is set, `BoatClient.me()`, then (first time) the key probe: the check fails with the refused action names and a fix when the key lacks a permission. A separate informational `boat-claude` check appears only while Claude is known not to be set up on boat.dev.
- The workspace directory is writable.

## Electron shell

`src/electron/main.ts`: single-instance lock; 1280x820 window (minimum 960x600) with a hidden title bar and overlay controls on Windows; tray icon with Show, Restart core and Quit; external links open in the default browser. On each core start main makes a random 32-byte admin secret, writes it to the core child's stdin pipe (`LEGION_ADMIN_STDIN=1`, never env, argv or a file) and keeps it in memory; a tray Restart core rotates it and reloads the window. `preload.cjs` is plain CommonJS and exposes `window.legion = {baseUrl, token, admin, platform, openExternal(url)}`, with the values fetched once over a synchronous IPC call; `admin` is non-empty only while our child is alive and the core on the port has just answered a fresh `GET /health?nonce=` challenge with the right HMAC (pid and `admin:true` prove nothing, and a `node` shim whose pid differs from the core's still passes), so a foreign core or a rogue listener never receives it. Main chooses the port once, passes it to the child as `LEGION_PORT`, and pins the port and MCP token for the window: `config.json` is not read again after the core starts, so editing it cannot redirect the window. If the core on the port is not ours (started by the MCP bridge or a terminal) and idle, main looks up which process owns the listener on the port (`netstat -ano` on Windows, `lsof` then `ss` elsewhere) and stops the pid `/health` claims only if that is the listener owner (otherwise the core counts as blocked and nothing is killed), then starts its own; if it has running tasks or pending approvals main asks (Restart now / Later), and until then approvals and settings answer 403 with an explanation in the UI. Our own core is spawned detached off Windows (its own process group) and stopped as a tree (`taskkill /T /F`, or a signal to the group), so a wrapper set in `LEGION_NODE` leaves no orphan. The decisions (including the listener output parsers and the kill plan) are pure functions in `src/electron/admin-logic.ts`; `test/electron-emu/` runs the compiled `main.js` with `electron` stubbed against a real core. The window runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.

## UI

`ui/` is Vite, React 19 and TypeScript, with no UI kit and tokenised hand-written CSS.

- Layout: a custom title bar; a left rail of agents with VM state and pending-approval badges; a center task thread with the composer; and a collapsible Ops panel (Ctrl+.) holding the mascot, the Computer card and recent tasks.
- Approval cards render inline in the thread. `A` and `D` allow or deny the focused one.
- `ui/src/api.ts` reads `window.legion` (Electron) or falls back to the `?base=&token=` query string, sends the bearer token and (in the app) `X-Legion-Admin` on every request through one helper, turns a `403 admin_unavailable` into a plain-words message ("Open the Legion app to approve or change settings"), and subscribes to the event stream with automatic reconnect and backoff: in the app with `fetch` and the admin header, in a browser tab with `EventSource` and `?token=` (which cannot send headers). The core sends `room.*`, `comms.*` and `settings.*` events only to an admin stream; a token-only stream gets task, message, agent, VM, approval and mascot events. `kg.*` events are admin-only too, so a plain browser tab (or the Vite dev server) does not get live Lattice or Inbox updates and shows what it loaded. A browser tab with `?token=` is read-only.
- Dark is the default theme, with a light variant.
- Fonts are bundled locally (see [NOTICE](../NOTICE)), so the app renders the same offline.

### Mascot

The mascot is "The Relic", animated by a layered SVG engine in `ui/src/mascot/`. Mascot art follows a fixed layer contract, described in [docs/art/MASCOT_CONTRACT.md](art/MASCOT_CONTRACT.md), and `scripts/build-mascot.py` turns a painted SVG into `ui/src/mascot/data/*.json`. Moods arrive as `mascot` events from the engine. Animation is CSS and SVG only and respects `prefers-reduced-motion`.

## Security model

- Core binds `127.0.0.1` only. The MCP token (random 24-byte hex, generated on first run, in `config.json`) opens the client routes; the admin secret (random 32 bytes, 64 hex characters, at least 32 required by the core, new on every core start, memory only, delivered over stdin) is needed for everything else. Comparison is constant-time.
- A bot can ask for a group room or for members to be added or removed (`room_create`, `room_add_member`, `room_remove_member`), but only through a card the user answers: the handler waits for it (never `canUseTool`, so no approval mode skips it), the MCP token cannot answer it, a decline or no answer within 10 minutes changes nothing, the rate is limited to 5 requests per bot per 10 minutes, the approved plan is created exactly as shown (re-checked at answer time), and bot-supplied card text is sanitized. See `docs/COMMS-BRIDGE.md`.
- A task started with the MCP token alone (`/mcp` or `POST /api/tasks`) gets `origin {roomId:'mcp', approvalCeiling:'ask'}`: a `full` agent runs in `default` mode with approval cards, and `legion_continue` keeps the earlier ceiling, origin and taint. The ceiling travels with that run's own messages too: `bot_send`, `room_post` and `handoff` take the strictest of the sender's agent mode, the woken tasks it is running and its own run's ceiling (`job.ceiling`), as `ask`/`tell` already did, so a peer it wakes is capped the same. Under a ceiling `vm_exec`, `vm_claude` and `vm_desktop` need a card. Shared Library notes from such a run are held for the Inbox. An unanswered MCP card is denied after 10 minutes with a message telling the client to open the Legion app.
- BSV policy changes use a second per-launch secret, the native secret (line 2 of the core's stdin, held only by the Electron main process). Flow: window -> `legion:bsv-policy` IPC (sender window and frame URL checked) -> strict parse (`parseBsvAction`) -> main reads the policy from its own core -> native dialog worded by main (the mainnet switch on, arm, unfreeze, limits, allowlists and Connect, and the spend dialogs; freeze, disarm, disconnect and the mainnet switch off skip it) -> core route with `X-Legion-Admin` and `X-Legion-Native`. The core module (`src/core/bsv/`) holds the pure policy engine (`policy.ts`), the hash-chained audit log (`audit.ts`), the loopback-only status probe (`wallet-probe.ts`, the one file allowed to name wallet methods), the `bsv_status` tool (`wallet-tool.ts`, MCP server `legion_bsv`, Assayer only) and the policy file (`policy-store.ts`), plus the spend path: `spend.ts` (the one file that names the three spend wallet methods; tool `bsv_spend_request` on the same `legion_bsv` server; pinned by content hash in `test/bsv-scan.ts`), `networks.ts` (per-network labels, address version bytes, default and hard caps; pinned too) and `mainnet-routes.ts` (`POST /api/bsv/policy/mainnet`). Spend routes, all admin and native-secret only and none on the MCP token's list: `GET /api/bsv/spend/pending`, `POST /api/bsv/spend/:id/decision`, `POST /api/bsv/spend/:id/resolve`. The wallet probe has no default address and contacts nothing until the owner presses Connect (in memory only). The policy file is fingerprinted (SHA-256 recorded in the audit log, which has a head anchor beside it), and Freeze is also open to the bearer token so a headless core can be stopped. The engine is used by the spend tool (testnet and mainnet; mainnet is a hard-off switch in the fingerprinted policy file and ships OFF; one Arm covers one mainnet spend); the spend path was tested against fake wallets only and has not been verified against a real wallet or with real funds. Main reads each card from the core itself and words the native dialogs. See docs/BSV-MODE.md and docs/BSV-WALLET-DESIGN.md.
- Residuals, stated plainly: a process running as the same OS user can read Legion's memory (and so the admin and native secrets), edit the installed files, synthesize input to the window, call the BSV wallet at `127.0.0.1:3321` directly, and read `config.json` (which holds `boat.apiKey` in plaintext). Only a VM or a separate OS account stops those. See SECURITY.md.
- CORS is limited to local origins. The Electron renderer uses `file://`.
- The renderer is sandboxed with context isolation; its only bridge is the `window.legion` object (base URL, token, admin key, platform, openExternal, `bsvPolicy(action)` and `onBsvChanged(cb)`; the window never holds the native secret).
- Legion does not read Claude credentials. The child environment starts from `process.env`, drops variables that belong to a host Claude session (so a Core launched from Claude Code does not attach to it), and removes API-key variables in `claude-login` mode.
- Approval modes are the main guard on what agents may do locally. `full` is opt-in per agent.
- boat.dev API keys live in `config.json` or the environment; the API redacts them. VM desktop URLs are secrets and are handed to the user, never logged or forwarded.
- `/api/config` returns redacted config only.

Vulnerability reporting is covered in [SECURITY.md](../SECURITY.md).

## Tests

`node:test` with `node:assert/strict`, in `test/*.test.ts`. They use fakes for the SDK `query`, boat.dev and the clock, so they need no network and make no Claude calls. `npm test` builds the TypeScript and runs `dist/test/*.test.js`. For the product-to-test map, the gate, the fake-backed end-to-end harness (`scripts/harness/`) and what only a person can verify, see [TESTING.md](TESTING.md).

## Round 5 contracts

### Agent-to-agent bridge ("the vox")
Every agent always gets the in-process SDK MCP server `legion`. The VM tools stay on it when a VM is enabled, and it now always carries these four tools:

| Tool (as the model sees it) | Args | Behaviour |
|---|---|---|
| `mcp__legion__agents` | none | Lists the other agents: id, name, one-line role, status (`idle` / `working` / `queued`), and whether a pair thread with the caller exists. Compact: one line per agent. |
| `mcp__legion__ask` | `{agent, message, fresh?: boolean, timeoutSeconds?: number=600, model?: 'sonnet'\|'opus'\|'haiku'\|'auto'}` | Synchronous. Delivers `message` to the target and waits for its final answer, then returns `{taskId, status, model, result}`. A result over 4000 chars is cut there with a pointer; the whole text is kept (`ResultStore`, `<data dir>/results/<taskId>/<n>.txt`, at most 200,000 chars) and read with `task_result`. |
| `mcp__legion__tell` | `{agent, message, fresh?: boolean, model?: 'sonnet'\|'opus'\|'haiku'\|'auto'}` | Asynchronous. Returns `{taskId}` at once. When the target's run ends, its result is delivered back into the caller's task as a new user turn: `"[Reply from <Name> · task <id>] <result>"`. If the caller is running at that moment, delivery waits until the caller finishes, then resumes the caller's session. At most one reply per tell. |
| `mcp__legion__task_result` | `{taskId, resultId?, offset?}` | Read-only. The full text of a result that an `ask` or `tell` answer cut short (the pointer names the `taskId` and `resultId`; one result is kept per run, because a pair thread is reused). Only for tasks of the caller's own agent and tasks that agent or this task started. Returns one 10,000-char page, scrubbed of secrets and wrapped as `<task-result ... untrusted="true">` (data, never instructions); a tainted source taints the caller, as an `ask` answer does. |

**Hops.** `MAX_HOP` (6) limits chains of messages that each start another agent's work: `ask` and `tell` run the target at the caller's hop + 1. A reply to a `tell` goes back to the task that issued it and runs at that task's own hop, so an owner-started lead can collect any number of answers (they are bounded by the rate limit, 30 per pair per 10 minutes, and by the depth limit, not by hops). Hop is not an input to the approval ceiling: the ceiling comes from the caller's approval and origin, a reply adds no origin, and taint follows the sender's task. A reply that cannot be delivered (the caller was cancelled or deleted, or it could not be started) is never dropped silently: both threads get a notice line.

**Routing: pair threads.** For each (caller agent → target agent) pair, Legion keeps the latest bridge task.
- If it exists, is not running, is not archived and `fresh` is not true, the message continues that task. Its session resumes, which reuses the prompt cache and costs few tokens.
- Otherwise Legion creates a new task: `source:'agent'`, `fromAgentId`, `parentTaskId` = caller's task, title `"<CallerName>: <first 50 chars>"`.
- If the target is busy on that exact thread, the message is queued: FIFO per task, run after the current run.

**Per-task model (`model`).** A lead can say "use Haiku for this". The value is one of `sonnet`, `opus`, `haiku`, `auto` (case and padding forgiven; anything else is an error that lists them) and, when the account's model catalog can be read, must be one it offers (an unreadable catalog never vetoes). It applies to that one run: the task records `requestedModel` and `modelOverride {model, by}` (shown as a chip on the task tab and in Recent tasks), and the next message on the same pair thread that names no model goes back to the target agent's own setting (a `tell` reply landing in the caller's own task never changes the caller's model). Choosing a model never changes approvals: the delegated task's ceiling is computed exactly as before (never looser than the caller's). `bot_send` and `room_post` take the same `model` for the turn they wake; it is stored on the room message (`RoomMessage.model`), shown in the room transcript and the Markdown export, and passed to the engine the same way. `legion_run` and `POST /api/tasks` already had `model`. It is capped at the target agent's own setting (haiku 1, sonnet 2, opus 3; `auto` or an unknown id counts as sonnet): `Bridge.ask`/`tell` and `Engine.startTask` refuse a request above it, the engine clamps what the router picks (and a `/opus` prefix in a bot's message) to it, and an override task on a sonnet-or-lower agent skips the sonnet to opus retry. The rank table is `src/core/model-cap.ts`.

**What the target sees.** One header line is prepended:
`[From <CallerName> (Legion agent) via the bridge. Reply with just what they need; your final message is returned to them.]`
The ChatMessage stored in the target thread has `role:'user'`, `fromAgentId`, and the raw message text without the header.

**Guards.**
- Self-messaging is an error.
- Depth is the parentTaskId chain length; above 3 is an error: "delegation too deep".
- Cycle guard: a target that is already an ancestor in the chain AND is waiting on an `ask` gets an error: "would deadlock". A `tell` is allowed.
- Bridge runs whose parent is running bypass the global concurrency cap, so nested asks can't deadlock the queue.
- Cancelling a task cancels its pending asks.
- Approvals still apply per target agent.

**Hygiene.**
- Engine options add `disallowedTools: ['SendMessage', 'ListAgents']`. Those are Claude Code's own peer-session tools and confuse agents inside Legion.
- The preamble tells agents to use `agents`, `ask` and `tell` for other Legion agents.

**Mascot.** `thinking`/`hacking` as usual. The note shows "Zealot → Builder".

### Task management
| Method | Path | Body | Response |
|---|---|---|---|
| PATCH | /api/tasks/:id | `{archived?: boolean, title?: string}` | `Task` (emits `task.updated`) |
| DELETE | /api/tasks/:id | – | `{ok:true}`. 409 if running. Removes the task and its messages file; emits `task.deleted`. |

`GET /api/state` and MCP `legion_recent_tasks` exclude archived tasks by default. `?archived=1` includes them.

### Settings
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/settings | – | `SettingsView` |
| PATCH | /api/settings | `SettingsPatch` | `SettingsView`. Validates, writes config.json atomically, applies live, emits `settings.updated`. |
| POST | /api/settings/boat/test | `{apiKey?: string}` | `{ok:boolean, detail:string, warnings?:string[]}` (warnings: key permission and Claude-setup findings). Tests the given key, or the saved one, with `GET /me`; never stores. |

**Applied live, no restart:**
- boat key/baseUrl: rebuild the BoatClient and start or stop the VM reaper;
- claude auth/apiKey/executablePath/inherit/inheritMcp/maxTurns: used from the next run;
- mcpServers: from the next run.

Port changes are not editable here.

`authToken` is never returned or editable. Secrets appear only as `apiKeySet` plus a hint of the last 4 chars.

## House context layer

The owner sees this layer as **Settings → Doctrine**; internally it is still the house context layer (`house_*` tools, `/api/house` routes, `src/core/house/`).

`src/core/house/` (`createHouseModule`, always on) copies a curated set of files from the installation into `<dataDir>/context` on start and serves it to every agent through the in-process server `legion_house`. Agents run in `workspaces/<agentId>`, never in the repository, so this is how the house rules, the decisions and the lessons reach them. Decisions: ADR 0009 (the layer), 0010 (owner adoption), 0011 (trust derived from the source), 0012 (switches and shipped skills).

- **Sync.** `syncContext` copies `AGENTS.md`, `CONTEXT.md`, the docs listed in `SHIPPED_FILES` and the folders in `SHIPPED_DIRS` (`docs/adr`, `context`, `skills`), walking folders recursively and copying only `.md` files (plus `.json` under `context/`). `scripts/stage-layer.mjs` does the same walk when `copy-static.mjs` stages `dist/context-layer`, so a packaged install and a checkout list the same files. A switch never stops a copy.
- **Trust.** A file is trusted only while its bytes match what Legion shipped (hash derived from the source, `.shipped.json`) or what the owner approved (`.adopted.json`, in the data directory). Anything else is served wrapped as untrusted. Reads taint the run. The layer is context, not permission.
- **Switches (`switches.ts`).** `<dataDir>/.house-switches.json` holds `off` (rules switched off) and `on` (skills switched on). Every rule is on by default except the skills, which are off by default. `AGENTS.md` and `CONTEXT.md` are locked on. A switched-off file is not listed, not readable and not returned by recall; it answers like a missing file. Paths are compared by real name, lower-cased (`canonicalRel`), because Windows and macOS are case-insensitive.
- **Groups.** `categoryOf` puts each path in one group for the owner's screen (themed name, plain hint): Core tenets (always on), Drills (skills), Foundations (how Legion is built), Decrees (decisions), Chronicle (release history), Lore (facts), Your orders (files you added). The names and hints live in `src/shared/house-view.ts`.
- **Skills (`skills.ts`).** `skills/<group>/<name>/SKILL.md` (frontmatter `name` and `description`), vendored and pinned in `skills/SOURCES.md`. Skills are served only by `house_skills` (the enabled ones) and `house_skill` (load one), never by `house_list`, `house_read` or `house_recall`. Legion never runs a skill's scripts. Each skill folder carries its licence as `LICENSE.md` so it is staged and synced with the skill (only `.md` ships); the screen shows it as a Licence link.
- **Tools.** `house_list`, `house_recall`, `house_read`, `house_skills`, `house_skill`, all read-only. The preamble names the enabled skills and says nothing about skills when none is on.
- **Routes.** All admin-only by the default-deny gate and none on the MCP client list: `GET /api/house` (the whole layer with category, skill group, title, trust, `on` and `locked`), `GET /api/house/file` (one file's text for the "Read it" link, ignoring switches), `POST /api/house/switch` (`{path, on}`; refuses to switch a core rule off), `POST /api/house/switch/reset` (`{category}` or `{group}`), `POST /api/house/adopt` and `/unadopt`. No tool changes a switch or an approval.
- **Limit.** The switch and adoption files are not a wall: a process running as the same OS user can write them. What a forged entry turns on is still served through the trust model and still taints the run (ADR 0011, ADR 0012).

## Projects and the board

`src/core/projects/` (`ProjectStore`, `createProjectsModule`) holds projects: owner-only routes, native confirmation for folder and member changes, a prompt section added after the agent's own prompt, and a project scope for Library notes (see `claude/plan-projects.md`). `src/core/projects/board/` is the board (`BoardStore`, `createBoardModule`, registered in `legion-core.ts` unless `features.projectBoard` is `false`): owner routes under `/api/projects/:id/board/...` (admin-only by the default-deny gate), the in-process server `legion_board` for member agents of a run's project (the project comes from the engine's `ModuleJob.projectId`, never from an argument), the read-only `legion_board_read` for token clients, `onTaskEnd` to move an item to Review or Blocked and link notes the run saved, and a preamble with a short board digest. Limits and the agent rules are in [PROJECT-BOARD.md](PROJECT-BOARD.md) and `claude/plan-project-board.md`; `board.updated` events carry no item text and go to the admin stream only.

## Blender Bridge

`src/core/blender/` is a core module (`createBlenderModule`, registered in `legion-core.ts`; off by default). It gives only the Sculptor the in-process server `legion_blender` (`blender_exec`, `_inspect`, `_screenshot`, `_docs`, `_status`) and adds the raw Blender MCP server names to every agent's `disallowedTools` through the new `CoreModule.disallowedTools(agent)` seam (the engine merges it into every run). `blender_exec` runs a static check, awaits an approval card inside the tool (it does not rely on `canUseTool`, so a bypass-mode bot still stops; `isLegionTool` includes `mcp__legion_blender__` so there is no second prompt), saves a `.blend` backup before the first live script of a task, then runs the script by mode: headless Blender on this computer (`local`, the default through `auto` when Blender is found), a `BlenderBackend` for `live` (official MCP stdio, or the community JSON socket; both at once is a setting, off by default), or the Sculptor's boat.dev VM (headless Blender, exports copied back into the workspace), and appends to a hash-chained audit log; output is untrusted text and marks the run tainted. Routes `GET /api/blender`, `POST /api/blender/{config,setup,test,launch}` are admin-only by the default-deny gate, and `blender.status` events are admin-only on the stream. The settings key is `blender` in `config.json`, rewritten alone like `bsv`. All downloads and processes go through `setup.ts`'s `BlenderIo` (real implementation in `system.ts`, on the BSV tripwire allowlist). See [BLENDER.md](BLENDER.md).

## Roster

`src/core/roster.ts` exports `ROSTER`, ten premade bots seeded by `Store.seedDefaults` after the three frozen defaults (zealot, builder and scout are never changed there). Seeding skips any id that already exists, so existing installs gain the new bots on next start and edited agents are never touched. Every roster prompt is the bot's own role, hard limits and output shape, followed by the shared working rules (think first, minimum change, touch only what was asked, verifiable goal, answer first, facts apart from guesses) and two lines on the `mcp__legion_comms__*` tools.

| id | model | approval | VM |
|---|---|---|---|
| `inquisitor` | opus | `ask` | off |
| `scribe` | sonnet | `auto-edits` | off |
| `archivist` | sonnet | `ask` | off |
| `sentinel` | sonnet | `ask` | on |
| `forgemaster` | auto | `ask` | on |
| `exorcist` | auto | `ask` | on |
| `preceptor` | opus | `ask` | on |
| `herald` | sonnet | `ask` | off |
| `assayer` | auto | `ask` | off |
| `sculptor` | auto | `ask` | on |

The Assayer carries `requires: 'bsv'` and is hidden until BSV mode is on. All roster VMs use the default size and a 15 minute idle stop.
