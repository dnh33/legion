# Plan: installer bootstrapper (Node on demand, no Git). No .exe in v0.2.0

Branch `claude/installer-bootstrap`, base `integration/v1`. Claims are scoped to "Legion's own scripts". Nothing here is signed; nothing is run on the owner's PC by the cloud session.

## 1. The Node version truth

- `package.json` `engines.node` is `>=20.10`. README says "20.10 or newer". `scripts/setup.ps1` checked only "major >= 20". CI uses Node 22. The owner's "Node 24" is the LTS line we INSTALL, not the minimum.
- Decision: **minimum accepted system Node = 20.10.0** (the engines value, now checked on major AND minor, one constant). **Version Legion installs when it has to = pinned Node 24 LTS, `24.21.0`** (one constant, `scripts/lib/node-bootstrap.ps1`). Electron 44 ships its own Node; the core is started with the PC's `node` (`LEGION_NODE` or PATH), so any version meeting engines works, the pin is only what a user without Node gets.
- Wording changes (README, not edited here): "Node.js 20.10 or newer. If you have none, setup offers to download Node.js 24 LTS (about 36 MB) into the Legion folder; nothing system-wide changes." And drop "git is required" (README says it for Windows install; reword to "git only for the developer route").

## 2. Flow in `setup.ps1`

1. Existing checks (install dir verdict, etc.).
2. **Resolve Node**, in order: (a) Legion's own `<install>\runtime\node` if its marker + `node.exe -v` match the pin: use it, no download; (b) a system `node` on PATH that is >= 20.10 with `npm`: use it, no download; (c) otherwise ask ONCE: "Legion needs Node.js 24 LTS. Install it now? It downloads about 36 MB from nodejs.org." `-Yes` (setup-yes.cmd) is the go-ahead; no terminal and no `-Yes` = no. No = print the winget line (`winget install OpenJS.NodeJS.LTS`) and stop, as today. A failed download/verify also prints the winget line; nothing is left installed.
3. Download route (`scripts/lib/node-bootstrap.ps1`, dot-sourced): `https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-<x64|arm64>.zip` and `.../SHASUMS256.txt` from the same folder. https only, host `nodejs.org` only, **zero redirects**, size caps (SHASUMS 64 KiB, zip 120 MiB, stream aborted at the cap, Content-Length over the cap refused), TLS 1.2 forced (PowerShell 5.1), timeouts. sha256 of the zip must equal the SHASUMS line for exactly that file name, else delete and refuse. Extract with a path-traversal-safe extractor (rejects absolute, drive letters, `..`, backslash tricks, device names, entry count and unpacked-size caps, checks every resolved path stays under the staging dir) into `<install>\runtime\.staging-<pid>`, check `node.exe -v` == pin, then rename to `<install>\runtime\node` and write `.legion-owned` (JSON: version, sha256, source) LAST. No admin, no registry, no system PATH. 32-bit Windows: unsupported, winget line.
4. setup puts `<install>\runtime\node` first on PATH **for its own process only** (npm ci / build use it).
5. `src/electron/main.ts` (outside the forbidden dirs) gets one small change: when `LEGION_NODE` is unset and `<app root>\runtime\node\node.exe` exists with its marker, the core is spawned with that node (pure helper `src/electron/resolve-node.ts`, tested on Linux). Shortcuts stay `electron.exe "<install>"`. No launcher scripts needed, tray restarts and updater relaunches use it too.
6. robocopy `/MIR` would delete `runtime\` (and the updater's `.update\`): both go on the `/XD` list. `Get-InstallDirVerdict` treats a folder holding only Legion's marked `runtime\` as empty (a failed first run can be retried). `.gitignore` gets `/runtime/`.

## 3. No Git

- Setup copies from the folder it runs in and never runs git. A user can get that folder as a plain zip download (GitHub "Download ZIP") or, later, an unpacked release package; a release package is already built (`dist`, no `src`), so setup skips `npm run build` for it. `.git` is only detected by uninstall (a checkout is kept). The developer `git clone` path is unchanged.
- Setup runs npm only as `npm ci` (or `npm install` when there is no lock, as today).
- Considered and dropped: fetching the signed release from inside setup. It only made sense for a single-file installer; the updater already owns the signed-manifest chain once the repo is public.

## 4. No .exe in v0.2.0

Owner decision (2026-10-02): **no `.exe` in v0.2.0**. No IExpress build, no `build-setup-exe.ps1`, no `SETUP-EXE.md`. The install flow is `setup.cmd` / `setup-yes.cmd` from the folder. **A signed installer or a single-file installer is Later** (it needs a code-signing certificate the owner would buy and hold, otherwise SmartScreen warns; both are out of scope here).

## 5. Uninstall

`uninstall.ps1` removes `<install>\runtime\node` only if it carries `.legion-owned`, and never follows a link: a junction or symlink inside is detached with a non-recursive delete, its target is not touched (CLAUDE.md lesson). For a source checkout (folder kept) only `runtime\node` goes. A `runtime\node` without the marker is left alone and reported.

## 6. Tests

Linux (pure, always run): version compare/min, SHASUMS parse, resolve-node helper, static contract (hosts: the scripts name only `nodejs.org` (plus the test loopback), `AllowAutoRedirect = $false`, ASCII only, no `Invoke-WebRequest`, no `Invoke-Expression`, no kill by name), tripwire files untouched.
PowerShell tests (run where `pwsh` or `powershell` exists; the Windows CI runner always): a fake nodejs.org on `127.0.0.1` (node:http). Host override exists only as `LEGION_TEST_NODE_MIRROR` AND `LEGION_TEST_MODE=1` together, http loopback only; a test proves that WITHOUT the flag the production URL is still nodejs.org. Cases: good install, wrong sha256 (nothing installed), truncated, oversize, zip-slip, redirect refused, existing Node = no download, user says no, `-Yes` says yes, re-run idempotent, uninstall removes an owned runtime only (and not an unmarked one, and not through a junction).
Gates: the usual. Windows-only verification (real nodejs.org, real arm64, real shortcuts) goes to `claude/tracker-pc-checks-installer.md`.

## 7. Out of scope / not done

Any .exe or signed installer (Later), winget/MSI packaging, auto-updating Node, mainnet anything, editing README/docs, any change to bsv/blender/providers/updater source.
