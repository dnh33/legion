# How to ship and install Legion

**Read this before cutting a release or installing Legion.** Written 2026-10-04 after a release had to be pulled
back. Everything here is verified on this machine, not remembered.

There is exactly **one** Legion folder: `D:\bots\legion`. It is the canonical clone, on `main`, and it is the
remote `cloud`. Everything else under `D:\bots` is a worktree of it, a build scratch folder, or an unpacked package.

---

## The one thing that must never be true

> **An install folder must never be a git worktree of the repository.**

If `%LOCALAPPDATA%\Programs\Legion\.git` exists, Legion refuses to self-update — by design, and correctly. It will
say *"This is a git checkout. Update it yourself: `git pull`, `npm ci`, `npm run build`."* and the
"install updates automatically" control will be dead.

That is not a bug to work around. It is the updater telling the truth: an app that lives inside a working copy of
its own source repository cannot be swapped underneath itself.

### How it happened here, so it is recognisable

On 2026-10-04 the install folder was found to be a **git worktree on `main`**:

```
%LOCALAPPDATA%\Programs\Legion\.git
  -> gitdir: D:/bots/legion-dev/.git/worktrees/legion-review
git log -1  -> deb5a69      (a commit pushed minutes earlier)
```

Two things were tangled at once:

1. The install folder was registered as a worktree, so **every push to `main` landed inside the installed app** and
   showed up there as local modifications.
2. The worktree's metadata pointed at `D:/bots/legion/.git` while living in `D:/bots/legion-dev/.git` — orphaned
   leftovers from the `legion-review` → `legion` rename earlier the same day.

**The tell:** if `git status` inside `%LOCALAPPDATA%\Programs\Legion` succeeds and prints `M CHANGELOG.md`, the
folder is a checkout, not an install. Check this **before** shipping anything, not after.

### The guard that exists, and the hole in it

`scripts/setup.ps1` calls `Get-InstallDirVerdict` (`scripts/lib/legion-procs.ps1:153`) before touching anything. It
refuses a drive root, your user profile, the data folder, a file instead of a folder, and any non-empty folder that
is not a Legion install.

It **accepts** a folder that "is an existing Legion install (`package.json` name is legion)". A git worktree also has
`package.json` named `legion`, so it passes. **The guard does not check for `.git`.** That is the hole, and it is why
this was not caught at install time. Fixing it is the first item in "What still needs fixing" below.

---

## Installing Legion (what a user does)

**From a GitHub release — the normal path, and the only one that can self-update:**

1. Download `legion-<version>-win-x64.zip` from the release page.
2. Unpack it anywhere. It becomes a folder named `legion-<version>`.
3. Double-click **`setup.cmd`** in that folder. It installs to `%LOCALAPPDATA%\Programs\Legion` by default
   (`-InstallDir "D:\Legion"` to choose another), verifies the package hash, and swaps it into place.
4. Launch with **`start-legion.cmd`**.

There is **no `npm ci`, no `npm run build`, no `git pull`** in this path. The package is prebuilt; `setup.cmd` does
not compile anything. If a document tells you to run npm on an installed Legion, that document is wrong.

**Verify the install afterwards:**

```
%LOCALAPPDATA%\Programs\Legion\.git   must NOT exist
```

If it exists, you are looking at a checkout. See "Fixing an install folder that became a checkout".

---

## Shipping a release

Every step, in order. The gate exists because three releases passed the whole test suite and were uninstallable.

### 0. Know where you are

```
D:\bots\legion          canonical clone, main, remote "cloud"    <- work here
D:\bots\legion-<topic>  a worktree for ONE feature               <- also fine, merge when done
```

Never ship from a worktree that is not merged. Never build or test in the install folder.

### 0b. Live test before the release, not after

As soon as a feature runs, put a test copy of the release branch on the owner's PC and let him click through it in the real Legion window. The copy has its own data folder (`LEGION_HOME`) and port, and is launched from the worktree, so his real install is not touched. Unit tests and stubbed screenshots do not replace this. The 0.3.0 live test found a sign-in that never showed its code, and a missing in-app repo picker, both after every PR had merged. Checking external-API assumptions in the spec against the official docs before building would have caught the second.

### 1. Gate

GitHub CI is the full-suite gate: all 11 required checks green on the release PR's head (Windows, macOS, Linux
tests, installers, typecheck + UI build). `main` requires the branch to be up to date, so that head already holds
`main`. Record the run id. Locally, run only what CI cannot: the typecheck, the test files the change touches, and the
in-app test in an isolated test copy. A full local run (`LEGION_LOCAL_GATE=1 npm test`) is opt-in, one at a time
(it rewrites `dist/`).

