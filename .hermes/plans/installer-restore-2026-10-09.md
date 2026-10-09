# Restore Windows installer to source-based build + mark prebuilt maintenance

## Goal
Restore the Windows installer to work reliably, since the prebuilt package's bundled
`runtime/electron/electron.exe` is broken (exits code 1, empty stderr; smoke test fails).

## Background / Evidence

### Installer history (setup.ps1)
| Commit | Change | Relevance |
|--------|--------|-----------|
| 4adb7c7 | base: setup.cmd, source-based install | Working source path |
| 92bced4 | Node bootstrap: downloads Node 24 LTS from nodejs.org if missing | Still intact |
| 9f3e73c | Package route: `-PackagePath` / `-PackageUrl` → `scripts/package-install.mjs` | Current path, broken |
| 89aa53e | Streaming zip writer, package lib, package installer (+ swapIn) | |
| 4f37dc6 | Prebuilt hostile-review fixes | Current HEAD |

### Current state
- **Source install (`setup.cmd` without `-PackagePath`)**: WORKS — `robocopy` + `npm ci` + `npm run build` + `npx install-electron`. This was the pre-0.2.0 installer behavior.
- **Prebuilt package (`scripts/package-install.mjs` smoke test)**: BROKEN — the zip's bundled `electron.exe` exits code 1 with empty stderr, so `realSmoke()` returns `runtime/electron/electron.exe`, the install aborts, and nothing installs.

### Root cause of broken prebuilt
The electron binary copied from the cache (`C:/Users/Danie/AppData/Local/electron/Cache/.../electron-v44.5.1-win32-x64.zip`) is being packaged into the zip, but the packaged copy doesn't run. Either:
- the cache binary itself is corrupt, or
- the packaging step copies the wrong file / doesn't include a working binary.

Grok's upstream finding: Electron 44.4.4 (backport #54118) fixes the `ready-to-show` / titleBarOverlay deadlock. Our cache binary is 44.5.1 from the same 44.x line — the deadlock may persist, and the binary may be stale.

## Plan

### Phase 1: Diagnose the prebuilt package binary
1. Extract `legion-0.2.5-q-win-x64.zip`
2. Run `runtime/electron/electron.exe` standalone and capture exit code + stdout/stderr
3. Compare against the cache binary: is it the same file? does it run?
4. If the packaged binary is corrupt/wrong: find the packaging script that places `runtime/electron/electron.exe` and fix it (or rebuild electron in the package via `npx install-electron`)

### Phase 2: Fix Electron binary in package (Electron 44.4.4+)
1. Install/upgrade electron to 44.4.4 in the package build context
2. Rebuild the package via `scripts/build-package.mjs`
3. Verify the packaged `electron.exe` runs standalone (smoke test passes)
4. Test full install via `setup.ps1 -PackagePath <zip> -Yes`

### Phase 3: Installer decision
**Decision to make (user):**
- Option A (recommended): Fix the prebuilt package (electron.exe works) — keep both source + prebuilt installers
- Option B: Remove the prebuilt route until fixed (`-PackagePath`/`-PackageUrl` unsupported, show clear error), fall back to source installer
- Option C: Hybrid — installer downloads Node + Electron itself (the original 92bced4 design)

For now (immediate): **Option B** — disable the prebuilt package installation and direct users to the source installer, while Phase 1-2 fix the package.

### Phase 4: Documentation & tracking
1. Update `legion-regression-postmortem-2026-10-08.md`:
   - Add prebuilt package electron.exe broken issue
   - Link to Electron 44.4.4 upstream fix
2. Update `parked-dependency-fixes-2026-10-09.md`:
   - Note prebuilt installer status
   - Note Electron bump strategy (44.3.x → 44.4.4 patch only, NOT full ladder)
3. Update `docs/STATE.md` (or active tracker) with:
   - installer-status: source=ok, prebuilt=broken/under-maintenance
   - electron-fix: upstream 44.4.4 (PR #54118) — target version
4. legion-site: show prebuilt package "in maintenance" notice (see Phase 5)

### Phase 5: legion-site updates
1. Find the page that links/shares the prebuilt package zip
2. Add maintenance notice: "Prebuilt package under maintenance — please install via setup.cmd from source."
3. Possibly show a "maintenance" badge or redirect to setup instructions
4. Alternative clever approach: a small "install page" on the site that auto-detects and runs setup.cmd/download

## Constraints
- No releases while prebuilt is broken
- Do not delete tracker content — append notes, mark status
- Preserve existing setup.ps1 capabilities (non-blocking, NoLaunch, DryRun, etc.)
- Keep electron bump minimal: 44.3.x → 44.4.4 only (patch line), NOT 45.x / full ladder

## Success criteria
- [ ] Prebuilt package electron.exe runs standalone
- [ ] Full install via setup.ps1 -PackagePath -Yes succeeds and launches
- [ ] Source installer (setup.cmd) still works unchanged
- [ ] Site shows maintenance status for prebuilt (or prebuilt route disabled with clear error)
- [ ] Tracker updated with all notes, nothing deleted
