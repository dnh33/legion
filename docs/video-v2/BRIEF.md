# Legion trailer v2: brief (PHASE 1, plan only; nothing rendered yet)

**What this is.** The trailer for the **beta launch of Legion 0.2.0**: what ships in 0.2.0 (the beta build), then a plainly separate **NEXT, planned for 0.2.1**. It succeeds `docs/video/` (the first trailer, left untouched). Source of truth for every claim: `claude/release-facts-0.2.0.md` (read on branch merge of `integration/v1` eec2384; it outranks the README, which is older: it still says "no spend tool" and "install from source only"). Re-read it before rendering; if it changed, the table below changes first.

**Beta wording.** "Beta" is the owner's framing and is used as a label, not a quality claim. The end card says what the beta is: built and tested, with some parts not yet tried on real services. Never "young", "stable", "production-ready".

## 1. Deliverables
| File | Spec |
|---|---|
| `legion-trailer-v2.mp4` | 1920x1080, 30 fps, H.264 yuv420p, BT.709 tagged, faststart, AAC score at about -14 LUFS, TP under -1. Committed only if 40 MB or smaller; otherwise `node docs/video-v2/render.mjs` rebuilds it (needs Node, Playwright Chromium, ffmpeg, Python with numpy/scipy). |
| `legion-trailer-v2.gif` | 960x540, 12 fps, about 15 s highlight, 8 MB or smaller |
| `poster-v2.png` | the end card |
| Source | `timeline.mjs`, `trailer.html`, `render.mjs`, `check.mjs`, `score.py`, `cues.json`, `capture/` (screenshot scripts), `shots/` (fresh PNGs), `AUDIT.md` |

## 2. Length, tempo, grid
- **100 s = 40 bars** at 96 BPM (beat 0.625 s, bar 2.5 s). It is at the top of the 75-100 s range because the brief asks for all of 0.2.0 plus a NEXT block; each shipped area gets 2 to 4 bars and none repeats. If the review finds it drags, the first things to cut are Rooms and the install card (the GIF and a 60 s cut-down would then reuse the same timeline).
- Same method as the first trailer (`claude/skills/cinematic-trailer-pipeline`): `b(bar,beat)` for every time, scene changes on bar lines, reveals on beats, `CUTS` with kinds (hard on downbeat for UI montage, dissolve 0.5 s, match for the Relic), no black except first and last frames, one anchor (the Relic, three homes), one idea per shot, reading time at least 0.3 s per word + 0.8 s, title revealed once at the end. `window.render(t)` drives everything; CSS animations seeked per frame; seeded PRNG; never screen-recorded.
- Pacing: long shots early, cuts tighten through BSV and Blender, one beat of silence before the NEXT block, a visibly different "weather" for NEXT (no screenshots, text cards, cooler tone, Relic stays), end card breathes.

