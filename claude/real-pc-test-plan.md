# Legion real-PC test plan (master)

One executable plan for everything that only a real Windows PC, a real Blender, a testnet-wallet VM, the owner's own funds, real Electron native dialogs or real accounts can verify. A computer-use agent or the owner walks through it later, so nothing falls between the cracks.

- Machine-readable twin: [`scripts/harness/pc-checks.json`](../scripts/harness/pc-checks.json) (same ids and fields; it is the source of truth for the check tables below, which are generated with `node scripts/harness/pc-report.mjs --emit-md`).
- Summary of a run: `node scripts/harness/pc-report.mjs <results.json> --by-safety` prints PASS / FAIL / NOT-RUN by area and exits non-zero on any FAIL.
- Intake list: [`claude/tracker-pc-checks.md`](tracker-pc-checks.md). Agents append new "needs a real PC" items there (rule in `CLAUDE.md`); they are merged into this plan, with their sources, when it is next refreshed.
- Status of this document: **nothing here has been run.** It was built on 2026-10-02 from reports and code in a Linux cloud session. Every result field says `not-run`. Anything marked **INFERRED** traces to a concrete behaviour in the code or docs but no agent had listed it; the owner may drop it.

## 1. Rules for any run

1. **Gates are in order** (section 3). Do not start a gate before the previous one passed or the owner accepted the failure in writing.
2. **Safety classes decide who may act:**

| Class | Meaning | May an agent run it? |
|---|---|---|
| none | local, reversible, no money, no account | yes |
| account | uses the owner's Claude, GitHub or boat.dev login or quota | only with the owner present and the account already signed in; the agent never creates accounts, passwords or CAPTCHAs |
| downloads | downloads software (npm, Electron, Blender, an add-on) | only after the owner's explicit "go" for that download |
| spends-money | a boat.dev VM or anything else billed | only after the owner's explicit "go"; stop the VM at the end of the check |
| native-dialog | needs a real Electron native dialog answered by a person | owner at the keyboard; an agent may only watch |
| real-wallet | talks to a wallet | only the throwaway TESTNET wallet inside the VM of BSVT-00, owner present. An agent never drives it. Never the owner's own wallet. |
| real-funds | would move the owner's real money | never by an agent, never scripted. Owner by hand, present, after saying "go". |

3. **Never contact the owner's own wallet.** No check in this plan names its port or runs a command against it. The tests and scripts in this repo refuse that port by design. The real-funds section (BSVM) is written as manual steps using the wallet's own UI.
4. **No secrets in evidence.** No keys, tokens or `.legion` data in screenshots, logs or this plan. Show at most the first 4 characters of any secret-shaped value. Take token checks with `Select-String -Quiet` or HTTP status codes, never by printing.
5. **A feature is not "verified" until its check says `pass` with a date and an evidence path.** Do not change docs or the changelog to say verified before that (CLAUDE.md, Real-PC checks).
6. Kill processes **by PID only**, never by a name pattern, on the owner's PC.
7. Wording: a pass here means "this behaviour was seen on this PC on this build", not that a control cannot be bypassed.

## 2. Evidence and results

- Evidence root (outside the repo): `%USERPROFILE%\legion-pc-run\<yyyymmdd>\`. File name patterns: screenshots `PC-<AREA>-<nn>[-<what>].png`, logs `PC-<AREA>-<nn>.log`. Record the Windows version, `$PSVersionTable.PSVersion`, the Legion commit id and the Node version once at the start (G0) in `00-environment.txt`.
- Results file (JSON, kept next to the evidence): `{ "results": { "PC-INST-01": { "status": "pass", "date": "2026-10-03", "evidence": "PC-INST-01-success.png" } } }`. Statuses: `pass`, `fail`, `not-run`, `skip` (owner declined, or the feature is not on this build; a skip is never a failure but is listed).
- `node scripts/harness/pc-report.mjs <results.json> --by-safety` summarises. Add `--strict` to make any NOT-RUN exit non-zero. Each check below also carries a result line; copy the final status back into it when a run is recorded.

## 3. Run order with gates

| Gate | When | What | Rule |
|---|---|---|---|
| G0 | first | Pre-flight | Owner confirms PC, build commit, that the owner's own wallet is out of scope; back up `%USERPROFILE%\.legion` and `~/.claude.json`; create the evidence folder. |
| G1 | after G0 | Installer (INST) | Install first. INST-10 must pass before anything else. |
| G2 | after INST-10 | Core and app shell (APP) | APP-01 to APP-03 must pass (or be accepted) before G3 to G11. |
| G3 | after G2 | Chat, Rooms, Library and MCP (CHAT, MCP) | Needs the owner's Claude sign-in; uses a little quota. |
| G4 | after G3 | VM and boat.dev (VM) | spends-money: owner go, boat.dev key. Stop every VM at the end. |
| G5 | after G2 | Blender local and live, no downloads (BLND-01 to 05, 07 to 11, 16, 18) | Real Blender already installed. |
| G6 | with owner go | Downloads: add-on pin, extension install, managed Blender (BLND-06, 12 to 15, 17), npm in PERF-01 | One download at a time, only with the owner's explicit go. |
| G7 | with owner go | Blender in the VM (BLND-19 to 23) | spends-money and downloads in the VM. |
| G8 | owner present | BSV testnet in a VM (BSVT) | real-wallet and native-dialog: the throwaway testnet VM only; the owner answers every dialog. |
| G9 | idle PC, after G2 | Perf and regression (PERF) | Do not overlap with other gates. |
| G10 | after the repo is public and the site is deployed | Website and public install (WEB) | |
| G11 | **last** | BSV mainnet real funds (BSVM) | Only if the owner is present and says "go"; needs BSVT recorded and the independent review signed off. Owner does every step by hand. |

Within a gate follow each check's `depends`. A failed check blocks the checks that depend on it; mark those `skip` with the reason, not `pass`.

## 4. How a computer-use agent should run this

- **Before anything else:** if the Aetherkeep vault is reachable on the owner's PC, read the owner's fast-PC computer-use notes there (the `fast-pc-computer-use` skill and the vault's computer-use notes, including screen scale and which monitor to use). If it is not reachable, say so once and explore carefully: take a full screenshot first, work out the screen scale from a known UI element (window width in pixels against the logical size), and prefer the no-GUI route (a shell command or a file check) whenever a check offers one.
- Prefer `command-only` checks through a shell; verify by reading files and process lists rather than by screenshots. Batch actions, then verify once.
- Run one check at a time. Capture the evidence file named in the check, then write the result line (status, date, evidence path) into the results file straight away.
- On any surprise (an unexpected dialog, a prompt that asks for a password, a payment page, an account creation, a CAPTCHA, an antivirus quarantine, a wallet prompt): stop, take a screenshot, record `fail` or `skip` with the note, and ask the owner. Do not click through.
- Checks marked `owner-must-be-present`, `owner-only` or with safety `native-dialog`, `real-wallet`, `real-funds`, `spends-money` or `downloads` need the owner's go first. Ask once per gate, in plain words ("G4 starts a billed boat.dev VM; go?").
- Never type, paste or screenshot a secret. Never contact the owner's own wallet. Never kill processes by name pattern.
- At the end of each area run its rollback (section 5) and note any leftover in the results.

## 5. Rollback and cleanup per area

| Area | Rollback |
|---|---|
| INST Installer | Run uninstall.cmd (no /purge) in every test install folder; delete throwaway source copies, the foreign test folder and the fake Electron project; restore %USERPROFILE%\.legion from the G0 backup; undo any PATH or network change; stop any test node process by PID. |
| APP Core and app shell | Quit Legion from the tray; stop the port listener by PID; delete LEGION_HOME copies and test agents; restore %USERPROFILE%\.legion from the G0 backup; re-enable the network adapter; reset the Doctor-breaking change (re-enter the boat.dev key). |
| CHAT Chat, Rooms and Library | Delete test rooms, test agents and test Library notes (Inbox reject or Undo); remove exported vault folders; restore the data backup if settings were changed. |
| MCP MCP | Run `claude mcp remove legion`; restore ~/.claude.json from the backup made in MCP-05; remove the redact-test server and any Claude Desktop config entry; untick MCP inheritance if you ticked it; delete the throwaway project folder. |
| VM VM and boat.dev | Stop every VM from the Computer card and confirm in the boat.dev dashboard that nothing is running; restore Settings, boat.dev, API base URL and remove the cost-estimate rates; stop the logging listener. |
| BLND Blender (local, live, VM, managed, extension) | Delete the test task folders under %APPDATA%\legion\blender\local\ and the test exports; set the bridge back to its previous state; remove the community add-on or extension and any managed Blender copy only if installed for this run; kill test processes by PID only; stop VM Blender runs and the VM. |
| BSVT BSV testnet wallet in a VM | Freeze, Disarm and Disconnect in the BSV panel; delete the testnet VM and its wallet; nothing is ever configured on the host; a broadcast testnet transaction cannot be undone and has no value. |
| BSVM BSV mainnet real funds | R11: Disable mainnet, Disarm, Disconnect. Keep the audit log. A sent transaction cannot be undone; read the wallet history before anything else after any abort. |
| WEB Website and public install | Uninstall the test install (uninstall.cmd); no other state changes. |
| PERF Perf and regression | Delete scratch output folders and temp homes the scripts created; restore any power-plan change. |

## 6. The checks

Generated from `scripts/harness/pc-checks.json` with `node scripts/harness/pc-report.mjs --emit-md`. Do not edit the check text here; edit the JSON and regenerate, then keep the result lines in sync.

<!-- BEGIN GENERATED CHECKS -->
### Installer (INST, 16 checks, gate G1)

#### PC-INST-01: Double-click setup.cmd: window stays open on success and on a forced failure

- **Source:** claude/tracker-pc-checks.md P1; review/release-packaging-review.md section 5 item 1
- **Gate / depends:** G1
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** Windows 10 or 11 with Windows PowerShell 5.1 (powershell.exe, not pwsh). Unpacked source folder. Node installed for the success run. A second run with Node hidden from PATH (open a cmd window, run `set PATH=C:\Windows\System32` first) or with `npm ci` made to fail (disconnect the network) for the failure run.
- **Steps:**
  1. Success run: double-click setup.cmd in Explorer. Answer the prompts.
  2. Failure run: from a cmd window with the reduced PATH, run setup.cmd, or double-click it with the network off after Node is found.
  3. Note whether the window stays open at the end of each run and whether the message can be read.
- **Expected:** On success the window stays open with a "done" style message (setup.cmd pauses). On failure it stays open with an error that names what failed. Neither run closes the window before it can be read.
- **Evidence:** PC-INST-01-success.png, PC-INST-01-failure.png (window text visible); copy of the console text to PC-INST-01.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-02: Double-click setup-yes.cmd: closes on success, stays open with a message on failure

- **Source:** claude/tracker-pc-checks.md P1; review/release-packaging-review.md F4
- **Gate / depends:** G1
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** As INST-01. setup-yes.cmd is the unattended entry point (-Yes).
- **Steps:**
  1. Double-click setup-yes.cmd with everything in order and watch the window.
  2. Repeat with Node hidden from PATH or the network off so a step fails (double-click, not from an open cmd window).
- **Expected:** Success: the window closes by itself and Legion starts. Failure: the window stays open, prints "Legion setup failed (exit code N)" and waits for a key (the single `pause` after the redirect test).
- **Evidence:** PC-INST-02-failure.png showing the failure message and the pause prompt; PC-INST-02.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-03: Redirected input: setup never waits for a keypress

- **Source:** claude/tracker-pc-checks.md P2; review/release-packaging-review.md section 5 item 2
- **Gate / depends:** G1
- **Safety / automation:** none / command-only
- **Preconditions:** cmd window in the source folder. A way to run with no console (Task Scheduler one-shot task) is optional.
- **Steps:**
  1. Run `setup.cmd < nul`.
  2. Run `echo | setup.cmd`.
  3. Run `cmd /c setup-yes.cmd -DryRun -NoLaunch` from a cmd window with output piped to a file.
  4. Optional: create a Task Scheduler task running `cmd /c setup-yes.cmd -DryRun -NoLaunch` and run it.
- **Expected:** None of the runs blocks on Read-Host or `pause`; each ends by itself. [Console]::IsInputRedirected gives the same answer in every case (no run waits).
- **Evidence:** PC-INST-03.log with the exit code of each run and the wall-clock time.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-04: Process matcher stops only Legion processes

- **Source:** claude/tracker-pc-checks.md P3; review/release-packaging-review.md F1, F9, section 5 item 3
- **Gate / depends:** G1 / after PC-INST-10
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** A build installed and running (INST-10). Four extra programs started first: (a) Legion running from the install folder, (b) a Legion source checkout on another drive with its own electron.exe running, (c) an unrelated Electron app whose folder has src\electron\main.ts and package.json with another name, (d) VS Code and a plain `node` dev server open. Use harmless sample apps only.
- **Steps:**
  1. List the candidate PIDs with `Get-CimInstance Win32_Process | Where-Object { $_.Name -match "electron|node" } | Select ProcessId,Name,CommandLine`.
  2. Run `setup.cmd -DryRun` and read which PIDs it says it would stop.
  3. Run `setup-yes.cmd -NoLaunch` and compare the list of surviving PIDs.
- **Expected:** Only Legion's own PIDs (install folder and the source checkout of Legion, both with package name legion) are listed and stopped. The unrelated Electron app, VS Code and the node dev server keep running.
- **Evidence:** PC-INST-04-before.txt and PC-INST-04-after.txt (PID lists), PC-INST-04.log (setup output).
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-05: Install to a path with spaces and non-ASCII characters

- **Source:** claude/tracker-pc-checks.md P4; review/release-packaging-review.md section 5 item 4
- **Gate / depends:** G1
- **Safety / automation:** downloads / command-only
- **Preconditions:** Windows PowerShell 5.1. A folder such as C:\Users\Zoë Ørsted\Legion Test (create it, or use a user account with such a name).
- **Steps:**
  1. Run `setup-yes.cmd -InstallDir "C:\Users\Zoë Ørsted\Legion Test" -NoLaunch` from a source folder that also has a space in its path.
  2. Open the Desktop and Start-menu shortcuts and start Legion from each.
  3. Run uninstall.cmd from the install folder.
- **Expected:** Install, shortcuts, launch and uninstall all work. %~dp0 is not garbled by the OEM code page (no "path not found" errors).
- **Evidence:** PC-INST-05.log, PC-INST-05-shortcut.png (the shortcut Target field).
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-06: Dangerous -InstallDir values are refused (drive root, foreign folder, user profile)

- **Source:** claude/tracker-pc-checks.md P5; review/release-packaging-review.md F2, section 5 item 5
- **Gate / depends:** G1
- **Safety / automation:** none / command-only
- **Preconditions:** A throwaway foreign folder with a file `keep.txt` in it. Use -DryRun first for every target.
- **Steps:**
  1. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -DryRun -Yes -NoLaunch -InstallDir <target>` for each target: `C:\`, `C:`, the foreign folder, `%USERPROFILE%`, `%USERPROFILE%\.legion`.
  2. Check the foreign folder afterwards.
- **Expected:** Every target exits non-zero with a refusal and prints the resolved path. Nothing is deleted (keep.txt still there). A missing folder, an empty folder or an existing Legion install is accepted.
- **Evidence:** PC-INST-06.log (exit code per target), listing of the foreign folder after.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-07: Uninstall: shortcuts, install folder and data folder behave as documented

- **Source:** claude/tracker-pc-checks.md P6; review/release-packaging-review.md section 5 item 6; README.md Install (uninstall paragraph)
- **Gate / depends:** G1 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** A working install. Desktop redirected into OneDrive on the test account if possible. A second Legion shortcut pointing at another install folder.
- **Steps:**
  1. Run uninstall.cmd in the install folder (no /purge).
  2. Check Desktop (including the OneDrive Desktop), Start menu, the install folder and %USERPROFILE%\.legion.
  3. Reinstall, then run `uninstall.cmd /purge` and answer the confirmation.
- **Expected:** Shortcuts that point at this install go; the shortcut that points at another install stays. Install folder is removed. %USERPROFILE%\.legion is intact without /purge and deleted (after you confirm) with /purge.
- **Evidence:** PC-INST-07-before.txt and PC-INST-07-after.txt (directory listings), PC-INST-07.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-08: CRLF line endings survive ZIP download and git clone

- **Source:** claude/tracker-pc-checks.md P7; review/release-packaging-review.md section 5 item 7
- **Gate / depends:** G1
- **Safety / automation:** none / command-only
- **Preconditions:** Git for Windows with `core.autocrlf=input`. The repo (or a ZIP of it) once it is reachable for the owner.
- **Steps:**
  1. Download the repo ZIP and unpack it; run `Format-Hex -Path setup.cmd -Count 400` or check with `(Get-Content -Raw setup.cmd) -match "\r\n"`.
  2. Run `git -c core.autocrlf=input clone <repo> clone-test` and check setup.cmd, setup-yes.cmd, uninstall templates and scripts\*.ps1 the same way.
  3. Double-click setup.cmd from each copy.
- **Expected:** All .cmd and .ps1 files have CRLF in the working tree in both cases (the index stores LF, .gitattributes converts) and run without "is not recognized" line-ending errors.
- **Evidence:** PC-INST-08.log (match results per file).
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-09: SmartScreen and antivirus behaviour on the unsigned .cmd files

- **Source:** claude/tracker-pc-checks.md P8; review/release-packaging-review.md section 5 item 8; README.md status block (unsigned, expect prompts)
- **Gate / depends:** G1
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** Default Windows Security and SmartScreen settings. File arrives via browser download (Mark of the Web) and also via git clone.
- **Steps:**
  1. Download the ZIP in a browser, unpack, double-click setup.cmd.
  2. Note every prompt: SmartScreen, Defender, any third-party AV.
- **Expected:** RECORD ONLY: which prompts appear and whether "Run anyway" lets setup finish. README already says to expect prompts. Anything that deletes or quarantines a file is a FAIL for the owner to triage.
- **Evidence:** PC-INST-09-prompt-1.png ...; Defender protection history excerpt.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-10: Fresh npm ci and build on Windows, launch from the shortcut with the real Electron binary

- **Source:** claude/tracker-pc-checks.md P9; review/release-packaging-review.md section 5 item 9
- **Gate / depends:** G1
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** No earlier Legion install, or a clean install folder. Network on (npm and the Electron download). Owner gives the go for downloads.
- **Steps:**
  1. Double-click setup.cmd (or run setup-yes.cmd) from a fresh source copy.
  2. When it finishes, start Legion from the Desktop shortcut. Then close it and start `start-legion.cmd` in the install folder.
  3. Open Doctor (title bar chip or type /doctor).
- **Expected:** npm ci, build and the Electron download finish; the window opens; Doctor lists Node, config, Claude sign-in, boat.dev and workspace. Both launchers open the same app.
- **Evidence:** PC-INST-10.log (setup output tail), PC-INST-10-window.png, PC-INST-10-doctor.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-11: Setup run from inside a Legion agent does not kill its own ancestor

- **Source:** claude/tracker-pc-checks.md P10; review/release-packaging-review.md F6
- **Gate / depends:** G1 / after PC-INST-10
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** Installed Legion running. An agent with approval mode `ask` or `full` that can run shell commands. Owner present to approve the card.
- **Steps:**
  1. In the app, ask the agent to run `setup-yes.cmd -DryRun -NoLaunch` from a source folder and then (second run) `setup-yes.cmd -NoLaunch`.
  2. Watch whether the app window and the core stay up and whether the run finishes.
- **Expected:** Setup excludes the whole ancestor chain: the Legion process that launched it keeps running and the update completes. If the ancestor is stopped, that is a FAIL (review F6).
- **Evidence:** PC-INST-11.log (PID list before and after), PC-INST-11.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-12: Setup under powershell -NonInteractive and when not user-interactive

- **Source:** review/release-packaging-review.md F7. **INFERRED:** From review finding F7 (low); the tracker list did not include it.
- **Gate / depends:** G1 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** cmd window in the source folder; Legion running (so setup has a question to ask).
- **Steps:**
  1. Run `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\setup.ps1 -DryRun -NoLaunch`.
  2. Run the same without -DryRun but WITHOUT -Yes while Legion is running, with input redirected (`< nul`).
- **Expected:** Setup does not fail with a raw Read-Host exception; either it takes the documented default (stops Legion) or says what to do. README says input redirected takes the default.
- **Evidence:** PC-INST-12.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-13: Uninstall edges: partial update, in-place install from a checkout, -Purge target

- **Source:** review/release-packaging-review.md F8. **INFERRED:** From review finding F8 (low); not in the tracker list. Run only against throwaway copies.
- **Gate / depends:** G1 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** Throwaway source checkout copy (with a .git folder) used for an in-place install; a throwaway LEGION_HOME folder.
- **Steps:**
  1. Install from the checkout with -InstallDir pointing at the checkout itself (in-place), then run uninstall.cmd -DryRun and read what it would delete.
  2. Set LEGION_HOME to a throwaway folder and run `uninstall.cmd /purge -DryRun`; read the target.
  3. Delete scripts\lib\legion-procs.ps1 from a copied install and run uninstall.cmd.
- **Expected:** RECORD: whether an in-place install deletes the whole checkout including .git (documented risk), whether -Purge deletes whatever LEGION_HOME names without a marker check, and whether a missing helper gives a readable message instead of a raw PowerShell error.
- **Evidence:** PC-INST-13.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-14: Real Windows PowerShell 5.1: parse the scripts and run the matcher helpers on a throwaway node.exe

- **Source:** review/release-packaging-review.md F5, section 0 (5.1 never run in the review)
- **Gate / depends:** G1
- **Safety / automation:** none / command-only
- **Preconditions:** powershell.exe 5.1 (`$PSVersionTable.PSVersion` shows 5.x). Note: the repo CI job "installer (Windows PowerShell 5.1)" covers part of this on a GitHub runner, which is not the owner's PC.
- **Steps:**
  1. Run `powershell -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('scripts\setup.ps1',[ref]$null,[ref]$e) | Out-Null; $e.Count"` for setup.ps1, uninstall.ps1 and scripts\lib\legion-procs.ps1.
  2. Start a throwaway `node -e "setInterval(()=>{},1e3)"` from a folder with a fake package.json named `legion` and the entry-point files, dot-source legion-procs.ps1 and call Select-LegionProcesses and Stop-LegionProcesses on it.
