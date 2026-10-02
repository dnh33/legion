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
- Open items: R6.1 flake (mitigated, unproven); scrubSecrets quadratic on 3 shapes; VPS sync of Aetherkeep (ssh timed out); Aetherkeep notes written 2026-10-02 (`06-projects/legion-v0.2.0-release-2026-10-02.md` etc.).
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
