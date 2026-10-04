# AGENTS.md — working on Legion

**Read this first.** It is the entry point for *any* coding agent, whatever tool you are. `CLAUDE.md` holds the same
rules in Claude's own format; where the two disagree, this file is the one that was updated, and that is the bug.

Legion is a local, Claude-native multi-agent desktop app: an Electron shell around a Node/TypeScript core bound to
`127.0.0.1:4747`, and a React UI. It runs on the owner's own Windows machine, with the owner's Claude Code sign-in.

## Read order

1. This file — the map and the rules.
2. `docs/ARCHITECTURE.md` — the processes and the contracts between them.
3. The doc for the area you touch (table below).
4. `docs/adr/` — the decisions that are hard to reverse, and **why**. Read the relevant one before changing its area.
5. `docs/TESTING.md` — before running anything. A fake-backed harness tests Legion end to end with no real Claude,
   no boat.dev, no wallet and no Blender.

`CONTEXT.md` is the glossary only. `docs/SESSION-LOG.md` is how we got here, including the mistakes.

## The area map

| Area | Read |
|---|---|
| Knowledge graph (the Lattice) | `docs/KNOWLEDGE-GRAPH.md`, `docs/KG-NOTES.md` |
| Bot-to-bot comms, rooms | `docs/COMMS-BRIDGE.md`, `docs/COMMS-NOTES.md` |
| BSV mode and wallets | `docs/BSV-MODE.md`, `docs/BSV-WALLET-DESIGN.md` |
| Blender bridge | `docs/BLENDER.md`, `docs/TESTING-BLENDER.md` |
| In-app updates | `docs/UPDATES.md`, `docs/VERSIONING.md` |
| Release notes voice | `docs/RELEASE-NOTES.md` |
| Library | `docs/LIBRARY.md` |
| Chat and history | `docs/CHAT.md` |
| boat.dev VMs | `docs/VM-NOTES.md` |
| Project board | `docs/PROJECT-BOARD.md` |
| House context layer (new) | `docs/adr/0009-house-context-module.md` |
| Security posture | `SECURITY.md` |

## Current state

