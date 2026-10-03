# Release notes convention

Owner directive (2026-10-04): "write or find a proper convention for release notes, /kodawari always."

Release notes are read by **someone deciding whether to install, mid-task, on their own machine.**
They are not a changelog, not a technical summary, and not marketing. Write for that person.

## The one test

> Could someone who has never seen this project decide, in ten seconds, whether to press Update?

If the answer needs a second read, it is wrong. Cut it.

## Hard rules

1. **Lead with the effect on the user, not the cause.** "Update button no longer asks twice", not
   "the installer no longer raises an approval card for a user-initiated action". The cause belongs in
   `CHANGELOG.md` and the tracker; the notes are for the person about to click.
2. **No jargon.** Not `depsSha256`, not `canSee`, not "notify-only", not "scope visibility". If a
   word only means something inside this repo, it does not go in the notes.
3. **No version internals.** No commit hashes, no file names, no branch names, no test counts.
4. **Short.** Cap 2000 characters (the manifest enforces it). Realistically: **under 600** for a patch.
   Long notes are not read, so they are not written.
5. **Every line earns its place or is cut.** If a fix does not change what the user sees or does,
   it does not get a line in the notes. It still goes in `CHANGELOG.md` — that file is the record,
   the notes are the pitch.
6. **Any manual step the user must take gets its own line, at the end, in plain words.** This is the
   rule that earned its place: a stuck-update escape hatch was shipped as release notes, and if it
   is wrong the release fails silently. One-time instructions say so: "only needed this once".
7. **Never say "safe", "secure", "verified", "cannot be bypassed".** Say what was done and what it
   changes. Scope claims to Legion's own code.
8. **No emoji, no exclamation marks, no "Exciting news".** Plain sentences. The product does not
   need a persona to tell you a button now works.
9. **Write it before you cut the release, not after.** Notes written at cut time are checked by
   `scripts/release-preflight.mjs`, which fails the release when they are missing or over the cap.

## Shape

```
<what changed for the user, one line per change>

<if a manual step is needed: a short line, plainly worded, marked as one-time if it is>
```

Two shapes only. A one-line release gets one line. If there is nothing a user would notice, say
that in one line — "Internal fixes, nothing changes for you" — rather than padding.

## Worked examples

Good:
```
Fixes the update button asking twice, which made an update look stuck.

- Update button: installs straight away now.
- Stuck update? Turn on "Install updates automatically when idle", let it update, then turn it off again. Only needed for this one update.
```

Rejected — right information, unusable delivery:
```
Fixed: install() no longer raises an approval card for user-initiated updates, resolving the double-consent defect in the consent model. The manifest depsSha256 now hashes dependency content rather than the raw lockfile.
```

## Relationship to CHANGELOG.md

- **Release notes** (`--notes` for `release-manifest.mjs`) → shown in the update panel and the GitHub
  release. For the person deciding. Above.
- **`CHANGELOG.md`** → the record. Technical, complete, includes causes and internal changes. Never
  trimmed to match the notes.
- **The tracker** (`claude/legion-release-tracker.md`) → why the work happened, with findings.

Three audiences, three documents. Copying one into another is a mistake, not consistency.