# Legion versioning protocol

The orchestrator picks the version number. The owner never names one.

Legion's updater accepts `MAJOR.MINOR.PATCH`, optionally with a single-letter patch suffix
(`0.2.2-a`). The rules below decide when each shape is used; the ordering rules in
`src/core/updater/semver.ts` are what make the lettered form usable at all, and they are
pinned by `test/updater-trust.test.ts`. Getting a version wrong does not degrade gracefully:
the update panel reports no update available, with no error.

## The rule

| Change | Bump | Example |
| --- | --- | --- |
| Bug fix, no dependency change, updater-appliable | **PATCH** | `0.2.1` -> `0.2.2` |
| Patch on a number not yet released, when the next PATCH slot is already spoken for | **LETTERED PATCH** | `0.2.2-a` |
| New feature, or a change in existing behaviour | **MINOR** | `0.2.2` -> `0.3.0` |
| Breaking change, or anything touching `package-lock.json` | **MINOR** + `requiresFullInstall` | `0.3.0`, not self-appliable |
| Pre-1.0 breaking change that invalidates data or config | **MAJOR** | -> `1.0.0` |

Batch what belongs together. Two bug fixes ship as one patch, not two.

## Lettered patches (`0.2.2-a`)

Use this when the owner has already been told a version number, or when the next PATCH slot
is taken. The suffix is a **single lowercase letter**, and it ranks BELOW its own plain
release and ABOVE the one before it:

```
0.2.1  <  0.2.2-a  <  0.2.2-b  <  0.2.2
```

So `0.2.2-a` is offered to anyone on `0.2.1`, and a later plain `0.2.2` supersedes it.

**This is not decoration — a pre-release normally ranks BELOW its own release, which is why
`0.2.1-a` can never work:** everyone is already on `0.2.1`, so it is never offered. Legion's
`src/core/updater/semver.ts` implements the ordering explicitly and `test/updater-trust.test.ts`
pins both directions, because a wrong compare is a downgrade-check hole.

Only `-a` through `-z` (one letter) are accepted. `-rc1`, `-beta.1`, `-a1`, `-ab` and uppercase
are still rejected: a lettered patch is not a general pre-release channel.

### BOOTSTRAP RULE (learned the hard way, 2026-10-04)

**The release that INTRODUCES lettered-patch support must itself be a plain version.**

A lettered patch can only be installed by a build that already accepts letters. An install
predating that support rejects it outright — the manifest fails its version check with
`rejected: the version is not a plain MAJOR.MINOR.PATCH`, **before** any download, approval or
install attempt. Nothing on the server can fix that: the decision is made by the old binary.

So the sequence is: plain `0.2.2` ships the lettered-patch support → everyone upgrades to it →
`0.2.2-a` and later lettered patches work normally from then on. Publishing `0.2.2-a` first
locked every existing install out of the fix that would have unblocked them.

## Why dependency changes cannot be a PATCH

The manifest carries `depsSha256` (a hash of `package-lock.json`). The updater compares it
against the hash of the **installed** lockfile; if they differ, the release is marked
`requiresFullInstall` and the updater refuses to stage it, telling the owner to download the
source and run `setup.cmd` instead. Any change to `package-lock.json` therefore forces a
notify-only release. That is a deliberate safety property, not an obstacle to route around:
a patch release that cannot self-apply would be a lie in the version number.

## Rules that hold for every release

1. One decision, applied without asking the owner: pick the smallest bump that covers every
   change in the batch.
2. `package.json`, `src/shared/config.ts` (`VERSION`), and `package-lock.json` move together.
   A release missing any one of them is not a release.
3. A published release is immutable. Signature + tag + assets are final. A fix for a shipped
   version is always a *new, higher* version — never an edit of the old one.
4. `CHANGELOG.md` gets a dated section for the version, written for someone deciding whether
   to update.
5. The manifest is signed with the release key before publishing; the public half is already
   baked into shipped builds (`src/core/updater/trust.ts`).
6. `publishedAt` must not be earlier than the running build's own `publishedAt`, and a version
   that rolled back is not offered again until a newer one appears.

## Cut procedure

1. Land and verify the fixes on `main`.
2. Bump the three files above; `CHANGELOG.md` entry.
3. `rm -rf dist dist-ui && npm run build` — `build-package.mjs` refuses to package a stale
   `dist` ("dist looks older than src").
4. `node scripts/build-package.mjs --out D:/bots/<pkg-dir> --skip-build`
   (out-dir must be **outside** the repo; use a native `D:/...` path, never `/d/...`).
5. `node scripts/release-manifest.mjs --zip ... --out ... --notes ...`
6. `node scripts/release-sign.mjs --key ... --manifest ...`
7. `gh release create v<version> --target main` with all five assets.
8. Confirm `releases/latest/download/legion-update-manifest.json` serves the new version.
   Freshly uploaded assets return HTTP 503 for roughly a minute while GitHub's CDN warms;
   that is not a failure — re-check before concluding a release is broken.

## Pre-1.0 and the `0.2.x` line

While the major version is `0`, MINOR bumps may carry breaking changes by convention. Legion
does not rely on that: the table above treats behaviour changes as MINOR and breaking changes
as MAJOR, so the number always tells the owner what to expect. The `1.0.0` line is the
stability commitment, not a promise of a date.