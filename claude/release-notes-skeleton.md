# Release notes skeleton (v1 / 0.1.x, version not decided)

Not final. `package.json` stays at 0.1.0 and `CHANGELOG.md` keeps its `[Unreleased]` heading until the other branches have landed their entries. When the owner picks the number: rename `[Unreleased]` to `[x.y.z] - date` in `CHANGELOG.md`, add a fresh empty `[Unreleased]` above it, bump `package.json` and `package-lock.json`, and paste the text below (trimmed) into the GitHub release.

Facts to re-check on the day (each can change while other branches merge): the entries listed, test count (Linux baseline was 1368 when this was drafted), Node requirement, whether MCP inheritance is off by default (decision recorded, work item A in the tracker), room budget default (work item R1), lazy key probe (K1), Builder VM size reset (U1).

---

## Legion <VERSION>

Legion is a local, Claude-only multi-agent desktop app: several Claude agents with their own personas and approval modes, groups of bots in rooms, a shared knowledge graph for memory, and an optional boat.dev VM for each agent. It runs on your machine and uses the Claude Code account you are signed in to. Claude Code and Cowork can drive it over MCP.

### Highlights
- <!-- fill from CHANGELOG [Unreleased] > Added: Muster of 13 bots, Rooms, Lattice and Library, message queue, copy menu, Markdown tables -->
- <!-- Blender Bridge (off by default) -->
- <!-- BSV mode: knowledge pack and a read-only wallet status check; no spend tool in this version -->
- <!-- Security: two secrets (MCP token vs per-launch admin secret), approval ceiling for MCP clients, bots cannot create rooms without a card -->
- <!-- VM fixes and usage display -->

### Install
Windows 10/11: unpack or clone the source, double-click `setup.cmd` (or `setup-yes.cmd` for no questions). Installs to `%LOCALAPPDATA%\Programs\Legion`, no admin rights. Needs Node.js 20.10+ and Claude Code signed in. macOS and Linux: dev install (`npm ci && npm start`). The installer is unsigned: expect SmartScreen or antivirus prompts.

### Known limits
- Claude only. Other providers (Codex, ChatGPT) are not supported and are listed under "Later".
- BSV mode has no spend tool and has not been checked against a real wallet. A testnet spend tool is planned.
- Blender and boat.dev flows were tested with stubs and recorded responses; real-system runs are listed in the tracker (items C, D, E).
- Same-user attacks are out of scope; see SECURITY.md "Known limits".
- Windows is the primary target; macOS and Linux are dev installs only.

### Upgrade notes
- <!-- Builder VM size resets to `default` (U1) -->
- <!-- Rooms made by bots have no spend limit unless you set one (R1) -->
- <!-- MCP inheritance default (A) -->

### Thanks and licences
Apache-2.0. Third-party attribution in NOTICE. Not affiliated with Anthropic or boat.dev.
