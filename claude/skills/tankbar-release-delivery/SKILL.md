---
name: "tankbar-release-delivery"
description: "Build, verify and deliver a Tankbar release (web, demo, Windows installer/portable, source, git backup) to the owner's D:\\screenquarium folder, then update the status docs."
---

# Tankbar release and delivery

**The code:** the repo lives at `/home/claude/tankbar` in the Cowork cloud workspace, which is lost when the session ends.

**The owner's copy:** everything they keep is in `D:\screenquarium` on their PC, reached through the device bridge. Inside the device shell it is `$HOME/mnt/screenquarium`.

**If the repo is missing,** restore it from `D:\screenquarium\backup\`:

1. Stage the bundles into the workspace.
2. `git clone` the full bundle.
3. `git pull` each incremental bundle in date order (`RESTORE.txt` lists them).

## 1. Checks (all must pass)

```bash
npx tsc --noEmit -p .
npm test                                   # core + Harbor
npm run smoke:ui -- /tmp/smoke             # every panel and sub-tab, reveal, sealed card + Verify; exit 1 on any console/page error
npm run perf:tank                          # only with an idle CPU (no workflow agents running); compare plain vs dressed
npm run odds:mint                          # when the Mint, genetics or finishes changed
```

For the live Harbor check, see the `tankbar-harbor-ops` skill: the Electron page must join, and the database must be reset afterwards if it should stay empty.

## 2. Build

```bash
export HARBOR_URL=wss://maincloud.spacetimedb.com HARBOR_MODULE=tankbar-1m6v2
node build.mjs --release
grep -o "script-src[^;]*\|connect-src[^;]*" dist/app/index.html   # must include 'unsafe-eval' and the maincloud origins
xvfb-run -a npm run dist:win     # -> release/Tankbar-Setup-<ver>.exe, release/Tankbar-<ver>-portable.exe
```

Web builds:

- `dist/web/index.html` → `Tankbar-web.html`
- `dist/demo/index.html` → `Tankbar-demo.html`

A release build refuses to run without `HARBOR_URL`, unless `ALLOW_MOCK_HARBOR=1` ships the offline preview harbour instead.

## 3. Deliver to `D:\screenquarium`

`device_commit_files` takes at most **20 MB per file**, and the installers are about 110 MB each. Use this procedure for big files:

1. **In the workspace:** `split -b 19m -d <file> <file>.part` into `/mnt/user-data/outputs/deliver/`, and note `sha256sum <file>`.
2. **Write the parts:** `device_commit_files` each part to `D:\screenquarium\<file>.partNN`, up to 50 files per call.
3. **In `device_bash`:**
   ```bash
   cd $HOME/mnt/screenquarium && cat <file>.part* > <file> && sha256sum <file>
   ```
   The hash must match the workspace's.
4. **Delete the parts.** Deleting needs `device_request_delete_permission` for the folder root, once per session. If the owner declines, move the parts into `_to_delete/` and say so.
5. **Update `SHA256SUMS.txt`** beside the builds.

**Source** (`tankbar-source/`):

1. In the workspace: `git archive --format=tar.gz -o tankbar-source.tar.gz HEAD` (split it if it's over 19 MB).
2. Commit it, then on the device: `tar -xzf tankbar-source.tar.gz -C tankbar-source`.
3. Remove the tarball.

Files deleted upstream stay behind in `tankbar-source/`, so mention it, or replace the folder once delete permission is granted.

**Backup** (incremental git bundle, about 200 KB instead of 200 MB):

```bash
git bundle create /mnt/user-data/outputs/backup/tankbar-<date>-<n>.bundle <last-bundled-commit>..HEAD --branches
git bundle verify <bundle> && git bundle list-heads <bundle> && sha256sum <bundle>
```

1. Commit the bundle to `D:\screenquarium\backup\`.
2. Test a real restore on the device:
   ```bash
   git clone -q <full>.bundle $HOME/rt && git -C $HOME/rt pull -q <each incremental> master && git -C $HOME/rt log --oneline -1
   ```
   Then `rm -rf $HOME/rt`; that is scratch outside the connected folder, so no permission is needed.
3. Write `<bundle>.sha256`, and add the new bundle to `RESTORE.txt`.

**Tell the owner** the folder and file names in plain words.

## 4. Docs

- **Repo `docs/STATUS.md`:** build version, commit, SHA-256 of the installers, checks passed, latest additions, and what still needs a human before launch.
- **Project docs:** `project_write` with `local_path` for `tankbar/STATUS.md` and `tankbar/HARBOR.md` (copies of the repo files). Rewrite `tankbar/SESSION-HANDOFF.md`: latest commit, what's done, the in-flight work, next steps, and new gotchas.
- **Steam store texts:** keep them free of crypto words. "Sealed by the Harbor's Mint" is fine.

## 5. End of session

If the cloud CLI was logged in to SpacetimeDB, run `spacetime logout`.