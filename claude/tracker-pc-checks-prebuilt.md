# PC checks: the prebuilt Windows package (build, clean install, run, MCP proxy, update, uninstall)

For the orchestrator on the owner's Windows PC (x64). Nothing here was run on Windows by the cloud session; see `claude/plan-prebuilt.md` section 12 for what only these checks prove. Plain rules: no keys, tokens or `.legion` data in reports (redact to a short prefix); never touch the owner's BSV wallet port; do not create accounts; the owner's go-ahead is needed for anything that uses their Claude sign-in or downloads from the internet beyond the build's own `npm ci`.

## Before you start: protect the real Legion

- The test install uses its OWN folder, data folder and port. Set these in every PowerShell window that starts the test app or the proxy: `$env:LEGION_HOME = 'D:\bots\legion-pkg-test\data'` and `$env:LEGION_PORT = '4799'`. Never `setx`.
- `setup` stops every running Legion it finds (any folder, by PID; the process that started setup is spared). **Close or finish the owner's real Legion first**, or accept that it is stopped.
- `setup` writes `Legion.lnk` on the Desktop and in the Start menu. **Back up both first** (`Copy-Item "$([Environment]::GetFolderPath('Desktop'))\Legion.lnk" D:\bots\legion-pkg-test\bak\` and the Start-menu one), restore them at the end (PB15). Do not start the test app through those shortcuts (Explorer does not carry the test environment variables, so it would use the real data folder and port 4747); read their target instead.
- Work in a fresh worktree of branch `claude/prebuilt-package`, not in the gate worktree. If it was last on another branch: `rm -rf dist` first.

## PB1 Build the package

```
cd D:\bots\legion-pkg            (the worktree)
scripts\build-package.cmd --out D:\bots\legion-pkg-out
```
Needs Node 20.10+ and git. It runs `npm ci`, `npm run build`, a production-only `npm ci --omit=dev --ignore-scripts` in a scratch folder, copies Electron's dist, writes the zips. Takes a few minutes (a 700 MB tree is deflated).
Expect: `legion-0.2.0-win-x64.zip` (about 270 MB, estimate), `legion-0.2.0-app.zip`, `legion-update-manifest.json` (NOT signed), `SHA256SUMS.txt` with exactly three lines (app zip, full zip, manifest), and the final lines "self-check" without an error.
Look at and write down: real zip size, unpacked size, file count, the sha256 line, and the printed numbers. **Likely first-run failures (all are named, none silent):** "reserved device name" or "path too long" for a file in some dependency (then that dependency path must be excluded or shortened: report the path), "claude.exe does not match the checksum in the SDK manifest", "claude-agent-sdk-win32-x64/claude.exe is missing" (an arm64 PC picks the arm64 build: use an x64 PC), "Electron x is installed but the lock pins y" (run `npm ci`), "git tree has uncommitted changes" (commit, or `--allow-dirty`).
Check by hand: `Get-FileHash D:\bots\legion-pkg-out\legion-0.2.0-win-x64.zip` equals the `SHA256SUMS.txt` line; open the zip listing: no `src`, no `dist\test`, no `.bin`, only `@anthropic-ai\claude-agent-sdk-win32-x64` under `node_modules\@anthropic-ai`, `runtime\electron\electron.exe` present, `PACKAGE-FILES.json` and `build-info.json` (kind package, platform win32-x64, commit, dirty false) present.

## PB2 Reproducibility (cheap, informative)
Run PB1 again into another folder with the same commit. Expect the same sha256. If it differs, note both and the Node version (zlib output can differ between Node builds; the published hash is the file the owner builds, so this is information, not a failure).

## PB3 Clean install from the unzipped package (Windows PowerShell 5.1 path)
```
mkdir D:\bots\legion-pkg-test\unz
Expand-Archive D:\bots\legion-pkg-out\legion-0.2.0-win-x64.zip D:\bots\legion-pkg-test\unz
cd D:\bots\legion-pkg-test\unz\legion-0.2.0
.\setup-yes.cmd -InstallDir "D:\bots\legion-pkg-test\Legion Test" -NoLaunch
```
(the install path has a space on purpose: argument quoting). Expect, in the output: "Not needed: this is a prebuilt package"; no "Checking Node.js ... OK", no `npm`, no "Building"; "copying N files ... and checking each one"; "Package installed and checked."; shortcuts created; `uninstall.cmd` written; exit code 0.
Look at: `Get-ChildItem "D:\bots\legion-pkg-test\Legion Test" -Force` (expect `.update` with no `prev` and no `staging`, `runtime`, `node_modules`, `dist`, `dist-ui`, `assets`, `scripts`, files; **no** `PACKAGE-FILES.json`, no `src`); total size; the time the copy took. The data folder `D:\bots\legion-pkg-test\data` does not exist yet or is untouched.
Shortcut: read `Legion.lnk` (`(New-Object -ComObject WScript.Shell).CreateShortcut(...)`): TargetPath = `...\Legion Test\runtime\electron\electron.exe`, Arguments = the install folder in quotes.
SmartScreen / web mark: `Get-Item <install>\runtime\electron\electron.exe -Stream *` and the same for `setup.cmd` in the unzipped folder. Write down whether `Zone.Identifier` is present on the installed exe (plan: Legion does not strip it). If you downloaded the zip with a browser instead of building it, note what Windows showed on `setup.cmd` and on the first start.

## PB4 Idempotent re-run
Run the same `setup-yes.cmd` line again. Expect success, "copying ..." again, `.update` empty of prev/staging, the data folder and `uninstall.cmd` unchanged (compare file hashes of `config.json` before/after once it exists, and the `uninstall.cmd` bytes).

## PB5 Start the app (own data folder, own port)
```
$env:LEGION_HOME='D:\bots\legion-pkg-test\data'; $env:LEGION_PORT='4799'
& 'D:\bots\legion-pkg-test\Legion Test\start-legion.cmd'
```
Expect: the window opens; `Invoke-RestMethod http://127.0.0.1:4799/health` answers with version 0.2.0; `Get-CimInstance Win32_Process | ? { $_.ExecutablePath -like '*Legion Test*' } | select ProcessId,Name,CommandLine`: only `electron.exe` from `runtime\electron`, one of them with `legion-core.js` in its command line, and **no `node.exe` at all**. `core.log` in the data folder is clean. Settings > Connections shows the Claude Desktop snippet with `...\runtime\electron\electron.exe`, `args` with `legion-mcp-stdio.js` and `"env": {"ELECTRON_RUN_AS_NODE": "1"}`.
First run has no Claude sign-in yet if the owner's `~/.claude` has none: the existing doctor card must say so. (The owner's existing Claude login in the user profile is shared; that is expected.)

