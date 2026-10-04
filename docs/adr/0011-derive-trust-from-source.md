# 0011 — Derive trust from the source, and keep adoption out of the layer

> Status: accepted
> Date: 2026-10-04

## Context

The house layer is served to agents as **trusted** text — it does not get the untrusted wrapper that room history and
graph notes get. That claim is only true while the bytes are the ones the app shipped, so `syncContext` records a
hash of what it shipped and a read compares (ADR 0009).

The Zealot acceptance test found the record itself was forgeable.

`syncContext` built the shipped manifest by hashing **the copy in the data directory**, and carried entries forward
for files it did not re-copy. An edited file is `keptNewer`, so it was in neither `written` nor `unchanged`, so any
entry it carried was one something else had written. Measured, against the code as it stood:

1. an agent edits `AGENTS.md` → `untrusted` ✓
2. the agent writes `sha256(its own bytes)` into `.shipped.json` → **`shipped`** — trusted, served unwrapped
3. the next app start carried the forged entry forward → still `shipped`

So an agent could promote its own edit to the owner's rules. That is the exact inversion ADR 0009 exists to prevent,
reached through the manifest rather than through the bytes.

A second, narrower hole sat beside it: `adopt()` wrote `.adopted.json` **into the layer**, so the owner's approval and
an agent's forgery were the same file, distinguished only by who wrote last.

## Decision

**1. The shipped manifest is derived from the source, never from the copy.** `syncContext` hashes
`LayerSource.file(rel)` — what the app ships — for every path it considered, including `keptNewer`.

- an agent edits a file → `keptNewer` → the entry is the source hash → the bytes differ → `untrusted`
- an agent forges an entry → the next sync overwrites it from the source → `untrusted`
- the edit is reverted by hand → the bytes match the source hash again → `trusted`, with nothing to re-click

The third property is what ADR 0009 requires, and it survives precisely because the entry never depended on the edited
bytes. Entries are still carried forward, and still dropped for files that are gone.

**2. The adoption manifest moves to the data directory**, one level above the layer (`adoptedPath` in `trust.ts`).
Call sites are unchanged: `root` is the layer throughout, so the parent is the data directory.

## The limit, stated plainly

This is defence in depth, not a cryptographic boundary, and it would be dishonest to call it one.

An agent runs as the same OS user and can write any file under `~/.legion` — `tainted-paths.ts` says so in its own
module docstring. Moving adoption out of the layer means the ordinary house file tools cannot reach it; it does not
mean an agent that knows the app's internal layout cannot forge it. Adoption is a UI affordance that keeps the common
path honest, and the test says so in those words rather than implying a wall.

Closing that properly needs a store the agent cannot write — an OS-protected location, or a signature over the manifest
with a key the app holds and the agent does not. That is a larger change and is not taken here.

## Consequences

- `test/house-zealot.test.ts` 2.4 asserts the refusal, and asserts the owner's door still works.
- Verified red-green: reverting the sync change turns 2.4 red on exactly the security claim.
- Gate: 2,644 tests across 218 files, 1 failure — the `kg` F1 already proven failing at `deb5a69`. 0 type errors.
