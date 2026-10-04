# START HERE — Legion repository map

**Read this before any other file in `claude/`. Several of them are historical.**

## Branches

| | |
|---|---|
| **`main`** | **The only development branch.** Canonical, protected (PR + 1 approving review, no force-push, no deletion). Remote name is `cloud`, not `origin`. |
| `integration/v1` | **DELETED 2026-10-03.** Merged into `main`, then retired. Anything still naming it is history, not instruction. |
| `providers-2`, `providers`, `blender-chip` | Preserved unmerged work, tagged `v0.2.0-*-unmerged`. Not branches to build on. |

If a document tells you to work on, merge into, or cut a release from `integration/v1`, it is
out of date. That is not a judgement call — the branch does not exist.

## Clones on this PC — only the first is real

| Path | State |
| --- | --- |
| `D:\bots\legion` | **Canonical.** v0.2.2, Apache-2.0, public, in sync with `cloud`. Renamed from `legion-review` on 2026-10-04; the old name appears in nothing. |
| `D:\bots\legion-ctx` | Second clone, same remote. Branch `claude/context-layer` (house context layer, commit `40842df`). |
| `D:\bots\_stale-legion-v0.1.0-20261004` | **STALE — v0.1.0, MIT, `private: true`, 87 uncommitted files.** Kept, not deleted, so nothing is lost. Its `src/core/bsv/` and `src/core/comms/` copies ARE recoverable from `main` history. Delete it once you are satisfied. |

Do not use any other folder here as a source of truth. `legion-gate`, `legion-cap-wt`, `legion-wt-win`,
`legion-wt-winfix` and `legion-dev` are linked WORKTREES of `D:\bots\legion` (detached or on old branches) — they are
gate/checkout scratch, not clones. `legion-site` is the separate website repo.

## Current state

- **Released:** 0.2.0, 0.2.1, 0.2.2. Latest release and updater manifest: `v0.2.2`.
- **Open work:** `claude/legion-release-tracker.md`, section `POST-0.2.2 — OWNER DIRECTIVES 2026-10-04` (D1–D7).
- **House context layer:** built, committed on `claude/context-layer` (`40842df`), **not yet reviewed or merged**.
- **Skills:** parked pending research. See the tracker, not this file.

## Before you cut a release

`docs/VERSIONING.md` is the authority and it is not optional reading. In short: the orchestrator
picks the version number, the owner never does; and `node scripts/release-preflight.mjs` is
mandatory before publishing. Three releases passed the whole test suite and were uninstallable
by real users. That gate exists because of it.

## Rules that are not negotiable

- One gate at a time. Two concurrent builds writing the same `dist/` produce meaningless results.
- Never pipe a backgrounded node/npm build (`| tail` makes stdout a non-tty and npm dies).
- Verify packaging changes **under Electron** — Electron patches `fs`, so `.asar` archives report
  `isDirectory() === true` and node-only tests pass while the real installer fails.
- After every release: save point (tracker + Aetherkeep + memory) and update the skill for what
  the session taught.

Full hard rules: `CLAUDE.md`. The cut procedure and its traps: the `legion-orchestrator` skill.