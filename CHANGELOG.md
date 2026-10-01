# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Muster of ten more premade bots** (Inquisitor, Scribe, Archivist, Sentinel, Forgemaster, Exorcist, Preceptor, Herald, Assayer, Sculptor), each with a hand-painted, animated bust and portrait that follows the mascot layer contract, a persona (quips and idle verbs) and a role prompt. Seeded after Zealot, Builder and Scout, which are never changed. The Relic stays byte-identical.
- **Rooms** (comms bridge): group chats of 2 to 6 bots plus you, bot-to-bot direct messages, mention / manager / round-robin / all strategies, and guards for hops, budget, cycles and `@everyone`, with freeze and resume. Tools `bot_list`, `bot_send`, `room_post`, `room_read`, `room_list` and `handoff`. Messages from a bot carry no approval: a woken bot never runs looser than the strictest sender on the chain.
- **Lattice** (knowledge graph): a shared, traversable graph with search, neighbours, paths, recall and lint, Markdown vault import and export, and `kg_*` tools for every bot, plus a graph view.
- **BSV Dev Kit mode** (off by default): reveals the Assayer and a BSV knowledge pack. Knowledge only; no wallet, keys or signing.
- Title-bar view tabs (Chat, Rooms, Library) as icons, so the search box keeps its position.
- **Library** (see [docs/LIBRARY.md](docs/LIBRARY.md)): the Lattice grows into long-term memory for the bots. `kg_capture` (decision, mistake, pattern, project, idea in fixed shapes with a duplicate warning), `kg_wm_set` (a private 2,500-character working memory), `kg_supersede` and `kg_merge`, a 1,200-character per-run briefing, ranked recall, a deterministic episode note after long tasks that saved nothing, a nightly lint pass, and a one-way mirror of the bots' notes into `<vault>/legion/`.
- **Library safety**: every note carries an engine-derived trust (human, agent, untrusted). A run that touches the web, a shell or an outside tool is tainted for the rest of the task: its writes are untrusted and wait for you. Bots cannot edit your notes (their change becomes a proposal), change scope or delete shared notes; per-task write quotas; secret redaction; safety copies of the log.
- **Library screens**: Inbox (accept, edit then accept, reject, before/after diff of proposals, bulk accept that skips untrusted sources unless you tick it, filter by bot), Activity (the last writes with a 7-day Undo that says why it is disabled), amber pending count on the title-bar tab, trust and status badges, and in-place editing of a note (title, type, tags, body) and of a link (relation, note) in the Lattice detail panel.
- `PATCH /api/kg/edges/:id` to change a link's relation, note or weight (human only).
- **BSV mode v1** (still knowledge only; see [docs/BSV-MODE.md](docs/BSV-MODE.md)): a truthful pack (pack version 2). Lessons about controls that do not exist yet (spend caps, approval broker, audit log and Freeze, native arming, the Legion-owned bsv tool, VM boundary) are marked `props.built:false`, start with "Design, not built in v0." and sit at confidence 0.6; the new `bsv-status-today` lesson says what BSV mode is today; the contradictory Update/Correction paragraphs are folded into their nodes; the new `bsv-wallet-choice` lesson records the wallet plan (BSV Desktop first, HandCash beta second, never a monthly limit or auto-pay, two-stage approval). `kg_recall` takes an optional `scope`, which also restricts the linked notes it pulls in. A pack upgrade that never overwrites human edits: the version is stored on the index node, every seeded node carries a `seedHash`, and the toggle (or **Load BSV pack**) adds missing nodes, updates untouched ones and reports `skippedEdited`. A tripwire test keeps wallet, key and network code out of `src/core/bsv` and every tool registration.


### Fixed

- The Assayer stayed reachable while BSV mode was off through `legion_run`, `legion_continue` and `legion_vm` (including `exec`), and the error text named it; the same lookup now refuses it as an unknown agent, and the HTTP routes that start a task or drive the VM of a hidden agent answer 404.
- A plain re-seed of the BSV pack (the Lattice button, or toggling BSV off and on) overwrote human edits of pack nodes, and a human note written to scope `bsv` first stopped the pack from ever loading.

### Changed

- The title-bar tab that opened the Lattice is now called Library and holds the Lattice, Inbox and Activity. The graph view itself is unchanged.
- The light-theme title-bar count badge uses white text (it was near-black on dark amber).
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
