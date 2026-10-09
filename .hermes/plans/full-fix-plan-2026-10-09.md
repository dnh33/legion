# Full Fix Plan — Electron 44.4.4 + Dependency Ladder + Working Prebuilt

## Goal
Fix the prebuilt package (electron.exe), upgrade Electron to 44.4.4 (titleBarOverlay fix),
plan full dependency ladder migration with official migration docs per version jump,
test on user PC, THEN decide on release.

## Current State (evidence-first, no deletion)

### What's broken
- Prebuilt `runtime/electron/electron.exe` (245MB, PE32+, all DLLs) → hangs on `--version`, `-e`
- `package-install.mjs` smoke test fails → install aborts
- User PC: 0.2.5-q installed with broken electron.exe + titleBarOverlay regression (Electron 44.4.0-44.4.3)
- CI smoke tests all fail (runs 37859656715, 37861097482, 37861429017, 37862264003)

### What works
- Source installer (`setup.ps1` without `-PackagePath`): robocopy + npm ci + build + `npx install-electron`
- Single-instance lock fix (86264dc) — `LEGION_UPDATE_RELAUNCH` env var in apply.ts + main.ts check
- Core process healthy (health endpoint responds)

## Phase 1: Diagnose & Fix Prebuilt electron.exe

### 1.1 Root cause of dead electron.exe in package
The package build script (`scripts/build-package.mjs`) copies electron from cache.
Cache binary: `C:/Users/Danie/AppData/Local/electron/Cache/*/electron.exe` (likely 44.5.1).
Packaged copy is corrupt/wrong.

**Action**: Find the packaging step that places `runtime/electron/electron.exe` and ensure it:
- Runs `npx install-electron` inside the package (like source installer)
- Or copies a verified-working electron.exe from a fresh `npm install electron@44.4.4`

### 1.2 Test electron.exe standalone before packaging
```bash
# Verify fresh electron@44.4.4 works
cd /tmp/test-electron && npm init -y && npm install electron@44.4.4
./node_modules/.bin/electron --version
./node_modules/.bin/electron -e "console.log('ok')"
```

### 1.3 Rebuild package with working electron
- Update `package.json` devDependency: `electron@44.4.4` (not 44.5.1)
- Run `npm ci` in package context
- Ensure `scripts/build-package.mjs` copies the working binary

## Phase 2: Electron 44.4.4 Upgrade (Patch Only — Fixes titleBarOverlay)

### 2.1 Why 44.4.4, not latest (45.x / 47.x / 48.x)
| Version | Status | Risk |
|---------|--------|------|
| 44.3.x | Current (cache) | Has titleBarOverlay regression |
| **44.4.4** | **Sep 22, 2026** | **Patch line 44.x — fixes #54025 (PR #54118), no breaking changes** |
| 45.x | Oct 20, 2026 | Requires Vite 8, TS 7, Node 24.21 — breaking |
| 46.x+ | 2027 | Further ladders |

**Official Electron migration for 44.x patch**: https://www.electronjs.org/docs/latest/tutorial/electron-versioning
- Patch releases (44.3 → 44.4.4) are **drop-in compatible**
- No API changes, no config changes, no code changes required
- Only the Chromium/V8 patch bumps (security + bug fixes)

### 2.2 Migration doc for Electron 44.3 → 44.4.4
```markdown
# Electron 44.3.x → 44.4.4 Migration
- Type: Patch upgrade (no breaking changes)
- Chromium: 152.0.7977.x (same major)
- Node: 24.20.0 (same)
- V8: 15.2.x (patch)
- Required changes: NONE
- Test: electron --version, electron -e "console.log('ok')", app launch
- Key fix: #54025 titleBarOverlay ready-to-show deadlock (PR #54118 backport)
```

## Phase 3: Full Dependency Ladder (Planned, Not Executed)

### 3.1 Version Matrix with Official Migration Docs