Version **0.2.2** (`package.json`, `src/shared/config.ts` → `VERSION`, and `package-lock.json` move together).
Three runtime dependencies: `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `zod`. Think twice before
adding a fourth.

Work in flight: `claude/legion-release-tracker.md` is the living tracker. Plans are `claude/plan-*.md`. Checks that
need the owner's PC are `claude/tracker-pc-checks.md`.

## Rules

### 1. Research first, ask the owner last

Before writing an assumption about anything outside this repo — a wallet, Blender and its MCP add-ons, Lightpanda,
GitHub or Node release formats, the Claude Agent SDK, a standard such as BRC-100 — **look it up** in the official
documentation and source, and quote the exact source and field names. Keep a table: documented fact (with link) /
assumption (with the check that would prove it) / unknown (with the owner-only check).

Do not ask the owner for a fact you can look up. Do not gate *building* on an owner-only step when a fake can carry the
build; gate the **ship**, not the build. Never present an old note or a handoff line as "a rule from the owner" unless
the owner said it: attribute rules honestly and flag any you could not trace.

### 2. Look at it yourself before you call it done

Kodawari. A builder's own report is never the proof.

- Evidence over assertion: run it, render it, count it. Never quote a number you did not compute.
- Real conditions: the smallest size it ships at, dark and light, extreme data, the real build, not only the dev server.
- A second eye that tries to refute, defaulting to "not fixed".
- Name what is still imperfect instead of hiding it.

### 3. Every new test needs a negative

Show, by a temporary scratch mutation of the source that you then revert, that the test actually fails. A test that has
never been seen red is not evidence.

### 4. Gates

```
npm ci && npm run build:ts && npm test && npm run typecheck && npm run build:ui
```

Report **exact counts**. One gate at a time: `npm test` clobbers `dist/`, so never run `tsc` or `build:ui` while a
suite is in flight. Never pipe a backgrounded npm build (`| tail -N` makes the child's stdin a non-tty and its child
scripts die).

### 5. Hard rules — do not weaken these to make something pass

- The **admin gate** (default-deny HTTP; the MCP bearer token reaches only the short client list), the per-launch
  **native secret** for BSV policy changes, **taint wrapping** of external content, and the tripwire and hedge tests
  (`test/bsv-scan.ts`, `test/bsv-tripwire*.test.ts`, `test/bsv-hedge.test.ts`) stay as they are. Child processes may
  be spawned only in files the tripwire lists.
- The owner's funded BSV wallet is never contacted by repo code, tests, scripts, the harness or a cloud agent. Keys
  never live in Legion. Every spend is a manual, native confirmation. Signing, spending or broadcasting needs the
  owner's explicit go-ahead for that action, with the amount and the address, tiny amounts first.
- No keys, tokens or `.legion` data in the repo, logs or reports. Redact any secret-shaped value to a short prefix.
- The mascot art is untouchable: effects and logic only, never repaint.
- No accounts, no passwords, no CAPTCHAs. Downloads and anything that spends money need the owner's go-ahead.
- Wording: claims are scoped ("Legion's own code ...") and never absolute ("cannot be bypassed", "fully safe").

### 6. Git

`main` only, and only through a pull request with one approving review. No force-push, no rewriting history, no
squash. Merge with `--no-ff`. After every merge, review every removed test line:

```
git diff pre-merge-<name> HEAD -- test/ | grep '^-[^-]'
```

Each `-` line must be empty or explained out loud.

### 7. Two files that must stay identical

The module list in `src/bin/legion-core.ts` and the one in `scripts/harness/core-entry.mjs`. They are the product and
its test harness; a module present in one and not the other means the harness is testing something else.

### 8. Invariants that break silently

These fail quietly, which is worse than failing loudly:

- **Version in three places.** A release missing one of them is not a release.
- **`depsSha256` hashes dependency content, not the raw lockfile.** npm rewrites the lock's own `version` on every
  bump, so a raw comparison reports "dependencies changed" for every patch and forces a full install — self-update
  could never work. See `docs/adr/0004-dependency-hash.md`.
- **A pre-release sorts below its own release.** `0.2.1-a` can never work. See `docs/VERSIONING.md`.
- **ESM caches modules**: a running server keeps stale code until restarted.
- **Config and state migrations** must be versioned, run once, and never override a later manual choice.

## Lessons from earlier work on this codebase

- **Windows is where tests break.** Use `fileURLToPath`, never `new URL(...).pathname` (on Windows that yields
  `/D:/...`, the wrong drive). PowerShell 5.1 does not unroll a JSON array from `ConvertFrom-Json` (pipe through
  `ForEach-Object { $_ }`). File symlinks need privilege: use junctions or hard links in tests. `Path` vs `PATH` env
  case. Never kill processes by name pattern on the owner's PC — kill by PID.
- **Verify the latest tree before building on it.** Stale folders have caused rework.
- **Deduplication findings are not safe to apply blind.** Two "obviously identical" extractions broke the suite while
  typecheck passed: `claudeAvailable?.()` (load-bearing for partial test mocks) and an inline `isVisible` whose
  truthiness was not the shared helper's strict `=== true`. Diff the exact semantics; run the affected files in
  isolation.
- **Batches lie.** A broken npm test read as "npm rejects lettered versions" and nearly killed the right version
  number. Re-test before calling something a blocker.

## If you are in a cloud session

- Aetherkeep, the owner's private vault, is **not** available. This file, `docs/`, and `claude/` are your context. Do
  not stop or complain about it.
- Your working copy disappears when the session ends. **Push your branch before you finish** (`claude/...`).
- You cannot run Windows, a real Blender, a real wallet, Electron's native dialogs or the owner's accounts. Anything
  you could not verify for that reason is **not done**: add it to `claude/tracker-pc-checks.md` and list it under
  "Needs a real PC". Never mark such a feature verified in the docs or the changelog until its check is recorded as
  passed.
- No long `sleep` chains: wait on a condition.

## Reporting

Answer first, then the detail, short and plain. Separate bugs from polish. Say what you could not check. A report
that overstates what was verified is the one failure this repo cannot recover from.