```
npm run typecheck
npm run build:ts
node --test dist/test/<touched>.test.js
gh pr checks <pr>              # all pass, then record the run id
```

**Package files check.** `package.json` and `package-lock.json` must be byte-identical to `main` on a release branch that
changes no dependencies (a full install would end the updater stepping stone). Compare hashes, not eyes:

```
git diff --stat cloud/main -- package.json package-lock.json   # prints nothing
git show cloud/main:package.json | sha256sum; sha256sum package.json
git show cloud/main:package-lock.json | sha256sum; sha256sum package-lock.json
```

Each pair must match. A difference is a stop unless the release is a planned dependency release.

Run a **clean-`main` baseline first** if you intend to claim a failure is pre-existing. Do not skip this: it is the
only way to tell your breakage from someone else's.

### 2. Version, in three places together

`package.json`, `src/shared/config.ts` (`VERSION`), `package-lock.json`. A release missing one is not a release.

```
npm install --package-lock-only
```

Then **check the lockfile diff is version-only.** Anything else means a dependency changed, which forces
`requiresFullInstall` and turns a self-update into a notify-only release.

Lettered patches (`0.2.3-a`, `-b`, …) only work on an **unreleased** base, and never before their letters are done —
a pre-release sorts *below* its own base, which is how `0.2.2-a` died. See `docs/VERSIONING.md`.

### 3. Restore tag, before anything can go wrong

```
git tag pre-merge-<name> && git push cloud pre-merge-<name>
```

### 4a. Build on GitHub Actions (the normal path)

The workflow `.github/workflows/release-build.yml` builds the package on a Windows runner, then records **signed SLSA build provenance** for the artifact (the `attest` job). It never signs the release and never publishes it: signing and publishing stay on the PC, and the signing key never goes to Actions. The `build` job is read-only; only the `attest` job holds write scopes, and only the three attestation scopes (`id-token`, `attestations`, `artifact-metadata`).

1. Make sure `docs/release-notes/<v>.txt` is committed in the release PR. It is the text the updater shows. Max 2000 chars.
2. After the release commit is on main, push the tag: `git tag v<v> && git push cloud v<v>`. The tag push starts "Release build" in Actions. Do not push test tags. For a dry run, use the manual run with `ref`.
3. Check the run is the tag build of the reviewed commit, then download it. `gh run view <run-id> --repo dnh33/legion --json event,headBranch,headSha,path` must say `event` = `push`, `headBranch` = `v<v>`, `path` = `.github/workflows/release-build.yml`, and `headSha` = `git rev-parse v<v>^{commit}`, a commit on main (`git merge-base --is-ancestor <sha> cloud/main`). Only a tag build makes an artifact named `legion-<v>-release`; a manual run makes `legion-<v>-DRYRUN-<sha7>`, which is never signed. Then: `gh run download <run-id> --repo dnh33/legion -n legion-<v>-release -D D:/bots/legion-pkg-<v>`.
4. Check the hashes. Compare `sha256sum` (or `Get-FileHash`) of each file with SHA256SUMS.txt and with the hashes in the run's job summary. Compare install.ps1 and install.sh with the files in your own checkout at the tag. Use the working-tree files, not `git show`, which drops the CRLF line endings of .ps1. Check `build-info.json` inside app.zip: `commit` is the same SHA as in step 3, and `dirty` is `false`. A match proves the download is what the runner produced from that commit. It does not prove what the runner ran: the dependency install runs on the runner too. The run also attests the artifact, so check its provenance: `gh attestation verify D:/bots/legion-pkg-<v>/legion-<v>-win-x64.zip --repo dnh33/legion` (repeat per file). Until checks RB1 and RB2 in `claude/tracker-pc-checks.md` have passed, also build app.zip on the PC from the tag (step 4 below) and sign only if its SHA-256 equals the artifact's.
5. Do NOT re-run release-manifest on the PC. CI already wrote the final manifest. It compares the dependency tree of `package-lock.json` with the previous release tag (the same `dependencyHash` the app uses, so a version-only lock change does not count). When the tree changed, the manifest carries `requiresFullInstall: true` and the signed `fullAsset` (name, size and sha256 of `legion-<v>-win-x64.zip`); otherwise neither. Read the decision in the run summary ("Full install needed") and check it matches what you expect for this release. A wrong answer is a reason to stop, not to patch the manifest by hand. If you ever must run it yourself, a dependency-change release needs both flags: `node scripts/release-manifest.mjs --zip <app.zip> --full-zip <win-x64.zip> --requires-full-install --notes docs/release-notes/<v>.txt --out <folder>`. `--requires-full-install` alone is refused (the release could only notify); `--notify-only` asks for that on purpose.
6. Then skip steps 4 and 5 below and go on from step 6 (Sign) of this section: 6, 7, 7a, 9 and 10 as written (8 is done, because the tag is on main). Sign on the PC. The key never goes to Actions.