## PB6 Run a task (needs the owner's go: uses their Claude sign-in)
Create one agent task with a trivial prompt ("say hello") and let it finish. While it runs: `Get-CimInstance Win32_Process | ? Name -eq 'claude.exe' | select ExecutablePath` shows the **bundled** `...\Legion Test\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`. Write down whether it needed a sign-in and how that looked. If there is no sign-in: run `"D:\bots\legion-pkg-test\Legion Test\scripts\legion-claude.cmd"` and let the owner type `/login` (the orchestrator does not log in for them).

## PB7 MCP stdio proxy on the package's own Node
Also try the Claude Desktop config entry in BOTH forms (the electron command with an `env` object, and `scripts\legion-mcp.cmd` as the command) on a copy of the config, and write down which one Claude Desktop accepts (the `env` support is unconfirmed, see plan section 13).
With the env vars of PB5 set, app running:
```
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"pc-check","version":"0"}}}' | & 'D:\bots\legion-pkg-test\Legion Test\scripts\legion-mcp.cmd'
```
Expect a JSON-RPC response naming server `legion` (a `tools/list` follows the same way and lists the short client list). Then **quit the app** (tray > Quit) and run it again: the proxy must start the core by itself: expect `Get-CimInstance` to show an `electron.exe` running `legion-core.js` with **no window**, and a working answer. Stop that core by PID afterwards (never by name). `scripts\legion-mcp-config.cmd` must print the HTTP command and the electron-based JSON (do not paste your real token into the report). Do not edit the owner's `claude_desktop_config.json` without their go.

