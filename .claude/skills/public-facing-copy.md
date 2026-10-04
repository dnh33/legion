---
name: public-facing-copy
description: Use when writing or editing anything a reader outside the project sees — CHANGELOG.md, docs/RELEASE-NOTES.md, release notes, UI copy, README. These files are scrubbed into the public snapshot, so write for that reader.
---

# Public-facing copy

## The rule that governs every other rule here

**`CHANGELOG.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md` and `CODE_OF_CONDUCT.md` are scrubbed into the
public snapshot.** `ROOT_DOCS` in `scripts/export-public.mjs` proves it. So does `docs/**` and `claude/**` via
`PROSE_DIRS`.

A reader of the changelog is **a contributor or a curious passer-by, not the owner and not a colleague.** Write for
them. Everything below follows from that.

## Ask the reader question first

Before writing a line: **does this change anything for the person reading it?**

If a reader who installed Legion gains nothing from an entry, it does not belong in the changelog. It belongs in
`claude/legion-release-tracker.md`, which is excluded from the export and exists precisely to hold maintainer
history.

Concretely, these do **not** belong, and have been written and then removed:

- Release tooling changes (`--pkg`, pre-flight behaviour, gate internals). Nobody who installs the app sees these.
  Publishing them only advertises the project's own tooling gaps to the world.
- Internal data-structure corrections ("the trust manifest is no longer counted as layer content"). True, fixed,
  and of no interest to any reader outside the project.

Dropping them from the changelog loses nothing. The tracker still records them.

## Describe the outcome, not the mechanism

State what the reader now gets, then why it mattered.

| instead of | write |
|---|---|
| "built into the bundle instead of copied at runtime" | "was not reaching installed copies at all" |
| "came back marked trusted" | "an agent's own edit was already trusted" |
| "`modeOf()` is now the single decider" | "one rule decides, and it re-reads your setting on each call" |

The first column is how you would brief a colleague. The second is what a reader needs. Both may be true; only one
belongs here.

## Keep the cause, drop the diagnosis

A changelog entry answers **why it was broken**, because that is what someone grepping for a bug six months from now
needs. Name the symptom and the fix in user terms. Skip the function names, file paths and internal identifiers —
they age badly and tell a reader nothing.

## Leak check before committing

The changelog is public, so run every entry against this list. Any hit is a rewrite, not a redaction:

- the owner's vault name or any local path
- the reference implementation's name, or "the reference implementation is not named in this repository" — that
  sentence is meaningless to a reader and points at something we deliberately do not publish
- internal identifiers (`modeOf`, `depsSha256`, `SHIPPED_FILES`)
- development-state hedging: "not yet tested", "tested against a fake", "has not been tried with a real X"

That last one is the exact failure mode this rule exists to prevent. If a behaviour is covered by tests, say what it
does. If it genuinely is unverified, it does not belong in a changelog yet — it belongs in the tracker.

## Changelog vs release notes

They are different documents for different readers.

- **`CHANGELOG.md`** — public, permanent, cause and fix. Cap-free.
- **`docs/RELEASE-NOTES.md`** — what shows on the Update button, mid-task, deciding whether to press it. Lead with
  the outcome in one sentence, cap 2000 characters and realistically stay under 600.

Rule of thumb: **cause goes in the changelog, outcome goes in the notes.**

## Before you commit

- [ ] Every entry passes the reader question
- [ ] No tooling or internal-structure entries
- [ ] Outcomes, not mechanisms
- [ ] Leak check passed
- [ ] Maintainer detail preserved in the tracker, so nothing is actually lost
