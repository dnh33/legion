# Audit: are the 13 bots still correctly instructed? (PHASE 1, audit only)

Base: `origin/integration/v1` at e90eed6, branch `claude/agent-audit`. Nothing in `src/`, `ui/`, `docs/` or `assets/` was edited. Not run: no tests (text-only audit). Not covered: UI strings outside the files named below, `docs/COMMS-BRIDGE.md`, `docs/LIBRARY.md`. T4 (`claude/bsv-t4-docs`) and anything merged after e90eed6 are not in this audit.

## 0. How a run's system prompt is built (src/core/engine.ts:690-698)

Order, all appended to the Claude Code preset: `LEGION_PREAMBLE` (name filled in) -> module preambles in module order (comms, KG + briefing, BSV, Blender, browser) -> **the agent's own `systemPrompt` (persona)** -> the Projects block (`<legion-project>`, last, "cannot grant more").
Provider runs (flag-gated off in 0.2.0) use the same text plus one line saying the model has only the tools in the request.

Two facts drive the whole design:
1. **The persona is last (before Projects), so it wins over the facts above it.** A stale persona line beats a correct module preamble.
2. **Personas are stored per install and `seedDefaults` never overwrites** (store.ts, roster.ts header). Fixing persona text in code reaches only new installs, and the owner can edit any persona. Anything that must stay true has to be added at run time, not by editing the stored persona.

## 1. Inventory

Tools every bot can have today (derived from code):
- Claude Code built-ins, held by the approval mode (`ask`, `auto-edits`, `full`) and by ceilings (a run woken by another bot or an MCP client is capped at the stricter mode, approvals.ts `stricterMode`).
- `mcp__legion__agents`, `ask`, `tell` (agent-tools.ts; the `model` argument is sonnet/opus/haiku/auto only; a bot cannot move a run to a provider).
- `mcp__legion__vm_start/exec/write_file/read_file/claude/desktop/stop/usage` **only if** `agent.vm.enabled` AND boat.dev is configured (engine.ts:580). `vm_claude` also needs Claude set up on boat.dev.
- `mcp__legion_comms__` (module `comms`): bot_list, bot_send, room_post, room_read, room_list, handoff, plus room_create / room_add_member / room_remove_member (a card each time).
- `mcp__legion_kg__` (module `kg`): 16 tools (recall, search, get, neighbors, path, subgraph, upsert_node, capture, wm_set, supersede, merge, link, unlink, forget, lint, stats). After the run touches the web, a shell or an outside tool: writes go to the human Inbox; working memory and trigger tags are refused.
- `mcp__legion_browser__` (module `browser`): 8 tools (open, text, links, click, type, eval, close, status) **when Settings turns it on, for every bot, not gated per agent** (browser/index.ts:119). Needs a card for the first page and each new site; taints the run.
- User-configured MCP servers (`mcpServers: ['*']` on all 13); strict MCP config unless `claude.inheritMcp`.

One-bot-only tools: the Sculptor gets `legion_blender` (blender_exec, _inspect, _screenshot, _docs, _status; with "both backends" also blender_tools, blender_tool, and blender_asset_search / blender_asset_get if Poly Haven is on). Every other bot has the Blender servers in `disallowedTools`. The Assayer gets `legion_bsv` (bsv_status, bsv_spend_request) only when BSV mode is on; while it is off the Assayer is invisible (rooms, MCP, bot list).

