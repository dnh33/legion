# Plan: the prebuilt Windows package and its install path

Branch `claude/prebuilt-package`, base `integration/v1`. Claims are scoped to "Legion's own scripts". Nothing here is signed. Nothing was run on Windows by the cloud session; section 12 lists exactly what only a real Windows run proves.

Owner decision (2026-10-02): a normal user needs no Git, no Node, no npm and no build. They get ONE package, unzip it, double-click `setup.cmd` (or `setup-yes.cmd`), start Legion from the shortcut. No `.exe` wrapper in v0.2.0 (single-file or signed installer = Later).

## 1. Everything runs on Electron's embedded Node

`electron.exe` with `ELECTRON_RUN_AS_NODE=1` is a Node 22-line runtime (Electron 44). `package.json` `engines.node` is `>=20.10`; the code needs nothing newer. Nothing in the production dependency tree is a native addon (checked: `npm ci --omit=dev` tree has no `*.node` and no `binding.gyp`).

What assumes a system `node` today (read from the repo) and what it uses in a package install:

| Where | Today | Package install |
|---|---|---|
| `src/electron/main.ts` `spawnCore` -> `resolveNodeBin` | `LEGION_NODE`, else `<root>/runtime/node/node.exe` (marker), else `node` on PATH | new `resolveCoreLaunch`: `LEGION_NODE` still wins, then Legion's own `runtime/node`, then **package mode** = `<root>/runtime/electron/electron.exe` with `ELECTRON_RUN_AS_NODE=1` in the child env only, else `node`. The "Node not found" error text becomes a package-aware message (Defender hint). |
| `src/bin/legion-mcp-stdio.ts` `ensureCore` | spawns `process.execPath legion-core.js` (inherits env) | still `process.execPath`; when `process.versions.electron` is set it forces `ELECTRON_RUN_AS_NODE=1` on the child so it never opens a window if the client did not set it |
| `src/electron/updater-main.ts` | already `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; `apply.ts` deletes the variable before relaunching the app | unchanged |
| `start-legion.cmd` | `where node`, `node_modules\electron\dist\electron.exe`, `npm run build` | package branch first: `runtime\electron\electron.exe` present -> start it, no node/npm. Source branch unchanged. |
| `scripts/mcp-config.mjs` (`npm run mcp-config`) prints `"command": "node"` | needs npm and node | package mode prints `command: <install>\runtime\electron\electron.exe`, `args: [stdio.js]`, `env: {ELECTRON_RUN_AS_NODE: "1"}` (Claude Desktop/Cowork config supports `env`; no wrapper needed). `scripts\legion-mcp-config.cmd` runs it in node mode (no npm). Source mode unchanged. |
| Settings > Connections snippet (`Settings.tsx`) | hard-coded `command: 'node'`, install dir guessed | core adds `install: { dir, packaged }` to the settings view (only when given; tests unchanged); package mode shows the electron command + env. |
| `claude mcp add --transport http ...` (Settings, Thread) | HTTP, needs only the `claude` CLI | unchanged. For people with no Claude CLI: `scripts\legion-claude.cmd` runs the SDK's own bundled `claude.exe` (so `legion-claude.cmd` then `/login` works with no extra install). |
| `scripts/harness/*`, `postinstall.mjs`, build scripts | dev tools | not part of the user flow; stay as they are |

Wrapper commands (tiny `.cmd` files under `scripts\`, which is already in the updater's code set, so no change to `CODE_SET` and the updater test that pins it): `legion-node.cmd` (`set ELECTRON_RUN_AS_NODE=1` then electron.exe `%*`, for a plain command line), `legion-mcp.cmd` (the stdio proxy), `legion-mcp-config.cmd`, `legion-claude.cmd`. All resolve the exe relative to `%~dp0..\runtime\electron\` and never touch PATH.

**Native binary.** `@anthropic-ai/claude-agent-sdk@0.3.285` resolves `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` from `node_modules` (read from its `core.mjs`: `<pkg>-<platform>-<arch>/claude[.exe]`). The lock lists all platforms as optional; on Windows x64 `npm ci` installs only the win32-x64 one. Real numbers: the linux variant is 240 MB unpacked and gzips to 106 MB; win32-x64 is 243,751,072 bytes (the SDK's own `manifest.json` gives its sha256 `121fc815...697e`). The build **checks the shipped `claude.exe` against that manifest entry (size and sha256)** and removes every other platform folder. Other native pieces: none.

## 2. Package content and size (real numbers)

Top folder `legion-<version>/`:
`build-info.json`, `PACKAGE-FILES.json` (install-time integrity list, not copied to the install), `package.json`, `package-lock.json`, `LICENSE`, `NOTICE`, `licenses/`, `dist/` (no `dist/test`), `dist-ui/`, `assets/`, `scripts/` (setup, uninstall, libs, wrappers, release scripts), `setup.cmd`, `setup-yes.cmd`, `start-legion.cmd`, README/SECURITY/CHANGELOG, `node_modules/` (production only, win32-x64 SDK binary only), `runtime/electron/` (the Electron win32-x64 runtime from `node_modules/electron/dist`).
Not in it: `src`, `ui`, `test`, `docs`, devDependencies, `.git`, `.bin` shims, `.package-lock.json`, the data folder.

Sizes: Electron 44.5.1 win32-x64 zip = **158.0 MB** (measured, GitHub release HEAD; unpacked about 400 MB, estimate); `claude.exe` 243.8 MB unpacked, about 105 MB compressed (measured on the linux twin); production `node_modules` without the binary 34 MB (7 MB compressed, measured); dist, dist-ui, assets, scripts a few MB. **Expect a zip of about 270 MB and about 690 MB installed** (estimates marked; the real run prints the true numbers). Caps used by the installer: zip 450 MB, unpacked 1.2 GB, 20,000 entries. The updater's limits (150 MB / 400 MB) stay as they are: they apply to the code-only update zip.

## 3. ONE package format, two assets

The release has two zips from the same build and the same bytes for the shared part:
- `legion-<v>-win-x64.zip` (**full**, what a new user installs): the tree above.
- `legion-<v>-app.zip` (**update**, what the in-app updater downloads, signed manifest): exactly the code-set subset of the full zip, byte for byte (the full zip is assembled from the entries of the app zip, so there is one source of truth).

Both carry the same extended `build-info.json` (`version`, `publishedAt`, `builtAt` = `publishedAt`, `commit`, `platform: "win32-x64"`, `kind: "package"`, `electron`, `sdk`, `sdkBinarySha256`) written by `release-package.mjs --build-info` (new optional flag; default output unchanged). Because an update keeps that file, an updated install is still recognised as a package. Package-mode detection everywhere = `build-info.json` kind package AND `runtime/electron/electron.exe` present. The updater's rule stays: an update that changes `package-lock.json` is `requiresFullInstall`; the user then installs the new full zip over the old install with the same setup (section 6), which is "update in place".

## 4. Build: `scripts/build-package.mjs` (+ `scripts/build-package.cmd`)

Run by the owner/orchestrator on Windows x64. Steps: (1) preflight (Windows x64 unless `--foreign` with explicit inputs; Node >= 20.10; clean git tree unless `--allow-dirty`, recorded as `dirty` in build-info); (2) unless `--skip-build`, `npm ci` then `npm run build` (the existing gate commands); (3) `release-package.mjs` for the app zip, entries read back; (4) production tree: `npm ci --omit=dev --ignore-scripts` in a scratch folder from the shipped lock (integrity hashes are verified by npm), prune other SDK platforms, check `claude.exe` against the SDK manifest; (5) Electron: copy `node_modules/electron/dist`, version must equal the lock's; (6) `PACKAGE-FILES.json` (sorted, path/size/sha256); (7) **streaming** deterministic zip (the in-memory `writeZip` would hold 700 MB): sorted names, fixed 1980-01-01 timestamp, no extra fields; (8) sha256 streamed; `release-manifest.mjs` for the app zip (not signed: the key is the owner's); `SHA256SUMS.txt` lists full zip, app zip and manifest; (9) self-check: the finished zip is read back with the strict zip reader (`src/core/blender/zip.ts`) into a temp folder and verified against `PACKAGE-FILES.json`.
Reproducibility: pinned inputs (lock integrity, SDK manifest checksum, Electron version), sorted entries, fixed timestamps, `publishedAt` defaults to the HEAD commit time (or `--published-at`), so the same commit on the same Node build gives the same bytes (a test builds twice and compares). Honest limit: zlib output can differ between Node builds, so bit-identical across machines is not promised; the sha256 published is that of the file the owner built.
Testable on Linux: the build is a pure function over `{repoRoot, prodNodeModules, electronDist, sdkBinaryDir}`; tests use a fake electron (a shell script) and a fake claude (a shell script) and a tiny fake tree. Only a real Windows run proves section 12.

## 5. Where a user gets it

- **A. Browser download (the normal path).** GitHub release asset `https://github.com/dnh33/legion/releases/download/v<v>/legion-<v>-win-x64.zip` once the repo is public; the page and `install.md` show the sha256 (from `SHA256SUMS.txt`) and `Get-FileHash` to check it. User unzips, double-clicks `setup.cmd`. Explorer's unzip cannot check a hash, so **authenticity of route A rests on the user comparing the sha256 of the zip with the page**; setup separately checks that the unzipped files are complete (`PACKAGE-FILES.json`), which catches a bad or half extraction, not a swapped package. Said plainly in the plan and the doc wording below.
- **B. Local file / agent / script:** `setup.cmd -PackagePath C:\x\legion-0.2.0-win-x64.zip -PackageSha256 <hex>` or `-PackageUrl https://github.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip -PackageSha256 <hex>`; a `legion-*-win-x64.zip` next to `setup.cmd` is picked up only in a folder that has no `src` (an installer kit, never a source checkout). No hash given for a local file: setup prints the computed sha256 and asks "does this match the page?" (default no; **`-Yes` does not answer this**, so unattended runs without a hash refuse). `-PackageUrl` always needs `-PackageSha256`.
- Download rules (existing `Invoke-BoundedDownload`, reused): only after a yes (`-Yes` = yes to the download, or the interactive question); https only; first hop host `github.com` with the exact path `/dnh33/legion/releases/download/v<semver>/legion-<semver>-win-x64.zip`; redirects up to 3, every hop on the allowlist `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`; no user info; size cap 450 MB (declared and streamed); a short read is refused; the **sha256 is compared before anything is unpacked**, a mismatch deletes the file. Unpack with the existing `Expand-ZipSafe` (names, resolved paths, entry and size caps; limits raised for this package), then the JS installer (section 6) verifies every file again. TLS 1.2 forced for PowerShell 5.1. A loopback test mirror exists only with `LEGION_TEST_MODE=1` plus a loopback http address, as for Node.

## 6. Install and update-in-place (`setup.ps1`, `scripts/package-install.mjs`)

`setup.ps1` first decides the kind of the folder it runs from: **package** (`build-info.json` kind package + `runtime\electron\electron.exe`) or **source** (today's `src` + `package.json`). Source: nothing changes (git clone + Node bootstrap + `npm ci` + build). Package: Node check, npm and build are skipped entirely; the running-Legion stop step stays (by PID, as now).
The copy is done by the JS installer, run with the package's own `electron.exe` in node mode (it exists once the zip is unpacked):
1. check the source is a complete package: only allowed top-level names, no links, every file in `PACKAGE-FILES.json` present with the right size and sha256 (hashed while it is copied, so what is installed is what was hashed), no unlisted files;
2. refuse a destination that is a drive root, inside or containing the source, a link, the user profile, or the data folder (`LEGION_HOME` / `%USERPROFILE%\.legion`): that folder is never read or written;
3. copy into `<install>\.update\staging\pkg` (a folder Legion owns), then **swap with the updater's own `swapIn`/`rollback`/`removeOwned`** (`apply.ts`, one additive option: the list of names to swap, default unchanged). No `robocopy /MIR` is used for a package. `.update`, `uninstall.cmd` and anything else in the folder are left alone;
4. smoke test of the installed build: installed `electron.exe` in node mode prints its version, installed `claude.exe --version` runs. Failure = rollback to the previous build and a plain message; success = the old copy in `.update\prev` is deleted;
5. `setup.ps1` writes the shortcuts (Desktop and Start menu; target = `<install>\runtime\electron\electron.exe`, argument = the install folder, icon from `assets`) and `uninstall.cmd`. Nothing system-wide: no registry, no PATH, no services, no admin.
Re-run = update: same code path, idempotent (same version installs again cleanly; the data folder is never touched). The in-app updater and setup share `swapIn`/`rollback`, so an interrupted setup is recovered at the next start by the same `recoverInterrupted`.

## 7. Uninstall, shortcuts, SmartScreen, first run, Defender

- Uninstall: `uninstall.cmd` (existing) removes shortcuts and the install folder (a package install is not a git checkout); `/purge` also the data folder with the existing guards. Wrappers and `.update` go with the folder.
- **SmartScreen / unsigned.** Nothing in the package is signed by Legion. Windows may show "Windows protected your PC" for `setup.cmd` (the downloaded zip carries a web mark) and possibly on the first start of `electron.exe` if the copy keeps the mark. The wording to use: "Legion is not code-signed yet. Windows may warn you the first time. Check the sha256 on the download page, then choose More info > Run anyway." Setup does **not** strip the web mark from anything (decision for the owner, not taken here).
- First run: no Claude sign-in yet = the existing doctor card. Package users have no `claude` on PATH, so setup's last lines point to `scripts\legion-claude.cmd` then `/login` (the SDK's bundled binary), and the Claude Code installer as the other route.
- **Defender or another antivirus removes or blocks a file** (most likely the 244 MB `claude.exe` or `electron.exe`): the copy step reports the exact file (missing after the copy, unreadable, wrong hash, or the smoke test failing), rolls back, and prints: "Windows or your antivirus blocked or removed `<file>`. Legion did not retry. Open Windows Security > Virus & threat protection > Protection history, restore or allow the file, then run setup again." Exit code 3. **No retry loop**: one attempt. At run time a core that cannot start shows the same hint in the app's error and `core.log`; the tray "Restart core" is the manual retry.

## 8. Controls and their tests (Linux, mutation per control)

Pure logic goes in `scripts/lib/package-lib.mjs` (+ `zip-stream.mjs`, `package-install.mjs`) and `src/electron/resolve-node.ts`; tests in `test/prebuilt-*.test.ts`. Each control gets a temporary scratch mutation that turns a named test red, then reverted: package-vs-source detection; `PACKAGE-FILES.json` verification (missing, wrong hash, extra file, wrong size); zip-slip and bad names in the zip reader path; URL/host allowlist and the exact release path (JS mirror of the PowerShell rule, plus a static contract on the `.ps1`); hash-before-unpack ordering (static contract on `setup.ps1` + JS ordering test); size cap; idempotent re-run; no-touch of the data folder and of `.update`/`uninstall.cmd`; refuse-destination cases; rollback on a failing smoke test; node-mode command construction (`resolveCoreLaunch` precedence, env only on the child); the stdio proxy env; wrapper `.cmd` content (exe relative path, no PATH edit, no `node`); SDK binary check vs the manifest; other-platform pruning; deterministic zip (twice identical, sorted, fixed time); app zip is a byte-exact subset of the full zip. PowerShell tests run where a PowerShell exists (the Windows CI runner); here, static contract tests carry the weight.

## 9. Not changed

`src/core/bsv`, `src/core/blender`, `src/core/providers`, `src/core/browser`, docs, README, the admin gate, native secret, taint wrapping, tripwire and hedge tests (child processes are spawned only in files the tripwire lists: no new file spawns one except where the tripwire already allows; `scripts/*.mjs` are outside `src`).

## 10. Wording for later (docs/README/install page, not edited here)

- "Download one zip, unzip it, double-click setup.cmd. You do not need Git, Node.js or npm. About 270 MB to download, about 690 MB installed."
- "Legion is not code-signed yet. Compare the SHA-256 on this page with `Get-FileHash legion-<v>-win-x64.zip` before you unzip."
- Node 20.10+ and Git stay documented for the developer route only.

## 11. Decisions I made (flag if wrong)

Two assets, one format (full and update zips share bytes). Hash for route A is the user's job (Explorer cannot do it). No `Unblock-File`. `-Yes` never answers "does this hash match". Previous build is deleted after a good smoke test (it would cost 650 MB). Wrapper commands live in `scripts\` to keep `CODE_SET` unchanged. Locale pruning of Electron (about 40 MB) is not done: not worth the risk.

## 12. Only the real Windows run proves

`npm ci` really picks `claude-agent-sdk-win32-x64`, and its `claude.exe` matches the SDK manifest; Electron's dist copy runs; `electron.exe` in node mode runs the core, the stdio proxy and the apply helper; the real size and zip time; `Expand-ZipSafe` on 700 MB under Windows PowerShell 5.1; shortcuts; the swap with real file locks and Defender; SmartScreen and web-mark behaviour of copied files; quarantine messages; uninstall of a 700 MB tree; the doctor card and `legion-claude.cmd /login`. Steps: `claude/tracker-pc-checks-prebuilt.md`.
