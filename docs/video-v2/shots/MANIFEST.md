# Trailer v2 screenshots: manifest

All PNGs: real built UI (dist-ui), 1440x900 at 2x (2880x1800), dark theme, taken by `docs/video-v2/capture/capture.mjs`
against a REAL Legion core (scripts/harness/core-entry.mjs) with the scripted fake model, fake boat.dev, fake wallet and fake Blender.
Demo data is invented and was written through the core's real HTTP routes (admin headers; native header for project members and the wallet connect).
No UI was mocked or edited. Re-run: `PLAYWRIGHT_PATH=<playwright dir> node docs/video-v2/capture/capture.mjs` (after `npm run build:ts && npm run build:ui`; one shot: add its name).

| File | Route / state | Seeded how |
|---|---|---|
| app-approval.png | Chat, Forgemaster (`ask`), task tab "Run the tests and fix...", PENDING Bash card (Allow A / Deny D), Read/Grep/Bash chips. Rail shows 12 bots (the 13th, Assayer, only exists with BSV on). Computer panel: "No VM" placeholder (see below). | fake-model script: say, Read, Grep, say, Bash |
| app-approval-13bots.png | Same state with BSV mode on (title-bar BSV chip, TESTNET block strip); Assayer is the 13th bot in the rail (rail is scrolled; Assayer at the bottom edge). Extra, not requested. | second stack, BSV on + fake wallet |
| library-inbox.png | Library > Inbox, 2 pending: "Competitor pricing..." (Scout, PENDING, Untrusted, Tainted run) and "Warm the cache before a launch" (Archivist, PENDING, Agent). Ops panel hidden is NOT used here; right panel shows the Zealot bust. | real taint path: Scout script WebFetch then kg_capture; Archivist kg_capture (held) |
| library-lattice.png | Library > Lattice, 36 nodes / 41 links, "Retry only idempotent calls" selected with detail panel, fit to view, Ops panel closed. | 34 invented notes (decision/pattern/lesson/concept/mistake/idea) + 39 edges via POST /api/kg/nodes, /edges; 2 are project-scoped |
| library-project-note.png | Library detail of "Sessions last 8 hours on shared computers", scope chip reads "Private . project.proj_xxxx" (project scope `agent:project.<id>`). Chip text is slightly clipped at its right edge by the real UI. | POST /api/kg/nodes with the project scope |
| rooms.png | Rooms > "Launch review", 4 bots (Forgemaster, Scribe, Sentinel, Herald lead), 4-message transcript, hops 3/6. | room via POST /api/rooms, replies from scripted bots woken by an @mention |
| projects.png | Project page "Harbor web app": instructions, folder, 3 members, 3 done tasks, 1 room (bottom cards are cut by the viewport; the room card is below the fold). Folder path shows the temp dir `/tmp/legion-v2-capture-xxxx/...` (could not set a C:\Users\you path: needs an existing folder). | POST /api/projects, PUT members (native), 3 scripted tasks, room with projectId |
| bsv-status.png | BSV panel (title bar PANEL button), top: TESTNET, wallet answers testnet v1.2.3 block 1,234,567, 157 knowledge notes. | POST /api/bsv, POST /api/bsv/wallet/connect (native) to the fake wallet. Enabling BSV loads the bundled pack (157 notes) as the product does |
| bsv-spend.png | Same panel scrolled to "Requests from the Assayer" ("Nothing is waiting"), "Live funds (mainnet)" with mainnet OFF, Disarmed, Arm LIVE FUNDS (disabled), Freeze, start of Activity. Nothing armed, no spend created. | same |
| blender-chooser.png | Chat, Sculptor, blender_exec approval card with the one-time mode chooser ("Where should Blender scripts run? Asked once."), 8-line script, CLOUD VM badge. Not clicked. | POST /api/blender/config enabled; scripted blender_exec call |
| blender-get.png | Settings > Blender scrolled to "Blender for Legion". | bridge enabled via config |
| update-panel.png | Settings > About, cropped to the Updates panel. | none (core's own state) |
| settings-connections.png | Settings > Connections; token is masked by the UI ("Bearer ............"). | none |
| harness-output.txt | Real stdout of `scenarios core-task-run approval-card-flow mcp-token-limits --verbose` (trimmed to the PASS lines, 3 PASS with 10/12/27 checks. | not retyped; prose arrays dropped to fit the cap |

## Weak or not honest-in-full
- Computer panel (app-approval): the fake boat.dev cannot serve a desktop picture; with a started VM the panel shows a broken image, so the VM is not started and the panel says "No VM yet". No VM preview in any shot.
- blender-get: the core runs on Linux here, so the card honestly says "Only available on Windows in this version" and the Get button is disabled. The real Windows state (enabled button, size and version) is NOT captured.
- update-panel: dull. Says "Updates are off in this build: it has no update key built in. You are on v0.2.0. Not checked yet."; no update-available state exists in this tree.
- Cloud VM is the default in blender-chooser because the fake blender is not detected as a local install.
- Temp paths appear in projects.png (folder); update-panel is cropped to avoid them.
- Dropped: nothing. Board tab not attempted (not in the requested list).

## Update 2: BSV recapture and Project board shots

- bsv-status.png, bsv-spend.png: recaptured on this branch after merging integration/v1 (same framing); Knowledge notes now reads "163 BSV notes ... bundled pack: 163 notes (version 8)".

Board shots come from origin/claude/project-board (a78b362) built in a scratch git worktree (removed afterwards; this branch's src/ and ui/ untouched), real core with config `{"experimental":{"projectBoard":true}}` and nothing else, via `docs/video-v2/capture/board-capture.mjs` (run from a tree that has the board; set SHOTS_OUT). Project "Harbor web app", members Forgemaster, Scribe, Sentinel. Ops panel closed, same 1440x900 @2x dark. The project Folder card at the bottom shows the temp path (innocuous, not a real user path).

| File | What it shows | Seeded how |
|---|---|---|
| board.png | Board tab, 9 items: Backlog 2, Doing 2, Review 2, Done 2, Blocked 1; assignees Scribe/Sentinel/Forgemaster and "You"; labels; priorities; due dates (2026-10-14, 2026-10-09); three cards with the real "Not reviewed" badge. Board leader reads None. | owner items via POST /board/items; "Not reviewed" ones created by the agents through the real legion_board `create` tool (scripted model); assignees set by the owner (PATCH) |
| board-guards.png | Same header with Board leader = Sentinel and the note beside it: "Member agents can create, edit, move, assign and label items and add notes. Only the leader can ask to delete one, and you approve each delete. Only you mark an item Done." | PUT /board/leader |
| board-guards-dialog.png | Item dialog of an agent-written item. Exact text: "Written by an agent, not reviewed. Read the text below. Until you mark it reviewed, "Run this item" starts the run with the stricter "ask" approvals." Button: "Mark as reviewed". Activity: "Created by an agent whose run touched outside content". | as above |
| board-inbox.png | Inbox (2): "Add a FAQ page to the docs" (Scribe) and "Rotate the staging password" (Sentinel, suggested assignee Forgemaster), each "Suggested by X. Not reviewed. Its run had read outside content (web, shell or other tools), so treat the text with extra care.", Accept / Reject. | agents' real `propose` tool |
| project-memory.png | After moving "Draft the release notes" to Done in the UI: banner "'Draft the release notes' is done. Save what you learned as a project note, so the agents and later sessions have it?" with "Save what we learned" and "Not now". | the item's Move select (real UI action) |
| project-memory-item.png | Item dialog for "Add a health check endpoint": Project notes: "Health checks answer fast and say the version" (linked), button "Save what we learned...", Linked work, Activity "Linked a project note". | agent run: kg_capture scope "project" then board `update`; the board linked the note automatically at run end |
| board-digest.txt | The real `<legion-board-digest>` block (10 lines, unedited) from the system prompt of a Scribe project run, read from the fake model's log (a patched copy of the harness model records the system prompt). | engine's own preamble |

Could NOT capture: board-delete-approval.png. In this tree a run that calls any legion_board tool is marked as having touched outside content (mcp__legion_board__* is not on the Legion-tool list in src/core/approvals.ts, so engine taint treats it as an external tool). The delete tool then answers "Error: This run touched outside content (web, shell or external tools), so it may not delete items. Ask the owner." and no approval card is created; the same cause makes `create` with an assignee fail ("may not assign"), so the agents' items were assigned by the owner. Looks like a bug on the board branch, not a capture problem.