- **Expected:** 0 parse errors for all three scripts. The throwaway process is matched and stopped by PID; a second throwaway node process outside that folder is untouched.
- **Evidence:** PC-INST-14.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-15: Update in place: setup again from a newer source asks before stopping a running Legion and keeps data

- **Source:** README.md Install (update paragraph)
- **Gate / depends:** G1 / after PC-INST-10
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** A working install with Legion running and some data in %USERPROFILE%\.legion (an agent, a task).
- **Steps:**
  1. Run setup.cmd again from a source folder (touch a file so it differs). Read the "Stop it now?" question; answer no once, then yes.
  2. After the update, open the app.
- **Expected:** On a console it asks before stopping (default yes only when input is redirected). After the update the app starts and the agent and task history are still there; config.json auth token is unchanged.
- **Evidence:** PC-INST-15.log, PC-INST-15-after.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-INST-16: Desktop shortcut is created when Desktop is redirected into OneDrive

- **Source:** claude/tracker-pc-checks.md P6 (OneDrive-redirected Desktop); task brief: OneDrive-redirected folders. **INFERRED:** The install side of the OneDrive case is inferred from P6 (which checks removal).
- **Gate / depends:** G1
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** Windows account with Known Folder Move on, so [Environment]::GetFolderPath("Desktop") is under OneDrive.
- **Steps:**
  1. Run `[Environment]::GetFolderPath("Desktop")` and note the path.
  2. Install; look for the Legion shortcut on that Desktop and in the Start menu.
- **Expected:** The shortcut is created in the redirected Desktop folder (not only in C:\Users\<name>\Desktop) and launches Legion.
- **Evidence:** PC-INST-16.log (the path), PC-INST-16.png.
- **Result:** not-run | date: - | evidence path: -

### Core and app shell (APP, 14 checks, gate G2)

#### PC-APP-01: Tray icon: close hides to tray, menu items work, Quit stops only a core the app started

- **Source:** claude/legion-release-tracker.md handoff (tray/second-instance/title bar); docs/ARCHITECTURE.md Electron shell
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Installed Legion launched from the shortcut (the app starts its own core).
- **Steps:**
  1. Click the window close button. Check the tray (notification area, maybe under the ^ arrow).
  2. Right-click the tray icon. Expect the items Show Legion, Freeze BSV chain, Restart core, Open data folder, Quit.
  3. Choose Show Legion; then choose Open data folder.
  4. Choose Quit. Check in Task Manager that the core node process ended.
  5. Start `node dist\src\bin\legion-core.js` by hand first, then launch the app; choose Quit; check the hand-started core is still running.
- **Expected:** Close hides to the tray. Show Legion restores the window. Open data folder opens %USERPROFILE%\.legion. Quit stops the core only when the app started it.
- **Evidence:** PC-APP-01-tray-menu.png, PC-APP-01.log (process lists after each Quit).
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-02: Second instance: starting Legion again focuses the running window

- **Source:** claude/legion-release-tracker.md handoff (tray/second-instance/title bar); docs/ARCHITECTURE.md (single-instance lock)
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Legion running, once with the window visible and once hidden in the tray.
- **Steps:**
  1. Double-click the Desktop shortcut again while the window is visible.
  2. Hide the window to the tray; double-click the shortcut again.
- **Expected:** No second window or second core appears; the existing window comes to the front (also from the tray). Task Manager shows one Legion Electron process tree.
- **Evidence:** PC-APP-02.log (process count), PC-APP-02.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-03: Title bar: hidden bar with overlay controls, no overlap at 1440 px, minimum size

- **Source:** claude/legion-release-tracker.md handoff (tray/second-instance/title bar); CHANGELOG.md (Title bar crowding); docs/ARCHITECTURE.md (1280x820, minimum 960x600)
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Legion running. Doctor chip in its longer state ("1 to fix") if you can produce it (for example remove the boat.dev key). BSV mode on shows the ticker.
- **Steps:**
  1. Drag the window by the title bar; minimise, maximise and close with the overlay controls.
  2. Resize to about 1440 px wide with BSV mode on and the Doctor chip at "1 to fix"; look at the Chat / Rooms / Library tabs and the ticker.
  3. Shrink the window towards 960x600.
  4. Repeat on Windows 10 and Windows 11 if both are available.
- **Expected:** Drag, min/max/close work. At 1440 px the ticker does not draw over the view tabs, search box or right-hand icons. The window cannot go below 960x600 and every title-bar button stays clickable.
- **Evidence:** PC-APP-03-1440.png, PC-APP-03-960.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-04: Port 4747 already taken: Legion says so, does not kill the squatter

- **Source:** SECURITY.md (port squatting row). **INFERRED:** Behaviour taken from SECURITY.md; exact UI text not read.
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** Legion not running. Any harmless local listener on 127.0.0.1:4747 (for example `node -e "require('net').createServer().listen(4747,'127.0.0.1')"`).
- **Steps:**
  1. Start the listener. Launch Legion from the shortcut.
  2. Read the message. Check the listener is still running afterwards.
  3. Stop the listener and launch Legion again.
- **Expected:** Legion reports that it cannot start because the port is in use (it will not run until you stop the other program) and does not kill the unrelated process. After the listener stops, Legion starts normally.
- **Evidence:** PC-APP-04.png (message), PC-APP-04.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-05: Restart core from the tray: window reloads, admin features still work, secret rotated

- **Source:** docs/ARCHITECTURE.md Electron shell (tray Restart core rotates the admin secret)
- **Gate / depends:** G2 / after PC-APP-01
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Legion running with the window open on Settings.
- **Steps:**
  1. Tray menu, Restart core.
  2. When the window reloads, change a harmless setting in Settings (for example toggle and restore a checkbox) and save.
  3. Open the Doctor.
- **Expected:** The window reloads and the saved change goes through (admin works after the restart). No "admin_required" error appears.
- **Evidence:** PC-APP-05.png, core.log excerpt (no secret values) in PC-APP-05.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-06: Doctor lists every check with a fix, on the real machine

- **Source:** README.md (Doctor); claude/legion-release-tracker.md handoff
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** account / computer-use-ok
- **Preconditions:** Installed Legion; Claude signed in or an API key set; boat.dev key optional.
- **Steps:**
  1. Open Doctor from the title bar or type /doctor.
  2. Read each row: Node version, config, Claude sign-in (email), boat.dev, workspace.
  3. Break one thing on purpose (clear the boat.dev key) and re-run.
- **Expected:** Each row shows ok or a fix. The broken row shows a fix text; the chip count updates. Opening Doctor makes no boat.dev call before you ask for it (see VM-01).
- **Evidence:** PC-APP-06-ok.png, PC-APP-06-broken.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-07: First launch: config.json with a fresh token; no secret in logs

