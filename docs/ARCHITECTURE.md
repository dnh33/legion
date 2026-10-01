# Architecture

This document describes how Legion is put together and the contracts between its parts. Read it before changing the core, the HTTP API or the MCP tools. For setup and workflow, see [CONTRIBUTING.md](../CONTRIBUTING.md).

Legion is a local, personal, Claude-only multi-agent bot. It runs on one machine for one user. It targets Windows first and also runs on macOS and Linux.

## Design principles

1. **Credentials stay with Claude Code.** Legion never reads, copies, stores or proxies Claude OAuth tokens or credential files. In `claude-login` mode it lets the Claude Agent SDK use whichever account Claude Code is signed in to, and removes `ANTHROPIC_API_KEY` (and `ANTHROPIC_AUTH_TOKEN`) from the child environment so the login is used. In `api-key` mode it passes `ANTHROPIC_API_KEY` from config, and nothing else.
2. **Models are aliases.** Legion passes Claude Code aliases (`sonnet`, `opus`) or values taken from the live model catalog. It never hard-codes dated model ids.
3. **Local only.** The HTTP server binds `127.0.0.1`. Every route except `GET /health` needs the MCP-class bearer token, and every route outside a short client list also needs the per-launch admin secret (see Security model).
4. **Small dependency surface.** Runtime dependencies are `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk` and `zod`, plus Node built-ins. Think twice before adding another.
5. **Windows-safe.** Use `path.join`, avoid shell-specific commands, and never hard-code `/tmp` on the host.
6. **ESM with NodeNext.** Relative imports end in `.js`. Node 20.10 or newer.

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
| `core.log` | Core log. |

Environment overrides: `LEGION_HOME`, `LEGION_PORT`, `LEGION_NODE`, `BOAT_API_KEY`, and `ANTHROPIC_API_KEY` (used only when `claude.auth` is `api-key`).

## Default agents

`Store.seedDefaults` creates these on first run without overwriting edits.

| id | name | model | approval | VM | purpose |
|---|---|---|---|---|---|
| `zealot` | Zealot | auto | `auto-edits` | enabled, default size | General-purpose lead. Cannot be deleted. |
| `builder` | Builder | auto | `full` | enabled, large | Coding and building; prefers its VM for risky work. |
| `scout` | Scout | sonnet | `ask` | disabled | Research, reading and summarising. |

VM idle stop defaults to 15 minutes. `mcpServers` defaults to `['*']` (all configured servers).

## HTTP API

JSON over `127.0.0.1:<port>` (default 4747). Implemented in `src/core/server.ts`. Two classes of caller (`src/core/admin.ts`). The **MCP token** (`Authorization: Bearer <authToken>`) opens only `/mcp`, `GET /api/state|agents|catalog|tasks/:id(/wait)`, `POST /api/tasks` (always an MCP-origin task under the `ask` ceiling unless the admin header is present), `POST /api/tasks/:id/cancel` and the SSE stream `GET /api/events` (which also accepts `?token=`). **Every other route** needs `X-Legion-Admin: <secret>` (default deny, decided before routing, so an unknown path is 403, not 404; a core without a secret answers `403 admin_unavailable: open the Legion app`; a wrong secret answers `403 admin_required`). Both secrets are compared in constant time. Every route table below except the client list above is admin-only.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | none | `{ok, version, pid, admin}` (no auth; `admin` says whether this core holds an admin secret, never the secret). With `?nonce=<16-128 hex>` a core that holds the secret adds `proof`, HMAC-SHA256(secret, nonce) as hex: the app's challenge to tell its own core from anything else on the port. |
| GET | `/api/state` | none | `StateSnapshot` |
| GET | `/api/config` | none | config with secrets redacted |
| GET | `/api/doctor` | none | `DoctorCheck[]` |
| GET | `/api/catalog?refresh=1` | none | `Catalog` (slash commands and models) |
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
| POST | `/api/vms/:agentId/stop` | none | `VmRecord` |
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
| `legion_vm` | `{agent, action: status\|start\|stop\|exec\|desktop, command?}`. |
| `legion_recent_tasks` | `{limit?=10}`. |

## Agent-side VM tools

`src/core/vm-tools.ts` gives each agent an in-process SDK MCP server, also named `legion`, so the model sees tools as `mcp__legion__<name>`. It is attached only when the agent has `vm.enabled` and a boat.dev key is configured.

- `vm_start`: create or resume this agent's VM and return its state.
- `vm_exec`: run a shell command in the VM. Starts it if needed.
- `vm_write_file` and `vm_read_file`: file access inside the VM.
- `vm_claude`: hand a whole task to Claude Code running inside the VM (boat.dev's `claude` provider, which uses the subscription you connected on boat's Agents dashboard). That Claude Code has boat's built-in computer-use tools.
- `vm_desktop`: return a desktop streaming URL. Treat it as a secret and tell the user to open it.
- `vm_stop`: stop the VM and snapshot it. Billing pauses.

Every `vm_*` call resets the VM's idle timer.

## Engine

`src/core/engine.ts` runs tasks through the Claude Agent SDK.

