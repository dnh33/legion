# README truth audit, 0.2.5-g

Branch `release/0.2.5-g`. Every factual claim in `README.md` checked against the code. Line numbers are the README before this audit's edits. Verdicts: true / false / stale / unprovable (needs the owner's real PC, or code that is not in this tree).

**Open conflict (owner decides).** The brief and `CLAUDE.md` ("Decisions already made") say providers ship: OpenAI, OpenRouter, Ollama, LM Studio, vLLM, custom address. The code in this tree says otherwise: `ui/src/providers/ProvidersSection.tsx:85-86` hides the presets `openai`, `ollama`, `lmstudio`, `vllm` behind a disabled "Next release" block ("Not in this release", badge 0.2.1) unless one is already enabled, and teases Codex the same way (`:88-105`, `:130`, `:141`). They are `enabled: false` in `src/core/providers/presets.ts`. Shipped and usable: OpenRouter (enabled by default) and "Add a custom endpoint" (any OpenAI chat-completions server; https, or http on this computer; help text names vLLM and LM Studio). The earlier CHANGELOG ("Not in this version (0.2.1): ... Ollama, LM Studio ...") and the tracker ("providers = next release") agree with the code. README now follows the code. To make the claim "providers ship" true, remove `NEXT_RELEASE` in that UI file (and ship a release that does).

