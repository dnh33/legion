# SESSION-LOG.md — how we got here, including the mistakes

The decisions are in `docs/adr/`. This is the narrative: what happened, in what order, and what it cost.
The mistakes are the point. A log that only records wins teaches nothing.

---

## 0.1.0 — first public release (2026-09-30)

Local-first multi-agent desktop app. Core on `127.0.0.1`, Electron shell, Claude-native agents through
the Agent SDK, inline approval cards, boat.dev VMs, the hand-painted mascot.

## 0.2.0 — public, and the year of hardening (2026-10-03)

Repository made public (`dnh33/legion`), licence moved MIT → Apache-2.0, branch protection on, and the
integrated branch retired so `main` is the only one. An export scrubber decides what may ship, because
the operational files contain real paths and process detail.

## 0.2.1 — the knowledge graph went stale (2026-10-03)

Turning BSV mode on or off changed which graph nodes were **visible**, but emitted only `agent.updated`.
The graph view refreshes on `kg.updated` and nothing else, so its cached node list went stale: nodes
missing after enabling, lingering after disabling.

Fixed by emitting `kg.updated` with an empty `changed` list — the signal for "visibility flipped, re-read
everything" — and teaching the graph store that an empty list means a full reload rather than an
incremental patch.

## 0.2.2 — the updater, and three bugs that should never have shipped

This release exists to prove the in-app signed updater works. Getting there took four attempts and
exposed a pattern worth keeping.

**1. The updater asked twice.** Clicking Update raised an approval card pointing at a list that was not
reachable from the update panel, so the update looked stuck. The click *is* the consent. A card is for an
update Legion starts by itself.

**2. Self-update could never work.** `depsSha256` hashed the raw `package-lock.json`. npm rewrites the
lock's own `version` field on every bump, so the hash changed on every release and every patch looked
like a dependency change — forcing a full reinstall, always. See `docs/adr/0004-dependency-hash.md`.
Found because the owner asked one question: *"is this a dependency change though?"*

**3. Every prebuilt package was uninstallable.** `listTree` walks the tree with `lstatSync`. Under plain
node an Electron `.asar` is a file. Under **Electron** — and the installer runs on `electron.exe` — the
runtime patches `fs`, so the same path reports `isDirectory() === true` and its contents appear as
children. The walk descended into the archive, found a file the manifest never named, and refused the
package. Node-only tests could never have caught it.

Then the follow-on: even with that fixed, Defender quarantined the same file. It is Electron's
*fallback* app, never loaded because `package.json` points at our own entry — dead weight that happens
to be exactly what heuristic scanners flag. Shipping it meant any user's antivirus could kill their
install. Excluding it fixed that for everyone; an antivirus exclusion would only ever have fixed one
machine.

### The pattern

All three passed the full suite — 2396 tests, 0 failures. None was a logic error. Each was a fact about
the *world* the code runs in, not the code:

- a file format that npm rewrites,
- a runtime that patches the filesystem,
- an antivirus heuristic.

The response was a gate that asks the question a test suite structurally cannot: **can an install that
exists today actually receive this release?** `scripts/release-preflight.mjs`. It has caught real
failures since.

### A fourth lesson: the version number is not a preference

`0.2.2-a` was published and was uninstallable by every existing user. A lettered patch is a semver
pre-release, and a pre-release sorts **below** its own release — so everyone already on `0.2.1` was
told it was a downgrade. The old binary decides that, so no server-side change could fix it. Only a plain
`0.2.2` could land, and it had to ship the lettered-patch support itself. See `docs/VERSIONING.md`.

## Still open

- "Full access" still prompts on the owner's machine. `needsApproval('full', …)` is correct; the suspect
  is `approvalCeiling` capping a `full` agent down to `ask`. Not confirmed.
- Skills: parked pending research. The SDK has native per-session `skills` selection, so the Claude path
  is close to free; provider-model agents have no file tools, so it is a different problem entirely.
- The house context layer (ADR 0009) is what makes Legion-on-Legion possible: the repo's knowledge
  reaches the agents instead of the repo reaching their working directories.

## How to read this file

If you are an agent and something here contradicts the code, **the code is right and this file is
stale**. Say so rather than working around it — that is the whole reason this file exists.