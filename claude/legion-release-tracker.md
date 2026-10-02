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

## Work items

| ID | Item | State |
|---|---|---|
| W0 | Windows baseline (`npm ci`, build, test) | running |
| A | MCP isolation: `inheritMcp`, strict config, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, status in UI | todo |
| R1 | Room spend limit defaults to none (hub budget guard must accept "no budget"; member cap 6 unchanged) | todo |
| K1 | Lazy key probe | todo |
| U1 | Builder → `default` on upgrade | todo |
| B | Packaging: setup-yes.cmd / non-blocking setup, version, CHANGELOG, README, licences; **public-repo audit** (no secrets, licence/NOTICE) | branch `claude/release-packaging`: audit done (`tracker-public-audit.md`: no secrets, no rewrite needed; owner decision on unverified BSV-pack sources), installer + docs + NOTICE done; version bump and CHANGELOG finalise still open; real-PC installer check open |
| C | boat.dev + Blender real-system verification (owner present) | todo |
| D | Blender follow-ups (pin add-on, extension install path, busy-while-running, line counts) | todo |
| E | Real-PC sweep (§6.2) | todo |
| F | BSV rung 3 testnet tool (§6.6) | todo, after plan |
