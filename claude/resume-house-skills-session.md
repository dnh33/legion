# Resume: house/skills session (Armory, CI panel, logging)

Read this first after a compaction or in a new session. Last updated 2026-10-07.

## Done
- A2a (Armory): PR #23, shipped in `0.2.5-j` (published by the orchestrating session; real-PC checks AR1-AR8 open).
- Shared CI run parser: PR #26 (`src/core/ci/parse.ts`, also used by the connectors tool `github_ci_wait`).
- Release B (CI panel): PR #27, merged as `b4e51aa`, ships in the next letter. Runs on the real connectors client
  (`getGitHubClient()`, read port only). Re-run and Cancel stay hidden until connectors slice 2 adds
  `src/core/connectors/github/writes.ts` with module-level `rerunFailed(runId, repo)` and `cancel(runId, repo)`
  (agreed shape; the connectors session adds `src/core/ci/wiring.ts` to the writes import allowlist). The GitHub App's
  device-flow client id is still a placeholder, so the panel shows not-connected until the App is registered.
  Real-PC checks CI1-CI4 open.
- Logging design: PR #28, `claude/plan-logging.md`, agreed with the connectors session.
- Log redactor: PR #30 (`github_pat_` in `scrub.ts`; `src/core/log/redact.ts` with `redact`, `registerSecret`,
  `registerSecretBytes`). Not wired into `log()` yet; the connectors session calls `registerSecret*` in slice 1b.
- All worktrees of this session are removed except the docs one for this file.

## Next (maintainer order, 2026-10-07)
1. The orchestrating session's Order-bug PR (BUG-7, 1, 2, 3; branch `fix/order-bugs`) merges first. Do not edit
   `src/core/engine.ts`, `src/core/bridge.ts` or `src/core/kg/graph.ts` while it is open.
2. Then logging (ladder items 3 and 7) per `claude/plan-logging.md`, building on the merged redactor. It must land
   before connectors slice 2 (writes): the redactor needs a caller in `log()` and both stream wrappers. Pending detail
   for the build: logs mask bare 64-hex, so the updater's sha256 digests and BSV txids are logged as a 12-hex prefix.

## Coordination
- The orchestrating session ("Legion Claude code mod planning") owns connectors, merges and releases (the maintainer
  put it in charge, as that session relayed on 2026-10-07). Tell it when a PR is green; do not tag, build or publish.
  Agree before touching `src/bin/legion-core.ts`, the log sink or the stream wrappers.
- SpiffyVault is parked (ladder item 22).

## Working rules learned this session
- Token economy: do small edits myself; reuse agents; capped reports; Haiku applies spelled-out fixes, Sonnet or I
  verify; reviewers look only at the diff since the last review; CI runs the full suite.
- Accessibility aids only for those who need them: `:focus-visible` rings, `.sr-only` text, honour reduced motion
  and forced colours.
- The UX review loop is capped at one final review; after it, fix bugs and cheap polish only, and list the rest as
  known imperfections.
- Key-shaped literals in tests and fakes are built at runtime (`'gh' + 'p_' + ...`), or the public export refuses the
  file.
