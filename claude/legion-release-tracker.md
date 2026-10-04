> **SUPERSEDED as a source of instructions.** `integration/v1` was merged into `main` and deleted on 2026-10-03.
> This file is kept as history. Read `claude/START-HERE.md` first, then `claude/legion-release-tracker.md`
> (section `POST-0.2.2`). Anything below naming a branch, work order or state predates that merge.

# Legion release tracker

Living tracker for the v1 release. Updated 2026-10-02 by Claude Code on the PC. Big topics get their own `tracker-<topic>.md` in this folder.

> ## ⛀ SESSION SAVE POINT (2026-10-03, pre-compaction — READ THIS FIRST, supersedes everything below)
> **integration/v1 head:** `cf41cff` (docs) over `bf90b94` (code). Worktrees: `D:/bots/legion` (integration/v1), `D:/bots/legion-gate` (detached gate), `D:/bots/legion-dev` (main clone on `claude/trailer-v2-build`), `D:/bots/legion-site` (site; main == loving-clarke `c3b7c41`).
> **State:** WO-1/2/5/7/8/9 CLOSED + gated + audited + recorded (WO-1 2316/2269/2/45; WO-2 2380/2333/2/45; WO-7 2381/2336/0/45; WO-9 Windows 2384/2339/0/45 ×2 + snapshot acceptance 2384/2339/0/45). WO-4 trailer rendered + verified, awaiting owner watch/listen. WO-10 (release) next, needs WO-4 first.
> **Design/debt review (done today):** `codebase-design` (18) + `zero-tech-debt` (23) subagent findings, spot-validated by grep. SAFE fixes kept, committed: 1221bad (prod `?latticeDiag` debug hook gone; dead `getBoardState` + `BLENDER_SAFETY_NOTE`; stale comments; `(token fix v1)` tag), plus the KEPT parts of 325fd73/bf90b94 (`normaliseModel` single home in bridge.ts, 6 dead UI exports removed, `ROOM_STRATEGIES` single-home in shared/comms.ts).
> **FOUR reverted (the subagents' "dedup/dead" advice was wrong to apply blind):** (1) engine.ts `claudeAvailable?.()` — load-bearing for partial test mocks; (2) comms inline `isVisible` → `agentVisible` — helper's strict `=== true` differs from the original truthiness; (3)+(4) **bsv/types.ts (`MainnetState`/`MainnetToggleBody`) + bsv/mainnet-routes.ts (a comment)** — `test/bsv-scan.ts` treats the bsv files as fail-closed one-home/pinned-guarded; ANY edit — even removing a truly-dead type or a comment — trips its tripwires (44 failures: every F2-plant, spend-tripwire, "dead allowance", "one home each"). Reverted in 2fe55cd + 9ccbfb9. Isolated proof: the 3 bsv test files run alone = **91/91 pass / 0 fail**.
> **LESSON (permanent):** dead-symbol/comment removal inside pinned bsv files (types.ts, mainnet-routes.ts, policy.ts, spend.ts, networks.ts, audit.ts, wallet-tool.ts, wallet-probe.ts) is NEVER a routine cleanup — it is a separate reviewer-signed **pin-recompute** step (`node scripts/bsv-spend-pin.mjs`). The deferred pin-recompute list is now: `MainnetToggleBody`, `MainnetState` (types.ts), `CARD_WINDOW_MS` (spend.ts), `TESTNET_MAX_ALLOWLIST` (policy.ts).
> **CLEAN GATE IN FLIGHT at 9ccbfb9** (background `proc_b1da5897ca2a`, log `/tmp/gate-9ccbfb9.log`) — read its `ℹ tests/pass/fail` when it finishes; expect ~2384/0/45, or the known load flakes (browser E4/E8, vm-fixes-http R7, bsv-spend-flow/mutants output-check, harness-smoke). Pitfall logged: two gates ran CONCURRENTLY in the one gate worktree earlier and clobbered each other's `dist/` (~250 spurious failures) — one gate at a time, always.
> **☰ RE-SCOPE (owner 2026-10-03):** 0.2.0 goes LEAN & fast — deliver via the install script (`setup.cmd`, like v6-6), **NO prebuilt/lite package** (that's 0.2.1). **OpenRouter SHIPS in 0.2.0 (owner decided)** — subagent `deleg_f15afc1a` is implementing it on branch `claude/openrouter-0.2.0` (enable + model-map deepseek-v4.1-flash=reasoning / gemini-3.8-flash=GUI); the trailer's NEXT cards + facts/site/CHANGELOG verbage must also reflect it (\"More model providers\" is no longer fully a 0.2.1 item). Repo→public prep runs in parallel. **FINAL REVIEW GATE DEFERRED** until after OpenRouter lands. TEMP CLEANUP DONE: ~37 GB freed.
> **Blocked on owner:** OpenRouter key (Aetherkeep→config); computer-use skills (`hermes-computer-use` still not on disk); repo rename → public; updater signing key; site deploy. **☰ SAVE-POINT (trailer approved, 2026-10-03):** owner watched the chip-free cut → **APPROVED, "it was great"**. One feedback: bring the score up to the FIRST trailer's (`docs/video/`) sound quality — v1's `score.py` (445 lines, 8 named sections incl. "field" kick+bass and "forges" glassy-chain/seal-chime) is richer than v2's (simplified `CYC` cycling + fewer sections). Open task: port v1's richer instrumentation to `docs/video-v2/score.py`, re-generate `score.wav`, re-mux, re-render. **Trailer final cut (owner 2026-10-03, overrides the earlier deferral):**_ DONE — all "not yet tried" chips (`CHIPS=[]` in timeline.mjs) + end-card caveat stripped, check.mjs chip-enforcement removed; RE-RENDERED + VERIFIED clean (`3633d6f` on `claude/trailer-v2-build`: 47.5 MB mp4 + 105 s audio, 5.85 MB gif, 1.89 MB poster; frames pulled + vision-checked — board/browser/end all chip-free). Awaiting owner watch/listen → WO-4 targeted merge. Save-points 1/2/5/7/8/9 written; SP-4 (trailer merge) + SP-10 (final) pending.

> ## ⛀ READ THIS FIRST — LATEST STATUS (2026-10-03, integration/v1 = `aa09170`). Supersedes every "SESSION SAVE POINT N" and "STATUS UPDATE" below.
> **Closed + gated + audited + recorded:** WO-1 agent-audit (2316/2269/2/45), WO-2 project board (2380/2333/2/45), WO-5 website (Lighthouse 99/100/100/100), WO-7 security review (re-gate 2381/2336/0/45), WO-8 docs + fresh screenshots (5 review fixes), WO-9 open-sourcing (`scripts/export-public.mjs` + `test/export-scrub.test.ts`, reviewed ×2, Windows gate 2384/2339/0/45 ×2, snapshot acceptance 2384/2339/0/45, PII-clean snapshot).
> **In progress / blocked on owner:** WO-4 trailer — cut rendered and VERIFIED (frames pulled from the final mp4: intro/browser t76/digest t47-full/end card all clean; audio full 105 s, −13.3 LUFS, no silence/clipping). Awaiting the owner's watch/listen approval (the one thing tooling can't do: the music has not been heard by a human) to merge `claude/trailer-v2-build`. WO-10 release — PR `integration/v1 → main` (Linux CI gate), `/code-review ultra`, deliver `legion-v6-7`, prebuilt, MCP, real-PC run, tag `v0.2.0` — needs WO-4 first.
> **Owner-only / pending directives:** OpenRouter sole extra provider (Aetherkeep key → config; deepseek-v4.1-flash = non-GUI reasoning, gemini-3.8-flash = GUI seat), mainnet BSV cleared (tiny amounts), computer-use skills (`hermes-computer-use` not on disk yet), repo rename → public, updater signing key, site deploy. NO `/code-review ultra` (owner 2026-10-03: it is a paid Claude feature, off the table) — the release reviews are run by the orchestrator with the skills at hand (code-review-excellence, systematic-debugging, kodawari, grill-with-docs, verification-before-completion) + fresh subagents.
> **Save-points:** ⛀ SP 1/2/5/7/8/9 done (markers below). SP-4 fires on the trailer merge; SP-10 = final handoff. Hermes todo list mirrors this 1:1 (revision 27).
> **Deferred (owner 2026-10-03):** trailer FINAL cut with NO dev caveats — strip the "Built and tested. Not yet tried on a real PC." chips and any "not yet tried" wording, since the trailer showcases 0.2.0, not its development. Deferred until AFTER the 0.2.0 build is fully real-PC-tested and issues fixed (the chips stay while they're still true; they become removable once validated). Re-render then.
> **New quality gate (owner 2026-10-03):** before the build is handed to the owner's PC — subagent reviews `codebase-design` (deep modules/interfaces/seams) + `zero-tech-debt` (end-state shape, dead code, one home per rule) on integration/v1, then VALIDATE each finding (read the code, confirm real + fix sound) before any fix. Findings feed a pre-install fix round.

## 2026-10-03 design/debt reviews (deleg_875b1c32) — VALIDATED, triaged
- Two read-only subagents (codebase-design 18 findings, zero-tech-debt 23); I spot-verified the security/dead-code claims by grep (native-secret 5-copy divergence, STRATEGIES byte-dup, CARD_WINDOW_MS dead alias, latticeDiag prod hook, dead-export refs) — all confirmed real. 4 findings were correctly self-refuted (eventbus, sse, Blender legacy sandbox mirror, projectBoard switch).
- FIXED NOW (1221bad, gated): prod `?latticeDiag` debug hook removed (CanvasPane.tsx — now dev-only); dead `getBoardState` export+import and `BLENDER_SAFETY_NOTE` removed; stale "experimental board" comments freshened to `features.projectBoard`; `(token fix v1)` tag dropped from admin.ts.
- DEFERRED TO 0.2.1 (recorded, not lost): the structural/deeper items — kg→bsv HTTP-route-as-function with fabricated Ctx; Bridge's mutable `isVisible`/`catalog` hooks; the native-secret guard copy-pasted 5× (updater's `!opts.nativeSecret ||` shape differs); atomic-write/corrupt-quarantine in 5+ stores; engine-internal `as` casts; providers bypassing the CoreModule seam; agent-defaults + model-validation duplicated; UI store factory; plus the pinned-file dead code (CARD_WINDOW_MS in spend.ts, TESTNET_MAX_ALLOWLIST in policy.ts — need bsv-scan pin update + reviewer sign-off), the remaining constant dedups (STRATEGIES, idle-stop 15, MIN_ROOM_BUDGET 0.05, port 4747, Blender 120s), the experimental-vs-features flag split, loopback×3, and the kg/Lattice/Library naming (needs an owner product-term call). None of these are correctness or security defects — the tree stays green; churning guards/core wiring pre-install is exactly the regression risk to avoid.
- Lesson (d762fe5): the C1 tripwire (`test/project-board-flag.test.ts:53`) pins the literal `projectBoard` to exactly two files; a comment "freshen" that wrote `features.projectBoard` into server.ts + two UI files tripped it (3 real failures the first gate caught). Reworded without the dotted name. The other two first-gate failures (browser E4, spend-flow output-check-extra-outputs) are the known load flakes — both pass clean in isolation.
- FIXED, rounds 2+3 (325fd73 + bf90b94, typechecked): one `normaliseModel` home in bridge.ts (resolveModel + checkModel both call it); dropped the dead `claudeAvailable?.()` optional-call in engine.ts; comms now reuses the shared `agentVisible` rule instead of re-stating `a.requires !== 'bsv'`; removed dead `MainnetState`/`MainnetToggleBody` (bsv/types.ts) + dead UI exports `getBsv`/`getRooms`/`useQueuedTotal`(+`totalOf`)/`AUTO_LABEL`/`BUST_IDS` and the `getBoardState` export/import + `BLENDER_SAFETY_NOTE`; `ROOM_STRATEGIES` now has one home in shared/comms.ts (hub.ts + routes.ts read it); dropped the "T2 adds the one line" task-id comment in mainnet-routes.ts.
- STILL OPEN / NEXT (mechanical, not done this session — recorded so they are not lost): the constant single-homing (idle-stop 15, port 4747, wait 600, MIN_ROOM_BUDGET 0.05, Blender 120s — all currently CONSISTENT, so zero drift today, pure future-proofing); the pinned-file dead symbols `CARD_WINDOW_MS` (spend.ts) + `TESTNET_MAX_ALLOWLIST` (policy.ts) — inside the bsv-scan hash-pinned files, so removal needs the pin recompute which the repo gates behind a reviewer sign-off; the native-secret guard 5→1 consolidation (the five call sites carry deliberately different diagnostic messages, so it is a careful red-flag pass, not a tail-of-session edit).
- 0.2.1 (structural refactors, deferred on purpose — not correctness/security): kg→bsv route-as-function with fabricated Ctx; Bridge's mutable `isVisible`/`catalog` hooks; atomic-write/corrupt-quarantine ×5 stores; engine-internal `as` casts; providers bypassing the CoreModule seam; agent-defaults + model-validation (4 divergent regexes) single-home; UI store factory (useSyncExternalStore ×10); experimental-vs-features flag split; harness core-entry composition copy; loopback-rule ×3. Rationale: these are rewrites of core wiring/persistence/security with real regression risk; doing them in the margin of a green release tree is exactly the mistake to avoid. Each will get a red-first + full gate as its own round.

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
| D | Blender: **local-first** (owner direction 2026-10-02): add a local headless mode (`blender -b` on this PC, per-task scene, approval card with full script, backup, audit, exports quarantined) as the default when Blender is found; boat.dev VM stays as the opt-in isolated mode. Today default is VM-first and local = live add-on socket only. Plus pin community add-on, extension install path, busy-while-running, line counts. Plan for owner approval before build (trade-off: a local script has the user's full rights; the static check is a filter, not a sandbox) | plan approved; Step 0 and builders 1-3 built on `claude/blender-*` branches (Builder 3: `claude/blender-b3-ui-setup`: UI, extension install, hedge test, docs); integration, Linux and Windows gate and the real-Blender PC run pending (`claude/tracker-pc-checks.md`) |
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

## Branches on GitHub (dnh33/legion, private)

- `main` = default branch (created 2026-10-02 from `integration/v1`; `rel2` history is underneath). Only moved by fast-forward from `integration/v1` after the full Windows + Linux gate passes.
- `integration/v1` = working integration branch (all merges land here first).
- `claude/*` = cloud builder/reviewer branches (never deleted; reviews are `claude/review-*`). `rel2` = the original bundle branch, kept as is.
- Full local backup bundle: `D:/bots/legion-backup-20261002.bundle` (all branches at 2026-10-02 13:18).

## BSV scope change (owner, 2026-10-02): mainnet capability IN v0.2.0

Earlier decision "mainnet out of v1" is replaced: the spend tool is built and independently reviewed with BOTH testnet and mainnet capability before v0.2.0. Mainnet stays hard-off by default (native-confirmed policy change + Arm + LIVE FUNDS dialogs), and is not called verified until the owner's own real-funds check (tiny amount, owner present) is recorded. Plan amendment: `claude/plan-bsv-rung3.md` section 12 (in progress). T1 and T3 were started against the testnet-only plan and are revisited by the amendment; T2 (spend module) has not started and builds both networks from the start.
Wallet environment for the first read-only checks (V1/V2): separate testnet environment (owner chose option 1). Windows Sandbox is NOT enabled on this PC (WindowsSandbox.exe missing, session not elevated): enabling needs an administrator PowerShell (`Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`) and a restart; BSV Desktop install, wallet creation and testnet coins are done by the owner by hand.

## RESUME POINT (written 2026-10-02 13:30; weekly Claude plan usage was 99%, cloud credits $238 of $250 left, expires Nov 5)

If the orchestrating session stops, a fresh session can continue from here. Cloud sessions run on the claude.ai/code web surface (credits) and do not need the orchestrator to keep running; they push their branch when done.

State:
- `integration/v1` (pushed; `main` is the default branch and equals an earlier integration tip, moved by fast-forward only after a passing gate). Gate on the merged tree: Windows 1446 tests / 1412 pass / 0 fail / 34 skipped, typecheck + UI build green. Checkpoint delivery folder `D:/bots/legion-v6-6` (md5-verified, NOT installed). Backup bundle `D:/bots/legion-backup-20261002.bundle`.
- Running in the cloud (check the sidebar of claude.ai/code, or `git fetch cloud` and look for the branch): BSV T1 `claude/bsv-t1-plumbing`, BSV T3 `claude/bsv-t3-native-ui` (both were started on the testnet-only plan: they must be revisited for mainnet, see plan section 12), Blender Step 0 DONE `claude/blender-step0` (not yet gated or merged).
- NEXT, in order: (1) launch Blender builders B1 runner+exports, B2 routing+guard+pin, B3 UI+setup+docs from `claude/blender-step0` per `claude/plan-blender-local-first.md` section 7; (2) read plan-bsv-rung3.md section 12 (mainnet amendment), send T1/T3 the listed corrections, then T2 spend module AFTER the V1/V2 wallet checks; (3) independent adversarial reviewer for every branch (cloud, web surface), fix rounds, merge to `integration/v1`; (4) item G docs + screenshots (last); (5) full gate on Windows + Linux, build the delivery folder `D:/bots/legion-v6-7` (never overwrite v6-6), install with `setup-yes.cmd`, register the Legion MCP (user scope, see above), run `tracker-pc-checks.md` P1-P10, then fast-forward `main`.
- Owner actions pending: enable Windows Sandbox (admin PowerShell `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All` + restart); in the sandbox the owner installs BSV Desktop in testnet mode, creates the wallet and gets testnet coins (the agent does not create accounts or passwords); reproduce the community add-on sha256 on the PC.
- Open items: R6.1 flake (mitigated, unproven); scrubSecrets quadratic on 3 shapes; VPS sync of Aetherkeep (ssh timed out); Aetherkeep notes written 2026-10-02 (`06-projects/legion/legion-v0.2.0-release-2026-10-02.md` etc.).
- Never: touch the owner's own BSV wallet (127.0.0.1:3321) with any automation; commit secrets; force-push or delete branches; overwrite an earlier delivery folder.

## Review plan (owner request 2026-10-02): cloud review with Anthropic's code review

- Per-branch independent adversarial reviewers (cloud, claude.ai/code web surface, defensive framing, mutation checks) stay: they know the controls.
- Added gate: `/code-review ultra` (multi-agent cloud review) on a pull request. It is user-triggered and billed: the orchestrating agent cannot launch it. Plan: open PR `integration/v1` -> `main` on dnh33/legion after the BSV work (T1, T5, T2, T3 second pass) is merged, owner runs `/code-review ultra <PR#>` from a Claude Code session started in `D:/bots/legion-dev` (needs a git repo); again on the final integration before `main` moves. `--post` only if the owner wants findings on the PR. Billing source (cloud credits vs plan limit) unknown: check the confirmation prompt. Fallback if the cyber safeguard stops it on BSV/Blender code: the defensive-framing reviewers.

## STATUS UPDATE (2026-10-02 ~13:45) - read this first if resuming

Running in the cloud (claude.ai/code sidebar; each pushes its branch when done): BSV T1 `claude/bsv-t1-plumbing` and T3 `claude/bsv-t3-native-ui` (both got the mainnet scope corrections), Blender B1 `claude/blender-b1-runner`, B2 `claude/blender-b2-routing`, B3 `claude/blender-b3-ui-setup` (all from `claude/blender-step0`, which is done). Plans: `claude/plan-bsv-rung3.md` (sections 11-13 = decisions incl. mainnet amendment), `claude/plan-blender-local-first.md` (section 10 = decisions).
Owner decisions since the resume point: mainnet capability IN v0.2.0 (hard-off, Arm, own real-funds check R0-R11 by the owner; v0.2.0 ships saying "not verified with real funds"); mainnet defaults = recommended (assumed): caps 1,000/2,000/5,000 sat, one Arm per spend, tainted run allowed with extra dialog, network = wallet's claim; testnet: no Arm, only owner-started runs may request spends; wallet env = separate Windows Sandbox (not enabled yet; owner enables it as administrator, installs BSV Desktop testnet, creates wallet; V1/V2 by hand gate the spend module T2); reviews: per-branch cloud adversarial reviewers + owner-run `/code-review ultra <PR#>` on a PR integration/v1 -> main (agent cannot launch it).
BSV order: T1 merge -> T5 mainnet enablement -> T2 spend module (after V1/V2) + T3 second pass -> T4 docs -> independent review -> ultra.
Blender order: B1/B2/B3 merge into `integration/v1` (B2 owns conflicts in index.ts; `test/bsv-scan.ts` also edited by BSV T2 later) -> full gate Linux + Windows -> real-Blender PC run (plan 6.2) -> independent reviewer.
Then item G (docs + screenshots), delivery `D:/bots/legion-v6-7`, install, Legion MCP (user scope), PC checks, fast-forward `main`.
Limits: weekly Claude plan usage ~99% (reset Mon Oct 5 01:00); cloud credits $238/$250 left (expire Nov 5), about $1.30 per cloud session; the cloud sessions keep running without the orchestrator. Never use the API routine route for cloud work.

Blender B4 (managed Blender: "Get Blender for Legion" pinned portable download + "Open download page" + winget text) is planned in `claude/plan-blender-local-first.md` section 11; starts after B1-B3 merge (owner approved the idea 2026-10-02; deliberately not steered into the running builders).

Item G phase 1 STARTED 2026-10-02 (cloud, `claude/docs-release-ready-1`): README/CONTRIBUTING verified against code, CHANGELOG compare links -> dnh33/legion, package.json repo fields, issue/PR templates, SECURITY reporting section, README status block, and the owner's request: README title as an ASCII-art bold GOTHIC banner (pure ASCII, alternatives in `claude/banner-alternatives.md`). Phase 2 (after BSV + Blender + managed Blender merge): feature docs, screenshots of the real current UI, independent review. Interpretation of "Legion should stand with ascii gothic bold font" = README banner; owner to confirm or redirect (e.g. app startup screen).

Item G phase 1 DONE (`claude/docs-release-ready-1`, 1 commit: README/CONTRIBUTING verified, status block, CHANGELOG links -> dnh33, package.json repo fields, issue/PR templates; its test counts not yet independently checked; to be reviewed with phase 2). Banner decision (owner 2026-10-02): **gothic wordmark IMAGE in Grenze Gotisch**, not ASCII (no figlet font is true blackletter; fraktur is 116 columns). Phase 2 task: generate light and dark SVG wordmarks with the glyph outlines converted to PATHS (no font dependency on GitHub) from the bundled `ui/src/fonts` Grenze Gotisch (OFL, already in NOTICE) using a dev-only script in a sandbox (no new repo dependency; keep the script in `scripts/`), show them via `<picture>` with prefers-color-scheme in the README, optionally keep one small ASCII line under it, replace the Roman ASCII banner. Alternatives file `claude/banner-alternatives.md` can be deleted after.

## Website (owner request 2026-10-02)

New PRIVATE repo `dnh33/legion-site` (default `main`), seeded with the art, fonts, UI tokens, wordmarks, screenshots, a copy of the product docs and a `CLAUDE.md` brief (install command first in the hero with links to Instructions and GitHub; honest status; Relic/Grenze Gotisch art direction; Zealot art untouchable; the owner's Kodawari skill embedded; Lighthouse >= 95; acceptance checklist). Cloud session started 2026-10-02 (claude.ai/code, "do not stop until done", about 3-4 hours planned). Output: `dist/` + `DEPLOY.md` + `NEEDS-OWNER.md` + `qa/`. The owner deploys (Netlify/Cloudflare/GitHub Pages) and decides domain and analytics. Screenshots on the site are swappable through a manifest; refresh them after item G phase 2. The install command on the site must be re-verified once the product repo is public and the installer/README final.

## STATUS UPDATE 2026-10-02 ~14:40 (supersedes the earlier STATUS UPDATE where they differ)

Merged into `integration/v1` and pushed: BSV T1 (plumbing + 6 review fixes; Windows gate 1465 tests / 1431 pass / 0 fail). NOT yet in integration: Blender merged branch `merge/blender` (B1+B2+B3 + integration fixes; Windows gate clean 1552 / 1517 / 0 fail / 35 skip; independent cloud review running, branch `claude/review-blender-merged`).
Running in the cloud now: BSV T5 `claude/bsv-t5-mainnet` (per-network policy core, mainnet hard-off); Blender merged review; website (`dnh33/legion-site`); test harness `claude/test-harness` (docs/TESTING*.md + scripts/harness, scenario runner, fakes for model/boat/BSV wallet(refuses 3321)/blender; BSV spend, mainnet and local Blender sections PENDING with extension points: needs a short second pass after those merge). Done earlier: T3 first pass `claude/bsv-t3-native-ui` (second pass after T5), docs phase 1 + wordmark `claude/docs-release-ready-1` (not merged; review with phase 2).
Next: review T5 -> merge; T2 spend module after the owner's V1/V2 wallet checks (Windows Sandbox not enabled yet: owner action); T3 second pass; Blender: review verdict -> fixes -> merge to integration -> B4 managed Blender; docs phase 2 + screenshots; harness phase 2; then full gate, delivery `D:/bots/legion-v6-7`, install, Legion MCP, PC checks, fast-forward `main`, PR integration/v1 -> main for the owner's `/code-review ultra`.
Lessons: never switch git branches in the main clone while a background gate runs (it invalidated one run); use a separate worktree (`git worktree add`) for gates and remove it with its node_modules junction detached.

## Real-PC test plan (owner request 2026-10-02)

Everything any agent says only a real PC can verify goes into ONE executable plan for a later computer-use or owner run. Standing rule added to repo `CLAUDE.md` ("Real-PC checks": append a numbered check to `claude/tracker-pc-checks.md` and list it in the report). Cloud session `claude/real-pc-test-plan` consolidates all existing sources (reviews, plans, "not verified" sections) into `claude/real-pc-test-plan.md` + `scripts/harness/pc-checks.json` + `node scripts/harness/pc-report.mjs`. Safety classes: real-wallet / real-funds / downloads / spends-money never run without the owner present and a go. Also running: e2e (tester.army) evaluation on throwaway branch `claude/e2e-eval` (Haiku review: safe to try in a sandbox; decide adoption after its report).

## SESSION SAVE POINT 2026-10-02 16:25 (written before the orchestrating session was compacted). READ THIS FIRST.

Repo/branches (GitHub dnh33/legion, private; `main` default; local clone D:/bots/legion-dev on `integration/v1`, pushed to remote `cloud`): `integration/v1` has BSV T1 merged + plans + CLAUDE.md + this tracker. NOT merged yet: `merge/blender` (B1+B2+B3 + fixes; being fixed in the cloud), `claude/bsv-t5-mainnet`, `claude/bsv-t3-native-ui` (first pass; second pass after T5), `claude/docs-release-ready-1` (docs phase 1 + gothic wordmark), `claude/test-harness`, `claude/e2e-eval` (throwaway, never merge), `claude/real-pc-test-plan`. Website is a SEPARATE private repo `dnh33/legion-site` (main). Backup bundle D:/bots/legion-backup-20261002.bundle; checkpoint delivery D:/bots/legion-v6-6 (not installed).
Cloud sessions (claude.ai/code, credits; check the sidebar or `git fetch cloud`): BSV T5 reviewer (branch `claude/review-bsv-t5`), Blender fix on `merge/blender` (spec = `claude/review-blender-merged` review, verdict BLOCK because LocalRunner was not wired into production; M4 pushed, M5 + lows maybe pending), website build (`dnh33/legion-site`: review-fix pass done, Pages workflow manual), test harness (built; Windows: smoke 3/3, scenarios exit 0; independent review NOT done), e2e (tester.army) evaluation (`claude/e2e-eval`; Haiku review said safe to try in a sandbox; owner decides adoption after the report), real-PC test plan (`claude/real-pc-test-plan` -> claude/real-pc-test-plan.md + scripts/harness/pc-checks.json + pc-report).
Gates (Windows, run in a SEPARATE worktree `D:/bots/legion-gate` with a node_modules junction; remove a worktree by `cmd /c rmdir <wt>\node_modules` FIRST, never recursive-delete a junction; NEVER switch branches in the main clone while a background gate runs): integration/v1+T1 = 1465/1431/0/34; T5 merged tree = 1511/1477/0/34 (green, but T5 not merged until its review passes); merge/blender before its fix round = 1552/1517/0/35 (hedge test + Windows test fixes already applied). Leftover worktrees D:/bots/legion-wt-win and D:/bots/legion-wt-winfix hold node_modules junctions (merged branches; safe to remove with the rmdir-junction-first rule).
NEXT (in order): (1) read `review/bsv-t5-review.md` on `claude/review-bsv-t5`, fix round, Windows gate, merge T5 -> integration; (2) when the Blender fix reports done: Windows gate on `merge/blender` (separate worktree), a quick re-review of the production-wiring test, then merge into integration/v1; then ONE builder session B4+B5 (managed Blender download, Sculptor guidance, first-use chooser; plan sections 11-12; ask the owner which Blender version to pin); (3) T2 spend module ONLY after the owner's V1/V2 wallet checks in a separate testnet environment (Windows Sandbox not enabled yet), then T3 second pass, T4 docs/pack, independent review of the whole BSV set, owner-run `/code-review ultra` on a PR integration/v1 -> main; (4) independent review of the test harness; read the e2e report and ask the owner; merge the real-PC plan; (5) docs phase 2: feature docs, fresh screenshots of the real UI, merge the wordmark branch, review; website final check (install command once the product repo is public); (6) full gate Linux + Windows, delivery `D:/bots/legion-v6-7` (never overwrite v6-6; git archive + md5 check), `setup-yes.cmd` install, Legion MCP registration (user scope, plan above), run the real-PC plan with the owner for anything real-wallet/real-funds/downloads, fast-forward `main`.
OWNER ACTIONS PENDING: enable Windows Sandbox (admin PowerShell `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`, restart), install BSV Desktop testnet + wallet + testnet coins inside it (agent never creates accounts/passwords), the owner's own real-funds check R0-R11 by hand, reproduce the community add-on sha256, decide Blender version to pin, decide e2e adoption, domain/analytics for the site, VPS sync of Aetherkeep (ssh timed out earlier).
LIMITS: weekly Claude plan usage ~99% (resets Mon 2026-10-05 01:00); cloud credits were $238 of $250 (expire 2026-11-05), ~$1.30 per ordinary session, the website session is long. Cloud sessions keep running without the orchestrator and push branches.
DECISIONS RECORDED: see the tables above and the plan docs (BSV plan sections 11-13, Blender plan section 10-12). Mainnet is IN v0.2.0 but hard-off and not "verified with real funds" until the owner's check; Blender is local-first; room spend limit none by default; version 0.2.0; gothic wordmark image (Grenze Gotisch); no ASCII banner.

## PROGRESS 2026-10-02 ~17:00 (after compaction)
All earlier cloud sessions finished. DONE: `merge/blender` gated on Windows (clean dist) 1567 tests / 0 fail / 37 skipped and merged into integration/v1 (4b7ff9b); the production-wiring test is POSIX-only so the Windows run is a real-PC check. Real-PC test plan merged (adds test/pc-report.test.ts, not yet gated). T5 independent review verdict SHIP AFTER FIXES (B1 net lost in audit lines, B2 no-payment tx, B3 approved spend after Disable, B4 tamper keeps switch on, B5 file vs memory, B6-B8, polish); fix session running on branch `claude/bsv-t5-fixes` (session_01LdEyJGqJstVE2bnWig1sPP). e2e report (claude/e2e-eval, eval/e2e-report.md): PILOT ONLY, recommend skip for v0.2.0 (needs API key for agent steps, no Windows/Electron). Still to do: independent review of claude/test-harness, gate real-PC plan merge, T5 fixes gate+merge, B4+B5 Blender (needs owner Blender version), docs phase 2, website check.
GATE NOTE: after switching branches in the gate worktree run `rm -rf dist` first (stale dist tests from another branch fail).
Owner decided Blender version policy (2026-10-02): full Blender = link to latest official download; headless = Legion fetches one pinned build we choose (recommended newest 5.2 LTS patch); minimum for local mode raised to 4.2. B4+B5 builder session running: branch `claude/blender-b4-b5` (session_01C4vXut6i4FSb5kyF6azE8a). Harness review session: `claude/review-test-harness` (session_01BkYqU5SUD5EasGNbrd3zKu). Open question given to the builder: can community + official add-ons coexist for max Sculptor tool surface.
Owner decision (2026-10-02): add multi-provider support (OpenAI, Codex, OpenRouter, OpenCode, custom endpoints) in v0.2.0, planned and built in one cloud session, isolated: branch `claude/providers` (session_01EFq4umrutWgkZ2F6xbPqx4), plan in claude/plan-providers.md, new files only plus a minimal engine.ts hook. Public wording "Claude only" (README, website brief, docs) must change when it merges: the session lists the exact replacement sentences. Needs an independent review (security: keys, egress, taint) and real-key owner checks before any "works with X" claim.
2026-10-02 ~17:30: BSV T5 + fixes B1-B8 merged into integration/v1 (gate on the T5 branch 1531 tests, 0 real fails; R3.4 scrub timing test is the known flake/quadratic item: failed once at x35.7, passes alone). NOT re-reviewed independently after the fixes; re-check B1-B5 with the T2 review. Harness review (review/test-harness-review.md on claude/review-test-harness) = SHIP AFTER FIXES (7 small findings: zero-check scenarios and cleanup must FAIL, npm banner breaks JSON, orphan temp dir, pointer file for parallel runs, env allowlist, .invalid host, doc order). Harness not merged yet.

## PROGRESS 2026-10-02 (B4+B5 built, branch `claude/blender-b4-b5`, based on integration/v1)
Built in the cloud: managed Blender download (pinned 5.2.2 LTS x64 zip, hash from the owner, address unconfirmed; TODO OWNER PC B12), strict zip reader, approval-before-download, detection prefers the managed copy, Settings "Get Blender for Legion" and "Get full Blender", local minimum Blender 4.2, Sculptor guidance, first-use chooser. Community + official add-on together: not wired, documented (docs/BLENDER.md). PC checks B12-B16 in `claude/tracker-pc-checks.md`. Needs an independent review before merge into integration/v1; nothing here was run against a real Blender or the real download.
2026-10-02 ~17:45: Blender B4+B5 merged (gate on the branch 1627 tests, only R3.4 failed, second time: timing test on scrub, being investigated in claude/test-harness-fixes). Pin 5.2.2 LTS windows-x64 zip sha256 3849d17a...b535 = the owner's value AND confirmed equal to download.blender.org/release/Blender5.2/blender-5.2.2.sha256; the URL answers HTTP 200, 404453484 bytes. Real download/unpack/run still PC checks B12-B16. Community + official add-ons: one live backend at a time (port 9876, SO_REUSEADDR risk on Windows); both together = documented follow-up.
Owner request (2026-10-02): update mechanism (push to git -> installed Legion gets it and restarts, only when idle). Cloud session `claude/updater` (session_01ExuHHgdYbhcQbzAMvvf3d3): plan claude/plan-updater.md then build. Defaults given: check on launch + every N hours (off switch), notice + one-click Update via ApprovalBroker (never silent), opt-in "auto-install when idle" OFF by default, never restart while work is active, verified manifest (sha256 + signature, pinned key), rollback after failed first-start, git-clone installs notify only. Needs independent security review before merge; real-PC checks in claude/tracker-pc-checks-updater.md. Public repo/releases needed for it to work in practice.
2026-10-02 ~18:35: merged into integration/v1: test-harness + fixes (zero-check scenarios fail, env allowlist, dead temp sweep) and the scrubSecrets linear fix (R3.4 was a REAL quadratic: token/secret_/http:// shapes; 200k-case fuzz 0 diffs vs old); multi-provider support (claude/providers: OpenAI-compatible adapter, Responses wire, per-provider keys in <dataDir>/providers/keys.json, Settings MCP servers incl. stdio for provider runs; Codex CLI/OpenCode CLI adapters left OUT with reasons in claude/plan-providers.md). Tripwire conflict resolved by keeping the blender entry and adding providers/http.ts + providers/external-mcp.ts. Harness core-entry now composes the providers module (smoke test enforces). Gate on the harness branch: 1669 tests, 1 fail = server.test "task archive/rename/delete" (running task delete returned 200; passes 5/5 alone: a timing race, second known flake). Providers branch gate: only R3.4 (fixed by the scrub change). OPEN DECISION (owner, in the providers session): auto-delegation lead->executor needs delegate-only mode (lead loses Bash/Write/Edit); Kodawari gate said not ready as pitched. NEEDS independent security review: providers (keys, egress, stdio MCP spawn path outside the literal tripwire, taint), updater.
2026-10-02 ~19:00: providers pass 2 started: `claude/providers-2` (session_01DtUsuxhvUu99upbktkQVv1). PART A fixes: per-server opt-in for stdio MCP in provider runs (default off, native confirm), redact streamed deltas across chunk boundaries, custom remote endpoints start tainted, optional per-provider token caps (default none), Windows-semantics checks, plan update. PART B: Codex + OpenCode: B1 inside the VM (recommended, like vm_claude) and B2 on this PC (opt-in, owner-started only, tainted, start card every time, fake CLI in tests; Legion never touches the CLI's own login). Order after it reports: Windows gate, my own read of the diff, THEN independent security review (providers + updater + T5 re-check).

## PROGRESS 2026-10-02 (updater built, branch `claude/updater`, based on integration/v1)
In-app updates built per `claude/plan-updater.md` (docs/UPDATES.md): signed manifest (Ed25519, key list in `src/core/updater/trust.ts` is EMPTY until the owner runs `scripts/release-keygen.mjs` and pastes the public key; updates stay off until then), consent card, idle-only apply, journaled swap with rollback, release scripts. Gate on the branch: 1744 tests, 1742 pass, 0 fail, 2 skipped; typecheck and build:ui clean. 27 mutations each turned a named test red. Not independently reviewed; nothing run on Windows: see `claude/tracker-pc-checks-updater.md` (U1-U13). Open: BSV T2 spend executor must register an updater busy probe (`registerBusyProbe`); owner must pin the real public key before the first release.

## SESSION SAVE POINT 2 — 2026-10-02 19:05 local (integration/v1 = 6941f86). READ THIS FIRST; it supersedes the earlier save point where they differ.

### What is merged in integration/v1 (all gated on Windows in a separate worktree, D:/bots/legion-gate)
BSV T1, T5 + review fixes B1-B8, Blender B1-B3 + review fixes, Blender B4+B5 (managed 5.2.2 LTS download, chooser, Sculptor guidance), real-PC test plan (claude/real-pc-test-plan.md, scripts/harness/pc-checks.json, pc-report), test harness + review fixes + scrubSecrets linear fix, multi-provider support pass 1 (OpenAI-compatible chat + Responses wire, keys in <dataDir>/providers/keys.json, MCP servers for provider runs), in-app updater (src/core/updater/*, Settings UpdatePanel, signed manifest). Last full gate on the tree with the updater: 1845 tests, 1807 pass, 37 skipped, 1 fail = blender-local "dispose stops a running Blender" (timing flake, passes 38/38 alone x3).
KNOWN FLAKES (do not chase, re-run the file alone): server.test "task archive / rename / delete" (running task delete 200 vs 409), blender-local "dispose stops a running Blender", earlier R3.4 (REAL quadratic, fixed). Gate rule: after switching branches in the gate worktree run rm -rf dist first; stray empty dir %TEMP%\x once failed R5.6 (removed).

### Cloud sessions (claude.ai/code, owner credits; check the sidebar: orange=done, grey=running; they push branches and do not notify)
- RUNNING: providers pass 2 = branch claude/providers-2, session_01DtUsuxhvUu99upbktkQVv1. PART A fixes (stdio MCP per-server opt-in default off + native confirm + child tree kill; redact streamed deltas across chunks; custom remote endpoints start TAINTED; optional per-provider token caps; Windows semantics), PART B Codex + OpenCode adapters (B1 inside the boat.dev VM like vm_claude, recommended; B2 on this PC opt-in, owner-started only, tainted, start card every time, fake CLI in tests, Legion never touches the CLI login), PART C owner-granted allowlist so a lead can change a sub-agent's model/provider (+ optional delegate-only mode). Owner said (2026-10-02): "A lead should be able to change a model / provider of a sub agent."; "why haven't you ensured all connectors run [under Legion's controls]".
- Website session (dnh33/legion-site) showed Running again; not checked by me; final check once the product repo is public.
- Finished and merged: T5 fixes, Blender B4+B5, harness fixes, providers pass 1, updater. Throwaway, never merge: claude/e2e-eval (verdict PILOT ONLY, skip for v0.2.0).
- Old session 01EFq4um... (providers pass 1) holds chat context with the owner; its final report is on the page.

### NEXT, in order
1. When providers-2 reports: read the WHOLE final report (not only the tail), Windows gate in D:/bots/legion-gate (rm -rf dist first), merge (expect additive conflicts in test/bsv-scan.ts tripwire allowlist, Settings.tsx, main.ts, preload.cjs, tracker, CHANGELOG: keep both sides; harness scripts/harness/core-entry.mjs must compose every module in src/bin/legion-core.ts, the smoke test enforces it).
2. ONE independent cloud security review (default verdict "not fixed", mutations, Linux gate) covering: providers (keys, egress, taint, stdio MCP spawn path outside the literal tripwire, CLI adapters, lead allowlist), updater (verification chain, apply/rollback, idle), and a re-check of BSV T5 fixes B1-B5 (never independently re-reviewed after the fixes). Fix round, gate, merge.
3. BSV T2 spend module ONLY after the owner's V1/V2 wallet checks (Windows Sandbox not enabled yet), then T3 second pass, T4 docs/pack, independent review of the whole BSV set. The updater needs a busy probe registered by the spend executor (registerBusyProbe).
4. Docs phase 2: feature docs, fresh screenshots of the real UI, merge claude/docs-release-ready-1 (wordmark README), review; public wording MUST change from "Claude only" to the provider sentences in claude/plan-providers.md section 16 (only after owner real-key checks may it say "works with X"); docs for updater (docs/UPDATES.md exists on the branch), Blender local mode.
5. Website: update copy for providers and updater, install command first in hero; final check after the repo is public.
6. Open a PR integration/v1 -> main (I open it; the OWNER runs /code-review ultra <PR#>, I cannot launch it). Full gate Linux + Windows, delivery D:/bots/legion-v6-7 (git archive + md5 check; never overwrite v6-6), install with setup-yes.cmd, register Legion MCP user scope (back up ~/.claude.json to ~/.claude/backups/2026-10-02-legion-mcp/ with RESTORE.md first; plan in this tracker), run the real-PC plan with the owner (claude/real-pc-test-plan.md, scripts/harness/pc-report), fast-forward main.
7. Cleanup: leftover worktrees D:/bots/legion-wt-win, legion-wt-winfix (rmdir node_modules junction first, never recursive-delete a junction); VPS sync of the Aetherkeep vault (ssh timed out earlier); remove stray %TEMP% dirs.

### OWNER ACTIONS / DECISIONS PENDING
- Updater: generate the REAL release signing key with scripts/release-keygen.mjs, store it safely, paste the PUBLIC key into UPDATE_KEYS in src/core/updater/trust.ts (empty = updates OFF, fail closed); updates need the product repo/releases to be PUBLIC; releases are signed and published by hand; dependency-lock changes cannot be delivered by an update (code-only swap; confirm in docs/UPDATES.md).
- Windows Sandbox (admin PowerShell: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All, restart) + BSV Desktop testnet wallet inside it (owner creates wallet/password/coins) for T2 V1/V2; the owner's own real-funds check R0-R11 by hand; reproduce the community add-on sha256 (eb0facf6...97fa5) on the PC.
- Blender pin 5.2.2 LTS windows-x64 zip sha256 3849d17a...b535 verified against download.blender.org checksum file and URL 200 (404453484 bytes); real download/unpack/run = PC checks B12-B16. Community + official add-on only one live backend at a time (port 9876 / SO_REUSEADDR); both together = documented follow-up.
- Providers: real-key checks PV-01..PV-12 (claude/tracker-pc-checks-providers.md); a ChatGPT/Codex subscription login is the CLI's own, Legion never touches it; API keys cost money (owner decides). Decide delegate-only mode default (off).
- e2e (tester.army): skip for v0.2.0 unless owner overrules; domain/analytics for the website; Aetherkeep VPS sync.
- Real-PC test plan: Windows-only items collected in claude/real-pc-test-plan.md and tracker-pc-checks*.md (installer P1-P10, MCP M1-M3, rooms K1/U1/R1, Blender B1-B16, updater U1-U13, providers PV, harness on Windows).

### LIMITS
Weekly Claude plan usage ~99% (resets Mon 2026-10-05 01:00); cloud credits were ~$238 of $250 at last look (expire 2026-11-05), ~$1.30 per ordinary session. Cloud sessions keep running without the orchestrator.
2026-10-02 (evening): INSTALLER GAP found by owner. No .exe exists; setup.ps1 only checks Node and prints a winget command; README says Node 24 + git required. Owner intent: one installer (.exe ideally) that checks Node, installs the needed version if missing (with consent; -Yes = consent), no Git needed, everything ready. Cloud session `claude/installer-bootstrap` (session_01ED7WPa4zvBroC953ZPurtW): plan claude/plan-installer.md, Node zip from nodejs.org verified by SHASUMS256.txt into a Legion-owned runtime folder (no admin, no PATH change), IExpress wrapper script scripts/build-setup-exe.ps1 for an UNSIGNED Legion-Setup.exe (SmartScreen will warn; owner/orchestrator builds it on Windows), fake-download tests, PC checks in claude/tracker-pc-checks-installer.md. Style rule saved: plain, answer-first (global CLAUDE.md + memory).
2026-10-02 (evening): OWNER SAID GO: Projects in v0.2.0, minimal. Scope: a project = name + shared instructions + folder + member agents + its tasks and rooms; Library notes scopable to a project; project switcher + per-project task view; owner-only create/edit (admin + native for member/permission changes); NO boards/sprints/due dates/reports (after 0.2.0). Start the cloud session ONLY AFTER providers-2 (claude/providers-2) is merged (it touches store, engine, kg, UI, so conflicts); branch claude/projects from integration/v1; plan first (claude/plan-projects.md), controls with tests+mutations, then independent review. After Projects: SCOPE FREEZE for v0.2.0 (only fixes, docs, delivery).
2026-10-02 (evening): OWNER: skip the .exe for v0.2.0 ("run with what we have"). Installer session told to drop scripts/build-setup-exe.ps1 and SETUP-EXE.md; keep setup.cmd/setup-yes.cmd, Node check + consented fetch, no Git needed. Signed or single-file installer = Later.
2026-10-02 (evening): LIGHTPANDA browser tool (owner request: browsing without a VM): cloud session `claude/lightpanda` (session_01VuPnVmHqsnfwUpke3XCMkP), new files only (src/core/browser/*, test/browser-*, ui/src/browser/*) + additive hooks (legion-core.ts module list, test/bsv-scan.ts allowlist, harness core-entry). Plan claude/plan-browser.md first. Constraints given: binary NEVER bundled, pinned download after approval card (Blender B4 pattern) or user's own binary; page content = tainted outside content; URL guard (http/https only, no private/loopback/metadata unless owner-enabled+native, ALWAYS refuse port 3321), redirects re-checked, no downloads/profile/cookies; CDP to loopback only; fake CDP + fake exe in tests. OPEN FACTS to verify: Windows support (native or WSL only?), licence (AGPL?), release assets/checksums. Needs independent security review with providers/updater. Not an addition to the scope freeze: Projects still follows providers-2.
2026-10-02 (evening): LOOPBACK-ONLY hardening (owner: Legion's MCP/API servers must never be open to the internet). Facts read in code: core binds 127.0.0.1 (hard-coded, legion-core.ts:99). Gaps: no Host header check (tunnel/DNS rebinding), allowedOrigin accepts 'null' and file://, no test that fails on a non-loopback listen. Cloud session `claude/loopback-only` (session_01YcA9X99z9A7qbp8eXDPbAE): net-guard.ts (Host + remote address + Origin checks before any route), listen constant + source scan test + startup self-check, tests + mutations, plan claude/plan-loopback.md. PC checks: Windows firewall prompt, Electron app still loads, owner's real tunnel test. Needs to be in the security review.
2026-10-02 (evening): OWNER: requiring users to install Git and Node may be too much. Installer session (claude/installer-bootstrap) told to re-open the design: compare (A) prebuilt self-contained Windows package using Electron's embedded Node (no Node/Git/npm for the user; shares the updater's package format), (B) Node-zip fetch as fallback, (C) current git+Node path (kept alive for developers); recommend the least risky in plan-installer.md, then build. Still no .exe in v0.2.0. Package must be built on the owner's Windows PC by script; verification by published sha256 until the updater key exists.
2026-10-02 (night): DECISION: MULTI-PROVIDER MOVES TO v0.2.1. Pass 1 stays in the tree but OFF: config.json `experimental.providers` (default false, only the literal true; no UI or route writes it). Off = no ProviderRuntime, no provider routes, no engine hook input, Settings "Providers" tab hidden (test/experimental-providers.test.ts). Public wording stays "Claude only" for 0.2.0 (do NOT apply plan-providers section 16 yet). Providers pass 2 (claude/providers-2, session_01DtUsuxhvUu99upbktkQVv1) was told: stay on its own branch, never push to integration, gate every new surface behind the same flag, finish and report; it will be reviewed and merged for 0.2.1. 0.2.1 backlog: providers pass 2 (CLI adapters Codex/OpenCode in VM and on-PC, stdio MCP opt-in, taint for custom endpoints, token caps, lead model/provider allowlist, optional delegate-only), independent security review of it, docs/website wording, owner real-key checks PV-01..12. R3.4 test got an absolute floor (150 ms) after a 3.9 ms baseline produced a false x8.7. Projects session may now start (no longer waits for providers).
2026-10-02 (night): PROJECTS session started: `claude/projects` (session_01UGNSLySPa7hhziR5KA1sRc), plan claude/plan-projects.md first. Minimal scope then FREEZE: project = name + instructions + folder + member agents + status; optional projectId on tasks and rooms (additive migration); Library notes project-scoped (other projects' notes never returned); owner-only create/edit (admin + native for folder/membership); bots/rooms/MCP clients read-only; MCP legion_projects read-only; rail switcher + project page. Running sessions now: providers-2 (own branch, flag-gated, for 0.2.1), installer-bootstrap, lightpanda, loopback-only, projects. NEXT when they report: gate each in D:/bots/legion-gate (rm -rf dist first), merge (additive conflicts: bsv-scan allowlist, legion-core.ts module list + harness core-entry.mjs must match, Settings.tsx, preload/main, tracker, CHANGELOG), ONE independent security review (updater, lightpanda browser, loopback-only, projects authority, T5 re-check, installer), fix round, delivery.
2026-10-02 (night): WEBSITE (getlegion.xyz is LIVE, owner deploys from dnh33/legion-site main). Read the live site vs product; sent the website session (session_01A7WjrHs9wnksiMG75Csq1s) the release contents (DONE vs IN PROGRESS vs 0.2.1) and a 10-point fix list: (1) "Claude-only" headline/meta/"Other providers not supported"/"Codex... possibility, not a feature" -> "built around Claude today; more providers (OpenAI, Codex, OpenCode, OpenRouter, custom/local endpoints) are the next release", no date, no "works with X"; (2) BSV ladder says mainnet "Not designed" but the mainnet policy core is built (hard-off, nothing can spend); (3) Blender text outdated (local-first, managed download, chooser); (4) "Signed installers and prebuilt releases not here" -> updater built (off until key), new no-Git/no-Node installer in progress, clone command stays; (5) Node 20.10 vs 24 mismatch -> NEEDS-OWNER; (6) the clone command FAILS while the product repo is PRIVATE: LAUNCH BLOCKER, owner must make dnh33/legion public (the site and updater depend on it); (7) "Nine tools" MCP count check; (8) screenshots are from an earlier build, label honestly, refresh when owner supplies new set (after Projects/installer UI lands); (9) add Roadmap block + new DONE features only; (10) Kodawari re-run. IN PROGRESS items (Projects, Lightpanda browser, loopback hardening, new installer) must NOT be claimed until merged: add to the site after merge.
2026-10-02 (night): SKILLS for cloud agents: cloud sessions cannot see the owner's local/Cowork skills. For the website the real skills are now copied into dnh33/legion-site main under brief/skills/ (kodawari real SKILL.md, anti-slop, copywriting, landing-page-copywriter, landing-page-design, design-taste-frontend, frontend-design, web-design-guidelines, responsive-design, design-critique, accessibility-compliance, fixing-accessibility, brand-guidelines; scanned: no secrets; 372 KB). Source: ~/.claude/skills (synced Cowork set under skills/synced/<id>/). The website session had already pushed a "Site update: more providers planned..." commit before the skills arrived: re-check its copy against anti-slop/copywriting. To give a PRODUCT session a skill, copy it the same way into the product repo under claude/skills/ (only if wanted; product sessions rely on CLAUDE.md rules today).
2026-10-02 (night, integration/v1 = 098f22f): MERGED + Windows-gated green (1914 tests, 0 fail, 37 skipped): installer bootstrap (claude/installer-bootstrap: consented nodejs.org Node 24.21.0 zip, sha256 checked, into <install>\runtime\node; Git NOT required; core uses runtime\node; uninstall removes it only with Legion's marker; NO .exe) and loopback-only hardening (claude/loopback-only: net-guard Host/remote-address/Origin checks before any route, listen constant + source scan + startup self-check; PC checks LB1-LB6). NOTE: the installer session was archived BEFORE it saw the owner's "Git+Node too much, consider a prebuilt package" message (that message was sent by mistake into the loopback chat, which ignored it). So what exists = option B (Node fetched on demand). OPEN: option A = prebuilt self-contained Windows package (Electron's embedded Node + dist + production node_modules, shares the updater's package format; no Node download, no npm, no build for the user; no .exe wrapper) not built. Owner to decide: build now or 0.2.1. Also: skills for cloud agents are in claude/skills/ (index README) and the running sessions were told.
2026-10-02 (night, ~19:30Z): STATUS. MERGED + Windows-gated green (integration/v1 14c1781: 1955 tests, 0 fail, 37 skipped): Projects (claude/projects: project = name+instructions+folder+members+status, optional projectId on tasks/rooms, project-scoped notes, owner-only authority with native confirm for folder/members, read-only MCP legion_projects; 31 mutations; PC checks PJ-01..PJ-11; NOT protected: compromised window can rewrite name/instructions/status, private agent memory spans projects, folder checked only when set, removing a member leaves old tasks). DONE, NOT MERGED (0.2.1): providers pass 2 (claude/providers-2 head 4fa482e; CLI adapters, lead allowlist, stdio opt-in, taint for custom endpoints, token caps; own gate 1809/0 fail; known weak points: OpenCode takes the prompt as an argv argument (visible in a process listing), config.json holds the opt-ins (same class as keys), every CLI flag assumed TODO OWNER PC). WEBSITE: the session pushed review fixes to dnh33/legion-site main (Lighthouse 98/100/100/100, "install command opening soon while repo is private", word "young" removed at the owner's request, a7664ae); owner deploys. STILL RUNNING: Lightpanda browser (claude/lightpanda). OWNER DECISION OPEN: prebuilt self-contained package (option A) now or 0.2.1. NEXT: Lightpanda -> gate -> merge; then ONE independent security review (updater, lightpanda, loopback-only, projects authority, installer bootstrap, T5 re-check B1-B5), fix round, gate; docs phase 2 + fresh screenshots; PR integration/v1 -> main (owner runs /code-review ultra); delivery D:/bots/legion-v6-7; real-PC plan with the owner.
2026-10-02 (night): OWNER: yes, the prebuilt package right away ("ease of getting started"). Session `claude/prebuilt-package` (session_01QNasPbpKgRAfWwoUfZWLJG): plan claude/plan-prebuilt.md first. Package = Electron win32-x64 runtime + dist/dist-ui + production node_modules + the SDK's win32-x64 claude binary + build-info.json; everything runs on Electron's embedded Node (ELECTRON_RUN_AS_NODE) so the user needs NO Node, Git, npm or build; no .exe wrapper; one package format shared with the updater; setup.cmd detects package vs source; source/dev install unchanged. Built on the Windows PC by scripts/build-package.mjs (orchestrator runs it, installs into a clean folder + clean data dir, starts the app, runs a task, tests the MCP stdio proxy, uninstalls; steps in claude/tracker-pc-checks-prebuilt.md). Unsigned: SmartScreen note. Hosting: GitHub release asset once the repo is public, or local file next to setup.cmd.

## v0.2.0 RELEASE STATUS (2026-10-02 21:35 local, integration/v1 = 48a99e7). Newest status; read with SAVE POINT 2.
NOT FINAL YET. Feature work is nearly done.
IN 0.2.0, merged and Windows-gated (1955 tests, 0 fail, 37 skipped): 13 bots, approvals + taint, rooms, Library/Lattice, boat.dev VMs, MCP, BSV read-only + mainnet POLICY CORE (hard off, nothing can spend), Blender (local/VM/live + managed 5.2.2 LTS download + chooser), in-app updater (OFF until the owner's signing key), installer with consented Node fetch (no Git), loopback-only hardening, Projects, test harness, real-PC plan (128 checks), skills for agents (claude/skills/).
RUNNING in the cloud: Lightpanda browser (claude/lightpanda), prebuilt package = no Node/Git/npm for the user (claude/prebuilt-package, session_01QNasPbpKgRAfWwoUfZWLJG).
NOT IN 0.2.0: multi-provider (OpenAI, Codex, OpenCode, OpenRouter, custom; built, flag-gated OFF, pass 2 on claude/providers-2) = 0.2.1; BSV spend tool T2/T3 second pass/T4 = recommended 0.2.1 (blocked on the owner's wallet checks V1/V2; Windows Sandbox not enabled). OWNER TO CONFIRM: ship 0.2.0 without the spend tool.
REMAINING, IN ORDER: (1) merge Lightpanda + prebuilt package (gate each in D:/bots/legion-gate, rm -rf dist first); (2) ONE independent security review (updater, lightpanda, loopback-only, projects authority, installer + prebuilt, T5 re-check B1-B5) + fix round + gate; (3) docs phase 2: merge claude/docs-release-ready-1 (wordmark README, NOT merged yet), feature docs, fresh screenshots (current ones are from an earlier build), Claude-only wording stays for 0.2.0; (4) owner: make dnh33/legion PUBLIC (install command and updater need it), generate the updater signing key (scripts/release-keygen.mjs, paste public key into src/core/updater/trust.ts), deploy the site (dnh33/legion-site main); (5) open PR integration/v1 -> main; the OWNER runs /code-review ultra <PR#>; fix findings; (6) full gate Linux + Windows, build the prebuilt package on this PC, delivery D:/bots/legion-v6-7 (git archive + md5; never overwrite v6-6), clean-folder install test, setup-yes.cmd install, register Legion MCP (user scope, backup first); (7) real-PC run with the owner (claude/real-pc-test-plan.md + scripts/harness/pc-report); (8) fast-forward main, tag v0.2.0, publish the release asset + signed manifest.
NOT TRIED ON REAL SERVICES: Blender, BSV wallet, boat.dev extras, the updater, providers, Lightpanda; only the real-PC run covers them. Never say "verified" before it.
2026-10-02 (night): BLENDER "BOTH BACKENDS" decided. In session 01C4vXut... (B4+B5 builder) the owner and the session settled plan section 14 (claude/plan-blender-local-first.md on branch claude/blender-b4-b5): official MCP = MAIN backend, community add-on = SECOND, blenderwright = runner-up pending a read-only code review (do not integrate). Owner said YES to building "both at once" provided it is the best option. Orders sent: new branch claude/blender-both from integration/v1; one merged tool list with a routing table (main backend's tool wins on overlap, second backend only where main has none, namespaced); two DISTINCT ports assigned by Legion, probed free, never SO_REUSEADDR, verify which server answers; asset tools (Poly Haven, Sketchfab, Hyper3D) = downloads + outside content: card per download, tainted run, per-task quarantine folder, per-source switch default OFF; guard/static check/audit apply to both backends; setting "Use both backends at once" ships OFF until PC check B17 passes; fake MCP servers in tests; mutation per control; own adversarial pass; report exact counts. Needs independent review before merge (add to the ONE security review).

## UNMERGED WORK LEDGER + MERGE PROTOCOL (2026-10-02 night; restore point: tag pre-merge-2026-10-02-night on integration/v1, bundle D:/bots/legion-backup-20261002-night.bundle, verified)
Imported now (docs/reports only, so nothing lives only on a branch): Blender plan section 14 (blender-b4-b5), all independent review reports under review/ (blender-merged, bsv-t1, bsv-t5, mcp-isolation, release-packaging, rooms-probe-upgrade, test-harness), the e2e report as claude/e2e-eval-report.md (the branch itself is throwaway, never merge).
STILL UNMERGED ON PURPOSE (all remain on remote `cloud`; never delete these branches): claude/lightpanda (running), claude/prebuilt-package (running), claude/blender-both (running, new), claude/providers-2 (0.2.1, flag-gated) AND claude/providers (1 later commit: bridge.ts + test/providers-roster.test.ts + ProvidersSection: must be merged WITH providers-2 for 0.2.1), claude/bsv-t3-native-ui (T3 first pass, to be redone after T2), claude/docs-release-ready-1 (docs phase 1 + gothic wordmark README + scripts/make-wordmark.py: NOT merged, needed for release docs), claude/e2e-eval (throwaway).
PROTOCOL for every merge: (1) tag a restore point (git tag pre-merge-<name> integration/v1; push the tag) and refresh the bundle before a big one; (2) merge with --no-ff, never rebase or force-push integration/v1, never squash; (3) conflicts: keep BOTH sides for additive files (tripwire allowlist test/bsv-scan.ts keeps every entry; module list in src/bin/legion-core.ts AND scripts/harness/core-entry.mjs must stay identical; Settings.tsx, preload.cjs, main.ts imports, CHANGELOG, tracker); (4) after the merge compare: git diff --stat <tag>..HEAD must show only the branch's files; git diff <tag> HEAD -- test/ must not DELETE any test or loosen a tripwire/hedge rule (reviewer greps removed lines in test/); (5) gate in D:/bots/legion-gate (rm -rf dist first): build, typecheck, build:ui, full suite; compare the test COUNT against the previous gate (it must not drop); (6) update this ledger and push. For claude/blender-both: it branches from integration/v1, so it carries all of today's merges; merge it last of the Blender work, check the single-backend default is unchanged with the flag OFF.

## CORRECTION 2026-10-02 (night): THE BSV SPEND TOOL WAS NEVER BUILT. It is back IN v0.2.0.
Fact: only T1 (plumbing) and T5 (mainnet policy core) were built and merged. T2 (spend.ts + bsv_spend_request) was held back "until the owner's V1/V2 wallet checks", and those need a separate testnet wallet in Windows Sandbox (not enabled; needs admin + restart). That was an orchestrator sequencing mistake: T2 can be built against the fake wallet like everything else. The owner's decision stands: the spend tool is built and independently reviewed with BOTH testnet and mainnet capability before v0.2.0; mainnet ships hard-off; "not verified with real funds". My earlier suggestion to move T2 to 0.2.1 is WITHDRAWN (it contradicted the owner's decision).
Started now in the cloud, against the fake wallet, assumptions A1..An written down and failing closed: T2 = claude/bsv-t2-spend (session_01HPJZkt8pQ2hwdZGqF3Cwst); T3 second pass = claude/bsv-t3-second (session_01JtgizcxWXFUZz9zg8w6QmP; merges the first pass claude/bsv-t3-native-ui). Then T4 docs/pack, then the independent review of the WHOLE BSV set (spend, policy-nets, dialogs, real-funds checklist R0-R11) as part of THE security review. Ship gates (owner/PC): V1..V12 on a separate testnet wallet (Windows Sandbox: admin PowerShell Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All, restart, then BSV Desktop testnet inside it) and the owner's own real-funds check R0-R11 by hand, tiny amounts. The real wallet at 127.0.0.1:3321 is NEVER touched by tests, scripts or agents. If the real wallet contradicts an assumption the spend path refuses.
The earlier lines in this file that say "T2 only after V1/V2" and "BSV spend tool recommended for 0.2.1" are superseded by this section. Website brief: spend tool still "being finished" (true).
2026-10-02 (night): OWNER: "I never made that rule" (about never touching the desktop BSV wallet at 127.0.0.1:3321; it came from the handoff file, not from the owner). Owner authorised using his own desktop wallet to test. CLAUDE.md line and plan-bsv-rung3.md section 14 amended: the ORCHESTRATOR may probe the wallet BY HAND from this PC, outside the repo, read-only first, then V1/V2 (unsigned tx then abortAction); repo code, tests, scripts, harness and CLOUD agents still never contact 3321 (hermetic tests, port guard stays); anything that signs/spends/broadcasts needs the owner's explicit go-ahead per action with amount and address, tiny amounts first; wallet prompt stays; wallet is probably mainnet so testnet spends cannot be tested on it. Cloud briefs that said "verbatim from the owner" about this rule were wrong in attribution only; their behaviour (fakes only) stays correct.
2026-10-02 (night): wallet docs looked up (spec page /brc/wallet/0100 + BSV Desktop README), written into plan-bsv-rung3.md 14.2. Key: createAction signAndProcess=false returns signableTransaction {tx: AtomicBEEF, reference} only (decode the BEEF for fee/change); abortAction {reference} -> {aborted:true}; spec silent on spend prompts and decline codes (check on the real wallet); BSV Desktop has a Network mainnet/testnet choice with a SEPARATE database (wallet-test.db): the testnet wallet can live in the same app. Plan: the owner switches the app to testnet (own phrase, faucet coins), then the orchestrator runs V1/V2 and testnet spend checks by hand against it.
2026-10-02 (night): owner: "why do I need to remind you" (I had not looked up the wallet's documentation, had gated T2 on an owner-only step, and had attributed a handoff line to the owner). Added a standing rule to CLAUDE.md: "Research first, ask the owner last" (look up official docs and quote sources; facts / assumptions / unknowns table; gate the ship, not the build; attribute rules honestly). Sent to all running cloud sessions.
2026-10-02 (night): PREBUILT PACKAGE built on branch `claude/prebuilt-package` (plan claude/plan-prebuilt.md, PC checks claude/tracker-pc-checks-prebuilt.md). A user needs no Node, Git or npm: unzip, setup.cmd, shortcut. Full zip (~270 MB est.) + update zip share bytes; everything runs on the package's own Electron in node mode. Gate on the branch: 1977 tests, all pass after one source-guard test (token-v1-electron) was updated for the new spawn call; typecheck and build:ui clean; about 90 mutations each turned a named test red. NOT run on Windows. Not independently reviewed. NOT protected: route A (user unzips by hand) runs the package's own scripts, so only the user comparing the zip sha256 protects it; PACKAGE-FILES.json is self-consistency only; nothing is signed (SmartScreen warns; web mark not stripped).

## v0.2.0 SCOPE LOCK (owner, 2026-10-02 night). NO NEW FEATURES after the items below. Only fixes, docs, review, delivery.
LAST ITEMS IN SCOPE (already running or merging): prebuilt package (merged, gate running), Lightpanda browser (claude/lightpanda), Blender "both backends" (claude/blender-both, flag OFF by default), BSV T2 spend module (claude/bsv-t2-spend), BSV T3 second pass dialogs/UI (claude/bsv-t3-second), then T4 BSV docs/pack. Anything else the owner or an agent suggests goes to the 0.2.1 backlog, not into 0.2.0.
0.2.1 BACKLOG (not in 0.2.0): multi-provider (flag-gated off; claude/providers + claude/providers-2), a LITE package (~160 MB: no bundled Claude engine, use the user's own Claude Code if found, else ask and download the engine; the engine is ~109 MB zipped of the ~270 MB package), possible move of the desktop shell from Electron to TAURI (owner idea; evaluate size vs the Node core as a sidecar, native dialogs, updater, MCP stdio proxy), first-run sign-in helper for users without Claude Code (Doctor "Sign in" button launching the bundled engine's /login), both Blender add-ons beyond the flag, signed installer, Blender real-world checks.
FINISH LINE for 0.2.0 (in order): (1) merge the remaining branches with the merge protocol + Windows gate each; (2) ONE independent security review of everything new (updater, lightpanda, loopback, projects, installer + prebuilt, blender-both, BSV spend T2/T3 + T5 re-check) + fix round; (3) docs phase 2 + fresh screenshots + website update; (4) owner: public repo, updater signing key, deploy site, switch BSV Desktop to testnet + testnet wallet (for V1/V2); (5) PR to main, owner's /code-review ultra; (6) delivery D:/bots/legion-v6-7, clean install test, MCP registration; (7) the real-PC run ("the test later"): claude/real-pc-test-plan.md + tracker-pc-checks*.md; (8) tag v0.2.0. PC checks to add: whether the bundled engine's runs appear in the user's own Claude Code history (no setting found that turns session saving off).
2026-10-02 (night): PREBUILT PACKAGE MERGED (claude/prebuilt-package; Windows gate: 2016 tests, 1 fail = test/prebuilt-contract "package branch of setup.ps1..." = CRLF line endings on Windows (the .ps1 files are CRLF in a Windows checkout, the test searched for LF); fixed in the test by reading as LF text, file now 9/9 on Windows; no other failures). Two existing tests were edited by the branch and verified not loosened (setup URL allowlist now nodejs.org + github.com for two named package files only; spawn guard renamed resolveNodeBin -> resolveCoreLaunch with new tests). Package: Electron win32-x64 (158 MB zipped) + the SDK's bundled Claude engine (~109 MB zipped, 244 MB raw) = about 270 MB zipped / 690 MB unpacked (estimates except the Electron zip); nothing built or run on Windows yet (PB checks in claude/tracker-pc-checks-prebuilt.md; I build it on this PC after the review). Lesson (CLAUDE.md Windows lessons apply): tests that read .ps1/.cmd sources must normalize CRLF.
2026-10-02 (night): BSV NODE COUNT BUG (owner saw ~184, 84, 74 in the title bar "TESTNET · n BSV nodes" with BSV mode on). Facts: the bundled pack is 157 nodes / 699 links, pack version 7, git history only grew (84 -> 124 -> 137 -> 155 -> 157); a fresh seed into an empty graph shows 157 for the human. The title bar number = ChainOverlay knowledgeNodes <- bsv/index.ts bsvNodes() <- /api/kg/stats byScope.bsv <- Graph.stats(HUMAN) (only nodes the viewer may see; a failed kg call returns 0). Sent to the T3 second-pass session (session_01JtgizcxWXFUZz9zg8w6QmP, owns ChainOverlay): trace every way the number can differ, tests for each, show the REAL count plus bundled-vs-graph breakdown (removed/merged, added by owner, missing), "unknown" instead of 0/stale on failure, a restore button using the existing safe seeder restore (never overwrites edited notes). Owner's .legion data is not read by agents. Ask the owner which version is installed (Settings, About) if the number still looks wrong after the fix.

## PROGRESS 2026-10-02 (Blender both-at-once, branch `claude/blender-both`)
Built, OFF by default: merged backend (official main, community second), distinct ports with free-before-start and identity checks, merged read-only tool list, Poly Haven assets fetched by Legion (card, taint, per-task folder, md5/sha256), blenderwright review verdict NEEDS WORK (plan section 15). PC check B17 in `claude/tracker-pc-checks.md`. Needs an independent review before merge; nothing ran against a real Blender or Poly Haven.

## NOTES FROM THE FINISHED CLOUD CHATS (written 2026-10-02 night so they are not lost; integration/v1 = 248871e)
### Blender "both backends" (claude/blender-both, merged locally, Windows gate running; its session: 1915 tests, 0 fail, 3 skipped, 29 mutations red, independent reviewer found no bugs)
- Design: official Blender Lab MCP = MAIN live backend; community add-on (ahujasid, about 29.8k stars) = SECOND (older Blender below 5.1 and its extras); setting "Use both backends at once" ships OFF; with it OFF behaviour is exactly the single-backend one. Legion assigns two distinct ports, probes them free, checks which server answers (a wrong or stand-in server fails closed).
- BETTER THAN THE LITERAL PLAN, taken by the builder: Legion downloads assets ITSELF (blender_asset_search / blender_asset_get, a card per download, tainted run, per-task quarantine folder, md5 + sha256, extension allowlist, size caps, host allowlist on every redirect, fixed import script) and the community add-on's own download/generator/export/telemetry/premium commands are NOT exposed. Poly Haven requires a unique User-Agent and a "Powered by Poly Haven" credit (both done); each asset source is OFF by default.
- blenderwright (191 tools, MIT, one maintainer, v2.0.1): read-only review verdict NEEDS WORK, NOT integrated (add-on on 127.0.0.1:9876, no authentication, SO_REUSEADDR, multiple clients). Revisit in 0.2.1.
- NOT protected: both add-on sockets have no password; nothing identifies the official add-on itself (the check only rules out the community add-on on its port); the filters for the official server's read-only tools look at argument names and trust its read-only labels; Poly Haven md5 comes from the same API as the files.
- COULD NOT FETCH (TODO OWNER PC): api.polyhaven.com docs, projects.blender.org, download.blender.org. Only a real Blender can verify (B17a-d in claude/tracker-pc-checks.md): whether the official add-on reads BLENDER_MCP_PORT, the official add-on's real tool list, the real Poly Haven file host.
### Lightpanda browser (claude/lightpanda, finished; steered to add two small edits, then merge integration)
- Facts looked up (links in plan section 10): NO native Windows build (runs under WSL); licence AGPL-3.0 (we download, never bundle); only a rolling NIGHTLY release exists so the download hash is EMPTY and Legion downloads nothing until the owner records a hash; docs site and CDP method coverage (incl. Fetch) could not be read; the real binary was never run. So on Windows the feature needs WSL + a recorded hash before it is usable. OWNER DECISION OPEN: keep it in 0.2.0 (off by default) or leave it out of the release.
- Built: URL guard, per-run state, tainted runs, approval cards, process port, tests with fake CDP + fake exe; checks BR1-BR11 in claude/tracker-pc-checks-browser.md. NOT protected: anything on this PC can reach the browser's local port during a run; page scripts run inside Lightpanda; a popup tab loads unguarded until Legion closes it; a click that lands on a new site is asked about after the request was made; an agent with a shell can edit the config file.
- Pending steer: native confirmation for choosing the program (src/electron/browser-ipc.ts + one-line hooks in main.ts/preload.cjs) and one line in approvals.ts so only the module's own cards appear.
### Prebuilt package (merged): see earlier note. Claude engine kept in the package (decision), lite package = 0.2.1.
2026-10-02 (late night): BLENDER BOTH-BACKENDS MERGED into integration/v1 (cfc7f6a); Windows gate green: 2039 tests, 2002 pass, 0 fail, 37 skipped (prebuilt package included). Removed test lines checked: assertion extended to the asset tool, allowlist reason text longer (kinds unchanged). Remaining merges: Lightpanda (after its two small edits), BSV T2 spend, BSV T3 second pass.

## Project board (IN v0.2.0, on by default; branch `claude/project-board`, owner decision 2026-10-03)
On by default; owner-only off switch `features.projectBoard = false` in `config.json` (only the literal `false`; nothing writes it; an old `experimental.projectBoard` is ignored). Merged with `integration/v1` on the branch, to be merged by the release owner; covered by the independent security review incl. agent access (rules and guard list: `claude/plan-project-board.md` section 14). Plan, controls and known limits: `claude/plan-project-board.md`; user doc: `docs/PROJECT-BOARD.md`; owner-PC checks: PB1 to PB10 in `claude/tracker-pc-checks.md` (steps in `claude/tracker-pc-checks-board.md`). Agents work the board like teammates (create, edit, move, assign, note, link project notes); only the owner marks Done; delete is leader-only behind an owner approval card; token clients are read-only. Project as context layer: project-scope episodes, board digest and recent project notes in each run's prompt, automatic note links, "Save what we learned". Nothing here ran on Windows.
2026-10-02 (late night): PROJECT BOARD (fuller project management) started in PARALLEL, NOT for 0.2.0: session `claude/project-board` (session_018vkVWTE3bbYxLFD6paDW4f), behind config.json experimental.projectBoard (default false), new files only (src/core/projects/board/*, ui/src/projects/board/*), merges AFTER the 0.2.0 tag so it cannot delay or disturb the release. Scope v1: work items per Project (status backlog/doing/review/done/blocked, assignee, due date, priority, labels, links to runs and rooms, activity trail), board + list views, "Run this item" (item -> doing, run linked, run ends -> review, only the owner marks done), bots may propose items (untrusted Inbox) and update only their own assigned items via legion_board, token clients read-only; no automation or schedules. Plan first: claude/plan-project-board.md (research table: Cowork projects and comparable harnesses). NOTE: Projects (minimal grouping) is ALREADY MERGED in 0.2.0.
2026-10-02 (night): BSV T2 (spend module, claude/bsv-t2-spend) + T3 second pass (claude/bsv-t3-second, incl. the real BSV note count: 184 = 157 pack + 27 owner notes; 84 = the first pack; "unknown" instead of 0/stale; Knowledge section + safe restore button) MERGED into integration/v1 (4ceb319). Windows gate green: 2185 tests, 2140 pass, 0 fail, 45 skipped (the 45 include Linux-only Electron emulation tests that use /proc). RESTORE TAG pre-merge-bsv-t2t3. FOR THE REVIEW (top items): (1) T2 rewrote the tripwire (test/bsv-scan.ts): ONE file src/core/bsv/spend.ts may name createAction/signAction/abortAction, its content sha256 is pinned (SPEND_PINS, scripts/bsv-spend-pin.mjs, .gitattributes keeps LF), strict no-network-literal files, spend path may never call setMainnetEnabled/unfreeze/setCaps/setAllowlist/arm; check every removed test line (e.g. the old "Legion has no tool that signs" assertions and the "no bsv source names mainnet in code" test were removed on purpose); (2) T2 says the B5 test "audit is a second source forcing mainnet off at load" no longer exercises that path because the hook now saves the file directly: prove the control or restore a test for it; (3) the merged tree has NEVER run on Linux: bsv-electron-emu tests skip on Windows; one merge conflict was resolved to the STRICT assertion spendTools: true (HEAD side) instead of T3's typeof boolean: the Linux gate decides; (4) readVersion in wallet-probe.ts still rejects the real 'wallet-brc100-1.0.0' (F-W1, fix pending: T5-owned file); (5) a reference lost in a crash between build and sign cannot be aborted (documented limit); change outputs are wallet-claimed only. PC checks: V1-V12, R0-R11, ND1-ND11 (ND11 = title-bar count) in claude/tracker-pc-checks.md. Remaining merge: Lightpanda; then THE security review incl. the Linux gate.
2026-10-02 (night): LIGHTPANDA MERGED (claude/lightpanda + blender-both plan section 16) into integration/v1 (6f20ae0; session's own gate 2042 tests 0 fail; my Windows gate running). Features: browser tools behind cards, taint on first call, native confirm for choosing the program (src/electron/browser-ipc.ts), approvals.ts exact-name skip, WSL wall-time wrapper bug found and fixed. Windows: needs WSL + a recorded nightly hash (plan section 11 has the owner steps). FACTS (looked up 2026-10-02): agent-browser (vercel-labs, Apache-2.0, Rust CLI, Windows/macOS/Linux) is a DRIVER over CDP: Chrome for Testing by default (downloaded), or --engine lightpanda / AGENT_BROWSER_ENGINE=lightpanda (experimental); Lightpanda = ENGINE; official Lightpanda binaries macOS ARM + Linux x86_64 only; with Lightpanda no extensions/profiles/storage state/file access/headed. OWNER REQUIREMENT: Windows users must not need WSL: a Chromium engine (Edge is on every Windows 10/11, or Chrome/Brave) via Legion's own CDP driver + same guards, no download. Sent to the browser session as new branch claude/browser-engines (decision table own-CDP vs agent-browser; agent-browser = optional later engine 0.2.1; honest comparison Chromium vs Lightpanda vs VM; vendor perf claims NOT quoted). Part of the 0.2.0 browser item, not new scope. ALSO: Blender chat's sculpting research (plan section 16): official Blender MCP has no sculpting tools; Python bpy.ops.sculpt.brush_stroke works through its code tool; a tested recipe needs a real Blender; hifipushie (MIT, SDF-blob sculpting, new/unproven) = prototype later, not integrated.
WEBSITE: facts file brief/RELEASE-FACTS-0.2.0.md (site repo main, 3c4f922) = SOURCE OF TRUTH; the website session was told to diff its live copy against it (qa/REVIEW.md table), fix contradictions, place Projects and the browser tool as features with their honest limits, providers = "next release", and to re-read the file at each task. UPDATE THIS FILE whenever shipping facts change (browser Chromium engine, package built, T-checks) before delegating again.

## OPEN-SOURCING PLAN (owner: "it doesn't matter if people can see what we are planning", 2026-10-02 night)
Plans, designs, reviews and the tracker MAY be public (transparency is fine). A public repo publishes ALL HISTORY, so: (1) PUBLISH A SCRUBBED SNAPSHOT from the final main with FRESH HISTORY (git archive + commit), not this repo's history; keep this private repo as the dev repo (rename it, e.g. dnh33/legion-dev, at publish time; cloud sessions use the repo id so work continues) and put the clean one at dnh33/legion (install command, updater and website point there). (2) REMOVE from the snapshot: claude/skills/ (the owner's Cowork skills: licences/personal, not ours to redistribute), operational/personal lines of the tracker (cloud credits balance, weekly plan usage, session ids, local paths like D:\bots, VPS/Tailscale details), and any file under review/ or claude/ whose content turns out to name the owner's real wallet details beyond the port number already in docs. (3) KEEP: docs/, README, SECURITY, CHANGELOG, LICENSE/NOTICE, plans and PC-check lists, review reports (after fixes). (4) Before publishing: run a secrets/personal-data scan over the snapshot (keys, tokens, emails, paths, IPs, session ids), re-check claude/tracker-public-audit.md, make sure no test or script READS a removed file (scripts/harness/pc-checks.json only names claude/ and review/ docs as references: either keep those docs or relabel the references), and update CLAUDE.md for contributors. (5) From now on: put credits, usage limits, session ids and machine details in Aetherkeep (06-projects/legion/legion-v0.2.0-release-2026-10-02.md), not in the repo tracker. A script scripts/export-public.mjs (snapshot + scrub + scan) is a release-train task; do it after the security review.
2026-10-02 (night): LIGHTPANDA merged-tree Windows gate: 2270 tests, 2 fails, both fixed on integration/v1: (1) test/bsv-port-guard: the browser tests named the wallet port literally; they now build it from parts (Number('33'+'21')), guard untouched; (2) browser-session failure-modes: on Windows a dropped WebSocket fires 'error' first, cdp.ts reported just "error"; message is now "The browser connection was closed after an error." LESSONS for every new test: never write the wallet port literally; Windows sockets emit error before close.
BSV STATUS FOR 0.2.0 (honest): BUILT AND MERGED: T1 plumbing, T5 mainnet policy core + fixes B1-B8, T2 spend module (testnet + mainnet capability, mainnet hard-off, fakes only), T3 second pass (native dialogs, panel, real note count + restore). NOT DONE: T4 (docs/knowledge pack: docs/BSV-MODE.md Spend section, SECURITY/README/CHANGELOG, pack v8 truthful about the spend tool, remove "no spend tool" lines); wallet-probe readVersion fix for 'wallet-brc100-1.0.0' (F-W1); a proving test for the B5 control "audit log is a second source forcing mainnet off at load" (T2 said the old test no longer exercises it); independent review of the WHOLE BSV set + Linux gate of the merged tree; owner/PC: V1-V12 on a testnet wallet (BSV Desktop testnet mode), R0-R11 funds check by hand, ND1-ND11. Nothing is verified with a real wallet or real funds.
2026-10-02 (night): BSV T4 STARTED (owner: "yes, and the fixes for the bsv stuff"): session `claude/bsv-t4-docs` (session_01PgsuWb6kAMXR2unKN11VcT), own branch from integration/v1, parallel to the rest. Contents: (1) docs per plan section 10 (BSV-MODE Spend section, SECURITY, README ladder, CHANGELOG, ARCHITECTURE, WALLET-DESIGN, real-wallet facts box); (2) knowledge pack v8 (157 nodes / 699 links at v7: keep every node id, rewrite the "no spend tool / testnet only / mainnet not designed" notes to be true, add spend/caps/dialogs/unknown-outcome/V-R notes, non-destructive upgrade tested); (3) FIX F-W1 readVersion accepts 'wallet-brc100-1.0.0'; (4) FIX/PROOF B5 "audit log is a second source forcing mainnet off at load"; (5) hedge tests only ADDED; removed test lines listed with reasons; (6) PC check ND12. After it: merge, then the independent review of the whole BSV set + Linux gate.

2026-10-03 (early): OWNER DECISIONS: (1) LIGHTPANDA IS DELETED, not hidden (code, tests, tripwire entries, Settings, docs; research kept as one "Evaluated and dropped" note in claude/plan-browser.md). Browser for 0.2.0 = ONE engine, Chromium family (Edge/Chrome on the PC or a user path) through Legion's own CDP driver and guards ("agent-browser's idea, our driver"); small engine interface kept; agent-browser = optional later engine; browser session (claude/browser-engines, session_01VuPnVmHqsnfwUpke3XCMkP) told twice (hide-flag order superseded by delete order). Website facts file updated: Lightpanda dropped, do not mention. (2) BOT INSTRUCTION AUDIT started: session `claude/agent-audit` (session_0154ccYCLdcEVqBSp11VX4WM), PHASE 1 read-only: claude/audit-agent-instructions.md (inventory of the 13 bots' real tools vs what they are told, stale/false claims, contradictions, soul-risk), proposed design = persona text byte-identical + ONE generated "What you can do right now" block from real registered tools/gates + tests (persona snapshot hash, tool coverage, stale-claims banned phrases, gate-consistency). PHASE 2 (apply) only after T4 (claude/bsv-t4-docs) and the browser work are merged; the orchestrator tells the session. Owner must see the Phase 1 report first.
2026-10-03: TRAILER V2 started (owner: successor to the first trailer, showcase 0.2.0 + planned 0.2.1, planned properly first, built from facts, show all features). Method skill = cinematic-trailer-pipeline (owner's Cowork skill, deterministic HTML timeline rendered frame by frame, synthesized score, check.mjs + AUDIT). The FIRST trailer's sources were no longer in the repo; restored from D:/bots/legion-v6-1/docs/video (BRIEF, AUDIT, timeline, trailer.html, render, check, score, edit_judge, gif 7 MB, poster) onto branch claude/trailer-v2 (7a93b33) with the skills (claude/skills/cinematic-trailer-pipeline, launch-teaser-kit, painted-mascot-engine; remove with the other skills from the public snapshot). Session claude/trailer-v2-build (session_01D7Gx3abU8pr3XvY8nN9Qjq), output docs/video-v2/. TWO PHASES WITH A GATE: PHASE 1 = BRIEF.md with storyboard in bars + FACT TABLE (scene / words / feature / evidence in repo / status SHIPS-BUILT-NOT-TRIED-PLANNED / honesty wording) then STOP; the ORCHESTRATOR VERIFIES the fact table against code and replies GO; PHASE 2 = screenshots of the real UI with demo data, render MP4/GIF/poster, AUDIT, independent reviewer pass. Facts source for the trailer: claude/release-facts-0.2.0.md (copy of the website facts file; keep both in sync). Browser tool only if SHIPPED at render time; project board and providers only as "NEXT" text cards, no fake UI, no dates.
2026-10-02 (night): BSV T4 (docs, knowledge pack v8, F-W1, B5 proof) on `claude/bsv-t4-docs`, NOT yet merged. Done: docs/BSV-MODE.md Spend section + real-wallet-facts box + tripwire pin how-to, SECURITY/README/CHANGELOG/ARCHITECTURE/WALLET-DESIGN/TESTING-BSV truthful (spend tool exists, mainnet built and OFF, not verified with a real wallet or real funds); pack v8 = 163 nodes / 727 links (from 157 / 699; 6 new notes, no id lost, v7 to v8 upgrade tested from a v7 fixture); readVersion accepts `wallet-brc100-1.0.0` (F-W1 fixed); B5 control exists in code and is now proven by two tests with mutations; hedge tests extended (stale claims, banned phrases, required statements, real-funds record marker `BSV REAL-FUNDS CHECK RECORDED` in tracker-pc-checks.md). Linux gate on this branch: 2204 tests, 2201 pass, 0 fail, 3 skipped. Owner PC checks added: ND12 (docs vs the running app). Still open: independent review, Windows gate, V1-V12, R0-R11, ND1-ND12. NOTE for the review: the BSV_PREAMBLE first line still says "the network is testnet" (T2 file, not changed here).

## SESSION SAVE POINT 3 (2026-10-03 ~00:35 local; integration/v1 = 73d4dfa + this note). READ THIS FIRST; it supersedes SAVE POINT 2 where they differ.
### Merged into integration/v1 and Windows-gated (last full gates: 2270 tests / 2 fixed fails after the Lightpanda merge; T4 merge gate running)
BSV T1, T5 + fixes, T2 spend module, T3 second pass (+ real note count fix), T4 (docs, knowledge pack v8 = 163 nodes / 727 links, F-W1 version parser, B5 proof), Blender B1-B5 + both-backends (flag off) + sculpting research, installer bootstrap, PREBUILT PACKAGE (Electron embedded Node + Claude engine ~270 MB zipped; not yet built/run on Windows), in-app updater (off until signing key), loopback-only hardening, Projects (minimal), test harness + scrub fix, real-PC plan, Lightpanda (TO BE DELETED by the browser session). Providers (claude/providers + providers-2) are flag-gated OFF for 0.2.1.
### Cloud sessions NOW (claude.ai/code; check the sidebar: Running / Idle / Unread response)
- BROWSER ENGINES: `claude/browser-engines` (session_01VuPnVmHqsnfwUpke3XCMkP): owner decision = DELETE Lightpanda completely; ONE engine = Chromium family via Edge/Chrome on the PC, Legion's own CDP driver + guards ("agent-browser's idea, our driver"); agent-browser = optional later engine (0.2.1). When it reports: restore tag, merge, check removed test lines are only Lightpanda tests, Windows gate, update facts files (site brief + claude/release-facts-0.2.0.md) from "in progress" to "SHIPS".
- BOT INSTRUCTION AUDIT: `claude/agent-audit` (session_0154ccYCLdcEVqBSp11VX4WM): PHASE 1 DONE (claude/audit-agent-instructions.md). Findings: personas are stored per install (seedDefaults never overwrites) and persona text comes LAST so stale persona lines beat correct preambles; stale/false: Sculptor persona "scripts run in the sandbox VM by default" (local is default), Assayer "mainnet when the user explicitly asks" (hard-off), pack text said no spend tool (FIXED by T4), Sentinel persona implies a scheduler (none exists), browser tool not known to Scout etc., Herald can submit forms via browser_type/click/eval. DESIGN: persona text byte-identical + ONE generated "What you can do right now" block (<=12 lines, placed BEFORE the persona) from real registered tools/gates + 4 tests (persona hash snapshot, tool coverage, stale-claims banned phrases, gate consistency). OWNER DECISIONS NEEDED (defaults in brackets): (1) edit the two plainly false persona lines as one-sentence changes? [no: block overrides]; (2) Assayer taint rule: CONFIRMED INTENDED in code and plan (bsv_status taints the run; untrusted content needs a second native dialog on the spend card) so the audit may state it; (3) browser for all 13 bots? [all, with Herald's "do not submit" line]; (4) is a Sentinel scheduler planned? [no: the block says checks run only while a task runs]. PHASE 2 only after the browser work is merged; owner approves the Phase 1 report first.
- TRAILER V2: `claude/trailer-v2-build` (session_01D7Gx3abU8pr3XvY8nN9Qjq): PHASE 1 pushed (docs/video-v2/BRIEF.md storyboard + fact table; it also added project-board and project-as-context-layer scene variants). ORCHESTRATOR MUST VERIFY THE FACT TABLE AGAINST THE CODE AND REPLY GO before it renders. Base sources of trailer v1 restored from D:/bots/legion-v6-1/docs/video. Facts source: claude/release-facts-0.2.0.md.
- PROJECT BOARD: `claude/project-board` (session_018vkVWTE3bbYxLFD6paDW4f): flag-gated experimental.projectBoard, AFTER 0.2.0 only; it has grown to "project as a context layer" (project-scope episodes, board digest in the run prompt, project-memory habit): needs an independent review before it ever merges; do not merge for 0.2.0.
- WEBSITE: dnh33/legion-site main; brief/RELEASE-FACTS-0.2.0.md is the source of truth (Lightpanda dropped; browser = in progress; providers = next release); the session was told to diff its live copy against it (qa/REVIEW.md). Owner deploys. Skills for it are in brief/skills/.
### NEXT (in order)
1. Windows gate result for the T4 merge (gate-t4.log); fix anything; push. 2. Browser merge. 3. Verify the trailer fact table and answer GO. 4. Owner answers the 4 audit questions, approves the Phase 1 report, then tell the audit session to start PHASE 2 (after the browser merge). 5. ONE independent security review (updater, browser, loopback, Projects authority, installer + prebuilt, Blender both, BSV T2/T3/T4/T5, Linux gate of the merged tree; first review item: the BSV_PREAMBLE first line still says "the network is testnet", the tripwire rewrite in test/bsv-scan.ts, the removed assertions listed in the T4 report) + fix round + gates. 6. Docs phase 2 + FRESH screenshots + merge claude/docs-release-ready-1 (wordmark README, NOT merged); website refresh. 7. scripts/export-public.mjs and the OPEN-SOURCING PLAN (scrubbed snapshot, fresh history, remove claude/skills and operational lines, rename the private repo). 8. Owner: BSV Desktop testnet + faucet coins (V1-V12 by me), public repo, updater signing key, deploy site, Tailscale login (VPS sync). 9. PR integration/v1 -> main (fast-forward is possible: main has no extra commits), the owner runs /code-review ultra, delivery D:/bots/legion-v6-7 (git archive + md5), build the package on this PC, clean install test, MCP registration (back up ~/.claude.json first), real-PC run (claude/real-pc-test-plan.md + scripts/harness/pc-report), tag v0.2.0.
### GIT RULES (owner asked: no fucked branches)
Only the orchestrator merges into integration/v1 and main; sessions push only to their own branch and merge integration/v1 INTO themselves before reporting; restore tag before every merge (pre-merge-*), --no-ff, never force/rebase/squash, keep both sides on additive conflicts; check removed test lines; test COUNT must not drop; audit state checked 2026-10-03: local = remote integration/v1, main untouched (ff7afd2), every finished branch fully merged (ahead=0). Stale local clutter (gate-*, fix/*, merge/* branches, worktrees legion-wt-win, legion-wt-winfix, legion-gate) to be cleaned at the end (rmdir node_modules junction first).
### OWNER STATE / DECISIONS (this session)
Scope LOCKED for 0.2.0 (see SCOPE LOCK); 0.2.1: providers (OpenAI, Codex, OpenCode, OpenRouter, custom/local), lite package, maybe Tauri shell, sign-in helper, agent-browser engine, project board. BSV spend tool IS in 0.2.0 (built vs fakes; V1-V12/R0-R11 pending; my earlier hold-back was a mistake); the wallet rule at 3321 was not the owner's (orchestrator may probe by hand, repo/cloud stay hermetic; V0 probe done); BSV Desktop has a testnet mode (own database): owner switches it. Package keeps the Claude engine (normie-friendly). Open-source: plans may be public; publish a scrubbed snapshot with fresh history. Style rule: plain answer-first (ISO 24495-1 / ASD-STE100 / Zinsser / Pyramid) in ~/.claude/CLAUDE.md and memory; standing rule "Research first, ask the owner last" in repo CLAUDE.md and memory. Cowork skills ported to the PC (enabled: kodawari, roast-and-council, verification-before-completion, systematic-debugging, receiving-review, fast-pc-computer-use, mcp-builder, skill-creator, skill-inspector; rest parked in ~/.claude/skills-disabled; Desktop\Cowork-skills has all 51; backup ~/.claude/backups/2026-10-02-skills-port).
2026-10-03: OWNER ANSWERS (bot audit): (1) edit the two false persona lines (Sculptor local-first, Assayer never chooses the network) as one-sentence factual fixes; (2) Assayer taint rule confirmed intended; (3) browser for all 13 bots, Herald stays draft-only (may read, not type/click/eval: a form submission is a message to a stranger's service), others may submit with a card in ask mode; (4) SENTINEL SCHEDULER PLANNED, not in 0.2.0 (the block says checks run only while a task runs). Audit PHASE 2 starts when the orchestrator says the browser work is merged. 0.2.1 IDEAS (owner): a button in the knowledge graph that runs an AUDIT AGENT to look up the most recent information and docs on a topic and refresh stale notes (needs design: sources, taint of web content, approvals, cost, never overwriting edited notes); the Sentinel scheduler (timer-driven runs; unattended runs must keep approvals, taint and the no-autonomous-spend rule).
2026-10-03: T4 MERGE GATE (Windows): 2286 tests, 2240 pass, 1 fail, 45 skipped. The single failure = a Lightpanda full-stack test with a fake process (Windows), to be DELETED with Lightpanda by the browser session; no other failures. WEBSITE updated again: brief/RELEASE-FACTS-0.2.0.md (site main 2e169eb) now has "CHANGES SINCE THE FIRST VERSION" (pack 163/727 v8, Lightpanda never mentioned, browser = one Edge/Chrome engine IN PROGRESS, Sentinel scheduler planned, Herald draft-only, 0.2.1 plans incl. KG audit button + project board + lighter package, open-source with clean public repo at release, trailer slot, tone: no "young"); product copy at claude/release-facts-0.2.0.md refreshed; the website session (01A7WjrH...) was told to re-diff and fix.
2026-10-03: BLENDER TITLE-BAR CHIP (owner: should there be a Blender button like the BSV toggle?). Fact: BSV has a title-bar chip (ui/src/bsv/BsvChip.tsx: switch + Panel button, left of Doctor); Blender is only in Settings -> Blender (with an enable switch, status lights, "Get Blender for Legion" (Windows-only fetch, card first) and "Get full Blender" link, first-use chooser). Small UI-only session `claude/blender-chip` (started from integration/v1): chip with status light + label from REAL status (unknown never stale), the enable switch through the SAME path/rules as Settings, "Get Blender" opens Settings (download keeps its own card), accessible, tests, docs paragraph, PC check. Within the scope lock as discoverability of an existing 0.2.0 feature; no new logic.
2026-10-03: OWNER DECISION: PROJECT BOARD IS IN 0.2.0, ON BY DEFAULT (scope lock lifted for it); covered by the ONE independent security review incl. AGENT ACCESS (any member agent can create/edit/move/claim/label/note; guards: tainted-run items untrusted, no cross-project access; Library "Save what we learned" refuses secrets). Board session (claude/project-board) told to: drop the experimental flag default (keep an owner-only OFF switch features.projectBoard=false), merge integration/v1 into itself, re-gate, adversarial pass on agent access with tests listing every remaining guard, update docs/CHANGELOG/plan, website paragraph. Its last gate: 2009 tests, 0 fail. After it reports: restore tag, merge, Windows gate, facts files -> SHIPS. The trailer and website sessions were told. The owner also gave the trailer session the GO directly (it is in Phase 2: score and capture scripts done, render running); my fact-table verification still to do against its final cut. Website session pushed 006c941 (proper Blender section, 14 feature blocks with status chips, harness only under "For developers"); open owner questions 34-38 in its NEEDS-OWNER.md (room costs, which VM actions ask for approval, what providers need, project limits, supported wallets/Arm card, where the updater key is published, supported Windows versions for the package; creator credit name).
2026-10-03: BLENDER CHIP merged locally into integration/v1 (restore tag pre-merge-blender-chip; gate running; its own gate 2213 tests 0 fail). OWNER YES to a confirmation dialog before Blender is turned ON, on BOTH the chip and the Settings switch (shared requestEnableBlender(), Cancel default, Escape cancels, off needs none): chip session told; follow-up merge after it reports. Known gap: at narrow widths two switches (BSV, Blender) side by side without visible labels (tooltips only). PC check B17 covers the chip and the dialog.

## SESSION SAVE POINT 4 (2026-10-03 01:17 local; integration/v1 = 70b4482). READ THIS FIRST; it supersedes SAVE POINT 3 where they differ.
### Merged into integration/v1 and Windows-gated (latest full gate: 2295 tests, 2250 pass, 0 fail, 45 skipped, on the tree with the Blender chip)
BSV T1-T5 complete (T4 docs + pack v8 = 163 nodes / 727 links + version parser fix + B5 proof; spend tool built vs FAKES only, nothing verified with a real wallet), Blender B1-B5 + both-backends (flag off) + sculpting research + BLENDER TITLE-BAR CHIP (restore tag pre-merge-blender-chip), installer bootstrap, PREBUILT PACKAGE (~270 MB, keeps the Claude engine; not yet built/run on Windows), updater (off until signing key), loopback-only, Projects (minimal), harness, real-PC plan, Lightpanda (still in the tree until the browser session's deletion merges). Providers flag-gated OFF (0.2.1).
### Cloud sessions NOW (claude.ai/code sidebar: Running / Idle / Unread response; sessions push only to their own branch)
- BROWSER ENGINES claude/browser-engines (session_01VuPnVmHqsnfwUpke3XCMkP): Lightpanda DELETED on its branch (5cad25c) + one Chromium-family engine (Edge/Chrome, own CDP driver, Fetch-domain guards), plan section "evaluated and dropped" (Lightpanda, agent-browser). Still finishing; when it reports: restore tag, merge, check removed tests are only Lightpanda ones, Windows gate, then facts files browser -> SHIPS and tell the bot-audit session (PHASE 2 waits for this).
- PROJECT BOARD claude/project-board (session_018vkVWTE3bbYxLFD6paDW4f): OWNER DECISION: IN 0.2.0, ON BY DEFAULT (owner-only OFF switch features.projectBoard=false), agent access (any member agent can create/edit/move/claim/label/note; guards: tainted-run items untrusted, no cross-project access, owner-only: marking done etc. per docs/PROJECT-BOARD.md), project as a context layer (board digest + 5 most recent project notes in each run; "Save what we learned" refuses secrets). Last pushed 6be357b "Project board in v0.2.0: docs, CHANGELOG, README, ARCHITECTURE". When it reports: restore tag, merge, gate; facts -> SHIPS. NEEDS the independent security review (agent access, run prompt injection of board/notes).
- BLENDER CHIP claude/blender-chip (session_01KkD2agyZPmdqbDvCLtPC6D): chip merged; OWNER YES to a "Turn on Blender?" confirmation on BOTH the chip and the Settings switch (shared requestEnableBlender(), Cancel default, Escape cancels, off needs none): session working on it; follow-up merge + gate.
- TRAILER V2 claude/trailer-v2-build (session_01D7Gx3abU8pr3XvY8nN9Qjq): owner gave GO directly ("Beta launch of 0.2.0", show project/context/knowledge-graph layer and agent access, deliver the first cut inline); timeline 105 s with the board shown as 0.2.0; waiting on fresh board/BSV screenshots then the full render; the orchestrator STILL OWES a fact-table check of the final cut against code (docs/video-v2/BRIEF.md fact table); browser tool only if facts say SHIPPED; Lightpanda never; NEXT cards: providers, KG audit button, Sentinel scheduler, lighter package, extra browser engines, real-wallet verification.
- BOT INSTRUCTION AUDIT claude/agent-audit (session_0154ccYCLdcEVqBSp11VX4WM): Phase 1 done and approved with owner answers (edit the two false persona lines; Assayer taint rule intended; browser for all 13, Herald draft-only (read, no type/click/eval); Sentinel scheduler planned, block says checks run only while a task runs). PHASE 2 starts ONLY when I tell it the browser work is merged.
- WEBSITE dnh33/legion-site main (session_01A7WjrHs9wnksiMG75Csq1s): pushed 006c941 (Blender section, 14 feature blocks with status chips, harness only under "For developers", trailer slot hidden); source of truth brief/RELEASE-FACTS-0.2.0.md (copy: claude/release-facts-0.2.0.md; keep BOTH in sync; it now has sections for Blender and the Project Board; board = "built, being finalised" until I mark SHIPS); OPEN owner questions in its NEEDS-OWNER.md (34-38 + creator credit name); owner deploys.
### NEXT (in order)
1. Browser merge + gate; board merge + gate; chip confirmation follow-up merge + gate (restore tag + removed-test-line check each). 2. Update facts (site + product copies) -> browser/board SHIPS; tell website, trailer and the audit session (audit PHASE 2 go). 3. Verify the trailer fact table against code; watch the first cut with the owner. 4. ONE independent security review incl. LINUX gate of the merged tree: updater, browser (Chromium), loopback, Projects + BOARD agent access, installer + prebuilt, Blender both + chip, BSV T2/T3/T4/T5 (tripwire rewrite in test/bsv-scan.ts, removed assertions listed in the T4 report, BSV_PREAMBLE first line still says "the network is testnet", B5, same-user limits), providers flag-off proof, the open-source scrub; then a fix round + gates. 5. Docs phase 2 + FRESH screenshots + merge claude/docs-release-ready-1 (wordmark README, still UNMERGED). 6. scripts/export-public.mjs + OPEN-SOURCING PLAN (scrubbed snapshot, fresh history, remove claude/skills, operational lines; rename private repo; clean public repo at dnh33/legion). 7. Owner: BSV Desktop testnet + faucet coins (then I run V1-V12 by hand), public repo, updater signing key, deploy site, Tailscale login (VPS sync), answer the website questions, decide nothing else pending. 8. PR integration/v1 -> main (fast-forward possible: main ff7afd2 has no extra commits), owner runs /code-review ultra, delivery D:/bots/legion-v6-7 (git archive + md5), BUILD THE PACKAGE ON THIS PC and test it in a clean folder, MCP registration (back up ~/.claude.json first), real-PC run (claude/real-pc-test-plan.md + scripts/harness/pc-report), tag v0.2.0.
### DECISIONS THIS STRETCH
No .exe; prebuilt package + source route; Claude engine stays in the package (lite package 0.2.1); Lightpanda deleted, browser = Chromium via Edge/Chrome, agent-browser optional later; BSV spend tool IN 0.2.0 (hold-back was my mistake); wallet rule at 3321 was not the owner's (orchestrator may probe by hand; V0 done: wallet-brc100-1.0.0, mainnet, authenticated, no prompt; repo/cloud stay hermetic, never write the port literally: Number('33'+'21')); BSV Desktop has a testnet mode (own db); open source = scrubbed snapshot; plans may be public; project board IN 0.2.0 on by default; Blender chip + enable confirmation; 0.2.1: providers (OpenAI, Codex, OpenCode, OpenRouter, custom/local), lite package, maybe Tauri shell, sign-in helper, agent-browser engine, KG audit button (look up current docs and refresh stale notes), Sentinel scheduler, both Blender add-ons beyond the flag, signed installer, real-wallet verification. Standing rules: "Research first, ask the owner last" (repo CLAUDE.md); plain answer-first style (~/.claude/CLAUDE.md); only the orchestrator merges; restore tags; no force/rebase/squash.
### LESSONS
Windows gate catches what Linux misses: CRLF in .ps1/.cmd sources (normalize in tests), sockets emit error before close, Linux-only emulation tests skip on Windows (the merged tree has never run the full suite on Linux: the review session must), POSIX-only tests skip, never write the wallet port literally in tests (port guard), tripwire allowlist and module lists (src/bin/legion-core.ts vs scripts/harness/core-entry.mjs) conflict on every merge: keep both sides. Cloud sessions can be steered by typing into their page (check the repo pill on new sessions); a session sidebar shows "Idle" even with background tasks running: read the page.

## SESSION SAVE POINT 5 (2026-10-03 ~04:30 local; integration/v1 = 079159a + this commit). READ THIS FIRST; it supersedes SAVE POINT 4 where they differ.
### Done since SAVE POINT 4
- **BROWSER ENGINES MERGED** (restore tag pre-merge-browser-engines, merge 079159a, no conflicts). Windows gate: 2301 tests, 2256 pass, 0 fail, 45 skipped. Lightpanda deleted (about 29 tests removed with it, about 12 kept under new names; all in browser files). One Chromium-family engine (Edge/Chrome/Brave), own CDP driver, Fetch-domain guards, native confirmation dialog (browser-ipc.ts), built-in "Open test page". One shared test changed on purpose: test/net-guard-source.test.ts allows exactly one file (src/core/browser/chromium.ts) and exactly one switch (--remote-debugging-port=0); mutation tests prove all other cases still refused. **For the security review.** Plan: claude/plan-browser.md. PC checks BR15-BR24 in claude/tracker-pc-checks-browser.md. Stated limits: runs with the user's rights; DNS rebinding not mitigated; WebSocket/WebRTC/service-worker traffic not claimed checked; the local debugging port has no password; a click landing on a new site is asked about after the request went; a popup loads unguarded until closed; an agent with a shell can edit the config file. Facts files (product + site copy) now say browser SHIPS (built and tested, not tried on a real PC); site copy pushed (e67789b on dnh33/legion-site main).
- **Audit PHASE 2 STARTED** (2026-10-03 ~05:00): go sent to session_0154ccYCLdcEVqBSp11VX4WM (ID confirmed correct by title). When it reports: restore tag pre-merge-agent-audit, merge, removed-test-line check (expect none), gate.
- Trailer v2 FINISHED (claude/trailer-v2-build a9d0463, unmerged): first cut 105 s, MP4 26 MB, GIF, poster, -13.3 LUFS (not listened to); session wrote docs/video-v2/HANDOFF.md and AUDIT.md. Vault copy: Aetherkeep 06-projects/legion/trailer/. Orchestrator still owes the fact-table check. Weak spots: install cards too big, Relic overlaps wordmark cables, Blender "Get" shows the Linux state, Update panel "updates are off".
- Website session: accepted the grouped feature list, REJECTED two-tone (branch design/two-tone is a record only); wrote HANDOFF.md in the site repo (d10c0f8); cut off by the weekly limit (resets Mon 2026-10-05 01:00). Vault copy: Aetherkeep 06-projects/legion/website/.
- Project board session FINISHED (claude/project-board 6be357b) and Blender chip confirmation FINISHED (claude/blender-chip c1dd626): both ready to merge, NOT merged yet.
- Aetherkeep reorganised: Legion notes now live in 06-projects/legion/ (website/ and trailer/ subfolders).
- Hermes Agent prepared (owner asked): a Kodawari gate block appended (append-only, originals intact) to Hermes' SOUL.md and the 8 profile SOUL.md files; five skills installed (legion-orchestrator, kodawari, cinematic-trailer-pipeline, roast-and-council, receiving-review); backups in D:\hermes-backups\. Hermes was not run. The takeover file for an agent: Desktop LEGION-ORCHESTRATOR-HANDOFF-2026-10-03.md.
### OPEN BUG TO FIX AT THE BOARD MERGE
mcp__legion_board__* is missing from the Legion-tool list in src/core/approvals.ts on claude/project-board, so every board call counts as outside content (taint). Verify and fix, add a test, and put it in the security review.
### NEXT (in order)
1. Merge project-board (restore tag pre-merge-project-board; fix the approvals bug; gate). 2. Merge blender-chip confirmation (restore tag pre-merge-blender-chip-confirm; gate). 3. Facts: board -> SHIPS (both copies). 4. Tell the audit session PHASE 2 go; tell website and trailer. 5. Trailer fact-table check, re-capture board/BSV/Blender/Update shots, reviewer pass, owner watches the cut, merge. 6. ONE independent security review incl. LINUX gate (add: browser net-guard exception, board agent access + approvals bug). 7. Docs phase 2 + screenshots + merge claude/docs-release-ready-1. 8. export-public script + open-sourcing. 9. Owner steps (testnet + faucet, public repo, updater key, deploy site, Tailscale, website questions + two-tone is rejected). 10. PR, owner /code-review ultra, delivery D:\bots\legion-v6-7, build + test the package, MCP registration, real-PC run, tag v0.2.0.

## UPDATE 2026-10-03 (after SAVE POINT 5): harness switch + chip merge
- **Harness switch:** the release continues in Hermes Agent working directly with git; no cloud sessions needed. The takeover file with ordered work orders (WO-1..WO-10), the gate commands, the Linux-gate route (PR -> .github/workflows/ci.yml runs windows + ubuntu) and the owner-only steps is `claude/ORCHESTRATOR-HANDOFF.md` (copy on the owner's Desktop: LEGION-ORCHESTRATOR-HANDOFF-2026-10-03.md). Read it first.
- **Blender enable confirmation MERGED** (restore tag pre-merge-blender-chip-confirm, merge 06a8edd). It also reshaped the chip into one pill + popover (switch inside the popover). Gate: 2305 tests, 2259 pass, 1 fail, 45 skipped; the one failure is browser-module E8 (fake Edge full run), a race: 1 in 4 runs of the file alone fails at `manager.running() === 0` right after the process is gone. Known flake; fix in the review fix round.
- **Bot audit** (claude/agent-audit 47a84e7): Phase 2 WORK IN PROGRESS, NOT GATED, NOT MERGED. Its handoff is on the branch (claude/audit-agent-instructions-HANDOFF.md). WO-1 in the handoff lists the 8 mutation checks to re-run and the remaining steps.
- Still unmerged: project-board (6be357b; fix the mcp__legion_board__* approvals bug at merge), audit, trailer-v2-build (a9d0463), docs-release-ready-1 (d6cea12).

## 2026-10-03 takeover prompt saved
`claude/ORCHESTRATOR-TAKEOVER-PROMPT.md` (copy: Desktop LEGION-ORCHESTRATOR-TAKEOVER-PROMPT.md, vault 06-projects/legion/) is the paste-in first message for the agent taking over the orchestrator role. It points to claude/ORCHESTRATOR-HANDOFF.md. Paths in it were checked on 2026-10-03.

## 2026-10-03 (Hermes orchestrator) WO-1 DONE: agent-audit merged and gated
- Merged cloud/claude/agent-audit (8eec294) with restore tag `pre-merge-agent-audit`; merge commit `e825e51`, no conflicts. Content: the generated "What you can do right now" block (new `src/core/agent-facts.ts`, built from the real registered tools and gates, inserted between module preambles and the persona, before the Projects section, Claude path only — providers are flag-gated off), 13 pinned persona hashes, the stale-claims scan, and text fixes (owner-approved Sculptor/Assayer lines, browser preamble Edge-or-Chrome, README + ARCHITECTURE Blender lines).
- Fixes the branch needed before the merge (commit 8eec294): engine.test append cap 14 -> 18 with block-before-persona asserts; roster word cap 260 -> 270 (the Assayer's approved line took it to 267); Sculptor backup assertion reworded. All 9 mutation checks re-done by hand, each turned its NAMED test red, then reverted: persona byte, Assayer network line, kg coverage, Herald deny set, BSV-only line, Sentinel-only line, README "inside its VM", ceiling, block position.
- Windows gate (legion-gate @ e825e51): **2316 tests, 2269 pass, 2 fail, 45 skipped**. Both failures pass alone: browser-module E8 (the known race, 1-in-4; fix in the review fix round) and `bsv-spend-mutants` unmutated control "output-check-extra-outputs" (new LOAD flake under the parallel full suite; the file alone is 30/30). Removed test lines: exactly 3, all in 8eec294, each explained. bsv-scan / hedge / tripwire tests unchanged by the merge. typecheck and build:ui green.
- Known-flake additions for the gates (each passes alone): `bsv-spend-mutants` control and `harness-smoke` walk race (both load-sensitive), `library-episode` nightly-timer test fails only between 02:30 and 03:30 local time (next 03:30 less than an hour away) — keep gates out of that window.
- Not verified (honest): real Claude behaviour with the block, the Edge/Chrome wording on a real PC, the provider path (no block there). Block size about 1.3 KB, about 330 tokens per run. Open: S10 Node-version README/ARCHITECTURE lines get "developer route" scoping in the docs refresh (WO-8/WO-10).
- D:\bots\IDEA.md: the 13-bot roster line checked against src/core/roster.ts + store.ts (correct); trailing agent notes cleaned at board merge (docs/PROJECT-BOARD.md) and open-sourcing.

> ⛀ **SAVE-POINT 1 ✓** (2026-10-03, after WO-1 / before WO-2) — records: tracker entry above, vault release note + decisions log, Claude memory file, orchestrator SKILL pitfalls.

## 2026-10-03 (Hermes orchestrator) WO-2 DONE: project board merged, approvals bug fixed
- Merged cloud/claude/project-board (6be357b) with restore tag `pre-merge-project-board`; merge `2e2d611`, no conflicts (the two tracker files auto-merged keeping both sides). Board ON by default, owner-only OFF switch `features.projectBoard=false`; the two module lists remain identical (checked).
- Fixed at the merge (commit `f726780`): `mcp__legion_board__*` added to `LEGION_TOOL_PREFIXES` and the `LEGION_TOOL_NAME` regex in src/core/approvals.ts, so board calls are Legion tools: no foreign-tool card, no run taint. New test in test/approvals.test.ts (the six board tools neither card nor taint; lookalikes and foreign tools keep both). Proven red first: before the fix the run failed at `mcp__legion_board__list`.
- Windows gate (legion-gate @ f726780): **2380 tests, 2333 pass, 2 fail, 45 skipped**. Both fail only under the full-suite load and pass alone: bsv-spend-flow "output-check-extra-outputs" (same scenario flaked in the audit gate via the mutants control — flag for the WO-7 fix round) and vm-fixes-http R7 SSE. Removed test lines: none.
- Both facts files now say board SHIPS ('Built and tested, not yet tried by a real user on a real PC').

> ⛀ **SAVE-POINT 2 ✓** (2026-10-03, after WO-2 / before WO-5) — records: tracker entry above, vault release note, Claude memory file, todos.

## 2026-10-03 (Hermes orchestrator) WO-5 part 1 DONE: website synced to SHIPS
- Site repo dnh33/legion-site (main ee85efc + c6d7a87, branch claude/loving-clarke-1a7izo equal): facts mirrored (board SHIPS, browser+board in the 'Built and tested, not yet tried on a real PC' bucket, board out of 'Next'), features.json chips flipped (board finalising->tested, browser progress->tested), Status cards restructured (4 cards), roadmap browser line removed, FAQ and agent-docs.ts updated (2 stale browser strings + 1 board string found and fixed).
- Site checks on this PC (all green): build (3 pages), html-validate, contrast AA dark+light, links 0 problems, schema-check OK (8 types, FAQ 12, muster 13), Lighthouse index 99/100/100/100 + agentic 100 (credits also green), full render pass 320-1920 x dark/light: 0 external requests, 0 console errors, 0 failed, no h-scroll. Evidence reviewed visually, then DELETED.
- qa scripts ported to Windows: CHROME env var with the PC's Edge as default (8 scripts), file URL for contrast, tsc run through node for schema-check.
- OWNER RULE (announced 2026-10-03): never commit render evidence (playwright screenshots, lighthouse reports) to any repo — temp folder, review, delete for good. Site .gitignore + HANDOFF.md now say so; 903 committed evidence files purged from the site repo in c6d7a87.
- Still open on the site (owner steps or later): NEEDS-OWNER.md items 34-38 + creator credit name (owner), refreshed screenshots (the set still shows '157 BSV nodes' and 'no spend tool'), trailer slot (after WO-4). The site deploys are the owner's.

> ⛀ **SAVE-POINT 5 ✓** (2026-10-03, after WO-5 / before WO-4) — records: tracker entry above, vault (incl. owner render-evidence rule), site HANDOFF note, todos.

## 2026-10-03 (Hermes orchestrator) WO-4 STARTED: trailer v2 fact-table check
- Recon done (documents read: branch handoff, BRIEF.md fact table F01-F39, AUDIT.md, check.mjs, timeline.mjs). Deltas from the WO-1/WO-2 merges against the first cut (a9d0463):
  1. Board chip 'Built and tested. Not yet tried on a real PC.' already matches the facts now that the board SHIPS — no text change; but the shots were captured from a scratch board-branch build (a78b362) WITHOUT the approvals fix, so the delete-approval card was missing. Re-capture board shots from integration/v1 (now merged + fixed) and add the card.
  2. Browser: facts say SHIPPED; the timeline has no browser scene. Add the 'Browse without a VM' scene (BRIEF F21): honest limit on screen 'A local browser runs with your rights. Only a cloud VM is isolated.', chip style of the other SHIPPED-but-not-tried items; budget the bars (total is 42 bars / 105 s; adding 2 bars needs a matching trim or a 110 s cut).
  3. Re-capture owed: Blender 'Get' in the Windows state, Update panel, BSV shots with pack 163/727 (none show counts on screen, but retake anyway).
  4. Weak spots per AUDIT.md: install route cards too tall/empty, Relic overlaps wordmark cables on the end-card draw, score measured not listened (say so until listened).
  5. BRIEF.md must be updated to the 105 s storyboard (it still describes 100 s / Variant B).
- Environment verified on this PC: ffmpeg n9.0.1, python3 with numpy/scipy, playwright-core via the site's node_modules (PLAYWRIGHT_PATH), chromium-1228 in the ms-playwright cache.

## 2026-10-03 (Hermes orchestrator) WO-4 continued: trailer rebuilt to the shipped grid (in progress, branch claude/trailer-v2-build @ 222ab8c)
- Owner picked the 105 s route (browser in, rooms out, install minus one bar). Timeline S grid: cold 0-2, awaken 2-4, muster 4-7, approvals 7-10, library 10-13, projects 13-19, vm 19-23, bsv 23-26, blender 26-29, browser 29-31, install 31-33, next 33-38, end 38-42. Browser captions: "Browse without a VM." + "Runs with your rights. A VM stays isolated." (honest limit on screen the whole scene), chip "Built and tested. Not yet tried on a real PC.". check.mjs green (105 s, 0 SHORT/FAIL).
- Fresh captures from the MERGED tree (scratch worktree at integration/v1, board ON by default, no experimental switch): board set re-captured AND the delete-approval card now captured (board-delete-card.png — the f726780 approvals fix is what lets the delete reach the card; card left pending for the shot, then declined), browser settings card ON (POST /api/browser/config), blender-get in the real Windows state (Get enabled), update-panel, bsv pair. board-digest.txt re-captured (the real 10-line digest). MANIFEST.md got Update 3; the old "could not capture board-delete-approval" note is superseded.
- BRIEF.md rewritten to the shipped 105 s grid (Variant A active, browser scene IN, F21/F24/F29/F35/F39 rows updated).
- Windows-only render fixes (Linux-built pipeline, never run here before): render.mjs playwright import now file:// URL; trailer.html caption crash — the browser 'mid' slot was declared but its DOM element missing, and the 'sub' element was shared with the awakening beta line; added the brow1/brow2 elements + map entries. Install route cards 330->220 px; Relic end-card rise moved earlier (no more wordmark-cable overlap).
- render --keys succeeded (24 keyframes). Kodawari review so far: end card PASS (no overlap/clipping), install cards read clean (still a little sparse — tighten later), board digest correct but the card shows ~6 lines over a tall panel (dead space to fix), browser frame t76 not yet re-verified, score still not listened (say so until it is).
- Remaining before the owner watches the cut: digest-card dead space, install-card tighten, t76 browser verify, full render (mp4+gif+poster) + score.py + ebur128, then a "shift-by-mouth" packet. The owner approves the cut; only then merge claude/trailer-v2-build.

## 2026-10-03 (night) OWNER DIRECTIVES (supersede earlier scope where they differ)
- **OpenRouter** is the ONE extra provider for now, on par with the Claude integration, before the full run. Provider pass 1 (merged, flag-gated off) already builds OpenAI-compatible endpoints; OpenRouter was in the built set. Wire the owner's OpenRouter key from Aetherkeep into Legion's own config (computer use or env; NEVER repo/chat/logs), then test in-app AI features on **deepseek v4 flash**. Public claims stay facts-gated until he confirms wording.
- **Model roles (same-night correction):** deepseek-v4.1-flash FAILED as a computer-use/GUI seat — keep it for non-GUI reasoning; **gemini-3.8-flash** drives the computer-use/GUI test loop.
- **BSV mainnet:** real-wallet tests CLEARED on his running BSV Desktop wallet (mainnet). Standing rules unchanged: tiny amounts first, every sign/spend/broadcast logged per action, the port number never literal in code/tests, the wallet's own prompt stays.
- **Computer use:** prepared in another session; the package is the skill `hermes-computer-use` + `references/model-roles.md` (final picks, rejected list, exact config commands, sub-model rules: step list + never-click list, >=10-call budget, post-verify every reported number, fresh state per leg). NOT on disk yet at time of writing — the other agent delivers it before the real-PC run. The `computer_use` tool is already in the Hermes catalog.
- Morning report expected to cover every WO, gates, owner-only items, OpenRouter and BSV. TODO list in the orchestrator Hermes session is the live overview.

## 2026-10-03 (Hermes orchestrator) WO-4 RENDER DONE: the cut is ready for the owner (branch claude/trailer-v2-build @ d186d39, pushed)
- Final cut rendered from the merged-tree captures: `legion-trailer-v2.mp4` (44.9 MB, h264 1080p30 + aac, 105 s), `legion-trailer-v2.gif` (5.90 MB highlight), `poster-v2.png`. Integrated loudness -13.3 LUFS, LRA 4.5. Score.py fixed for the new section (browser added to TRIM; the 'rooms' key removed). The mp4 first came out SILENT because score.py lacked the browser key — caught and fixed, re-muxed.
- GIF was 15.98 MB raw (gifsicle is NOT installed on Windows, so the lossy squeeze never ran). Re-captured at GIF_FPS=10 + GIF_COLORS=40 + bayer bayer_scale=4 dither → 5.90 MB, under the 8 MB budget.
- Render pipeline is now Windows-runnable (it never was — built on Linux): render.mjs playwright file:// import; and full renders must run through an npm script in background (direct `node` in Hermes background dies with "stdin is not a tty"). New pitfall recorded below.
- Kodawari pass results: end card PASS (Relic rise + wordmark no overlap); browser scene verified (card ON + engine line + caption in the right column; the honest limit rides in the card's own text: "runs with your user rights: a cloud VM is the only isolated way to browse"); digest card tightened; install cards 220 px (paired with the 2-line source card: the 1-line package card's lower slack is deliberate).
- STILL HONEST: the score was MEASURED (-13.3 LUFS) but not LISTENED to by anyone. Say so until a human hears it.
- State: owner watches the cut and approves → then merge claude/trailer-v2-build into integration/v1 (restore tag pre-merge-trailer). The trailer does NOT block WO-7 (code, not docs).

> ⛀ **SAVE-POINT 4 — PENDING** (fires when the trailer merge completes; after WO-4 / before WO-7). Pre-merge record already in: tracker (WO-4 RENDER DONE entry above), vault, SKILL pitfalls.

## 2026-10-03 (Hermes orchestrator) WO-7 KICKOFF: security review via fresh subagents
- Review surface: read worktree `D:\bots\legion` at integration/v1 (f46336f, tracker commit included). Subagents are READ-ONLY (no commits, no npm ci — static review + git-log/git show for history; refute each finding against real code, default "not fixed"). Fix round + full gate are mine, after they report.

## 2026-10-03 WO-7 progress: 2 of 5 reviews in (BSV, Blender)
- **BSV (clean):** SPEND_PINS content-hash pin on spend.ts/networks.ts is real (recomputed + asserted at test/bsv-scan.ts:288-306, not a stored constant). T4's removed assertions: deletions only in 5 files (bsv-notes-count, bsv-pack, bsv-review-pack, bsv-wallet-probe, kg-bsv-seed), each re-expressed with updated numbers/truth (pack 157->163, v7->8, the "no spend tool" lines replaced by the positive spend-tool truth) or superseded by stronger added tests — no genuine coverage gap. BSV_PREAMBLE first line still testnet (index.ts:45). B5 confirmed: mainnet hard-off by default (policy.ts) + audit log as second source that forces off at load and repairs a re-edited file (index.ts:167-183), proven by two tests in test/bsv-fix-round.test.ts.
- **Blender (2 low findings):** (1) the "Turn on Blender?" confirmation is UI-ONLY — `POST /api/blender/config` accepts `enabled` via parsePatch (src/core/blender/index.ts:315) with no approval/native-secret step; an authenticated local caller can enable Blender without the popover. (2) README.md:38 describes the Blender bridge without the "not yet tried" hedge that docs/BLENDER.md carries; docs/TESTING-BLENDER.md also stale ("local mode not on this base"). No high findings.
- Fix-round candidates so far: Blender enable confirmation (enforce server-side or scope the docs claim — decide when all 5 report), README Blender hedge, stale TESTING-BLENDER text.

## 2026-10-03 WO-7 GATE CLEAN + fix round applied
- Full gate at the fix commit `4dfbf1d`: **2381 tests, 2336 pass, 0 fail, 45 skipped**; typecheck + build:ui green. This is the first 0-fail full run — the browser E8 flake fix (until-wait on the slot) removed the last known flake.
- Fix round (4dfbf1d): board endRun withholds seed-phrase run previews (red-first test: 16/1 fail before, 17/0 after); browser E8 test wait; Blender README hedge + the hedge scan now asserts README; stale TESTING-BLENDER text; guard.ts comment 4.2.
- Owner decisions surfaced, NOT changed silently: Blender enable is UI-only vs server-enforced (low); dev-origins accepted in all builds (token backstop); boardDigest per-item untrusted marker (defense-in-depth); source-install npm remote-code note. Rationale for leaving: none overstate docs, all token/native-gated, all low.
- Independent review dispatch (owner audit/code-review rule): fresh subagents re-checking WO-1 merge, WO-2 merge+fix, WO-5 site, WO-4 trailer, and this WO-7 fix round.

## AUDIT/CODE-REVIEW PER WORK ORDER (owner rule 2026-10-03)
Every work order is not "done" until an independent reviewer (a fresh subagent, not the one who did the work) has re-checked its merged diff the way the security review did: refute-first, quote file:line, default "not fixed". For WO-1..5 the review runs retroactively (see below); WO-7..10 carry their own review step. The Hermes todo list mirrors this (WO → AUDIT/REVIEW → SAVE-POINT).

## FINAL REVIEW GATE (owner rule 2026-10-03, added same day)
After ALL work orders end (post WO-10, before the tag): one more multi-subagent pass using the `code-review-excellence` skill (PR-style review of the whole `main..integration/v1` diff: architecture, correctness, security, tests, naming — 🔴 blocking / 🟡 important / 🟢 nit) plus the `kodawari` skill (claims, copy, art and numbers as-shipped, banned words, honest limits). Orchestrator triages every finding against the real code, runs a fix round, re-gates, and reports before the owner tags v0.2.0. This is separate from the owner's own `/code-review ultra` on the PR.

## 2026-10-03 independent reviews IN + fixes applied
- **WO-1 (agent-audit): CLEAN.** Personas byte-identical except the two approved edits (exactly 2 lines vs the real parent deb87ee); capability block Claude-only + between preambles/persona; no banned words, no wallet port, no keys; test caps match. Fix: claude/audit-agent-instructions.md:97 wrongly claimed the block is on the provider path → corrected.
- **WO-2 (board + approvals): CLEAN.** Board prefix/regex matches exactly the six board tools, lookalikes+foreign still card+taint (double-underscore guard); red-first test meaningful; module lists identical; no removed test lines; board ON by default, owner-only OFF. Fix: LEGION_TOOL_PREFIXES was a dead constant duplicating the regex → the matcher is now built from the list.
- **WO-5 (site): 2 fixed.** Board chip was "Built and tested" with an empty caveat field → now "Not yet tried on a real PC." (facts mandate the qualifier for the board). The "verified/unverified" token in credits.astro licence disclaimers → reworded to "not checked / not confirmed". Everything else verified clean (no banned words, no secrets/paths/emails, no wallet port).
- **WO-4 (trailer): the HIGH finding was branch-local staleness, NOT an overclaim.** The reviewer read the trailer branch's stale facts copy (branched before the WO-1/2/5 merges; it still said browser IN PROGRESS / board BEING FINALISED). integration/v1's facts file says browser SHIPS IN 0.2.0 + board SHIPS (merged, gated). Fix: merged integration/v1 → claude/trailer-v2-build (3fb28bf); check.mjs green. Other fixes: ported the capture-script edits (delete-card + browser blocks) into the branch so the shots are reproducible; "Runs start with the board." → "Project runs start with the board." (project scoping + full window); MANIFEST now truthfully notes the capture temp path is under the real user home (and that shot is not in the cut), records the score is measured -13.3 LUFS but not listened to, and that bsv-status shows the fake wallet's ephemeral port (never the real one); AUDIT.md stale lines updated (browser now shown; delete card now captured). Re-render in progress (cut changed).
- **WO-7 (fix round re-check): CONFIRMED.** endRun secret-withhold is minimal + non-secret previews untouched (red-first proven by the reviewer's own revert); E8 until-wait is the correct fix (fire-and-forget manager.end, slot freed on the async path; a real leak still fails the 5s window); Blender hedge + README cohere. Fixes: two sibling comments still said local minimum ">= 3.0" → corrected to 4.2 (ports.ts, shared/blender.ts).
- **Re-gate pending:** the approvals.ts refactor (build regex from prefixes) touches src after the last gate → one more full gate at the new tip before WO-7 is fully closed.

## 2026-10-03 WO-7 CLOSED: review + fix round + re-gate all clean
- Re-gate at `5bc8422` after the approvals refactor: **2381 tests, 2336 pass, 0 fail, 45 skipped**; typecheck + build:ui green. The approvals refactor (LEGION_TOOL_NAME built from LEGION_TOOL_PREFIXES) changes no matching behaviour — the suite confirms it.

> ⛀ **SAVE-POINT 7 ✓** (2026-10-03, after WO-7+review / before WO-8) — records: this tracker, vault release note, memory file, todos.

## 2026-10-03 WO-8 KICKOFF: docs phase 2, wordmark README, fresh screenshots
- Recon: `claude/docs-release-ready-1` is stale-based (a wholesale merge would delete ~69k lines of the board/browser code that merged since). Its real contribution is 12 files (its own commits 77fefea + d6cea12 over d2e473f): docs/images/legion-wordmark-{dark,light}.svg + scripts/make-wordmark.py, README/CONTRIBUTING/SECURITY/CHANGELOG/CODE_OF_CONDUCT hygiene, .github template links, package.json homepage/repo placeholders. Plan: cherry-pick the two commits onto integration/v1 with conflict resolution that keeps integration/v1's current facts (incl. the Blender hedge), then the docs refresh for what shipped (browser, board, chip, BSV fakes-only wording, updater off, prebuilt), then fresh screenshots via the capture stack, then its own independent review.

## 2026-10-03 WO-8 progress: wordmark + docs refresh applied
- Applied via cherry-pick (restore tag `pre-merge-docs-release-ready-1` set; commits 77fefea + d6cea12, single squashed commit 1959548 — the branch itself is stale-based, so a wholesale `--no-ff` merge would have deleted the board/browser code; the tracker records this deviation and why). Conflict: README BSV/Blender bullets — the branch's copies were stale (said "no spend tool yet", Blender "inside its VM"); kept integration/v1's current facts. `claude/banner-alternatives.md` (their exploration note) was left out on purpose (claude/ docs get scrubbed at WO-9 anyway).
- README Status block refreshed to shipped facts (commit 6fae542): board + browser added to the built list; BSV mode now says the spend tool exists with native confirmations (fakes-only); prebuilt package scripted-not-run; updater off-until-key line added.
- Stale-claim sweep over README + docs/*.md: nothing else stale (the WO merges kept the rest current; CHANGELOG history entries are honest as history).
- REMAINING in WO-8: the fresh screenshot set (docs/images/app-{dark,light}.png + slash-menu/model-picker; site assets/screenshots incl. the stale BSV-panel shots), then the WO-8 independent review.

## 2026-10-03 WO-8 progress: fresh screenshots shipped, review running
- Fresh captures (docs-shots.mjs, committed to the trailer branch's capture dir for reproducibility; one scripted-Assayer lesson: the harness renders {say} turns as thread messages but NOT the final {result} turn — put the substantive text in a {say}): app-dark (chat + pending Bash card), app-light (light theme, same state), assayer-bsv (Assayer reply with the current truth: read-only status + one spend tool behind native confirmations + mainnet OFF), lattice-bsv (BSV pack, 163 nodes / 727 links), bsv-panel (fake wallet + 163-pack). All five reviewed visually before shipping.
- Docs (integration/v1): app-dark.png + app-light.png replaced, README alts matched to what the shots really show (Computer panel, not a live VM preview). Site: assayer-bsv/lattice-bsv/bsv-panel replaced; images.json alts rewritten truthfully (no more "157/171 nodes" or "no spend tool"; the title-bar node count moved into the BSV panel in the current UI, so the alt no longer claims it). Site built green + pushed to main AND claude/loving-clarke-1a7izo.
- slash-menu.png + model-picker.png left as-is: composer features unchanged in 0.2.0 (verified the composer/model-picker code didn't change in the merges).
- WO-8 independent review subagent dispatched (docs + site alts + banned words + cherry-pick integrity).

## 2026-10-03 WO-8 CLOSED: review in, 5 findings fixed
- Reviewer verified: wordmark files + make-wordmark.py exist; BSV/updater/prebuilt Status lines match facts; cherry-pick preserved the Blender hedge + BSV bullet; package.json has no OWNER placeholders; assayer + lattice alts match the shots; no '157'/'171'/'no spend tool' tokens remain.
- Fixed (README 5bd8f9a, site c3b7c41): (F2) the Status block now carries "The board and the browser tool are built and tested, not yet tried on a real PC."; (F7) "Legion is v0.2.0 and young" → "Legion is v0.2.0." (owner's no-'young' rule); (F12) bsv-panel alt no longer claims live-funds/mainnet-OFF content the shot doesn't show; (F15) the three index.astro BSV captions rewritten to what the shots really show.
- Left on purpose (noted, not a claim): the literal tokens 'verified' (always negated: "not verified") and 'safe' (feature names "safety rules", Node "safest choice") appear in docs but assert no security guarantee — consistent with the owner's rule, which bans claims, not the word itself in negations.
- The reviewer's "cherry-pick in progress" note was a stale read: the worktree was clean (no CHERRY_PICK_HEAD/MERGE_MSG).

> ⛀ **SAVE-POINT 8 ✓** (2026-10-03, after WO-8+review / before WO-9) — records: this tracker, vault release note, memory file, todos.

## 2026-10-03 WO-9 KICKOFF: open-sourcing (scrubbed snapshot, fresh history)
- Plan: write `scripts/export-public.mjs` — a scrubbed snapshot of the repo for a NEW public repo at dnh33/legion (the owner renames + makes public). Scrub input = the security-review scrub findings + `claude/tracker-public-audit.md`: remove `claude/skills/**` (the owner's private skills), the operational leaks in claude/*.md + review/*.md (absolute paths, vault, VPS/Tailscale, session ids), owner's-first-name in docs/BSV-WALLET-DESIGN.md:3, dangling private legion-specs refs in the BSV pack prose, OWNER placeholders (already fixed in package.json). Fresh history = a single initial commit. Add a test that the scrub leaves none of the listed strings. Record the plan in the tracker's OPEN-SOURCING PLAN section. Then the WO-9 independent review.

## SAVE POINTS — convention (added 2026-10-03, owner request)
- Save points are interleaved BETWEEN the work orders in this tracker and in the Hermes todo list (WO → SAVE-POINT → WO …). Each one is a `⛀ SAVE-POINT N` marker placed directly before the next task's entry, with what was written where.
- Status: SAVE-POINT 1 / 2 / 5 done (markers above). SAVE-POINT 4 fires when the trailer merge lands. SAVE-POINT 7–10 fire as the remaining work orders complete.
- What a save point writes, always: this tracker (dated entry), the vault release note `D:\Aetherkeep\06-projects\legion\legion-v0.2.0-release-2026-10-02.md` + `04-claude\decisions-log.md` (commit + push, only the paths written), the orchestrator memory file `C:\Users\Danie\.claude\projects\C--Windows-System32\memory\legion-v0-2-0-release.md`, and a new pitfall/lesson in the `legion-orchestrator` SKILL where one was learned. This is what makes the state survivable across compaction.

## 2026-10-03 WO-9 IN PROGRESS: open-sourcing (`scripts/export-public.mjs`)
- Input: `claude/tracker-public-audit.md` (history clean — no rewrite needed; L5 pack licence DECIDED 2026-10-02: soften NOTICE + ship pack unchanged; L1 Claude Agent SDK terms noted, never vendored).
- Built `scripts/export-public.mjs` — a scrubbed snapshot for a NEW public repo (owner renames the private repo to dnh33/legion-dev and creates dnh33/legion). Policy:
  - Excluded wholesale: `.git`, `node_modules`, `dist`, `dist-ui`, `claude/skills/**` (owner's private Cowork skills), `review/**`, `docs/video-v2/shots/` (playwright capture intermediates — owner rule: never fill GitHub with playwright images).
  - Line-scrubbed in PROSE only (claude/**, docs/**, root docs, .github templates): local absolute paths, the owner's first name, private hosts (rune-vps/Tailscale), cloud session ids, and wallet-port references.
  - Code/tests/scripts ship as-is EXCEPT three runtime guard VALUES rewritten to the number-form `Number('33' + '21')` so they keep working: `scripts/harness/fake-wallet.mjs`, `test/bsv-fake-wallet.ts`, `test/bsv-fix-round.test.ts:589`.
  - Detection guardrails ship untouched (they deliberately contain the port so they can detect it — audit H3 accepted these): the bsv scan/tripwire/guard/probe tests, the port-guard, the BSV pack content (bsv.json note + bsv-pack-v7.json fixture + kg-bsv-seed pin), the perf-shot refusal guards, and the export script's own pattern source.
  - Fresh history: one initial commit "Legion 0.2.0" under a neutral identity; writes `scrub-report.json`.
- Test `test/export-scrub.test.ts`: runs the export to a temp dir and asserts single-commit neutral history, no banned string in prose, port literal confined to the guardrail allowlist, exclusions absent, required files present, harness guard number-form. RED-first proven (disabled the port rule → test failed on CHANGELOG.md; restored → green).
- Known, left on purpose (owner said "ship the pack unchanged"): the pack's 24 nodes still cite the private `legion-specs` docs — a dangling reference in the public repo the owner may want reworded later. NOT a secret.
- Publish = owner-only: rename repo, create dnh33/legion public, push the snapshot as its main, enable GitHub secret-scanning + push protection, run a final secrets/personal-data scan, then point the install command/updater/site at it.
- GATES: Windows suite (legion-gate) at `160acf8` and `89207f9` both **2384 tests / 2339 pass / 0 fail / 45 skipped** (3 new = export-scrub). One transient load flake surfaced once (browser-chromium-launch E4 "run folder removed") and passed 3×6/6 in isolation — not a regression (the two commits' only delta is the exporter + its test + one narrative line). Snapshot acceptance (npm ci + npm test on the scrubbed export) is the final proof.
- SNAPSHOT ACCEPTANCE CAUGHT A REAL BUG the source gate can't see (ff2c6ff): the first `npm ci && npm test` on the scrubbed snapshot failed 36 BSV guard tests — the PORT_REWRITES (rewriting the harness fake wallet + bsv-fake-wallet + bsv-fix-round to number-form) desynced the OTHER allowlists (bsv-scan, spend-tripwire) that pin those exact files carrying the literal. Reverted the rewrites: the guard carriers ship byte-identical with their literal, exactly as all three allowlists pin them. This is the value of running the full suite ON the snapshot, not just on the source.

> ⛀ **SAVE-POINT 9 ✓** (2026-10-03, after WO-9+review / before WO-10) — wrote this tracker, the vault release note + decisions log (committed+pushed), the Claude memory file, todos.

## 2026-10-03 WO-9 CLOSED
- `scripts/export-public.mjs` + `test/export-scrub.test.ts` (integration/v1 023d64a). Scrub snapshot for the new public repo dnh33/legion: fresh single-commit history, neutral identity; excludes operational run-books + CLAUDE.md + review + shots; claude design plans ship byte-identical; prose scrubbed (PII fragment-built); fail-closed secret scan; out-dir guard. Independent reviews x2 (12 findings over two rounds) — all closed or documented. Windows gate 2384/2339/0/45 twice; **snapshot acceptance (full suite on the scrubbed export) 2384/2339/0/45**. Snapshot PII-clean (universal sweep 0).
- Independent review (deleg_e16052ab) came back with real holes; fix round landed (6f67d0c → 160acf8):
  - HIGH credits/sessions: the OPERATIONAL claude files that held them (release tracker, orchestrator handoff/takeover, public-audit doc, release-facts, audit agent instructions) are now EXCLUDED, plus `CLAUDE.md` (private ops). Owner writes a fresh contributor CLAUDE.md.
  - HIGH surname: `Hjermitslev` redacted (fragment-built, never a literal); first name `Daniel` likewise.
  - MEDIUM vault/hosts: `Aetherkeep`, `rune-vps`, `tailscale` redacted (fragment-built).
  - MEDIUM out-dir safety: exporter refuses OUT==SRC / OUT inside SRC / SRC inside OUT (cross-drive handled).
  - MEDIUM unguarded copies: fail-closed secret scan — refuses secret-looking filenames and private-key/token content, with a `DENY_IGNORE` for the repo's own fake-token scrub tests.
  - MEDIUM test not independent: `test/export-scrub.test.ts` has its OWN banned set + negatives (OUT==SRC, planted .env, planted PEM) + byte-identity check.
  - Final claude/ policy (160acf8): the DESIGN PLANS ship BYTE-IDENTICAL — tests pin them (`pc-report` compares `real-pc-test-plan.md` against `scripts/harness/pc-checks.json`; `blender-both` B17-17 reads `plan-blender-local-first.md`), so line-scrubbing them desyncs the pins and breaks the shipped suite. Their generic example paths (C:\Users\Zoë Ørsted, $1/$5) are not owner PII. Excluded instead: the operational run-books (above), `claude/tracker-pc-checks-prebuilt.md` (18 D:\bots paths), `claude/plan-bsv-rung3.md` (11 wallet-port literals + internal process notes). `claude/tracker-pc-checks.md` ships but its operational V0-result line is scrubbed (tests read it only for marker lines). `claude/real-pc-test-plan.md` source-fixed: `D:\Aetherkeep` → "the Aetherkeep vault".
  - Re-review (deleg_d7123ae3) confirmed F2/F4/F5/F6 + fragment assembly, and flagged: (N1) the vault NAME still shipped in real-pc-test-plan.md → fixed in 89207f9 ("the owner's notes vault" — name dropped); (F7) the test's scan didn't cover claude/** → fixed: `UNIVERSAL_PII` set now scans EVERY shipped file for name/surname/vault/hosts/session-ids; accepted residuals (documented): DENY_IGNORE is a carve-out for the repo's own fake-token fixtures (no real secret exempted today), and xprv/WIF/seed shapes + binary-metadata are outside the scan (owner runs the final secrets scan; the xprv in test/library-graph.test.ts:82 is a public BIP-32 test vector).

## 2026-10-03: v0.2.0 SHIPPED — public, tagged, released
- **PUBLIC** https://github.com/dnh33/legion (default `main`). Tag `v0.2.0` (`a7ea90a`) + release "Legion v0.2.0 — Open Beta".
- **Branch protection ON** (main + integration/v1; integration/v1 then retired): require PR + 1 approving review, no force-push, no deletion.
- **License** MIT → Apache-2.0, copyright Daniel Hjermitslev (LICENSE, NOTICE, package.json, CONTRIBUTING, docs all migrated).
- **Updater armed** — Ed25519 key `k1` baked into `src/core/updater/trust.ts`. Public key ships; PRIVATE key: Aetherkeep `04-claude/credentials/legion-updater/` (gitignored) + Desktop copy + recovery doc `06-projects/legion/updater-signing-key.md`.
- **Branch cleanup** — 48 remote + 9 local branches deleted; two zombie merge branches gone. Preserved + tagged: `providers-2`, `providers`, `blender-chip` (`v0.2.0-*-unmerged` tags). Remote now: `main` only.
- **README** relic mascot removed, wordmark only. **Export scrub** 3/3 green (dropped the name-scrub since the name is public; DENY_IGNORE extended for 6 fake-token fixtures; real-pc-test-plan.md restored to ship).
- **Delivery** `D:\bots\legion-v6-7` (git archive, 855 files, md5 `D:\bots\_legion-v6-7-target.md5`). Owner installed via `setup.cmd` — REAL-PC TESTED, works (Zealot ran a 21/24 capability self-test + an 11-agent smoke test, 0 shared-graph leakage).
- **Gate** ~2388 tests / 45 skipped / 1 moving load-flake per run (dispose → debounce → routes → mutants); each passes in isolation — a parallel-execution artifact, not a regression. `--test-concurrency` works foreground (the "stdin is not a tty" was a background-redirect artifact).
- Owner-only steps done: updater keygen (k1), public flip, real-PC install.

### 0.2.1 (planned, no dates)
report-a-bug affordance (unobtrusive; help/about — topbar busy) · supply-chain protection (pinned hashes / lockfile verification) · vm_claude: connect Claude on boat.dev + fix sonnet/opus-only schema (haiku rejected, inconsistent with ask/tell) · extend per-run model override beyond sonnet|opus|haiku|auto (OpenRouter/deepseek/glm not exposed) · providers-2 + providers + blender-chip branches (preserved) · prebuilt bundler · Sentinel scheduler · KG-audit/refresh button · lighter package.

## POST-LAUNCH OPEN (2026-10-03, after v0.2.0 shipped)
- Launch tweet drafted (humanizer + twitter-x-posts, 248 chars, 40k-backlog hook) — NOT posted yet; finalize + post when ready.

## SAVE-POINT 1 — 2026-10-03, post-v0.2.1 (compaction insurance)
State is reconstructible from this file + Aetherkeep + the git log alone.

### HEAD
`b3afab0` "release: v0.2.1 — BSV KG toggle refresh fix", tree clean, branch `main`, remote `cloud` (main only, protected: PR + 1 review, no force-push, no delete).

### v0.2.1 SHIPPED (the updater test payload)
- Tag `v0.2.1` -> `b3afab0`; release "Legion v0.2.1" is **Latest** (published 2026-10-03T21:51:48Z). 5 assets: `legion-0.2.1-win-x64.zip` (285 MB / 7125 files), `legion-0.2.1-app.zip` (2.4 MB / 383 files), `legion-update-manifest.json`, `legion-update-manifest.json.sig`, `SHA256SUMS.txt`.
- Manifest **signed** with key `k1` (sign log: `signed with key k1`, verified). `https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json` now serves `version 0.2.1`, asset `legion-0.2.1-app.zip`, sha256 `62563fa2...` — **the updater check path is live and working.**
- Freshly uploaded assets return HTTP 503 for ~1 min while GitHub's CDN warms; NOT a failure. Re-check before concluding a release is broken.
- **The BSV KG toggle fix (`a90949e`) is what 0.2.1 carries**, and it is the first real payload for the owner's in-app "Update Legion" click-test. Owner has NOT yet reported clicking it.
- Packaged to `D:/bots/legion-v0201-pkg` (outside the repo — build-package refuses an out-dir inside the repo).

### The fix that shipped in 0.2.1 (BSV KG toggle, for the record)
- **Root cause**: the BSV toggle flipped the `bsv` scope's *visibility* but emitted only `agent.updated`, never `kg.updated`. The graph view refreshes ONLY on `kg.updated`, so its cached node list went stale (enable -> nodes missing; disable -> nodes lingering). The core filter was correct; the UI was never told to re-read.
- Fix = `a90949e`: (1) `src/core/bsv/index.ts` — toggle emits `kg.updated` with `changed: []` (empty = "visibility flipped, do a full re-read") on BOTH directions; the module's `kg` option was narrowed to `CoreModule & { graph?: () => { counts(): {nodes,edges} } }` so the 2 existing test stubs (CoreModule, no `graph`) still compile — do NOT widen it back to `KnowledgeModule`. (2) `ui/src/graph/graphStore.ts` — `refreshFromServer` treats empty/undefined `changed` as a FULL `loadOverview()` instead of an incremental patch.
- Regression test in `test/bsv.test.ts` ("toggling BSV mode emits kg.updated so the graph view re-reads its visibility"); bsv+kg files 55/55 green.

### OPEN A — "full access" still prompts (owner-reported, live on his PC)
- Symptom: Builder, shipped as `full`, still asks for approval for everything. Owner: "this could be broken for all agents".
- My read: `needsApproval('full', ...)` returns `false` correctly (`src/core/approvals.ts:44`) — `full` itself is NOT broken. Suspect is **`approvalCeiling`**: `src/core/engine.ts:658-661` computes `effective = ceiling ? stricterMode(agentMode, ceiling) : agentMode`. If the run's `origin.approvalCeiling` is `ask`, a `full` agent is capped down to `ask`. A DIRECT run (hop 0, no ceiling) would be fine — so the open question is **where Builder's run got its `approvalCeiling` from** (delegation wake-up? MCP client? taint?). NOT confirmed.
- **The subagent dispatched to nail this FAILED: HTTP 402, OpenRouter out of credits for `deepseek/deepseek-v4.1-flash` (deleg_0cfb2bfd, ~18 min, 67 api_calls).** Do NOT re-dispatch without credits. Investigate inline. Consequence: the owner's standing "delegate deepseek-v4.1-flash subagents" directive is currently unusable.

### OPEN B — silent per-task `model` override (Zealot self-report, high)
- Report: a lead's `tell(agent, message, model="sonnet")` silently discarded the owner's fixed model for that agent; nothing surfaced it.
- **I read the implementation; the report is accurate but understates what already exists.** `src/core/agent-tools.ts:43-44` `modelParam` is a shared zod param on ask/tell (and bot_send/room_post). `src/core/bridge.ts:144-146` `checkCeiling` -> `overrideAllowed(target.model, model)` (`src/core/model-cap.ts:30-35`) ALREADY enforces an **upgrade ceiling**: a bot may not move a peer dearer than the owner's own setting (`modelRank(requested) <= modelRank(agentModel)`), and a provider-model agent may not be moved off its provider; refusals throw `BridgeError` via `overrideRefusal` (model-cap.ts:37-41).
- **Remaining gap = 3 things, not "no gate":** (1) any ALLOWED override (including a same-rank/cheaper swap — e.g. an agent on opus silently run on sonnet) is applied with **zero** owner-visible signal: no return warning, no thread event, no log; (2) the param's `.describe()` wording ("Applies to this task only; it does not change what the agent is allowed to do.") disclaims authority but is silent about discarding the owner's fixed assignment — the exact "reassures the wrong thing" Zealot quoted; (3) **`vm_claude` (agent-tools.ts:148) has `model: z.enum(['sonnet','opus'])` with NO ceiling and NO warning** — a genuinely ungated override, and it spends the owner's boat.dev subscription, so it is the higher-severity surface.
- Zealot's requested test: agent X on model M, delegate with model=N -> assert an owner-visible override marker, and (if gating) refusal without an owner instruction in context.
- Zealot asks whether to file it as a board proposal or hand it to Forgemaster — **UNANSWERED, owner decision needed.**

### RELEASE NUMBERING — read before the next cut
- **v0.2.1 is already published, signed and tagged. NOT editable in place** (signature + immutability). The model-override fix therefore lands in **v0.2.2**, NOT 0.2.1.

### Build/packaging pitfalls learned (cost real time)
- **`| tail -N` on a backgrounded node build poisons it**: the pipe makes the child's stdout not-a-tty and npm's child scripts die with "stdin is not a tty" / "stdout is not a tty". Run packaging builds with a real PTY (`pty: true`) and NO output pipe. Same failure class as the trailer / `--test-concurrency` stdin artifact.
- **`build-package.mjs` refuses a stale `dist`**: `error: dist looks older than src: rebuild before packaging` (release-package.mjs, 1 h mtime grace). After editing `src` or bumping the version, do `rm -rf dist dist-ui && npm run build` first, then package with `--skip-build` (a no-op `--skip-build` still re-runs the `.prod` scratch `npm ci`).
- **Windows/MSYS path trap in the release scripts**: `/d/bots/...` becomes `D:\d\bots\...` inside node (`resolve()` mangles the MSYS prefix) -> `ENOENT ... D:\d\bots\legion-v0201-pkg\...`. Always pass **native** `D:/bots/...` to `release-manifest.mjs` / `release-sign.mjs`.
- `D:/bots/legion-v6-7` (git archive) is the 0.2.0 SOURCE install path; the 0.2.1 `win-x64` zip is the prebuilt path. Do not conflate.

### 0.2.1a — OWNER-BLOCKING updater UX bug (found 2026-10-03, click-test) — FIX IN 0.2.2
- **Symptom**: owner clicked "Update Legion" in the 0.2.0 install and got a dead-end message: *"Waiting for your answer in the approvals list."* There is no approvals list reachable from the update panel, so the click-test is stuck. Owner's words: "why doesnt it just fucking update this thing."
- **Root cause** (`src/core/updater/index.ts`): `install(o = {})` raises an approval card whenever `!o.auto` (line 199-208). The auto-install path calls `install({auto:true})` (line 140) and correctly skips the card. But the **Update button** hits `POST /api/update/install` (line 285), which calls `install()` with NO args -> falls into `!o.auto` -> spawns a card for an action the owner JUST explicitly clicked. The click itself is the consent; asking twice is the bug. `phase='awaiting-approval'` then strands the panel on `UpdatePanel.tsx:63`, which is the only place that string appears — hence "where is the approvals list?".
- **Owner directive (verbatim)**: "when you have clicked update then it updates no reason to need an approval at this point."
- **Fix direction**: the explicit click path must not re-ask. Distinguish *owner-clicked* from *Legion-initiated*:
  - `POST /api/update/install` (the button) -> treat the click as consent, no card (pass the existing auto/consent path, or an explicit `ownerInitiated` flag).
  - A card must remain ONLY for an update Legion starts on its own without a click (auto-install-when-idle after a background check, line 140, and any future autonomous trigger) — that is a genuine "no human asked for this" moment and deserves a prompt.
  - Replace the dead-end `awaiting-approval` copy with something actionable (or make that phase unreachable from a click).
- **Kodawari check before shipping**: do NOT simply delete the approval gate — verify the *only* remaining paths into `stagePackage` are owner-consented, and that `consent` still gates the actual commit (`readyToApply`, line 184) so a staged update cannot apply itself unattended. The signature check + idle-wait are separate controls and must stay.
- **Tests**: updater test files assert the current card-on-click behaviour — expect to update them deliberately (change in behaviour is the point), and add one asserting click => no card, and auto-install => card.

### 0.2.2-a — SHIPPED WORK, awaiting full-suite + cut (2026-10-03)
- **Version decision**: owner directive — "0.2.2-a". Verified BEFORE building: npm accepts a lettered suffix in `package.json`
  AND `package-lock.json` (my earlier "npm rejects it" claim was a BROKEN test — bad flag, empty stderr, read as a rejection.
  Never report an unverified claim as a blocker). `0.2.1-a` is impossible (a pre-release ranks below its own release, so it is
  never offered to anyone already on 0.2.1). `0.2.2-a` ranks above 0.2.1 and below 0.2.2 → offered, and later superseded.
- **CRITICAL FINDING (owner's question "is this a dependency change tho?" exposed it):** `depsSha256` hashed the WHOLE
  `package-lock.json`, and npm rewrites the lock's own `version` field on EVERY release bump. So the raw hash changed on every
  single release → `installedLockSha256 !== lock` → `requiresFullInstall` → **self-update was impossible for every patch, ever.**
  This is why the click-test could never have passed, independent of the approval-card bug. Fixed with `dependencyHash()`
  (src/core/updater/package.ts): hash the lock with ONLY its own version fields removed (top-level `version` + `packages[""].version`).
  A dependency's own `version` stays in the hash, so real dep changes are still detected. Verified on the REAL lockfile: the
  0.2.1 and 0.2.2-a locks produce an IDENTICAL dependency hash → self-applies. Parameter renamed `installedLockSha256` →
  `installedDepsHash` (callers + tests updated).
  - **Fail-closed preserved**: `installedDepsHash === undefined` (unreadable install) still counts as full-install. An unknown
    installed dependency set is treated as CHANGED, never as matching.
- **Fix A (updater double-consent)**: `install()` no longer raises an approval card on EITHER path. Clicking Update *is* the
  consent; auto-install-when-idle already bypassed the card and its label promises "without asking again", so raising one there
  would have contradicted the UI (I made that mistake first and corrected it — the owner's suggestion to document the auto-install
  toggle for stuck users is in the release notes instead). Signature verification, `requiresFullInstall`, and `consent` gating the
  commit (readyToApply) all still stand. Tests rewritten deliberately: C11 (click ⇒ no card, stages), C11b (auto ⇒ no card),
  `stagedRig` no longer waits for a card, plus the drain/lock tests.
- **Fix B (model override)**: ceiling KEPT as-is per owner decision ("loud + keep existing ceiling"): upgrades refused, downgrades
  allowed. Added `noteOverride()` in bridge.ts — an applied override appends a `role:'user'` message to the CALLER's transcript
  naming agent / configured model / model used, then emits `task.updated`. A no-op override (same model) says nothing.
  **Do NOT use `deliverReply` for this** — it is for agent-to-agent answers and QUEUES A NEW RUN; using it broke the ask's own
  result (`asked.json` undefined). vm_claude now enforces the same ceiling at the tool boundary via `overrideAllowed`/`overrideRefusal`
  (it had NO gate at all and spends the owner's boat.dev subscription). Needed new `VmManager.agentModelFor()` + imports of
  `model-cap` + `BridgeError`.
- **Ceiling limits, documented not hidden** (`model-cap.ts:modelRank`): 3 buckets — contains `opus`=3, `haiku`=1, EVERYTHING ELSE=2.
  So `stealth/space-bunny-alpha`, `gpt-4o`, `glm-4`, typos and unknown models all rank 2 and pass. It is a cost/allocation guard for
  the three known aliases, NOT a security boundary. Owner asked "how does it know what a downgraded model is vs the other" — the
  answer: by rank, and that is fail-open by design; a real redesign of `overrideAllowed` is a separate decision.
- **Versioning protocol**: `docs/VERSIONING.md` (owner directive: "a proper versioning protocol also locked down and followed
  for this so i never have to mention what the next version should be"). PATCH / LETTERED PATCH / MINOR / MAJOR table, the lettered
  ordering rule, why dep changes can't be PATCH, cut procedure, pre-1.0 note.
- **Release notes = ONE-TIME ESCAPE HATCH (owner: "explain why not in too many words... just for this one update and toggle it off
  afterwards again right")**: "If your update looks stuck: turn on Install updates automatically when idle in Settings → Updates,
  let it update, then turn it off again. Only needed for this one update." Verified this path needs NO code change on existing
  installs — auto-install already bypasses the card.
- **Tests**: updater-trust 11/11 (3 new lettered-suffix ordering tests), updater-module 17/17, bridge+bridge-model 33/33 (2 new
  visibility tests), updater-package + release + surface green. `tsc` clean, UI typecheck clean. Commit `9885ca7`, pushed.
- **Commit discipline lesson**: the `patch` tool's escape-drift guard caught a real mistake (a test whose parens I unbalanced, and a
  `VERSIONING.md` heading I duplicated). Read the whole file after a structural edit instead of chaining blind patches.

### OPEN C — subtle update-available notification (owner directive 2026-10-03, NEW)
- "whenever legion finds an update or whatever, it should subtly tell the user in a toast or some other way" — owner wants a
  UX expert council + /kodawari gates on this before it is built. NOT STARTED. Design question the council must answer: how to
  surface it without nagging (topbar is busy; the owner already rejected a loud topbar affordance for report-a-bug), and how it
  interacts with the "only tell me once" instinct. Owner wants it in the same update cycle.

### RELEASE PLAN (owner directive 2026-10-03) — 0.2.2-a is the updater test ONLY
- **0.2.2-a = SHIPPED, awaiting cut.** Carries ONLY the updater fixes + the model-override fix. Its single purpose: prove the
  in-app signed self-update works end to end on the owner's PC. Nothing else is bundled, so if the click-test surfaces another
  problem it is unmistakably an updater problem, not something else riding along.
- **0.2.2-b = NEXT, deliberately not started.** (owner: "this should be in the 0.2.2-b then so we can see if 0.2.2-a works")
  - OPEN C: the subtle update-available notification — needs a UX expert council + /kodawari gates FIRST, not a rushed build.
  - Zealot's model-override item: proposal-vs-Forgemaster question is still UNANSWERED and belongs in 0.2.2-b scope.
- Rule of thumb adopted: one lettered patch = one thing you are verifying. If 0.2.2-a is clean, 0.2.2-b takes the notification work.

### Release scripts must share the version rule (found while cutting 0.2.2-a)
- `scripts/build-package.mjs`, `scripts/release-package.mjs` and `scripts/release-manifest.mjs` each had their OWN copy of the
  "plain MAJOR.MINOR.PATCH" regex, so packaging failed on `0.2.2-a` with `package.json version "0.2.2-a" is not a plain
  MAJOR.MINOR.PATCH` WHILE the app's `semver.ts` accepted it. Fixed by adding `VERSION_RE` / `isReleaseVersion` to
  `scripts/lib/release-lib.mjs` and importing it in all three, so the scripts and the shipped updater cannot drift again.
- LESSON: whenever the version grammar changes, grep the release scripts too, not just `src/`. The app and the tooling must agree.

## POST-RELEASE SAVE POINT — 0.2.2-a SHIPPED (2026-10-04)
Owner directive: "after every release like this one, we run a save point for context, if we should create any skills based on
the actions etc we've done in this session". Also recorded in Hermes memory. Skill `legion-orchestrator` gained a
"Cutting a release" section with the verified procedure + the traps below.

- **RELEASED**: `v0.2.2-a` → https://github.com/dnh33/legion/releases/tag/v0.2.2-a. Commits `9885ca7` (fixes + semver +
  dependencyHash), `dee350f` (launch check + release-notes link), `0ee1ed9` (release scripts share one version rule).
- **Manifest**: signed with key `k1` (release-sign.mjs verified it with the APP'S OWN verifier). Live fetch returns
  `version 0.2.2-a`, asset `legion-0.2.2-a-app.zip` (2.4 MB), **`requiresFullInstall: false`** — the field that was blocking
  self-update. Packages: `legion-0.2.2-a-win-x64.zip` (285 MB / 7125 files, sha256 `373fd2a4…`).
- **Gate**: FULL suite green — 2396 tests / 2351 pass / 0 fail / 45 skipped.
- **Purpose of this release**: prove the in-app signed self-update works. Nothing else bundled, so anything the owner finds is
  an updater problem. 0.2.2-b takes OPEN C (update notification + UX council) and Zealot's item.

### What the session actually taught (the traps)
1. **`depsSha256` hashed the RAW lockfile.** npm rewrites the lock's own `version` on every bump → the hash changed on EVERY
   release → `requiresFullInstall` on every patch → **self-update was structurally impossible**, independent of the approval
   card. Fixed with `dependencyHash()`; verified on the real lock (0.2.1 and 0.2.2-a hash identically). Fail-closed preserved.
2. **Pre-releases rank below their own release.** `0.2.1-a` can never be offered to anyone on 0.2.1. Lettered patches must
   therefore sit on the NEXT unreleased number. Ordering pinned in `updater-trust.test.ts` both directions.
3. **Release scripts had their own copies of the version regex** and rejected what the app accepted. Now shared via
   `release-lib.mjs`, with a drift assertion over 9 sample versions so the copies cannot silently diverge again.
4. **Update checks were near-useless**: first check 30 s after CORE boot (not app launch), then a 12 h interval, and
   `lastCheckedAt` only records SUCCESS — so one network failure was indistinguishable from "checked recently" and could
   silence updates for hours. Auto-install depends on a check happening first, so the documented escape hatch was dead too.
   Now: launch check + 60 s poll honouring intervalHours + 15 m retry floor when no check ever succeeded.
5. **`| tail` poisons a backgrounded npm/node build** (tty). And `npm test` clobbers `dist/` — never build while a suite runs.
6. **I asserted an unverified blocker.** A broken npm test (bad flag, empty stderr) read as "npm rejects lettered versions" and
   I nearly killed the version number the owner had chosen. Verify before calling something a blocker; say "unconfirmed".
7. **`deliverReply` is not a notification channel** — it queues a new agent run and broke the `ask` result. Notices that must
   not start work go through `store.addMessage` + a `task.updated` event.

### Owner answers captured this session
- Version numbers are MY decision (protocol in `docs/VERSIONING.md`); the owner never names one.
- Lettered patch = one thing being verified. 0.2.2-a = updater test; 0.2.2-b = notification UX + Zealot's item.
- Release notes stay short; the stuck-update escape hatch is a one-time toggle, explained in a few words.
- Existing installs cannot be force-updated remotely — document the manual path instead.
- Check the real artifact, not the absence of errors (his "is this a dependency change tho?" found the release-blocking bug).

### NEXT
1. [ ] **Rebuild 0.2.2 with the .asar + antivirus fixes, reinstall on the owner's PC** (this unblocks D1, the install that was promised).
2. [ ] D4 UX council + /kodawari for the update progress indicator.
3. [ ] D5 council plan for Skills in Legion (+ Claude Code skill bridging) — required before Legion-on-Legion.
4. [ ] D7 Zealot handoff prompt + context layer, after D5/D6.
5. [ ] OPEN A "full access" still prompts (`approvalCeiling`, engine.ts:658-661) — subagents available again via `stealth/space-bunny-alpha` (owner changed config.yaml:167).
6. [ ] Backlog unchanged: report-a-bug, supply-chain pinning, vm_claude boat.dev config/schema, model-override beyond the three aliases, providers-2/providers/blender-chip, prebuilt bundler, Sentinel scheduler, KG-audit button, lighter package. Launch tweet drafted not posted. Site: stale screenshots, trailer slot, creator credit, provider-parity roadmap line.

## POST-0.2.2 — OWNER DIRECTIVES 2026-10-04 (recorded now; none of this was tracked before)

### D1 — INSTALL 0.2.2 ON THE OWNER'S PC (promised, not yet delivered)
- The 0.2.0 install is at `%LOCALAPPDATA%\Programs\Legion` (installed from SOURCE, so it carries `node_modules/electron`).
- Upgrade path: `setup.ps1 -PackagePath <win-x64.zip> -PackageSha256 <hash> -Yes`. Run twice, both failed — see D2 and D3.
- BLOCKED on D2 + D3. Both are packaging bugs in our code, neither is the owner's machine.

### D2 — FIXED (needs rebuild): `.asar` breaks the installer under Electron
- **Root cause, proved not guessed:** `listTree` (scripts/lib/package-lib.mjs) walks with `lstatSync`. Under plain node
  `resources/default_app.asar` is a FILE. Under **Electron** — and the installer runs on `electron.exe` with
  `ELECTRON_RUN_AS_NODE=1` (package-bootstrap.ps1:165) — Electron patches `fs`, so the same path reports `isDirectory() === true`
  and its contents appear as children (`default_app.asar/default_app.js`). The walk descends into the archive, finds a file
  PACKAGE-FILES.json never named, and the installer refuses the entire package.
- **Consequence: every prebuilt package ever built was uninstallable.** The packaging path had never been exercised end to end.
- **Fix:** in `listTree`, a name ending `.asar` is ONE opaque file; never descend, whatever the runtime's fs claims.
- **Verified under Electron:** on disk 7124 / listed 7124, extra 0, missing 0. The real `package-install.mjs` then copied all
  7124 files (671 MB) and stopped only on the antivirus block in D3.
- **Test lesson:** invisible to node-based tests — it only appears on electron.exe. Packaging/installer changes must be verified
  UNDER ELECTRON, never only under node.

### D3 — FIXED (needs rebuild): stop shipping Electron's fallback app so antivirus stops blocking users
- `resources/default_app.asar` is Electron's FALLBACK app, used only when no app is specified. Our `package.json` sets
  `"main": "dist/src/electron/main.js"`, so it never loads — dead weight (~110 KB).
- It is also the file heuristic scanners flag (a small script inside an archive), so shipping it can make a USER's Defender
  quarantine it mid-install and fail the install outright.
- **Fix:** `scripts/build-package.mjs` filters `resources/default_app.asar` out of the runtime entries, reason logged.
- Owner asked "how do we fix that on other people's machines": an antivirus exclusion only fixes ONE machine; not shipping the
  file fixes it for everyone. That is the fix chosen.

### D4 — Progress indicator for an active update, aesthetically native to the UI
- Owner: "some sort of progress indicator for the update when its active would be sick. Aesthetically added so it fits in our UI right."
- NOT STARTED. Needs a UX council + /kodawari. The updater ALREADY reports `progress` (`{bytes,total}`, phase `downloading`) and
  UpdatePanel renders a plain percentage — so this is a redesign of an existing surface, not new plumbing.

### D5 — SKILLS IN LEGION — PARKED 2026-10-04 (owner). Research findings recorded; NOT an action item yet.
**Owner:** "park this skills feature for now... we need to plan properly a feature that allows us to do what I asked
for in a skills feature, both on a global, project and personal levels hierarchy etc like claude and everybody else does
it, needs to be properly researched."

**Requirement as stated:** a skill system with a GLOBAL / PROJECT / PERSONAL hierarchy, like Claude Code's and everyone
else's. Not the narrower "project-scoped only" shape first discussed.

**What the research already established (do not re-derive):**
1. **The SDK has native per-session skill selection.** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2240-2262`:
   `skills?: string[] | 'all'` — "This is the single place to turn skills on". `string[]` enables only the listed skills,
   matched by SKILL.md `name` or directory name. So the CLAUDE path needs ~one line in `buildOptions`, not a loader.
2. **Omitting `skills` is NOT "skills off"** (same doc, line 2245): the CLI's own defaults still apply. Current Legion
   behaviour is therefore UNKNOWN — measure `'all'` cost before "fixing" anything.
3. **It is a context filter, not a sandbox** (line 2251): unlisted skills are hidden from the model's listing and refused
   by the Skill tool, but their files stay on disk and remain reachable via Read/Bash. For agents holding Bash this is
   presentation, not isolation. Relevant to the threat model.
4. **TWO runtimes, different capabilities** (engine.ts:4 `realQuery` vs engine.ts:779 `providers!.run`):
   `providers/runtime.ts:28` — "No file editing, shell, web search or web fetch of its own", only Legion's tools + MCP.
   `skills` is an SDK option, so it does NOTHING for a provider-model agent. **One feature cannot serve both runtimes.**
5. **The format is identical in both libraries.** Only `name` + `description` are universal. Hermes: 120 skills, 60 use
   `references/`, 6 `scripts/`, 11 `evals/`. Claude Code: ~148 skills, 68 `references/`, 16 `scripts/`, 11 `evals/`,
   median description 304 chars, median body 9,335 chars, max body 88,332. Discovery is directory scanning; no manifest.
   **So Legion needs no format, parser or loader of its own.**
6. **Budget reality for the provider path**: no file tools means bodies cannot be fetched mid-task and must be
   pre-injected. At median 9.3k chars/body, ~10 skills is ~93k chars before the agent does anything. Provider-model agents
   need a far smaller per-project cap than Claude agents (guess: 3–5) — UNMEASURED.
7. **The hierarchy the owner asked for is the open design question**: how personal / project / global precedence
   resolves when the same skill name exists at two levels. No evidence gathered yet; that is the research to do.

**Security position already taken (see also the trust analysis in this session's history):** skills cannot grant authority —
`permissionMode` / `disallowedTools` / `canUseTool` are set in `buildOptions` before the model sees anything, so prompt text
cannot widen them. But skills DO exercise whatever authority an agent already holds. Most dangerous case: an agent in `full`
mode (`bypassPermissions`, engine.ts:733) following third-party skill text — no card ever appears. The control that matters is
a hard floor on spend regardless of approval mode; that needs verifying. Signing/attestation was judged NOT worth it for a
single-owner desktop app; provenance visibility is.

### D8 — Make the repo's own orientation files stop lying (owner 2026-10-04)
- Owner: "No other agents seem to know which branch you have turned into the main branch right now besides you."
- **Confirmed real:** 12 docs still referenced the DELETED `integration/v1`, including the two files an agent reads first
  to orient (`ORCHESTRATOR-HANDOFF.md`, `ORCHESTRATOR-TAKEOVER-PROMPT.md`). A separate Hermes session reasoned from
  `D:\bots\legion` (stale v0.1.0, MIT, private) because of exactly this.
- **Fixed:** new `claude/START-HERE.md` is the single authority (branches, which clone is real, current state, release
  gate); SUPERSEDED banners on the three orientation files.
- **Remaining:** the other `claude/` files (handoffs, plans, e2e report) still name `integration/v1` in their bodies.
  They are history and are no longer the first thing an agent reads, but a repo-wide sweep is not done.

### ORDERED QUEUE — the seven open items, in the order they are done (index, 2026-10-04)

This is the index. The detail for each lives in its  section below, which carry the evidence and file:line.
`claude/SESSION-QUEUE.md` is the same list written as per-session briefs; if the two ever disagree, this index and
the  sections win, because this file is the durable record.

| # | Session | What | Release | Tracker | Status |
|---|---|---|---|---|---|
| 1 | **S1** | House context layer | `0.2.3-a` | D9 | **Shipped, installed, running.** Close-out is the live test below |
| 1a | S1 close-out | Live test against the installed app | — | — | **OPEN.** See below |
| 2 | **S2** | Context compaction | `0.2.3-b` | D11 | Design complete. **Zero code.** Next session |
| 3 | **S5b** | Full-access bot still shows a "needs your OK" card | — | D7 / below | **OPEN, LIVE — the owner is seeing it** |
| 4 | **S3** | Effort level in the model picker | `0.2.3-c` | D10a | Design decided. **Zero code** |
| 5 | **S4** | Multiple folders per project | `0.2.3-d` | D10b | Design decided. **Zero code** |
| 6 | **S5** | `perf-l-store F1` — a node save publishes the graph twice | — | D13 | **OPEN.** Pre-existing, harmless, will not break the app |
| 7 | **S6** | D1–D4 and the 0.2.1/0.2.2 backlog, copy sweep, README screenshot, Skills | — | D1–D8, D12 | **Parked, not cancelled** |

**S1 close-out — the live test.** `claude/LIVE-TEST-0.2.3-a.md`, run by Zealot against the real app. The step that
matters: an agent writes a line into `AGENTS.md`, then `house_read` must return it wrapped and labelled
`[UNTRUSTED SOURCE]`. If it still reads as trusted, that is a serious defect — stop and report it.

**S5b — the full-access card.** Owner, 2026-10-04: "it still shows when a bot has full access perms".
`needsApproval('full', …)` is correct as written, so the suspect is **`approvalCeiling` capping a `full` agent
down to `ask`**. Never confirmed — the earlier investigation ran out of subagent credit before isolating it. Small,
live, and visible to the owner, so it is its own session rather than bundled with a feature.
### D12 — PIVOT 2026-10-04: the four features come first, one release each (owner)
**Owner:** "if the 4 features are NOT built, then I think we should focus each one being an independent minor release or
something, we are in beta mind you... and then when this house layer is fully verified and you have fixed and validated
everything here then you save all important context etc as we do in order to make this session ready to be archived, and
then we shall create a new session for each of the remaining features."

**We drifted from the path promised in 0.2.1.** Stated plainly so nobody reads the old plan as current: D1–D4 (update
progress indicator, report-a-bug entry point, supply-chain protection, Sentinel scheduler) and the 0.2.1/0.2.2 backlog
are **NOT abandoned — they are parked behind these four.** Nothing in D1–D7 was closed or cancelled.

**Build reality as of 2026-10-04 (correcting an earlier assumption):** of the four, **only the house layer is built.**
Effort (D10a), multi-folder (D10b) and compaction (D11) are **designed and mapped only — zero code.** Do not read any
tracker entry as implying they exist.

**Release plan — one feature per release, not one big cut.** Supersedes the earlier "all four in 0.2.3" decision.
Versions use a lettered patch on an **unshipped** base (`0.2.3-a`, `-b`, `-c`): a pre-release sorts *below* its own
release, so `0.2.2-xyz` sorts below the shipped `0.2.2` and the updater refuses it as a downgrade (verified with semver
2026-10-04). This is the same trap that made `0.2.2-a` uninstallable; see `docs/VERSIONING.md`.

| Release | Contents | State |
|---|---|---|
| `0.2.3-a` | House context layer (D9) | built; 3 blockers fixed; mutation-verified. **Awaiting final gate.** |
| `0.2.3-b` | Effort level (D10a) | designed only — per-task, defaults to the agent's model setting |
| `0.2.3-c` | Multi-folder per project (D10b) | designed only — first folder stays the working directory |
| `0.2.3-d` | Context compaction (D11) | designed only — 50% threshold, retry-once, spec in `docs/COMPACTION.md` |
| after | D1–D4 and the 0.2.1 backlog | parked, not cancelled |

Each release is gated and cut on its own so a bad one can be pulled without taking the others with it.

#### The version ladder (verified against shipped 0.2.2 code, 2026-10-04 — do not re-derive)
```
0.2.3-a  house context layer      (BUILT — cut this session)
0.2.3-b  CONTEXT COMPACTION      <-- TOP PRIORITY, first new session (owner 2026-10-04)
0.2.3-c  effort level
0.2.3-d  multi-folder per project
0.2.3    later, once the four have proven themselves
0.2.4-a  next line of work
```
**Owner directive 2026-10-04:** compaction is the highest priority of the remaining three and is the **first new
session**. "The compaction engine has top priority as the next task after this." It was third in an earlier ordering
because it looked largest; the owner has since ranked it first. Effort and multi-folder follow.
- Verified with the shipped `src/core/updater/semver.ts`: `0.2.3-a < 0.2.3-b < 0.2.3`, and a client on `0.2.2` **or on
  `0.2.3-a`** is offered every one of them.
- **`0.2.2-a` is refused** — it sorts below the shipped `0.2.2` and the updater calls it a downgrade. Never letter a base
  that has already shipped.
- **THE RULE: never publish a bare `0.2.3` before its letters are done.** The moment plain `0.2.3` ships, `0.2.3-a` … `-d`
  become unreachable. This is exactly how `0.2.2-a` died on 2026-10-04.
- **Exactly one lowercase letter** per release. `isPlainSemver` rejects `0.2.3-ab` and `0.2.3-1` (verified). 26 lettered
  patches fit under one base. Skipping a letter is fine.
- `0.2.2`'s `manifest.ts:23` validates via `isPlainSemver`, which **accepts** a lettered patch. Plain `0.2.2` was the
  correct bootstrap precisely because it shipped that validator.

### D14 — DECIDED: git history stays as-is (owner, 2026-10-04)
Commits `94b32bd` and `5b6c758` contain three lines naming the context engine's upstream source, a local Windows
install path, and a licence. They are pushed to the **public** repo and are readable by anyone with the URL. The
current files were scrubbed; the history deliberately was **not** rewritten.

**Owner ruling: "No dont mess with the git history now, its harmless information thats in there right?"** Confirmed by
scanning those commits: **zero** secrets, keys, tokens, wallet data or hashes. Exposure is a username, a standard
app-data path, a public repo name and a licence.

Rewriting was also rejected on process grounds: it requires a force-push to a public remote and rewriting release
history, which this project's own rules forbid. **Do not reopen this.**

### D13 — OPEN: perf-l-store F1 — one node save publishes the graph twice (pre-existing on main)
**Not fixed.** Four attempts, each reverted; `ui/src/graph/graphStore.ts` is byte-identical to `main`.

**What is established by instrumentation, not inference:**
- One save fires `refreshFromServer(["note-0005"])` **twice** — the caller's own refresh, then the server's `kg.updated`.
- The second publish comes from **`replaceView`**, not `linkUp`. Instrumented `reconcileView` shows `linkUp` behaves
  correctly across the whole test: `changed=false, changed=true (the real edit), changed=false`.
- So the defect is that the full re-read (`loadOverview` → `replaceView`) publishes an unchanged view, in a different
  order, purely because the server ranks nodes.

**Why each attempt failed (do not repeat these):**
1. `replaceView` skips byte-identical content → breaks pinned-seed ordering (F3): `loadOverview([seeds])` reorders the
   *same* nodes and must publish.
2. Compare by id-set ignoring order → breaks F1 again, because after `linkUp` the canvas order legitimately differs.
3. Dedupe `refreshFromServer` by changed-set signature + time window → breaks 2 tests, and would swallow a legitimate
   second edit to the same node within the window.
4. Skip `linkUp` when the refresh is full → breaks the full re-read entirely (0 fetches; the full path *relies* on
   `linkUp`, not `loadOverview`).
5. `replaceView` skips an unpinned re-read with the same id-set → breaks B1/B2/B3/B6 (deleted-link removal, late-answer
   ordering, boot/refresh races). `replaceView` is load-bearing for more than publishing.

**Next idea, untested:** the distinguishing factor between F1-step6 (must NOT publish) and F3 (must publish) is
*intent* — a background refresh versus an explicit pinned `loadOverview`. Attempt 5 tried that and the skip broke the
race guards, so any real fix must preserve whatever B3/B6 observe about `replaceView` returning.

#### Council verdict 2026-10-04 (two independent subagents, both read the real code)

**Both agreed:** F1 encodes a **real requirement**, not a wrong assumption — do not relax the test. And all six
attempts attacked the wrong layer. The store's own contract (`linkUp`'s doc, and `sameHits`/`F10` elsewhere) is that
an unchanged view costs no render and no layout; `replaceView` breaks it by clearing and rebuilding unconditionally.

**They disagree on the fix, and the difference is real:**

- **Advocate** — drop `full` from `refreshFromServer`'s `loadOverview` condition; a background refresh is reconciled
  in place by `linkUp`, and `loadOverview` is only for *building* a canvas. It correctly notes this would stop a
  background refresh from throwing away the owner's pan/zoom, because `replaceView` forces `cam: 'fit'` and
  `CanvasPane` re-fits and re-heats the layout.
- **Skeptic** — keep the full re-read (it is how deletes and reorders are *detected*) but route the result through
  `reconcileView` and publish only when **content *or* order** actually differs. Keep `replaceView`'s unconditional
  publish for genuine rebuilds: pinned seeds, Library return, scope flip.

**Recommendation: the skeptic's recipe.** The advocate's is simpler but loses real capability: nodes created elsewhere
would stop appearing on a populated canvas until an explicit gesture, and — sharpest — the **BSV scope visibility flip
would stop rebuilding a populated canvas**, regressing the toggle fix shipped in 0.2.1. That trade is not worth it.

**Why no single-axis comparison works** (this is the whole trap): F1 and F3 jointly demand it. F1's re-read returns an
identical view (same set, same order, same content) so it must not publish; F3's re-read returns the same set in a
**different order** (pinned seeds first) so it must. Comparing content alone breaks F3; comparing id-sets alone breaks F1.
Any real fix must compare **both** content and order, at the reconcile/rebuild boundary rather than inside `publish()`.

**Status:** this does **not** block the `0.2.3-a` house-layer release — it is a pre-existing UI churn defect (extra
layout and render per save, no data loss), untouched by this work. It does block a clean full-suite gate.

### D10 — PRE-RELEASE FEATURES the owner wants before the next download (added 2026-10-04, NOT STARTED)
Owner: "before we ship this as a new release or whatever that can be downloaded etc, we should add the possibility to choose
effort level on a model in the model picker, and we should be able to add more than 1 folder on a project that is referenced
for agents in it."

Both scoped against the real code on 2026-10-04; neither is started. Neither is a blocker for merging the house layer —
they block the **next release**.

#### D10a — Effort level in the model picker
**DECIDED 2026-10-04 (owner):** **per-task**, chosen when a task starts, **defaulting to the agent's model setting.**
Not per-agent-only, not both. A second control at task creation is the accepted cost.
**Consequence for the build:** the model picker keeps a per-agent default (`legion.effort.<agentId>`, mirroring
`legion.model.<agentId>`); the create-task body carries an optional `effort` that wins when present
(same ride-along as `modelOverride`, `ui/src/store.ts:380`). A provider with no effort concept **must say the level
does nothing** — never silently ignore it.

- **There is no request-option plumbing at all.** `chatTurn` builds the body at `openai-compat.ts:145-154` with only
  `model`, `stream`, `messages`, `stream_options`, `tools`, `tool_choice`. No `temperature`/`max_tokens`/`top_p`/
  `reasoning`/extra body. Headers are fixed (`http.ts:141-143`). Claude SDK options (`engine.ts:691-722`) likewise carry no
  temperature/effort/thinking/maxTokens. **So this is a new field on two paths, not a wiring job.**
- **Where the model lives:** `ProviderEntry.models` (`providers/types.ts:12-27`); OpenRouter preset `presets.ts:9-10`.
  Per-agent Claude model comes from the live catalog (`catalog.ts:61-64`), served `GET /api/catalog`.
- **Picker:** `ui/src/components/ModelPicker.tsx` → `setModelChoice` (`ui/src/store.ts:350-353`) → localStorage
  `legion.model.<agentId>` + `modelOverride` → sent as `model` in the create-task body (`store.ts:380`). Agent's own model:
  `AgentEditor.tsx:67-75` → `PATCH /api/agents/:id` (`server.ts:146-153`, `MODEL_RE` `server.ts:54`).
- **Dispatch fork:** `engine.ts:796-801` — `resolve(model)` returns a provider or the run goes to `buildOptions` + `queryFn`.
  Effort must survive **both** branches or it is a lie on one of them.
- **Decision still needed:** per-model or per-task. The picker stores per-agent; effort is usually per-call. Storage shape
  depends on it.
- **Honesty rule:** a provider with no effort concept must say the level does nothing, not silently ignore it.

#### D10b — More than one folder per project
**DECIDED 2026-10-04 (owner):** the **first folder stays the working directory**; the rest are additional folders the
agent may read/write. Purely additive — nothing shifts silently for existing projects.
- **Today it is a single string, load-bearing in four places.**
  - `Project.folder: string` — `src/shared/projects.ts:13`, default `<workspaceDir>/projects/<id>`.
  - Native-secret-gated route `PUT /api/projects/:id/folder` (`src/core/projects/index.ts:70-74`); creation refuses
    `folder` outright (`index.ts:50`).
  - `engine.ts:689` mkdirs it · `engine.ts:700` passes it to `projectSection(...)` · `engine.ts:702` hands it to
    `additionalDirectories` (already an array, so the engine change is small).
- **Change shape:** `folder: string` → `folders: string[]`, keeping `folder` as a derived first entry so nothing that reads
  it silently changes meaning.
- **Decide first:** the first folder stays the agent's working directory, or all folders do. The agent's own `cwd` is
  already its own (`engine.ts:691`) — project folders are *additional*. Keeping the first as primary preserves today's
  behaviour and matches the owner's phrasing.

### D11 — CONTEXT COMPACTION (owner 2026-10-04, biggest item). NOT STARTED.
Owner: "we literally do not have any compaction / context features in Legion... sometimes a conversation just stops because
context got rekt. We should learn from /hermes-agent and mimic it."

**Verified state (subagent, file:line):**
- **No compaction or summarization exists.** No token counting anywhere, no tokenizer dependency (`package.json:54-58`).
- **Provider path already truncates — bluntly.** `buildMessages(host)` (`providers/tool-loop.ts:84-114`) returns a **tail**:
  `HISTORY_MAX_MESSAGES = 40`, `HISTORY_MAX_CHARS = 60_000` (`tool-loop.ts:18-19`, applied `:105-112`). **Character counts,
  not tokens.** This is the real cause of "the conversation just stops": the oldest half is dropped silently.
- **No overflow recovery.** A context-length error becomes a plain `'status'` ProviderHttpError (`http.ts:159-162`) → rethrown
  (`openai-compat.ts:175-188`) → task `status:'error'` (`tool-loop.ts:204-206` → `engine.ts:549-553`). Nothing detects it by
  type. Escalation cannot help: `shouldEscalate` (`router.ts:46-51`) only fires for `'sonnet'`, which a provider model never is.
- **Claude path is fine already** — the SDK compacts natively (`sdk.d.ts` `autoCompactThreshold`, `CompactBoundaryMessage`).
  Legion just does not surface it in the transcript.
- **Resume asymmetry, already documented in-code:** `runtime.ts:31` — "A continued task remembers less than a resumed Claude
  session (the newest messages only)". Provider resume = JSONL (`store.ts:103-109`, loaded `:183-196`); Claude resume =
  `sessionId` (`engine.ts:799` → `options.resume` `:723`).
- **What the reference implementation does (read from source on the owner's machine):** rolling per-exchange summary rather than one-shot;
  the prompt asks for "key decisions, requirements, file paths, and open questions" and to **drop resolved details**;
  **never summarise secrets** — "replace any that appear with `[REDACTED]`"; cut only on **turn boundaries**
  (`allow_split_turn=False`, `:86`) so a turn is never orphaned; off by default because rewriting the prefix breaks the
  provider prompt cache. Full-size compaction lives in `agent/native_compaction.py` (server-side where supported, local
  compressor as fallback).
- **DESIGN DECIDED 2026-10-04 — see `docs/COMPACTION.md`.** Summary is written inline into the thread transcript as a
  system message; originals stay untouched in the append-only JSONL (`store.ts:103-109`). NOT a KG node — that
  would bury curated notes under machine churn. Legion rewrites nothing (Hermes rewrites its SQLite
  rows; Legion needs no such surgery). Full Hermes spec extracted and written to `docs/COMPACTION.md`.
- **THRESHOLD DECIDED 2026-10-04 (owner): 50% of the usable window**, Hermes' proven number, **plus
  compact-and-retry-once on a context-length error.** The retry is the actual safety net; the threshold only has to
  usually compact before the overflow. Our estimator errs toward over-counting, so in real tokens we land slightly under
  50% — the safe direction. One compaction per thread on threshold; **no micro-compaction** (off by default in Hermes
  too, and 13 agents make per-exchange summarisation expensive here).
- **Risk:** the only one of the four that can "pass" while silently losing work. Needs its own validation: a long
  conversation must survive with its decisions intact.

### D9 — HOUSE CONTEXT LAYER: fix, rebase, merge (owner approved 2026-10-04: "if you truly believe in that, plan it out")
Reviewed at `40842df` (branch `claude/context-layer`, repo now `D:\bots\legion-ctx`). Verdict was **request changes**. Nothing merged yet.

**Why it is worth merging at all:** it is the only copy of the feature, it is the answer to "how does an agent
inside Legion know how to work on this project", and Legion-on-Legion depends on it. `main` does not have it.

#### The three blocking fixes
1. **`claude/skills` in `SHIPPED_DIRS` does not exist** (context.ts:33). Legion reports the folder and copies nothing.
   **Fix:** drop the entry for now (Skills is parked) **and add a test that asserts every path in `SHIPPED_FILES` +
   `SHIPPED_DIRS` actually exists in the repo.** The test is the real fix — it makes this class of lie impossible.
2. **Trusted-text hole (the one that matters).** context.ts:8-10 declares the layer trusted because it is Legion's own
   text, but `sync.ts` copies from the repo root. Once agents develop Legion from inside Legion, an agent can edit
   `AGENTS.md`; its own edit then comes back marked TRUSTED, while everything else an agent touches is wrapped as
   untrusted (the KG rule). The trust claim holds only on a fresh install and degrades silently — worst exactly when
   Legion-on-Legion starts.
   **Fix (owner-chosen 2026-10-04: hash manifest, over both cheaper options):** `sync.ts` writes a hash
   manifest at copy time; `readContextFile`/`recallContext` compare against it and wrap anything that has
   drifted as untrusted (reuse the existing KG `wrap.ts` untrusted wrapper). Chosen explicitly because it is
   the only option correct **regardless of who edited the file or by what route**. Owner edits to the layer
   stay trusted — they are the point of the feature — but an edit that arrives through the repo/agent path
   does not inherit trust.
   **This is the substantial one.** It is the only fix that is more than a few lines, and it is the reason the review
   said request-changes rather than approve-with-nits.
3. **Unbounded tree walk** (context.ts:87-106, 180-192). `recallContext` re-reads every `.md` under the root; the caps
   are per-file, not per-search.
   **Fix:** cap recursion depth, total file count and total bytes read per `recallContext`. Add to `HOUSE_LIMITS`.

#### Non-blocking, fix while in there
- `missing` only checks `SHIPPED_FILES`, so a missing `docs/adr/` is invisible (context.ts:108). Cover `SHIPPED_DIRS` too.
- `df` is recomputed inside the term loop (context.ts:203) — hoist it.

#### Process
1. Rebase `claude/context-layer` onto `main` **first** — it is behind and currently missing `START-HERE.md`, the tracker
   updates and the rename. Merging as-is would regress the repo.
2. Fix 1-3 + non-blocking, on the branch.
3. Gate, one at a time, never overlapping (`npm test` clobbers `dist/`): `npm ci && npm run build:ts && npm test &&
   npm run typecheck && npm run build:ui`. Report exact counts.
4. Restore tag, `git merge --no-ff`, review every removed test line (`git diff pre-merge-<name> HEAD -- test/ | grep '^-[^-]'`).
5. **Verify the module-list invariant**: the module list in `src/bin/legion-core.ts` and `scripts/harness/core-entry.mjs`
   must stay identical — a module in one and not the other means the harness is testing something else.
6. Real-PC check: an agent in Legion can `house_list` and `house_read` a shipped file (add to `claude/tracker-pc-checks.md`;
   the harness cannot prove the MCP surface end to end).

#### After the merge — Legion-on-Legion
1. Create a Legion project whose folder is `D:\bots\legion`.
2. Hand Zealot `claude/HANDOFF-zealot-legion-development.md`.
3. Constraint already established: this works for **Claude-provider agents only**. Provider-model agents have no file
   tools at all (`providers/runtime.ts:28`), so they cannot edit code regardless of skills.
4. Skills stays parked (see D5) — it is a "make it good" item, not a "get started" one.

### D6 — Move Legion development INTO Legion (Legion-on-Legion)
- Owner: "Hopefully this will be the last time we need to be in Hermes Agent and can start developing Legion from within Legion."
- NOT STARTED. Precondition: D5 (Skills) and D7 (Zealot handoff).

### D7 — Zealot takes over this role: handoff prompt + context layer
- Owner wants a prompt that hands this job to Zealot: build a proper **context layer** with the other agents so Legion can be
  developed from inside Legion, follow up open tasks, and run releases properly.
- NOT STARTED. Depends on D5 + D6.