| # | Claim | README line | Evidence | Verdict | Fix |
|---|---|---|---|---|---|
| 1 | Header: Claude default, plus OpenRouter for any model | 5 | `presets.ts:10` (OpenRouter `enabled: true`) | true | none |
| 2 | Beta; Releases on GitHub; release install updates itself | 13, 15 | `gh release list`: v0.2.5-f latest; `src/core/updater/*` | true (updater on a real PC: check U1 still `todo`) | none; see owner list |
| 3 | Tests cover core, app, agents, rooms, Library, board, MCP, approvals, updater, installer | 16, 26 | `test/` (246 files; `installer-*`, `updater-surface`, `browser-*`) | true | none |
| 4 | Project board in daily use on the maintainer's PC; screen-reader/scale/crash checks open | 17 | owner statement; `claude/tracker-pc-checks.md` PB3, PB4, PB9 `todo` | true (already rewritten) | none |
| 5 | Browser tool built and tested; agents have not used it on a real PC; web search is Claude's own tool | 18 | `src/core/browser/*`, `test/browser-*`; owner evidence | true (owner-confirmed) | none |
| 6 | BSV mode tested against fake wallets only; mainnet built, OFF | 19 | `src/core/bsv/policy.ts:8` (`mainnetEnabled` false); `test/bsv-hedge.test.ts` pins it | true | none |
| 7 | Blender bridge not tried on real Blender/VM | 20 | `test/blender-hedge.test.ts:163` pins it; tracker B1-B17 `todo` | true | none |
| 8 | Installer not code-signed, not widely tested | 21 | `docs/UPDATES.md` "Unsigned build"; tracker P1-P10 `todo` | true | none |
| 9 | **Models: Claude + OpenRouter; "Codex and local endpoints are under Later"** | 22 | `ProvidersSection.tsx:67-82` (AddCustom works for local servers: https or this computer) | **stale** | Status line now names the custom address; presets and Codex are Later |
| 10 | Updates checked against the maintainer's signature | 29 | `src/core/updater/trust.ts`, `docs/UPDATES.md` | true | none |
| 11 | BSV: read-only status check + one spend tool, native dialogs, testnet and mainnet | 27 | `wallet-probe.ts:26` (4 methods), `spend.ts`, `admin-logic.ts:508-529` | true | none |
| 12 | "With OpenRouter, add your own key and run any model" | 30 | `presets.ts:10` | true, incomplete | added: custom address; provider agents lack Claude Code's file/shell/web tools (`runtime.ts:31-33`) |
| 13 | Several Claude agents from one desktop app; per-agent persona, model policy, approval mode, working directory | 36-37 | `AgentProfile` in `src/shared/types.ts`; `engine.ts:767` (cwd) | true | none |
| 14 | **Agent can start a cloud Ubuntu VM on boat.dev** | 39 | no "Ubuntu" anywhere in `src`, `docs` | **unprovable** | "Ubuntu" removed |
| 15 | Uses the Claude Code account you are signed in to: no extra logins or keys | 40 | `engine.ts:159-161` (login mode drops `ANTHROPIC_API_KEY`) | true for the default | none |
| 16 | Claude Code and Cowork can drive Legion over MCP | 41 | `mcp-tools.ts`, `legion-mcp-stdio.ts` | true | none |
| 17 | Node service on 127.0.0.1 + Electron window | 45 | `legion-core.ts:116`, `net-guard.ts` | true | none |
| 18 | Agents run through the official Claude Agent SDK; existing agents on a Claude model by default | 46 | `package.json` dependency; roster models `auto/sonnet/opus` | true | none |
| 19 | **OpenRouter second provider; "Codex and other local/custom endpoints come later"** | 47 | `ProvidersSection.tsx` (AddCustom ships) | **stale** | custom address added; presets + Codex come later |
| 20 | Zealot leads an Order of 13 agents; 13 ready-made | 62, 66, 168 | `store.ts:147-159` (zealot, builder, scout) + `roster.ts` (10) = 13 | true (computed) | none |
| 21 | Zealot splits requests, hands to best agent, runs independent ones at once | 67 | `lead.ts:2-22` | true | none |
| 22 | Agents `ask` (wait) and `tell` (reply later) | 68 | `agent-tools.ts:68-86` | true | none |
| 23 | Rooms: group chats of agents and you | 69 | `comms/hub.ts` | true | none |
| 24 | VM per agent on demand, live screen preview | 70 | `ComputerCard.tsx:38-47` (polls screenshot every 2.5 s) | true | none |
| 25 | Zealot edits kept, lead role on top; board leader in a project | 74 | `lead.ts:2-22` | true | none |
| 26 | Pair threads resume the same session; hop, rate, cycle guards | 75 | `bridge.ts:10-13` (MAX_HOP 6, RATE_LIMIT 30/10 min), `:253-257` (deadlock, depth), `:298` | true | none |
| 27 | Agents propose rooms/member changes; Allow card only you can answer | 76 | `hub.ts:644-661`, `admin.ts` | true | none |
| 28 | Idle VMs stop; "Open desktop" link; VM run time today; optional cost from hourly price | 77 | `AgentEditor.tsx:18` (15 min), `ComputerCard.tsx:88`, `Settings.tsx:317` | true | none |
| 29 | Projects with a work board; board doc | 83 | `src/core/projects/board`, `docs/PROJECT-BOARD.md` | true | none |
| 30 | Talk to a task while it works; message joins after current step | 84 | `Composer.tsx:41-103` (`canJoinRun`) | true | none |
| 31 | Live progress: turn, tool, time, context, Claude's checklist | 85 | `engine.ts:188` (`progress` fields incl. `todos`) | true | none |
| 32 | Continue at turn limit, after crash or restart | 86 | `src/shared/continue.ts`, `engine.ts:651-654` | true | none |
| 33 | Slash commands and model picker | 87 | `ui/src/commands.ts:9-19` | true | none |
| 34 | Board: members create, edit, move, claim, note; you mark done and approve deletes | 92 | `docs/PROJECT-BOARD.md` "What member agents may do now"; `tools.ts:125` | true | none |
| 35 | Provider models: Enter queues, Ctrl+Enter interrupts; stop/failure/reload pauses queue; per-thread drafts across restarts | 93 | `chat/queue.ts:1-30`, `chat/drafts.ts:18` (localStorage) | true | none |
| 36 | 200 turns default; Continue | 94 | `config.ts:DEFAULT_MAX_TURNS = 200` | true | none |
| 37 | Claude Code over HTTP; Cowork/Desktop over stdio bridge | 95 | `scripts/mcp-config.mjs:24-29` | true | none |
| 38 | Lattice + Library as long-term memory; Inbox accept/reject | 101, 108 | `docs/LIBRARY.md`, `kg/tools.ts` | true | none |
| 39 | House layer: rules every agent reads, plus project `AGENTS.md`; unapproved changed file labelled; approval lapses when text changes | 102, 109 | `house/context.ts:24`, `house/index.ts:105-123` | true | none |
| 40 | Compaction automatic and `/compact`; context readout is an estimate | 103, 110 | `commands.ts:46-52`, `engine.ts:468` | true | none |
| 41 | Claude Code settings/hooks/skills/commands partly inherited; MCP not loaded unless `claude.inheritMcp` | 104, 111 | `config.ts:187-192` (`inheritMcp: false`) | true | none |
| 42 | Approval cards; per agent `ask`/`auto-edits`/`full`; A or D | 117 | `ApprovalCard.tsx:44-45`, `approvals.ts` | true | none |
| 43 | Settings applied live: Claude sign-in, boat.dev key, MCP servers; boat key Test button | 118, 124 | `Settings.tsx:18-26`, `:366-` (Test) | true | none |
| 44 | Doctor checks Node, config, Claude sign-in (email, plan, no model call), boat.dev, workspace | 119, 125, 347 | `doctor.ts:58-117`, `:26-30` | true | none |
| 45 | One-click download, installed on restart | 120 | `UpdatePanel.tsx:89-99` | true | none |
| 46 | Auto model routing Sonnet/Opus by difficulty; or any model your account offers | 131 | `router.ts:24-47`, catalog | true | none |
| 47 | Optional spend limit per run (Settings, Claude); run pauses, work kept | 132 | `Settings.tsx:105-146` (0.05 to 1000) | true | none |
| 48 | Usage panel in title bar: today, 7, 30 days, by model and agent | 133 | `usage-summary.ts:15,36-37`, `UsagePopover.tsx:8-9,73` | true | none |
| 49 | Sonnet error: Opus takes over; not on auth/billing/rate-limit; running out of turns is not such an error | 137, 473-474 | `router.ts:16-19,50-56` | true | none |
| 50 | Usage figures are Claude's per-task costs | 138 | `usage-summary.ts` | true | none |
| 51 | BSV mode off by default; Assayer, knowledge pack, wallet status check, one spend tool | 144, 149 | `config.ts:195` (`bsv.enabled: false`) | true | none |
| 52 | Blender bridge off by default; Sculptor; headless Blender local by default, VM when not found, live after card showing whole script; downloads only on Set up | 145, 150 | `src/shared/blender.ts`, `docs/BLENDER.md` | true (real-PC checks open, stated in Status) | none |
| 53 | Relic mascot reacts to what agents do | 156 | `ui/src/mascot/useRelicState.ts` | true | none |
| 54 | Copy menu Markdown/plain text; tab-separated rows | 157, 162 | `CopyMenu.tsx` | true | none |
| 55 | Keyboard first, dark and light themes, tray icon, bundled fonts offline | 158 | `App.tsx:87-95`, `store.ts:44`, `main.ts:48`, `ui/src/fonts/` | true | none |
| 56 | Muster: 10 more agents with their roles; Archivist flags never deletes; Herald drafts only; Assayer hidden until BSV | 170-187 | `roster.ts:29-125` (prompts), `visibility.ts:14` | true | none |
| 57 | You see 12 until BSV mode is on | 172 | `visibility.ts` (only the Assayer has `requires: 'bsv'`) | true (computed) | none |
| 58 | Room: 2 to 6 agents plus you | 193 | `hub.ts:92,240` | true | none |
| 59 | Room guards: hops, budget, cycles, `@everyone`; freeze and resume | 194-195 | `hub.ts:164,331,341` | true | none |
| 60 | Four wake strategies: mention, manager, round-robin, all | 200 | `shared/comms.ts:16` | true | none |
| 61 | Room wake never gets more freedom than the waker | 201 | `hub.ts:124,152` (`stricterMode`) | true | none |
| 62 | Seed-phrase text refused | 202 | `hub.ts:993,1314` | true | none |
| 63 | Lattice: `kg_*` tools, graph view; no model calls or embeddings; vault import/export; trust level; web/shell notes wait in Inbox | 209-217 | `kg/tools.ts` (16 tools), `shared/kg.ts:22`, `docs/LIBRARY.md:50-60`; no "embedding" in `kg/` | true | none |
| 64 | BSV: off by default; switch in the title bar | 225 | `BsvChip.tsx`, `TitleBar.tsx:63` | true | none |
| 65 | `bsv_spend_request`; you confirm in native dialogs; wallet may ask too, depends on wallet | 227 | `spend.ts`, `admin-logic.ts:264,508-529` | true | none |
| 66 | Knowledge pack: 163 notes | 232 | `bsv.json` `nodes` = 163 (computed); `test/bsv-notes-count.test.ts:38` | true | none |
| 67 | **"An optional toggle in Settings"** (BSV) | 232 | no BSV control in `Settings.tsx`; only `BsvChip` in the title bar | **false** (also contradicted line 225) | "an optional switch in the title bar" |
| 68 | Wallet check: four harmless questions to an address you type | 232 | `wallet-probe.ts:26`, loopback-only `walletUrl` | true | none |
| 69 | Mainnet hard-off, per-spend Arm, extra dialog; tiny per-network caps; empty allowlist; unknown outcome blocks spends; holds no key | 232 | `policy.ts:8-20,40-42`, `networks.ts` | true | none |
| 70 | Assayer in `ask` mode: shell/edits need approval; web fetch and read-only tools run without prompt | 232 | `approvals.ts:8,98` | true | none |
| 71 | Never pointed at the funded wallet by Legion's own code | 28, 232 | `test/bsv-hedge.test.ts`; number forbidden in source | true | none |
| 72 | Uses Claude Code's account via official SDK | 238 | `engine.ts:159-161` | true | none |
| 73 | Legion independent, not affiliated | 241 | statement | true | none |
| 74 | Default `claude.auth: "claude-login"`; api-key option | 245 | `config.ts:187-188` | true | none |
| 75 | **"Legion never reads, copies or stores your Claude credentials"** | 246 | api-key mode: `config.ts:258-259`, `engine.ts:159` (key kept in `config.json`, read from `ANTHROPIC_API_KEY`) | **false as an absolute** | scoped to the default sign-in; api-key line says the key is kept in `config.json` |
| 76 | Requirements: Claude Code signed in (`claude`, `/login`); subscription or API key | 254 | `doctor.ts:14` fix text | true (whether the `claude` CLI itself is required: unprovable, owner) | none |
| 77 | Windows 10/11 primary; **macOS and Linux "work" from a dev install** | 255 | `.github/workflows/ci.yml` (windows + ubuntu, no macOS here); maintainer PC is Windows | **unprovable** | "run from a dev install"; Status line: dev install only, CI on Linux and Windows, maintainer uses Windows |
| 78 | Node 20.10+ for source install only; release brings own runtime; engines | 256 | `package.json` engines; `start-legion.cmd:5-8` | true | none |
| 79 | boat.dev account/key optional | 257 | `doctor.ts:90` | true | none |
| 80 | Source install downloads pinned Node LTS into the install folder, no admin, no PATH change; asks once | 261 | `scripts/lib/node-bootstrap.ps1:4-5`, `setup.ps1:22-23` | true | none |
| 81 | CI runs on Node 22 | 262 | `.github/workflows/ci.yml:29,46` | true | none |
| 82 | Release zip `legion-<version>-win-x64.zip`; `setup.cmd` checks hash, installs for your user; `start-legion.cmd`; taskbar pin | 270-274 | `build-package.mjs:2`, `setup.ps1:14,121-127`, `package-install.mjs:28-49`, `start-legion.cmd` | true | none |
| 83 | Install to `%LOCALAPPDATA%\Programs\Legion`, `-InstallDir`; Desktop and Start-menu shortcuts; no admin/Node/build | 282-283 | `setup.ps1:68-70,228-245` | true | none |
| 84 | `uninstall.cmd`; `/purge` deletes data after confirmation; data kept otherwise | 278, 284 | `setup.ps1:249-273`, `uninstall.ps1:45-58` | true | none |
| 85 | Source install: `-DryRun`, `-Yes`, `setup-yes.cmd`, asks before stopping Legion, stops by PID, refuses non-empty foreign folder | 290-305 | `setup.ps1:25-30,151-160,95-102`, `setup-yes.cmd` | true | none |
| 86 | `npm ci`, `npm start`, `npm run core` | 311-318 | `package.json` scripts | true | none |
| 87 | **Update: click "Update", then "Restart and install"** | 322 | `UpdatePanel.tsx:89` button reads "Download update"; `:99` "Restart and install" | **stale** | "Download update" |
| 88 | Checks on launch and on a schedule; off in Settings, About; git checkout only a notice; one request to github.com | 323-332 | `updater/config.ts:43` (12 h), `UpdatePanel.tsx:84,129`, `docs/UPDATES.md` | true | none |
| 89 | "Install updates automatically when idle" off by default; waits for idle; rollback; non-Windows/dep-changing release gets a notice | 329-333 | `config.ts:43`, `updater/index.ts:168,225`, `UpdatePanel.tsx:86` | true | none |
| 90 | `config.json` created on first launch in `%USERPROFILE%\.legion` or `~/.legion` | 345 | `config.ts:dataDir`, `loadConfig` | true | none |
| 91 | boat.dev setup: **put key in `config.json`, then restart Legion** | 355-357 | `Settings.tsx:366-` (key field and Test, applied live) | **stale** | step 2 now says Settings, boat.dev (VMs), Test; restart step removed; config/env stay as alternatives |
| 92 | `vm_claude` needs Claude connected on boat's Agents dashboard | 356 | `doctor.ts:104`, `Settings.tsx` Agents page link | true | none |
| 93 | VMs stop after 15 idle minutes by default, configurable | 359 | `roster.ts:22`, `AgentEditor.tsx:18,93` | true | none |
| 94 | **VM tools list** (7 tools) | 364 | `grep` of `src/core`: also `vm_usage` | **stale** | `vm_usage` added (8) |
| 95 | **`npm run mcp-config` prints snippets** | 370 | `scripts/mcp-config.mjs`; a release install has no npm: `scripts/legion-mcp-config.cmd` (`setup.ps1:285`) | **stale for release installs** | release-install command added |
| 96 | Claude Code HTTP command and stdio config; bridge starts core headless | 379-389 | `mcp-config.mjs:24-31`, `legion-mcp-stdio.ts:31-33`; package install uses its own Electron entry (`mcp-config.mjs:29`) | true; release note added | one sentence: use the printed snippet |
| 97 | MCP token: runs/reads agents, `ask` ceiling; cannot approve/accept/change settings/BSV policy except Freeze | 393-395 | `admin.ts:57-80`, `kg_wm_set` doc | true | none |
| 98 | `Ŧ LEGION · sworn · done` line | 396 | `mcp-tools.ts:65-72` | true | none |
| 99 | **MCP tool table (9 tools)** | 400-409 | `mcp-tools.ts` registers 10 (`legion_projects`), + `legion_board_read` (`projects/board/mcp.ts:18`) = 11; `legion_vm` also has `usage` | **stale** | rows for `legion_projects`, `legion_board_read`; `legion_vm` row mentions usage |
| 100 | "Legion in Claude Code (coming soon)": plan, names `dnh33/legion-mod`, `legion@legion`, `legion-runner`, `/legion` panel, desktop-only list | 414-445 | repo `dnh33/legion-mod` does not resolve (`gh`); plan in the mod worktree matches the names | unprovable here (explicitly labelled "not published"; plan can change) | none; see owner list |
| 101 | Slash command table (9 commands) and descriptions | 456-465 | `commands.ts:9-19`, `:46-52`, `:60-70` | true (computed: 9 = 9) | none |
| 102 | Auto picks Sonnet for ordinary, Opus for long or hard; hard = architecture, refactors etc., or "think hard" | 467, 472 | `router.ts:7-12,41-46` (long = 1800 chars; hard needs 2 keywords) | true | none |
| 103 | Ctrl+M opens model picker; remembered per agent | 468 | `App.tsx:91`, `store.ts:366-368` | true | none |
| 104 | Commands Legion does not handle go to Claude Code | 454 | `commands.ts:121-131` | true | none |
| 105 | Config keys and defaults: `port` 4747, `authToken`, `workspaceDir`, `claude.auth/inheritClaudeCodeSettings(true)/inheritMcp(false)/executablePath/maxTurns(200)`, `boat.apiKey/baseUrl`, `features.projectBoard` (only literal false), `mcpServers` | 482-494 | `config.ts:180-199,49-56`, `types.ts:249-254,324` | true (computed per key) | none |
| 106 | Env vars `LEGION_HOME`, `LEGION_PORT`, `LEGION_NODE`, `BOAT_API_KEY` | 496 | `config.ts:171,246-250`, `resolve-node.ts:11` | true | none |
| 107 | `authToken` serves MCP clients; admin secret never stored; MCP tasks under `ask`, cannot write working memory | 500 | `admin.ts`, `docs/LIBRARY.md:12` | true | none |
| 108 | `maxTurns` 40 to 200 migration once | 505 | `config.ts:CONFIG_MIGRATIONS` | true | none |
| 109 | `features.projectBoard`: restart; app does not write it | 506 | `docs/PROJECT-BOARD.md:11`, `legion-core.ts:94-95` | true | none |
| 110 | `mcpServers`: agents pick by name or `*` | 507 | `types.ts:45-46` | true | none |
| 111 | **"Settings -> MCP"** | 503 | nav label is "MCP servers" (`Settings.tsx:21`) | **stale (label)** | "Settings, MCP servers" |
| 112 | Data directory holds `config.json`, `state.json`, `messages/`, `workspaces/<agent>/`, `core.log` | 508 | `store.ts:59-60`, `engine.ts:767`, `legion-core.ts:33` (also `board/`, `providers/`, ...) | true, incomplete | "among other files" |
| 113 | Keyboard table: Ctrl+K, Ctrl+N, Ctrl+M, Enter/Ctrl+Enter, F1/F2/F3 (Chat/Rooms/Library), Ctrl+, , Ctrl+., Alt+1-9, A/D, Ctrl+Shift+M; Cmd on macOS | 514-527 | `App.tsx:77-95`, `viewKeys.ts:34`, `TitleBar.tsx:52,71`, `Composer.tsx:134` (11 shortcuts, all match) | true (computed) | none |
| 114 | Mascot: Expression Lab, in-app lab, three clicks or "Deus vult" | 531-533 | `docs/demo/relic-lab.html`, `CommandPalette.tsx:42`, `Takeover.tsx:6` | true | none |
| 115 | Mascot: one SVG in layers, small engine; states; contract doc | 537-540 | `docs/art/relic.layered.svg`, `ui/src/mascot/engine.js`, `docs/art/MASCOT_CONTRACT.md` | true | none |
| 116 | **Later: "Codex, Ollama and other custom/local endpoints"** | 548 | see conflict note above | **stale** | two bullets: presets (OpenAI, Ollama, LM Studio, vLLM) + Codex (reason as in `ProvidersSection.tsx:89`) |
| 117 | Later: BSV beyond one payment; code-signed installer | 549-550 | `docs/BSV-WALLET-DESIGN.md` | true | none |
| 118 | Development commands, `dev:ui` on :5173 | 562-569 | `package.json`, `ui/vite.config.ts:33` | true | none |
| 119 | Project layout block | 576-588 | `ls src ui test scripts docs assets` | true | none |
| 120 | Security: binds 127.0.0.1, bearer token on every request except `/health`; second secret in memory for approvals, settings, Inbox, BSV | 593-594 | `server.ts:440,478-512`, `admin.ts` | true | none |
| 121 | **"Legion never handles your Claude credentials"** (Security details) | 599 | as row 75 | **false as an absolute** | scoped to the default sign-in |
| 122 | Legion does not stop a same-user process from attacking memory/files or calling the BSV wallet | 601 | `SECURITY.md` | true | none |
| 123 | Licence Apache-2.0, NOTICE; OpenMausBot inspiration, no code copied; Claude Agent SDK + MCP SDK; fonts IBM Plex Sans, JetBrains Mono, Grenze Gotisch (OFL 1.1) | 611-619 | `LICENSE`, `NOTICE:8`, `ui/src/fonts/`, `licenses/` | true | none |

