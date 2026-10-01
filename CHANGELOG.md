# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Muster of ten more premade bots** (Inquisitor, Scribe, Archivist, Sentinel, Forgemaster, Exorcist, Preceptor, Herald, Assayer, Sculptor), each with a hand-painted, animated bust and portrait that follows the mascot layer contract, a persona (quips and idle verbs) and a role prompt. Seeded after Zealot, Builder and Scout, which are never changed. The Relic stays byte-identical.
- **Rooms** (comms bridge): group chats of 2 to 6 bots plus you, bot-to-bot direct messages, mention / manager / round-robin / all strategies, and guards for hops, budget, cycles and `@everyone`, with freeze and resume. Tools `bot_list`, `bot_send`, `room_post`, `room_read`, `room_list` and `handoff`. Messages from a bot carry no approval: a woken bot never runs looser than the strictest sender on the chain.
- **Lattice** (knowledge graph): a shared, traversable graph with search, neighbours, paths, recall and lint, Markdown vault import and export, and `kg_*` tools for every bot, plus a graph view.
- **BSV Dev Kit mode** (off by default): reveals the Assayer and a BSV knowledge pack. Knowledge only; no wallet, keys or signing.
- Title-bar view tabs (Chat, Rooms, Lattice) as icons, so the search box keeps its position.

### Changed

- `mcp__legion__ask` and `tell` now apply the same approval ceiling as rooms: an agent started through the bridge is never more permissive than its caller. Agents switched off (Assayer while BSV mode is off) are neither listed nor reachable through the bridge.

## [0.1.0] - 2026-09-30

First public release.

### Added

- **Legion Core**, a local Node service bound to `127.0.0.1` with a bearer-token HTTP API, a server-sent events stream and an MCP endpoint.
- **Electron desktop app** with a tray icon, single-instance lock, sandboxed renderer, dark and light themes, and bundled fonts.
- **Agents** built on the Claude Agent SDK, using the Claude Code account you are signed in to (or an API key). Three defaults (Zealot, Builder, Scout) plus custom agents with their own system prompt, model, approval mode and working directory. Claude Code settings, MCP servers and claude.ai connectors are inherited, and extra MCP servers can be added in `config.json`.
- **Auto model routing** between Sonnet and Opus, with a one-time escalation from Sonnet to Opus on failure, and forced models through `/model`, `/opus` and `/sonnet`.
- **Slash commands and a model picker.** Claude Code commands, skills and custom commands run through the agent; Legion adds `/new`, `/model`, `/vm`, `/doctor`, `/agent` and `/clear`. Commands and models come from a cached, model-call-free catalog probe.
- **Inline approvals** with `ask`, `auto-edits` and `full` modes, Allow/Deny cards and `A`/`D` shortcuts, and auto-deny after ten minutes.
- **On-demand boat.dev VMs per agent**: start, exec, file access, `vm_claude` (Claude Code inside the VM), desktop link, live screenshot preview, and automatic idle stop.
- **MCP orchestration** for Claude Code (HTTP) and Cowork or Claude Desktop (stdio bridge) with nine tools: `legion_list_agents`, `legion_models`, `legion_create_agent`, `legion_run`, `legion_continue`, `legion_status`, `legion_cancel`, `legion_vm` and `legion_recent_tasks`.
- **Doctor** checks for Node, config, Claude sign-in, boat.dev and the workspace.
- **The Relic**, a hand-painted animated mascot with nine expressions, plus the Expression Lab page and a mascot layer contract for adding others.
- **Windows installer** (`setup.cmd`) that installs per user under `%LOCALAPPDATA%\Programs\Legion`, with shortcuts, in-place updates and an uninstaller.
- Command palette, keyboard shortcuts, task history per agent, and cost and turn tracking.

[Unreleased]: https://github.com/OWNER/legion/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/legion/releases/tag/v0.1.0
