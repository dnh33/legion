# Updates

How an installed Legion gets a new version, and what is and is not checked. Plan and design record: `claude/plan-updater.md`. Code: `src/core/updater/*`, `src/electron/updater-main.ts`, `ui/src/components/UpdatePanel.tsx`, `scripts/release-*.mjs`. Not yet tried on a real Windows PC: `claude/tracker-pc-checks-updater.md`.

## What the user sees

- Settings, About, "Updates": the version you run, the last check, and, when a newer verified release exists, its version, size, date and notes (plain text). **Update** asks for an approval card; only then is anything downloaded.
- After the download is checked and unpacked: "Update ready, will install when Legion is idle", with the reasons while it is busy. It is applied by itself once Legion has been idle for 60 seconds (no task, agent run, approval, VM install or stop, or Blender download). **Restart now** shows a native dialog naming what will stop. Running tasks are cancelled and are not resumed automatically; pending approvals are denied; cloud VMs are not touched (they keep billing until you stop them).
- Switches: check on launch and every 12 hours (on; one GET to github.com, nothing about you is sent beyond your IP address and the Legion version); install automatically when idle (off).
- A git checkout, an unwritable install folder, a non-Windows system, or a release that changes dependencies only shows a notice (for a checkout: `git pull`, `npm ci`, `npm run build`; Legion never runs git or npm).

## What is verified before anything is applied

Legion's own code, in this order: the request goes to a fixed address built from constants (`https://github.com/dnh33/legion/releases/...`), https only, port 443, host in `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, on every redirect hop (max 3); the manifest and its signature are size-capped; the Ed25519 signature over the raw manifest bytes verifies against a key in `src/core/updater/trust.ts`; the manifest passes a strict schema (product, stable channel, plain semver, asset name `legion-<version>-app.zip`); the version is newer than the running one and the publish date is not older than the running build (and not in the future); the package is downloaded only after consent, capped at the signed size, and its sha256 must equal the signed one before anything is unpacked; the strict zip reader refuses path traversal, absolute and drive paths, links, duplicates and size lies; only the update code set (`dist`, `dist-ui`, `assets`, `scripts`, `licenses`, a few root files) is accepted; `package.json` carries the signed version and the dependency lock equals the signed hash and the installed one (otherwise: notice only).

## How it is applied

The core never restarts anything. When the core reports an approved update ready and idle, the Electron app copies `apply.js` out to `<install>\.update\run\apply.mjs`, starts it detached under the installed Electron binary in node mode, and quits. The helper waits for the app to exit and for the port to be free, then renames the code folders into `.update\prev` and the staged ones into place (journaled; only those names, only inside the install folder), starts the app, and waits up to 60 seconds for `/health` to report the new version. If that fails, it stops the new build by PID, puts the previous version back, starts it, and records the version as failed (it is not offered again). An update cut off at any point is rolled back at the next start, before the core starts. Exactly one previous version is kept. The data folder and `node_modules` are not touched; `state.json` is copied once to `<data>\updater\state-before-<version>.json` and not restored automatically.

## What is not protected

A compromised maintainer account together with the signing key, a compromised signing key (there is no remote revocation; recovery is a manual reinstall and a release that changes the key), a malicious change the maintainer builds and signs, a compromised build machine, withholding or freezing of updates, the first install (trust on first use of the repository), and a program running as your OS user. Node, Electron and npm dependencies are not updated here. Unsigned build; no reproducible-build check.

## Releasing (owner)

1. Once: `node scripts/release-keygen.mjs --out <folder outside the repo>`. It writes the private key (0600) there and prints the public key; paste the public key into `UPDATE_KEYS` in `src/core/updater/trust.ts`. Keep the private key offline (hardware key or an encrypted stick), keep two backups, never in GitHub secrets, CI, the repo or a chat. Rotation: ship a signed release with the old and the new key in the list; drop the old key in a later release.
2. Per release: bump the version, `npm ci && npm run build`, `node scripts/release-package.mjs --out <dir>`, `node scripts/release-manifest.mjs --zip <dir>/legion-<v>-app.zip --out <dir> --notes <file> [--previous <last manifest>]`, `node scripts/release-sign.mjs --key <private key> --manifest <dir>/legion-update-manifest.json`, `node scripts/release-verify.mjs --dir <dir>`.
3. Publish by hand: tag `v<version>`, a GitHub release (not a draft or pre-release) with the four files `legion-<v>-app.zip`, `legion-update-manifest.json`, `legion-update-manifest.json.sig`, `SHA256SUMS.txt`. If the release changes dependencies, pass `--requires-full-install` to the manifest script; installs then only get a notice and use the source zip with `setup.cmd`.
4. Test the path from the previous version on a copy install before announcing.