## 3. Storyboard (bars of 2.5 s)
| Bars | Time | Scene | Picture | Words on screen |
|---|---|---|---|---|
| 0-2 | 0-5 | Cold open | candle on black, then the dark app silhouette | "A team of Claude agents." / "On your own computer." |
| 2-4 | 5-10 | Awakening | arch fades up, the Relic wakes on the bell (match) | "Legion 0.2.0. Now in beta." (small, not the title) |
| 4-7 | 10-17.5 | The muster | the 13 painted busts (as provided) rise on the beat, name under each; Zealot first | "Thirteen bots. Each with its own role." |
| 7-10 | 17.5-25 | Approvals and the taint model | real app shot pushes in on an approval card (Allow/Deny), then the Library Inbox with an untrusted "pending" note | "You approve the risky calls." / "What the web returns is treated as untrusted." |
| 10-12 | 25-30 | Rooms | real Rooms view, one room with bots and you | "Rooms: bots and you, with loop guards." |
| 12-15 | 30-37.5 | Library and Lattice | Library Inbox, then Lattice graph (dark) | "A shared memory you can read." / "You accept or reject what they save." |
| 15-19 | 37.5-47.5 | A VM per agent, and MCP | computer panel with VM preview (hard cut), then a terminal: `legion_list_agents`, `legion_vm`, `legion_run`, `legion_projects` | "Their own cloud computer, when you want one." / "Drive it from Claude Code or Cowork." |
| 19-21 | 47.5-52.5 | Projects | real Projects view | "Projects: tasks, rooms, notes and agents in one place." |
| 21-25 | 52.5-62.5 | BSV mode | BSV panel (read-only pack and wallet status), then the spend section and the Arm control; chain animation behind | "BSV mode. Off by default." / "A spend tool, behind your own confirmations." / chip: "Built against fakes. Not tried with real funds." |
| 25-29 | 62.5-72.5 | Blender | mode chooser (This computer / Cloud VM / Live), then Settings "Get Blender" card, then the Sculptor busts (art as provided) | "Blender, with the Sculptor." / "Runs here first. Cloud VM or live Blender if you prefer." / chip: "Not yet tried on a real Blender." |
| 29-32 | 72.5-80 | Install, update, loopback, harness | two route cards (package: no Node, no Git; source: `setup.cmd`), Update panel shot, `127.0.0.1` card, harness terminal | "Two ways in." / "Updates only when you click." / "Listens on this computer only." / "Fake model, fake wallet, fake Blender, to test it." chips on package and updater: "Built, not yet run on Windows" |
| 32-37 | 80-92.5 | NEXT (planned for 0.2.1) | five plain text cards, no UI, a thin rule and the label "NEXT · planned for 0.2.1" | "More model providers." / "A project board." / "A smaller package." / "More browser engines, optional." / "Real-wallet BSV checks." |
| 37-40 | 92.5-100 | End card | wordmark LEGION forges once, Relic rises | "LEGION" / "0.2.0 · Beta" / "Built and tested. Some parts not yet tried on real services." / sigil |

Conditional scene: **Browse without a VM** (2 bars, between Blender and Install). Rendered only if, at render time, the facts file says SHIPPED for the browser tool. Today it says IN PROGRESS, so it is out, and the timeline has a ready fallback cut (Install starts 2 bars earlier; the total stays 100 s by giving Blender and the harness 1 extra bar). If it ever ships, the honest limit goes on screen: "A local browser runs with your rights. Only a cloud VM is isolated."

## 4. Look and sound (from the product's own tokens)
- Palette `ui/src/styles/tokens.css`: `--bg #0b0d10`, `--surface #12151a`, `--line #1e232b`, `--text #e6e9ef`, `--muted #8a93a3`, accent phosphor `#7CFFB2`, warn `#FFCC66`, danger `#FF6B6B`. Trailer-only accents carried from the first trailer: gold `#caa64a`, crimson `#b3202f`, parchment `#e9dfc4`. NEXT cards use `--muted` and a cool steel rule so planned reads as different from shipped.
- Fonts (bundled in `ui/src/fonts/`): Grenze Gotisch (display), IBM Plex Sans (labels, acronyms such as MCP and VM), JetBrains Mono (terminal).
- Mascot: the Relic via `ui/src/mascot/engine.js`, states from the timeline. Busts and Zealot: `docs/art/muster/*` and `ui/src/mascot/` **as provided, never repainted**; effects, scale and layout only.
- Score: original, synthesized in `score.py` (numpy/scipy, no samples), read from `cues.json`. D minor, one chord per bar, Picardy major on the end card. Gothic half (organ, choir, bell, drums) and hacker half (arpeggio, ticks, glitch on hard cuts, key clicks on typed lines). New for v2: a thinner, cooler organ-and-bell-only texture under NEXT; a silent beat before it; a confirm blip per approval. Measured, not heard: ebur128, per-section RMS, band energy, pre-hit gap of at least 15 dB, no DC offset.

