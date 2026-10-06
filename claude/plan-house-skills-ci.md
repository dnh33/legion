# Plan: house rules you can switch, shipped skills, and a CI panel

Branch `feat/house-skills-ci-panel` off main `57937cf` (worktree `D:\bots\legion-house`). Status: **design, waiting for the owner's approval.** Nothing is built yet.

## Owner decisions (2026-10-06, question UI)

| Question | Decision |
|---|---|
| How agents get skills | Through the house tools (trust check and taint kept; works for Claude and provider agents; nothing downloads at runtime) |
| Defaults | **Every shipped skill is OFF by default** and has its own switch. Skills "from Legion" are opinionated; each user turns on what they want (owner, 2026-10-06, replacing the earlier "core set on") |
| Scope | Global switches now; per-agent overrides in a follow-up |
| Core rules (AGENTS.md, CONTEXT.md) | Locked on, shown with a lock and one line saying why |
| CI | Add a CI panel with great UX: watch and run CI from inside Legion, as a floating window or docked into the layout |

## What the owner gets

1. **Settings → House, regrouped** (named **Doctrine** on screen since 2026-10-06; groups: Core tenets, Drills, Foundations, Decrees, Chronicle, Lore, Your orders; see ADR 0012 item 9). Groups in this order, each with a one-line explanation and a count:
   - **Core rules**: AGENTS.md, CONTEXT.md. Locked.
   - **Skills**, with sub-groups: *Verify and debug*, *CI and GitHub*, *Review*. The sub-groups start **collapsed**; each header shows its name, a one-line summary and "n of m on", and expands on click (and keyboard: Enter/Space, arrow keys between headers). Inside: one switch per skill, all off by default, with its one-line description, source and licence, and a "Read it" link that shows the full skill text before you switch it on.
   - **How Legion is built**: ARCHITECTURE, TESTING, VERSIONING.
   - **Decisions**: the ADRs.
   - **History**: RELEASE-NOTES, SESSION-LOG.
   - **Facts**: `context/`.
   - **Your files**: anything the owner added.

   Every rule except the core rules gets a switch. Trust ("from Legion", "edited", "approved by you") stays as a tag inside each group. "Turn all off" / "Reset to defaults" per group, and a search box when the list is long.
2. **Shipped skills**, vendored into the repo as plain files, each pinned to the upstream commit, with licence and attribution kept, and edited where the safety read asked for it (below).
3. **A CI panel.** It shows the current branch's and main's runs, live. Each run is a row of jobs: OS, shard, duration, status. A failed job opens to the failing test with its log excerpt. Buttons: *Re-run failed jobs*, *Cancel*, *Run workflow*, *Open on GitHub*. The panel can float (drag, resize, stay on top of the chat) or dock to the right edge, and it remembers where you put it. A small status chip in the title bar (green / red / running, with counts) opens it.
4. **CI tools for agents:** `ci_status` and `ci_wait`, read-only. They give an agent the same data the panel shows, so "push, then wait for CI" works inside Legion. Re-run and cancel go through an approval card, like every other outside action. No agent can start a workflow on its own.

## Facts, assumptions and unknowns

| Kind | Item | Source / check |
|---|---|---|
| Fact | Runs, jobs, logs, re-run failed jobs, cancel and dispatch are REST endpoints under `/repos/{owner}/{repo}/actions/...` | https://docs.github.com/en/rest/actions/workflow-runs , https://docs.github.com/en/rest/actions/workflow-jobs |
| Fact | A job-log request answers with a redirect to a short-lived storage URL on another host | Seen in this session: the log fetch for a running job returned an Azure blob storage "BlobNotFound" error |
| Fact | Rate limit: 60 requests per hour without a token, 5,000 with one | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api |
| Fact | Fine-grained tokens can be limited to one repository and to "Actions: read" (watch) or "Actions: read and write" (re-run, cancel, dispatch) | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens |
| Fact | "Run workflow" needs a `workflow_dispatch:` trigger in ci.yml (not there today) | https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_dispatch |
| Fact | Agent Skills format: a folder with `SKILL.md`; frontmatter `name`, `description` | https://code.claude.com/docs/en/skills |
| Fact | `copy-static.mjs` stages shipped folders non-recursively, so `skills/<name>/SKILL.md` would be missing from packaged installs until fixed | Codebase read, 2026-10-06 |
| Assumption | Polling every 10 s while a run is in progress (60 s when idle, none while the panel is closed and no agent waits) stays far under 5,000 per hour | Measure in the fake harness: count requests per hour |
| Assumption | Exact redirect hosts for logs | Record the hosts on the first real fetch; allowlist only those |
| Unknown (owner) | Which token the owner wants to use, and whether "Run workflow" is wanted at all | Asked at build time in Settings; read-only works without write rights |

## Security design (hard rules respected)

- **Network:** one new file, `src/core/ci/github.ts`, gets a `fetch` entry in the tripwire allowlist (`test/bsv-scan.ts`) with its reason, the same way the updater and providers did. It reaches `api.github.com` plus the measured log-redirect hosts only, over https, with timeouts and size caps. No child processes, so no `gh` CLI. The tripwire and hedge tests are not weakened; this is a new listed file, which is the existing process.
- **Token:** pasted once in Settings → CI. It is stored like provider keys (`<dataDir>/ci/token.json`, owner-only file, atomic write), never in config.json, logs or the UI after saving, and sent only to `api.github.com`. Without a token, public repos still work read-only at 60 requests per hour.
- **Admin gate:** all CI routes are admin-only (default deny). None are added to the MCP client list.
- **Agents:** `ci_status` / `ci_wait` are read-only. Re-run and cancel use an approval card. Log text from GitHub is outside content: wrapped as untrusted, and it taints the run.
- **Skills:** served through the house tools, so the trust hashes, untrusted-wrapping and taint are kept. A skill cannot grant itself tools or approvals. Its scripts are never run by Legion. Switch state lives in the data dir (`.house-switches.json`, next to `.adopted.json`), changed only through admin routes. It is not writable by any tool.
- **Downloads:** none at runtime. Skills are vendored at build time, from commits that were read and pinned.

