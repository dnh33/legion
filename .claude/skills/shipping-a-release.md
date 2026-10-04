# Shipping a Legion release

**The rule that governs everything here, from the owner (2026-10-04):**

> dont merge unless we are 100% done, and its an update that is correctly handled and is updatable in the Legion app
> itself you hear me? note this fucking down

A release is not done because the code is good and the tests pass. It is done when **a Legion that already exists can
install it from inside itself.** Those are different claims and only the second one matters to a user.

## When this applies

- Cutting, publishing or rolling back a release, or choosing a version number.
- The updater will not update, Settings says *"This is a git checkout"*, or auto-install is dead.
- Anyone asks "can users install this from inside Legion?"
- Touching anything under `src/core/updater/` or `ui/src/components/UpdatePanel.tsx`.

## What makes an update installable in-app

Four conditions. All four, or it is not an in-app update.

1. **The install folder is not a git checkout.** `installMode()` returns `checkout` if `.git` exists, and auto-update
   is permanently disabled. Check before shipping:
   ```
   git -C "$LOCALAPPDATA/Programs/Legion" status
   ```
   It must FAIL. If it prints modifications, that folder is a checkout and no release is shippable.

2. **`requiresFullInstall: false`** in the signed manifest. This is the field that separates a real update from a
   notify-only release the owner has to action by hand.

3. **`depsSha256` matches the installed app's `dependencyHash`.** `package-lock.json` carries its own `version`, which
   npm rewrites on every bump, so a RAW hash comparison reports "dependencies changed" for every patch and forces a
   full install. `dependencyHash()` blanks the lock's own version fields; compare that. A version-only bump must
   produce an **identical** dependency hash.

4. **The panel offers a clickable install after the download.** See the failure below — this one shipped broken.

## The procedure

Full detail with commands: [`docs/SHIPPING.md`](../../docs/SHIPPING.md). The order that matters:

1. **Full suite green in the tree that will become `main`.** Focused suites are not the gate — they say nothing about
   the other 2,400 tests. One gate at a time: `npm test` rewrites `dist/`, so a concurrent build corrupts both results.
2. **Baseline from the same tree before your change**, so "3 failures" means something next to "3 failures before".
3. **Version in three places**: `package.json`, `src/shared/config.ts` (`VERSION`), `package-lock.json`. Confirm the
   lockfile diff is version-only.
4. **Restore tag first**: `git tag pre-merge-<name> && git push cloud pre-merge-<name>`.
5. **Build outside the repo**, native `D:/...` path (an MSYS `/d/...` becomes `D:\d\...` and ENOENTs).
6. **Manifest from `app.zip`**, not the 285 MB installer zip.
7. **Sign with the key outside every work tree.** The vault key sits inside the owner's vault's own repo and the signer
   refuses it. Copy out, sign, delete the copy. Never read a key into a session — pass the path.
8. **`release-preflight.mjs` must end "Pre-flight passed".** Do not publish over a failure.
9. **Merge `--no-ff`.** Read every removed test line: `git diff pre-merge-<name> HEAD -- test/ | grep '^-[^-]'`.
10. **DRAFT the release.** `--draft` first, all assets uploaded, **verify from the live CDN**, then `--draft=false`.

## Failure modes seen here

**The update panel hid its own install button (2026-10-04).** `UpdatePanel.tsx` rendered the install button only while
`!st.staged`, so the moment the download finished the button disappeared. Users could download a release and have no
way to install it except waiting for idle or restarting the app. Nothing was broken — a control was absent — and the
suite was fully green. **Check every state of a flow, not just the first one.** A control that vanishes on state
change is invisible to any test that only exercises the happy path.

**The install folder was a git worktree (2026-10-04).** Auto-update was dead, and every push to `main` landed *inside*
the installed app. The installer accepted it because a worktree's `package.json` is named `legion`. The guard now
refuses any folder containing `.git` — test both shapes, because a clone's `.git` is a directory and a worktree's is a
file.

**A release had to be pulled back (2026-10-04).** Draft-first meant it took under a minute and nothing was ever
offered as `latest`. After a rollback, **verify** — `gh release view`, asset 404, and the `releases/latest/download`
manifest, because that last URL is what every install polls.

**The rescue/compaction class of bug is the same shape.** A control or an invariant that is *absent* rather than wrong.
See [`verifying-changes.md`](verifying-changes.md).

## Verifying an update really works

Local checks prove your folder is right. They do not prove an existing install can receive the release. After the
draft is uploaded:

```
curl -sL https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json
```

Into a **fresh** directory, fetch the manifest, its `.sig`, `app.zip` and `SHA256SUMS.txt`, and run
`release-verify.mjs` **on those fetched bytes**. Confirm `version`, `requiresFullInstall: false`, and that the asset
sha256 matches. Newly uploaded assets 503 for about a minute while the CDN warms — that is not a failure; wait.

Only then `--draft=false`.

## Do not burn version numbers

One patch of real work once consumed three version numbers in a single session: a real `0.2.1`, a `0.2.2-a` that no
existing install could take, and `0.2.2` carrying the same code so it would land. **One number per shipped state,
proven receivable by the pre-flight gate.** A number spent on a release nobody can install is not progress. When an
attempt fails, fix and re-cut under the SAME number if it was never published — a tag only exists once people can
install it.

**A pre-release sorts BELOW its own release**, so `0.2.1-a` is never offered to anyone already on `0.2.1`. Lettered
patches only work on the next *unreleased* number. `semver.ts` implements this and `updater-trust.test.ts` pins both
directions.

**When the version grammar changes, grep `scripts/` too.** `build-package`, `release-package` and `release-manifest`
each once carried their own copy of the version regex and rejected what the app accepted. They now share
`VERSION_RE` / `isReleaseVersion` from `scripts/lib/release-lib.mjs`.

## Consent: clicking Update IS the consent

The updater raises **no approval card**, deliberately. Clicking Update is the consent, and auto-install-when-idle is
already behind a `window.confirm` on the toggle whose label promises "without asking again" — a second card would
contradict the UI. (There was a double-consent bug that stranded the panel pointing at an approvals list not reachable
from the update panel.)

What still stands between a GitHub download and running code: the release **signature**, verified before staging;
`requiresFullInstall`; and `consent` gating the commit so a staged update waits for the owner **and** for idle.

For installs predating a fix, the release notes tell people to enable auto-install once, update, then disable it. You
cannot patch someone's installed client remotely.

## Release notes follow `docs/RELEASE-NOTES.md`

Effect, not cause. No jargon, no internals. Under ~600 characters for a patch. Every manual step as its own
plainly-worded line. The manifest carries the notes, so the pre-flight gate covers them.

## Product copy claims

Never say "safe", "secure", "verified" or "cannot be bypassed". Scope them: "Legion's own code …". And **"not verified
in the real app" stays in the copy until the real-PC run is done.**
