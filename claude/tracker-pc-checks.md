# Checks that need the real Windows PC: INTAKE list (collected from reviewer reports)

**Master:** [`claude/real-pc-test-plan.md`](real-pc-test-plan.md) (machine twin `scripts/harness/pc-checks.json`, summary `node scripts/harness/pc-report.mjs <results.json>`). It holds every check with steps, expected observation, evidence, safety class, run order and rollback. Results are recorded there. This file stays as the **intake list**: any agent that finds something only a real PC can verify appends a numbered row here (rule in `CLAUDE.md`, "Real-PC checks"), and it is merged into the plan with its source at the next refresh. Never mark a feature verified in docs or the changelog until its plan check says `pass`.

Row format for new intake: `id | area | preconditions | exact steps | expected observation | evidence to capture | safety class (none, downloads, spends-money, native-dialog, real-wallet, real-funds, account) | source`.

## Where the old ids went (all of them are in the plan)

| Old id | Plan id | | Old id | Plan id |
|---|---|---|---|---|
| P1 | INST-01, INST-02 | | K1 | VM-01, VM-02 |
| P2 | INST-03 | | U1 | APP-09, VM-06 |
| P3 | INST-04 | | R1 | CHAT-01 |
| P4 | INST-05 | | Blender B1 | BLND-01 |
| P5 | INST-06 | | B2 / B3 / B4 / B5 | BLND-03 / 04 / 05 / 06 |
| P6 | INST-07, INST-16 | | B6 / B7 / B8 | BLND-07 / 08 / 09 |
| P7 | INST-08 | | B9 / B10 / B11 | BLND-12 / 13 / 19, 20 |
| P8 | INST-09 | | BSV V0 to V12 | BSVT-00 to BSVT-12 |
| P9 | INST-10 | | BSV R0 to R11 | BSVM-01 to BSVM-12 |
| P10 | INST-11 | | M1 / M2 / M3 | MCP-01 / 02 / 04 |
| handoff line (section 6.2/6.3) | APP-01 to 03, APP-10 to 12, MCP-07, VM-05, PERF-04 | | | |

Plan ids are written `PC-<AREA>-<nn>`. The tables below are the original intake text, unchanged. (The Blender rows B1 to B11 live only on `claude/review-blender-merged` so far; they are already in the plan.)

Source: `review/release-packaging-review.md` section 5 (branch `claude/review-release-packaging`) and `review/mcp-isolation-review.md`. Cloud reviewers ran Linux only; none of these is proven yet. Update the State column as each is run on this PC.

## Installer (release-packaging review, sec. 5)

| # | Check | State |
|---|---|---|
| P1 | Double-click `setup.cmd` and `setup-yes.cmd` on Windows 10/11 with Windows PowerShell 5.1: window stays open on success and on a forced failure (Node missing, `npm ci` fails) | todo |
| P2 | `setup.cmd < nul`, `echo \| setup.cmd` from cmd, and `cmd /c setup-yes.cmd` with no console (Task Scheduler): `IsInputRedirected` gives the same answer everywhere | todo |
| P3 | Setup with Legion running from (a) the install dir, (b) a source checkout on another drive, (c) an unrelated Electron app that has `src\electron\main.ts` (review F1), (d) VS Code and a `node` dev server open: only Legion's PIDs are listed and stopped | todo, after fix |
| P4 | Install to a path with spaces and non-ASCII (e.g. `C:\Users\Zoe Orsted\Legion Test`): `%~dp0` OEM code page, `uninstall.cmd`, shortcuts | todo |
| P5 | `-InstallDir C:\`, a non-empty foreign folder, and `%USERPROFILE%` with `-DryRun` first (review F2: robocopy /MIR) | todo, after fix |
| P6 | Uninstall: shortcuts pointing at another install are kept; Desktop (incl. OneDrive-redirected) and Start-menu entries go; `%USERPROFILE%\.legion` intact without `/purge` | todo |
| P7 | CRLF survives: downloaded ZIP and a `git clone` with `core.autocrlf=input` still give CRLF `.cmd`/`.ps1` (index stores LF) | todo |
| P8 | SmartScreen / antivirus behaviour on the unsigned `.cmd` files | todo |
| P9 | Fresh `npm ci` + `npm run build` on Windows, launch from the shortcut with the real Electron binary | todo |
| P10 | Setup run from inside a Legion agent (Bash tool) must not kill its own ancestor Legion (review F6) | todo, after fix |

## MCP isolation (mcp-isolation review)

| # | Check | State |
|---|---|---|
| M1 | Review F1: with `inheritMcp` off, does a project/user `.claude/settings.json` `env` block re-enable `ENABLE_CLAUDEAI_MCP_SERVERS`? Reviewer could not verify offline. Fix adds `settings.disableClaudeAiConnectors`; confirm on the real PC with real connectors that none connect (status panel + owner's connector server logs) | todo, after fix |
| M2 | With `inheritMcp` on and `claude mcp add legion http://127.0.0.1:4747/mcp` configured: self-server is switched off after init, no loop (review F6) | todo |
| M3 | The owner's broken `plugin:data:definite` server (ENDPOINT_NOT_FOUND) is the owner's Claude setup, not Legion: tell the owner | note |

## Rooms / key probe / upgrade (review still running)

| # | Check | State |
|---|---|---|
| K1 | Core start makes zero boat.dev calls with the real key; first VM use or opening Settings -> boat.dev runs the probe once | todo |
| U1 | Upgrade from v6-5 state on the PC: Builder resets to `default` once | todo |
| R1 | Room created by a bot with no budget: approval card says no spend limit, running cost visible | todo |

## Also still open from the handoff (section 6.2/6.3)

Real boat.dev checks, real Blender 5.x (official add-on is a Blender extension), tray/second-instance/title bar, Sentinel schedule firing, Forgemaster VM run, Cowork over MCP, approval-card flows end to end, BSV on a testnet wallet in a VM only, perf re-record.

## Blender local-first (plan 6.2 and 6.3). Record results here; when the local run (B1-B8) passes, add the line `BLENDER LOCAL PC RUN RECORDED` below and only then remove the "not yet tried" notes

Local mode, real Blender on this Windows PC (no downloads if Blender is installed):

