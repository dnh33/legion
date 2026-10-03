---
name: "tankbar-deliver-windows"
description: "Build Tankbar's Windows release (installer, portable, web, demo) and deliver it plus source and a git bundle backup to D:\\screenquarium on the owner's PC."
---

# Deliver a Tankbar build to D:\screenquarium

The repo lives in the cloud workspace at `/home/claude/tankbar`. The owner's PC is reached through the remote-devices tools (the folder `D:\screenquarium` is connected; in `device_bash` it is `$HOME/mnt/screenquarium`). If those tools are missing or report no device, stop and say so: nothing on the PC is reachable.

## 1. Gate

1. `npx tsc --noEmit -p .` and `npm test` must pass (21+ core, 32+ Harbor).
2. If the SpacetimeDB module changed: `spacetime start` in the background, then `HARBOR_E2E=1 node scripts/harness/harbor/run-tests.mjs`. Stop the server with `kill $(pgrep -f 'spacetimedb-standalon[e] start')` (a plain `pkill -f` kills its own shell).
3. Commit everything that belongs in the release. Uncommitted work of running agents must not ship.

## 2. Build (cloud)

- Web + demo + Electron bundles: `ALLOW_MOCK_HARBOR=1 node build.mjs --release` (or with `HARBOR_URL` and `HARBOR_MODULE` set once the live Harbor exists).
- Windows installer and portable: `ALLOW_MOCK_HARBOR=1 xvfb-run -a npm run dist:win`. Output in `release/`: `Tankbar-Setup-<v>.exe`, `Tankbar-<v>-portable.exe`.
- Stage into `/mnt/user-data/outputs/delivery/`: the two exes, `dist/web/index.html` as `Tankbar-web.html`, `dist/demo/index.html` as `Tankbar-demo.html`, and `SHA256SUMS.txt` (`sha256sum` of the four files).
- Source update: `git archive -o source-update.zip HEAD` (or only the changed paths since the last delivery: `git archive -o source-update.zip HEAD $(git diff --name-only <lastDeliveredCommit> HEAD)`).
- Backup: `git bundle create tankbar-<date>.bundle --all`.

## 3. Transfer

- `device_commit_files` takes at most 100 MB per call and 20 MB per file, so split large files: `split -b 19m -d file file.part` and commit the parts (5 per call), then send each through `SendUserFile` first when a `file_uuid` is needed, or commit by `stagedPath` under `/mnt/user-data/outputs/`.
- On the PC (`device_bash`): reassemble with `cat file.part* > file`, check `sha256sum -c SHA256SUMS.txt`, unzip `source-update.zip` into `tankbar-source/` (`unzip -o`), put the bundle in `backup/`.
- Delete the `.part` files. Deleting needs the user's permission (`device_request_delete_permission` for the connected folder); if declined, move them into `_to_delete/`.
- Never overwrite a file on the PC that changed since it was staged without asking.

## 4. Report

Tell the owner in plain words which files are in `D:\screenquarium`, the version, the SHA-256 of the installer, what changed, and anything that still needs a human (Steam URL, studio name, code signing, Mint pepper after publishing the Harbor). Update the project docs `tankbar/STATUS.md` and `tankbar/SESSION-HANDOFF.md`.