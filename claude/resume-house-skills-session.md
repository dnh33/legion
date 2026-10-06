# Resume: house/skills session (Armory, CI panel)

Read this first after a compaction or in a new session. Last updated 2026-10-07.

## Done
- A2a (Armory) merged to main: PR #23, merge `00541f2`. CI 11/11 green, independent review "ship".
- Release `0.2.5-j` (the Armory) published 2026-10-07 by the orchestrating session (tag on merge `e850201`;
  pre-flight passed, asset digests and the live CDN manifest checked). Worktrees `legion-rel-j` and `legion-armory`
  and their local branches are removed.
- Merges and releases: the orchestrating session ("Legion Claude code mod planning") merges and releases (the maintainer
  put it in charge, as that session relayed on 2026-10-07). Tell it when a PR is green; do not tag, build or publish.

## Next, in order (scope lock, maintainer 2026-10-06; ladder in `claude/legion-release-tracker.md`)
1. Release B (CI panel) on a new branch off main. Build against a fake of the GitHub client interface from the
   connectors design rev 6 section 4.3 (`D:/bots/legion-connectors/claude/design-connectors.md`): `connection()`,
   `can(area, level)`, `request(path)`, `logs(jobId)` returning `{text, truncated}`. "Logs unavailable" is a normal
   state, because the storage-host allowlist ships empty until PC check C-GH-2. Re-run and Cancel go only through
   `writes.ts`, from admin-only routes, never an agent tool. Offer "Connect with write access" while
   `can('actions','write')` is `'no'`. Ship once the connectors session's real client is merged.
2. Then the ladder resumes: connectors (16, the connectors session) -> logging (items 3 and 7) is next. Logging and the
   connectors redactor (design rev 6, section 4.4) both rewrite the single `log()` in `src/bin/legion-core.ts` and the
   stdout/stderr wrappers: whoever builds logging agrees the design with the connectors session first.
   Release B plan: `claude/plan-ci-panel.md` on branch `feat/ci-panel` (worktree `D:/bots/legion-ci`).

## Coordination
- The orchestrating session ("Legion Claude code mod planning") owns connectors phase 1, merges and releases. It
  will message this session when the GitHub client (`src/core/connectors/github/client.ts`) is merged; Release B
  swaps its fake for it then. Propose any interface name change to it before using it.
- SpiffyVault is parked (ladder item 22).

## Working rules learned this session
- Token economy: do small edits myself; reuse agents; capped reports; Haiku applies spelled-out fixes, Sonnet or I
  verify; reviewers look only at the diff since the last review; CI runs the full suite.
- Accessibility aids only for those who need them: `:focus-visible` rings, `.sr-only` text, honour reduced motion
  and forced colours.
- The UX review loop is capped at one final review; after it, fix bugs and cheap polish only, and list the rest as
  known imperfections.
