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
| 9 | Release | Public repo (version/installer not stated: assumed 0.1.0, robocopy installer fixed to be non-blocking, unsigned) | version/installer **assumed, not confirmed**; public repo confirmed |

## Work items (updated 2026-10-02 09:17)

Cloud work runs on the claude.ai/code web surface (credits). Branches live in private repo dnh33/legion. Reviews are on `claude/review-*` branches (`review/*.md`).

| ID | Item | State |
|---|---|---|
| W0 | Windows baseline: 1300 pass / 27 fail / 41 skip of 1368 | DONE: 27 test-side fixes, 1368 tests / 1327 pass / 0 fail / 41 skip on Windows, no product bug; independent review running (branch `fix/windows-baseline`) |
| A | MCP isolation (`claude/mcp-isolation`) | reviewed (SHIP AFTER FIXES), all 4 fix commits landed, 1387/1387; merged into integration/v1; real-PC check M1/M2 open |
| R1 K1 U1 | Rooms no default spend limit, lazy key probe, Builder reset (`claude/rooms-probe-upgrade`) | built; review = SHIP AFTER FIXES (B1 budget >10000, B2 operator ceiling bypass, K1-F1 doc wording); fix session running (claude web) |
| B | Packaging + public audit (`claude/release-packaging`) | reviewed (SHIP AFTER FIXES), all 8 fixes landed, 1392/1392 with PowerShell; merged into integration/v1; NOT run on Windows yet: see tracker-pc-checks.md P1-P10; version bump + CHANGELOG finalise still open |
| C | boat.dev + Blender real-system verification (owner present) | todo |
| D | Blender follow-ups | todo |
| E | Real-PC sweep (section 6.2) | todo |
| F | BSV rung 3 testnet tool (section 6.6) | todo, after plan |

## Open owner decisions

- DECIDED 2026-10-02: BSV knowledge pack: soften NOTICE to "written in our own words from public documentation; licence status of some sources not established", ship pack unchanged (91 of 157 nodes only unverified/no-licence sources; 24 cite private `legion-specs` docs). To apply after the packaging fix session lands.
- Release version/installer assumed 0.1.0 + robocopy installer, unsigned (assumed, not confirmed).
- Weekly Claude usage at ~98% (resets Mon Oct 5 01:00): cloud sessions may stall.
