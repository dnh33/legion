# Full-install releases work end to end Implementation Plan

> For agentic workers: use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** A release that changes dependencies ships a signed full package from CI, is checked by preflight and verify, applies safely in the updater, and is rehearsed end to end in CI.

**Architecture:** A pure script decides "did the dependency tree change" (same `dependencyHash` the app uses). release-build.yml uses it to write the final manifest. A shared script helper checks `fullAsset` for preflight and verify. The updater gets five hardening fixes, each test first. A windows-latest workflow installs the previous release with install.ps1, updates it from a loopback server, and asserts success, rollback and locked-file handling. No production code gains a switch: the rehearsal injects a Node `--import` preload through NODE_OPTIONS on the runner only.

**Tech Stack:** Node 24, TypeScript, node:test (tests compile to dist/test), GitHub Actions on windows-latest.

**Spec:** D:/Aetherkeep/06-projects/legion/research/full-install-plan-2026-10-14.md

## Global Constraints
- No em dashes in docs or user text. Say "your computer".
- No `Co-Authored-By`. Commits: `area: what changed for the user`.
- Never run installers on the dev PC; never use the real signing key; throwaway keys only.
- `src/core/updater/apply.ts` imports only `node:` builtins.

## Review Focus
- Forgotten flag: lock changed but manifest has no fullAsset -> preflight FAIL (Task 2).
- Version-only lock diff must not force a full install (Task 1).
- Antivirus removes a listed file after extraction -> stage refused (Task 3a).
- reExec fails -> nothing swapped, old app restarted, outcome visible (Task 3b).
- Slow first start -> not rolled back and not blocked 7 days (Task 3c).

### Task 1: Dependency-change decision (scripts/lib/deps-change.mjs, scripts/release-deps-decision.mjs, release-build.yml)
- [ ] Failing test `test/release-deps-decision.test.ts`: version-only diff -> false; dependency bump -> true; missing previous lock -> true (fail closed).
- [ ] Implement using built `dist/src/core/updater/package.js` dependencyHash.
- [ ] Wire release-build.yml: find previous tag, decide, pass `--full-zip --requires-full-install`, write job summary, hard smoke check.
- [ ] Test: manifest script `--requires-full-install` without `--full-zip` is an error unless `--notify-only`.

### Task 2: fullAsset checks (scripts/lib/full-asset-check.mjs; preflight; verify)
- [ ] Failing tests for the pure check (true needs exact name/size/sha; false refuses stray fullAsset; sums list).
- [ ] Wire into release-preflight.mjs and release-verify.mjs.

### Task 3: Updater hardening (src/core/updater)
- [ ] 3a verify extracted files against PACKAGE-FILES.json (missing, tampered, unlisted refused).
- [ ] 3b reExec failure: explicit result, no swap, old app relaunched, temp copy cleanup on next start.
- [ ] 3c first-start window: full swaps get 180 s plus one bounded extension while the new process lives.
- [ ] 3d disk: check zip + unpacked + 10% (exact unpacked read from the zip), delete the zip after extraction.
- [ ] 3e delete `.update/prev` after a confirmed healthy start.

### Task 4: Rehearsal (scripts/rehearsal, .github/workflows/full-install-rehearsal.yml)
- [ ] Preload (`--import` via NODE_OPTIONS, runner only): redirects github.com fetches to loopback and swaps the baked key in memory.
- [ ] Scenarios: success, forced first-start failure rolls back, locked file during swap.
- [ ] Tripwire test: no `secrets.`, no `pull_request_target`, read-only permissions, no src/ reads of the rehearsal env.

### Task 5: Docs (SHIPPING.md 4a.5, VERSIONING.md, CHANGELOG)
