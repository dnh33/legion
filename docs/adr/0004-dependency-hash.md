# ADR 0004 — `depsSha256` hashes dependency content, not the raw lockfile

**Status:** accepted · **Date:** 2026-10-04

## Context

Every release carries a `depsSha256` in its signed manifest: the SHA-256 of `package-lock.json`.
The updater compares it against the hash of the **installed** lockfile. If they differ, the release
is marked `requiresFullInstall` and the updater refuses to stage it, telling the owner to download
the source and run `setup.cmd` instead.

That check exists for a good reason: if dependencies changed, the new code may expect packages the
installed tree does not have, so swapping code in place would produce a broken install.

## The problem

`package-lock.json` contains a `version` field describing **itself**. `npm install --package-lock-only`
rewrites it on every version bump, for every dependency change and for nothing else. So the raw file
hash changes on **every single release**, whether or not a single dependency moved.

The consequence: every patch release looked like a dependency change, so every patch was forced into
a full reinstall. Self-update could not work — not for one release, not for any release, ever.

This was found on 2026-10-04 when the owner asked one question: *"is this a dependency change though?"*
The full suite was green. The bug had been present since the updater was written and had never been
exercised against a real install, because the packaging path had never been run end to end.

## Decision

Hash the lockfile's **dependency content**: parse it as JSON, remove the version fields that describe
the lock itself (the top-level `version` and `packages[""].version`), and hash the result.

A dependency's own `version` stays in the hash. Adding, removing or bumping a dependency still changes
it, and still requires a full install.

**Fail closed:** if the installed lockfile cannot be read, its dependency hash is unknown, and unknown
is treated as *changed*. An unreadable install is notify-only, never silently overwritten.

## Consequences

- A version-only bump produces an identical dependency hash and self-applies.
- A real dependency change is still detected, and still requires the owner to run setup.
- The invariant is pinned by tests in `test/updater-package.test.ts` (`C10b`), including the case that
  exposed it.
- Anyone adding a field to the lock that is not a dependency must decide whether it belongs in the
  hash. That is the cost, and it is the right place to pay attention.

## Related

- `scripts/release-preflight.mjs` re-checks this before every release, because a test suite cannot
  answer "can an install that exists today receive this release?".
- `docs/VERSIONING.md` records the other invariant that bit the same day: a pre-release sorts below its
  own release, so a lettered patch must sit on a number that has not shipped yet.