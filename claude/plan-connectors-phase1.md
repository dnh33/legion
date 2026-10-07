# Plan: connectors phase 1 (GitHub first)

Design: `claude/design-connectors.md` (rev 6, signed off by the maintainer, plus the 2026-10-07 pins in section 4.3).
Branch `feat/connectors`, worktree `D:/bots/legion-connectors`. Orchestrator: the "Legion Claude code mod planning"
session (merges and releases). Order set by the maintainer: connectors, then logging.

Phase 1 is split so the CI panel (Release B, house/skills session) can land early. Each slice is one PR, built by a
Sonnet builder, reviewed by an independent reviewer (re-runs, tries to refute), CI is the gate.

| Slice | Scope (design sections) | Unblocks |
|---|---|---|
| 1a | Encrypted token store (4.4: envelope, write queue, AAD; key from Electron `safeStorage` via the per-launch native channel; a headless fallback that refuses to store), GitHub client `src/core/connectors/github/client.ts` (4.3: device flow for the read App, anonymous mode, `connection()`, `can()`, `request()` with ETag/304, typed `GhError`, `logs()` fail-closed with an empty storage-host list), harness fake GitHub (device flow + REST), tripwire entry for the client's fetch | CI panel wiring |
| 1b | Gateway (4.1: in-process MCP `mcp__legion_connectors__`, shipped class table, unknown = WRITE, `markTainted` in every handler, `AgentProfile.connectors` opt-in, client-origin refusal, redactor at the log sink) + GitHub read tools + `github_ci_wait` (imports `src/core/ci/parse.ts` once Release B lands; until then a local copy of the same shape) + Settings → Connectors → GitHub (connect, user code, status, disconnect) + `registerSecret()` (src/core/log/redact.ts, PR #30) on the admin secret, native secret and connectors KEY as each is read + the first-Connect core restart for a keyless launch (slice 1a closes the stdin pipe as before) | agents use GitHub |
| 1c | Generic OAuth engine (4.2) + treg with caps and spend safety (4.5) + Settings pages for them + MCP/AS fakes | treg |
| 2 | GitHub writes (write App on selected repos, `writes.ts` exporting module-level `rerunFailed(runId, repo)` and `cancel(runId, repo)` (Promise<void>, GhError, never retried), as agreed with Release B; the import allowlist includes `src/core/ci/wiring.ts` (admin routes), carded `github_ci_rerun` / `github_ci_cancel`) | CI panel Re-run/Cancel. **Blocked until** the redactor (PR #30) is wired into `log()` and both stream wrappers (logging build, house/skills session) |

Owner-only steps (gate the SHIP, not the build): register the two GitHub Apps in Chrome with one OK per step (design
section 9); real-PC checks C-GH-1..6 appended to `claude/tracker-pc-checks.md` as each slice lands.

Added to the ladder 2026-10-07 (maintainer): **context stats in the usage panel** (each agent's context use and
compactions, like Claude Desktop's usage view). After connectors unless the maintainer reorders.
