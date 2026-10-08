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

### 1. Gate (one at a time — `npm test` clobbers `dist/`)

A release runs the full suite locally on purpose, so set `LEGION_LOCAL_GATE=1` for this step (the PR's CI runs it too).

```
npm ci
npm run build:ts
npm test                       # record the EXACT counts
npm run typecheck
npm run build:ui
```

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
5. If the release needs a full install (dependencies changed), re-run release-manifest on the PC with `--requires-full-install --notes docs/release-notes/<v>.txt` against the downloaded app.zip, into the same folder. It rewrites the manifest and its SHA256SUMS line.
6. Then skip steps 4 and 5 below and go on from step 6 (Sign) of this section: 6, 7, 9 and 10 as written (8 is done, because the tag is on main). Sign on the PC. The key never goes to Actions.

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

```
node scripts/release-manifest.mjs --zip D:/bots/legion-pkg-<v>/legion-<v>-app.zip \
     --out D:/bots/legion-pkg-<v> --notes <notes-file>
```

Passing the 285 MB zip fails with a naming error that does not explain which zip is expected.

### 6. Sign (the manifest **and** SHA256SUMS)

```
node scripts/release-sign.mjs      --key <key.pem> --manifest D:/bots/legion-pkg-<v>/legion-update-manifest.json
node scripts/release-sign-sums.mjs --key <key.pem> --sums     D:/bots/legion-pkg-<v>/SHA256SUMS.txt
```

The first signs the update manifest, which the app checks before it stages an update. The second signs `SHA256SUMS.txt`,
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

**Do not publish over a failure.** Two warnings are known and benign on Windows installs:
`lettered patch: only installs that ALREADY support lettered versions…` (safe once any `-a` has shipped) and
`could not determine installMode (non-fatal)`.

### 7b. THE FULL SUITE MUST BE GREEN BEFORE `main` IS TOUCHED

`npm test` on the merged tree, in the folder that will be `main`, with nothing else building at the time. Two
rules that are not negotiable, both learned the hard way on 2026-10-04:

- **Focused suites are not the gate.** Running the seven suites a change touches proves the change works. It says
  nothing about the other 2,400 tests. Merging on focused evidence alone is merging on a guess.
- **One gate at a time.** `npm test` rewrites `dist/`, so a concurrent `npm run build:ts` — from another agent,
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
gh release create <v> --repo dnh33/legion --title "..." --notes-file <file> --draft
gh release upload <v> --repo dnh33/legion <the six assets>
gh release edit <v> --repo dnh33/legion --draft=false
```

Six assets: `app.zip`, `win-x64.zip`, `legion-update-manifest.json`, its `.sig`, `SHA256SUMS.txt` and `SHA256SUMS.txt.sig`.

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

Check `version` **and** `requiresFullInstall: false`. Download the manifest, its `.sig`, the `app.zip` and
`SHA256SUMS.txt` into a fresh folder and run `release-verify.mjs` **on those fetched bytes**. Local verification
proves the folder is right; this proves a real install can receive it.

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