- `startTask` creates or continues a `Task` (status `queued`), stores the user message, emits events and queues the job. At most 4 runs execute at once; the rest wait in FIFO order.
- A run routes the model, then calls `query({prompt, options})` with:
  - `model` and `cwd` (`agent.cwd`, or `<workspaceDir>/<agentId>`, created if missing);
  - `resume: task.sessionId` for follow-ups;
  - `systemPrompt: {type:'preset', preset:'claude_code', append: preamble + agent.systemPrompt}`;
  - `settingSources: ['user','project','local']` when `claude.inheritClaudeCodeSettings` is true, otherwise `[]`;
  - `mcpServers`: the agent's selected entries from `config.mcpServers`, plus the `legion` VM tools when available;
  - approvals: mode `full` uses `bypassPermissions`; `ask` and `auto-edits` use the default permission mode with a `canUseTool` callback that goes through the approval broker;
  - `maxTurns`, `includePartialMessages: true`, an `AbortController`, and a scrubbed child environment (see Security);
  - `pathToClaudeCodeExecutable` when `claude.executablePath` is set.
- Stream handling:
  - `system/init` stores the session id on the task.
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
- **Escalation.** `shouldEscalate` is true only when the model is `sonnet`, the run ended in `error_max_turns`, `error_during_execution` or another error, and the error text does not look like an auth, billing, rate-limit or overload problem (`/auth|login|credit|billing|rate.?limit|429|401|403|overloaded/i`). It happens at most once per task, and only Sonnet to Opus.
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
- `stop` stops and snapshots the sandbox, then briefly waits so the UI can show `archived`.
- `exec`, `readFile`, `writeFile`, `claude` and `desktopUrl` auto-start the VM and touch the idle timer.
- `screenshot` requires a running VM, runs an ImageMagick `import` (falling back to `scrot`) inside it, and reads the JPEG back as base64. It deliberately does not touch the idle timer: watching is not using. The UI polls it every 2.5 seconds while the Ops panel shows a running VM and the window is visible.
- The reaper runs every minute. It refreshes stored state from boat.dev once at startup and stops VMs idle longer than their agent's `idleStopMinutes`.
- boat.dev states map onto `VmState`: `none`, `provisioning`, `ready`, `running`, `idle`, `archiving`, `archived`, `error`.

## Doctor

`src/core/doctor.ts`. Checks, each of which never throws:

- Node version is 20 or newer.
- `config.json` exists.
- Auth mode, and for `api-key` whether a key is present.
- Claude sign-in: an idle query plus `accountInfo()` with a 20 second timeout. It reports the account email and subscription type, and makes no model call. The fix text is "Run `claude` in a terminal and sign in with /login".
- boat.dev: if a key is set, `BoatClient.me()`.
- The workspace directory is writable.

## Electron shell

`src/electron/main.ts`: single-instance lock; 1280x820 window (minimum 960x600) with a hidden title bar and overlay controls on Windows; tray icon with Show, Restart core and Quit; external links open in the default browser. On each core start main makes a random 24-byte admin secret, writes it to the core child's stdin pipe (`LEGION_ADMIN_STDIN=1`, never env, argv or a file) and keeps it in memory; a tray Restart core rotates it and reloads the window. `preload.cjs` is plain CommonJS and exposes `window.legion = {baseUrl, token, admin, platform, openExternal(url)}`, with the values fetched once over a synchronous IPC call; `admin` is non-empty only while our child is alive and the core on the port has just answered a fresh `GET /health?nonce=` challenge with the right HMAC (pid and `admin:true` prove nothing, and a `node` shim whose pid differs from the core's still passes), so a foreign core or a rogue listener never receives it. Main chooses the port once, passes it to the child as `LEGION_PORT`, and pins the port and MCP token for the window: `config.json` is not read again after the core starts, so editing it cannot redirect the window. If the core on the port is not ours (started by the MCP bridge or a terminal) and idle, main stops it by pid and starts its own; if it has running tasks or pending approvals main asks (Restart now / Later), and until then approvals and settings answer 403 with an explanation in the UI. The decisions are pure functions in `src/electron/admin-logic.ts`. The window runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.

## UI

`ui/` is Vite, React 19 and TypeScript, with no UI kit and tokenised hand-written CSS.

- Layout: a custom title bar; a left rail of agents with VM state and pending-approval badges; a center task thread with the composer; and a collapsible Ops panel (Ctrl+.) holding the mascot, the Computer card and recent tasks.
- Approval cards render inline in the thread. `A` and `D` allow or deny the focused one.
- `ui/src/api.ts` reads `window.legion` (Electron) or falls back to the `?base=&token=` query string, sends the bearer token and (in the app) `X-Legion-Admin` on every request through one helper, turns a `403 admin_unavailable` into a plain-words message ("Open the Legion app to approve or change settings"), and subscribes to the event stream with automatic reconnect and backoff: in the app with `fetch` and the admin header, in a browser tab with `EventSource` and `?token=` (which cannot send headers). The core sends `room.*`, `comms.*` and `settings.*` events only to an admin stream; a token-only stream gets task, message, agent, VM, approval, mascot and kg events. A browser tab with `?token=` is read-only.
- Dark is the default theme, with a light variant.
- Fonts are bundled locally (see [NOTICE](../NOTICE)), so the app renders the same offline.

