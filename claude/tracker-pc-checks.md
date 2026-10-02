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

## BSV spend tool (T2, branch `claude/bsv-t2-spend`): owner-only wallet checks. Nothing here was run: the build used fakes only
Each assumption A1..A12 of `claude/plan-bsv-rung3.md` section 15 is a named failing-closed check in `src/core/bsv/spend.ts`; the row that proves it on a real wallet is below. If a real wallet contradicts one, the spend path refuses (fails closed) and the owner is told; release is gated on these rows, not on the build. Plan ids in `claude/real-pc-test-plan.md`: V = BSVT, R = BSVM.

### V1 to V12: a SEPARATE TESTNET wallet (BSV Desktop switched to its testnet database, or a VM), owner present. Never the funded mainnet wallet
Setup V0: the wallet app in testnet mode with testnet coins from a faucet; Legion built from the reviewed commit; confirm in Legion's BSV panel that the wallet claims a TESTNET network before anything else.

| # | Owner action | Expected observation | Assumption it proves | State |
|---|---|---|---|---|
| V1 | By hand (no Legion code): ask the wallet for an unsigned transaction (`createAction` with `options.signAndProcess:false`, one P2PKH output to a second testnet address of the wallet itself); save a scrubbed copy of the answer | `signableTransaction {tx, reference}` and NO txid; no wallet prompt; nothing broadcast. Note: encoding of `tx` (byte array or hex), whether the parent transactions are inside the BEEF, number and kind of extra outputs (change) | A1 A2 A3 A4 | todo |
| V2 | By hand: `abortAction` with that `reference` | `{aborted:true}`; the locked coins are spendable again; a second `abortAction` with the same reference fails cleanly | A5 | todo |
| V3 | Connect to the wallet in Legion, run `bsv_status` | testnet, reachable, signed in; the version string is whatever the wallet says (the real one is not semver, finding F-W1) | A9 A12 | todo |
| V4 | Panel: put one testnet address (the wallet's second address) on the TESTNET allowlist | native dialog; list saved | | todo |
| V5 | Assayer asks for 600 sat to that address | card: 600 sat, FULL address, TESTNET, fee, caps; second dialog (untrusted content) because `bsv_status` taints the run; the wallet's own prompt appears only after both; a txid comes back; open it in a testnet explorer (Legion does not check it) | A6 A7 A10 A11 | todo |
| V6 | A second request right after | the wallet prompts AGAIN (no standing grant for the originator `legion.local`) | A6 | todo |
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
| R4 | Arm 5 minutes (read the dialog); ask again | D1 then D2 (D3 if tainted); compare amount, network word, FULL address (character by character against the wallet) and caps with this table | todo |
| R5 | Press Cancel on D2 | `declined`; no wallet prompt; reservation freed; still armed | todo |
| R6 | Ask again, confirm D1 and D2 | The wallet shows its OWN prompt: 200 sat, the recipient, ONE payment output; approve there only if all match | todo |
| R7 | Read the result | txid returned; check it in a mainnet explorer in a browser (Legion does not): one 200 sat output to the own address plus change; the balance fell by the fee only | todo |
| R8 | Ask once more | Denied `not-armed` (one arm, one spend); no wallet prompt | todo |
| R9 | Arm, ask, confirm D1 and D2, then Decline in the WALLET | Legion shows `unknown`; the switch is off (auto-off); read the wallet history and resolve natively ("NOT sent") | todo |
| R10 | Enable, arm, ask; Freeze while D1 is open | Dialog answer refused; no wallet prompt | todo |
| R11 | Disable mainnet, Disarm, Disconnect | Panel shows off; read the audit lines for R1..R10 and record dated results here | todo |

ABORT at once (Freeze, Disable mainnet, no retry, record) if: a dialog differs from the table in amount, network word or one character of the address; the wallet prompt comes before D1 and D2 are answered, shows another amount or recipient or more than one payment output, offers "always allow" or a monthly limit (do not tick it), or does not appear at all in R6 (assumption A6); the fee shown exceeds 100 sat; Legion returns any status other than the expected one; a second prompt appears; the txid is not 64 hex or the explorer shows anything unexpected. After an abort read the wallet history before anything else.

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
| ND10 | Real core with T2 merged, fake or throwaway-testnet wallet only: a spend request shows the dialogs, and the WALLET's own prompt appears only after the last one; nothing appears before. If the wallet shows no prompt of its own, stop: that is the U13 abort. (T3-A5, T3-A7) | todo |
| ND11 | Title bar note count (owner's real graph; read it, change nothing): with BSV mode on the bar shows `<n> BSV notes`, with `(pack 157)` when n differs; the panel's Knowledge notes section gives the line `bundled pack: 157 notes (version 7); in your graph: n; removed or merged by you or a bot: a; added by you: b; missing: c`. Check a, b, c against what you remember doing (deleting, merging, adding notes). Turn the core off or block it: the bar must say `BSV notes: unknown`, never 0. If `missing` is above 0, press `Restore N missing bundled notes` and confirm the number rises by N and edited notes keep your text. | todo |


## Browser tool (Lightpanda) - see claude/tracker-pc-checks-browser.md for the full steps (BR1 to BR14)
Safety classes: BR2 downloads; BR3-BR8 none (a harmless public page you control); BR12 native dialog; BR13 none. Nothing in this section was run in the cloud session; do not call the browser tool verified until each is recorded as passed.
