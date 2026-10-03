> **SUPERSEDED as a source of instructions.** `integration/v1` was merged into `main` and deleted on 2026-10-03.
> This file is kept as history. Read `claude/START-HERE.md` first, then `claude/legion-release-tracker.md`
> (section `POST-0.2.2`). Anything below naming a branch, work order or state predates that merge.


> Paste-in first message for the new agent: `claude/ORCHESTRATOR-TAKEOVER-PROMPT.md` (repo only).

# >>> HARNESS SWITCH (2026-10-03): READ THIS BLOCK FIRST. It overrides every "cloud session" step further down. <<<

The release now continues in a NEW harness (Hermes Agent) that works **directly with git on this PC**. It does not use claude.ai cloud sessions, and it does not need them. Do every task below yourself, in the repo, using your own subagents if you have them. The old cloud sessions are finished or stopped; their work is on their branches (read, do not steer).

## Ground truth in git (nothing lives only in a chat)
- Repo: `D:\bots\legion-dev`, remote `cloud` (github.com/dnh33/legion, private). Integration branch `integration/v1` (head at the time of writing: see `git log -1 cloud/integration/v1`; it was `7ea51ab`). Default branch `main` is untouched (`ff7afd2`).
- This file lives in the repo at `claude/ORCHESTRATOR-HANDOFF.md` (repo only). The tracker (`claude/legion-release-tracker.md`, section "SESSION SAVE POINT 5" and later) is the log. Update it after every change.
- Vault (the owner's notes): `D:\Aetherkeep\06-projects\legion\` (`legion.md`, the release note, `website\`, `trailer\`). Memory file: `C:\Users\Danie\.claude\projects\C--Windows-System32\memory\legion-v0-2-0-release.md`.
- Hermes is prepared: the Kodawari gate is in its SOUL files and five skills are installed (legion-orchestrator, kodawari, cinematic-trailer-pipeline, roast-and-council, receiving-review). Start Hermes in `D:\bots\legion-dev` so `CLAUDE.md` loads. Use the `kodawari` skill for every review.

## Rules in force (short; full text in section 2 below and in repo `CLAUDE.md`)
Only the orchestrator (you) merges into `integration/v1` and `main`. Restore tag before every merge (`git tag pre-merge-<name> && git push cloud pre-merge-<name>`), `--no-ff`, never force, rebase or squash. After every merge: check removed test lines (`git diff <tag> HEAD -- test/ | grep '^-'`), run the Windows gate (below), push, update tracker/vault/memory. Never touch the BSV wallet at the port written as 33 and 21 from any code, test or agent (the orchestrator may probe it by hand, read-only first). Never write that port literally in tests (`Number('33' + '21')`). Do not disable the admin gate, native-secret flow, taint wrapping or tripwire/hedge tests; only extend hedge tests. Never write "safe", "secure", "verified" or "cannot be bypassed" about the product. No keys, tokens or `.legion` data anywhere. Zealot's art is untouchable. Do not spend money or click purchase buttons; downloads need the owner's go. Setup changes to the owner's tools: plan, back up, get a go. Plain, short, answer-first writing to the owner.


## Per-session handoffs that exist (read the one for the area you touch)
- In this repo (`claude/handoffs/`): `browser-engines-HANDOFF.md`, `blender-chip-HANDOFF.md`, `providers-HANDOFF.md` (0.2.1 work).
- On unmerged branches: `claude/audit-agent-instructions-HANDOFF.md` (branch claude/agent-audit); `docs/video-v2/HANDOFF.md`, `AUDIT.md`, `BRIEF.md` (branch claude/trailer-v2-build); site repo `HANDOFF.md`.
- NOT written (the weekly limit blocked those sessions): project board (use `claude/plan-project-board.md`, `docs/PROJECT-BOARD.md`, `claude/tracker-pc-checks-board.md` on branch claude/project-board) and the BSV and Blender build sessions. For those, the merged plans and docs are the record: `claude/plan-bsv-rung3.md`, `docs/BSV-MODE.md`, `docs/BSV-WALLET-DESIGN.md`, `docs/TESTING-BSV.md`, `claude/plan-blender-local-first.md`, `docs/BLENDER.md`, `docs/TESTING-BLENDER.md`, `claude/tracker-pc-checks.md`, plus the tracker's dated entries. Do NOT spin up cloud sessions to fetch more.
- Docs that exist on integration/v1: ARCHITECTURE, BLENDER, BSV-MODE, BSV-WALLET-DESIGN, CHAT, COMMS-BRIDGE, KNOWLEDGE-GRAPH, LIBRARY, TESTING*, UPDATES, VM-NOTES; root: README, SECURITY, CONTRIBUTING, CHANGELOG, CLAUDE.md, LICENSE, NOTICE. `docs/PROJECT-BOARD.md` exists only on claude/project-board until it is merged.
- Owner rule: do not fan out many agents at once (a burst of 15 sessions cost about 9 dollars in seconds). Ask first before starting more than one paid agent.

## The Windows gate (run in the worktree, never in the main clone)
```
cd D:\bots\legion-gate
git checkout --detach <commit>
rm -rf dist
npm run build:ts && npm run typecheck && npm run build:ui
node --test "dist/test/*.test.js"      # ~2300 tests, 15-25 min, expect 0 fail, ~45 skipped
```
Known flakes (re-run the file alone): `server.test` "task archive / rename / delete"; `blender-local` "dispose stops a running Blender"; `browser-module.test` E8 "a full run (fake Edge on Windows paths)" (about 1 failure in 4 runs of the file alone: after the process is gone the test asserts `manager.running() === 0` immediately and the count can lag; fix the TEST by waiting with `until(() => manager.running() === 0)`, or the manager if the lag is real; do this in WO-7's fix round). Never recursively delete `D:\bots\legion-gate\node_modules` (junction): `cmd /c rmdir` it first when removing the worktree.

## The Linux gate (no cloud agent needed)
Repo has `.github/workflows/ci.yml`: on `pull_request` and push to main it runs `npm ci`, typecheck, `npm test`, build on **windows-latest and ubuntu-latest**, plus the Windows PowerShell 5.1 installer job. Opening a PR `integration/v1 -> main` therefore runs the first Linux run of the merged tree. (WSL and Docker are NOT installed on this PC.) Read the result with `gh run list` / `gh run view --log-failed`. Fix failures on `integration/v1` (not on main). Using Actions minutes on the private repo is a small cost on the owner's account: mention it once when you open the PR.

---

# WORK ORDERS, in order. Each is self-contained. Do them yourself.

## WO-1  Finish the bot-instruction audit (branch `claude/agent-audit`, head 47a84e7, WORK IN PROGRESS, NOT GATED)
Read on that branch, in this order: `claude/audit-agent-instructions-HANDOFF.md` (the session's own handoff; the exact state), then `claude/audit-agent-instructions.md` (audit, owner answers in its section 8, the design).
**What is built (committed on the branch):** `src/core/agent-facts.ts` (new): `renderCapabilities(agent, {servers, ceiling?, vmEnabledForAgent})` reads tool names from each in-process server's `instance._registeredTools`; emits one block of lines (per server, VM line, browser lines, BSV taint line for Assayer only, Sentinel "scheduled runs are planned, not available yet", approvals line with the ceiling). `INTENTIONALLY_HIDDEN` is empty on purpose. `src/core/engine.ts` `buildOptions` inserts the block between module preambles and the persona (before the Projects block); NOT added on the provider path (providers are flag-gated off). Text fixes: roster Sculptor and Assayer sentences; README line 37 and `docs/ARCHITECTURE.md` Blender paragraph; browser preamble in `src/core/browser/tools.ts` (Edge or Chrome, text only, no screenshots). New tests: `test/agent-facts-helpers.ts`, `test/agent-facts.test.ts`, `test/agent-persona-snapshot.test.ts` (13 pinned persona hashes; only assayer and sculptor changed), `test/agent-stale-claims.test.ts`.
**The mutation checks you MUST re-run (the session ran them by hand, each must turn a NAMED test red, then revert; they are not in the repo as a script, so redo them in a scratch copy or by editing and `git restore`-ing via `git show HEAD:file > file`):**
 1. change one byte of any persona text -> the persona hash snapshot test must fail;
 2. put "you choose the network" back in the Assayer text -> stale-claims test must fail;
 3. drop the `kg` server line from the block -> tool-coverage test must fail;
 4. empty Herald's deny set (browser_type/click/eval) -> the Herald test must fail;
 5. show the BSV taint line to every agent -> the Assayer-only test must fail (this one needed an extra `bsv_status` assertion, already added: confirm it is there);
 6. move the Sentinel scheduler line to Scout -> the Sentinel test must fail;
 7. re-add README "inside its VM" -> stale-claims scan must fail;
 8. make the approvals line ignore the ceiling -> the gate-consistency test must fail.
If a mutation does NOT turn a test red, the test is weak: fix the test, do not accept it.
**Still NOT done (do in this order):** (1) `rm -rf dist && npm ci && npm run build:ts && npm test && npm run typecheck && npm run build:ui`; fix any test that pins the old browser preamble or the old roster sentences, and existing engine tests that inspect `systemPrompt.append` (they may need to account for the block). (2) Removed-test-lines check against integration/v1: `git diff <integration/v1 commit> -- test/ | grep '^-[^-]'` must be EMPTY (additions only); confirm the block text passes `test/bsv-hedge.test.ts` and `test/bsv-tripwire*.test.ts` unchanged. (3) Optional: one engine-level test that a run's `systemPrompt.append` contains the block BEFORE the persona (use the `setup()` pattern in `test/engine.test.ts`) with a negative. (4) Left on purpose: README.md:77 and `docs/ARCHITECTURE.md` lines about "Node 20.10 / system node" (S10): check against the shipped installer/prebuilt docs before touching, or list as open. (5) Commit, merge: restore tag `pre-merge-agent-audit`, `--no-ff`, resolve conflicts keeping both sides, gate. Report numbers honestly: block size is about 1.3 KB (about 330 tokens) per run. Not verified: a Windows run of the branch, real Claude behaviour with the block, the Edge/Chrome wording on a real PC, the provider path (no block there).
Design rules (owner-approved, do not change): persona text byte-identical except the two false lines the audit named; Herald is draft-only; Sentinel scheduler is planned (the block says checks run only while a task is running); the Assayer taint rule is intended; browser for all 13 bots, other bots may submit forms but each such action needs a card in ask mode, notes written after browsing wait in the owner's Inbox. 0.2.1 ideas list (KG audit button, Sentinel scheduler) is in the audit file.

## WO-2  Merge the project board (branch `claude/project-board`, head 6be357b, finished)
- Restore tag `pre-merge-project-board`; `git merge --no-ff cloud/claude/project-board`. Expected conflicts: `src/bin/legion-core.ts` and `scripts/harness/core-entry.mjs` module lists (keep both sides, lists must stay identical: harness-smoke test), tracker, `claude/tracker-pc-checks.md`, `ui/src/components/Settings.tsx`, `src/electron/main.ts`, `preload.cjs`, `test/bsv-scan.ts` allowlist (keep every entry from both sides).
- **FIX THE BUG before the gate:** `mcp__legion_board__*` is missing from the Legion-tool list in `src/core/approvals.ts`, so every board call counts as outside content (taint). Read `src/core/approvals.ts`, find how other `mcp__legion_*` tools are recognised, add the board tools the same way, and add a test that a board call does NOT taint the run while an unrelated outside tool still does (prove it red first by mutation). Do not weaken any existing taint test.
- Board rules (owner decision): ON by default, owner-only OFF switch `features.projectBoard=false`; member agents can create/edit/move/claim/label/note; owner-only: Done, assigning to the owner, items assigned to the owner (notes only), closed items; agent-created items untrusted; limited runs cannot assign or delete; delete only by the leader with an approval card; caps (50 open items per agent, stops 40 short of 200); project is a context layer (board digest + 5 most recent project notes per run; "Save what we learned" refuses secrets). Docs: `docs/PROJECT-BOARD.md`; plan `claude/plan-project-board.md`; PC checks PB1-PB10.
- Gate, push. Then set the board to SHIPS in both facts files (see WO-6).

## WO-3  Blender enable-confirmation: MERGED (restore tag `pre-merge-blender-chip-confirm`, merge 06a8edd; gate 2305 tests, 2259 pass, 1 fail = the E8 browser flake above, passes on re-run, 45 skipped). Nothing to do except the PC check B17.
What it is: the session also reshaped the title-bar chip into one quiet pill with a popover (the switch now lives in the popover; no switch in the title bar); test assertions were re-expressed, not removed. The change adds the "Turn on Blender?" dialog on both the chip and Settings via one `requestEnableBlender()` in `ui/src/blender/blenderStore.ts` and `enableCopy.ts`. Gate, push.

## WO-4  Trailer v2 (branch `claude/trailer-v2-build`, head a9d0463, first cut done, unmerged)
Read `docs/video-v2/HANDOFF.md` on that branch first (rebuild commands, method, gotchas, decisions that must survive an edit). Vault copy: `D:\Aetherkeep\06-projects\legion\trailer\`.
1. **Fact-table check (owner asked me to do this and it is still owed):** verify every on-screen claim in `docs/video-v2/BRIEF.md` against the merged code and `claude/release-facts-0.2.0.md`. The browser now SHIPS; the board ships after WO-2; keep honesty chips (BSV spend "built against fakes, not tried with real funds", Blender, prebuilt package, updater, board "built and tested, not yet tried on a real PC"). Beta wording is the owner's: "0.2.0 · BETA", dry, confident; never "young", "safe", "secure", "verified"; no Lightpanda; no provider names; no repo URL; no "open source" claim until the owner says the repo is public.
2. Fix the reported weak spots (install route cards too big; Relic overlaps wordmark cables while it draws; Blender "Get" card shows the Linux state; Update panel shows "updates are off"; sound measured -13.3 LUFS, not listened to), re-capture screenshots after the merges (board shots, BSV with the final pack 163/727, Blender, Update) using `docs/video-v2/capture/` (a real core with the repo's fakes), update `BRIEF.md` to the 105 s storyboard, run `node docs/video-v2/check.mjs`, re-render (`node docs/video-v2/render.mjs`, ~25 min; needs Node, Python with numpy/scipy, ffmpeg, Playwright Chromium; check what is installed on this PC before assuming).
3. Show the cut to the owner (file path + a contact sheet); merge only after his yes (restore tag `pre-merge-trailer-v2`). Put the MP4/GIF/poster path into the website's `src/data/launch.json` trailer slot only with his go.

## WO-5  Website (repo `dnh33/legion-site`, branch `main`; clone it to a scratch folder)
Read the site repo's `HANDOFF.md` (d10c0f8), `CLAUDE.md`, `NEEDS-OWNER.md`, and the vault note `D:\Aetherkeep\06-projects\legion\website\`. Accepted: grouped feature list. Rejected: two-tone (branch `design/two-tone`, record only). The site's source of truth is `brief/RELEASE-FACTS-0.2.0.md` (copy of the product's `claude/release-facts-0.2.0.md`; edit BOTH together; the site copy has no header line difference except one comment line at the top). After each product merge: update the facts (status words SHIPS), then mirror in `src/lib/agent-docs.ts`, `src/data/features.json` (flip chip `finalising` to `tested` for the board when WO-2 is merged), rebuild (`npm run build`), run the site's checks (`npx html-validate dist/index.html dist/credits.html`, `node qa/contrast.mjs`, `node qa/lighthouse.mjs`, `node qa/links.mjs`), push to `main` (and keep branch `claude/loving-clarke-1a7izo` equal to main). The owner deploys; do not deploy. Open owner questions: `NEEDS-OWNER.md` items 34-38 and the creator credit name; refresh screenshots (the Assayer shot still says "no spend tool"); the trailer slot.

## WO-6  Keep the facts honest after every merge
Edit both facts files together (product `claude/release-facts-0.2.0.md`, site `brief/RELEASE-FACTS-0.2.0.md`). Browser = SHIPS (done). Board = SHIPS after WO-2. Providers = 0.2.1. Sentinel scheduler = planned. Signed installers = not claimed. Prebuilt package = "scripted, not built or run" until you build and run it (WO-10).

## WO-7  ONE independent security review of the merged tree, then a fix round
Do it with your own fresh subagents (default "not fixed", refute each finding against real code), after WO-1..3 are merged. Scope: updater, browser (Chromium, Fetch guards), loopback guard, Projects + board agent access (+ prompt injection through board items and notes), installer + prebuilt, Blender both + chip + confirmation, BSV T2/T3/T4/T5. Specific items: the tripwire rewrite in `test/bsv-scan.ts` (spend.ts content hash pinned via SPEND_PINS) and every removed assertion in the T4 report (`git log` for the BSV T4 merge 73d4dfa); `BSV_PREAMBLE` first line still says "the network is testnet"; the B5 control (mainnet hard-off; audit log is a second source); same-user limits; providers flag-off proof (`test/experimental-providers.test.ts`; only the literal `true` enables); the browser net-guard exception (`test/net-guard-source.test.ts`: exactly one file `src/core/browser/chromium.ts`, exactly one switch `--remote-debugging-port=0`); browser limits (runs with the user's rights, DNS rebinding not mitigated, WebSocket/WebRTC/service-worker traffic not claimed checked, debugging port has no password, popup unguarded until closed); the open-source scrub. Put the Linux gate result in the report (open the PR early to get it, see "Linux gate"). Fix round: fix on `integration/v1`, gate again.

## WO-8  Docs phase 2, screenshots, wordmark README
Merge `claude/docs-release-ready-1` (d6cea12, wordmark README with Grenze Gotisch SVG paths) after the others (restore tag). Refresh docs for what shipped (browser, board, Blender chip, BSV spend with fakes-only wording, updater off until key, prebuilt package). Fresh screenshots via `docs/video-v2/capture/` stack. Every claim scoped ("Legion's own code ..."), no banned words.

## WO-9  Open-sourcing (scrubbed snapshot, fresh history)
Write `scripts/export-public.mjs`: scrubbed snapshot of the repo for a NEW public repo at `dnh33/legion` (rename the private repo first; the owner does the rename and making it public). Scrub: `claude/skills/` (the owner's private skills), operational lines in tracker/plans that name the owner's paths, wallet facts you cannot publish, anything the open-sourcing plan section in the tracker lists; fresh history (single initial commit). Plans may be public (owner said so). Add a test that the scrub leaves none of the listed strings. Plan: tracker section "OPEN-SOURCING PLAN" and `claude/tracker-public-audit.md`.

## WO-10  Release path (after WO-1..9 and the owner steps)
1. Open PR `integration/v1 -> main` (a fast-forward is possible: main has no extra commits). CI runs the Linux gate. Tell the owner the PR number; **the owner runs `/code-review ultra <PR#>`** (billed to him; an agent cannot launch it).
2. Deliver to a NEW folder `D:\bots\legion-v6-7` (`git archive` + md5). Never overwrite `legion-v6-6` or earlier.
3. BUILD the prebuilt package on this PC (plan `claude/plan-prebuilt.md`; ~270 MB zipped, ~690 MB unpacked; keeps the Claude engine) and test it in a clean folder with a clean data dir. Not built or run yet.
4. Register the Legion MCP at user scope: back up `~/.claude.json` first, plan first, get the owner's go.
5. Run the real-PC plan (`claude/real-pc-test-plan.md`, 128 checks, with `scripts/harness/pc-report`) together with the owner; PC check ids: PB1-PB10 (board), B17 (chip), BR15-BR24 (browser), V1-V12 (BSV testnet, by hand), R0-R11, ND1-ND12.
6. Tag `v0.2.0` (only after the owner's go).
7. Cleanup: stale local branches (gate-*, fix/*, merge/*), worktrees `legion-wt-win`, `legion-wt-winfix`, `legion-gate` (rmdir `node_modules` junction first).

## OWNER-ONLY STEPS (list them to him, plainly; do not do them for him)
BSV Desktop in testnet mode + faucet coins (then the orchestrator runs V1-V12 by hand, tiny amounts, per-action go-ahead); make the repo public when WO-9 is done; generate the updater signing key (`scripts/release-keygen.mjs`) and paste the PUBLIC key into `src/core/updater/trust.ts`; deploy the website; log in to Tailscale so the VPS Aetherkeep copy can sync; answer the website questions; run `/code-review ultra`.

## 0.2.1 (record only, do NOT build now)
Providers (OpenAI, Codex, OpenCode, OpenRouter, custom/local; branches `claude/providers`, `claude/providers-2`), lite package (~160 MB), maybe Tauri, sign-in helper, agent-browser engine, KG audit button, Sentinel scheduler, both Blender add-ons beyond the flag, signed installer, real-wallet BSV verification.

## Honest status (say it as it is)
Nothing in 0.2.0 has run in the real Windows app; BSV spend tool tested against fakes only; prebuilt package not built; merged tree never run on Linux yet (the PR's CI is the first run); trailer sound not listened to.

---
(Older text follows. Wherever it says "cloud session", "claude.ai", "steer", "tell the session", skip it: you do that work yourself.)

---

# >>> UPDATE 2026-10-03 ~04:30 (newer than the text below; where they differ, THIS block wins) <<<
- **browser-engines is MERGED** into integration/v1 (restore tag `pre-merge-browser-engines`, merge `079159a`, Windows gate **2301 tests, 2256 pass, 0 fail, 45 skipped**). integration/v1 head: `5da600d` (pushed to remote `cloud`). Lightpanda is gone. Browser facts say SHIPS in both facts files (site copy pushed: dnh33/legion-site main `e67789b`). Section 4.1 below describes the pre-merge state: ignore its "wait for the report" steps.
- **Still to merge, in this order:** (1) `claude/project-board` (6be357b; finished), (2) `claude/blender-chip` confirmation (c1dd626; finished), then trailer/docs.
- **BUG to fix at the board merge:** `mcp__legion_board__*` is missing from the Legion-tool list in `src/core/approvals.ts`, so every board call counts as outside content (taint). Verify, fix, add a test, keep it in the security review.
- **Add to the security review:** the browser net-guard exception (`test/net-guard-source.test.ts`: exactly one file `src/core/browser/chromium.ts`, exactly one switch `--remote-debugging-port=0`), and browser limits (runs with user's rights, DNS rebinding not mitigated, WebSocket/WebRTC/service-worker traffic not claimed checked, debugging port has no password, popup unguarded until closed).
- **Audit PHASE 2 STARTED** (2026-10-03 ~05:00): the session ID in 4.5 is CORRECT (title checked); I sent it the go (branch from integration/v1 5da600d, minimal text fixes, generated block, four tests, gate, report <150 words, push only to claude/agent-audit). Next: read its report, merge with a restore tag (pre-merge-agent-audit), check removed test lines (should be none), gate.
- **Trailer v2 finished** (see 4.4 update). **Website:** grouped features accepted, two-tone REJECTED (the "show two-tone screenshots" task in 4.6 is cancelled by the owner's later decision recorded in the site HANDOFF.md). Site repo HANDOFF.md (d10c0f8) is the site session's own context.
- **Hermes is prepared:** Kodawari gate block appended (append-only) to Hermes' main SOUL.md and 8 profile SOUL.md files; five skills installed in `%LOCALAPPDATA%\hermes\skills\` (legion-orchestrator, kodawari, cinematic-trailer-pipeline, roast-and-council, receiving-review); backups in `D:\hermes-backups\`. Start Hermes in `D:ots\legion-dev` so repo `CLAUDE.md` loads. Hermes was not run: first thing, check `skills_list`. Hermes' `approvals.mode` is `off` while its SOUL says never to set that: the owner's call, untouched.
- **Records current:** tracker "SESSION SAVE POINT 5" (repo), Aetherkeep `06-projects/legion/` (release note, website/, trailer/ subfolders; legion.md), decisions log, memory file. Aetherkeep VPS copy is behind (Tailscale logged out).
- Weekly limit resets Mon 2026-10-05 01:00. The merge, gate and record work above needs only the repo and git; steering cloud sessions needs a logged-in claude.ai browser.
- Gate note: gate with `git -C D:ots\legion-gate checkout --detach <commit>`, `rm -rf dist`, build:ts, typecheck, build:ui, `node --test "dist/test/*.test.js"`; log of a full run is ~2300 tests, about 15-25 min.

---

# Legion v0.2.0: orchestrator takeover (written 2026-10-03, after the weekly limit hit)

Read this first. It lets a new agent (Hermes) take over the orchestrator role: steer the cloud sessions, merge their branches, gate, review and ship v0.2.0.
Older handoff (archived, ignore): D:\bots\_old-desktop-legion-files\LEGION-RELEASE-HANDOFF.md. This file supersedes it.

Owner: Daniel Hjermitslev (dnh33). Direct. Writes in plain English. Wants short answers, answer first.

---

## 1. The answer in 10 lines

- Product: Legion, a local multi-agent desktop app (Electron + Node/TS core on 127.0.0.1:4747 + React UI). Release: **v0.2.0**.
- Repo: `D:\bots\legion-dev`. Integration branch: **`integration/v1`** (local head `c3f68e5`, pushed to remote `cloud`). GitHub `dnh33/legion` (private). Default branch `main` is untouched at `ff7afd2`.
- Latest Windows gate on integration/v1: **2295 tests, 2250 pass, 0 fail, 45 skipped.**
- Merged: BSV T1-T5, Blender B1-B5 + both-backends (flag off) + title-bar chip, installer bootstrap, prebuilt package, updater (off until a signing key exists), loopback guard, Projects (minimal), test harness, real-PC plan, providers (flag-gated OFF).
- **NOT merged yet (the work you take over):** browser-engines, project-board, blender-chip confirmation follow-up. Plus docs-release-ready-1, trailer-v2-build, agent-audit Phase 2, website.
- The weekly Claude limit was hit. It **resets Mon 2026-10-05 01:00** (local time). The website session was cut off mid-turn. Other sessions may still be running or idle.
- Only the orchestrator merges into `integration/v1` and `main`. Cloud sessions push only to their own branch.
- Source of truth for everything: `claude/legion-release-tracker.md` in the repo, section **"SESSION SAVE POINT 4"** (line ~285). Read it right after this file.
- Do not deliver v0.2.0 before: all merges, ONE independent security review including a Linux run, docs and screenshots, owner steps, PR, delivery folder, real-PC run.

---

## 2. Rules that stay in force (owner's rules; do not break)

**Safety and security**
- Never disable the admin gate, the native-secret flow, taint wrapping, or the tripwire/hedge tests to make anything pass. Hedge tests are only extended, never loosened.
- Never write the words "safe", "secure", "verified" or "cannot be bypassed" in product claims. Scope claims ("Legion's own code ...").
- No keys, tokens or `.legion` data in the repo, chat or logs. Do not read the owner's `.legion` folder.
- **BSV wallet at 127.0.0.1:3321 (the owner's real wallet):** the orchestrator may probe it by hand, outside the repo, read-only first, then V1/V2 (unsigned tx, then `abortAction`). Repo code, tests, scripts, the harness and cloud agents NEVER contact it. Test files never write the port literally: use `Number('33' + '21')`. Anything that signs, spends or broadcasts needs the owner's explicit per-action go-ahead (amount + address), tiny amounts first. This amended rule is in repo `CLAUDE.md` and `claude/plan-bsv-rung3.md` section 14. (The old "never touch the wallet" rule was NOT the owner's; he said so.)
- "Zealot's art is untouchable."
- No creating accounts, passwords or CAPTCHAs.
- No downloads, and nothing that spends money, without the owner's explicit go-ahead. Do NOT click "Turn on credits", "Get more usage", or any purchase button.
- Setup changes to the owner's Claude/Aetherkeep: plan first, back up, get a go.

**Git rules**
- Tag a restore point before every merge: `git tag pre-merge-<name> && git push cloud pre-merge-<name>`.
- Merge with `git merge --no-ff`. No force push, no rebase, no squash.
- Never switch branches in the main clone while a background gate runs. Gate in the separate worktree (see section 6).
- A hook blocks `git checkout --`. Use `git show REV:file > file` to restore a file.

**Working style**
- "Research first, ask the owner last": look up official docs, quote sources, keep a facts / assumptions / unknowns table. Gate the SHIP, not the build. Attribute rules honestly (do not call something the owner's rule unless he said it).
- Write to the owner in plain, short, answer-first English (ISO 24495-1, ASD-STE100, Zinsser, Pyramid). Long detail goes to the tracker, chat points to it.
- The owner dislikes the word "young" and apologetic hedging in site copy.
- Keep the tracker, Aetherkeep and memory current after every change (see section 9). Context saves matter: limits hit without warning.
- Deliver to a NEW folder (next: `D:\bots\legion-v6-7`). Never overwrite earlier ones (`legion-v6-6` and older exist).

---

## 3. Environment and access

| Thing | Where |
|---|---|
| Repo (main clone) | `D:\bots\legion-dev` (branch integration/v1; remote `cloud` = github.com/dnh33/legion, remote `origin` also exists) |
| Gate worktree (Windows) | `D:\bots\legion-gate` (has a `node_modules` junction; NEVER recursively delete it; `cmd /c rmdir <wt>\node_modules` first) |
| Other worktrees (cleanup at the end) | `legion-wt-win`, `legion-wt-winfix` |
| Backup bundle | `D:\bots\legion-backup-20261002-night.bundle` |
| Aetherkeep (owner's vault, private) | `D:\Aetherkeep` (VPS copy `rune-vps:/opt/aetherkeep` is behind: Tailscale is logged out) |
| Release project note | `D:\Aetherkeep\06-projects\legion\legion-v0.2.0-release-2026-10-02.md` and `04-claude\decisions-log.md` |
| Claude memory dir | `C:\Users\Danie\.claude\projects\C--Windows-System32\memory\` (file `legion-v0-2-0-release.md`) |
| Website repo | `dnh33/legion-site` (separate, branch main; owner deploys) |
| OS / shell | Windows 11, Git Bash and PowerShell |

**How cloud sessions are driven:** at `https://claude.ai/code/<session_id>` in the logged-in Playwright browser (owner's account, billed to the owner's credits). You type a message into the session's page and press Enter. Read session state from **page text** (`document.body.innerText`), not screenshots. The sidebar shows Running / Idle / Unread response; it can say "Idle" while background tasks run, so read the page. New sessions: check the repo pill says `legion`.

Hermes note: if Hermes has no logged-in browser for claude.ai, the owner must log in once, or the steering messages in section 4 must be pasted by the owner. Git work, gates and file edits need only the repo.

---

## 4. Cloud sessions: where each got cut off

Read at 2026-10-03 (about 01:05 local). Branch heads from `git fetch cloud --prune`.

### 4.1 BROWSER ENGINES: `claude/browser-engines` (session_01VuPnVmHqsnfwUpke3XCMkP)
- Head `3ec9a52`: 12 commits ahead of integration/v1, 24 behind. Last commit: "tests: prove the Fetch guard path on its own (fetch-only fake)".
- Goal: DELETE Lightpanda entirely (owner decision) and ship ONE Chromium-family engine (Edge/Chrome on the PC) via Legion's own CDP driver with Fetch-domain guards. Plan section "Evaluated and dropped" (Lightpanda: no native Windows build, AGPL-3.0, nightly-only; agent-browser: later, 0.2.1). Docs rewritten for Chromium-only.
- Page showed it **still running** a mutation-test loop (it had just fixed: fake CDP server now enforces the exact endpoint path; added an internal-page forged-name test; fetch-only fake). It was mid `/advisor opus` call. **No final report yet.**
- Orchestrator to do: wait for its report (or ask: "report status in under 120 words: gate counts, removed tests list, what is not verified"). Then: restore tag `pre-merge-browser-engines`, merge `--no-ff`. **Check removed test lines:** `git diff pre-merge-browser-engines HEAD -- test/ | grep '^-'`. Only deleted Lightpanda tests are acceptable. Expect conflicts in: the two module lists, `claude/tracker-pc-checks*.md`, `test/bsv-scan.ts` allowlist (keep BOTH sides; keep the browser allowlist entries). Windows gate. Push.
- After merge: set browser to SHIPS in both facts files (section 7), tell the audit session "browser is merged, start PHASE 2", tell website and trailer sessions.

### 4.2 PROJECT BOARD: `claude/project-board` (session_018vkVWTE3bbYxLFD6paDW4f)
- Head `6be357b`: 15 ahead, 9 behind. **Session finished and reported** (12 min before the read). Nothing blocks the merge.
- Owner decision: board is IN 0.2.0, ON by default (owner-only OFF switch `features.projectBoard=false`). Agent access: any member agent can create/edit/move/claim/label/note. Project works as a context layer (board digest + 5 most recent project notes in each run; "Save what we learned" refuses secrets).
- Guards (all tested in `test/project-board-agent-access.test.ts`): no tool argument can name a project/trust/reviewer; update cannot set Done; agent-created items are untrusted; an agent text edit clears owner review; other projects out of reach; owner-only: Done, assigning to owner, items assigned to the owner (notes only), closed items; limited runs cannot assign or delete; delete only by the leader with an approval card every time; write/create rate limits; 50 open items per agent; board stops 40 short of 200; no key/seed phrase by any text path.
- Stated gaps (put in docs honestly): Legion's own code makes these checks, it does not limit what an allowed agent tool does; a compromised app window has the admin key and can edit the board (runs and agent deletes still need approval cards); any member agent can reword open items or take items assigned to other agents; rate limits reset on restart; **nothing run on Windows**. PC checks PB1-PB10 in `claude/tracker-pc-checks.md`.
- Orchestrator to do: restore tag `pre-merge-project-board`, merge `--no-ff` (conflicts expected in the module lists, tracker, PC checks, `Settings.tsx`, `main.ts`, `preload.cjs`: keep both sides), removed-test-line check, Windows gate, push. This branch needs the independent security review (agent access; prompt injection through board items and notes).

### 4.3 BLENDER CHIP and ENABLE CONFIRMATION: `claude/blender-chip` (session_01KkD2agyZPmdqbDvCLtPC6D)
- Head `c1dd626`: 1 ahead, 3 behind (the chip itself is already merged, restore tag `pre-merge-blender-chip`). **Session finished and reported.**
- New: "Turn on Blender?" confirmation on BOTH the title-bar chip switch and the Settings checkbox, one shared `requestEnableBlender()` in `ui/src/blender/blenderStore.ts`, copy in `enableCopy.ts`. Cancel is default, Escape and X cancel with no write, confirm calls `saveBlenderConfig({enabled:true})` once, turning off asks nothing. 4 new tests with mutations. Branch gate: 2217 tests, 2214 pass, 0 fail, 3 skipped. B17 PC check updated. Real Windows app NOT checked.
- Orchestrator to do: restore tag `pre-merge-blender-chip-confirm`, merge `--no-ff`, removed-line check, Windows gate, push.

### 4.4 TRAILER V2: `claude/trailer-v2-build` (session_01D7Gx3abU8pr3XvY8nN9Qjq)
- Head `a714eeb`: 11 ahead, 8 behind. Base branch `claude/trailer-v2` (restored first-trailer sources from `D:\bots\legion-v6-1/docs/video`).
- Owner framing: "Beta launch of 0.2.0". 105 s timeline; shows project board and project memory as 0.2.0 with a "built, tested, not yet tried" chip; "next" list is: more model providers, knowledge-graph audit button, Sentinel scheduler, optional lighter package, extra browser engines, real-wallet BSV verification. Lightpanda is NEVER mentioned. The browser tool is shown only if the facts file says SHIPPED at render time.
- **UPDATE (read later): the session FINISHED.** Head `a9d0463`: first cut rendered (105 s, MP4 26 MB, GIF 6.7 MB, `poster-v2.png`, -13.3 LUFS, not listened to), `docs/video-v2/AUDIT.md` lists what is left, and it wrote `docs/video-v2/HANDOFF.md` (rebuild commands, method, gotchas, decisions that must survive an edit, ordered next steps). Vault copy: `D:\Aetherkeep-projects\legion	railer\`. Weak spots: install cards too big, Relic overlaps wordmark cables, Blender "Get" shows the Linux state, Update panel shows "updates are off". Next: independent reviewer pass, polish, re-capture after merges, update BRIEF.md.
- **BUG TO CHECK AT THE BOARD MERGE:** `mcp__legion_board__*` is missing from the Legion-tool list in `src/core/approvals.ts` on the board branch, so every board call counts as outside content (taint). Verify and fix before or at the board merge; add to the security review.
- Older status: **full render running**, 4 workers, 3150 frames. It waits on a screenshot sub-agent for board shots and retaken BSV shots (the pack count changed). Then it checks MP4, GIF, poster, loudness and sends the video inline to the owner.
- **Orchestrator still owes:** a fact-table check of the final cut against the code (`docs/video-v2/BRIEF.md` fact table). Watch the first cut with the owner. Only GO when facts match.
- Branch content is docs/video-v2 + skills (cinematic-trailer-pipeline: HTML timeline rendered frame by frame, synthesized score). Merge into integration/v1 only after the cut is accepted (restore tag first).

### 4.5 BOT INSTRUCTION AUDIT: `claude/agent-audit` (session_0154ccYCLdcEVqBSp11VX4WM; ID confirmed correct by title)
- Head `15884fd`: 2 ahead, 27 behind. Phase 1 (audit only) done: `claude/audit-agent-instructions.md`.
- Design: persona text byte-identical (only the two false persona lines edited, owner approved); one generated "What you can do right now" block (<=12 lines, before the persona) built from real registered tools and gates; four tests (persona hash snapshot, tool coverage, stale-claims banned phrases, gate consistency).
- Owner answers: Assayer taint rule is intended; browser for all 13 bots, **Herald draft-only** (read, no type/click/eval); Sentinel scheduler is planned (block says checks run only while a task runs).
- **PHASE 2 starts ONLY when the orchestrator says the browser work is merged.** Waiting.

### 4.6 WEBSITE: repo `dnh33/legion-site` branch main (session_01A7WjrHs9wnksiMG75Csq1s)
- Pushed `006c941` earlier (Blender section, 14 feature blocks with status chips, harness only under "For developers", trailer slot hidden). Then built a grouped feature list on a branch with a **two-tone** design (mint bands in dark, near-black in light).
- **Cut off by the weekly limit mid-turn** (it was running `git checkout`). The owner's last message to it: he accepts the new feature presentation (grouped list), wants the two-tone shown in screenshots ONLY of the two-tone design before he confirms. The screenshots were not delivered.
- Source of truth for site copy: `brief/RELEASE-FACTS-0.2.0.md` in the site repo, kept in sync with `claude/release-facts-0.2.0.md` in the product repo. Board status there is "built, being finalised" until you mark SHIPS.
- Open owner questions are in the site repo's `NEEDS-OWNER.md` (items 34-38 plus the creator credit name). Owner deploys the site himself.
- After the limit resets: tell it to produce two-tone-only screenshots, then wait for the owner's yes/no.

### 4.7 Idle / old sessions (do not need steering)
- Providers phase 2 `claude/providers-2` (01DtUsuxhvUu99upbktkQVv1): 20 commits ahead, unmerged on purpose. Providers moved to **0.2.1**. Old branch `claude/providers` too. Keep for 0.2.1.
- BSV T4 session (01PgsuWb6kAMXR2unKN11VcT): done and merged.
- `claude/docs-release-ready-1` (d6cea12, 2 ahead): wordmark README (Grenze Gotisch SVG). **Unmerged**, merge after docs phase 2.
- `claude/e2e-eval` (8d5415d, 2 ahead): eval work, unmerged; check whether still wanted before merging.
- Many `claude/review-*`, `claude/blender-*`, `claude/bsv-*` branches are already merged or review-only. Safe to leave. Delete only in the final cleanup.

---

## 5. Merge order and exact steps

Do ONE branch at a time. Do not batch.

1. `cd D:\bots\legion-dev && git fetch cloud --prune && git status` (must be clean, on integration/v1).
2. Tag: `git tag pre-merge-<name> && git push cloud pre-merge-<name>`.
3. `git merge --no-ff cloud/claude/<branch>`. Resolve conflicts by **keeping both sides** in: tracker, PC checks, `test/bsv-scan.ts` allowlist, `src/bin/legion-core.ts` and `scripts/harness/core-entry.mjs` module lists (they MUST stay identical; the harness-smoke test checks it), `preload.cjs`, `main.ts`, `Settings.tsx`.
4. Removed-assertion check: `git diff pre-merge-<name> HEAD -- test/ | grep '^-'`. Investigate every removed test line. Browser branch: only Lightpanda tests may disappear.
5. Gate (section 6). All green, or only the known flakes (re-run the file alone).
6. `git push cloud integration/v1`.
7. Update tracker, Aetherkeep, memory (section 9). Tell the affected sessions.

Order: **(1) browser-engines, (2) project-board, (3) blender-chip confirmation**, then trailer/docs when ready.

---

## 6. The Windows gate

Run in the gate worktree, never in the main clone:

```
cd D:\bots\legion-gate
git checkout --detach integration/v1     # or the merge commit
rm -rf dist                              # ALWAYS: stale dist after a branch switch gives false results
npm run build:ts && npm run typecheck && npm run build:ui
node --test "dist/test/*.test.js"
```

- Expect roughly 2295+ tests, 0 fail, ~45 skipped (Linux-only emulation and POSIX-only tests skip on Windows).
- **Known flakes** (re-run that file alone, then accept): `server.test` "task archive / rename / delete"; `blender-local` "dispose stops a running Blender".
- Windows lessons: CRLF in .ps1/.cmd sources (tests normalize with `.replace(/\r\n/g, '\n')`), sockets emit `error` before `close`, never write the wallet port literally in tests (port guard `test/bsv-port-guard.test.ts`), a stray `%TEMP%\x` directory breaks R5.6 (remove it with a non-recursive `rmdir`).
- The merged tree has NEVER run the full suite on Linux. The security-review session must do that (section 8).

---

## 7. After the merges: keep the facts honest

- Update BOTH facts files together: `claude/release-facts-0.2.0.md` (product repo) and `brief/RELEASE-FACTS-0.2.0.md` (site repo `dnh33/legion-site` main). Browser -> SHIPS after the merge and gate. Board -> SHIPS after the merge and gate.
- Writing rule for every feature in the facts: what it needs, where it runs, what it asks you to approve, what it does not do. Scope the claims ("Legion's own code ...").
- Tell the website, trailer and audit sessions what changed.
- Facts to hold:
  - Knowledge pack v8: **163 nodes / 727 links** (bsv scope). Title-bar count shows the owner's real visible count with a breakdown, "unknown" on failure.
  - BSV spend tool: built and tested against FAKES only. Nothing verified with a real wallet. Mainnet capability exists but is hard-off. The wallet uses BRC-100; `createAction signAndProcess:false` returns a signable transaction, `abortAction({reference})` aborts.
  - Prebuilt package: ~270 MB zipped, ~690 MB unpacked, keeps the Claude engine, **not yet built or run on Windows**.
  - Updater: signed manifest (Ed25519), `UPDATE_KEYS` empty until the owner generates a key with `scripts/release-keygen.mjs`; needs a public repo.
  - Blender: local headless is the default when found (min 4.2); managed pinned Blender 5.2.2 LTS Windows x64 zip (sha256 `3849d17a682cba006075aaa3f3597ecb5c9c30ec31035b2e092c53e40679b535`, ~386 MB, fetch is Windows-only); both-backends mode off by default; Poly Haven downloads done by Legion behind approval cards.
  - Providers (OpenAI, Codex, OpenCode, OpenRouter, custom/local) are flag-gated OFF; public wording stays Claude-only for 0.2.0.

---

## 8. The remaining work, in order (from the tracker NEXT list)

1. Browser merge + gate; board merge + gate; chip confirmation merge + gate.
2. Update facts -> SHIPS; tell website, trailer, audit (audit PHASE 2 go).
3. Verify the trailer's fact table against code; watch the first cut with the owner.
4. **ONE independent security review** of the merged tree **including a Linux full-suite gate** (use a cloud session or a Linux box). Scope: updater, browser (Chromium + Fetch guards), loopback guard, Projects + BOARD agent access, installer + prebuilt, Blender both + chip + enable confirmation, BSV T2/T3/T4/T5. Specific review items:
   - the tripwire rewrite in `test/bsv-scan.ts` (pinned `spend.ts` hash via SPEND_PINS) and every removed assertion listed in the T4 report;
   - BSV_PREAMBLE first line still says "the network is testnet";
   - the B5 control;
   - same-user limits;
   - the providers flag-off proof (`test/experimental-providers.test.ts`; only the literal `true` enables);
   - the open-source scrub.
   Then a fix round and gates again.
5. Docs phase 2 + FRESH screenshots; merge `claude/docs-release-ready-1`.
6. `scripts/export-public.mjs` and the OPEN-SOURCING PLAN (tracker section): scrubbed snapshot, fresh history, remove `claude/skills` and operational lines; rename the private repo; clean public repo at `dnh33/legion`.
7. Owner steps (section 10).
8. Release path:
   - open the PR `integration/v1` -> `main` (a fast-forward is possible; main has no extra commits);
   - the owner runs `/code-review ultra <PR#>` (agents cannot launch it; it is billed to him);
   - deliver to a NEW folder `D:\bots\legion-v6-7` (`git archive` + md5);
   - BUILD the prebuilt package on this PC and test it in a clean folder with a clean data dir;
   - register the Legion MCP at user scope (back up `~/.claude.json` first, plan first, get a go);
   - run the real-PC plan (`claude/real-pc-test-plan.md`, 128 checks, + `scripts/harness/pc-report`);
   - tag `v0.2.0`.
9. Final cleanup: stale local branches (gate-*, fix/*, merge/*), worktrees `legion-wt-win`, `legion-wt-winfix`, `legion-gate` (rmdir the `node_modules` junction first).

---

## 9. Keeping the record current (do after every change)

1. `claude/legion-release-tracker.md`: add a dated entry; add a new "SESSION SAVE POINT 5" when the state changes materially (it supersedes 4).
2. Aetherkeep: `D:\Aetherkeep\06-projects\legion\` (folder: legion.md, release note, `website\` subfolder with the website note; save points in the release note) and `04-claude\decisions-log.md` (decision + why). Commit only the paths you wrote: `git -C D:/Aetherkeep add <paths>` (never `add -A`), `git push origin master`. The VPS copy cannot sync until the owner logs in to Tailscale; say so.
3. Memory file `legion-v0-2-0-release.md` (index `MEMORY.md`): one line per change.
4. Open items go in the tracker so a limit never loses them.

---

## 10. What the owner must do (list these to him)

- Switch BSV Desktop to **testnet mode** and add faucet coins, so the orchestrator can run V1-V12 by hand (the wallet is currently mainnet, authenticated, height ~969369; V0 read-only probe is done and recorded in `claude/tracker-pc-checks.md`).
- Make the repo public when the open-sourcing step is reached.
- Generate the updater signing key (`scripts/release-keygen.mjs`) and paste the PUBLIC key into `src/core/updater/trust.ts`.
- Deploy the website. Answer the website questions (`NEEDS-OWNER.md` 34-38 + the creator credit name). Confirm the two-tone design after he sees the screenshots.
- Log in to Tailscale so the VPS Aetherkeep copy can sync.
- Run `/code-review ultra <PR#>`.
- Do the real-PC checks that need his hands (PB1-PB10, B17, BR1-BR14 are in the tracker PC-check files).

---

## 11. 0.2.1 backlog (recorded, do NOT build now)

Providers (OpenAI, Codex, OpenCode, OpenRouter, custom/local; branches providers + providers-2); lite package (~160 MB); maybe a Tauri shell; a sign-in helper; an agent-browser engine; a knowledge-graph audit button (look up current docs and refresh stale notes); the Sentinel scheduler; both Blender add-ons beyond the flag; a signed installer; real-wallet BSV verification.

---

## 12. Known problems and unknowns (be honest about these)

- **Nothing in 0.2.0 has been run in the real Windows app.** All gates are automated tests. Say "not verified in the real app" until the real-PC run is done.
- Nothing about the BSV spend tool is verified with a real wallet.
- The prebuilt package has not been built or run.
- The merged tree has never run on Linux.
- Session ID for the bot audit may be wrong (section 4.5). Match sessions by title in the sidebar.
- Branch head timestamps on the remote look odd (local time vs UTC); trust the commit hashes.
- The chip session's note: at narrow widths the BSV and Blender switches sit side by side with no visible label; only tooltips tell them apart (known gap).
- A past error to avoid: do not tell the website a facts section exists before it does; do not ask the owner for facts you can look up; do not attribute a rule to the owner unless he said it.

---

## 13. Quick start for the new orchestrator (first 15 minutes)

1. Read this file, then the tracker section "SESSION SAVE POINT 4" and `CLAUDE.md` in `D:\bots\legion-dev`.
2. `git fetch cloud --prune`. Compare heads with section 4.
3. If the limit has reset: open `https://claude.ai/code`, read the sidebar by page text. Ask the browser-engines session for its report. Ask the website session for the two-tone screenshots.
4. Merge project-board first if browser-engines is still running (the order is a preference, not a hard rule; the module lists conflict either way). Then browser, then chip confirmation.
5. Tell the owner, short and answer first, what merged and what the gate said.