## 5. IP and wording rules
- Original look only: no double-headed eagle, cog-skull, "Emperor", "Imperium", "Adeptus", "Space Marine". **Drop the first trailer's Warhammer-tagline parody** (its AUDIT B2); cold-open copy is original.
- Never on screen: "safe", "secure", "verified", "cannot be bypassed", "young", "fully", "guaranteed". No dates. No "works with X" for any provider. No Lightpanda. No bot-instruction audit. No vendor claims, no performance numbers, no invented counts.
- Scope claims as "Legion's own ..." where a claim is about code. Safety claims are about controls, never outcomes ("You approve", not "Safe").
- Counts allowed only where the facts file or the code gives them: 13 bots; the BSV pack's 157 notes and 699 links is NOT shown (the title bar shows the real count of the user's graph and the number can differ).
- A planned item is a text card only. No UI, no logos of other providers, no screenshots.
- No end-card URL (the repo is still private). No "open source" claim until the owner says the repo is public. No keys, tokens, `.legion` data or wallet port in anything captured or committed.

## 6. FACT TABLE
Status words from the facts file: **SHIPS** (built, merged, tested), **BUILT-NOT-TRIED** (built and tested against fakes, never tried on the real service), **PLANNED**. Evidence is a path or test name in this tree; "facts" means `claude/release-facts-0.2.0.md`.

