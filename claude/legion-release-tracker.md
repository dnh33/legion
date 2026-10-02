# Legion release tracker

Living tracker for the v1 release. Updated 2026-10-02 by Claude Code on the PC. Big topics get their own `tracker-<topic>.md` in this folder.

## Owner decisions (2026-10-02)

| # | Topic | Decision | Status |
|---|---|---|---|
| 1 | BSV wallet design (`docs/BSV-WALLET-DESIGN.md` §12) | All draft defaults approved; rung 3 testnet only | confirmed |
| 2 | Builder VM size on upgrade | Reset to `default` | confirmed |
| 3 | Key probe | Lazy: first VM use or Settings → boat.dev open; none at core start | confirmed |
| 4 | Bot-created room limits | Member cap stays 6. **No spend limit by default** (no default budget); users can add a budget per room | confirmed (replaces the $1 default / $5 max; see work item R1) |
| 5 | MCP inheritance | `claude.inheritMcp` default **off**, strict MCP config, connectors off; opt in per server | confirmed |
| 6 | Busy ring on rail avatars | Keep; re-measure perf in the sweep | confirmed |
| 7 | Queue busy rule | Current behaviour (`docs/CHAT.md`) is right | confirmed |
| 8 | Claude only in v1 | Codex/ChatGPT listed under "Later" | confirmed |
| 9 | Release | Public repo; version 0.2.0 (confirmed 2026-10-02); robocopy installer fixed to be non-blocking, unsigned | public repo + version confirmed; installer type/signing **assumed, not confirmed** |

## Work items (updated 2026-10-02 09:17)

Cloud work runs on the claude.ai/code web surface (credits). Branches live in private repo dnh33/legion. Reviews are on `claude/review-*` branches (`review/*.md`).

