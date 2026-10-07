# Tracker: backends, Codex, Herdr parity, voice, tool-call display

Lead: Zealot. Started 2026-10-06. Owner has approved nothing yet: this is the research and design phase.
The board can't take these items: the lead's run is limited and may not assign. This file is the tracker until the owner moves them to the board.

## Goals (from the owner)
1. Shell access for any LLM backend (local, endpoint), not just Claude.
2. Full 1-to-1 Codex integration; Legion knows and isolates which backend an agent runs on.
3. Learn from Herdr (herdrdev/herdr) and reach parity where it fits.
4. Native moshi voice with an intuitive UX (Preceptor).
5. Leaner, cleaner display of tool calls (no raw `legion_house·house_recall`).
6. Use this as a test of Legion as a team.

## Tasks
| # | Task | Owner | Status | Output |
|---|---|---|---|---|
| T1 | Harness research (Codex, Goose, OpenHands, ...) | Scout | done, verified | task_0bb3d7599e6a; Lattice n_96d34ae5348b (pending owner) |
| T2 | Audit of the provider path and Claude hardcodes | Builder | done | task_cde99ca5ed89 |
| T3 | Herdr + moshi identification and research | Scout | done; Moshi candidate needs the owner's confirmation | task_0bb3d7599e6a |
| T4 | Map of agent-to-agent foundation + voice gap + model pickers | Builder | done | task_cde99ca5ed89 |
| T5 | Hostile review of the backend plan | Inquisitor | done: QUESTIONABLE, 7+ findings | task_223849ed110d |
| T6 | Lattice/house sweep for prior decisions | Archivist | running | task_d36508cc4153 |
| T7 | UX: backends, Herdr ideas, voice, tool-call display | Preceptor | done: ship as design | task_ea32339a25ca |
| T5b | Review of providers-2 against the findings | Inquisitor | done: QUESTIONABLE | task_223849ed110d |
| T8 | Combined plan for owner approval | Zealot | done, waiting on the owner | this file |
| T9 | Port providers-2 onto main (feat/providers-port), without the local codex exec path, with the vm_cli fixes | Builder (Inquisitor reviews) | running, owner approved | task_cde99ca5ed89 |
| T11 | Fix: ScheduleWakeup taints the run, which blocks board assignment (fix/schedulewakeup-clean) | Exorcist | running, owner approved | task_2c6280394346 |
| T12 | How other harnesses handle a tainted shell in full mode | Scout | done: none tracks run taint; Codex guardian (policy_template.md) and Hermes hardline floors judge each action; Goose adversary_inspector | task_0bb3d7599e6a |
| T13 | Branch/worktree hygiene audit (delete only after the owner OKs) | Archivist | done; safe set waits for the owner's OK | task_e5c827d4f4ee |
| T14 | Moshi B (iOS terminal app): notifications/approvals to the phone | — | idea, owner wants both Moshis | |
| T15 | Moshi A (Kyutai): GPU fit spike on the RTX 5060 Ti 16 GB | Builder | needs the owner's OK (multi-GB download) | |
| T10 | Docs match the code on HEAD (CLAUDE.md, CHANGELOG Unreleased, release-facts; README/ARCHITECTURE were already fixed, uncommitted, alongside BSV edits) | Scribe | done, uncommitted (also the release-notes skeleton, video-v2 BRIEF:67, legion-site RELEASE-FACTS note). Video on-screen text still says "A team of Claude agents" (owner's call) | task_77139bb4cd6b |

## Key facts so far
- Provider seam exists: `src/core/providers/`, selected by `provider:model` (engine.ts:990). Provider runs share authorize()/taint with Claude but have NO shell or file tools.
- plan-providers.md §3.3 refuses Codex CLI (its tools bypass ApprovalBroker). The `codex app-server` (experimental) sends command, file-change and permission approval requests to the client: a hook point. Caveat: the `untrusted` policy auto-runs "safe" commands.
- Codex: Responses-only wire API; no `codex mcp-server`; AGENTS.md is concatenated from root to cwd; WSL2 is the documented Windows path.
- No voice code exists. Kyutai Moshi: ~24 GB for PyTorch; owner GPU RTX 5060 Ti 16 GB (Rust int8 might fit, unverified); Windows unsupported; no tool calling; English only.
- Herdr: Rust terminal multiplexer; status sidebar (working/blocked/idle), detach and resume, multi-machine, pane API.

## Inquisitor findings the plan must absorb (T5)
1. Critical: Codex `untrusted` auto-runs "safe" reads (cat ~/.ssh, auth.json, key store) with no request: no taint, data goes to OpenAI. Use `on-request` + cwd-limited read sandbox; an owner-PC check fails if reads can't be limited on Windows.
2. High: `full` mode never cards, even for tainted runs; full-to-full `tell` chains pass it on (approvals.ts:97, engine.ts:354). Same gap for Claude Bash today. Fix conflicts with the 2026-10-04 "full never cards" rule: owner decision.
3. High: taint laundering: shell and Codex fileChange writes aren't in WRITE_FILE_TOOLS (engine.ts:110).
4. High: tripwire only greps `child_process`; StdioClientTransport/execa slip through (providers-tripwire.test.ts:24).
5. High: text-shim injection: nonce delimiter, parse the newest assistant message only, one call per turn; probe cache keyed on provider+baseUrl+model, and assume no tools when unsure.
6. Medium: capabilities come from owner config only; keep the provider clamp (engine.ts:598-603) ahead of escalation.
7. Medium: CODEX_HOME must sit outside agent workspaces (auth.json in plaintext); a tainted run can poison config.toml and AGENTS.md.

## Preceptor design (T7), summary
- Rule: build on AgentEditor, AgentRail and Composer; no parallel surfaces. One word per state (reuse busyLabel, "needs your OK").
- Backends: segmented Claude · Codex · Local · Endpoint control in AgentEditor.tsx:66; capability chips (✓ Files ✓ Shell ✗ Web ✗ Skills ✗ Resume); approval labels per backend; "Codex" badge on ApprovalCard; backend glyph in AgentRail. Bug: providerModelLabel undefined, so the raw "ollama:..." string shows (providersStore.ts:69).
- Herdr: adopt the status rail (Working / Needs your OK · 7 min / Waiting on X / Idle / Error); blocked agents sort to the top; TitleBar "N need your OK" count. Pane API = ask/tell already. Multi-machine deferred.
- Voice: Dictate (push-to-talk speech-to-text into the composer; default) + Talk (full-duplex Moshi, no tools, "Send a summary to {agent}?"). Mic red dot always shown. New ui/src/voice/VoiceStrip.tsx + Settings Voice section. Unsure: a Moshi transcript; Ctrl+Space vs IME; GPU share with Ollama.
- Tool display (verdict FIX FIRST: raw names in 4 places; the registry is UI-side by choice; unknown tools default to "Server: tool sentence"; reading the MCP `title` field from external servers comes later): ui/src/chat/toolNames.ts naming map + describeTool() used by util.ts:18, ToolChip.tsx:62, bridgeView.ts:107, ApprovalCard.tsx:30. Lookups group ("Looked up 2 sources"); act calls never collapse. The Codex adapter maps items to Bash/Edit/mcp__x__y.

## Archivist (T6) + lead check: existing unmerged work
- Branch `cloud/claude/providers-2` (16757eb, NOT merged into HEAD bb663c2; 59 files, +2968) already builds, behind `config.experimental.providers`:
  - B1 `vm_cli` (codex|opencode in the VM, card, tainted);
  - B2 `kind:'cli'` Codex/OpenCode on this PC via `codex exec` (start card, owner-started only, read-only sandbox, scrubbed env, proc.ts spawn);
  - lead choices of a sub-agent's provider; delegate-only.
  - Its own words: "Legion cannot see or stop what Codex does with its own shell". Plan §19 lives there only.
- Stale house docs: ARCHITECTURE.md:5 and CLAUDE.md:3,32 say "Claude-only"; the CHANGELOG/README/release-facts say local endpoints are not in 0.2.1 while the plan says built; ORCHESTRATOR-HANDOFF says providers are flag-gated off.
- Decisions to respect: Claude is the default with no fallback (C2); only the owner picks a provider (C3/C21); only http.ts fetches and only proc.ts spawns; the same approvals and taint for everyone; nothing is "verified" before the owner's PC checks.

## T5b Inquisitor on providers-2 (QUESTIONABLE)
- The branch is 482 commits behind HEAD (base 76f3bda); a merge is a re-port (diff of 702 files, -77k lines; approvals.ts predates guardAsk).
- Fixed: the spawn tripwire (providers folder). Partly: vm_cli is carded when capped. Open: Codex exec is blind; taint laundering; CODEX_HOME passed through, so agents share the owner's ~/.codex.
- New holes: (1) vm_cli OpenCode prompt starting "--share" becomes a flag and publishes the session (vm-cli.ts:37); (2) Windows sandbox unproven, so refuse kind:'cli' on win32 until the PV check; (3) workspace-write exec writes AGENTS.md/.codex with no card; (4) vm_cli has no model ceiling, defaults to workspace-write, lacks --ignore-user-config; (5) orphan children (Windows Job Object fix).

## T8 Combined plan (for the owner)
Phase 0: do NOT merge providers-2. Port its good parts onto current HEAD (spawn tripwire, vm_cli with fixes 1 and 4, lead choices, delegate-only, the panel). Drop local `codex exec` in favour of the app-server. Fix the stale "Claude-only" wording.
Phase 1, security fixes (Inquisitor 2-4): taint for shell/CLI writes, a broader spawn tripwire, a tainted-shell card policy (owner decision).
Phase 2, Codex 1-to-1: upgrade B2 from `codex exec` (blind) to `codex app-server` with per-action approval cards; `on-request` policy; CODEX_HOME outside workspaces; item-to-tool name mapping. Owner-PC check: no read runs without a card.
Phase 3, shell for any model: a Legion shell/file tool for provider runs via proc.ts + authorize(); a text-protocol shim (nonce, newest message only) + a probe cache; capabilities from owner config only.
Phase 4, UX (Preceptor): toolNames.ts tool display; backend switch + capability chips; rail states (Herdr parity); title-bar "need your OK" count.
Phase 5, voice: Dictate (local STT) first; Moshi Talk mode after a GPU fit spike on the 16 GB card.
Every phase: Builder builds, Inquisitor reviews, Preceptor checks the UI as shipped, Scribe writes the docs.

## Codex on this PC (Inquisitor spike, 2026-10-06)
- Binary: desktop app copy, C:\Program Files\WindowsApps\OpenAI.Codex_26.930.7945.0_x64__...\app\resources\codex.exe, codex-cli 0.160.1, not on PATH; the path changes on every app update.
- Confirmed: --ignore-user-config (auth still uses CODEX_HOME); --sandbox values; the app-server exists (experimental), and its JSON schema has the 3 requestApproval methods; app-server policies untrusted|on-request|never|granular. `exec` forces approval: never.
- Refuted: a per-agent CODEX_HOME without its own `codex login` (401). Read scope NOT measured: read-only rejected every command, even inside cwd ("blocked by policy"); the Windows sandbox is perhaps not provisioned (codex-windows-sandbox-setup.exe, elevated: owner's call).
- Missing from the branch's FORBIDDEN_CLI_TOKENS: --approve-for-me, --dangerously-bypass-hook-trust, --enable/--disable, -p/-C.
- Next: owner provisions the sandbox, then rerun the canary; drive the app-server with on-request.

## Open questions for the owner
- Should a tainted run get a card for shell even in `full` mode (Inquisitor #2)?
- Which Moshi (Kyutai or the other candidate)?
- Codex: through the app-server with cards, or only inside the VM?
- Move these tasks to the board (needs the owner, or an unlimited run).
