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

`test/library-review-integrity.test.ts` "R6.1 replay fidelity" failed intermittently on Windows (1 of the original baseline, 1 of 3 gate runs): "seed 3 step 299: reloaded graph differs from live", nodes and edges equal, diff list empty. Never failed on Linux (1368/1368).
- Investigated by a local agent for about 45 minutes (worktree `D:/bots/legion-wt-r61`, branch `fix/r61-replay`): no failing sample reproduced; the test was instrumented to print which part differs.
- Hypothesis (from reading `src/core/kg/graph.ts`): search score = BM25 x recency factor from `this.now()` (wall clock), rounded to 4 decimals; the test builds the live and the reloaded Graph without an injected `now`, so searches run at different moments. If true it is a test timing problem, not a replay bug. Sent to the agent for a 5 minute test.
- Status until proven: **unverified**. The Library's "restart equals live" guarantee must be reported as not confirmed on Windows.

## After install: Legion MCP for Claude Code (owner approved 2026-10-02, user scope)

1. Back up `~/.claude.json` to `~/.claude/backups/2026-10-02-legion-mcp/` with RESTORE.md.
2. `claude mcp add --scope user legion -- node "%LOCALAPPDATA%\Programs\Legion\dist\srcin\legion-mcp-stdio.js"` (stdio bridge reads the token itself; no token in the Claude config).
3. Verify tools list, then a one-line Haiku task. Token class cannot approve cards, accept notes or change settings. Remove with `claude mcp remove legion`.