| ID | Scene / what the viewer sees | Exact words on screen | Feature | Evidence in repo | Status | Honesty wording |
|---|---|---|---|---|---|---|
| F01 | Cold open, dark app | "A team of Claude agents." / "On your own computer." | Claude-only local multi-agent app, core on loopback | facts "SHIPS"; `docs/ARCHITECTURE.md`; CLAUDE.md | SHIPS | "Claude" only; no other model named here |
| F02 | Awakening | "Legion 0.2.0. Now in beta." | version and beta label | `package.json` version; owner's framing | SHIPS (beta label is the owner's) | label, no quality claim |
| F03 | 13 painted busts, names | "Thirteen bots. Each with its own role." | 13 premade bots | `src/core/roster.ts` (10) + defaults Zealot/Builder/Scout in `store.ts`; `test/roster.test.ts`; `docs/art/muster/` | SHIPS | Assayer hidden until BSV mode is on: caption does not say "all visible at once" |
| F04 | Approval card push-in | "You approve the risky calls." | approvals: ask / auto-edits / full, Allow/Deny cards | `ui/src/components/ApprovalCard.tsx`; `test/approvals.test.ts` | SHIPS | control wording, not "safe" |
| F05 | Library Inbox, untrusted pending note | "What the web returns is treated as untrusted." | taint model: runs that used external content get notes stored untrusted and pending | scenario `library-capture-taint` (`scripts/harness/scenarios.mjs`); `test/library-capture.test.ts`; `ui/src/library/Inbox.tsx` | SHIPS | "Legion's own code treats ..." in fine print; no claim about outcomes |
| F06 | Rooms view | "Rooms: bots and you, with loop guards." | rooms of 2-6 bots plus the user; hop, budget, cycle, @everyone guards; freeze/resume | `docs/COMMS-BRIDGE.md`; `ui/src/rooms/`; `test/rooms-polish.test.ts`, `comms-room-requests.test.ts` | SHIPS | "guards" not "prevents" |
| F07 | Library, then Lattice | "A shared memory you can read." / "You accept or reject what they save." | knowledge graph, Inbox accept/reject | `ui/src/library/`, `ui/src/graph/`; `docs/LIBRARY.md`; `test/library-inbox.test.ts` | SHIPS | none |
| F08 | Computer panel with VM preview | "Their own cloud computer, when you want one." | optional per-agent cloud VM via the user's own boat.dev account | `src/core/vm-manager.ts`, `boat.ts`; `ui/src/components/ComputerCard.tsx`; `test/boat.test.ts`; `docs/VM-NOTES.md` | SHIPS | small text "your own boat.dev account"; fake boat in the capture, never claimed as live |
| F09 | Terminal typing real tool names | "Drive it from Claude Code or Cowork." | MCP tools `legion_list_agents`, `legion_vm`, `legion_run`, `legion_projects` | `src/core/mcp-tools.ts` (registerTool lines); `test/mcp.test.ts`, `mcp-isolation.test.ts` | SHIPS | terminal output limited to fields the tools really return (names, state, answer, model, cost, taskId); no invented result text |
| F10 | Projects view | "Projects: tasks, rooms, notes and agents in one place." | Projects: group tasks, rooms, notes, agents; instructions; owner-only control; read-only MCP project tool | `ui/src/projects/`; `src/core/projects/`; `test/projects-http.test.ts`, `projects-ui.test.ts`; `legion_projects` | SHIPS | none |
| F11 | BSV panel, status | "BSV mode. Off by default." | read-only knowledge pack and wallet status | `src/core/bsv/wallet-tool.ts` (`bsv_status`); `ui/src/bsv/BsvPanel.tsx`; `docs/BSV-MODE.md`; scenario `bsv-readonly` | SHIPS | no note counts on screen |
| F12 | BSV spend section and Arm | "A spend tool, behind your own confirmations." + chip "Built against fakes. Not tried with real funds." | `bsv_spend_request`; testnet and mainnet capability; mainnet hard-off behind a native-confirmed switch, an Arm, and the wallet's own prompt | `src/core/bsv/spend.ts`, `mainnet-routes.ts`; tool `mcp__legion_bsv__bsv_spend_request`; `test/bsv-spend-flow.test.ts`, `bsv-spend-native.test.ts`, `bsv-spend-tripwire.test.ts`; `SpendSection` and `ArmSection` in `BsvPanel.tsx` | BUILT-NOT-TRIED | chip is on screen the whole scene; never "safe", never "verified", never a balance or address; no wallet is contacted, capture uses fake data |
| F13 | Blender mode chooser | "Blender, with the Sculptor." / "Runs here first. Cloud VM or live Blender if you prefer." | local-first headless Blender, cloud VM, live add-on | `ui/src/blender/ModeChooser.tsx`, `copy.ts`; `docs/BLENDER.md`; `test/blender-local.test.ts`, `blender-ui.test.ts` | BUILT-NOT-TRIED | chip "Not yet tried on a real Blender." |
| F14 | Settings, Get Blender card | "One pinned Blender, only after you say yes." | managed download of ONE pinned official portable Blender, hash checked, after approval | `src/core/blender/get-blender.ts`; `test/blender-get.test.ts`; facts (5.2.2 LTS not shown on screen) | BUILT-NOT-TRIED | no version number, no download actually shown happening |
| F15 | Sculptor busts | (name only) | Sculptor agent | `src/core/roster.ts` (`sculptor`); `docs/art/muster/sculptor` | SHIPS | none |
| F16 | Package route card | "No Node. No Git. No npm." + chip "Built by script, not yet run on Windows." | prebuilt package route | `scripts/build-package.mjs`, `package-install.mjs`; `test/prebuilt-*.test.ts`; facts | BUILT-NOT-TRIED | no size, no "installer ready"; "unsigned" appears in fine print |
| F17 | Source route card | "Or from source: setup.cmd." | source route | `setup.cmd`, `scripts/setup.ps1`; `test/installer-*` | SHIPS | none |
| F18 | Update panel (Settings, About) | "Updates only when you click." + chip "Built, not yet tried." | in-app updater: checks releases, downloads after click, installs when idle, rolls back, signed manifest; OFF until a key is published and the repo is public | `ui/src/components/UpdatePanel.tsx`; `src/core/updater/`; `test/updater-*.test.ts` | BUILT-NOT-TRIED | on-screen "off until the owner publishes a key" is NOT needed; chip says not tried |
| F19 | `127.0.0.1` card | "Listens on this computer only." | loopback-only core: Host, address, Origin checks | `src/core/net-guard.ts`; `test/net-guard.test.ts`, `net-guard-source.test.ts`; facts | SHIPS | "Legion's own code listens ..." in fine print; not "cannot be reached" |
| F20 | Harness terminal | "Fake model, fake wallet, fake Blender, to test it." | agent test harness | `scripts/harness/`; `docs/TESTING.md`; `test/harness-smoke.test.ts` | SHIPS | the terminal shows real `npm run harness` output captured from a run, trimmed, never retyped |
| F21 | Conditional: Browse without a VM | (only if SHIPPED) "Browse without a VM." + "A local browser runs with your rights." | optional browser tool, off by default | `src/core/browser/`; `test/browser-tripwire.test.ts`; facts: IN PROGRESS | IN PROGRESS (out today) | not rendered unless the facts file says SHIPPED |
| F22 | NEXT header | "NEXT · planned for 0.2.1" | plan | facts "0.2.1 PLAN" | PLANNED | no dates |
| F23 | NEXT card 1 | "More model providers." | OpenAI, Codex, OpenCode, OpenRouter, custom and local endpoints | facts; `ui/src/providers/`, `src/core/providers/` (built, tested against fakes, switched OFF) | PLANNED | **no provider names on screen** (a name would read as "works with X"); sub-line "Claude is the full path today." |
| F24 | NEXT card 2 | "A project board." | work items, columns, due dates | facts ("in development, after 0.2.0") | PLANNED | none |
| F25 | NEXT card 3 | "A smaller package." | uses the user's own Claude Code | facts | PLANNED | none |
| F26 | NEXT card 4 | "More browser engines, optional." | extra engines | facts ("0.2.1 PLAN") | PLANNED | no engine named |
| F27 | NEXT card 5 | "Real-wallet BSV checks." | BSV real-wallet verification after the owner's checks | facts; `claude/tracker-pc-checks.md` | PLANNED | none |
| F28 | End card | "LEGION" / "0.2.0 · Beta" / "Built and tested. Some parts not yet tried on real services." | label | facts header | SHIPS (label) | no URL, no "open source" |

