# Shipping a Legion release

**A release is not done because the code is good and the tests pass. It is done when a Legion that already exists can
install it from inside itself.** Those are different claims, and only the second matters to a user. Do not merge unless
the update is correctly handled and updatable in the Legion app itself.

## When this applies

- Cutting, publishing or rolling back a release, or choosing a version number.
- The updater will not update, Settings says *"This is a git checkout"*, or auto-install is dead.
- Anyone asks "can users install this from inside Legion?"
- Touching anything under `src/core/updater/` or `ui/src/components/UpdatePanel.tsx`.

## Four conditions for an in-app update

All four, or it is not an in-app update.

1. **The install folder is not a git checkout.** `installMode()` returns `checkout` if `.git` exists and disables
   auto-update permanently. Check before shipping:
   ```
   git -C "$LOCALAPPDATA/Programs/Legion" status
   ```
   It must FAIL. If it prints modifications, that folder is a checkout and no release is shippable. Test both shapes:
   a clone's `.git` is a directory, a worktree's is a file.
2. **`requiresFullInstall: false`** in the signed manifest. This field separates a real update from a notify-only
   release the owner must action by hand.
3. **`depsSha256` matches the installed app's `dependencyHash`.** `package-lock.json` carries its own `version`, which
   npm rewrites on every bump, so a raw hash comparison reports "dependencies changed" for every patch and forces a
   full install. `dependencyHash()` blanks the lock's own version fields; compare that. A version-only bump must
   produce an **identical** dependency hash.
4. **The panel offers a clickable install after the download.** A control that renders only while a state is active
   vanishes the moment that state changes; assert what exists in every state.

## The procedure

Full commands: [`docs/SHIPPING.md`](../../docs/SHIPPING.md). The order that matters:

1. **Full suite green in the tree that will become `main`.** Focused suites are not the gate. One gate at a time:
   `npm test` rewrites `dist/`, so a concurrent build corrupts both.
2. **Baseline from the same tree before your change**, so "3 failures" means something next to "3 failures before".
3. **Version in three places**: `package.json`, `src/shared/config.ts` (`VERSION`), `package-lock.json`. Confirm the
   lockfile diff is version-only.
4. **Restore tag first**: `git tag pre-merge-<name> && git push cloud pre-merge-<name>`.
5. **Build outside the repo**, native `D:/...` path (an MSYS `/d/...` becomes `D:\d\...` and ENOENTs).
6. **Manifest from `app.zip`**, not the 285 MB installer zip.
7. **Sign with the key outside every work tree.** The vault key sits inside the owner's vault repo and the signer
   refuses it. Copy out, sign, delete the copy. Never read a key into a session — pass the path.
8. **`release-preflight.mjs` must end "Pre-flight passed".** Do not publish over a failure.
9. **Merge `--no-ff`.** Read every removed test line: `git diff pre-merge-<name> HEAD -- test/ | grep '^-[^-]'`.
10. **DRAFT the release.** `gh release create --draft`, upload all five assets, verify the **uploaded** assets
    (GitHub reports a per-asset `digest`, and it must equal your local sha256), then `--draft=false`.
11. **Verify from the live CDN only AFTER publishing.** A draft's assets are not publicly served —
    `releases/download/...` returns 404 until the release is public. What a draft can prove is byte-equality via the
    asset digest; what only the CDN proves is that an *existing install* can fetch it.

## Never publish then verify

Check everything checkable before `--draft=false`. The CDN fetch is only ever a confirmation that the published bytes
are the bytes you checked — never the first time anything is verified. If the CDN fetch finds a fault, the fault is in
the verification, because the release was already proven receivable by pre-flight and by asset-digest equality.

## Verify an existing install can receive it

Local checks prove your folder is right; they do not prove an existing install receives the release. After upload,
fetch the live manifest:

```
curl -sL https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json
```

**Into a FRESH directory — create it new, never reuse one.** A check that a previous failed attempt can contaminate is
not a check: a stale 9-byte `Not Found` body once produced a false "signature does not match". `rm -rf` and re-create
the directory, then fetch the manifest, its `.sig`, `app.zip` and `SHA256SUMS.txt`, and run `release-verify.mjs`
**on those fetched bytes**. Confirm `version` and `requiresFullInstall: false`.

Freshly uploaded assets 503 for about a minute while the CDN warms — wait and re-fetch.

If any check here is unproven, say so plainly and stop. Do not publish around it and call it done.

## Rollback

Publish draft-first so a bad release is never offered as `latest`. After a rollback, **verify**: `gh release view`, the
asset 404, and the `releases/latest/download` manifest — that last URL is what every install polls.

## Do not burn version numbers

**One number per shipped state, proven receivable by the pre-flight gate.** A number spent on a release nobody can
install is not progress. When an attempt fails, fix and re-cut under the SAME number if it was never published — a
tag exists only once people can install it.

**A pre-release sorts BELOW its own release**, so `0.2.1-a` is never offered to anyone already on `0.2.1`. Lettered
patches work only on the next *unreleased* number. `semver.ts` implements this and `updater-trust.test.ts` pins both
directions.

**When the version grammar changes, grep `scripts/` too.** Duplicated version regexes reject what the app accepts.
The scripts share `VERSION_RE` / `isReleaseVersion` from `scripts/lib/release-lib.mjs`.

## Clicking Update is the consent

The updater raises **no approval card**, deliberately. Clicking Update is the consent, and auto-install-when-idle is
already behind a `window.confirm` on the toggle whose label promises "without asking again" — a second card would
contradict the UI.

What still stands between a GitHub download and running code: the release **signature**, verified before staging;
`requiresFullInstall`; and `consent` gating the commit so a staged update waits for the owner **and** for idle.

You cannot patch someone's installed client remotely. For installs predating a fix, the release notes tell people to
enable auto-install once, update, then disable it.

## Release notes and product copy

Release notes follow `docs/RELEASE-NOTES.md`: effect, not cause; no jargon, no internals; under ~600 characters for a
patch; every manual step as its own plainly-worded line. The manifest carries them, so the pre-flight gate covers them.

**Product copy: never put internal testing status in text a user reads.** No "tested against our own servers", no "not
tested yet", no "not verified in the real app". That is the most unprofessional thing the product can say about itself.

- **Describe the behaviour, not the development state.** "Credentials are sent only to the address you set here" is a
  fact a user can act on.
- **Scope a claim by what is actually scoped**, not by hedging. Never write "safe", "secure" or "cannot be bypassed"
  absolutely.
- **Do not apologise in the UI.** Errors state what happened and what to do; limitations belong in docs and release
  notes.
- **Unverified work is tracked, not shipped.** It is a blocker to fix before release or a line in the release notes —
  never a disclaimer inside the product.

Before shipping, grep the UI for the tells: *fake, mock, stub, dummy, not tested, not yet, TODO, WIP*.