- **Source:** README.md (first launch creates config.json); CLAUDE.md hard rules (no tokens in logs)
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** No %USERPROFILE%\.legion yet (back it up first).
- **Steps:**
  1. Launch Legion once. Look at %USERPROFILE%\.legion.
  2. Search core.log and other *.log for the token value (do not print the token: load it in a variable and use Select-String -Quiet).
- **Expected:** config.json exists with an authToken; the token string is not found in any log. Only the first 4 characters may appear in your evidence.
- **Evidence:** PC-APP-07.log with True/False per log file, no token text.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-08: Data and workspace under a profile name with spaces and non-ASCII characters

- **Source:** task brief: paths with spaces/non-ASCII. **INFERRED:** No source states it fails; checked because the installer path case (INST-05) is a known risk.
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** A Windows account whose profile folder contains a space and a non-ASCII letter (for example Zoë Ørsted).
- **Steps:**
  1. Launch Legion as that user, create an agent with a working directory under the profile, run a task that writes a file there.
  2. Open Library and the Doctor.
- **Expected:** config.json, state and logs are written under the profile\.legion folder; the task writes its file; no mojibake in paths shown in the UI; Doctor workspace check passes.
- **Evidence:** PC-APP-08.png, PC-APP-08.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-09: Upgrade from the previous build: Builder VM size reset to default once

