---
name: upgrading-electron
description: Use before changing the Electron version in package.json for any reason (a security fix, a new feature, Dependabot), and when test/electron-pin.test.ts or the "Electron upgrade record" CI job fails.
---

# Upgrading Electron

Electron is Legion's runtime, not a library: it draws every window, and in a Windows package install it also runs the core
(`ELECTRON_RUN_AS_NODE`, `src/electron/resolve-node.ts`), so its Node is the core's Node. A new Electron is a migration.
Legion keeps working only if the person changing it reads what Electron changed, in Electron's own words, and checks the
Legion code those changes touch. CI enforces that, so an upgrade without the reading does not merge.

## When this applies

- Any change to `devDependencies.electron` or to `node_modules/electron` in `package-lock.json`, by hand or by a bot.
- `test/electron-pin.test.ts` fails, or the `Electron upgrade record` CI job fails.

## The rules

1. **Pin exactly.** `npm i -E -D electron@<x.y.z>`, never `^` or `~`. *Why:* a range lets `npm install` pick a version
   nobody read; the package, the full-install hash and the update route all follow the lock.
2. **Read the official sources, all of them.** Start with `node scripts/electron-upgrade.mjs --draft <x.y.z>`: it lists every
   stable version between the current pin and the target from the npm registry, with each release page, and prints the notes.
   - Every version's notes at `https://github.com/electron/electron/releases/tag/v<version>`. An empty page (it happens: 44.9.1
     carried a security fix with empty notes) means you read its commits on the compare page instead.
   - For every major crossed, its section of the breaking-changes guide,
     `https://github.com/electron/electron/blob/main/docs/breaking-changes.md`, and the matching migration notes it links.
   - Never a blog post, a changelog aggregator or memory instead. *Why:* only Electron's own pages say what changed in the build
     Legion ships.
3. **Read each change against Legion.** For every note, `rg` the API it names in `src/electron`, `src/core` and `scripts/`.
   Write the result in the version's `affects` ("none: Legion denies window.open" is an answer; an empty string is not).
4. **Record it** in `docs/electron-upgrades.json`, appended as the last entry (`from` = the old pin, `to` = the new pin):
   `why`, every version with its notes URL and `affects`, `majorsCrossed`, `apisChecked` (the API, the Legion file you read,
   the verdict) and `checks` (what you ran). If the upgrade fixes a security issue, raise `floor` to the first fixed version.
5. **Prove Legion still runs**, then list it in `checks`: the full suite (CI), `npm run build`, one launch of the real app in its
   own data folder (`.claude/skills/verifying-changes`), and for a TLS or certificate fix the live probe
   (`LEGION_LIVE_TLS=1 node --test dist/test/tls-blocklist-live.test.js`).
6. **It is a dependency release.** The lock changes, so the next release is a full install (signed full package on Windows, a
   notice on Mac and Linux). Read `.claude/skills/shipping-a-release` before cutting it.

## Failure modes

- A bot opens the bump. Do not merge its PR: make the same change as your own commit with the record, then close the bot PR.
- The notes are read but not the code: `affects` says "none" for an API Legion uses. The API checks name a file so a reviewer
  can follow them; a reviewer reads at least one.
- A security fix is assumed to reach every user. It reaches what runs on Electron: the window everywhere, and the core only in a
  Windows package install. Source installs, Mac and Linux run the core on plain Node.js (see `src/core/tls-blocklist.ts`).