| ID | Item | State |
|---|---|---|
| W0 | Windows baseline: 1300 pass / 27 fail / 41 skip of 1368 | DONE: 27 test-side fixes, 1368 tests / 1327 pass / 0 fail / 41 skip on Windows, no product bug; independent review running (branch `fix/windows-baseline`) |
| A | MCP isolation (`claude/mcp-isolation`) | reviewed (SHIP AFTER FIXES), all 4 fix commits landed, 1387/1387; merged into integration/v1; real-PC check M1/M2 open |
| R1 K1 U1 | Rooms no default spend limit, lazy key probe, Builder reset (`claude/rooms-probe-upgrade`) | built; review = SHIP AFTER FIXES (B1 budget >10000, B2 operator ceiling bypass, K1-F1 doc wording); fix session running (claude web) |
| B | Packaging + public audit (`claude/release-packaging`) | reviewed (SHIP AFTER FIXES), all 8 fixes landed, 1392/1392 with PowerShell; merged into integration/v1; NOT run on Windows yet: see tracker-pc-checks.md P1-P10; version bump + CHANGELOG finalise still open |
| C | boat.dev + Blender real-system verification (owner present) | todo |
| D | Blender: **local-first** (owner direction 2026-10-02): add a local headless mode (`blender -b` on this PC, per-task scene, approval card with full script, backup, audit, exports quarantined) as the default when Blender is found; boat.dev VM stays as the opt-in isolated mode. Today default is VM-first and local = live add-on socket only. Plus pin community add-on, extension install path, busy-while-running, line counts. Plan for owner approval before build (trade-off: a local script has the user's full rights; the static check is a filter, not a sandbox) | todo, after v0.2.0 delivery |
| E | Real-PC sweep (section 6.2) | todo |
| F | BSV rung 3 testnet tool (section 6.6) | todo, after plan |

## Open owner decisions

- DECIDED 2026-10-02: BSV knowledge pack: soften NOTICE to "written in our own words from public documentation; licence status of some sources not established", ship pack unchanged (91 of 157 nodes only unverified/no-licence sources; 24 cite private `legion-specs` docs). To apply after the packaging fix session lands.
- Installer type: robocopy installer, unsigned (assumed, not confirmed). Version 0.2.0 confirmed.
- Weekly Claude usage at ~98% (resets Mon Oct 5 01:00): cloud sessions may stall.

## Follow-ups found during this release (not yet done)

- `scrubSecrets` (src/core) is already quadratic for the `token`, `secret_eq` and `http` shapes: about 0.1 s at 20k chars, 1.7 s at 80k. Found by the Windows R3.4 scaling test; tests hold those shapes to "no worse than now". Candidate fix: linear scan.
- Real-PC checks: see `tracker-pc-checks.md`.
- Cloud sessions run on the claude.ai web surface (credits); API routine route is not to be used (see memory).

## Open item: R6.1 replay-fidelity test flakes on Windows (2026-10-02)

`test/library-review-integrity.test.ts` "R6.1 replay fidelity" failed intermittently on Windows (1 of the original baseline, 1 of 3 gate runs): "seed 3 step 299: reloaded graph differs from live", nodes and edges equal, diff list empty. Never failed on Linux.
- A local agent hunted it for about 50 minutes without reproducing a failure, then was stopped (owner decision).
- Likely cause, from reading `src/core/kg/graph.ts`: search score = BM25 x recency factor from `this.now()` (wall clock), rounded to 4 decimals; the test searched the live and the reloaded Graph at different moments, so a score can straddle a rounding boundary with identical data. A test timing problem, not (as far as known) a replay bug.
- Mitigation merged (`a88d595`): the comparison now pins one instant for both Graphs and the failure message names the differing part (nodes/edges/search/inbox). 10 of 10 runs pass on Windows afterwards.
- **Not proven:** the failure was never reproduced before the change, and no mutation check (does the test still catch a real replay break?) was done. Report the Library's "restart equals live" guarantee as *not confirmed on Windows*. If R6.1 fails again, the new message says which part differs.

## After install: Legion MCP for Claude Code (owner approved 2026-10-02, user scope)

1. Back up `~/.claude.json` to `~/.claude/backups/2026-10-02-legion-mcp/` with RESTORE.md.
2. `claude mcp add --scope user legion -- node "%LOCALAPPDATA%\Programs\Legion\dist\srcin\legion-mcp-stdio.js"` (stdio bridge reads the token itself; no token in the Claude config).
3. Verify tools list, then a one-line Haiku task. Token class cannot approve cards, accept notes or change settings. Remove with `claude mcp remove legion`.

## Item G: GitHub-ready docs and current screenshots (owner request 2026-10-02) - runs LAST, after BSV and Blender are merged

Cloud agent (claude.ai web surface) + independent reviewer; may run in parallel with the final Windows gate and the install.
- README, SECURITY, CONTRIBUTING, NOTICE, CHANGELOG: every claim checked against the code; features list current (queue, copy menu, tables, rooms incl. no default spend limit, MCP isolation, lazy key probe, Blender local-first + VM + live, BSV read-only + testnet tool, VM usage); Claude-only stated plainly, Codex/ChatGPT under "Later".
- Repo hygiene: CHANGELOG compare links say `OWNER/legion` (placeholder) -> `dnh33/legion`; package.json `repository`/`bugs`/`homepage`; issue templates; security policy + private vulnerability reporting; repo description and topics; note to enable secret scanning + push protection; the Dependabot branches in the private repo.
- Screenshots: regenerate ALL of `docs/images/*` and `docs/screenshots/*` from the built UI (mock server, demo data), light and dark, at README sizes; read each at full resolution; before/after side by side; Zealot art photographed only, never edited. Fallback if the cloud has no browser: capture on the PC with the Playwright harnesses under `test-perf/`.
- Reviewer checks docs against code and images against the real UI.

## Blender local-first: plan approved (2026-10-02)

Plan: `claude/plan-blender-local-first.md` (decisions in its section 10). Order: Step 0 (types/config/ports) -> 3 builders in parallel (runner+exports | routing+guard+pin | UI+setup+docs) -> integration -> Linux + Windows gate -> real-Blender run on the PC -> independent reviewer. Cloud via claude.ai web surface. Assumed, not confirmed: task folder location, min Blender 3.0, no job-object limits.
