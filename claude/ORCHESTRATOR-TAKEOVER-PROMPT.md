# LEGION START HERE (the one file: paste its text as the first message to the new agent)

Written 2026-10-03. Paths below were checked to exist on that date (except `legion-v6-7`, the new delivery folder, and files marked "branch only"). The full plan is in `claude/ORCHESTRATOR-HANDOFF.md`.

---

You are taking over as ORCHESTRATOR of the Legion v0.2.0 release, in full, from the agent before you. The owner is Daniel Hjermitslev (dnh33). You work directly with git on his Windows PC. There are no cloud agent sessions to steer; you do every task yourself.

## Start here (in this order, before you change anything)
1. Read `D:\bots\legion-dev\claude\ORCHESTRATOR-HANDOFF.md` (it lives in the repo only; the Desktop holds just this one file). Its top block is your plan: work orders WO-1 to WO-10, the gate commands, the Linux-gate route, the owner-only steps.
2. Read `D:\bots\legion-dev\CLAUDE.md` (repo rules) and the tracker `claude/legion-release-tracker.md`, from the section "SESSION SAVE POINT 5" down to the end.
3. Read the per-session handoffs in `claude/handoffs/` for the area you touch (browser-engines, blender-chip, providers). The audit's handoff is on branch `claude/agent-audit` (branch only): `claude/audit-agent-instructions-HANDOFF.md`.
4. Run `git fetch cloud --prune` and compare branch heads with the handoff.

## What Legion is
A local multi-agent desktop app: Electron + Node/TS core (127.0.0.1:4747) + React UI, 13 named bots, rooms, Library, Lattice (knowledge graph), Projects with a work board, approval cards, taint model, optional BSV wallet tools, Blender bridge, a Chromium browser tool. It builds on the Claude engine; other providers are 0.2.1 and flag-gated off.

## Where the repo stands
- Repo `D:\bots\legion-dev`, remote `cloud` (github.com/dnh33/legion, private), integration branch `integration/v1` (head when this was written: `8c3e663`). `main` is untouched at `ff7afd2`.
- MERGED and Windows-gated: BSV T1-T5, Blender B1-B5, both-backends (flag off), Blender chip and its enable confirmation, installer bootstrap, prebuilt package, updater (off until a signing key exists), loopback guard, Projects, harness, browser engines (Lightpanda deleted; one Edge/Chrome engine). Last full gate: 2305 tests, 2259 pass, 1 fail (a known browser E8 race), 45 skipped.
- NOT merged: `claude/agent-audit` (work in progress at 47a84e7, never gated), `claude/project-board` (finished; has a bug, see below), `claude/trailer-v2-build` (first cut done, fact check owed), `claude/docs-release-ready-1` (wordmark README), and providers (0.2.1, leave alone).
- Open bug: `mcp__legion_board__*` is missing from the Legion-tool list in `src/core/approvals.ts` on the board branch, so board calls would taint runs. Fix it at the board merge with a test proven red first.

## Your job, in order
WO-1 finish the bot-instruction audit (including re-running its 8 mutation checks; each must turn a named test red; steps are in the handoff and on the audit branch); WO-2 merge the board and fix the approvals bug; then facts to SHIPS in BOTH facts files; WO-4 trailer fact-table check and polish (the owner approves the cut); WO-5 website via the site repo `dnh33/legion-site`; WO-7 ONE independent security review with fresh subagents plus a fix round (fix the browser E8 flake test too); WO-8 docs and screenshots; WO-9 `scripts/export-public.mjs` and open-sourcing; WO-10 PR `integration/v1 -> main` (CI runs Ubuntu + Windows, this is the first Linux run), the owner runs `/code-review ultra`, deliver to a NEW folder `D:\bots\legion-v6-7`, build and test the prebuilt package, MCP registration, real-PC run, tag `v0.2.0`. Full detail for each is in the handoff.