## Skills to ship (from the safety read, 2026-10-06)

| Skill | Upstream (pin at build time) | Licence | Default | Edits before shipping |
|---|---|---|---|---|
| verification-before-completion | obra/superpowers | MIT | off | Legion wording; no Claude Code-only tool names |
| systematic-debugging | obra/superpowers | MIT | off | Replace the `env \| grep IDENTITY` example (it could print a secret); drop `find-polluter.sh` and the test-pressure files |
| requesting-code-review / receiving-code-review | obra/superpowers | MIT | off | Legion wording |
| gh-fix-ci | openai/skills (curated) | to confirm from the folder's LICENSE.txt; ship only if it allows | off | Point it at `ci_status` / `ci_wait` instead of the `gh` CLI; drop the Python script |
| harden-github-actions | basecamp/house-skills | MIT | off | Remove `GITHUB_TOKEN=$(gh auth token) zizmor`; generalise the Basecamp-specific lines |
| flaky-rerun rule (from LangChain baby-sit) | langchain-ai/open-swe | MIT | folded into gh-fix-ci | Re-run only when the log shows a flaky failure, never for a deterministic one |

Not shipped: Cursor `loop-on-ci` (no licence; pushes in a loop) and Warp `ci-fix` (`git add -A`, then pushes).

Also fix: the five flat `.claude/skills/*.md` developer procedures become `.claude/skills/<name>/SKILL.md` so Claude Code really loads them (repo developers only, not shipped in the app). Stale lines get fixed too: ADR 0009:51-52, context.ts:65, and AGENTS.md:13 pointing at a folder agents cannot reach.

## Build order

1. **Groundwork:** `copy-static` stages shipped folders recursively (`skills/<name>/SKILL.md`, `references/`); the test checks that staging and sync list the same files. Add a category and title per file to `GET /api/house`.
2. **Switches:** `.house-switches.json` plus admin routes `POST /api/house/switch`. They apply in `listContext`, `recallContext` and `readContextFile`, and in `hasContent`. The core rules refuse to switch off, at the route and in the UI.
3. **Skills:** vendor them under `skills/` with a `skills/SOURCES.md` (upstream, commit, licence, edits). Add `house_skills` (the list of enabled skills, name and description) and `house_skill` (load one; trust, wrapping and taint as for `house_read`). Put the list of enabled skills in the house preamble.
4. **Settings → House UI:** groups, switches, locks, search, per-group reset.
5. **CI core:** `src/core/ci/` (client, poller, cache, token store, routes) plus the tripwire entry. Fake GitHub in the harness: runs, jobs, logs, redirects, 403/404/rate limit.
6. **CI panel UI:** a general float-or-dock panel container (the first in Legion, reusable later), the CI panel, the title-bar chip.
7. **Agent tools:** `ci_status`, `ci_wait`, and re-run / cancel through approval cards.
8. **ci.yml:** add `workflow_dispatch:` so "Run workflow" works.
9. **Kodawari pass:**
   - Map every screen and state:
     - no token, bad token, rate-limited, offline
     - no runs yet, a run in progress, a 10-job run with long test names, a red run with a 400-line log
     - floating window at the edge of the screen, docked, 0.75x and 1.5x UI scale, light and dark
   - Screenshot everything at real size with the shots rig.
   - Have an adversarial reviewer try to refute each finding.
   - Fix, then re-shoot before and after.

## Tests (each with a demonstrated negative)

- **House:** a switched-off rule is absent from list, read and recall; a core rule cannot be switched off (route and UI); switches survive a restart and a sync; an agent's write to the switch file location is not honoured unless it came through the admin route; staging includes nested skill files.
- **Skills:** a fresh install has every skill off (nothing listed, nothing in the preamble); only enabled skills are listed; loading a disabled one is refused; an edited skill is served wrapped as untrusted; a load taints the run.
- **CI client:** only allowed hosts; a redirect elsewhere is refused; the token is never in logs, errors or the UI after saving; the rate-limit backoff; no polling while nothing watches; the routes are admin-only; agent tools cannot re-run without approval.
- **Tripwire:** the new file is the only new allowlist entry, and the tripwire tests still pass unchanged.

## Real-PC checks (to `claude/tracker-pc-checks.md`)

- A real fine-grained token, read-only: the panel shows live runs for dnh33/legion. Safety class: none.
- With a write token: "Re-run failed jobs" on a deliberately red PR. Safety class: none (GitHub minutes are free on a public repo).
- Floating panel across two monitors and after a restart (Windows). Safety class: none.

## Size and risk

This is a large feature: about 3-4 build rounds. The CI panel is the biggest part, and the riskiest part is the token. Suggested release split:
- **Release A:** house switches, groups and skills (steps 1-4).
- **Release B:** the CI panel and agent tools (steps 5-8).
- The kodawari pass runs on each.

CI runs every round, so the owner's PC is not needed for gates.