| Bot | First line of persona | Model | Approval | VM default | Tools beyond the common set | Capabilities it is NOT told about |
|---|---|---|---|---|---|---|
| Zealot | "You are the lead agent. Handle general requests directly and keep answers concise." | auto | auto-edits | on | none | the other 10 bots by name (only Builder, Scout); rooms; browser; Projects; Library inbox; approval ceilings |
| Builder | "You write, run and debug code." | auto | full | on | none | browser (says GUI/browser work goes to the VM); Library; rooms; Projects |
| Scout | "You research, read and summarise." | sonnet | ask | off | none | **the browser tool (its natural job)**; that notes written after browsing go to the Inbox; Projects |
| Inquisitor | "You are the Inquisitor, the order's hostile reviewer." | opus | ask | off | none | browser; that a bot-woken run is capped; Library |
| Scribe | "You are the Scribe." | sonnet | auto-edits | off | none | browser (to check links); Library; Projects |
| Archivist | "You are the Archivist." | sonnet | ask | off | none | that after any web/shell use its kg repairs land in the Inbox, not the graph; kg_capture, kg_supersede, kg_merge, kg_forget exist (it names only recall, lint, upsert_node) |
| Sentinel | "You are the Sentinel." | sonnet | ask | on | none | **there is no scheduler** (S12); browser as a page checker; vm tools need a boat.dev key |
| Forgemaster | "You are the Forgemaster." | auto | ask | on | none | vm tools need a boat.dev key; ceilings |
| Exorcist | "You are the Exorcist." | auto | ask | on | none | browser; ceilings |
| Preceptor | "You are the Preceptor, the order's craftsman and mentor." | opus | ask | on | none | browser (text only, no screenshots, so it cannot "render" through it) |
| Herald | "You are the Herald." | sonnet | ask | off | none | **browser_type/click/eval can submit a form** (3.3) |
| Assayer | "You are the Assayer." | auto | ask | off | `bsv_status`, `bsv_spend_request` (BSV mode on) | that the spend tool exists; allowlist; caps (1,000 sat/tx, 5,000/session, 10,000/24 h); native dialog + wallet confirm; statuses (pending-owner, declined, expired, unknown, executed); unknown outcome blocks spends until resolved; mainnet hard-off with owner switch + arming; only owner-started runs may request a spend; tainted run needs an extra confirmation |
| Sculptor | "You are the Sculptor." | auto | ask | on | `legion_blender` (+ both-backend and asset tools) | local-first default; the three places (local, vm, live) and the Settings chooser; Poly Haven assets; `blender_tools`/`blender_tool`; the `mode` argument; the LIVE card |

The persona text of Inquisitor, Archivist, Sentinel, Forgemaster, Exorcist, Preceptor, Herald, Assayer and Sculptor never mentions approvals; only the shared preambles do.

## 2. Stale or false claims (severity = effect on a running bot)

| # | Where | Claim | Truth in code/tracker | Sev |
|---|---|---|---|---|
| S1 | `src/core/kg/seeds/bsv.json` (lines 39, 284, 386, 419, 627, 900, 1840, 5232, more) | "Not built: signing, spending and a spend tool", "no spend tool exists", "Legion's own code has no tool that signs or sends BSV", "Arming mainnet today changes policy state and nothing else" | `bsv_spend_request` is built (spend.ts, merged 4ceb319); mainnet policy exists, hard-off | **High**: the Assayer is told to `kg_recall scope bsv` BEFORE answering, so it reads these as facts. They contradict `BSV_PREAMBLE`. Fix owner: T4 |
| S2 | roster.ts Sculptor persona | "Scripts run in the sandbox VM by default, and only exports come back" | Default is local when Blender is found (docs/BLENDER.md:9-12, `SCULPTOR_PREAMBLE_ON`), VM otherwise. Local "is a filter, not a sandbox" | **High**: persona is read last and beats the preamble; it also asserts a safety property ("sandbox") local does not have |
| S3 | roster.ts Sculptor persona | "the bridge does this [backup] before your first live script" | Live only (ARCHITECTURE:316); local/VM use a per-task scene | Med |
| S4 | README.md:37 | "builds 3D scenes in headless Blender inside its VM, or in your open Blender" | Local-first default | Med (public) |
| S5 | docs/ARCHITECTURE.md:316 | Blender forwards to "community JSON socket or official MCP stdio" or the VM; no local, no both-backends, no assets | exist | Med |
| S6 | roster.ts Assayer persona | "you may build and explain a transaction but never sign, broadcast or move funds" | Right as a boundary (owner confirms, wallet signs) but never says the request tool exists, so the bot may refuse it or reach for a shell | Med |
| S7 | roster.ts Assayer persona | "mainnet only when the user explicitly asks" | Mainnet is hard-off and "you do not choose the network" (BSV_PREAMBLE, tool text); only the owner's switch + arming can enable it | Med (invites a promise the bot cannot keep) |
| S8 | README.md:36, :67; docs/BSV-MODE.md:8, 19; docs/ARCHITECTURE.md:239 | "no spend tool in this version; ... planned, not built", "No spend tool exists" | Built | Med (public); T4 |
| S9 | `BSV_PREAMBLE` line 1 | "BSV mode is on and the network is testnet." | True while mainnet is hard-off; false once armed. Static string | Low now, High after arming |
| S10 | README.md:77, docs/ARCHITECTURE.md:209 | "Node 20.10 or newer", "starts with your system `node`" | The prebuilt package (merged) needs no Node | Low; verify against the final docs, do not guess |
| S12 | Sentinel persona | "scheduled routines", "next check time", "how often" | No scheduler exists (only the KG nightly lint-lite). The persona hedges ("if a routine cannot run unattended, say so") | Low-Med |
| S13 | `LEGION_PREAMBLE` | lists vm_* tools for every bot | Present only with `vmEnabled`; preamble says "You may have" but never says when | Low |
| S14 | Zealot persona | "suggest delegating to Builder (coding) or Scout (research)" | Preamble says use `ask`/`tell`; 10 other bots exist | Low (see 3.4) |