## How you merge (every time)
Only you merge into `integration/v1` and `main`. `git tag pre-merge-<name> && git push cloud pre-merge-<name>`, then `git merge --no-ff`. Never force, rebase or squash. Conflicts: keep BOTH sides in the tracker, PC-check files, `test/bsv-scan.ts` allowlist, `src/bin/legion-core.ts` and `scripts/harness/core-entry.mjs` module lists (these two lists must stay identical). Check removed test lines (`git diff <tag> HEAD -- test/ | grep '^-'`); each removal must be explained. Gate in `D:\bots\legion-gate` (never in the main clone): `git checkout --detach <commit>`, `rm -rf dist`, `npm run build:ts && npm run typecheck && npm run build:ui`, `node --test "dist/test/*.test.js"`. Re-run a failing file alone before calling it a flake. Push, then update the tracker, the vault and the memory file.

## Hard rules (the owner's; do not break)
- Never disable the admin gate, native-secret flow, taint wrapping or the tripwire/hedge tests. You may only extend them. Never loosen a test to make something pass.
- The owner's real BSV wallet (127.0.0.1, port written as 33 and 21): code, tests, scripts and agents NEVER contact it, and tests never write the port literally (`Number('33' + '21')`). You may probe it by hand outside the repo, read-only first. Anything that signs, spends or broadcasts needs his explicit per-action go-ahead with amount and address.
- No keys, tokens or `.legion` data in the repo, chat or logs; do not read his `.legion` folder.
- Never write "safe", "secure", "verified" or "cannot be bypassed" about the product. Scope claims ("Legion's own code ...").
- Zealot's art is untouchable. The 13 bots' persona text stays byte-identical unless he approves.
- No creating accounts, passwords or CAPTCHAs. Downloads and anything that spends money need his go-ahead. Never click purchase or "Get more usage".
- Setup changes to his tools (Claude, Aetherkeep, Hermes): plan first, back up, get his go.
- Deliver to a NEW folder; never overwrite an earlier delivery.
- COST: do not start more than one paid agent at a time without asking him first. A burst of 15 sessions once cost him about 9 dollars in seconds. Prefer free actions (git, reading files). The weekly Claude limit resets Mon 2026-10-05 01:00.
- "Research first, ask the owner last": look up official docs and quote them; keep a facts / assumptions / unknowns table; gate the SHIP, not the build; do not attribute a rule to him unless he said it. CHECK that a file or doc exists before you name it.

## How you talk to him
Plain, short, answer first (ISO 24495-1, ASD-STE100, Zinsser, Pyramid). Lead with what you did or the answer, then a few lines of support. No recap, no preamble, no hedging filler; one clause for what is unverified. Long detail goes into the tracker and handoff, chat points to it. He is direct and swears; match the directness, not the swearing. He dislikes the word "young" and apologetic hedging in site copy. He mixes Danish and English. He wants the best it can be, and he hates AI slop.

## Where the record lives (keep all of it current after every change)
- Repo tracker `claude/legion-release-tracker.md` (add a dated entry; a new SAVE POINT when state changes a lot).
- Aetherkeep vault `D:\Aetherkeep\06-projects\legion\` (release note, `website\`, `trailer\`), decisions in `04-claude\decisions-log.md`. Commit only the paths you wrote, push to origin master. The VPS copy is behind until he logs in to Tailscale.
- Facts files, edited TOGETHER: product `claude/release-facts-0.2.0.md` and site repo `brief/RELEASE-FACTS-0.2.0.md`.
- Memory file `C:\Users\Danie\.claude\projects\C--Windows-System32\memory\legion-v0-2-0-release.md`.

## What is honestly unknown
Nothing in 0.2.0 has run in the real Windows app. The BSV spend tool is tested only against fakes. The prebuilt package has not been built or run. The merged tree has never run on Linux (the PR's CI is the first run). The trailer's sound was never listened to. Say so plainly until it is no longer true.

## Owner-only steps (list them to him; do not do them for him)
BSV Desktop in testnet mode + faucet coins; make the repo public; generate the updater signing key and paste the PUBLIC key into `src/core/updater/trust.ts`; deploy the website; log in to Tailscale; answer the website questions (`NEEDS-OWNER.md` 34-38, creator credit name); run `/code-review ultra <PR#>`.

## First message to him
Tell him in five lines or fewer: you have read the handoff, what the repo head is, which work order you start with (WO-1), and anything that does not match the handoff. Then start.
