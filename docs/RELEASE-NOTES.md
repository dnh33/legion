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
6. **Any manual step the user must take gets its own line, at the top under the restart line, in plain words.** This is the
   rule that earned its place: a stuck-update escape hatch was shipped as release notes, and if it
   is wrong the release fails silently. One-time instructions say so: "only needed this once".
7. **Never say "safe", "secure", "verified", "cannot be bypassed".** Say what was done and what it
   changes. Scope claims to Legion's own code.
8. **No emoji, no exclamation marks, no "Exciting news".** Plain sentences. The product does not
   need a persona to tell you a button now works.
9. **Write it before you cut the release, not after.** Notes written at cut time are checked by
   `scripts/release-preflight.mjs`, which fails the release when they are missing or over the cap.

## Shape

Owner decision (2026-10-13): **one story, with the restart line on top.** The reader is at the restart prompt
and asks, in this order: what does restarting do to my work, do I have to do anything, what changed for me.
People remember one thing, so the notes spend their space on the change that matters most.

The update panel (the `--notes` text, plain text):

```
<Restart line: what restarting does to running work, and "You need to do nothing." or the one step.>

<Plain title of the one change that matters most>
<The problem, in one sentence, as the user met it.>
<What Legion does now, one or two sentences.>
Try it: <where to see it, one sentence>        (leave out for a fix with nothing to try)

Also new:                                       (leave out when empty; one line each, at most 3)
- <change>
Fixed:                                          (leave out when empty; only fixes a user would notice)
- <fix>
```

- **The restart line is always first and always true.** Today it reads "Restarting stops running agents. Each
  stopped run offers Continue afterwards." Check it against the updater before each release; never write that
  a restart is safe (rule 7).
- **Pick the headline by what a user would miss most,** not by the size of the work. A safety fix beats a
  feature. If two changes are truly equal, the one the user meets first wins; the other goes under "Also new".
- **A release with one change is just the restart line and the story.** If there is nothing a user would
  notice, say so in one line, "Internal fixes, nothing changes for you", rather than padding.

The GitHub release page (markdown) tells the same story as **before and now** pairs, one per change, each with
a fresh screenshot of the real app when the change is visible. The pair must make sense without the picture.
`CHANGELOG.md` stays the full list.

## Worked examples

Good:
```
Restarting stops running agents. Each stopped run offers Continue afterwards. You need to do nothing.

Stray typing no longer answers an approval
Pressing A with nothing selected could allow an approval card you could not see.
Now A allows a card only when all of it is on screen, as one deliberate press. On a card off screen, A scrolls to it first.
```

Good, with a manual step:
```
Restarting stops running agents. Each stopped run offers Continue afterwards.
Stuck update? Turn on "Install updates automatically when idle", let it update, then turn it off again. Only needed for this one update.

The update button installs straight away
It asked twice, which made an update look stuck. Now one press installs.
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