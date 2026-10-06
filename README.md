<div align="center">

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/legion-wordmark-dark.svg"><img alt="Legion" src="docs/images/legion-wordmark-light.svg" width="460"></picture>

**A local multi-agent bot for your desktop — Claude by default, plus OpenRouter for any model — with a VM for every agent when it needs one.**

<img alt="The Claude Code critter glitches and is converted into the Legion helm" src="docs/images/legion-takeover.gif" width="285">

<sub>Ŧ The Legion is taking over Claude. (Art only: Legion is an independent app, is not affiliated with or endorsed by Anthropic, and does not modify Claude Code.)</sub>

[Status](#status) · [Install](#install) · [Orchestrate over MCP](#orchestrate-from-claude-code-or-cowork) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

</div>

## Status

Legion is v0.2.0. What is built and what is not:

- **Built and covered by the automated tests** (no network, no real Claude calls): the core, the app, agents, rooms, the Lattice and Library, Projects with the work board, the browser tool, MCP orchestration, approvals, the Windows installer scripts. The board and the browser tool are built and tested, not yet tried on a real PC.
- **BSV mode:** a read-only status check of a wallet on this computer, plus one spend tool that asks the wallet to pay only after your confirmations in native dialogs (testnet and mainnet; mainnet is built and OFF until you switch it on). Tested against fake wallets only; not verified against a real wallet or with real funds yet.
- **Blender bridge:** built, but not yet tried on a real Blender.
- **Installer:** unsigned, and not yet run on a wide range of Windows machines. Expect SmartScreen or antivirus prompts. There are no prebuilt releases yet (a prebuilt package is scripted and comes with the release; not built or run on Windows so far); today you install from source.
- **The updater:** built, but off until a signing key is published and the repository is public.
- **Claude by default, plus OpenRouter.** Add your own OpenRouter key and run any model. Codex and other local/custom endpoints are under [Later](#later).

## What it is

Legion is a desktop app for running several Claude agents from one place. Each agent has its own persona, model policy, approval mode and working directory, and can start a cloud Ubuntu VM on [boat.dev](https://boat.dev) when a task calls for one. It runs on your machine: a small Node service on `127.0.0.1` does the work, and an Electron window sits on top. Agents run through the official Claude Agent SDK using the Claude Code account you are already signed in to, so there are no extra logins or keys to manage.

Claude Code and Cowork can drive Legion too, over MCP.

**Legion runs on Claude by default.** Every existing agent runs on a Claude model through the Claude Agent SDK. OpenRouter ships in 0.2.0 as a second provider — add your own key and run any model. Codex and other local/custom endpoints are 0.2.1 (see [Later](#later)).

<p align="center">
  <img src="docs/images/app-dark.png" alt="Legion's main window in the dark theme: agent rail, a task thread with tool calls and an inline approval card, the mascot, the Computer panel and recent tasks" width="900">
</p>

<details>
<summary>Light theme</summary>
<p align="center"><img src="docs/images/app-light.png" alt="Legion's main window in the light theme" width="900"></p>
</details>

## Features

- **Multiple agents.** Ships with Zealot (lead), Builder (coding) and Scout (research), plus ten more premade bots (see [The Muster](#the-muster)). Create your own with a name, system prompt, model, approval mode and VM settings.
- **Projects and a board.** A project groups one job: instructions, a folder, member agents, tasks, rooms and notes. Its board holds work items the member agents can create, edit, move, claim and note, with you marking them done, approving deletes and deciding what runs (see [docs/PROJECT-BOARD.md](docs/PROJECT-BOARD.md)).
- **Rooms.** Group chats of bots and you, with guards against runaway loops (see [Rooms](#rooms)).
- **The Lattice and the Library.** A shared knowledge graph the bots use as long-term memory, with an Inbox where you accept or reject what they save (see [Lattice and Library](#lattice-and-library)).
- **Rooms you can build from chat.** Bots can propose creating a room or changing its members with `room_create`, `room_add_member` and `room_remove_member`. Each one waits for an Allow card that only you can answer in the app, whatever the agent's approval mode (see [Rooms](#rooms)).
- **BSV mode** (off by default): reveals the Assayer and a BSV knowledge pack, a read-only status check of a wallet on this computer, and one spend tool that asks the wallet to pay once you have confirmed in native dialogs (testnet and mainnet; mainnet is built and OFF until you switch it on). Tested against fake wallets only; not verified against a real wallet or with real funds yet (see [BSV mode](#bsv-mode)).
- **Blender bridge** (off by default): the Sculptor builds 3D scenes in headless Blender on this computer by default (in its cloud VM when Blender is not found), or in your open Blender after an approval card that shows the whole script. Backends are downloaded only when you press Set up. Not yet tried with a real Blender or a real VM (see [docs/BLENDER.md](docs/BLENDER.md)).
- **Agents talk to each other.** Any agent can `ask` another and wait for the answer, or `tell` it and get the reply later in its own task. Pair threads resume the same session, so repeat conversations stay cheap. Hop, rate and cycle guards stop runaway loops.
- **Settings in the app.** Claude sign-in or API key, your boat.dev key (with a Test button), MCP servers and connection snippets. Changes apply live.
- **Auto model routing.** Each task goes to Sonnet or Opus depending on how hard it looks. If Sonnet fails or runs out of turns, Legion retries once on Opus. Or pick any model your account offers.
- **Your Claude Code setup, partly inherited.** Agents pick up your Claude Code settings, hooks, skills and slash commands by default. Your Claude Code MCP servers and claude.ai connectors are *not* loaded unless you turn on `claude.inheritMcp`; add the MCP servers you want agents to have in Settings or `config.json`.
- **A VM per agent, on demand.** Agents start, use and stop their own boat.dev VM. You get a live screen preview and an "Open desktop" link. Idle VMs stop on their own so billing pauses. Legion shows how long a VM has run today, and an optional cost estimate from the hourly price you enter (see [docs/VM-NOTES.md](docs/VM-NOTES.md)).
- **Inline approvals.** Per agent, choose `ask`, `auto-edits` or `full`. Risky tool calls show up as Allow/Deny cards in the thread. Press `A` or `D`.
- **Slash commands and a model picker** in the composer.
- **A message queue.** While an agent works, Enter queues your next messages (in order, shown above the composer); Ctrl+Enter interrupts the run and sends now. A stop, a failure or a reload pauses the queue instead of sending on its own. See [docs/CHAT.md](docs/CHAT.md).
- **Copy menu** under every reply: copy as Markdown or as plain text.
- **Tables.** Markdown tables in replies are drawn as real, scrollable tables; copy as Markdown keeps the source, copy as plain text gives tab-separated rows.
- **Orchestration over MCP.** Claude Code connects over HTTP; Cowork and Claude Desktop connect over a stdio bridge.
- **Doctor.** A built-in check of Node, config, Claude sign-in, boat.dev and the workspace, with a fix for each failure.
- **A hand-painted animated mascot**, The Relic, that reacts to what your agents are doing.
- **Keyboard first**, dark and light themes, tray icon, fonts bundled so it works offline.

## The Muster

Legion ships with 13 premade bots, each with its own persona, model policy, approval mode and animated bust. The three originals are **Zealot** (lead), **Builder** (coding) and **Scout** (research). Ten more join them: **Inquisitor** (hostile review and security audit), **Scribe** (documentation), **Archivist** (notes and memory hygiene; flags, never deletes), **Sentinel** (watch duty and alerts), **Forgemaster** (infrastructure, CI and deploys), **Exorcist** (debugging), **Preceptor** (craft and mentoring), **Herald** (message drafts; drafts only, never sends), **Sculptor** (Blender work through the Blender bridge) and **Assayer** (BSV development; hidden until BSV mode is on, so you see 12 until then). They are ordinary agents: edit their prompts, models and approval modes like any other, or delete the ones you do not want.

## Rooms

A room is a group chat of 2 to 6 bots plus you. Bots can also message each other directly. A plain message wakes bots by one of four strategies (mention, manager, round-robin, all), and guards for hops, budget, cycles and `@everyone` stop loops; you can freeze and resume a room at any time. A bot that wakes through a room never runs with more freedom than the bot that woke it, and text that looks like a seed phrase is refused rather than stored. Details: [docs/COMMS-BRIDGE.md](docs/COMMS-BRIDGE.md).

## Lattice and Library

The Lattice is a shared, traversable knowledge graph (search, neighbours, paths, recall, lint, Markdown vault import and export) with `kg_*` tools for every bot and a graph view. The Library turns it into long-term memory: bots capture decisions, mistakes and patterns, every note carries a trust level, and anything a bot writes after touching the web, a shell or an outside tool waits in your Inbox until you accept it. There are no model calls or embeddings in any of it. See [docs/KNOWLEDGE-GRAPH.md](docs/KNOWLEDGE-GRAPH.md) and [docs/LIBRARY.md](docs/LIBRARY.md).

## BSV mode

An optional toggle in Settings, off by default. It shows the Assayer bot, loads a read-only BSV knowledge pack into the Lattice (163 notes) and gives the Assayer a short preamble. It can run a read-only status check of a wallet on this computer (four harmless questions to an address you type; the answer is the wallet's own claim). Legion's own code also has one spend tool, `bsv_spend_request`: it asks your wallet to build a transaction, Legion decodes it itself, you read native dialogs (amount, the full address, the network, the fee, the limits left), and only then is the wallet asked to sign; the wallet's own prompt is the last gate. It works on testnet and on mainnet. **Mainnet is built behind a hard-off switch that ships OFF**: only you turn it on, in the app, and each mainnet spend needs its own Arm and an extra dialog. Limits are tiny by default and per network, the recipient list starts empty, and an outcome Legion cannot confirm blocks every spend until you resolve it. Legion's own code holds no key and does no signing or broadcasting itself. An agent's ordinary tools (a shell, a web fetch) are outside all of this and rest on their approval cards. The Assayer is an ordinary agent: in `ask` mode its shell commands and file edits need your approval, while web fetch and read-only tools run without a prompt. **The spend tool was built and tested against fake wallets only and has not been verified against a real wallet or with real funds until your checks are recorded**; Legion has never been pointed at your funded wallet by its own code, tests or agents. See [docs/BSV-MODE.md](docs/BSV-MODE.md) for what it is and is not.

## Your Claude subscription, and Anthropic's terms

Legion talks to Claude through the official [Claude Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk). By default (`claude.auth: "claude-login"`) it uses whichever account Claude Code is signed in to on your machine. Legion never reads, copies or stores your Claude credentials, and it removes `ANTHROPIC_API_KEY` from the child environment so your login is the one used. If you would rather pay by API key, set `claude.auth` to `api-key` and provide one.

Use it for yourself, on your own machine. Do not host Legion for other people, put it behind a shared endpoint, or pass your subscription through it to anyone else. Anthropic's terms are the authority on what your plan allows, and they can change; read them for your plan. Legion is an independent project and is not affiliated with or endorsed by Anthropic or boat.dev.

## Requirements

- **Node.js 20.10 or newer.** The Electron app starts Legion Core with your system `node`. CI runs on Node 22 and `.nvmrc` says 22, so 22 is the safest choice.
- **Claude Code, signed in.** Run `claude`, then `/login`. A Claude subscription or an API key is required.
- **Windows 10/11** is the primary target. The installer is unsigned and has had no wide testing yet; expect Windows SmartScreen or antivirus prompts for `.cmd` files. macOS and Linux work from a dev install.
- **Optional:** a [boat.dev](https://boat.dev) account and API key for agent VMs.

## Install

### Windows

Unpack or clone the source anywhere, then double-click `setup.cmd`, or run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

Setup installs Legion for your user on the C drive, in `%LOCALAPPDATA%\Programs\Legion`. No admin rights are needed. It copies the source there, installs dependencies, builds the app, and adds **Legion** shortcuts to the Desktop and Start menu. Options:

- `-InstallDir "C:\Some\Folder"` installs somewhere else.
- `-DryRun` shows what would happen without changing anything.
- `-Yes` asks no questions: it stops a running Legion, installs and launches. `setup-yes.cmd` is the same as a double-click; it closes by itself when it succeeds and keeps the window open with a message if it fails (never when input is redirected). Setup also never waits when it is run from a script (input redirected).
- Run setup again from a newer source folder to update in place. It asks before stopping a running Legion, unless input is redirected (a script or CI), where it takes the default and stops it. Legion's own code is matched by install folder and package name (`package.json` named `legion` with Legion's entry points), wherever that folder is, and stopped by process ID; it never stops by program name, and it leaves the process that started setup alone. It refuses to install over a folder that is not empty and not already a Legion install.

To launch, use the shortcuts or `start-legion.cmd` in the install folder. To uninstall, run `uninstall.cmd` in the install folder; it removes the install folder and the Desktop and Start-menu shortcuts. Your data in `%USERPROFILE%\.legion` is kept; add `/purge` to delete it too (you will be asked to confirm).

### macOS and Linux (or any dev install)

```bash
git clone https://github.com/dnh33/legion.git
cd legion
npm ci
npm start          # builds, then opens the desktop app
```

`npm run core` runs the headless core alone, which is enough for the MCP integration.

## Updates

Legion can check GitHub for a new release and tell you. It downloads and installs only after you click Update (or if you turn on "install updates automatically when idle", which is off by default), and it never restarts while a task, approval or install is in progress; a ready update waits until Legion is idle. Updates are checked against a signature made with the maintainer's key, which is built into your copy of Legion. The check is one request to github.com (it sees your IP address and the Legion version) and can be turned off in Settings, About. A git checkout is only told that a new version exists; update it with `git pull` and a rebuild. Details and limits: [docs/UPDATES.md](docs/UPDATES.md).

## First run and Doctor

On first launch Legion creates `config.json` in its data directory (`%USERPROFILE%\.legion` on Windows, `~/.legion` elsewhere) with a fresh auth token. Open **Doctor** in the title bar (or type `/doctor`) to check the setup. It confirms your Node version, config, Claude sign-in (email and plan, with no model call), boat.dev key and workspace folder, and tells you how to fix anything that fails. If sign-in fails, run `claude` in a terminal and use `/login`.

## boat.dev VMs

VMs are optional. Without a key, agents simply work locally.

1. Create an API key in the boat.dev dashboard.
2. Put it in `config.json` as `"boat": { "apiKey": "…" }`, or set the `BOAT_API_KEY` environment variable.
3. To let an agent run Claude Code *inside* its VM (`vm_claude`), connect your Claude subscription once on boat's **Agents** dashboard. That sign-in goes through Anthropic's own flow, not through Legion.
4. Restart Legion, and enable the VM in an agent's settings.

Agents get `vm_start`, `vm_exec`, `vm_write_file`, `vm_read_file`, `vm_claude`, `vm_desktop` and `vm_stop`. VMs cost money while they run; Legion stops them after a configurable idle period (15 minutes by default).

## Orchestrate from Claude Code or Cowork

Run `npm run mcp-config` to print ready-to-paste snippets with your real token. That token is the MCP token: it lets Claude Code and Cowork run and read agents (under the `ask` approval ceiling), but it cannot approve cards, accept Library notes, change settings or change BSV policy (the one BSV call it can make is Freeze, which only stops things); those need the Legion app window, which holds a secret that lives only in memory.

**Claude Code** (MCP over HTTP):

```bash
claude mcp add --transport http legion http://127.0.0.1:4747/mcp \
  --header "Authorization: Bearer <token>"
```

**Cowork and Claude Desktop** (stdio bridge), in `claude_desktop_config.json` under `mcpServers`:

```json
"legion": { "command": "node", "args": ["/path/to/legion/dist/src/bin/legion-mcp-stdio.js"] }
```

The bridge starts Legion Core headless if the app is not running. Then you can say, for example: *"Use legion_run with Builder to scaffold the site in its VM, then summarise."*

| Tool | What it does |
|---|---|
| `legion_list_agents` | List agents with model, approval mode and VM state. |
| `legion_models` | List the models your account can use. |
| `legion_create_agent` | Create an agent (name, prompt, model, VM). |
| `legion_run` | Give an agent a task; waits for the answer by default. |
| `legion_continue` | Follow up on a finished task in the same session. |
| `legion_status` | Task status, result and recent messages. |
| `legion_cancel` | Cancel a queued or running task. |
| `legion_vm` | Check, start, stop, exec in, or get the desktop URL of an agent's VM. |
| `legion_recent_tasks` | List recent tasks. |

## Slash commands and models

<p align="center">
  <img src="docs/images/slash-menu.png" alt="The composer's slash menu, with Legion commands and Claude Code commands" width="560">
  <img src="docs/images/model-picker.png" alt="The model picker, listing Auto and the models available to the account" width="560">
</p>

Type `/` in the composer to open the menu. Commands that Legion does not handle itself go to Claude Code unchanged, so your skills, plugins and custom commands work.

| Command | Action |
|---|---|
| `/new` | Start a new task. |
| `/model <auto\|name>` | Set the model for the composer, or for one message if you add text. |
| `/opus`, `/sonnet` | Shorthands for `/model`. |
| `/vm start\|stop\|desktop` | Control this agent's VM. |
| `/doctor` | Open the setup checks. |
| `/agent <name>` | Switch agent. |
| `/clear` | Clear the draft. |

**Auto** picks Sonnet for ordinary prompts and Opus for long or hard ones (architecture, refactors, debugging, security and similar, or phrases like "think hard"). A Sonnet run that errors or hits its turn limit is retried once on Opus, unless the error looks like an auth, billing or rate-limit problem. Ctrl+M opens the model picker. The choice is remembered per agent.

## Configuration

`config.json` in the data directory. Missing keys fall back to defaults.

| Key | Meaning |
|---|---|
| `port` | Local port. Default `4747`. |
| `authToken` | The MCP-client token (Claude Code, Cowork, curl): `/mcp`, state reads, start and cancel tasks, event stream. Generated for you; keep it private. It cannot approve or change settings; the per-launch admin secret that does is never stored. Tasks it starts run under an `ask` ceiling and cannot write working memory or trusted notes. |
| `workspaceDir` | Where agent working directories live. Default `<data dir>/workspaces`. |
| `claude.auth` | `claude-login` (default, your Claude Code account) or `api-key` (with `claude.apiKey`). |
| `claude.inheritClaudeCodeSettings` | Load your Claude Code user and project settings, hooks and CLAUDE.md. Default `true`. |
| `claude.inheritMcp` | Also load the MCP servers, plugins' MCP servers and claude.ai connectors from your Claude Code setup. Default `false`: a run gets Legion's own server and the servers listed in Settings -> MCP. |
| `claude.executablePath` | Path to your own `claude` binary. By default the one bundled with the SDK is used. |
| `claude.maxTurns` | Turn cap per run. Default `200` (a config still on the old default `40` moves to `200` once). A run that hits it pauses; **Continue** picks it up in the same conversation. |
| `boat.apiKey`, `boat.baseUrl` | boat.dev access. `BOAT_API_KEY` also works. |
| `features.projectBoard` | The project board. Default on; only the literal `false` turns it off (restart Legion). Not written by the app. See [docs/PROJECT-BOARD.md](docs/PROJECT-BOARD.md). |
| `mcpServers` | Extra MCP servers, in the same shape as Claude Code's `.mcp.json`. Agents pick them by name, or `*` for all. |

Environment variables: `LEGION_HOME` (data directory), `LEGION_PORT`, `LEGION_NODE` (Node binary for the app to use), `BOAT_API_KEY`.

The data directory holds `config.json`, `state.json`, `messages/`, `workspaces/<agent>/` and `core.log`.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` | Command palette |
| `Ctrl+N` | New task |
| `Ctrl+M` | Model picker |
| `Enter` / `Ctrl+Enter` | Send. While the agent works: queue / interrupt and send now |
| `Ctrl+,` | Open or close Settings |
| `Ctrl+.` | Toggle the Ops panel |
| `Alt+1` to `Alt+9` | Switch agent |
| `A` / `D` | Allow / Deny the focused approval |
| `Ctrl+Shift+M` | Open the mascot lab |

On macOS, use `Cmd` in place of `Ctrl`.

## The mascot

The Relic is a single hand-painted SVG, split into layers and animated by a small engine. It leans in while you type, thinks, hacks, waits for your approval, celebrates, winces at errors, and sleeps when nothing happens. You can try every expression in the [Expression Lab](docs/demo/relic-lab.html) (download it and open it in a browser, or use the in-app lab). Want to add your own character? The layer format is documented in the [mascot contract](docs/art/MASCOT_CONTRACT.md).

## Later

Not in v1, and not promised:

- **Codex, Ollama and other custom/local endpoints (0.2.1).** OpenRouter already ships in 0.2.0 — any model, with your own key.
- **BSV mode: the real-wallet checks, and anything beyond one payment.** The spend tool is built (testnet and mainnet, mainnet behind a hard-off switch) and tested against fakes; the owner's by-hand checks on a real wallet come next, and wallet reads (balances), a VM boundary for wallet tools and spends by anything other than a run you started are not built (see [docs/BSV-MODE.md](docs/BSV-MODE.md) and [docs/BSV-WALLET-DESIGN.md](docs/BSV-WALLET-DESIGN.md)).
- Signed installers and prebuilt releases. Today you install from source with `setup.cmd`.

## Development

```bash
npm ci
npm run typecheck   # TypeScript, core and UI
npm test            # the full suite, no network, no real Claude calls
npm run build       # core to dist/, UI to dist-ui/
npm start           # build and open the app
npm run core        # headless core only
npm run dev:ui      # Vite dev server for the UI on :5173
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Project layout

```
src/
  bin/        legion-core (entry point) and legion-mcp-stdio (MCP bridge)
  core/       engine, router, approvals, catalog, VM manager, boat.dev client, store, HTTP server, MCP tools
  electron/   main process and preload
  shared/     types, config, small helpers
ui/           Vite + React renderer, mascot engine, bundled fonts
  dev/        mock server and screenshot scripts
test/         node:test suites
scripts/      Windows installer, icon and mascot builders, MCP config printer
docs/         architecture, comms bridge, Lattice and Library, BSV mode, mascot art and contract, expression lab, README images
assets/       app icon, tray icons, splash
```

## Security

Legion binds to `127.0.0.1`, requires a bearer token on every request except `/health`, keeps a second, in-memory admin secret for approvals, settings, the Library inbox and BSV (so a bot that reads `config.json` cannot approve its own request), and never handles your Claude credentials. It does not stop a process running as your own user from attacking Legion's memory or files or calling your BSV wallet directly; only a VM or a separate OS account does. Agents can run code on your machine, so pick their approval modes deliberately, and use VMs for untrusted work. See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are tracked in the [changelog](CHANGELOG.md).

## Licence and credits

Legion is released under the [MIT License](LICENSE).

Design inspiration came from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0): bots as contacts, inline approval cards, and a computer panel with a live preview. No code was copied. Legion uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), and bundles IBM Plex Sans, JetBrains Mono and Grenze Gotisch under the SIL Open Font License 1.1. Full attribution is in [NOTICE](NOTICE).