### Mascot

The mascot is "The Relic", animated by a layered SVG engine in `ui/src/mascot/`. Mascot art follows a fixed layer contract, described in [docs/art/MASCOT_CONTRACT.md](art/MASCOT_CONTRACT.md), and `scripts/build-mascot.py` turns a painted SVG into `ui/src/mascot/data/*.json`. Moods arrive as `mascot` events from the engine. Animation is CSS and SVG only and respects `prefers-reduced-motion`.

## Security model

- Core binds `127.0.0.1` only. The MCP token (random 24-byte hex, generated on first run, in `config.json`) opens the client routes; the admin secret (random 24 bytes, new on every core start, memory only, delivered over stdin) is needed for everything else. Comparison is constant-time.
- A task started with the MCP token alone (`/mcp` or `POST /api/tasks`) gets `origin {roomId:'mcp', approvalCeiling:'ask'}`: a `full` agent runs in `default` mode with approval cards, and `legion_continue` keeps the earlier ceiling, origin and taint. The ceiling travels with that run's own messages too: `bot_send`, `room_post` and `handoff` take the strictest of the sender's agent mode, the woken tasks it is running and its own run's ceiling (`job.ceiling`), as `ask`/`tell` already did, so a peer it wakes is capped the same. Under a ceiling `vm_exec`, `vm_claude` and `vm_desktop` need a card. Shared Library notes from such a run are held for the Inbox. An unanswered MCP card is denied after 10 minutes with a message telling the client to open the Legion app.
- Residuals, stated plainly: a process running as the same OS user can read Legion's memory (and so the admin secret), edit the installed files, synthesize input to the window, call the BSV wallet at `127.0.0.1:3321` directly, and read `config.json` (which holds `boat.apiKey` in plaintext). Only a VM or a separate OS account stops those. See SECURITY.md.
- CORS is limited to local origins. The Electron renderer uses `file://`.
- The renderer is sandboxed with context isolation; its only bridge is the `window.legion` object (base URL, token, admin key, platform, openExternal).
- Legion does not read Claude credentials. The child environment starts from `process.env`, drops variables that belong to a host Claude session (so a Core launched from Claude Code does not attach to it), and removes API-key variables in `claude-login` mode.
- Approval modes are the main guard on what agents may do locally. `full` is opt-in per agent.
- boat.dev API keys live in `config.json` or the environment; the API redacts them. VM desktop URLs are secrets and are handed to the user, never logged or forwarded.
- `/api/config` returns redacted config only.

Vulnerability reporting is covered in [SECURITY.md](../SECURITY.md).

## Tests

`node:test` with `node:assert/strict`, in `test/*.test.ts`. They use fakes for the SDK `query`, boat.dev and the clock, so they need no network and make no Claude calls. `npm test` builds the TypeScript and runs `dist/test/*.test.js`.

## Round 5 contracts

### Agent-to-agent bridge ("the vox")
Every agent always gets the in-process SDK MCP server `legion`. The VM tools stay on it when a VM is enabled, and it now always carries these three tools:

| Tool (as the model sees it) | Args | Behaviour |
|---|---|---|
| `mcp__legion__agents` | none | Lists the other agents: id, name, one-line role, status (`idle` / `working` / `queued`), and whether a pair thread with the caller exists. Compact: one line per agent. |
| `mcp__legion__ask` | `{agent, message, fresh?: boolean, timeoutSeconds?: number=600}` | Synchronous. Delivers `message` to the target and waits for its final answer, then returns `{taskId, status, model, result}`. The result is truncated to 4000 chars with a note. |
| `mcp__legion__tell` | `{agent, message, fresh?: boolean}` | Asynchronous. Returns `{taskId}` at once. When the target's run ends, its result is delivered back into the caller's task as a new user turn: `"[Reply from <Name> · task <id>] <result>"`. If the caller is running at that moment, delivery waits until the caller finishes, then resumes the caller's session. At most one reply per tell. |

**Routing: pair threads.** For each (caller agent → target agent) pair, Legion keeps the latest bridge task.
- If it exists, is not running, is not archived and `fresh` is not true, the message continues that task. Its session resumes, which reuses the prompt cache and costs few tokens.
- Otherwise Legion creates a new task: `source:'agent'`, `fromAgentId`, `parentTaskId` = caller's task, title `"<CallerName>: <first 50 chars>"`.
- If the target is busy on that exact thread, the message is queued: FIFO per task, run after the current run.

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
| POST | /api/settings/boat/test | `{apiKey?: string}` | `{ok:boolean, detail:string}`. Tests the given key, or the saved one, with `GET /me`; never stores. |

**Applied live, no restart:**
- boat key/baseUrl: rebuild the BoatClient and start or stop the VM reaper;
- claude auth/apiKey/executablePath/inherit/maxTurns: used from the next run;
- mcpServers: from the next run.

Port changes are not editable here.

`authToken` is never returned or editable. Secrets appear only as `apiKeySet` plus a hint of the last 4 chars.

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