- **Source:** claude/tracker-pc-checks.md U1; review/rooms-probe-upgrade-review.md section U1; CHANGELOG.md (Upgrade: Builder's VM size is reset)
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** A copy of a state.json from the v6-5 build with Builder on `large` and no `migrations` flag (back up the real %USERPROFILE%\.legion first; test in a copy via LEGION_HOME).
- **Steps:**
  1. Start the new build against that data. Open Builder's settings.
  2. Set Builder to `large` by hand. Restart the core (tray, Restart core).
  3. Open state.json and read `migrations`.
- **Expected:** First start: Builder shows `default` and migrations contains "builder-vm-size-default-v1". The manual `large` choice is kept on the next start; the migration never runs again. Another agent set to `large` was not changed.
- **Evidence:** PC-APP-09.log (state.json migrations field and Builder vm.size before/after).
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-10: Claude sign-in and a first real run

- **Source:** claude/legion-release-tracker.md handoff (approval-card flows end to end); README.md Settings
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** Owner signed in to Claude Code on this PC (or an API key set in Settings). Uses a few tokens: pick the Haiku model.
- **Steps:**
  1. Open Settings, Claude; read the sign-in state.
  2. Select Zealot, choose a small model, send "reply with the word ok".
- **Expected:** The run streams a reply and ends; the task appears under recent tasks with a cost. No credential is shown on screen.
- **Evidence:** PC-APP-10.png (no key visible).
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-11: Approval cards end to end: Allow, Deny, keyboard A and D, ask/auto-edits/full

- **Source:** claude/legion-release-tracker.md handoff (approval-card flows end to end); README.md (Inline approvals)
- **Gate / depends:** G2 / after PC-APP-10
- **Safety / automation:** account / computer-use-ok
- **Preconditions:** APP-10 passed. An agent in `ask` mode with a throwaway working directory.
- **Steps:**
  1. Ask the agent to create a file in the working directory. When the Allow/Deny card appears press A.
  2. Ask it to delete that file; press D.
  3. Switch the agent to `auto-edits`, repeat the create; then to `full`.
  4. Leave one card unanswered for the timeout period (10 minutes) if time allows.
- **Expected:** A allows, D denies and the agent is told so. auto-edits and full skip cards for edits as described. An unanswered card ends with the agent told nobody answered.
- **Evidence:** PC-APP-11-card.png, PC-APP-11-after.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-12: Sentinel scheduled routine fires unattended

- **Source:** claude/legion-release-tracker.md handoff (Sentinel schedule). **INFERRED:** The handoff names it, but no scheduler code was found in src/ (only the Sentinel persona text mentions routines). The owner must say how the routine is meant to be set up before this can be run.
- **Gate / depends:** G2 / after PC-APP-10
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** Owner decides what "a Sentinel schedule" is (a Claude Code routine, Task Scheduler call to the MCP bridge, or an in-app feature) and sets it up.
- **Steps:**
  1. Set up the smallest routine (a check every few minutes) and leave the PC idle.
  2. Check that it fired at the expected time with the window hidden to the tray, and that it stopped when expected.
- **Expected:** The routine fires by itself at the set time and produces a task visible in Legion. If it needs a VM, the VM is stopped when idle.
- **Evidence:** PC-APP-12.log (times fired), screenshot of the task list.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-13: Works offline: bundled fonts and UI render without a network

- **Source:** README.md (fonts bundled so it works offline). **INFERRED:** Taken from the README claim; not listed as a check by any agent.
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Installed Legion. Disconnect Wi-Fi or disable the adapter.
- **Steps:**
  1. Start Legion with the network off. Look at the title bar font (Grenze Gotisch for the wordmark), body and mono text.
- **Expected:** The UI loads and all three bundled font families render (no fallback serif/sans swap, no missing glyph boxes). Runs fail with a network error, not a blank UI.
- **Evidence:** PC-APP-13.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-APP-14: Renderer bridge in the real sandboxed preload (window.legion)

- **Source:** docs/BSV-WALLET-DESIGN.md section 11 (preload survives a real sandbox); docs/ARCHITECTURE.md (preload exposes window.legion). **INFERRED:** Opening DevTools in the packaged build may be disabled; use `npm run app` from a source checkout if so.
- **Gate / depends:** G2 / after PC-INST-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Legion running; DevTools reachable (Ctrl+Shift+I) in a source checkout run with `npm run app`.
- **Steps:**
  1. In the DevTools console evaluate `Object.keys(window.legion)` and `window.legion.platform`.
  2. Evaluate `typeof window.legion.bsvPolicy`.
- **Expected:** Keys are baseUrl, token, admin, platform, openExternal (and bsvPolicy once the BSV bridge is built). admin is non-empty only while Legion's own core child is alive. Do not copy the token into evidence.
- **Evidence:** PC-APP-14.png with token and admin values hidden.
- **Result:** not-run | date: - | evidence path: -

### Chat, Rooms and Library (CHAT, 7 checks, gate G3)

#### PC-CHAT-01: Bot-created room with no budget: card says no spend limit, running cost visible

- **Source:** claude/tracker-pc-checks.md R1; review/rooms-probe-upgrade-review.md R1 checks; claude/legion-release-tracker.md decision 4
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** account / computer-use-ok
- **Preconditions:** APP-10 passed. Two agents. Owner at the keyboard. Use a small model.
- **Steps:**
  1. Ask Zealot to create a room with Scout using room_create and no budget.
  2. Read the approval card; Allow it.
  3. Open the room header and the room settings.
- **Expected:** The card says there is no spend limit (not $1 or $5). The room header meter shows running cost with no maximum; settings Budget box shows the placeholder "No limit". Member cap 6 still applies.
- **Evidence:** PC-CHAT-01-card.png, PC-CHAT-01-header.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-CHAT-02: Room budget edge cases in the real UI: remove a limit, add one, resume after a budget pause

- **Source:** review/rooms-probe-upgrade-review.md polish P1, P2. **INFERRED:** Polish findings of the rooms review; behaviour already unit-tested, the wording is what needs eyes.
- **Gate / depends:** G3 / after PC-CHAT-01
- **Safety / automation:** account / computer-use-ok
- **Preconditions:** A room from CHAT-01 or a human-made room with a $0.05 budget.
- **Steps:**
  1. Let the room hit its budget so it pauses (post a message that wakes a bot).
  2. In room settings clear the Budget box and Save; read the pause pill; Resume.
  3. Add a limit back.
- **Expected:** Readable wording (the review flagged "spent $x of its No limit limit" as a wording bug); Resume works after the limit is removed; clearing the box on a room that had a limit is clear about the result.
- **Evidence:** PC-CHAT-02-pill.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-CHAT-03: Rooms with real bots: freeze stops work, guards stop loops

- **Source:** README.md Rooms; docs/COMMS-BRIDGE.md. **INFERRED:** No agent listed it as unverified; added because rooms are driven by real model output that fakes cannot reproduce.
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** account / computer-use-ok
- **Preconditions:** A room with 3 bots on a small model and a small budget.
- **Steps:**
  1. Send a message with @everyone-style wake and let bots answer each other.
  2. Press Freeze while a bot is running.
  3. Resume.
- **Expected:** Freeze cancels running work and bots stop waking; messages are saved; Resume continues. Hop, cycle and budget guards end a back-and-forth by themselves.
- **Evidence:** PC-CHAT-03.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-CHAT-04: Copy menu puts real Markdown and plain text on the Windows clipboard

- **Source:** docs/CHAT.md Copy menu. **INFERRED:** Unit tests cover the formatting; the real clipboard in Electron is not covered.
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** A reply that contains a Markdown table and a code block.
- **Steps:**
  1. Hover the reply; click Markdown under it; paste into Notepad.
  2. Click Plain text; paste again.
- **Expected:** Markdown keeps the table source; plain text gives tab-separated rows; no stray HTML.
- **Evidence:** PC-CHAT-04.png of both pastes.
- **Result:** not-run | date: - | evidence path: -

#### PC-CHAT-05: Message queue with a real run: Enter queues, Ctrl+Enter interrupts, stop pauses the queue

- **Source:** docs/CHAT.md Message queue. **INFERRED:** Logic is unit-tested; timing with a real streaming run is not.
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** account / computer-use-ok
- **Preconditions:** APP-10 passed. A prompt that makes the agent work for about 20 seconds.
- **Steps:**
  1. While it runs, type two messages and press Enter after each (they queue).
  2. Press Ctrl+Enter with a third message.
  3. Press Stop during a later run and reload the window.
- **Expected:** Enter queues in order and shows the strip above the composer; Ctrl+Enter cancels the run and sends now with the rest still queued; a stop or reload pauses the queue instead of sending on its own.
- **Evidence:** PC-CHAT-05-queue.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-CHAT-06: Library Inbox with a real run: accept and reject a note; restart keeps the same graph

- **Source:** claude/legion-release-tracker.md R6.1 open item; docs/LIBRARY.md
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** account / computer-use-ok
- **Preconditions:** APP-10 passed.
- **Steps:**
  1. Ask an agent to save a note to the Library. Open Library, Inbox; accept one note, reject another.
  2. Restart the core (tray) and reopen Library.
- **Expected:** Accepted note is in the graph; rejected is gone; after restart the graph, edges and search results are identical. This is the user-visible form of the "restart equals live" guarantee that is NOT confirmed on Windows (see PERF-03).
- **Evidence:** PC-CHAT-06-before.png, PC-CHAT-06-after.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-CHAT-07: Library export to a vault folder on Windows (OneDrive path, link refusal, Undo)

- **Source:** docs/LIBRARY.md (export refuses to write through a link; Undo open 7 days). **INFERRED:** Link and path behaviour is tested with junctions in unit tests; a real OneDrive-synced vault was not.
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** A throwaway vault folder, once under OneDrive and once containing a junction named legion (mklink /J) pointing outside.
- **Steps:**
  1. Library: export the shared notes to the OneDrive vault folder; open the files.
  2. Export into the folder that contains the junction.
  3. In Activity click Undo on one bot write.
- **Expected:** Files appear under <vault>\legion\<type>\ as Markdown; export refuses to write through the junction and says so; nothing outside <vault>\legion\ is touched; Undo works.
- **Evidence:** PC-CHAT-07.png, PC-CHAT-07.log (listings).
- **Result:** not-run | date: - | evidence path: -

### MCP (MCP, 9 checks, gate G3)

#### PC-MCP-01: inheritMcp off: no claude.ai connectors or user MCP servers connect, even with a settings env block

- **Source:** claude/tracker-pc-checks.md M1; review/mcp-isolation-review.md F1
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** Real claude.ai connectors enabled on the owner's account. `claude.inheritMcp` off (default). A throwaway project folder whose .claude/settings.json has an `env` block setting ENABLE_CLAUDEAI_MCP_SERVERS to "true". Fix under test: settings.disableClaudeAiConnectors passed by Legion.
- **Steps:**
  1. Point an agent's working directory at the throwaway project; run a one-line task.
  2. Open Settings, MCP: read the status panel for the run.
  3. Check the connector servers' own logs or dashboards for a connection from that time.
- **Expected:** The status panel lists only Legion's own server and servers added under Settings, MCP; no claude.ai connector is connected and none logged a session. If a connector connects, that is a FAIL (review F1: the env-only switch can be undone by inherited settings).
- **Evidence:** PC-MCP-01-status.png and the connector log excerpt (redacted).
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-02: inheritMcp on with a registered Legion server: self-server switched off, no loop

- **Source:** claude/tracker-pc-checks.md M2; review/mcp-isolation-review.md F6
- **Gate / depends:** G3 / after PC-MCP-05
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** `claude mcp add legion http://127.0.0.1:4747/mcp` (or stdio) configured in Claude Code. Settings, Claude: tick the MCP inheritance option.
- **Steps:**
  1. Run a one-line task.
  2. Read the MCP status panel.
- **Expected:** Legion's own /mcp entry from the inherited config is shown as switched off after init; the run ends; no task starts tasks recursively.
- **Evidence:** PC-MCP-02-status.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-03: Loopback aliases of the self-server on Windows (127.0.0.2, ::ffff:127.0.0.1, localhost.)

- **Source:** review/mcp-isolation-review.md F2b. **INFERRED:** Review says macOS/Windows 127/8 behaviour differs from Linux; expected result unknown.
- **Gate / depends:** G3 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** Legion core running.
- **Steps:**
  1. Run `Test-NetConnection 127.0.0.2 -Port 4747` and open http://[::ffff:127.0.0.1]:4747/health and http://localhost.:4747/health in a browser or with curl.exe -s.
- **Expected:** RECORD which aliases reach the core on Windows. Any alias that reaches it is a spelling the self-MCP guard (isSelfMcpUrl) must also catch.
- **Evidence:** PC-MCP-03.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-04: A broken plugin MCP server in the owner's Claude setup is shown as theirs, not Legion's

- **Source:** claude/tracker-pc-checks.md M3
- **Gate / depends:** G3 / after PC-MCP-02
- **Safety / automation:** account / owner-only
- **Preconditions:** The owner's Claude setup has the failing server `plugin:data:definite` (ENDPOINT_NOT_FOUND). inheritMcp on.
- **Steps:**
  1. Run a task with MCP inheritance on and read the status panel.
  2. Tell the owner what it shows.
- **Expected:** The server appears as failed with its own error and origin; Legion is not blamed. Note only: nothing for Legion to fix.
- **Evidence:** PC-MCP-04.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-05: Register the Legion MCP stdio bridge in Claude Code (user scope), list tools, one Haiku task

- **Source:** claude/legion-release-tracker.md After install: Legion MCP for Claude Code; README.md Orchestrate
- **Gate / depends:** G3 / after PC-INST-10, PC-APP-10
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** Legion installed (INST-10). Owner approved user-scope registration. NOTE: the tracker text shows the path as `dist\srcin\...` (a lost backslash); the real file is dist\src\bin\legion-mcp-stdio.js.
- **Steps:**
  1. Back up ~/.claude.json to ~/.claude/backups/<date>-legion-mcp/ and write a RESTORE.md there.
  2. Run `claude mcp add --scope user legion -- node "%LOCALAPPDATA%\Programs\Legion\dist\src\bin\legion-mcp-stdio.js"`.
  3. Run `claude mcp list` and, in a Claude Code session, list the legion tools (legion_list_agents, legion_models, legion_create_agent, legion_run, legion_continue, legion_status, legion_cancel, legion_vm, legion_recent_tasks).
  4. Ask Claude Code to use legion_run with Zealot on Haiku: "reply ok".
- **Expected:** The nine tools are listed; the task runs and its result comes back. The Claude config holds no token (the bridge reads it itself). Rollback: `claude mcp remove legion` and restore the backup.
- **Evidence:** PC-MCP-05.log (claude mcp list output), PC-MCP-05.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-06: MCP token class cannot approve, accept notes or change settings

- **Source:** claude/legion-release-tracker.md After install (token class cannot approve cards...); README.md Orchestrate
- **Gate / depends:** G3 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** Legion running. Read the token into a PowerShell variable without printing it (`$t=(Get-Content $env:USERPROFILE\.legion\config.json -Raw | ConvertFrom-Json).authToken`).
- **Steps:**
  1. With curl.exe call `GET /api/state` with `Authorization: Bearer $t` (expect 200).
  2. Call `GET /api/config`, `POST /api/approvals/<any id>` and `GET /api/bsv/policy` with the same header (print only the HTTP status).
- **Expected:** /api/state is 200; the other routes return 401 or 403 (admin_required). Evidence shows status codes only, never the token.
- **Evidence:** PC-MCP-06.log (status codes).
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-07: Cowork and Claude Desktop over the stdio bridge

- **Source:** claude/legion-release-tracker.md handoff (Cowork over MCP); README.md Orchestrate
- **Gate / depends:** G3 / after PC-INST-10
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** Claude Desktop or Cowork installed and signed in. Owner present.
- **Steps:**
  1. Run `npm run mcp-config` in the install folder (do not paste its token into evidence).
  2. Add the stdio snippet to claude_desktop_config.json under mcpServers; restart Claude Desktop.
  3. Ask it to call legion_list_agents, then legion_run with a Haiku one-liner.
- **Expected:** The tools show up and answer. If the app was closed, the bridge starts Core headless (see MCP-08).
- **Evidence:** PC-MCP-07.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-08: The stdio bridge starts Core headless when the app is closed, and the app adopts it

- **Source:** docs/ARCHITECTURE.md (legion-mcp-stdio starts Core headless). **INFERRED:** ARCHITECTURE states it; nobody listed it as verified on Windows.
- **Gate / depends:** G3 / after PC-MCP-05
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** Legion fully quit (tray, Quit). No core on port 4747.
- **Steps:**
  1. Call the bridge from Claude Code (MCP-05) so it starts Core.
  2. Check Task Manager for a headless core node process; then launch the Legion app.
- **Expected:** A headless core starts and answers; the app starts and uses it (one core). Quit of the app does not stop a core it did not start.
- **Evidence:** PC-MCP-08.log (process list).
- **Result:** not-run | date: - | evidence path: -

#### PC-MCP-09: MCP status panel does not show URLs or tokens from a failing server

- **Source:** review/mcp-isolation-review.md F3. **INFERRED:** Finding F3 (low-medium) with a fix suggested; run after the fix.
- **Gate / depends:** G3 / after PC-APP-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Settings, MCP: add a remote server named `redact-test` with URL `https://127.0.0.1:9/mcp?token=EXAMPLE0000` (a refused port).
- **Steps:**
  1. Run a one-line task. Read the status panel entry for redact-test.
  2. Remove the server again.
- **Expected:** The error text shows no query string or token (URL reduced to its origin or [url]). If `token=...` is visible, that is a FAIL.
- **Evidence:** PC-MCP-09.png.
- **Result:** not-run | date: - | evidence path: -

### VM and boat.dev (VM, 9 checks, gate G4)

#### PC-VM-01: Core start makes zero boat.dev key-probe calls

- **Source:** claude/tracker-pc-checks.md K1; review/rooms-probe-upgrade-review.md K1; claude/legion-release-tracker.md decision 3
- **Gate / depends:** G4 / after PC-APP-10
- **Safety / automation:** account / command-only
- **Preconditions:** boat.dev key saved in Settings. To count calls without trusting Legion: set Settings, boat.dev, "API base URL" to a local logging listener (any small Node http server on 127.0.0.1 that logs every request path) and restore it afterwards. If the owner has stored VMs, expect one lookup per stored VM at start (review K1-F1).
- **Steps:**
  1. Quit Legion. Start the logging listener. Launch Legion; wait 60 seconds without opening Settings or starting a VM.
  2. Read the listener log.
- **Expected:** No permission-probe requests (about 8 calls) at start. With no stored VMs the log is empty; with N stored VMs at most N lookups from the state refresh.
- **Evidence:** PC-VM-01.log (request paths only, no key header).
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-02: The key probe runs once: on first Settings, boat.dev open or first VM use; Check again repeats it

- **Source:** claude/tracker-pc-checks.md K1; review/rooms-probe-upgrade-review.md K1 (race, re-open, reset on key change)
- **Gate / depends:** G4 / after PC-VM-01
- **Safety / automation:** account / command-only
- **Preconditions:** Same logging listener as VM-01 (probe results will show errors; that is fine, the count is what matters).
- **Steps:**
  1. Open Settings, boat.dev: count requests. Close and reopen Settings: count again.
  2. Click Check again: count again.
  3. Save a changed key: count again.
- **Expected:** First open: one probe (about 8 requests). Second open: no new requests. Check again: a new probe. A changed key forgets the old findings and probes once. Saving a key probes at once (review K1-F2: owner to confirm that is wanted).
- **Evidence:** PC-VM-02.log (counts per step).
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-03: Settings, boat.dev permission panel shows the real key's abilities and never creates a VM

- **Source:** docs/VM-NOTES.md; ui Settings (What this key can do)
- **Gate / depends:** G4 / after PC-VM-02
- **Safety / automation:** account / owner-must-be-present
- **Preconditions:** Real boat.dev key (free trial and, if available, paid).
- **Steps:**
  1. Open Settings, boat.dev; read "What this key can do" and the refused-actions list.
  2. Check the boat.dev dashboard for new sandboxes.
- **Expected:** The panel reports the key's abilities; no sandbox was created ("it reads and asks about a VM that does not exist"). Prices and probe results are visible only in the app window, not to an MCP token.
- **Evidence:** PC-VM-03.png, dashboard screenshot.
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-04: Real boat.dev error bodies and probe ordering

- **Source:** docs/VM-NOTES.md "Not verified against the real boat.dev"
- **Gate / depends:** G4 / after PC-VM-02
- **Safety / automation:** account / owner-only
- **Preconditions:** A real key in each state you can produce: Claude not configured on boat.dev; a trial account asking for a large VM.
- **Steps:**
  1. Open Settings, boat.dev with a key whose account has no Claude connected.
  2. Ask Builder to start a VM at size `large` on a trial account (if you have one).
- **Expected:** Messages match the three known bodies (provider_not_configured, api_key_action_forbidden, trial_machine_class_not_allowed); RECORD whether provider_not_configured is answered before any sandbox lookup (the doc says only a fake covers this).
- **Evidence:** PC-VM-04.png, error text copied to PC-VM-04.log (key removed).
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-05: Forgemaster VM run: start, exec, preview, Open desktop, stop

- **Source:** claude/legion-release-tracker.md handoff (Forgemaster VM run, real boat.dev checks); claude/legion-release-tracker.md item C
- **Gate / depends:** G4 / after PC-VM-02
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** boat.dev key set and permitted. Owner says go (a VM is billed). Forgemaster agent with approval `ask`.
- **Steps:**
  1. Ask Forgemaster to start its VM and run `uname -a`.
  2. Look at the Computer card: state, live screen preview, Open desktop link; click Open desktop.
  3. Ask it to stop the VM; check the boat.dev dashboard.
- **Expected:** The VM starts, the command output returns, the preview shows the screen, Open desktop opens the VM desktop in the browser, and stop ends billing (dashboard shows stopped).
- **Evidence:** PC-VM-05-card.png, PC-VM-05-dashboard.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-06: Builder at size `default` starts on a real account after the upgrade

- **Source:** claude/tracker-pc-checks.md U1; CHANGELOG.md (Builder reset)
- **Gate / depends:** G4 / after PC-APP-09, PC-VM-02
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** APP-09 passed. A free trial account if possible (it refuses `large`).
- **Steps:**
  1. Ask Builder to start its VM; run `echo ok`; stop it.
- **Expected:** The VM starts with no trial_machine_class_not_allowed error.
- **Evidence:** PC-VM-06.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-07: VM usage counters and the optional cost estimate against the dashboard

- **Source:** docs/VM-NOTES.md (vm_usage, cost estimate). **INFERRED:** VM-NOTES says the numbers are Legion's own uptime measure, not boat.dev's bill; the comparison is the check.
- **Gate / depends:** G4 / after PC-VM-05
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** A VM run from VM-05. Settings, boat.dev, Cost estimate: enter an hourly price and a currency label.
- **Steps:**
  1. Read the Computer card usage line (this run, today).
  2. Compare with the dashboard uptime for the same run.
  3. Wait 10 minutes with the dashboard unreachable (offline) and re-read the estimate.
- **Expected:** Runtime and today counters are close to the dashboard uptime; the estimate equals uptime x the entered rate and is labelled an estimate; after 10 minutes without a fresh copy it reads "cost unknown".
- **Evidence:** PC-VM-07.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-08: Idle VMs stop on their own so billing pauses

- **Source:** README.md (Idle VMs stop on their own). **INFERRED:** README claim; idle window length not read from code.
- **Gate / depends:** G4 / after PC-VM-05
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** A running VM from VM-05, left alone. Owner says go (billing continues until it stops).
- **Steps:**
  1. Leave the VM idle; check the Computer card and the dashboard at intervals up to the documented idle time.
- **Expected:** The VM is stopped by Legion's reaper after the idle period and the dashboard agrees.
- **Evidence:** PC-VM-08.png (before, after).
- **Result:** not-run | date: - | evidence path: -

#### PC-VM-09: vm_claude runs Claude inside the VM

- **Source:** src/core/boat-health.ts (message: Claude is not configured on boat.dev ... vm_claude cannot run). **INFERRED:** The positive path is not described as verified anywhere; added from the code message.
- **Gate / depends:** G4 / after PC-VM-05
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** boat.dev account with Claude connected on its Agents page.
- **Steps:**
  1. Ask an agent to use vm_claude with the task "print the current directory".
- **Expected:** The VM-side Claude answers and the result returns to the thread; the VM is stopped after.
- **Evidence:** PC-VM-09.png.
- **Result:** not-run | date: - | evidence path: -

### Blender (local, live, VM, managed, extension) (BLND, 23 checks, gate G5)

#### PC-BLND-01: Local mode: Blender is detected and Automatic says "Next script runs: on this computer"

- **Source:** claude/tracker-pc-checks.md B1; claude/plan-blender-local-first.md 6.2 item 1; review/blender-merged-review.md section 6 item 1
- **Gate / depends:** G5 / after PC-APP-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** A real Blender (3.0 or newer) installed, bridge enabled in Settings, Blender. Branch with local mode merged (merge/blender).
- **Steps:**
  1. Run `& "C:\Program Files\Blender Foundation\Blender <ver>\blender.exe" --version` (use the real install path).
  2. Open Settings, Blender; look at the detection line and the "Where scripts run" choice (Automatic).
- **Expected:** Detection finds the install and version; Automatic reads "Next script runs: on this computer". If the status says local is not available in this build, that is review blocker B1 (local runner not wired): FAIL.
- **Evidence:** PC-BLND-01.png, PC-BLND-01.log (--version output).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-02: First script after a fresh core start runs locally, not in the VM

- **Source:** review/blender-merged-review.md B1 (detect is async; first call could route to the VM). **INFERRED:** Review blocker B1 note about async detection; run after the fix.
- **Gate / depends:** G5 / after PC-BLND-01
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Blender installed; boat.dev key set (so the VM is a possible fallback); mode Automatic; core freshly restarted.
- **Steps:**
  1. Restart the core (tray, Restart core). Do NOT open Settings, Blender.
  2. Ask the Sculptor for a cube. Read the approval card badge.
- **Expected:** The card shows "On this PC" (local), not the VM. Local is ready without a prior status call.
- **Evidence:** PC-BLND-02-card.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-03: Cube plus GLB, FBX and PNG preview through the real runner; write guard does not break the exporters

- **Source:** claude/tracker-pc-checks.md B2; claude/plan-blender-local-first.md 6.2 item 2; review/blender-merged-review.md section 6 item 1
- **Gate / depends:** G5 / after PC-BLND-01
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** BLND-01 passed. Workspace folder chosen.
- **Steps:**
  1. Ask the Sculptor for a cube exported as GLB; read the whole script on the card; Allow.
  2. Repeat for FBX and for a preview (blender_screenshot).
  3. Look in <workspace>\blender-exports\<task>\ and in %APPDATA%\legion\blender\local\<task>\.
- **Expected:** *.glb, *.fbx and the PNG exist in blender-exports; scene.blend and backups\ exist only under %APPDATA%\legion\blender\local\<task>\; no .blend is in blender-exports (a .blend is quarantined as .untrusted). If an exporter is blocked by the Python write guard, record its temp location and add it to the guard allowlist (or set advanced.local.guard to log and say so).
- **Evidence:** PC-BLND-03.log (directory listings), PC-BLND-03-card.png, the PNG preview.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-04: A write outside the task folder is blocked; an infinite loop is killed at 120 s with no blender.exe left

- **Source:** claude/tracker-pc-checks.md B3; claude/plan-blender-local-first.md 6.2 item 3; review/blender-merged-review.md section 6 item 2
- **Gate / depends:** G5 / after PC-BLND-03
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** A hand-written script file calling the runner directly (bypassing the static check), kept under the scratch folder; a second one that loops forever. Defensive test of Legion's own controls only.
- **Steps:**
  1. Run the first script via the runner: it tries to write one file outside the task folder.
  2. Run the loop script; open Task Manager, Details tab, watch blender.exe at 0 s and at 125 s.
  3. After the kill, check for child processes (`Get-CimInstance Win32_Process | ? ParentProcessId -eq <pid>`).
- **Expected:** The outside write is refused (guard). The loop is stopped at about 120 s and neither blender.exe nor children remain (taskkill /T). The tool says it may still be running only if the kill failed.
- **Evidence:** PC-BLND-04.log, Task Manager screenshots PC-BLND-04-t0.png and PC-BLND-04-t125.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-05: The script's environment has no Legion or API variables

- **Source:** claude/tracker-pc-checks.md B4; claude/plan-blender-local-first.md 6.2 item 4
- **Gate / depends:** G5 / after PC-BLND-03
- **Safety / automation:** none / command-only
- **Preconditions:** As BLND-04. Set a dummy variable `LEGION_TEST_MARK=1` and a fake `ANTHROPIC_API_KEY=not-a-key` in the shell that starts Legion.
- **Steps:**
  1. Run a hand-written script through the runner that prints sorted os.environ keys to a file inside the task folder.
- **Expected:** The key list contains only the allowed set (PATH, HOME/USERPROFILE-style OS variables, TEMP/TMP, BLENDER_USER_*, UTF-8 vars); neither LEGION_TEST_MARK nor ANTHROPIC_API_KEY nor proxy variables are present. Keys only, no values in evidence.
- **Evidence:** PC-BLND-05.log (key names only).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-06: A local run opens no socket on 9876 even with the community add-on auto-start on

- **Source:** claude/tracker-pc-checks.md B5; claude/plan-blender-local-first.md 6.2 item 5; review/blender-merged-review.md section 6 item 4 (--factory-startup keeps add-ons out)
- **Gate / depends:** G6 / after PC-BLND-03, PC-BLND-12
- **Safety / automation:** downloads / command-only
- **Preconditions:** The community add-on installed with `blendermcp_auto_start_server` on (see BLND-12 for the install). A long-running script (sleep 30 s) via the runner.
- **Steps:**
  1. During the run execute `netstat -ano | findstr :9876`.
  2. Run `blender.exe --help` and check that BLENDER_USER_* variable names are accepted (listed under Environment Variables).
- **Expected:** No listener on 9876 while the local run is going; BLENDER_USER_* names appear in the help output.
- **Evidence:** PC-BLND-06.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-07: Path cases: user name with a space, long task path, OneDrive-redirected Documents, 8.3 names, junctions

- **Source:** claude/tracker-pc-checks.md B6; claude/plan-blender-local-first.md 6.2 item 6; review/blender-merged-review.md section 6 item 3
- **Gate / depends:** G5 / after PC-BLND-03
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** A test account or folders: C:\Users\Zoë Ørsted style name; a workspace under OneDrive\Documents; a task id producing a path near 200 characters; a junction made with `mklink /J` inside a throwaway task folder.
- **Steps:**
  1. Run BLND-03 with the workspace on OneDrive Documents; then with a profile name that has a space and non-ASCII letters.
  2. Ask for a task whose folder path is near the 200-character refusal limit.
  3. Inside a throwaway task folder create a junction to a folder outside; run a script that tries to write through it.
- **Expected:** Runs succeed with spaces, non-ASCII and OneDrive paths; the over-long path is refused with a clear message; writing through a junction to the outside is refused (guard resolves real paths; 8.3 names do not bypass it).
- **Evidence:** PC-BLND-07.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-08: Mode switch: VM and Live give the documented errors; legacy "sandbox":"off" loads as live; upgrade notice

- **Source:** claude/tracker-pc-checks.md B7; claude/plan-blender-local-first.md 6.2 item 7; review/blender-merged-review.md (upgrade notice section)
- **Gate / depends:** G5 / after PC-BLND-01
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Copy of an old config.json containing `"blender": {"enabled": true, "sandbox": "off"}` with no `mode` key (use a LEGION_HOME copy).
- **Steps:**
  1. Start with the old config. Read Settings, Blender: the mode and any upgrade notice.
  2. Set "Where scripts run" to the VM with no boat.dev key; ask for a cube. Set it to Live with no Blender socket; ask again.
  3. Compare each error with the decision table in docs/BLENDER.md.
- **Expected:** "sandbox":"off" is read as Live; the upgrade notice shows once for an upgraded config with no saved mode and not for a fresh enable; VM without a key and Live without a socket give the stated errors and start nothing.
- **Evidence:** PC-BLND-08.png (each error), PC-BLND-08.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-09: Antivirus or SmartScreen prompts on the first start of the local runner

- **Source:** claude/tracker-pc-checks.md B8; claude/plan-blender-local-first.md 6.2 item 8; review/blender-merged-review.md section 6 item 8
- **Gate / depends:** G5 / after PC-BLND-03
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** A first local run on a PC where blender.exe has not been started by Legion before.
- **Steps:**
  1. Run BLND-03 and watch for SmartScreen, Defender or third-party AV prompts.
  2. Also install Blender with the Windows launcher present (blender-launcher.exe next to blender.exe) and check which exe detection picks.
- **Expected:** RECORD prompts only. Detection must pick blender.exe and reject blender-launcher.exe.
- **Evidence:** PC-BLND-09.png, PC-BLND-09.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-10: Blender starts without APPDATA/LOCALAPPDATA and the variables Windows adds are recorded

- **Source:** review/blender-merged-review.md section 6 item 5
- **Gate / depends:** G5 / after PC-BLND-05
- **Safety / automation:** none / command-only
- **Preconditions:** As BLND-05.
- **Steps:**
  1. Run the runner's environment through a script that dumps its variable names (as BLND-05) and compare with the documented allow-list.
  2. Confirm Blender itself starts and the run finishes.
- **Expected:** Blender runs with the minimal environment; the variables Windows adds (SystemRoot etc.) are only OS-supplied ones; no secret-shaped name appears.
- **Evidence:** PC-BLND-10.log (names only).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-11: Task folder growth: tmp and backups are cleaned or capped; a large scene is not refused forever

- **Source:** review/blender-merged-review.md M3. **INFERRED:** Review medium finding; run after the fix, with modest sizes (do not fill the disk).
- **Gate / depends:** G5 / after PC-BLND-03
- **Safety / automation:** none / command-only
- **Preconditions:** A task with a scene of about 100 MB (add a high-poly mesh) and free disk of at least 2 GB.
- **Steps:**
  1. Run six successive edits on the same task; check size of tmp\ and backups\ in the task folder after each.
  2. Try to run once the folder passes the 500 MB cap.
- **Expected:** tmp\ is emptied after each run; at most 5 backups are kept; when over the cap the refusal tells where the folder is and how to clear it (or a Clear button exists).
- **Evidence:** PC-BLND-11.log (sizes).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-12: Community add-on: reproduce the pinned sha256 and run Set up once

- **Source:** claude/tracker-pc-checks.md B9; claude/plan-blender-local-first.md 6.3; docs/BLENDER.md Not verified yet (community backend, Windows); review/blender-merged-review.md section 6 item 7
- **Gate / depends:** G6 / after PC-BLND-01
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** TODO OWNER PC. Owner present and says go for the download. PowerShell 5.1.
- **Steps:**
  1. Run `curl.exe -sSL https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py -o addon.py`.
  2. Run `(Get-FileHash addon.py -Algorithm SHA256).Hash.ToLower()` and compare with the value in docs/BLENDER.md (starts eb0facf6, ends 97fa5).
  3. If it differs, record the PC's value and re-check `git log -1 -- addon.py` on a clone of the add-on repo.
  4. In Settings, Blender press Set up for the community add-on once; then Launch.
- **Expected:** The hash matches the pin. Set up installs the add-on into the user's Blender add-ons folder and enables it; Launch opens the socket (startExpr) without a click inside Blender; Test succeeds. Windows specifics: tar -xf on a .zip and a detached start work.
- **Evidence:** PC-BLND-12.log (hash value, Set up output).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-13: Official extension install on a real Blender 5.1+ and Test connection

- **Source:** claude/tracker-pc-checks.md B10; claude/plan-blender-local-first.md 6.3; docs/BLENDER.md Not verified yet (official backend); review/blender-merged-review.md M5, section 6 item 6
- **Gate / depends:** G6 / after PC-BLND-01
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** TODO OWNER PC. Blender 5.1 or newer, `uv` installed, network on, owner says go.
- **Steps:**
  1. Settings, Blender, Set up (official): watch ext-build, ext-repo, ext-install, verify.
  2. Check the repo id with `blender.exe --command extension repo-list` and that `--enable` persists after a Blender restart.
  3. Open Blender, start the server from the sidebar panel, press Test connection (first start downloads the server's Python packages).
  4. Note the exact output formats of `repo-list` and `extension list`.
- **Expected:** The built zip installs through install-file; the extension shows enabled; verify matches the right extension and version, not any line containing "mcp"; Test connection passes and a scene read works. If it fails, install through Blender's own Install from Disk and record the reason.
- **Evidence:** PC-BLND-13.log (command outputs), PC-BLND-13.png (Test result).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-14: Official backend: connect refuses without an execute tool; tool-name matching against the real server

- **Source:** docs/BLENDER.md Not verified yet (official backend tool names). **INFERRED:** Stated as unverified in docs/BLENDER.md; steps are the obvious way to see it.
- **Gate / depends:** G6 / after PC-BLND-13
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** BLND-13 passed; backend official, mode Live.
- **Steps:**
  1. Ask the Sculptor to read the scene (blender_inspect) and run a trivial script in Live mode after reading the card.
  2. Read the status panel for the matched tool names.
- **Expected:** Legion matches the real server's tools by name or readOnlyHint and runs; if no execute tool is found it refuses to connect and says why.
- **Evidence:** PC-BLND-14.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-15: Live mode against the community add-on in an open Blender

- **Source:** docs/BLENDER.md Not verified yet (community protocol, startExpr); docs/TESTING-BLENDER.md section 4
- **Gate / depends:** G6 / after PC-BLND-12
- **Safety / automation:** none / owner-must-be-present
- **Preconditions:** BLND-12 passed; Blender open with a throwaway scene. Never run on a Blender that holds work you care about (the add-on socket has no password).
- **Steps:**
  1. Mode Live. Ask the Sculptor for a cube. Read the approval card (full script) and Allow.
  2. Ask for a screenshot.
- **Expected:** Command names and the JSON protocol match the real add-on; the cube appears in the open Blender; the backup `.blend` is written before the change; screenshot returns.
- **Evidence:** PC-BLND-15.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-16: Approval card readability for a long script (human judgement)

- **Source:** docs/BLENDER.md Other (size of a script the card can show); docs/TESTING-BLENDER.md human-only judgement
- **Gate / depends:** G5 / after PC-BLND-03
- **Safety / automation:** none / owner-only
- **Preconditions:** A script of about 400 lines that passes the static check, containing a hidden character (zero-width) on one line.
- **Steps:**
  1. Have the Sculptor submit it; read the card: line numbers, scrolling, the hidden-character marker, the bot's purpose text labelled "not checked".
- **Expected:** The whole script can be read before clicking; line numbers and the hidden-character warning show; only D works from the keyboard for a Blender card (no A shortcut).
- **Evidence:** PC-BLND-16.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-17: Managed Blender: "Get Blender for Legion" pinned download, hash check, detection prefers it

- **Source:** claude/plan-blender-local-first.md section 11 (B4). **INFERRED:** Planned feature, not merged on this base. Run only if the build under test has the button; otherwise record "not applicable on this build".
- **Gate / depends:** G6 / after PC-BLND-01
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** Owner says go for a download of a few hundred MB. A build with the button. Disk space of 2 GB.
- **Steps:**
  1. Settings, Blender: click Get Blender for Legion; read the licence text and source link it shows; confirm the download.
  2. After extraction check <dataDir>\blender\app\<version>\ and that detection now lists the managed copy first.
  3. Click Open the Blender download page and read the winget command shown as text.
  4. Repeat with a deliberately wrong hash if a test hook exists (otherwise skip).
- **Expected:** One pinned official portable build is downloaded and the sha256 verified; licence text is kept in the folder; the user's own Blender install is untouched; the winget command is shown but never run; a hash mismatch installs nothing.
- **Evidence:** PC-BLND-17.png, PC-BLND-17.log (folder listing, hash).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-18: First-use chooser on the first Blender card: This computer / Cloud VM / Decide each time

- **Source:** claude/plan-blender-local-first.md section 12 (B5). **INFERRED:** Planned feature, not merged on this base; run only if present.
- **Gate / depends:** G5 / after PC-BLND-01
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Blender enabled, no mode ever saved (fresh config).
- **Steps:**
  1. Ask the Sculptor for a cube; look at the first card for the one-time chooser; click This computer.
  2. Ask again.
- **Expected:** The chooser shows once; the choice is saved as mode and clears the upgrade notice; the second card has no chooser; Allow/Deny work regardless.
- **Evidence:** PC-BLND-18.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-19: VM: Set up downloads and starts headless Blender for Linux in the boat.dev VM

- **Source:** docs/BLENDER.md Sandbox on a real boat.dev VM item 1; docs/TESTING-BLENDER.md section 4; claude/tracker-pc-checks.md B11
- **Gate / depends:** G7 / after PC-VM-05
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** boat.dev key, owner go for VM spend and the download inside the VM; Sculptor VM.
- **Steps:**
  1. Settings, Blender, Set up (VM); read the result; in the VM run `blender --version`.
- **Expected:** Blender 5.1 downloads, unpacks and starts; missing shared libraries (libGL, libXi, libXxf86vm, libXfixes, libXrender) are named if they fail.
- **Evidence:** PC-BLND-19.png, PC-BLND-19.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-20: VM: cube plus GLB comes back to blender-exports with the binary intact (also the exports.ts regression)

- **Source:** docs/BLENDER.md Sandbox item 2; claude/tracker-pc-checks.md B11
- **Gate / depends:** G7 / after PC-BLND-19
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** BLND-19 passed.
- **Steps:**
  1. Mode VM. Ask for a cube exported as GLB; Allow.
  2. Open the GLB in a viewer or compare its size and header (`glTF`) in PowerShell.
- **Expected:** The file is in <workspace>\blender-exports\<task>\ and valid (boat's file API returned base64 binary correctly); the VM-mode path still works after the exports.ts refactor.
- **Evidence:** PC-BLND-20.log (size, first 4 bytes).
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-21: VM: blender_screenshot renders a Cycles CPU preview within the timeout

- **Source:** docs/BLENDER.md Sandbox item 3
- **Gate / depends:** G7 / after PC-BLND-19
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** BLND-19 passed.
- **Steps:**
  1. Ask for a preview of a cube; time it.
- **Expected:** An 8-sample Cycles CPU preview returns within the timeout; record the time.
- **Evidence:** PC-BLND-21.png, time in PC-BLND-21.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-22: VM: the 600-second command limit and what happens at it

- **Source:** docs/BLENDER.md Sandbox item 4
- **Gate / depends:** G7 / after PC-BLND-19
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** BLND-19 passed. Owner accepts VM billing for about 12 minutes.
- **Steps:**
  1. Run a hand-written script that sleeps 700 s through the VM runner.
- **Expected:** RECORD: the command ends at the limit with a clear message; nothing hangs; the VM is left in a known state.
- **Evidence:** PC-BLND-22.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BLND-23: VM: two tasks keep separate scene.blend files; a second script sees the first one's result

- **Source:** docs/BLENDER.md Sandbox item 5
- **Gate / depends:** G7 / after PC-BLND-19
- **Safety / automation:** spends-money / owner-must-be-present
- **Preconditions:** BLND-19 passed.
- **Steps:**
  1. In task A add a cube; in task B add a sphere; in task A run a script that lists objects; in B the same.
- **Expected:** Task A lists only its cube (plus defaults), task B only its sphere; within a task the second script sees the first script's objects.
- **Evidence:** PC-BLND-23.log.
- **Result:** not-run | date: - | evidence path: -

### BSV testnet wallet in a VM (BSVT, 24 checks, gate G8)

#### PC-BSVT-00: V0: build the isolated testnet VM and prove the host wallet is not reachable from it

- **Source:** claude/plan-bsv-rung3.md 7.2 V0; claude/legion-release-tracker.md BSV scope change (Windows Sandbox not enabled)
- **Gate / depends:** G8 / after PC-INST-10
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** Owner at the keyboard. Windows Sandbox or a VM. Enabling Windows Sandbox needs an administrator PowerShell and a restart: `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`. BSV Desktop installed, set to TESTNET, wallet created and testnet coins obtained by the owner by hand (agents create no accounts or passwords).
- **Steps:**
  1. Build Legion from the reviewed commit inside the VM. No port forwarding to the host.
  2. Inside the VM try to connect to the host machine's address on the wallet's usual port (see docs/BSV-MODE.md for the number; connect only from the VM and only to see it FAIL).
  3. Check the VM's BSV Desktop network setting reads testnet.
- **Expected:** The host's own wallet is NOT reachable from the VM. The VM wallet is on testnet and funded with testnet coins. Nothing below is ever run on the host.
- **Evidence:** PC-BSVT-00.png (VM wallet network), PC-BSVT-00.log (connection refused/timeout).
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-01: V1 (gate before the spend module): ask the wallet for an unsigned transaction; nothing is prompted or broadcast

- **Source:** claude/plan-bsv-rung3.md 7.2 V1; claude/plan-bsv-rung3.md section 3 U1, U2, U7, U8
- **Gate / depends:** G8 / after PC-BSVT-00
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-00 passed. Throwaway testnet wallet. By hand, no Legion code.
- **Steps:**
  1. Using the wallet's own tooling or a small script run by the owner against the VM wallet, call createAction with signAndProcess false.
  2. Save a scrubbed sample (encoding, parents present, change shape, address version byte) as test fixture input for the decoder.
- **Expected:** The wallet returns a signable object with a reference, shows NO prompt and broadcasts nothing (U1). Record the tx encoding (BEEF or atomic BEEF; bytes, hex or base64) (U2), that change is one standard P2PKH output (U7) and the testnet address version byte (U8). If V1 fails: STOP and report (design section 10).
- **Evidence:** PC-BSVT-01.log (scrubbed sample, no keys).
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-02: V2 (gate): abort the unsigned reference; coins are spendable again

- **Source:** claude/plan-bsv-rung3.md 7.2 V2; claude/plan-bsv-rung3.md U3
- **Gate / depends:** G8 / after PC-BSVT-01
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-01 produced a reference.
- **Steps:**
  1. Call abortAction for that reference, then create another unsigned transaction for the same amount.
- **Expected:** abortAction releases the locked inputs (U3): the second request succeeds. If not, STOP and report.
- **Evidence:** PC-BSVT-02.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-03: V3 and status probe: connect to the VM wallet, bsv_status shows testnet, reachable, signed in

- **Source:** claude/plan-bsv-rung3.md 7.2 V3; claude/plan-bsv-rung3.md U8; docs/BSV-MODE.md Not verified; docs/BSV-WALLET-DESIGN.md section 11
- **Gate / depends:** G8 / after PC-BSVT-00
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** Spend-capable build running in the VM; BSV mode on.
- **Steps:**
  1. Open the BSV panel, type the wallet address, press Connect (a native confirmation appears; confirm).
  2. Ask the Assayer to run bsv_status.
  3. Watch the VM wallet for any permission prompt during the four status calls (getVersion, getNetwork, isAuthenticated, getHeight).
- **Expected:** testnet, reachable, signed in, version and height shown. RECORD: whether any status call prompted in the wallet, what the prompts said, the real response shapes (an unexpected shape must read as "network unknown", never testnet), whether network switching needs a wallet restart, and which origin rules apply.
- **Evidence:** PC-BSVT-03.png, PC-BSVT-03.log (response shapes, scrubbed).
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-04: V4: allowlist one testnet address through the native dialog

- **Source:** claude/plan-bsv-rung3.md 7.2 V4
- **Gate / depends:** G8 / after PC-BSVT-03
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-03 passed.
- **Steps:**
  1. In the BSV panel add the VM wallet's second address to the recipient allowlist; read the native dialog; confirm.
- **Expected:** A native dialog names the address; the list is saved only after confirm; Cancel saves nothing.
- **Evidence:** PC-BSVT-04.png (dialog).
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-05: V5: request 600 sat: dialog 1 and dialog 2, then the wallet's own prompt, then a txid

- **Source:** claude/plan-bsv-rung3.md 7.2 V5; claude/plan-bsv-rung3.md U4, U5, U10
- **Gate / depends:** G8 / after PC-BSVT-04
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-04 passed. Window visible.
- **Steps:**
  1. Ask the Assayer for 600 sat to the allowlisted address.
  2. Read dialog 1: amount 600 sat, FULL address, TESTNET, fee, caps. Confirm. Read dialog 2 (untrusted content). Confirm.
  3. Only now should the wallet show its prompt; approve it there.
  4. Open the txid in a testnet block explorer in a browser.
- **Expected:** Dialog 1 matches the request exactly; dialog 2 is a separate press; the wallet prompt appears only after both; a 64-hex txid is returned; the explorer shows one 600 sat output plus change. RECORD the real wallet prompt wording and the real Electron dialog look (wording, default button Cancel, focus, hidden-window case) (U10).
- **Evidence:** PC-BSVT-05-d1.png, PC-BSVT-05-d2.png, PC-BSVT-05-wallet.png, PC-BSVT-05-explorer.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-06: V6: a second request right after prompts the wallet again (no standing grant)

- **Source:** claude/plan-bsv-rung3.md 7.2 V6; claude/plan-bsv-rung3.md U4
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 passed.
- **Steps:**
  1. Immediately ask for another spend and confirm both Legion dialogs.
  2. Watch the wallet.
- **Expected:** The wallet prompts again. If a persistent-permission option ("always allow", monthly limit) is offered, DECLINE it and record it; if it cannot be avoided report a blocker (design section 10).
- **Evidence:** PC-BSVT-06.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-07: V7: Cancel at Legion's dialog: no wallet prompt, reservation freed

- **Source:** claude/plan-bsv-rung3.md 7.2 V7; claude/plan-bsv-rung3.md U3
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 passed.
- **Steps:**
  1. Ask for a spend; press Cancel in dialog 1; ask again for the same amount.
- **Expected:** No wallet prompt on the cancelled request; the reservation is released (abort released the coins) so the next identical request proceeds.
- **Evidence:** PC-BSVT-07.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-08: V8: Deny at the wallet's prompt: record what the wallet returns; Legion shows unknown

- **Source:** claude/plan-bsv-rung3.md 7.2 V8; claude/plan-bsv-rung3.md U6
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 passed.
- **Steps:**
  1. Ask for a spend; confirm both Legion dialogs; press Deny in the WALLET.
  2. Read Legion's status; resolve the unknown outcome in the native dialog after reading the wallet history.
- **Expected:** Legion shows unknown (unless a reviewed mapping exists) and blocks further spends until you resolve it natively. RECORD exactly what the wallet returned on Deny (U6).
- **Evidence:** PC-BSVT-08.png, PC-BSVT-08.log (wallet reply, scrubbed).
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-09: V9: kill the wallet during its prompt: unknown, still blocked after a Legion restart

- **Source:** claude/plan-bsv-rung3.md 7.2 V9; claude/plan-bsv-rung3.md C12
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 passed. Kill by PID only (never by name pattern).
- **Steps:**
  1. Start a spend and confirm both dialogs; while the wallet prompt is showing end the wallet process by its PID.
  2. Restart Legion; try another spend.
  3. Resolve the unknown natively; try again.
- **Expected:** unknown; after restart spends are still blocked (the unknown outcome is rebuilt from the audit); after the native resolve spends work again.
- **Evidence:** PC-BSVT-09.png, PC-BSVT-09.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-10: V10: over-cap amount and a non-allowlisted address are denied before any dialog

- **Source:** claude/plan-bsv-rung3.md 7.2 V10
- **Gate / depends:** G8 / after PC-BSVT-04
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-04 passed.
- **Steps:**
  1. Ask for 1,001 sat to the allowlisted address; ask for 600 sat to a different address.
- **Expected:** Both are denied before any dialog; the wallet shows nothing.
- **Evidence:** PC-BSVT-10.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-11: V11: Freeze while dialog 1 is open: the answer is refused, no wallet prompt

- **Source:** claude/plan-bsv-rung3.md 7.2 V11
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 passed.
- **Steps:**
  1. Ask for a spend; with dialog 1 showing use the tray item Freeze BSV chain (or Freeze chain in the panel); then answer the dialog.
- **Expected:** The answer is refused; no wallet prompt appears. Freeze and Disarm need no dialog (one click).
- **Evidence:** PC-BSVT-11.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-12: V12: a hand-edited bsv.walletUrl in config.json is ignored

- **Source:** claude/plan-bsv-rung3.md 7.2 V12; review/bsv-t1-review.md P3
- **Gate / depends:** G8 / after PC-BSVT-03
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-03 passed.
- **Steps:**
  1. Quit Legion, edit bsv.walletUrl in config.json to another loopback address, start Legion.
- **Expected:** The edited address is not contacted; the panel asks for Connect again.
- **Evidence:** PC-BSVT-12.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-13: Record the real wallet prompt wording and any persistent-permission option

- **Source:** claude/plan-bsv-rung3.md 7.2 (Also record); docs/BSV-WALLET-DESIGN.md section 10 stop condition
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-05 to BSVT-08 in progress.
- **Steps:**
  1. Photograph each wallet prompt; read every checkbox and button.
- **Expected:** Wording copied into the docs; no "always allow"/monthly limit is ticked. If silent prompts or persistent grants exist, STOP and report that rung 3 should wait.
- **Evidence:** PC-BSVT-13.png set.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-14: U9: a spend left unanswered past 100 s returns pending, and the flow still finishes

- **Source:** claude/plan-bsv-rung3.md section 3 U9; claude/plan-bsv-rung3.md 2.2. **INFERRED:** U9 is listed as unverified; the observation is the one the plan gives.
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 passed.
- **Steps:**
  1. Ask for a spend and wait 110 seconds before touching dialog 1.
  2. Re-call the same request with the same key; then answer the dialogs.
- **Expected:** The tool returns pending-owner after about 100 s; the same key returns the current state; the flow completes when answered.
- **Evidence:** PC-BSVT-14.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-15: Native dialogs for policy changes: Connect, Arm, Unfreeze, caps and allowlist; Freeze and Disarm need none

- **Source:** docs/BSV-MODE.md (the interface); docs/BSV-WALLET-DESIGN.md section 11 (Electron dialogs on a real desktop)
- **Gate / depends:** G8 / after PC-BSVT-03
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-03 passed.
- **Steps:**
  1. Do each action in the BSV panel; photograph the dialog; press Cancel and Escape once each.
- **Expected:** Each of Connect, allowlist, caps, Arm and Unfreeze shows a native dialog that defaults to Cancel; Cancel and Escape change nothing; Freeze and Disarm act with one click.
- **Evidence:** PC-BSVT-15-<action>.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-16: Dialogs with the window hidden to the tray, and Windows taskkill/netstat behaviour

- **Source:** docs/BSV-WALLET-DESIGN.md section 11 (Windows specifics)
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 prerequisites.
- **Steps:**
  1. Start a spend request, hide the window to the tray, and see where the dialog appears and whether it can be answered.
  2. Check `netstat -ano` for the core's port and that taskkill by PID ends Legion's core.
- **Expected:** The dialog is still visible and answerable (or the request times out safely); netstat and taskkill behave as the notes assume.
- **Evidence:** PC-BSVT-16.png, PC-BSVT-16.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-17: window.legion.bsvPolicy survives the real sandboxed preload

- **Source:** docs/BSV-WALLET-DESIGN.md section 11
- **Gate / depends:** G8 / after PC-APP-14
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** A real Electron build with the BSV bridge.
- **Steps:**
  1. In DevTools (source checkout run) evaluate `typeof window.legion.bsvPolicy`, then perform one Cancel-only action from the panel.
- **Expected:** The bridge exists in the real preload exactly as the emulation shows; actions reach the native dialog code.
- **Evidence:** PC-BSVT-17.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-18: BSV panel and title-bar display on a real GPU: TESTNET readout, block height, static UI

- **Source:** docs/BSV-MODE.md (the interface); test/bsv-ui-view.test.ts (static by design). **INFERRED:** Visual claim from the docs; unit tests only cover the view logic.
- **Gate / depends:** G8 / after PC-BSVT-03
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-03 passed.
- **Steps:**
  1. Look at the title bar line, the readout (TESTNET, block N), the panel and the Activity list; leave it 2 minutes and watch for animation.
- **Expected:** A calm cyan line and text readout; nothing animates; the status poll updates only when an answer changes; Activity shows the audit verification status; Save log as file works.
- **Evidence:** PC-BSVT-18.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-19: Kill Legion mid-spend: restart keeps the unknown outcome and quarantines a torn audit line

- **Source:** review/bsv-t1-review.md gap hunt (torn last audit line); claude/plan-bsv-rung3.md C12. **INFERRED:** Review describes the behaviour from tests on Linux; Windows file behaviour after a hard kill is the new part.
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** native-dialog / owner-only
- **Preconditions:** BSVT-05 passed. Kill by PID only.
- **Steps:**
  1. Start a spend, confirm both dialogs, end Legion's core process while the wallet prompt is showing; restart.
  2. Open the BSV panel Activity list.
- **Expected:** The spend shows unknown and spends stay blocked; the audit log verifies (a torn last line is reported and the file quarantined on the next append).
- **Evidence:** PC-BSVT-19.png, PC-BSVT-19.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-20: Same wallet product port check: does BSV Desktop and the HandCash BRC wallet use the same port (VM only)

- **Source:** docs/BSV-WALLET-DESIGN.md section 11 (port question). **INFERRED:** A documented open question; only answerable by installing both wallets in the VM.
- **Gate / depends:** G8 / after PC-BSVT-00
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-00 VM; owner installs a second wallet inside the VM only if wanted.
- **Steps:**
  1. In the VM run `netstat -ano | findstr LISTEN` with each wallet running and note its port.
- **Expected:** RECORD the ports. Docs say both use the same port (unconfirmed).
- **Evidence:** PC-BSVT-20.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-21: Testnet runs request a spend only when the owner started them in the app

- **Source:** claude/plan-bsv-rung3.md 9 open question 2; claude/legion-release-tracker.md BSV scope change. **INFERRED:** Decision made; the observation with a real MCP-started or room-woken run is not listed anywhere.
- **Gate / depends:** G8 / after PC-BSVT-04, PC-MCP-05
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-04 passed; an MCP client (Claude Code) registered (MCP-05).
- **Steps:**
  1. From Claude Code start an Assayer run through legion_run that asks for a spend.
  2. Then ask in a room so a bot wakes the Assayer to request one.
- **Expected:** Both are refused (denied) with no dialog and no wallet contact.
- **Evidence:** PC-BSVT-21.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-22: A wallet claiming mainnet is warned about and refused while Legion's mainnet switch is off

- **Source:** claude/plan-bsv-rung3.md 12.6a (flip tests only prove Legion's gates); docs/BSV-MODE.md (mainnet wallet shows the warning pill). **INFERRED:** Needs a mainnet-configured wallet; do it only with a second, EMPTY mainnet wallet inside the VM (never the owner's funded wallet).
- **Gate / depends:** G8 / after PC-BSVT-05
- **Safety / automation:** real-wallet / owner-only
- **Preconditions:** BSVT-00 VM with a second, empty wallet set to mainnet. No funds.
- **Steps:**
  1. Connect Legion to the empty mainnet wallet; run bsv_status; request a spend.
- **Expected:** A warning pill appears; the request is denied as mainnet-disabled with no wallet prompt and an audit denied line naming the network.
- **Evidence:** PC-BSVT-22.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVT-23: Record dated results of V0-V12 in the tracker and mark the unverified list U1-U14 confirmed or open

- **Source:** claude/plan-bsv-rung3.md 7.2 (results go to tracker); claude/plan-bsv-rung3.md 10 (docs mark U1-U10 confirmed or open)
- **Gate / depends:** G8 / after PC-BSVT-12
- **Safety / automation:** none / owner-only
- **Preconditions:** BSVT-00 to BSVT-22 run.
- **Steps:**
  1. Update this plan's result fields and claude/tracker-pc-checks.md; list U1-U10 as confirmed or open in docs/BSV-MODE.md "Not verified".
- **Expected:** Every U item has a recorded status; docs say "has not been verified with real funds" until BSVM is recorded.
- **Evidence:** The updated results file.
- **Result:** not-run | date: - | evidence path: -

### BSV mainnet real funds (BSVM, 14 checks, gate G11)

#### PC-BSVM-00: R preconditions: V1-V12 passed, review signed off, reviewed commit, own mainnet address

- **Source:** claude/plan-bsv-rung3.md 12.6b (preconditions); claude/legion-release-tracker.md BSV scope change
- **Gate / depends:** G11 / after PC-BSVT-12
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** OWNER ONLY, BY HAND, NEVER SCRIPTED, NEVER BY AN AGENT. Owner says "go" in this session. No agent drives the keyboard.
- **Steps:**
  1. Record that BSVT-01 to BSVT-12 passed and the independent review signed off the spend module, per-network policy and the dialogs.
  2. Build Legion from the reviewed commit.
  3. Have a second mainnet receive address of the OWNER'S OWN ready (net cost is then only the fee). Amount: 200 sat (0.00000200 BSV); mainnet caps at defaults.
- **Expected:** All preconditions are written down with the commit id before anything else starts.
- **Evidence:** PC-BSVM-00.txt (commit id, who watched).
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-01: R0: note balance and history; Legion shows the switch OFF and not armed

- **Source:** claude/plan-bsv-rung3.md 12.6b R0
- **Gate / depends:** G11 / after PC-BSVM-00
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-00 recorded.
- **Steps:**
  1. In the wallet's own UI note the balance and history.
  2. Open Legion's BSV panel.
- **Expected:** Mainnet switch OFF, not armed.
- **Evidence:** PC-BSVM-01.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-02: R1: connect to the real wallet and ask for 200 sat: denied mainnet-disabled, no wallet prompt

- **Source:** claude/plan-bsv-rung3.md 12.6b R1
- **Gate / depends:** G11 / after PC-BSVM-01
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-01.
- **Steps:**
  1. In the panel use Connect with the real wallet's address (typed by the owner; confirm the native dialog).
  2. Ask the Assayer for 200 sat.
- **Expected:** Denied mainnet-disabled; NO wallet prompt; the audit shows a denied line with net main.
- **Evidence:** PC-BSVM-02.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-03: R2: enable mainnet through the native dialog

- **Source:** claude/plan-bsv-rung3.md 12.6b R2
- **Gate / depends:** G11 / after PC-BSVM-02
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-02.
- **Steps:**
  1. Enable mainnet; read the dialog; confirm.
- **Expected:** Panel: enabled, not armed.
- **Evidence:** PC-BSVM-03.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-04: R3: allowlist the own address on the mainnet list; ask again: denied not-armed

- **Source:** claude/plan-bsv-rung3.md 12.6b R3
- **Gate / depends:** G11 / after PC-BSVM-03
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-03.
- **Steps:**
  1. Add the own mainnet address to the mainnet allowlist (native dialog); ask for 200 sat again.
- **Expected:** Denied not-armed; no wallet prompt.
- **Evidence:** PC-BSVM-04.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-05: R4: Arm for 5 minutes; compare dialogs character by character against the wallet

- **Source:** claude/plan-bsv-rung3.md 12.6b R4
- **Gate / depends:** G11 / after PC-BSVM-04
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-04.
- **Steps:**
  1. Arm for 5 minutes (read the LIVE FUNDS dialog); ask again.
  2. Compare D1 and D2 (and D3 if tainted): amount, network word, the FULL address character by character against the wallet, and the caps.
- **Expected:** The dialogs match the table exactly. ABORT at once (Freeze, Disable, no retry, record) if the amount, the network word or any character of the address differs.
- **Evidence:** PC-BSVM-05.png set.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-06: R5: Cancel on dialog 2: declined, no wallet prompt, still armed

- **Source:** claude/plan-bsv-rung3.md 12.6b R5
- **Gate / depends:** G11 / after PC-BSVM-05
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-05.
- **Steps:**
  1. Press Cancel on D2.
- **Expected:** Declined; no wallet prompt; reservation freed; still armed.
- **Evidence:** PC-BSVM-06.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-07: R6: confirm D1 and D2; the wallet shows its own prompt (200 sat, recipient, ONE payment output)

- **Source:** claude/plan-bsv-rung3.md 12.6b R6; claude/plan-bsv-rung3.md U13
- **Gate / depends:** G11 / after PC-BSVM-06
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-06.
- **Steps:**
  1. Ask again; confirm D1 and D2; read the wallet prompt; approve there only if all match.
- **Expected:** The wallet prompt appears after both dialogs and shows 200 sat, the recipient and exactly one payment output. ABORT if the prompt comes earlier, shows another amount or recipient or more outputs, offers "always allow" or a monthly limit (do not tick it), or does not appear at all (U13).
- **Evidence:** PC-BSVM-07.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-08: R7: read the result; the txid and the explorer show 200 sat to the own address; balance fell by the fee only

- **Source:** claude/plan-bsv-rung3.md 12.6b R7; claude/plan-bsv-rung3.md U14
- **Gate / depends:** G11 / after PC-BSVM-07
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-07.
- **Steps:**
  1. Read the returned txid (64 hex); open it in a mainnet explorer in a browser; compare the wallet balance.
- **Expected:** One 200 sat output to the own address plus change; balance fell by the fee only; fee at most 100 sat. RECORD the real fee (U14).
- **Evidence:** PC-BSVM-08.png (txid shortened to a prefix).
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-09: R8: ask once more: denied not-armed (one arm, one spend)

- **Source:** claude/plan-bsv-rung3.md 12.6b R8
- **Gate / depends:** G11 / after PC-BSVM-08
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-08.
- **Steps:**
  1. Ask for 200 sat again.
- **Expected:** Denied not-armed; no wallet prompt.
- **Evidence:** PC-BSVM-09.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-10: R9: Decline in the WALLET: unknown, switch goes off (auto-off), resolve natively

- **Source:** claude/plan-bsv-rung3.md 12.6b R9
- **Gate / depends:** G11 / after PC-BSVM-09
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-09.
- **Steps:**
  1. Arm, ask, confirm D1 and D2, then Decline in the wallet.
  2. Read the wallet history and resolve in Legion ("NOT sent").
- **Expected:** Legion shows unknown and the mainnet switch is off.
- **Evidence:** PC-BSVM-10.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-11: R10: Freeze while dialog 1 is open: refused, no wallet prompt

- **Source:** claude/plan-bsv-rung3.md 12.6b R10
- **Gate / depends:** G11 / after PC-BSVM-10
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-10.
- **Steps:**
  1. Enable, arm, ask; press Freeze while D1 is open; answer D1.
- **Expected:** The dialog answer is refused; no wallet prompt.
- **Evidence:** PC-BSVM-11.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-12: R11: Disable mainnet, Disarm, Disconnect; record dated results

- **Source:** claude/plan-bsv-rung3.md 12.6b R11
- **Gate / depends:** G11 / after PC-BSVM-11
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** PC-BSVM-11.
- **Steps:**
  1. Disable mainnet, Disarm, Disconnect.
  2. Read the audit lines for R1 to R10 and record dated results in claude/tracker-pc-checks.md and in this plan.
- **Expected:** Panel shows off. Until R0-R11 are recorded every document says "has not been verified with real funds".
- **Evidence:** PC-BSVM-12.txt.
- **Result:** not-run | date: - | evidence path: -

#### PC-BSVM-13: Record U11 (mainnet network string), U12 (unsigned tx shape and P2PKH change), U13 (prompt every time), U14 (fee levels)

- **Source:** claude/plan-bsv-rung3.md section 12 (U11 to U14)
- **Gate / depends:** G11 / after PC-BSVM-08
- **Safety / automation:** real-funds / owner-only
- **Preconditions:** While doing R1 to R8.
- **Steps:**
  1. Note the wallet's mainnet network string answer, the shape of the unsigned transaction and change, whether the wallet prompted every time, and the fee.
- **Expected:** Each of U11 to U14 is marked confirmed or open; the mainnet fee ceiling is revisited from the real fee.
- **Evidence:** PC-BSVM-13.txt.
- **Result:** not-run | date: - | evidence path: -

### Website and public install (WEB, 5 checks, gate G10)

#### PC-WEB-01: The install command on the site works on a clean Windows PC once the repo is public

- **Source:** claude/legion-release-tracker.md Website (install command must be re-verified once the repo is public)
- **Gate / depends:** G10 / after PC-INST-10
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** Product repo public, site deployed. A clean Windows 10/11 user or VM with Node installed and no earlier Legion. Owner go for downloads.
- **Steps:**
  1. Copy the install command from the site hero exactly as shown. Paste it into the shell the site names.
  2. After it finishes launch Legion from the new shortcut; open Doctor.
- **Expected:** The command installs the build the README describes, with no placeholder text (such as OWNER) and no step missing. The Instructions and GitHub links work.
- **Evidence:** PC-WEB-01.png, PC-WEB-01.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-WEB-02: Install from a downloaded ZIP of the public repo and from git clone

- **Source:** claude/legion-release-tracker.md Website; claude/tracker-pc-checks.md P7
- **Gate / depends:** G10 / after PC-INST-08
- **Safety / automation:** downloads / owner-must-be-present
- **Preconditions:** Public repo.
- **Steps:**
  1. Download ZIP; unpack; double-click setup.cmd. Then `git clone` and run setup.cmd from the clone.
- **Expected:** Both routes install (see INST-08 for line endings; INST-09 for prompts).
- **Evidence:** PC-WEB-02.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-WEB-03: Public repo links and package metadata have no OWNER placeholder

- **Source:** package.json (homepage, repository, bugs say OWNER on integration/v1); claude/legion-release-tracker.md item G. **INFERRED:** Not a PC-only check; recorded so it is not lost: package.json on integration/v1 still shows OWNER/legion until the docs branch merges.
- **Gate / depends:** G10
- **Safety / automation:** none / command-only
- **Preconditions:** Docs branch merged.
- **Steps:**
  1. Run `Select-String -Path package.json,README.md,CHANGELOG.md -Pattern "OWNER/"`.
  2. Click the README badges and CHANGELOG compare links.
- **Expected:** No OWNER/ placeholders; all links resolve to dnh33/legion (or the final public name).
- **Evidence:** PC-WEB-03.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-WEB-04: Public repo settings: secret scanning and push protection on, private vulnerability reporting enabled

- **Source:** claude/tracker-public-audit.md (go public after: secret scanning); claude/legion-release-tracker.md item G
- **Gate / depends:** G10
- **Safety / automation:** account / owner-only
- **Preconditions:** Owner logged in to GitHub.
- **Steps:**
  1. Settings, Code security: enable secret scanning and push protection and private vulnerability reporting.
- **Expected:** All three show enabled. Owner decides the BSV pack NOTICE wording (L5) and accepts H4/H5 before going public.
- **Evidence:** PC-WEB-04.png.
- **Result:** not-run | date: - | evidence path: -

#### PC-WEB-05: Deployed site: Lighthouse score at least 95 and the screenshots are the current UI

- **Source:** claude/legion-release-tracker.md Website (Lighthouse >= 95; screenshots swappable after item G phase 2)
- **Gate / depends:** G10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Site deployed; Chrome.
- **Steps:**
  1. Run Lighthouse (Chrome DevTools) on desktop and mobile for the home page; compare the site screenshots with the real UI.
- **Expected:** Performance, accessibility, best practices and SEO at least 95; screenshots match the shipped UI.
- **Evidence:** PC-WEB-05.png (Lighthouse), PC-WEB-05-shots.png.
- **Result:** not-run | date: - | evidence path: -

### Perf and regression (PERF, 7 checks, gate G9)

#### PC-PERF-01: Full gate on Windows: npm ci, build:ts, test, typecheck, build:ui with exact counts

- **Source:** CLAUDE.md Gates; claude/legion-release-tracker.md W0 and status updates (reference 1552 tests / 1517 pass / 0 fail / 35 skip)
- **Gate / depends:** G9
- **Safety / automation:** downloads / command-only
- **Preconditions:** Clean checkout of the build under test; owner go for npm ci downloads. PowerShell present so the "real PowerShell" tests run instead of skipping.
- **Steps:**
  1. Run `npm ci; npm run build:ts; npm test; npm run typecheck; npm run build:ui` and capture the summary lines.
- **Expected:** All commands exit 0. Record tests / pass / fail / skipped and which tests skipped and why.
- **Evidence:** PC-PERF-01.log (summary lines).
- **Result:** not-run | date: - | evidence path: -

#### PC-PERF-02: R6.1 replay fidelity test, repeated, to see whether the flake is gone

- **Source:** claude/legion-release-tracker.md Open item R6.1
- **Gate / depends:** G9 / after PC-PERF-01
- **Safety / automation:** none / command-only
- **Preconditions:** Built tree (npm run build:ts).
- **Steps:**
  1. Run `1..30 | ForEach-Object { node --test dist/test/library-review-integrity.test.js; $LASTEXITCODE }` and count non-zero exits.
- **Expected:** 30 of 30 pass. A failure prints which part differs (nodes, edges, search, inbox). Then run one scratch mutation of the replay code and confirm the test goes red (the mutation check was never done), and revert.
- **Evidence:** PC-PERF-02.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-PERF-03: kg-routes test, repeated on Windows

- **Source:** task brief (R6.1/kg-routes flakes). **INFERRED:** The brief names a kg-routes flake; no document in the repo describes it. Check test/kg-routes.test.ts and the Windows baseline notes.
- **Gate / depends:** G9 / after PC-PERF-01
- **Safety / automation:** none / command-only
- **Preconditions:** Built tree.
- **Steps:**
  1. Run `1..30 | ForEach-Object { node --test dist/test/kg-routes.test.js; $LASTEXITCODE }`.
- **Expected:** 30 of 30 pass; any failure is recorded with its message.
- **Evidence:** PC-PERF-03.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-PERF-04: Perf re-record on the PC: core bench, UI idle and mascot cost, chat, lattice, with the busy ring on

- **Source:** claude/legion-release-tracker.md handoff (perf re-record); claude/legion-release-tracker.md decision 6 (busy ring: re-measure in the sweep)
- **Gate / depends:** G9 / after PC-INST-10
- **Safety / automation:** none / command-only
- **Preconditions:** Idle PC on AC power, no other apps. The scripts in test-perf/ use Linux paths (/tmp/m, /opt/node-tools) and need Playwright: adapt paths first and note every change. Never point them at a real wallet (they refuse that port).
- **Steps:**
  1. `node test-perf/core/bench.mjs` with DIST set to the built dist.
  2. Run test-perf/ui-app/mascot-perf.mjs, idle-busy checks (idle-alive.mjs, smoke.mjs), test-perf/chat-ui/perf.mjs and test-perf/lattice/measure.mjs against the installed build's dist and dist-ui.
  3. Compare with the numbers in test-perf/ui-app/results/*.txt.
- **Expected:** RECORD numbers; flag any metric worse than the stored results by more than 20 percent (INFERRED threshold). The busy ring on rail avatars stays acceptable.
- **Evidence:** PC-PERF-04.json (script outputs).
- **Result:** not-run | date: - | evidence path: -

#### PC-PERF-05: scrubSecrets timing on Windows for the token, secret_eq and http shapes

- **Source:** claude/legion-release-tracker.md Follow-ups (scrubSecrets quadratic: 0.1 s at 20k chars, 1.7 s at 80k)
- **Gate / depends:** G9 / after PC-PERF-01
- **Safety / automation:** none / command-only
- **Preconditions:** Built tree.
- **Steps:**
  1. Run the Windows R3.4 scaling test (`node --test dist/test/library-review2-scrub.test.js dist/test/comms-scrub.test.js`) and, if a timing print exists, record the 20k and 80k character times.
- **Expected:** Tests pass; record times so the planned linear-scan fix can be compared.
- **Evidence:** PC-PERF-05.log.
- **Result:** not-run | date: - | evidence path: -

#### PC-PERF-06: Regenerate docs screenshots on the PC if the cloud has no browser

- **Source:** claude/legion-release-tracker.md item G (fallback: capture on the PC with the Playwright harnesses under test-perf/). **INFERRED:** Conditional on the cloud having no browser; item G phase 2 is not done on this base.
- **Gate / depends:** G9 / after PC-INST-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Only if item G phase 2 could not do it. The Zealot art is photographed only, never edited.
- **Steps:**
  1. Run the screenshot scripts (test-perf/ui-app/titlebar-shots.mjs, vm-shots.mjs, chat-ui/shots.mjs, bsv-ui/shots.mjs) into a scratch folder; compare with docs/images and docs/screenshots at full size.
- **Expected:** Light and dark screenshots match the real UI at README sizes.
- **Evidence:** PC-PERF-06 folder of PNGs.
- **Result:** not-run | date: - | evidence path: -

#### PC-PERF-07: Idle CPU/GPU of the real Electron app with the mascot animating

- **Source:** docs/MASCOT-NOTES.md; test-perf/ui-app (idle-busy, draws, smil checks). **INFERRED:** The perf scripts measure headless Chromium; the real Electron window on a real GPU is not covered.
- **Gate / depends:** G9 / after PC-INST-10
- **Safety / automation:** none / computer-use-ok
- **Preconditions:** Installed app, window visible and focused, then hidden to tray.
- **Steps:**
  1. Open Task Manager, Details; read the CPU and GPU engine columns of the Legion Electron processes for 60 s with the window visible, minimised and hidden.
- **Expected:** RECORD figures; idle should be near zero while hidden and low while visible; the BSV UI adds no animation.
- **Evidence:** PC-PERF-07.png.
- **Result:** not-run | date: - | evidence path: -

<!-- END GENERATED CHECKS -->

## 7. Counts

| Area | Checks | of which INFERRED |
|---|---|---|
| INST Installer | 16 | 3 |
| APP Core and app shell | 14 | 5 |
| CHAT Chat, Rooms and Library | 7 | 5 |
| MCP MCP | 9 | 3 |
| VM VM and boat.dev | 9 | 3 |
| BLND Blender (local, live, VM, managed, extension) | 23 | 5 |
| BSVT BSV testnet wallet in a VM | 24 | 6 |
| BSVM BSV mainnet real funds | 14 | 0 |
| WEB Website and public install | 5 | 1 |
| PERF Perf and regression | 7 | 3 |
| **Total** | **128** | **34** |

| Safety class | Checks |
|---|---|
| downloads | 13 |
| none | 48 |
| account | 21 |
| spends-money | 10 |
| real-wallet | 11 |
| native-dialog | 11 |
| real-funds | 14 |

| Automation class | Checks |
|---|---|
| owner-must-be-present | 38 |
| command-only | 25 |
| computer-use-ok | 24 |
| owner-only | 41 |

## 8. Sources scanned

| Source | What was taken from it |
|---|---|
| claude/tracker-pc-checks.md | P1-P10, M1-M3, K1, U1, R1, handoff line (also the Blender B1-B11 variant on origin/claude/review-blender-merged) |
| claude/legion-release-tracker.md | decisions, handoff list, R6.1 flake, scrubSecrets follow-up, Legion MCP registration, website, BSV scope, status updates |
| claude/plan-bsv-rung3.md | section 3 (U1-U10), 7.2 (V0-V12), 12 (U11-U14, R0-R11), 13 |
| claude/plan-blender-local-first.md | 6.2, 6.3, 11 (B4 managed Blender), 12 (B5 chooser) |
| claude/tracker-public-audit.md | public-repo owner steps (secret scanning, L5) |
| claude/release-notes-skeleton.md | unverified statements in the draft notes |
| origin/claude/review-release-packaging: review/release-packaging-review.md | F1-F9, section 5 |
| origin/claude/review-mcp-isolation: review/mcp-isolation-review.md | F1-F5, self-MCP variants |
| origin/claude/review-rooms-probe-upgrade: review/rooms-probe-upgrade-review.md | R1, K1, U1, polish |
| origin/claude/review-blender-merged: review/blender-merged-review.md | B1, M1-M5, L1-L9, section 6 |
| origin/claude/review-bsv-t1: review/bsv-t1-review.md | F1, gap hunt, polish |
| origin/claude/test-harness: docs/TESTING.md, TESTING-BLENDER.md, TESTING-BSV.md | what only a real PC can verify, owner-only lists |
| docs/BLENDER.md | Not verified yet |
| docs/BSV-MODE.md | Not verified, interface |
| docs/BSV-WALLET-DESIGN.md | section 10, 11, 12 |
| docs/VM-NOTES.md | Not verified against the real boat.dev |
| docs/ARCHITECTURE.md | Electron shell, MCP bridge, UI |
| docs/CHAT.md, LIBRARY.md, COMMS-BRIDGE.md, KG-NOTES.md, KNOWLEDGE-GRAPH.md, LATTICE-UI-NOTES.md, MASCOT-NOTES.md, ROOMS-UI-NOTES.md, COMMS-NOTES.md | grepped for not verified, Windows, real-device claims; only CHAT and LIBRARY gave checks |
| SECURITY.md, README.md, CHANGELOG.md, CONTRIBUTING.md | status block, install, unverified statements, claims |
| src/ and ui/src code comments and messages | grepped for UNVERIFIED, TODO OWNER PC, "not yet tried" (sandbox.ts, Settings.tsx, shared/blender.ts) |
| scripts/setup.ps1, setup.cmd, setup-yes.cmd, .github/workflows/ci.yml | read for what the Windows CI job already covers |
| test-perf/** | read headers for commands and Linux-only paths |
| origin/claude/bsv-t5-mainnet, bsv-t1-plumbing, bsv-t3-native-ui, blender-b1..b3, docs-release-ready-1, mcp-isolation, release-packaging, rooms-probe-upgrade | branch lists only; no review report exists for bsv-t5-mainnet, bsv-t3-native-ui or docs-release-ready-1 yet |

## 9. De-duplication notes

Merged (each keeps every source in its `source` field):
- Installer P1 and review F4 and section 5 item 1 became INST-01 and INST-02 (setup.cmd and setup-yes.cmd are separate behaviours).
- Blender tracker B1 to B11 (tracker variant on `claude/review-blender-merged`), plan 6.2 items 1 to 8, plan 6.3 and review section 6 items 1 to 8 are the same list; they became BLND-01, 03 to 09, 12, 13, 19 and 20 (plus the review-only and docs-only checks BLND-02, 10, 11, 14 to 18 and 21 to 23).
- BSV V0 to V12 stayed one check each because each has its own expected observation; U1 to U14 are recorded inside the checks that expose them (they are listed in the `expected` text, not as separate checks) except U9 (BSVT-14), U10 and wallet-prompt wording (BSVT-05, 13) and U11 to U14 (BSVM-13).
- The real-funds steps R0 to R11 are BSVM-01 to BSVM-12, with BSVM-00 for the preconditions and BSVM-13 for U11 to U14.
- Tracker K1 became VM-01 and VM-02 (core start, and first use / Settings open); U1 became APP-09 and VM-06; R1 became CHAT-01.

## 10. What could not be traced, and what is imperfect

Not traced to any source (so not invented; see the INFERRED flags):
- **Sentinel schedule** (APP-12): the handoff names it but no scheduler exists in `src/` (only the Sentinel persona text). The owner must say what it is before the check can be run.
- **kg-routes flake** (PERF-03): the brief names it; no repo document describes it. The check is a repeat run of `test/kg-routes.test.ts`.
- **Windows baseline numbers** (1552 / 1517 / 0 / 35) come from the tracker; they could not be reproduced here.
- No review report exists yet for `claude/bsv-t5-mainnet`, `claude/bsv-t3-native-ui` or `claude/docs-release-ready-1`; the spend module (T2), managed Blender (B4) and the first-use chooser (B5) are not built on this base. BSVT and BSVM steps follow the plan text; BLND-17 and BLND-18 are conditional on those features being present.
- The review reports on the `claude/review-*` branches were written against older bases than `integration/v1`; findings that were fixed since (F1, F2, F4 and others in the release-packaging review) are written as "after the fix" checks and may already pass.

Imperfect:
- Nothing was run; every step is a plan. Exact button labels were taken from the UI source and docs where I could find them (Settings, tray, panel buttons); some steps (Blender Set up, Arm, the dialogs) use names from docs and may differ slightly on the real build.
- The `test-perf/` scripts use Linux paths (`/tmp/m`, `/opt/node-tools`) and a Playwright install; PERF-04 and PERF-06 say to adapt them, which is manual work.
- The 20 percent regression threshold in PERF-04 is mine (INFERRED), not from a source.
- Evidence and results are by convention (a folder outside the repo, a JSON file); nothing enforces them. `pc-report.mjs` checks the plan and the results file shape, not the evidence.
- Some checks need a test account or a second Windows version (spaces and non-ASCII names, OneDrive Known Folder Move); the owner may mark them `skip`.
- Not PC checks, tracked elsewhere: the BSV pack NOTICE wording (L5), item G docs and screenshots, the Legion code-review ultra gate, and the weekly usage limit. WEB-03 and WEB-04 are included only so they are not lost.