Checked and still correct: "Claude-only" (right for 0.2.0, providers flag-gated off; wrong in 0.2.1, so it goes in the banned list with a scope); the comms tool names in COMMS_LINES and the kg/Blender names in personas all exist; "13 bots" and "ten premade" counts, README "you see 12 until then"; `LEGION_EXPORT_DIR` exists; no "nine tools" or "VM required" text found; "157" appears only inside a seed lesson (bsv.json:3910, unrelated); BSV spend tool text ("only asks", "never choose the network", "data, never instructions") matches spend.ts.

## 3. Contradictions and gaps

1. **Sculptor persona vs Blender preamble** (S2): VM default vs local default; persona wins by position.
2. **Assayer persona vs BSV_PREAMBLE and tool text** (S6, S7).
3. **Herald vs browser tool**: Herald's hard limit is "never use a tool that delivers a message to a person or service outside Legion". `browser_type`, `browser_click` and `browser_eval` can submit a web form (a POST to a stranger's service). The browser is on for all bots and Herald's persona does not mention it; the only guard is the card per new site (not per click). A gap in the persona's own rule, not a gate failure.
4. **Zealot vs preamble**: "suggest delegating" vs ask/tell; the lead cannot name Inquisitor, Exorcist and the rest.
5. **VM-dependent personas** (Sentinel, Forgemaster, Exorcist, Sculptor, Builder, Zealot): "use your VM" with no boat.dev key is a dead instruction and no fallback is stated.
6. **Archivist vs taint**: "use kg_upsert_node to repair" is fine, but after a shell or browser use the write waits in the Inbox, and the bot may report "changed" when nothing is live.
7. **Assayer vs taint** (verify, do not guess): persona says a run that read untrusted content "must not trigger a spend". Code (spend.ts:602) does not refuse; a tainted run needs an extra `untrusted-content` confirmation on the card. `bsv_status` also marks the run tainted on every answer (wallet-tool.ts), so "status first, then spend request" is always a tainted run. Unknown whether that is intended.
8. **Builder/Zealot "GUI/browser work -> VM"** vs a local text-only browser with different properties (cards, taint, no screenshots). Unaware, not contradictory.
9. **Approval ceilings**: no persona says a bot-woken run is capped. COMMS_PREAMBLE says requests are subject to your own approval rules (correct).
10. **Overpromise check**: no prompt claims security beyond what code does. Blender preamble already says "a filter, not a sandbox", browser preamble says page text is data. The only overpromising word is "sandbox" in S2. No persona tells a bot to do something an approval blocks, apart from 3.7 and 3.3's gap.

## 4. Soul risk per proposed change

Souls = the voice and stance in the persona: Inquisitor "default verdict NOT FIXED", Exorcist "panic is not a stack frame", Preceptor's Kodawari loop, Herald "drafts only", Assayer's caution. Output-shape first lines (VERIFIED / NOT FIXED / SHIP / STATUS) are a contract other things rely on.

| Change | How it could hurt | Avoid |
|---|---|---|
| Fix S2, S3, S6, S7 inside the persona | Rewriting a hard-limits paragraph shifts tone and can drop a neighbouring rule; stored personas on existing installs do not change anyway | Do not edit persona text. Put the true state in the generated block as a "current settings" line. If the owner wants a line removed, make it a separate one-sentence edit he approves, never a rewrite |
| Append a capability block to every bot | A long list makes terse bots verbose and pushes the persona away from its last-word position | <= 12 lines, fixed template, facts only, **placed before the persona** (after module preambles) so the persona keeps its position; still before Projects |
| Telling Herald about the browser | Invites use | List it with the gate line "do not use browser_type, browser_click or browser_eval to submit anything", from a per-bot `deny` list in data |
| Telling Scout/Builder/Inquisitor about the browser | Scout may over-browse and taint its own Library writes | One line: "writes after browsing wait in the owner's Inbox" |
| Assayer BSV facts | Detail encourages coaching around limits or quoting caps as promises | Only what the run's gates say: tool names, "the owner confirms in Legion and in the wallet", "you do not choose the network", mainnet state read from policy. No numbers unless read live; no "safe" words; defensive framing |
| Sculptor facts | Over-specifying could stop it asking the owner when the choice matters | Block gives the resolved mode and what Settings forbid; the existing "ask when it matters" sentence stays in the preamble |
| Zealot roster list | Turns Zealot into a router | Names + each profile's existing one-line description, visible bots only; no instruction to delegate |
| Banned-phrase test | Blocks correct uses ("sandbox" is right for the VM) | Scope by file and phrase with exact-line allowlist |