| # | Check | State |
|---|---|---|
| B1 | `blender.exe --version`; Settings, Blender: detection finds it and mode Automatic says "Next script runs: on this computer" | todo |
| B2 | Cube plus GLB: approve the card; `<workspace>\blender-exports\<task>\*.glb` exists; `scene.blend` and `backups\` exist under `%APPDATA%\legion\blender\local\<task>\`. Repeat for FBX and a PNG preview (`blender_screenshot`). This is the check that the Python write guard does not break the exporters; if one is blocked, add its temp location to the guard's allowlist and record why (or set `advanced.local.guard` to `log` and say so in the docs) | todo |
| B3 | Through the real runner with a hand-written script (below the static check): a write outside the task folder is blocked; an infinite loop is stopped at 120 s and `blender.exe` and its children are gone from Task Manager | todo |
| B4 | A hand-written script that lists `os.environ`: no Legion or API variables | todo |
| B5 | With the community add-on installed and `blendermcp_auto_start_server` on, a local run opens no socket on 9876 (`netstat`) | todo |
| B6 | Path cases: user name with a space; long task path; OneDrive-redirected `Documents` as the workspace | todo |
| B7 | Mode switch: VM and Live give the errors from the decision table in `docs/BLENDER.md`; a config file with `"sandbox":"off"` loads as live | todo |
| B8 | Antivirus or SmartScreen prompts on the first start of the runner: note them | todo |

Needs the owner present (downloads or accounts):

| # | Check | State |
|---|---|---|
| B9 | **TODO OWNER PC:** reproduce the community add-on pin. PowerShell: `curl.exe -sSL https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py -o addon.py; (Get-FileHash addon.py -Algorithm SHA256).Hash.ToLower()` must print `eb0facf6...97fa5` (full value `eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5`). If it differs, take the PC's value and re-check `git log -1 -- addon.py` on a clone. Then run Set up for the community add-on once | todo |
| B10 | **TODO OWNER PC:** official extension install on a real Blender 5.1+ (needs `uv`): Set up runs `ext-build`, `ext-repo`, `ext-install`, `verify`; confirm the repo id from `repo-list`, that `--enable` persists, that `install-file` accepts the built zip, and the output formats of `repo-list` and `list`; then start the server from the sidebar panel and press Test connection (the first start downloads the server's Python packages) | todo |
| B11 | **TODO OWNER PC:** VM mode regression after the `exports.ts` refactor (needs the boat.dev key; item C covers the VM checks) | todo |

B4/B5 (managed Blender, chooser). Downloads: the owner present and a go for each.

| # | Check | State |
|---|---|---|
| B12 | **TODO OWNER PC:** reproduce the managed pin. `Invoke-WebRequest https://download.blender.org/release/Blender5.2/blender-5.2.2.sha256` and the line for `blender-5.2.2-windows-x64.zip` must read `3849d17a682cba006075aaa3f3597ecb5c9c30ec31035b2e092c53e40679b535` (given by the owner; not reproduced by an agent). Also confirm the zip address in `MANAGED_BLENDER.url` answers (HTTP 200) and the file's top folder is `blender-5.2.2-windows-x64` | todo |
| B13 | Settings, Blender, Get Blender for Legion: the approval card appears in Settings and in the Sculptor's chat; Deny fetches nothing (check the folder `%APPDATA%\legion\blender\app` does not exist yet); Allow downloads about 386 MB, unpacks (note the time and peak memory), `blender.exe --version` from `%APPDATA%\legion\blender\app\5.2.2\blender-5.2.2-windows-x64\` prints 5.2.2, and Settings shows it installed. Note any antivirus or SmartScreen prompt on the unpacked files | todo |
| B14 | With the managed copy installed: detection lists it first, "Next script runs: on this computer (Blender 5.2.2)", and a cube plus GLB export runs through the headless runner (this repeats B2 on the managed build). A normal install is still listed and untouched | todo |
| B15 | Negative: with a deliberately wrong hash (a scratch edit of `blender.advanced.managed.sha256` is not enough while the constant is set, so use a scratch build or a fake file server) nothing is unpacked and no `managed.json` appears. Also delete the folder by hand and confirm Settings goes back to "not installed" | todo |
| B16 | First-use chooser: a fresh data dir with the bridge on shows the chooser on the first Blender card; picking "This computer" saves `mode` and `modeAsked` in `config.json` and the chooser is gone on the next card; the Sculptor, asked in chat, names the place it chose and why | todo |
| B17 | **Title-bar Blender pill, real app on Windows.** Look at the pill (cube, dot, "Blender") with the bridge off (grey hollow dot), on with Blender installed (green dot; the popover says Ready: this computer plus the version) and with Blender missing (red dot; the popover button says Get Blender, opens Settings, Blender and downloads nothing). It must look like the Doctor button next to it, with no colour of its own. Open the popover: Tab reaches the pill, Enter/Space opens it, Escape closes it and returns the focus to the pill. In the popover press the switch while off: the dialog "Turn on Blender?" opens, Cancel has the focus (Enter cancels), Escape and the X cancel and leave Blender off; "Turn on Blender" turns it on. Do the same from Settings, Blender (the checkbox must show the same dialog and stay unchecked after Cancel). Turning it off from either place asks nothing. Both themes. Resize to 960, 1000, 1280 and 1440: nothing wraps or overlaps, below 1280 only the cube and dot remain. Stop the core: the dot is grey and the popover says Blender: unknown with the switch locked. Narrator reads the pill with its status and the switch as "Turn on the Blender bridge, switch, on/off". | todo |

- Extension verify (setup.ts `extensionListed`): the real `extension list` layout is not known. The step now needs the entry line to start with the id, show the exact version and an `enabled` marker (same line or indented lines under it). Check on the PC with Blender 5.1+ that a real list passes; if the layout differs, adjust the parser, do not loosen it to "the word appears".


## Loopback-only guard (claude/plan-loopback.md). Safety class: none unless noted

| # | Check | State |
|---|---|---|
| LB1 | Start the installed app: the window loads, tasks list, the event stream (live updates) works. If the window shows 403/421 errors, capture the core log and DevTools network tab (what `Origin` and `User-Agent` the window sends: `null` or `file://`, and whether the UA contains `Electron/`). | todo |
| LB2 | Windows Firewall: first start of the core must NOT show an "allow access" prompt (it listens on 127.0.0.1 only). Note any prompt. | todo |
| LB3 | `netstat -ano \| findstr :4747` shows only `127.0.0.1:4747` LISTENING (no `0.0.0.0`, no `[::]`). | todo |
| LB4 | From another computer on the LAN: `curl http://<pc-lan-ip>:4747/health` cannot connect. | todo |
| LB5 | Owner's own tunnel test (ngrok/cloudflared to 4747, **owner present, a tunnel is outbound exposure; delete it after**): `curl https://<tunnel-host>/health` must answer 421, not 200, and with the real token also 421. | todo |
| LB6 | Claude Code / Cowork through the MCP stdio proxy still lists Legion tools; `curl -H "Authorization: Bearer <token>" http://127.0.0.1:4747/api/state` still works. | todo |