Coverage check against the facts list: bots, approvals, taint, rooms, Library, Lattice, VM, MCP (F03-F09); Projects (F10); install both routes (F16-F17); updater (F18); loopback (F19); BSV read-only and spend (F11-F12); Blender local, VM, live, managed download, Sculptor (F13-F15); harness (F20); browser conditional (F21); NEXT (F22-F27). Secrets scrubbing is shown only in the loopback fine print, not as its own scene. The bot-instruction audit is excluded on purpose.

## 7. Screenshots: only real UI, captured fresh
Rule: every UI frame is a screenshot of the built React UI (`npm run build:ui` to `dist-ui`) in headless Chromium at 1440x900, 2x, dark theme, demo data only. If a screen cannot be captured honestly it is dropped, never drawn.

Route A (primary, cheap): `docs/video-v2/capture/mock.mjs`, a copy of `ui/dev/mock-server.mjs` extended with demo responses for the routes each store calls (`/api/projects`, `/api/rooms`, `/api/kg/*`, `/api/bsv*`, `/api/blender*`, `/api/update/status`, `/api/providers` omitted). `src/` and the original mock stay untouched. The mock's default scenario flags already give approvals (`approval`), VM running (`vm-running`), tasks and messages. Electron-only controls (the Arm button, the update and BSV bridges) need `window.legion`: the capture injects a stub object with `bsvPolicy` and `admin` via `addInitScript`, which only enables the buttons to render; no click is performed and nothing is sent anywhere.

Route B (cross-check for the "built against fakes" scenes): `npm run harness` starts the REAL core with the fake model, fake wallet and fake Blender; the capture serves `dist-ui` and proxies `/api/*` through the harness `call` command so the admin secret never leaves the harness. Used for BSV, Blender, Projects, Library and Lattice if Route A's data looks thin or shapes drift. The harness fake wallet refuses the forbidden real-wallet port; no capture script writes that number.