Claims checked: 123 rows (some rows hold several sub-claims; every sentence of the README was read).

**False or stale, fixed (13):** rows 9, 19, 67, 75, 77 (unprovable), 87, 91, 94, 95, 99, 111, 116, 121. Also dropped: the unprovable "Ubuntu" (row 14).

**Leak check (public-facing-copy):** no local paths, vault names, internal identifiers or pointers into `claude/` in `README.md`. "the maintainer's PC" and the `dnh33/legion-mod` names are public-safe. `OpenMausBot` is the Apache attribution in `NOTICE`, not the unnamed reference implementation.

## Needs the owner (could not decide here)

1. **Providers.** Conflict at the top. Either keep README as now (code truth) or change the UI so the presets are usable, then re-edit Status, What it is, Later.
2. **Updater on a real PC.** README says a release install "updates itself". `claude/tracker-pc-checks.md` U1 (update from 0.2.5-c) is still `todo`. If you updated a real install by the button, record U1 and nothing changes; if not, add one Status line.
3. **"Claude Code, signed in" as a requirement.** Doctor tells users to run `claude` and `/login`, but setup also mentions `scripts\legion-claude.cmd` ("Legion has Claude Code built in"). Whether the separate Claude Code CLI is needed is not provable from the code.
4. **macOS and Linux.** New Status line says dev install only, CI on Linux and Windows, maintainer uses Windows. Correct it if a Mac has been used.
5. **"Legion in Claude Code" section.** Describes the unpublished mod's plan; `dnh33/legion-mod` does not resolve. It says "Chat view and Order view" while the mod plan has five views. Left as is.
6. **`docs/PROJECT-BOARD.md` line 3** still says "Nothing here has run on Windows yet" (contradicts "in daily use"). Outside this task; not edited.
7. **CHANGELOG 0.2.5-g, two "Fixed" entries** (house-context file dates on macOS/Linux; Windows-style paths) describe code that exists only on `ci/green-mac-shards` (`src/core/house/sync.ts`, `context.ts`), not in this tree. True only after that branch merges first.
8. **CHANGELOG 0.2.5-g, first "Fixed" entry** states how BSV Desktop prompts for a spending grant. It comes from the peer session; no real-wallet check records it. Reword to a scoped line, or record a check, before release.
