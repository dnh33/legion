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
