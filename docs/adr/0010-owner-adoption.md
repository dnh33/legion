# ADR 0010 — Adoption: the owner's own files as rules

**Status:** accepted · **Date:** 2026-10-04 · **Amends:** ADR 0009 (the house context layer)

## Context

ADR 0009 made the layer fail closed: a file is trusted only while its bytes still match what Legion shipped,
anything else is served wrapped as material rather than as the owner's instructions. That is the right default
and it is not up for debate — the hole it closes is an agent writing `AGENTS.md` and getting its own text back
as the owner's rules.

But failing closed took something away too, and nothing recorded it: **the owner could never make their own
file a rule.** The only trusted text in the entire layer was text Legion shipped. A user who writes
`my-rules.md` into `~/.legion/context/` gets it wrapped as untrusted, forever, with no action available to
change that. The layer is read-only in practice, and read-only to the person who owns the machine.

Measured on the released `v0.2.3-a` package while fixing the packaging bug, the layer also held no files at
all for any user, which hid how little the trust model was being used. Four defects shipped together; this ADR
is about the one that was a missing decision rather than a coding mistake.

## Decision

Three trust states, decided by **who**, not by **what a file is called**:

| State | Who granted it | Stored as | Agent can self-grant? |
|---|---|---|---|
| `shipped` | Legion, by shipping the bytes | sha256 in `.shipped.json` | no |
| `adopted` | the owner, by approving the bytes | sha256 in `.adopted.json` | no |
| `untrusted` | — (the default) | — | — |

Adoption is **content-addressed**: approving a file records the sha256 of the bytes at that moment. So:

- owner writes a file, approves it → `adopted`
- anyone edits it → hash differs → `untrusted` again, automatically, with nothing to re-approve
- an agent restores previously-approved bytes → `adopted`, and *correctly* so, because that is literally the
  text the owner blessed

### Why an agent cannot promote itself

An agent runs as the same OS user and can write any file on this computer, including both manifests.
`tainted-paths.ts` states this outright rather than pretending otherwise. So a marker file cannot be the
boundary, and no design that treats "the file says it is approved" as sufficient is safe.

What an agent cannot do is **produce bytes the owner never approved**. The approval names a specific hash, so
writing a matching entry for content the owner has not seen is the one thing this cannot be talked into. That
is the whole security argument, and it is why adoption adds nothing that an agent can reach:

- **one door only** — an owner action in the app, over an admin-gated route
- **no MCP tool adopts.** If a run could call it, "the owner approved this" would mean nothing. The house
  tools are deliberately read-only.

### The manifest merge

The shipped manifest is now **carried forward** rather than rebuilt from each sync's results. An existing entry
survives only while the file's current bytes still hash to it.

This fixes a one-way ratchet: rebuilding the manifest dropped the entry for any edited file on the next start,
and because a missing entry reads as untrusted, **reverting an edit by hand could never restore trust** — the
opposite of the rule ADR 0009 states. It is still fail-closed, because keeping an entry is conditional on the
bytes matching it. An agent's edit changes the hash, the entry stops matching, and the file reads untrusted.

## Consequences

- A user's own rules can be rules, which is what makes the layer worth having for anyone but the Legion author.
- Editing your own approved file costs one re-approval. Deliberate: a standing grant by path is exactly the
  hole this design refuses to open.
- `trustKind` is the single answer for "how is this file served", so the read tool, the recall tool and the
  owner's UI cannot disagree about it.
- The two manifests are separate files on purpose: what the app shipped and what the owner approved are
  different decisions, and a future sync must not be able to rewrite an approval.
- **Not shipped:** `claude/skills`. Those are one person's workflow skills, already excluded wholesale from the
  public repo by `export-public.mjs`. Shippable skills need a public path of their own.

## What this does not do

- It does not widen an agent's approvals. The layer is context, not permission; that is structural (ADR 0009).
- It does not make an agent's *past* edits safe. Approval is forward-looking only.
- It is not a claim that an agent cannot write these files. It cannot. The design assumes that and does not
  depend on it holding.