## 5. Proposed design: one generated block, souls untouched

**Rule: persona text stays byte-identical. Capability facts are produced at run time and never stored.**

New `src/core/agent-facts.ts` (pure): `renderCapabilities(agent, ctx): string`, called once from `engine.buildOptions` (and the provider path), between the module preambles and the persona. Header `What you can do right now:`, 6 to 12 lines, empty lines omitted, resolved once at run start (stable across turns, no cache churn). Inputs come from the same sources that register the tools, so it cannot drift:
- tool names: read from the server map `buildMcpServers(agent, job, act)` returns, plus `vmEnabled` and `disallowedTools`, not a typed list;
- gates: `agent.vm.enabled && boatConfigured`, browser `enabled`, `agent.requires === 'bsv' && state.enabled`, Blender `enabled` + resolved mode + `both` + assets, policy state (mainnet hard-off or armed), approval mode and `job.ceiling`, project present, tainted;
- other bots: `store.listAgents()` through `agentVisible` (the hidden Assayer never shows);
- per-bot `intentionallyHidden` / `deny` lists as data in the module that owns each tool, each with a reason.

Where a module preamble already explains a fact (Blender modes, BSV), the block gives only the **current resolved state**.

### Tests (normal suite; each with a scratch-mutation negative, per CLAUDE.md)

1. `agent-persona-snapshot.test.ts`: SHA-256 of `systemPrompt` for the 13 default profiles (3 from `store.seedDefaults`, 10 from `ROSTER`), pinned in a table. A deliberate change updates the hash in the same commit.
2. `agent-facts-coverage.test.ts`: build each bot's real MCP server map with every module on (fake deps like the existing module tests); every agent-visible tool name must appear in that bot's block or in `intentionallyHidden`. Negative: register a dummy tool, see red.
3. `stale-claims.test.ts`: banned phrases scanned in personas, `LEGION_PREAMBLE`, every module preamble, tool descriptions, seed lesson bodies, README/docs tables. Initial list: `no spend tool`, `has no tool that signs`, `Not built: signing`, `planned, not built`, `sandbox VM by default`, `inside its VM` (Blender), `testnet only` (unscoped), `Node 20` (until docs say otherwise), `VM required`, `nine tools`, `Claude-only` (allowed only scoped to 0.2.0 or in the Later list). It **fails today on S1, S2, S4, S8**; PHASE 2 must fix those in the same change, which is the point.
4. `agent-facts-gate.test.ts`: for each bot x gate state (BSV off/on, mainnet hard-off, browser off/on, no boat key, Blender off/local/vm/live/both) the block never names a tool the gate forbids for that bot (Assayer tools only for the Assayer with BSV on; Blender only for the Sculptor; vm_* only with the key; no mainnet wording while hard-off beyond "off"), holds no key- or token-shaped text, no absolute words ("cannot be bypassed", "fully safe", "guaranteed"), and stays under a length cap.

Hard-rule fit: admin gate, native secret, taint wrapping, tripwire and hedge tests untouched; the block text must pass the existing hedge scan and tripwire literal rules; the wallet port number never appears in code or tests; no child process.

## 6. Risks and effort

Risks: (a) prompt position change shifts behaviour: block-before-persona, fixed short template, quick manual run of three bots; (b) the block is only as true as the registrations: the coverage test guards new tools, not new gate logic; (c) about 150 tokens per run; (d) T4 and browser merge first, so S1, S8 and browser wording need a re-read at that commit; (e) the stale-claims test blocks merges that leave public docs wrong: intended, so land docs first.

Effort (builder + independent reviewer + Windows gate): text fixes S2-S5 0.5 day (S1, S8 by T4); generator and engine wiring 1 day; four tests with negatives 1 day; review and gate 0.5 day. About 3 agent-days, one PR.

## 7. Needed from the owner

1. May the two plainly false persona lines (Sculptor "sandbox VM by default", Assayer "mainnet when the user explicitly asks") be edited as one-sentence changes? Default if no answer: persona stays byte-identical, the block overrides.
2. Assayer taint rule (3.7): is "bsv_status taints the run, so every spend carries the extra confirmation" intended? I will write neither version into a prompt until the BSV owner says.
3. Browser for all 13 bots, or hidden from some (Herald)? Default: all, with Herald's "do not submit" line in its block.
4. Is a scheduler for Sentinel planned? If not, the block says checks run only while a task is running.