### 4. Fallback: build the package on the PC, **outside the repo**

Use this when Actions is down or for a hotfix; steps 4 and 5 are the old local path.

```
rm -rf dist dist-ui && npm run build
node scripts/build-package.mjs --out D:/bots/legion-pkg-<v> --skip-build
```

Use a **native `D:/...` path**. An MSYS `/d/...` becomes `D:\d\...` inside node and ENOENTs.

It refuses to build on a dirty tree — that is correct, commit first.

Produces two zips: `legion-<v>-win-x64.zip` (285 MB, the installer) and `legion-<v>-app.zip` (2.5 MB, the updater's
code-only subset).

### 5. Manifest — from `app.zip`, **not** the full zip

A release publishes **two manifest names** (see [Stepping stones](#stepping-stones)). `release-manifest.mjs` writes both: `legion-update-manifest-2.json` is the release's own manifest, `legion-update-manifest.json` is what a 0.2.7 install reads. **Every release after the stone (0.3.0), code-only or full, needs `--stepping-stone <folder>`**: the folder holds the stone's own published `legion-update-manifest.json` and `.sig` (`gh release download v0.3.0 -p 'legion-update-manifest.json*' -D <folder>`). They are copied byte for byte under the old name and never re-signed. A full-install release's own manifest also names the stone and sets `minUpdater: 2`. Without `--stepping-stone` the script refuses (a later release under the old name would be staged by a 0.2.7 install, fail the dependency-hash check and strand it). Only the stone release itself (a version listed in `scripts/stepping-stones.json`) is built without the flag: both names carry its own manifest. The release build workflow does this for you.

```
node scripts/release-manifest.mjs --zip D:/bots/legion-pkg-<v>/legion-<v>-app.zip \
     --out D:/bots/legion-pkg-<v> --notes <notes-file>
```

Passing the 285 MB zip fails with a naming error that does not explain which zip is expected.

### 6. Sign (the manifest **and** SHA256SUMS)

```
node scripts/release-sign.mjs      --key <key.pem> --manifest D:/bots/legion-pkg-<v>/legion-update-manifest-2.json
node scripts/release-sign-sums.mjs --key <key.pem> --sums     D:/bots/legion-pkg-<v>/SHA256SUMS.txt
```

The first signs the release's own manifest (`legion-update-manifest-2.json`), which the app checks before it stages an update; for the stone release itself it also writes the same `.sig` for the identical old-name file; for every later release the old name already carries the stone's own `.sig`, so nothing else is signed. The second signs `SHA256SUMS.txt`,
so the hashes a downloader compares are covered by a signature and not only by a file that travelled beside them; it
writes `SHA256SUMS.txt.sig` next to it. Both use the same k1 key, both write a detached Ed25519 signature in the same
`{"keyId","alg","sig"}` shape, and both refuse a key that is not the one the app trusts.

**The key must be outside every git work tree.** The vault path
`D:\the owner's vault\04-claude\credentials\legion-updater\legion-update-k1.key.pem` is *inside* the owner's vault's own git repo
and the script refuses it. Copy to `D:\bots\_key.pem`, sign, delete the copy immediately. Never read the key into an
agent session; pass the path.

### 7. THE GATE — mandatory, must end in "Pre-flight passed"

```
node scripts/release-preflight.mjs --version <v> --pkg D:/bots/legion-pkg-<v>
node scripts/release-verify.mjs   --dir D:/bots/legion-pkg-<v>
```

This answers the one question `npm test` cannot: *can an install that exists today actually receive this release?*
It checks version reciprocity, lockfile-vs-dependency hashing, artifact/manifest/sha agreement, notes presence, and
verifies the signature **with the app's own verifier and its own baked-in keys**. It also checks `SHA256SUMS.txt.sig`
against the same key when that file is present (it is optional, so a release signed before the sums signer existed
still passes).

Both scripts also check the old name (`--no-network` skips only the download, for rehearsals): the old name must be the permanent signed stepping stone, 0.3.0, pinned in `scripts/lib/stepping-stone.mjs` (the stone release itself: its own manifest, identical under both names), byte for byte the files published at `v0.3.0` (fetched, a network failure fails the check; `release-publish.mjs` runs the same checks before it creates the draft), a full-install release's second manifest must name it and set `minUpdater`, and the stone's package URL must return the signed size and sha256. A later release that carries itself under the old name fails. Missing either name fails.

A full-install release adds these checks (both scripts fail, not warn): the manifest's `fullAsset` must equal the `legion-<v>-win-x64.zip` in the folder (name, size, sha256) and be listed in `SHA256SUMS.txt`; a release that does not need a full install must not carry a `fullAsset`.

### 7a. Rehearse the update (full-install releases)

Run the workflow "Full-install rehearsal" on the release commit (`gh workflow run full-install-rehearsal.yml --repo dnh33/legion --ref <commit or tag>`) and write the run id in the release PR. It installs the latest published release with `install.ps1`, then updates that install to a candidate built from the same commit, from a loopback server, with a throwaway signing key: success (the new version reports health, files match the package list, user data survives), rollback (a first start that fails puts the old version back) and a locked file (the swap refuses cleanly). `stone-walk` (the live release goes to a code-only stone, then to the full candidate, install intact and data surviving) and `stone-direct` (a build with the new updater goes straight to the full candidate through the second manifest name) and `stone-later` (a code-only release published after the full one: the live release reaches the stone through the old name, then the newest release through the second name) must be green too. `vanished-live` is informational: it documents the known old-helper case that the stepping stone exists to avoid. Nothing real is touched. All three scenarios must be green before you publish.

**Do not publish over a failure.** Two warnings are known and benign on Windows installs:
`lettered patch: only installs that ALREADY support lettered versions…` (safe once any `-a` has shipped) and
`could not determine installMode (non-fatal)`.

### 7b. THE FULL SUITE MUST BE GREEN BEFORE `main` IS TOUCHED

The release PR's CI, all 11 required checks, on a head that is up to date with `main` (step 1). Two rules that are
not negotiable, both learned the hard way on 2026-10-04:

- **Focused suites are not the gate.** Running the seven suites a change touches proves the change works. It says
  nothing about the other 2,400 tests. Merging on focused evidence alone is merging on a guess.
- **One local full run at a time, if you opt in to one.** `npm test` rewrites `dist/`, so a concurrent `npm run build:ts` — from another agent,
  a scratch worktree, or a probe script — silently corrupts both results. Two suites writing the same output
  produce numbers that mean nothing, and the failure mode looks like flaky tests.

If the full suite is still running, `main` waits. There is no cost to waiting; the cost of a red `main` is that
every subsequent session inherits it and cannot tell whose failure it is.

Record the counts, and compare them against a baseline from the same tree before the change. "3 failures" is
only meaningful next to "3 failures before".

### 8. Merge and push

```
git merge --no-ff <branch>          # restore tag already pushed
git diff pre-merge-<name> HEAD -- test/ | grep '^-[^-]'    # MUST be empty
git push cloud main
```

Read every removed test line. No test may vanish silently.

### 9. Publish — **draft first, always**

```
node scripts/release-publish.mjs --dir D:/bots/legion-pkg-<v> --version <v> --notes-file <file>
```

`release-publish.mjs` refuses to start unless all ten files are in the folder, then runs `gh release create --draft`, one `gh release upload` of all ten, and only then `gh release edit --draft=false --latest`. So `releases/latest` never serves a release whose second manifest, signature or package is still missing. `--dry-run` prints the three commands. If a step fails the release stays a draft; fix it and run the missing step by hand.

Ten assets: `app.zip`, `win-x64.zip`, `legion-update-manifest.json` and its `.sig`, `legion-update-manifest-2.json` and its `.sig`, `SHA256SUMS.txt`, `SHA256SUMS.txt.sig`, `install.ps1` and `install.sh`. **Every release publishes both manifest names**: a release without the second name makes every 0.3.0+ install read a 404, fall back to the stone and say "up to date" for ever. The installers are not optional: `getlegion.xyz/install.ps1` fetches `install.ps1` from the latest release, so a release without it breaks every new install the moment it becomes latest (0.2.6-s and 0.2.6-t shipped without them on 2026-10-12; new installs failed until they were added).

**Why draft first:** `gh release create` without `--draft` publishes immediately. A draft lets you upload, verify,
and abort without anything being visible. On 2026-10-04 this is exactly what made a rollback possible — the release
was deleted, its assets 404'd, and `/releases/latest` pointed back at the previous good version within a minute.

### 10. Verify from the **live CDN**, not your disk

Freshly uploaded assets 503 for about a minute while GitHub's CDN warms. That is not a failure. The `latest` URL can also
keep serving the PREVIOUS release's manifest for a few minutes (seen 2026-10-06 with 0.2.5-f): fetch it until `version` is
the new one before running the verify, or the verify sees a mix of two releases and fails. Then:

```
curl -sL https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json
```

Fetch `legion-update-manifest-2.json` (and its `.sig`) from the same live URL too: it must answer 200 with the new version, and `node scripts/stone-check.mjs` must pass (it fails on a missing second name, a second name that is not the latest tag, an old name that is not the stone byte for byte, and a stone package that does not return the signed size and sha256). Check `version` **and** `requiresFullInstall` (false for a code-only release; true for a dependency change, and then the manifest must carry `fullAsset`). Download the manifest, its `.sig`, the `app.zip` and
`SHA256SUMS.txt` into a fresh folder and run `release-verify.mjs` **on those fetched bytes**. Local verification
proves the folder is right; this proves a real install can receive it. For a full-install release also download `legion-<v>-win-x64.zip` from the live URL and compare its size and sha256 with the manifest's `fullAsset`: `release-verify.mjs` does this when the zip is in the folder, and the first real test of a 285 MB download must not be a user's PC.

Then check that a new install still works: `curl -sL https://getlegion.xyz/install.ps1` must return the same bytes as
the release's `install.ps1` (not "Legion installer unavailable"), and
`https://github.com/dnh33/legion/releases/latest/download/install.sh` must answer 200.

### 11. Rebuild the website

The website (repo `dnh33/legion-site`, served at getlegion.xyz) reads the latest release's version when it is built
(`tools/fetch-version.mjs`), so after a release it still shows the old version until it is rebuilt. Cloudflare Pages
rebuilds on every push to its `main`: merge the site's pending change, or trigger a rebuild, then check the live page
in a browser (curl without a browser user agent gets the install script, not the page) shows the new version.

### 12. Clean up

Never delete a stepping-stone release, tag or asset (see [Stepping stones](#stepping-stones)). Skip any release listed there.

When the release is live, remove what the work left behind: merged branches (local and remote), worktrees made for
it, package and scratch folders, merged or superseded PRs. Anything with unmerged commits, someone else's uncommitted
work or a stash is listed for the owner, not deleted. Keep the `pre-merge-*` restore tags.

---

## Stepping stones

A 0.2.7 install reads only `releases/latest/download/legion-update-manifest.json` and builds its package address from that manifest's **version** (`releases/download/v<version>/...`). Its old swap helper cannot be trusted with a full-install package (rehearsal run 38534394554: in `vanished-live` it swapped an incomplete package and still reported healthy). So a full-install release must never be what the old name offers. Instead:

- The old name carries a **stepping stone**: a code-only release whose updater is new enough (0.3.0, updater generation 2), as its own signed manifest and `.sig`, copied byte for byte. This holds for **every release after the stone, code-only or full**, not only full-install ones: a later code-only release under the old name would be staged by a 0.2.7 install, fail its dependency-hash check and strand it. Only the stone release itself publishes its own manifest under both names.
- **Every release publishes both names.** A 404 on the second name is a failure everywhere (the daily check, preflight, verify, the publish script), never a fallback: 0.3.0+ installs would silently stay on the stone.
- The new name `legion-update-manifest-2.json` carries the full release. Generation 2 and later read it first and fall back to the old name only when it is absent (404), never on a signature or parse failure. It sets `minUpdater` and signs the stone (`steppingStone`: version, date, deps hash, asset name, size, sha256). A client below `minUpdater` is offered only that stone, or nothing and a plain message when there is none.
- Result: an install on 0.2.7 goes to 0.3.0 on its next check, then to the full release on the check after, whatever day it wakes up.

Stepping stones (the list is `scripts/stepping-stones.json`; a test keeps this section and that file in step):

| Version | Release | Why |
| --- | --- | --- |
| 0.3.0 | `v0.3.0` | first release with the second manifest name and `minUpdater`; the stone for every full-install release while 0.2.7 installs exist |

**Never delete a stepping-stone release, tag or asset.** 0.2.7 builds the address from the manifest version, so deleting `v0.3.0` or its zip strands every 0.2.7 install, silently. Release clean-up (step 12) never touches a release listed above, and a stone's assets are never replaced.

Protection and detection:

1. **Tag ruleset** (owner, one time, not done by any script run in CI): the `v*` ruleset below already blocks update and deletion of every release tag except by the owner. Keep it active, and confirm it with `gh api repos/dnh33/legion/rulesets --jq '.[] | select(.target=="tag") | {name, enforcement}'`. For a ruleset that names only the stones, create one over `refs/tags/v0.3.0` with the `deletion` and `update` rules and no bypass actor other than the owner role (`node scripts/gh-tag-ruleset.mjs` prints a body to adapt). This document does not change repository settings.
2. **Every release's gate** (step 7) fetches the stone's package from its public URL and checks the signed size and sha256.
3. **Daily check**: `.github/workflows/stone-check.yml` runs `node scripts/stone-check.mjs` against the live latest release: the latest release must publish the second manifest name (404 is a failure) whose version is the latest tag, the old-name manifest must verify and be the stone byte for byte as published at its tag, and the stone's package must still return the signed size and sha256. A red run means a stone is damaged or gone: restore it that day (re-upload the identical asset from the release build).

---

## Protect the `v*` release tags (one-time, owner only)

A release is identified by a `v*` tag, so a tag anyone can move or recreate is a release anyone can re-point at other
bytes. Apply the tag protection ruleset once, as the repository owner:

```
node scripts/gh-tag-ruleset.mjs            # prints the ruleset and the exact gh command; touches nothing
node scripts/gh-tag-ruleset.mjs --apply    # creates it (needs gh authenticated with admin on dnh33/legion)
```

It creates an active `tag` ruleset over `refs/tags/v*` that restricts **creation, update and deletion** to the repository
admin role (the owner) and no one else. Running `--apply` again updates the same ruleset by name instead of failing. The
script sends the official `POST /repos/{owner}/{repo}/rulesets` body (the field sources are in its header comment); to do
it by hand:

```
node scripts/gh-tag-ruleset.mjs --repo dnh33/legion > ruleset.json
gh api --method POST repos/dnh33/legion/rulesets --input ruleset.json
```

Confirm it took, then leave it alone:

```
gh api repos/dnh33/legion/rulesets --jq '.[] | select(.target=="tag") | .name'
```

This is the owner's own `gh`, never Actions: the ruleset step is the one place a write scope is involved, and it carries
no secret of its own. A changed ruleset is a deliberate, manual act.

---

## Rolling a release back

Fast, and the reason to draft first.

```
gh release delete <v> --repo dnh33/legion --yes --cleanup-tag
```

Then **confirm**, do not assume:

```
gh release view <v>                                  -> "release not found"
curl -o /dev/null -w "%{http_code}" -L <asset URL>   -> 404
git ls-remote --tags cloud | grep <v>                -> nothing
curl -sL .../releases/latest/download/legion-update-manifest.json | head -3
```

The last one is the one that matters: it is the URL every install polls, so it is what decides whether anyone is
offered the bad version.

---

## Fixing an install folder that became a checkout

Only after the release side is settled. **Park, never delete** — every step here is reversible.

1. `git -C <install> status` — is anything uncommitted that is not yours? **Ask the owner before continuing.**
2. Move the orphaned worktree metadata aside, renamed:
   `D:\bots\legion-dev\.git\worktrees\legion-review` → `…\legion-review.stale-<date>`
3. Delete the single `.git` **file** in the install folder. That is what re-enables auto-update.
4. Re-run `setup.cmd` from a freshly downloaded release package, so the folder is a clean unpacked copy.

---

## What still needs fixing

- **`Get-InstallDirVerdict` does not check for `.git`** (`scripts/lib/legion-procs.ps1:153-183`). It should refuse a
  folder containing a `.git` file or directory, naming the reason. This is the root cause and it is unfixed.
- **No pre-ship check that the install folder is not a checkout.** The release procedure should assert it.
- **`D:\bots\legion-dev` still exists** as a separate clone with a live worktree list, which is how the metadata got
  tangled. It should be retired or its relationship to `D:\bots\legion` documented.

## GitHub Apps

The two Legion GitHub Apps are production infrastructure. Rules for them: [GITHUB-APPS.md](GITHUB-APPS.md).