## V0 result (2026-10-02 night, orchestrator by hand, owner's BSV Desktop at 127.0.0.1:3321, read-only, scratch script outside the repo)
POST /getVersion -> 200 {"version":"wallet-brc100-1.0.0"} (78 ms); /getNetwork -> {"network":"mainnet"} (8 ms); /isAuthenticated -> {"authenticated":true} (5 ms); /getHeight -> {"height":969369} (470 ms). No permission prompt appeared (the owner was present). Content-Type of every reply is text/html; charset=utf-8 although the body is JSON (Legion's probe does not check the content type: OK, keep it that way). FINDINGS: (F-W1) the real version string is NOT semver: readVersion() in src/core/bsv/wallet-probe.ts returns null for it (SEMVER_RE), so Legion shows the version as unknown; reachable stays true; harmless but wrong: accept a short safe token like [a-z0-9-]+-\d+\.\d+\.\d+ or show the clipped raw string (fix in T5-owned file wallet-probe.ts, tests included). (F-W2) the real network string is "mainnet": readNetwork maps it to main, correct. The owner's wallet is MAINNET, so a testnet spend cannot be tested against it; the network-mismatch refusal can.
B17 (both backends at once). Area: Blender both-backends mode. Safety class: downloads (the asset card, owner present) and none for the rest. Preconditions: a real Blender 5.1 or newer on the PC, the official add-on installed (Set up) and the community add-on installed (Set up with the community backend), `uv` on PATH, the bridge on, "Use both backends at once" switched on, Poly Haven switched on for the download step.

| # | Check | State |
|---|---|---|
| B17a | Press Launch in both mode: it refuses with a plain message if port 9876 or 9877 is already taken (start any listener on 9877 first to see it); with both free Blender starts. Note whether the official add-on picked up `BLENDER_MCP_PORT` (otherwise set its port in its sidebar panel to 9876) and whether the community server started on 9877 (`netstat -ano` shows two different listening ports for blender.exe) | todo |
| B17b | Test connection: both sides report ok; then stop the community server and see "Nothing is listening on port 9877" and that blender_exec still works; start a stand-in program on 9877 (any listener that is not the add-on) and see the fail-closed "does not answer like the community add-on" message | todo |
| B17c | The merged list: ask the Sculptor for `blender_tools`; every entry is `official:` or `community:`; try `community:node_type` with `ShaderNodeBsdfPrincipled`, `community:api_lookup` (it should be hidden if the official server has `search_api_docs`), `official:` extras that exist. Record which community extras were hidden and which official read-only tools appeared | todo |
| B17d | A code run through the MAIN: a cube script gets the usual card (badge LIVE), runs through the official server, and the community add-on's log shows no `execute_code`. Then with the switch off (one backend at a time) a run through the community backend alone (the old behaviour) still works, so both code paths are exercised | todo |
| B17e | **Downloads, owner present:** switch Poly Haven on, `blender_asset_search` for "crate" or an HDRI, then `blender_asset_get` for one small 1k HDRI: a card names the files, size and host; Deny fetches nothing (check `%APPDATA%\legion\blender\assets` is empty); Allow downloads into `%APPDATA%\legion\blender\assets\<task>\<id>\` with `manifest.json`, the world lighting changes in Blender, the run counts as tainted. Confirm the real file host (expected `dl.polyhaven.org`; record it) and that the md5 values match. Repeat once with a 1k model (glTF) and check textures load | todo |
| B17f | Poly Haven switched OFF: `blender_asset_get` is refused before any listing; Sketchfab and Hyper3D show "Not available" in Settings and cannot be switched on | todo |

## Project board (claude/plan-project-board.md; in v0.2.0, on by default). Safety class: none (no spend, no download)

Full steps in `claude/tracker-pc-checks-board.md`. Preconditions: a project with two member agents (nothing to switch on).

| # | Check | State |
|---|---|---|
| PB1 | The board is there by default; `features.projectBoard: false` removes it (no tab, `GET /api/board` is 404); the text `"false"` leaves it on. Evidence: screenshots. | todo |
| PB2 | Create, edit, drag and keyboard-move (Alt+arrows) items; restart Legion; the board is unchanged. Evidence: screenshot before/after. | todo |
| PB3 | NVDA or Narrator: a card is read with title, status, assignee, priority; the move is announced. Evidence: the screen reader's spoken text. | todo |
| PB4 | Window at 960 px and at 150% display scale: no sideways scroll, targets usable. Evidence: screenshots. | todo |
| PB5 | Run this item (owner-written text): normal approval cards; item goes Doing then Review with the result linked, never Done. | todo |
| PB6 | Agent-written item: run shows the limited (ask) approvals; Mark as reviewed lifts them. | todo |
| PB7 | Agents create/claim/move/note items; leader delete shows an approval card; Deny and Allow behave. | todo |
| PB8 | Save what we learned: banner on Done, draft, saved note found by a run in this project, not by another project. | todo |
| PB9 | Compaction and crash: add/delete ~300 items; kill the core by PID during a write; restart: board loads, no `.tmp` left, antivirus on. | todo |
| PB10 | Downgrade: an older build ignores `board\`; upgrade again: items are back. | todo |
## BSV spend tool (T2, branch `claude/bsv-t2-spend`): owner-only wallet checks. Nothing here was run: the build used fakes only
Each assumption A1..A12 of `claude/plan-bsv-rung3.md` section 15 is a named failing-closed check in `src/core/bsv/spend.ts`; the row that proves it on a real wallet is below. If a real wallet contradicts one, the spend path refuses (fails closed) and the owner is told; release is gated on these rows, not on the build. Plan ids in `claude/real-pc-test-plan.md`: V = BSVT, R = BSVM.

### V1 to V12: a SEPARATE TESTNET wallet (BSV Desktop switched to its testnet database, or a VM), owner present. Never the funded mainnet wallet
Setup V0: the wallet app in testnet mode with testnet coins from a faucet; Legion built from the reviewed commit; confirm in Legion's BSV panel that the wallet claims a TESTNET network before anything else.

| # | Owner action | Expected observation | Assumption it proves | State |
|---|---|---|---|---|
| V1 | By hand (no Legion code): ask the wallet for an unsigned transaction (`createAction` with `options.signAndProcess:false`, one P2PKH output to a second testnet address of the wallet itself); save a scrubbed copy of the answer | `signableTransaction {tx, reference}` and NO txid; no wallet prompt; nothing broadcast. Note: encoding of `tx` (byte array or hex), whether the parent transactions are inside the BEEF, number and kind of extra outputs (change) | A1 A2 A3 A4 | todo |
| V2 | By hand: `abortAction` with that `reference` | `{aborted:true}`; the locked coins are spendable again; a second `abortAction` with the same reference fails cleanly | A5 | todo |
| V3 | Connect to the wallet in Legion, run `bsv_status` | testnet, reachable, signed in; the version string is shown as the wallet says it when it is semver or a short token followed by semver (the real BSV Desktop says `wallet-brc100-1.0.0`; F-W1 is fixed in `readVersion`, tests with the real string and hostile ones in `test/bsv-wallet-probe.test.ts`); anything longer or with other characters shows as unknown | A9 A12 | todo |
| V4 | Panel: put one testnet address (the wallet's second address) on the TESTNET allowlist | native dialog; list saved | | todo |
| V5 | Assayer asks for 600 sat to that address | card: 600 sat, FULL address, TESTNET, fee, caps; second dialog (untrusted content) because `bsv_status` taints the run; a wallet built on wallet-toolbox may instead ask for a spending grant BEFORE the card, while it builds (record which, and the grant choices it offers; pick one-time if offered, else a limit no higher than Legion's caps); any prompt after the dialogs is recorded too; a txid comes back; open it in a testnet explorer (Legion does not check it) | A6 A7 A10 A11 | todo |
| V6 | A second request right after | record whether the wallet asks AGAIN. Expected for wallet-toolbox wallets (revised 2026-10-06): no prompt inside a grant you gave; a prompt again only after a one-time grant. Legion's dialogs appear either way | A6 (revised) | todo |
| V7 | Cancel at Legion's dialog | no wallet prompt; reservation freed; the wallet's coins are not locked (abort worked); a following request for the same amount works | A5 | todo |
| V8 | Decline in the WALLET's prompt | record exactly what the wallet sends back (HTTP status, JSON `code`); Legion shows `unknown` (expected) until a reviewed mapping exists; resolve it natively ("it was NOT sent") | A8 | todo |
| V9 | Kill the wallet during its prompt, then restart Legion | `unknown`; after the restart still blocked and frozen; resolve natively, unfreeze; spends work again | A8 | todo |
| V10 | Request 1,001 sat; request a non-allowlisted address | denied before any dialog; the wallet is not asked to build anything | | todo |
| V11 | Freeze while the card dialog is open | the dialog answer is refused; no wallet prompt | | todo |
| V12 | Hand-edit `bsv.walletUrl` in `config.json`, restart | not used; the panel asks for Connect | | todo |

Also record: the wallet prompt's wording (for the docs), whether a "remember / always allow" option appears (must be declined; if it cannot be avoided, that is a blocker), whether the wallet adds more than one change output, and the fee level it chooses (sets the mainnet fee ceiling, A11).

### R0 to R11: the owner's real-funds check, BY HAND, tiny amounts, owner at the keyboard. Never scripted, never by an agent
Preconditions: V1..V12 passed; independent review of the spend module, per-network policy and the dialogs signed off; Legion built from the reviewed commit; a second mainnet address of the owner's OWN (so the net cost is the fee). Amount 200 sat, mainnet caps at defaults. Until R0..R11 are recorded every document says "has not been verified with real funds".

| # | Owner action | Expected observation | State |
|---|---|---|---|
| R0 | Note the wallet balance and history; open Legion's BSV panel | Mainnet switch OFF, not armed | todo |
| R1 | Connect to the real wallet; ask the Assayer for 200 sat | Denied `mainnet-disabled`; NO wallet prompt; audit `denied` with `net` main; the wallet's call log shows only the four read-only questions | todo |
| R2 | Enable mainnet, read the dialog, confirm | Panel: enabled, not armed | todo |
| R3 | Allowlist the own address on the MAINNET list; ask again | Denied `not-armed`; no wallet prompt | todo |
| R4 | Arm 5 minutes (read the dialog); ask again | The wallet may ask for a spending grant first, while it builds (wallet-toolbox): one-time if offered, else no higher than the mainnet caps; never a larger monthly amount. Then D1 then D2 (D3 if tainted); compare amount, network word, FULL address (character by character against the wallet) and caps with this table | todo |
| R5 | Press Cancel on D2 | `declined`; no wallet prompt; reservation freed; still armed | todo |
| R6 | Ask again, confirm D1 and D2 | Record what the wallet asks and when (a grant prompt at build time, a prompt after D2, or nothing because a grant covers it). Whatever it shows must say 200 sat, the recipient and ONE payment output; approve there only if all match | todo |
| R7 | Read the result | txid returned; check it in a mainnet explorer in a browser (Legion does not): one 200 sat output to the own address plus change; the balance fell by the fee only | todo |
| R8 | Ask once more | Denied `not-armed` (one arm, one spend); no wallet prompt | todo |
| R9 | Arm, ask, confirm D1 and D2, then Decline in the WALLET | Legion shows `unknown`; the switch is off (auto-off); read the wallet history and resolve natively ("NOT sent") | todo |
| R10 | Enable, arm, ask; Freeze while D1 is open | Dialog answer refused; no wallet prompt | todo |
| R11 | Disable mainnet, Disarm, Disconnect | Panel shows off; read the audit lines for R1..R10 and record dated results here | todo |

ABORT at once (Freeze, Disable mainnet, no retry, record) if: a dialog differs from the table in amount, network word or one character of the address; a wallet prompt other than a spending-grant request comes before D1 and D2 are answered, a grant request asks for more than the mainnet caps with no smaller choice (decline it), a wallet prompt shows another amount or recipient or more than one payment output, or the wallet asked nothing at all for the FIRST mainnet spend (no grant prompt and no signing prompt: U13, Legion's dialogs would be the only gate); the fee shown exceeds 100 sat; Legion returns any status other than the expected one; a second prompt appears; the txid is not 64 hex or the explorer shows anything unexpected. After an abort read the wallet history before anything else.

## 2026-10-06: what each wallet asks, and when (BRC-100 leaves it to the wallet). Safety class: real wallet, testnet only (a throwaway testnet wallet in a VM; never the funded wallet)
Why: BRC-100 does not say how a wallet identifies a local app outside a browser (`legion.local` is self-declared), so whether a wallet asks at `createAction` or `signAction` depends on the wallet. wallet-toolbox master (`src/WalletPermissionsManager.ts`) asks at `createAction` for a spending grant per originator, then not again inside it, and never at `signAction`. Owner decision 2026-10-06: Legion's dialogs are the per-spend gate; the wallet's grant is a second check. Repeat W1-W5 for every wallet Legion lists (BSV Desktop first; the HandCash BRC wallet if it really answers on 3321).

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| W1 | Fresh testnet wallet, no grant for `legion.local`; one 600 sat request through Legion | Record: does the wallet ask while it builds (before Legion's card), after the last Legion dialog, or never; the exact prompt text; the grant choices (one-time? an amount? per month?) | screenshots of each prompt in order, the audit lines | todo |
| W2 | After a one-time grant (if offered), a second request | the wallet asks again | screenshot | todo |
| W3 | Leave the wallet's grant prompt open for 40 s, then decline it | Legion reports `build-failed` after 30 s; after the decline, the wallet's coins are not left locked (check the spendable balance); record what the wallet does if you approve it late instead | panel text, the wallet's balance before and after | todo |
| W4 | Grant a small amount (no higher than Legion's testnet caps), then two requests inside it | record whether the wallet asks at all for the second one (expected: no); Legion's dialog still appears | screenshots | todo |
| W5 | In the wallet's own settings: find the switch for spending checks (BSV Desktop: `seekSpendingPermissions`, Settings) and any list of granted apps; revoke the `legion.local` grant | record the default (BSV Desktop master: on) and that revoking works | screenshots | todo |

## BSV native dialogs and panel (T3 second pass; claude/plan-bsv-rung3.md section 15). Safety class: funds-adjacent (no spend is made by these checks; use the harness or a throwaway testnet setup, never the funded wallet, until the real-funds checks R0-R11)

| # | Check | State |
|---|---|---|
| ND1 | Any Legion BSV dialog (Arm, Allow mainnet, D1): press Escape. The request is denied (nothing changes, audit shows a denial). Repeat by closing the dialog with the window X. (T3-A1) | todo |
| ND2 | D2 ("Last Legion check before your wallet"): press Escape, press the X, and press Enter without moving: each is Cancel and denies. (T3-A1, T3-A2) | todo |
| ND3 | Button positions as built: D1 and Arm and Allow mainnet show `Cancel` on the LEFT and the confirm on the right, with Cancel focused. D2 shows the confirm button (`Send N sat to ...XXXXXXXX`) FIRST and `Cancel` LAST with Cancel focused. Note on a screenshot if Windows reorders them (command-link style must be absent: `noLink`). (T3-A2) | todo |
| ND4 | Full recipient address shown on its own line in D1 and D2, never abbreviated; the last 8 characters on the D2 button match the end of the address; the text is readable at 125% and 150% display scaling and is not cut off. | todo |
| ND5 | Panel, mainnet OFF by default on a fresh data folder: badge says TESTNET, the Arm button is disabled, `Allow mainnet...` opens the LIVE FUNDS dialog (Cancel default); Cancel leaves it off; confirming turns it on and the badge says `MAINNET ON, not armed`; `Switch mainnet off` acts with no dialog. (T3-A8) | todo |
| ND6 | Arm dialog: wording says ONE mainnet spend, shows the mainnet limits, 5 minutes preselected; after arming the countdown runs and the badge says MAINNET ARMED; Disarm and Freeze work at once; the audit log shows `armed`. | todo |
| ND7 | With a stand-in spend card (harness fake core) on mainnet: D1, then D2, then (tainted run) D3, in that order, one at a time; Cancel at each denies and the amber state stays only while armed. | todo |
| ND8 | Per-network limits and recipient lists: change a testnet cap, then a mainnet cap; the dialog names the network; the panel shows the change on THAT network only and the other network's numbers are unchanged. (T3-A3, T3-A4) | todo |
| ND9 | Mainnet allowlist: a testnet address and a bad-checksum address are refused before any dialog; a valid mainnet address (full, never abbreviated) is shown in the dialog. (T3-A6) | todo |
| ND10 | Real core with T2 merged, fake or throwaway-testnet wallet only: a spend request shows the dialogs. Record whether the wallet asks for a grant while it builds (before the dialogs) or after the last one. If the wallet asks nothing at all for the first spend, stop: that is the U13 abort. (T3-A5, T3-A7) | todo |
| ND11 | Title bar note count (owner's real graph; read it, change nothing): with BSV mode on the bar shows `<n> BSV notes`, with `(pack 163)` when n differs; the panel's Knowledge notes section gives the line `bundled pack: 163 notes (version 8); in your graph: n; removed or merged by you or a bot: a; added by you: b; missing: c`. Check a, b, c against what you remember doing (deleting, merging, adding notes). Turn the core off or block it: the bar must say `BSV notes: unknown`, never 0. If `missing` is above 0, press `Restore N missing bundled notes` and confirm the number rises by N and edited notes keep your text. | todo |
| ND12 | **Docs against the running app** (owner, no spend, nothing is sent): open `docs/BSV-MODE.md`, section Spend, and read it next to the app. For each line, say true, false or cannot tell. (a) The input fields, the status words and the reason codes match what the Assayer's tool answers (ask for a request with a `network` field in it: it must be denied `extra-input`). (b) D1, D2 (mainnet only), D3 and Resolve: the title, the buttons, which one is the default, Escape and closing the box, and the order D1, D2, D3 are what the section says. (c) The limits table: open the panel's limits and allowlists and compare every default (testnet 1,000 / 5,000 / 10,000 sat, fee ceiling 200; mainnet 1,000 / 2,000 / 5,000 sat, fee ceiling 100; both allowlists empty on a fresh data folder). (d) Mainnet is OFF on a fresh data folder; Arm is refused while it is off. (e) The panel never shows an amount, address or fee for a spend (only the native dialogs do). (f) The title bar and Knowledge section say `163` and `version 8`. (g) The "Not verified" list: every item is still unrecorded here until its V, R or ND row above says otherwise. (h) The real-wallet box (`wallet-brc100-1.0.0`, `mainnet`, JSON labelled `text/html`, no prompt for the four read-only methods) matches the Connect result on your own wallet (read-only, same as V0). Any sentence that is false: write it down and tell the reviewer; do not edit the docs to match the app without saying so. When R0 to R11 are all recorded as passed, add one line `BSV REAL-FUNDS CHECK RECORDED` (with the date) to this file: only then does `test/bsv-hedge.test.ts` stop asserting that no text says the tool was verified with real funds, and the docs must then be rewritten with a dated, scoped sentence (never "safe"). | todo |



## House context layer (branch `fix/house-layer-packaging`, 0.2.3-a fixes). Safety class: none

Four defects shipped in 0.2.3-a and are fixed here, all reproduced against the released app.zip. Proven in a real
package built by `scripts/release-package.mjs` (409 entries; `dist/context-layer` = 12 files, 113.9 KB) with the module
run as shipped inside it. **Not yet run in a real Legion**, so nothing here may be called verified until a row says pass.
Full record: `claude/HOUSE-LAYER-VERIFICATION.md`.

| # | Check | Expected observation | State |
|---|---|---|---|
| H1 | Install or update to this build over 0.2.2. Ask a Claude-provider agent (not a provider-model agent: those have no file tools) to call `house_list`. | 12 files listed, none reported missing, and neither `.shipped.json` nor `.adopted.json` appears. (0.2.3-a listed 1 file, the manifest, and reported 11 missing.) | todo |
| H2 | `house_recall` for something specific, e.g. `"dependency hash"`. | Real hits with paths and sections. (0.2.3-a returned nothing at all on a packaged install.) | todo |
| H3 | `house_read` on `AGENTS.md` and on `docs/adr/0010-owner-adoption.md`. | Both readable, neither wrapped, header says `shipped with Legion`. | todo |
| H4 | **The approval-card check.** In `ask` mode, have the agent read a house file. | **No approval card appears.** Any card here is a regression: `mcp__legion_house__` was missing from the Legion-tool prefix list, so all three house tools asked permission to read a markdown file. Repeat once in `auto-edits`. | todo |
| H5 | **The ratchet check.** Append a harmless comment line to the repo's `AGENTS.md`, then `house_read` it again. Restart Legion, read again, then revert the line and read once more. | Wrapped and `untrusted` while edited — **and `shipped` again after the revert.** Under 0.2.3-a the revert left it untrusted forever. Revert the edit afterwards. | todo |
| H6 | **Adoption.** Put a markdown file in `%USERPROFILE%\.legion\context\`, open Settings -> Doctrine (named House context before 2026-10-06). | The file is listed as `Not approved`; the shipped files are listed as `From Legion`. | todo |
| H7 | Press **Approve as my rules** on that file. | It becomes `Your rules`. Ask the agent to `house_read` it: served **unwrapped**, header says your own approved file. | todo |
| H8 | Edit that file (add a line), reopen Settings. | It is back to `Not approved` with no prompt and no button state carried over. That is the content-addressed approval working, not a bug. | todo |
| H9 | Press **Withdraw approval** on a file Legion also shipped (`AGENTS.md`). | It stays trusted and is labelled `From Legion`: withdrawing your approval removes your approval, not the app's own bytes. | todo |
| H10 | Restart Legion. | `house_list` unchanged; approvals survive; nothing you dropped into the context folder was deleted. | todo |

## Browser tool (built-in headless Edge/Chrome) - see claude/tracker-pc-checks-browser.md for the full steps (BR15 to BR24; the Lightpanda checks BR1-BR14 are dropped)
Safety classes: BR15-BR20, BR22-BR24 none (a harmless page you control); BR21 native dialog. Nothing in this section was run in a cloud session; do not call the browser tool verified until each is recorded as passed.

| H11 | **Heap ceiling (0.2.3-j).** The core now gets `min(RAM/4, 2048)` MB, floored at 512. On this machine Node's default was 4192 MB, so the cap is roughly half. **Nobody profiled the core's actual peak heap** — the cap is reasoned, not measured. Run a heavy session (large KG, several compactions, a long agent run) and watch whether heap approaches 2048. If it does, the cap is too low and the core will OOM where it previously survived. | todo |

## Turn limit and Continue (branch `fix/long-task-turn-limit`, 0.2.5-b). Safety class: spends a few cents of Claude usage (Haiku)

Proven with the scripted model only (`test/engine.test.ts`, `test/turn-limit-config.test.ts`; 8 source mutations each turned a test red). The scripted model cannot prove that the real Claude Agent SDK resumes the session and that Claude carries on instead of starting over, so nothing here may be called verified until a row says pass. The SDK docs name this as the recovery path ("resume with a higher limit", code.claude.com/docs/en/agent-sdk/sessions).

| # | Check | Expected observation | State |
|---|---|---|---|
| TL1 | Settings → Claude: confirm the turn limit reads 200 after the update (it read 40 before; `%USERPROFILE%\.legion\config.json` gains `"migrations": ["claude-max-turns-v2"]`). | 200. Set it to 3, save. | todo |
| TL2 | On a Haiku agent with Full access, send: "Create step1.txt to step5.txt in the current folder, one Write call per turn, in order, then reply FINISHED." | After 3 turns: an amber **Paused at the turn limit** card (not a red "Run failed"), text "(3 turns this run)", buttons **Continue** and **Raise the limit**. No Opus escalation line. Some step files exist. | todo |
| TL3 | Press **Raise the limit**. | Settings opens on the Claude section. Set the limit back to 200. | todo |
| TL4 | Press **Continue**. | The thread shows "Continued where it stopped" (not a long user bubble). Claude writes only the missing step files (check the folder: earlier files keep their timestamps) and replies FINISHED. It does not restart from step1. | todo |
| TL5 | Start a long task, quit Legion mid-run, start it again. | The task shows "Legion restarted" with **Continue** (not Retry). Continue picks up the work. | todo |
| TL6 | In a Claude task with some history, type `/compact keep the API notes`. | The thread shows a `/compact keep the API notes` message, then "Claude Code compacted this conversation. It held about Nk tokens." The toast says "Claude Code is compacting this conversation." Before 0.2.5-b, Legion caught `/compact` and answered "Choose a provider model in Settings", and Claude Code's own `/compact` could not be reached. | todo |
| TL7 | Let a long Claude task run until Claude Code compacts by itself (or check an old long task). | A line "Claude Code compacted this conversation by itself, to make room…" appears where it happened. | todo |

## 0.2.5-c: messages during a run, and the rest of the council items. Safety class: a few cents of Claude usage

| # | Check | Expected observation | State |
|---|---|---|---|
| C1 | Start a longer Claude task. While it works, type a correction and press Enter. | The hint reads "Enter adds it to the run"; the message appears in the thread at once; Claude takes it into account after its current step, in the same run (no second run starts; the working row's turn keeps counting). | todo |
| C2 | Same, with a provider-model agent. | The message is queued (the strip shows it) and sent when the run ends. | todo |
| C3 | A task whose session file was deleted (or a very old one): press Continue. | "The earlier conversation could not be found, so Claude is starting a new one with your request." and the request runs fresh. | todo |
| C4 | Settings -> Claude: spend limit $0.10; run a task that costs more. | Amber "Paused at the spend limit" card, calm mascot; Continue resumes. | todo |
| C5 | A task that uses TodoWrite and thinks; open the window mid-run. | The checklist and "Working · turn N of 200 · tool · time · context" show at once; "Thinking" while it thinks. | todo |
| D3 | Give Zealot a plain multi-part request ("build a landing page with a signup form and write the release note"), without saying how. Then the same inside a project whose board leader is Builder. | Zealot names the pieces, delegates them (tell, several at once), keeps a plan with owners and status, checks the answers and reports who did what. In the project: it reads the board, sees Builder leads it, and routes the work through Builder instead of running its own plan. | todo |

## 2026-10-06: Deny mood and Lattice camera (uncommitted fixes on main, see the tracker section of the same date). Safety class: a few cents of Claude usage (MD1); none (MD2)

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| MD1 | Built app. Give Zealot a task that runs a Bash command that needs a card. Press Deny quickly (under 1 s), then again on a new card after a slow Deny (about 3 s). Then Allow on a third. | After each Deny, the bust and Zealot's Relic go from "Awaiting your word" to "Deliberating", with no "Executing" frame. After Allow, Executing shows as before. | A screen recording or quick screenshots of the bust label after each answer. | todo |
| MD2 | Built app, Lattice open with a framed view. Toggle BSV mode (or anything that refreshes from the server without changing the graph). | The camera does not jump or re-fit. A real change (a node hidden or deleted elsewhere) still shows after the refresh. | Before and after screenshots of the Lattice. | todo |

## 2026-10-06: the takeover art and the Ŧ mark (uncommitted, spec claude/spec-legion-takeover.md). Safety class: none (TK1, TK2, TK4); a few cents of Claude usage (TK3)

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| TK1 | Quit Legion fully, start it from the desktop shortcut, watch the splash. Time the window from double-click to the main window, before and after this change. | The critter idles, glitches and is converted into the helm within about 0.8 s; the helm holds with its ring turning until the fade. On a warm second launch (start it again at once), the helm is fully converted before the fade starts; the headline "THE LEGION IS TAKING OVER CLAUDE" is never clipped. If the boot fails, the error shows next to the still helm, not a glitch frame; the boot lines still appear. The main window opens no later than before. With Windows "Show animations" off: one still helm, no motion. | A screen recording of the splash; the two timings. | dropped: the takeover splash was reverted in 0.2.5-e (owner: the takeover art is the mod's) |
| TK2 | In Windows Terminal (CaskaydiaCove NF) run `node -e "console.log('Ŧ LEGION · sworn · done|')"`; then look at the same text in a Claude Code desktop session (TK3). | `Ŧ` is drawn, one cell wide: the `|` at the end lines up with a row of 26 ASCII characters above it. | A screenshot of each. | todo |
| TK3 | In Claude Code with Legion's MCP server: ask it to run a one-line task on Scout through legion_run. | The tool result ends with the line `Ŧ LEGION · sworn · done`, visible when the result is expanded. Claude does not treat it as an instruction. | A screenshot of the expanded tool result. | todo |
| TK4 | Put docs/images/legion-takeover.gif (frame 1) side by side with Claude Code's own banner critter. | It reads as the critter (an homage) but is not a pixel copy: proportions and palette are Legion's redraw. If it is a near-copy, redraw before publishing. | The side-by-side image. | todo |

## 2026-10-06: the installed 0.2.5-c picks up 0.2.5-d. Safety class: none (updates your own install)

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| U1 | In the installed Legion 0.2.5-c: Settings → About → Updates → "Check now", then "Update" (download), then **"Restart now…"** (not "Update and install now", which is the 0.2.5-c bug this release fixes). Confirm the dialog. | Legion restarts on 0.2.5-d (title bar shows v0.2.5-d); the usage chart icon is in the title bar; the update panel now shows "Restart and install". `%LOCALAPPDATA%\Programs\Legion\.git` still does not exist. | Screenshot of the title bar version and the updates panel. | passed (maintainer report 2026-10-06: the in-app update worked on the PC through the 0.2.5 releases; no screenshot kept) |

## 2026-10-06: taskbar pinning (0.2.5-e). Safety class: none

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| P1 | On 0.2.5-e: start Legion from the Start menu. Right-click its taskbar button, "Pin to taskbar". Quit Legion fully (tray, Quit). Click the pinned button. Then, while it runs, check the taskbar. | "Pin to taskbar" is offered; the pin starts Legion; the running window sits ON the pinned button (one button, not two). The splash is the Zealot splash. In PowerShell, the Start-menu Legion.lnk now has System.AppUserModel.ID = dev.legion.app. | Screenshot of the taskbar with Legion pinned and running; the PowerShell line. | todo |

## 2026-10-06: agent-to-agent bridge wording, audit bugs B1-B7 (uncommitted on release/0.2.5-f; audit claude/audit-agent-to-agent-ux.md). Safety class: a few cents of Claude usage (AB1-AB6); none otherwise

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| AB1 | Built app. Ask Zealot to `tell` an agent that does not exist ("tell nobody: hi"), then to tell Builder 7 times in a row (the 7th hits the rate limit). Expand each chip. | The refused chips read "Not sent: Unknown agent …" / "Not sent: Rate limit: …" in the red error colour; a delivered tell still reads "Sent. Builder's reply will arrive in this task." with "Open their task". Also confirms what the real Claude CLI stores as the tool result of an MCP `isError` call: the text must start with "Error: " (the fake harness cannot show this; the B1/B5 detection depends on it). | Screenshot of the expanded chips; the stored tool-result text from the task's messages (GET /api/tasks/:id). | todo |
| AB2 | Ask Zealot to `ask` Builder something that takes about a minute. While it runs, expand the ask chip and look at the working row. | Chip: "Waiting for Builder…" (not "No result was recorded"). Working row: "Working · turn N of M · Waiting on Builder" (not "mcp__legion__ask"). After the answer: the chip shows the Result. | Two screenshots (during, after). | todo |
| AB3 | Ask Zealot to `ask` Builder with `timeoutSeconds: 5` for a task that takes longer. Expand the chip. | "Still working after 5 s; Builder keeps going." with "Open their task", not raw JSON. | Screenshot. | todo |
| AB4 | Ask Zealot to `ask` Builder; cancel Builder's task from its thread while Zealot waits. Then repeat with `tell` and cancel again. | The ask chip reads "Builder could not finish: …" in red, not under a "Result" heading. The tell reply in Zealot's thread is drawn with a red left rule and "Builder could not finish: the task was cancelled." instead of "(cancelled)". | Screenshots of both. | todo |
| AB5 | Set Builder to Opus in its editor. Ask Zealot to `ask` Builder with `model: "haiku"`. | The override line ("Model override: Builder is set to opus … runs on haiku …") shows as a grey system line in Zealot's thread, not as a message bubble from Builder. Rows written by 0.2.5-e or earlier keep their old look (not migrated). | Screenshot. | todo |
| AB6 | Same as AB5 with a provider-backed caller (an agent on an experimental provider) asking Builder with a model override, then one more turn. | The provider run does not answer the override line as if the owner had said it; its next turn continues normally. | Screenshot of the thread; the run's request log if available. | todo |

## 2026-10-06: splash start error shown in full (0.2.5-f). Safety class: none

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| SP1 | (1) Occupy Legion's port first, so the core cannot start: in PowerShell run `$l=[System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,4747); $l.Start()` (use your configured port if not 4747), then start Legion; afterwards `$l.Stop()` and press Retry. (2) Windows Settings > Accessibility > Visual effects > Animation effects OFF, start Legion again. | (1) The splash is the 0.2.5-f design: the painted Zealot as before, "Legion" in the title bar's blackletter, "Your order of agents.", the same boot lines. The error shows in full in red with Retry and Open log visible; the log scrolls with the wheel if needed while the rest of the window still drags. "Open log" shows the same text as a "Legion could not start the core:" line in core.log. After Retry the app starts normally. (2) Nothing on the splash moves (no glow pulse, no blinking caret, no sweeping bar) and it disappears without a fade. The longest message (the antivirus hint) was checked by render: 0 px hidden at 560x360 in Cascadia and Consolas. | Screenshots of the error splash and of the still splash; the core.log line. | todo |

## 2026-10-06: thread fixes (0.2.5-g, uncommitted on release/0.2.5-g). Safety class: a few cents of Claude usage (TG2); none otherwise

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| TG1 | Built 0.2.5-g, dark and light theme. Repeat AB4's tell part (cancel Builder's task while it works on Zealot's tell). Then make the window 960 px wide with the ops panel open and get a long working row (an ask to an agent with a long name, e.g. "Release Notes Cartographer"). | The failed reply "Builder could not finish: …" is red (danger colour), not grey. The working row wraps inside a taller row; "1m 31s" never splits across lines; at full width the row looks as in 0.2.5-f (22 px). | Screenshots in both themes. | todo |
| TG2 | Ask Zealot to `ask` Builder (quick question) and Scout (a task of about a minute) in the same turn, as parallel tool calls. Watch the working row after Builder answers. | Confirms how the real Claude CLI delivers parallel MCP results: one at a time (then the row reads "Waiting on Scout" after Builder's answer) or together. While both run it reads "Waiting on Builder, Scout". It never reads "Waiting on another agent" while a named ask is open. | Two screenshots; the task's stored messages (GET /api/tasks/:id) showing the order of the results. | todo |

## 2026-10-06: house switches and shipped skills (Release A, on feat/house-skills-ci-panel; ADR 0012). Safety class: none

| id | Steps | Expected | Evidence | State |
|---|---|---|---|---|
| HS1 | Built Windows app, fresh install (or a data directory with no `.house-switches.json`). Open Settings, Doctrine. Also try 150% Windows scaling and Ctrl + / Ctrl - zoom, light and dark theme. | The groups appear in this order, each with its plain hint: Core tenets (always on), Drills (skills agents can use, off by default), Foundations, Decrees, Chronicle, Lore, Your orders (if you added files). The Drills sub-groups (Verify and debug, CI and GitHub, Review) are collapsed, each with a name, a one-line summary and "0 of n on". Every skill is off; every non-core rule is on. A skill row shows its full description, "Licence (MIT)" or "Licence (Apache-2.0)" and "Read it"; Read it shows the rendered skill with its switch ("Use this skill"). At every scale nothing overlaps and the Doctrine tab is visible as selected. | Screenshots of the Doctrine screen at 100% and 150%, one expanded sub-group, the Read-it dialog. | todo |
| HS2 | Built app. Turn one skill on (for example verification-before-completion). Start a task on any agent and ask it to list its skills and then load that skill. | The agent's `house_skills` lists only that skill; `house_skill` returns its text with the header "skill; shipped with Legion". The preamble names the skill. The run is marked tainted. Turn the skill off and run again: `house_skills` says no skills are turned on, and `house_skill` refuses it. | The task's tool chips for both runs; a screenshot of the taint marker. | todo |
| HS3 | Built app. In Settings, Doctrine, switch a rule off (for example `docs/TESTING.md`). Ask an agent to read it with `house_read`, to `house_recall` a phrase from it, and to run `house_list`. Then look at the core rules. | The file is absent from `house_list`, `house_read` answers as if it does not exist, and `house_recall` returns nothing from it. The core rules (`AGENTS.md`, `CONTEXT.md`) show a lock and have no working switch; trying to switch one off through the screen does nothing. Switch `docs/TESTING.md` on again: an agent can read it. | The three tool results; a screenshot of the lock. | todo |
| HS4 | Built app. Switch one rule off and one skill on. Quit Legion fully (tray, Quit) and start it again. Then install a newer build over it (Settings, About, Updates, or a manual install). Look at Settings, Doctrine again, and start a task. | After the restart both switches are as you left them. After the update they are still as you left them, and every skill you did not turn on is still off. A new skill that the newer build adds is off. | Screenshots of the Doctrine screen after the restart and after the update; the contents of `%USERPROFILE%\.legion\.house-switches.json` (no secrets in it). | todo |
| HS5 | Built app on NTFS. Switch `docs/ARCHITECTURE.md` off. Ask an agent to call `house_read` with each of these paths: `docs/ARCHIT~1.MD` (the 8.3 short name; check the real short name with `dir /x docs` inside `%USERPROFILE%\.legion\context`), `DOCS/architecture.md` (other case), `docs/ARCHITECTURE.md::$DATA` (NTFS stream; any path with a colon is refused outright, even for a file that is on). Repeat with a skill that is off, for example `skills/verify-debug/systematic-debugging/SKILL.md` and its short-name form. | Every spelling is refused with the same "No such file" answer as a file that does not exist (the colon spelling is refused as outside the folder). None returns the text. If any spelling returns text, record the exact spelling: it is a hole in the switch. | The tool result for each spelling; the `dir /x` output. | todo |