## PB8 Update in place (a second package)
In the worktree bump `package.json` version to `0.2.1` locally (do not commit), `build-package.cmd --out D:\bots\legion-pkg-out2 --allow-dirty`, unzip, run its `setup-yes.cmd -InstallDir "D:\bots\legion-pkg-test\Legion Test"`. Expect: the old app was stopped, "package installed", `package.json` says 0.2.1, `.update\prev` is gone, `config.json` and `uninstall.cmd` byte-identical, the app starts and `/health` says 0.2.1. Then revert the local version bump.
Also: a failed update keeps the old build: before running, rename `runtime\electron\resources\default_app.asar` in the UNZIPPED copy (a missing listed file) and expect "Windows or your antivirus blocked or removed ... Legion did not retry", exit code 3, and the installed 0.2.0 untouched.

## PB9 Antivirus / quarantine behaviour (no malware samples)
Do not use test viruses without the owner's go. Check what you can: (a) the "blocked" message above; (b) watch **Windows Security > Protection history** during PB1 and PB3 and write down whether Defender scanned, delayed (how many seconds the copy and the `claude.exe --version` smoke test took) or removed anything. If it quarantines `claude.exe` or `electron.exe`, copy the exact Protection history text.

## PB10 Local-zip route (installer kit)
Make a folder with `setup.cmd`, `scripts\` (the lib files too), the full zip and its `SHA256SUMS.txt`; run `setup.cmd -InstallDir "D:\bots\legion-pkg-test\Kit Test" -NoLaunch` (answer the prompts, or use `-Yes`). Expect the same result as PB3 plus "package checked and unpacked". Run it once with a wrong digit in `SHA256SUMS.txt`: expect "does not match the SHA-256 you gave ... Nothing was unpacked." and nothing in `%TEMP%\legion-setup-*`. Run with no `SHA256SUMS.txt` and `-Yes`: expect the refusal "No checksum to compare with".
The `-PackageUrl` route needs the public release and the owner's go (a real download): later, with `setup.cmd -PackageUrl https://github.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip -PackageSha256 <hex from the page> -Yes`.

## PB11 Updater on a package install
Re-run `claude/tracker-pc-checks-updater.md` U1-U13 against the installed package where they apply: `installMode` must be `apply` (no `.git`), an update that does not change `package-lock.json` swaps only the code set and keeps `node_modules` and `runtime`, one that does must say it needs the full package. The update zip must keep the package recognised after the swap: `build-info.json` still says `kind: package`, and the app still starts with its own runtime.

## PB12 Uninstall
`"D:\bots\legion-pkg-test\Legion Test\uninstall.cmd"` (no `/purge`) with the test app running: expect it stopped by PID, the install folder removed (700 MB), only shortcuts that point at this install removed, the test data folder kept. Then restore the owner's original `Legion.lnk` files from the backup. `/purge` only against the test data folder (it asks to type DELETE, and only deletes a folder holding Legion's `config.json`).

## PB13 Odd paths
Install once into a path with a non-ASCII character and a space (`D:\bots\legion pkg test\Légion`) and into the default `%LOCALAPPDATA%\Programs\Legion` ONLY if the owner has no real install there (otherwise skip: the default path is the real one).

## Report back (short)
Zip size and sha256, unpacked size and file count, build time, copy time, whether the output matched, whether any file was refused by name or length, Defender observations, the `Zone.Identifier` observation, process list proof (no `node.exe`), the MCP proxy answers, PB8 result, uninstall result, and anything that looked wrong. Separate bugs from polish.