| Dependency | Current | Target | Migration Type | Official Doc |
|------------|---------|--------|----------------|--------------|
| **Electron** | 44.3.x | **44.4.4** | Patch (no breaking) | [Electron Versioning](https://www.electronjs.org/docs/latest/tutorial/electron-versioning) |
| Electron | 44.4.4 | 45.x | Minor (breaking) | [45.0 Breaking Changes](https://github.com/electron/electron/releases/tag/v45.0.0) |
| Electron | 45.x | 46.x | Minor (breaking) | [46.0 Breaking Changes](https://github.com/electron/electron/releases/tag/v46.0.0) |
| **Vite** | 5.x | **6.x** | Minor (some breaking) | [Vite 6 Migration](https://vite.dev/guide/migration.html) |
| Vite | 6.x | **7.x** | Minor (breaking) | [Vite 7 Migration](https://vite.dev/guide/migration-v7.html) |
| Vite | 7.x | **8.x** | Major (breaking) | [Vite 8 Migration](https://vite.dev/guide/migration-v8.html) |
| **TypeScript** | 5.x | **6.x** | Minor (breaking) | [TS 6 Migration](https://github.com/microsoft/TypeScript/wiki/Roadmap) |
| TypeScript | 6.x | **7.x** | Major (breaking) | [TS 7 Migration](https://github.com/microsoft/TypeScript/wiki/Roadmap) |
| **Node.js** | 20.x | **22.x** | LTS upgrade | [Node 22 Release](https://nodejs.org/en/blog/release/v22.0.0) |
| Node.js | 22.x | **24.x** | LTS upgrade | [Node 24 Release](https://nodejs.org/en/blog/release/v24.0.0) |
| **@claude-code/sdk** | 0.3.285 | 0.3.294 | Patch/Minor | [SDK Releases](https://github.com/anthropics/claude-code-sdk/releases) |
| **@modelcontextprotocol/sdk** | 1.x | 1.32.1 | Minor | [MCP SDK Releases](https://github.com/modelcontextprotocol/sdk/releases) |

### 3.2 Ladder Execution Order (MUST follow)

```
Step 1: Electron 44.3 → 44.4.4 (PATCH — fixes titleBarOverlay, NO other changes)
        ↓ TEST: prebuilt works, app launches, CI passes
Step 2: Vite 5 → 6 (MINOR — config changes, plugin updates)
        ↓ TEST: build works, dev server works
Step 3: TypeScript 5 → 6 (MINOR — type changes, may need code fixes)
        ↓ TEST: tsc passes, no type errors
Step 4: Electron 44.4.4 → 45.x (MINOR — requires Vite 6+, Node 22+)
        ↓ TEST: app launches, native modules rebuild
Step 5: Vite 6 → 7 (MINOR — more config changes)
        ↓ TEST: build works
Step 6: TypeScript 6 → 7 (MAJOR — significant type changes)
        ↓ TEST: tsc passes
Step 7: Node 20 → 22 → 24 (LTS upgrades, test native modules)
        ↓ TEST: npm ci, native rebuilds
Step 8: Vite 7 → 8 (MAJOR — breaking config, esbuild → rolldown?)
        ↓ TEST: full build pipeline
Step 9: SDK upgrades (claude-code, mcp) — test integration
```

### 3.3 What we do NOW vs LATER

| Now (Phase 1-2) | Later (Phases 3+) |
|-----------------|-------------------|
| Electron 44.4.4 only | Vite 6, 7, 8 |
| package.json: electron@44.4.4 | package.json: vite@6, ts@6, etc. |
| Rebuild prebuilt package | Each step tested in CI + local |
| Test on user PC | Staged releases per step |

**No skipping steps. Each step = CI green + local test.**

## Phase 4: Test on User PC

### 4.1 Prebuilt test
1. Build package with Electron 44.4.4
2. Extract zip, run `electron.exe --version` (must return in <2s)
3. Run `electron.exe -e "console.log('ok')"` (must print ok)
4. Run `setup.ps1 -PackagePath <zip> -Yes` on user PC
5. Launch Legion — verify splash → UI transition, no blank renderer

### 4.2 Source test
1. `setup.ps1` (no package args) on clean folder
2. Verify Node bootstrap works (downloads Node 24 LTS if needed)
3. Verify `npm ci` + `npm run build` + `npx install-electron` produces working app

## Phase 5: Website / legion-site Updates

### 5.1 Prebuilt package status
- Current: prebuilt zip linked as download
- Fix: show "Prebuilt package under maintenance — use setup.cmd from source"
- Or: hide prebuilt link entirely until fixed
- Clever approach: install page that detects environment and runs `setup.cmd`

### 5.2 Documentation
- Update download page with version status
- Link to tracker for transparency

## Phase 6: CI / Release Pipeline

### 6.1 CI smoke test fix
Current `.github/workflows/release-build.yml` has `$env:PKG` extraction bug.
Fix: correct PowerShell syntax for zip extraction + `$env:PKG` path.

### 6.2 Release gates (when ready)
1. CI smoke test passes (full package install + health check)
2. Local test on user PC passes
3. Tracker updated with all evidence
4. Release cut with `legion-shipping` skill (kodawari gate)

## File Paths to Modify (minimal, targeted)

### Must change
- `package.json` → `devDependencies.electron: "44.4.4"`
- `scripts/build-package.mjs` → ensure working electron.exe copied
- `.github/workflows/release-build.yml` → fix `$env:PKG` extraction
- `legion-site` → prebuilt maintenance notice

### Must NOT change (unless Phase 3+)
- Vite config (`vite.config.ts`)
- TS config (`tsconfig.json`)
- SDK versions
- Native module bindings

## Success Criteria (Kodawari)

- [ ] `electron.exe --version` returns `44.4.4` in <2s
- [ ] `electron.exe -e "console.log('ok')"` prints `ok`
- [ ] Prebuilt package installs via `setup.ps1 -PackagePath -Yes` on user PC
- [ ] App launches: splash → UI transition (no blank renderer)
- [ ] Health endpoint responds `{"ok":true,"version":"..."}`
- [ ] CI smoke test green
- [ ] Source installer still works
- [ ] No tracker content deleted

## Next Actions (Sequential)

1. **Diagnose packaging script** — find where `runtime/electron/electron.exe` comes from
2. **Test fresh electron@44.4.4** standalone
3. **Update package.json** to electron@44.4.4
4. **Rebuild package** with working binary
5. **Test prebuilt smoke** locally
6. **Test on user PC** (install + launch)
7. **Fix CI workflow** extraction bug
8. **Update legion-site** maintenance notice
9. **Document all evidence** in tracker (append-only)
10. **User confirms** → then consider release

---

**Decision point after Phase 1-2**: If Electron 44.4.4 + working prebuilt fixes the blank renderer, we have a release candidate. Full ladder (Phase 3) stays planned but not executed until needed.