| Screen | Where in UI | Route | Shot |
|---|---|---|---|
| Main thread with approval card, computer panel | `Thread`, `ApprovalCard`, `ComputerCard` | A (flags `approval.vm-running`) | exists in v1 style; recaptured |
| Library Inbox with untrusted pending note | `library/Inbox.tsx` | A, falls back to B (real taint path via scenario) | new |
| Lattice graph | `graph/GraphView.tsx` | A with seed nodes | recaptured |
| Rooms | `rooms/RoomsView.tsx` | A | new |
| Projects | `projects/ProjectView.tsx` | A | new (not in trailer 1) |
| BSV panel: status, Spend section, Arm | `bsv/BsvPanel.tsx` via `BsvChip` | B preferred, A if needed | new |
| Blender mode chooser and Get Blender card | `blender/ModeChooser.tsx`, Settings > Blender | A | new |
| Update panel | Settings > About, `UpdatePanel.tsx` | A (`/api/update/status` demo) | new |
| Settings (nav list, Connections snippet) | `Settings.tsx` | A | new |
| Slash menu, model picker | `SlashMenu`, `ModelPicker` | not used this time (already shown in trailer 1; no new idea) | dropped by design |

Drop rule per screen: if after two tries a screen needs invented data shapes that the real store would reject (the UI renders an error or an empty state), the scene is cut and its facts row is marked DROPPED in AUDIT.md.

## 8. Risks
1. **Older text wins by mistake.** README is behind the facts file (spend tool, install). Mitigation: only the facts file and code are quoted; contradictions listed in AUDIT.md.
2. **Overclaiming on BUILT-NOT-TRIED scenes.** Mitigation: the chip is part of the scene's own timeline entry, not an extra; `check.mjs` fails the build if a BUILT-NOT-TRIED scene has no chip, and fails on banned words ("safe", "secure", "verified", "cannot be bypassed", "young", "OpenAI", "Codex", "Ollama", "Lightpanda", "OWNER", "TODO", "lorem").
3. **Mock data drifting from real shapes**, giving screens that no real run would produce. Mitigation: Route B cross-check for BSV, Blender, Projects; types imported from `src/shared`.
4. **100 s is long.** Mitigation: the cut list in section 2; GIF is a separate highlight.
5. **Python deps** (numpy, scipy) are absent in this container; Phase 2 installs them through the proxy or, failing that, ships the render recipe only.
6. **MP4 over 40 MB** is likely at 100 s; then it is not committed and the one-command rebuild is documented.
7. **Fonts and busts** must not be altered: Zealot and the muster art are used through their own files.
8. **Facts move.** The browser scene is conditional; the facts file is re-read at render start and the render prints which conditional scenes it used.

## 9. Independent reviewer pass (does not trust the maker)
A fresh subagent (or, if none, a strict second pass as a stranger) with default verdict "not fixed". It: (a) extracts a frame every 0.5 s and the three frames either side of every cut, reads them at 1920x1080 and at 360 px width, noting clipped text, overlaps, empty frames, double exposure, labels over UI text; (b) lists every on-screen string and ties it to a row of the fact table, flagging any string with no row, any status mismatch, any banned word; (c) checks every UI frame is traceable to a file in `shots/` and the capture script that made it, and that no screenshot shows a key, token, path under a real home, or the wallet port; (d) re-runs `check.mjs`, ebur128 and the per-section RMS arc; (e) compares the end card and the NEXT cards for anything a viewer could read as a dated promise or a "works with" claim. Findings go to AUDIT.md with fixed / not fixed / left-for-owner, each fix proven by a re-render of the affected frames.

## 10. Phase gate
Phase 1 stops here. No screenshots taken, no render, until the orchestrator replies GO or sends corrections to the fact table.
