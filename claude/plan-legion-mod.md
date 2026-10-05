# Plan: Legion Mod for Claude Code

Status: PLAN, not built. Written 2026-10-05. It replaces the earlier `plan-tui-mod.md`, which assumed a companion to the desktop core. Nothing here is verified on a real PC.

## 0. What it is

Legion for people who don't want a desktop app and just run Claude in terminal windows. It is the same agent orchestration as the desktop app, rebuilt as a Claude Code mod, with **Claude Code itself as the engine**:

- no Legion core, no port, no tokens;
- the 13 agents run as Claude Code subagents;
- approvals use Claude Code's permission flow, worded by Legion;
- the Library (shared memory), rooms, projects and the board live in the mod's own files, so every terminal window shares them.

The goal is as much of the desktop app as can work there. The look: phosphor green on near-black, the roster glyphs, calm motion, plain words for state, character in the quips. Optional 2D agents (the painted busts drawn in terminal cells) are **off by default** and cost nothing when off.

**Sources:**

- `D` = this build's mod API (`plugin-authoring/types/claude-code.d.ts`, Claude Code 2.1.286, early access, can change without notice, D:4).
- `R` = `reference.md`.
- Legion files are cited by path and line.

## 1. Desktop → mod: what maps to what

| Desktop Legion | In the mod | How (source) | Phase |
|---|---|---|---|
| 13 agents (`store.ts:127-145`, `roster.ts:24-131`) | Claude Code agent types `legion:<id>` | `$.agent.register(AgentSpec)` in `session.start`, re-registered on change (D:2960-2985, 361-444) | 1 |
| Run prompt = preamble + modules + capabilities + agent + project (`engine.ts:705-711`) | Same assembly into `AgentSpec.prompt`. Note: it **replaces** the session prompt (D:372-375); desktop appends to the `claude_code` preset. | Port the pure builders | 1 |
| Task (one thread, resumable) | One subagent run plus its resumes: `agentId` is the task id | `$.agent.spawn` (D:2943-2954); resume with `$.session.send({to:{agentId}})` (D:10650-10656) | 1 |
| Live thread, streaming | `session.append` rows plus `turn.step` chunks with `agentId`, observed from a separate hook registration | D:9695-9730, 12439-12481 (the spawning hook does not see its children, D:12467-12470) | 1 |
| Stop | `$.tool.call({tool:'TaskStop', task_id})` | D:15244-15248 (`$.turn.abort` cannot reach subagents) | 1 |
| Auto model router, /opus /sonnet, one escalation (`router.ts`) | `routeModel` reused as is, to pick `spawn({model})`; escalation rewrites `model` in `turn.step` for that agent | D:268-274, 12452-12462 | 1 |
| Turn limit + Continue (`continue.ts`) | `AgentSpec.maxTurns`; Continue sends `CONTINUE_PROMPT` (reused as is) | D:412-415 | 1 |
| Approvals ask / auto-edits / full (`approvals.ts:94-102`) | Mode → `AgentSpec.permissionMode`: `ask` → `default`, `auto-edits` → `acceptEdits`, `full` → owner decision (§9). `needsApproval` reused on top: it adds a card via `$.ui.ask` inside `tool.call` (its wait is free) or `tool.check → ask` with a `$.ui.notice` line. **Never `bypassPermissions`.** | D:395-401, 2227-2242, 11944-11960, 2149-2161 | 1 |
| Agent bridge ask / tell / agents (`bridge.ts`, guards: depth 3, hop 6, 30 per 10 min) | **ask** = Claude Code's own Agent tool, `subagent_type: legion-mod:<id>`, `run_in_background: false`: blocking, native, visible (spike S7). **tell** = the same call with `run_in_background: true`; when the child finishes, its answer reaches the caller with the desktop wording `[Reply from X · task id]`, appended into a running caller (`$.session.append({agentId})`) or resuming a finished one (runner). `legion-mod`'s `tool.call` hook on `Agent` enforces the desktop guards (deny with the desktop message) and adopts the child as a Legion task (`origin: bridge`). `mcp__legion-mod__agents` lists the order with live states. | D:2812-2827, 9695-9730 | 1 |
| Taint (`engine.ts:78-98`) | `tool.call` observer marks an agent tainted per `agentId` | D:11765-11774 | 2 |
| Library / Lattice (`kg/graph.ts` + pure kg modules) | Ported graph over a storage port on `$.fs`. Tools `mcp__legion__kg_*` with the same schemas. Briefing, working memory, close-out episode. | §3 | 2 |
| Inbox / Activity / Undo / Lint | Library view; `lintLite` on `$.clock` (desktop runs it nightly at 03:30) | | 2 |
| Rooms (`comms/hub.ts`: strategies, guards, handoff) | `hub.ts` ported with a `RoomStore` on `$.fs`. A wake = spawn or resume a member with the room context. Comms tools with the same schemas. | §3 | 3 |
| Projects + Board (`board/store.ts`, `PROJECT-BOARD.md`) | Ported stores. **A project binds to a folder**: the session's cwd picks it. Run item = spawn with `runPrompt(item)` → Review or Blocked, never Done. | | 4 |
| House context (`house/*`) | House docs ship in the plugin; `house_*` tools read `$.plugin.root` | | 2 |
| Painted busts and moods (`ui/src/mascot/*`) | 2D Order: half-block Raster frames, machine-made from the exact layers. Off by default. | §5 | 5 |
| Command palette, F-keys, Alt+1..9 | Slash commands plus pane hotkeys | §4 | 1 |
| Compaction | Claude Code's own (subagents compact themselves); `/compact` passes through | | 1 |
| Doctor | `/legion doctor`: storage writable, spawn works, glyph widths, terminal size | | 1 |

**Left out, and why:**

| Desktop feature | Why it is not in the mod |
|---|---|
| BSV Dev Kit | Its safety rests on native dialogs and the per-launch native secret; a mod has neither. The mod has **no BSV code at all**. |
| boat.dev VMs | Need a key and a live service. Possible later over `$.http.fetch`, but not in v1. |
| Blender | Possible later over `$.process`. Its click-only safety cards need their own design. |
| Other providers / OpenRouter | This mod is Claude-only by nature. |
| Browser tool | Claude Code has its own web tools. |
| Updater | Plugin updates come from the marketplace. |

## 1b. Spike results (2026-10-05)

All runs were headless (`claude -p`, Claude Code 2.1.289, haiku). The probe plugins are in the session scratchpad.

| Spike | Result |
|---|---|
| `$.agent.spawn` | Returns `{ model, agentId }` at once. `$.agent.list()` shows `status: 'running'` and the `name`. |
| `turn.complete` | One per subagent run, carrying `agentId`, `reason` (`answer`), `answer`, and `usage` (the four token counts plus `model`). |
| `session.append` | Every row of every subagent, with `agentId`. `door`: `prompt` / `response` / `tool-result` / `attachment` / `hook-context`. |
| **Visibility (new)** | **The plugin whose hook caused a spawn never sees that agent's `tool.call` or `turn.step`, even from its other hooks.** It still sees `session.append` and `turn.complete`. The cause is followed through the chain: when plugin A's `$.state.set` triggered plugin B's `state.set` hook to spawn, **A** was blind and B saw the agent. When B spawned from its **own** `$.clock.every` timer after reading A's state, A saw every step and tool call. Agents the model starts with the Agent tool are visible to every plugin. This contradicts the d.ts wording ("every other hook sees its steps", D:12467-12470), and the tests are the evidence. |
| One module per plugin | `hooks.json` `modules` takes exactly one entry. Validate refuses a second. |
| Validator rule | `$` may be passed only to a function declared at the top of the same file, and is always spelled `$.noun.method(...)`. Closures made inside a hook that call `$.fs.read(...)` validate. |
| Imports | `.ts` specifiers work in validate, `claude plugin test` and Node. Repo-style `./x.js` specifiers resolve in the engine. Node needs `--experimental-transform-types` for the vendored files (parameter properties). |
| Globals | `crypto.randomUUID` and `crypto.subtle.digest` exist in the plugin environment. |
| Turn limit (partial) | A `maxTurns: 2` agent that wanted 3 tool rounds ended with `reason: 'answer'` and an **empty** `answer`. There is no explicit flag. Detect it as an empty answer plus a step count of at least `maxTurns`. Needs a second run to confirm. |
| Nested agents (S7) | A subagent can call the Agent tool. With `run_in_background: false` the call blocks and returns the child's answer (`NESTED` came back through two levels). With the default (background) the caller ends its turn without the answer. The child's `tool.call` carries the parent's `agentId`, visible to every plugin. |
| Headless permissions | In `-p`, a subagent's Bash outside `--allowedTools` came back `isError` (denied). S1 and S2, the interactive dialogs, are still open. |

**Consequence: Legion ships as two plugins.**

| Plugin | Role |
|---|---|
| `legion-mod` | The brain: UI, approvals, taint, stores, bridge tools. It **observes** every agent. |
| `legion-mod-runner` | The hands, about 150 lines. It makes every lifecycle call: spawn, resume (`$.session.send`), stop (`TaskStop`). It acts **only from its own timer**. |

How they talk:

1. `legion-mod` writes requests into its own state (`runQueue`).
2. The runner polls that state with `$.clock.every`, at 200 ms while requests are pending and 1 s when idle. A state read is an in-process call.
3. The runner writes the outcomes (`runIds`) into its own state.

Because the runner, not `legion-mod`, causes every spawn, `legion-mod` sees every step. A test pins the rule: an agent spawned through the queue raises `tool.call` in `legion-mod`.

- **Agent types stay with `legion-mod`.** It registers `legion-mod:<id>` from its agent store. Who owns the type made no difference to visibility in the spike.
- **Bonus:** when Claude Code's own model delegates to `legion-mod:builder` with the Agent tool, that run is visible too. `legion-mod` adopts it as a Legion task (`origin: claude-code`), so work Claude Code hands to the order shows up in the pane.

## 2. Hard problems and their designs

1. **Approval UX.** A hook cannot hold a tool call while a custom pane waits: awaiting our own promise counts against the 10 s hook budget, and the call then proceeds (D:4733-4750). Designs, in order:
   - **(a)** `$.ui.ask` inside `tool.call`. It is the engine dialog, its wait is free, and the wording is ours: "⌘ Builder asks to run `npm test` · task "fix R6.1" · [Allow] [Deny] [Allow for this task]".
   - **(b)** `tool.check → ask` plus `$.ui.notice`.
   - **(c)** Deny fast with "waiting for your OK in Legion", grant from the Seal pane, then tell the agent to retry.

   Spikes S1 and S2 pick one.

   Rules for all three:
   - The agent's mode sets the baseline through `permissionMode`. Legion's `needsApproval` can only **add** cards on top of it.
   - The person's own Claude Code deny rules always win (proved by S3).
   - **No spawn ever happens inside a `tool.call` hook.** The spawning hook never sees its children's tool calls (D:12467-12470), so a spawn from the approval hook's own registration would run uncarded. Spawns are queued in `$.state` and started from a `$.clock.after` callback.
   - Test: an agent started through `ask`/`tell` that runs Bash still gets a card. It has a negative: a scratch mutation that spawns inline must make it fail.
2. **Finished agents wake the main session.** Each completion arrives as a `task-notification` prompt (D:8075-8080). Legion-managed runs drop it in `prompt.submit` and show it in the band instead. Your main Claude Code conversation is never spammed (S6).
3. **Many terminal windows, one Library.** The stated use case is several windows, and `$.fs` has no append, delete, rename or lock (D:2987-3115). The design needs no locks:
   - each session writes only its **own** append segments, `kg/seg-<sessionId>-<n>.jsonl`, rolled at 1 MiB, far under the 4 MiB cap;
   - readers merge every segment by `(at, sessionId, seq)`;
   - edits carry `rev`, and the higher rev wins;
   - compaction writes a new generation and flips `kg/manifest.json`;
   - old segments are blanked, not deleted;
   - other windows notice changes by polling `stat` every 2 s (or `FileChanged` via `watchPaths`, S9).

   The same pattern serves the board and rooms.

   **No shared single files.** Every index is per session: `tasks/<sessionId>.json`, `rooms/index/<sessionId>.json`, and so on, merged on read. Edits to projects, settings and agents are segment ops like everything else.

   **Compaction:** a session compacts only its own segments, and the manifest is per session too. Two windows compacting at once therefore never fight over one file.

   **Ownership:**
   - An agent run belongs to the window that started it. Other windows show it read-only: "running in another window".
   - A room's bot wakes are owned by one window at a time: a lease file with a 30 s heartbeat, so two windows never wake the same bots or pay twice. Any window can post; the owner wakes.
4. **Cost per agent.** The API reports tokens per turn and USD only for the session as a whole (D:12289-12372, 10829-10860). Room budgets need USD, so a price table per model gives an estimate, always shown as `≈$0.42`. A test pins the table, and its date is shown in `/legion doctor`.
5. **Hot reload and session end.** Module variables reset on reload. Running agents' fate at session end is undocumented (S5). So all state goes to `$.state` (live) and to files (durable), written as it changes, never at exit.
6. **Shared code with the desktop app.** The mod may only import files inside its plugin folder (R:14). So `npm run build:mod` copies the pure Legion files into `mod/vendor/legion/`: router, model-cap, continue, kg briefing / capture / quota / text / types, the comms contract, board and project prompts, and shared types.
   - Only **truly pure** files are vendored, byte for byte. A test fails if any vendored file differs from its source: one source of truth.
   - Files with a crypto call (`util.ts`, `scrub.ts`, `approvals.ts` through `util`) are not vendored. The mod gets small adapters of its own (`crypto.randomUUID`, `crypto.subtle.digest`, both in the mod's globals, D:13511-13636), and a parity test runs both on the same inputs.
   - The vendored files are **committed**, because a marketplace install from git does not run the build.
7. **No network, no processes.** This design needs neither `$.process` nor `$.http` at runtime.
   - A test asserts that `claude plugin validate` reports zero `process.*` and `http.fetch` calls.
   - That gives a privacy claim we can prove: the mod's own code makes no network calls and starts no programs.
   - It also means the repo's tripwire tests need no change. The frame pipeline is a build script outside the scanned roots.

## 3. Storage

Root: `~/.legion-mod/` (override with `LEGION_MOD_HOME`). It sits outside `~/.legion`, because the desktop uninstaller's `-Purge` deletes `~/.legion` recursively. Import and export use the desktop's own formats.

```
manifest.json              generations of each store
agents/<id>.json           user edits to agents (seeded from the roster; edits never overwritten)
kg/seg-*.jsonl             Library ops (same op format as desktop graph.jsonl: node / edge / del_* / patch / begin / commit)
rooms/<roomId>/seg-*.jsonl room messages; rooms/index.json
projects.json              projects (folder-bound)
board/<pid>/seg-*.jsonl    work items
tasks/index.json           task list (agentId, agent, title, status, cost≈, model, project, taint)
settings.json              mod settings (motion, 2D Order, router, limits)
```

The desktop's `graph.jsonl` can be imported read-only, because the op format is the same. An Obsidian vault can be imported and exported through the ported `vault.ts` rules.

## 4. The screen

### Surfaces

- **Status line:** `✠ Zealot · Standing vigil · 2 running · 1 awaiting your word`.
  - Plain text, at most 80 characters.
  - Turns accent while a channel is open.
- **Band (above the prompt):** shown only when something needs you: an approval, a finished run, a paused turn limit, an Inbox note.
  - One row each, with a hotkey; at most 3 rows, then `+N more · open Legion`.
  - It yields to surveys and is gone when nothing waits.
- **Pane "Legion"** (opened by `/legion`, so it seats at any width). It has its own tab row with five views: `1 Chat · 2 Rooms · 3 Library · 4 Board · 5 Order`.
  - It docks beside the transcript in fullscreen at 110+ columns, otherwise it sits inline (D:9465).
  - Order is the 2D stage, or the Ops summary when 2D is off.
- **Transcript dispatch cards:** `/to builder …` leaves a live card that freezes into one summary line, `⌘ Builder · done · 9 turns · ≈$0.21`.
- **Toasts:** only for runs you are not watching, merged per kind.

### Composer

Claude Code's own prompt is the composer, because Input is one line only. Commands:

| Command | Does |
|---|---|
| `/to <agent> <text>` | sends one message to an agent |
| `/say <text>` | sends to the shown agent |
| `/continue`, `/stop` | continue or stop the shown task |
| `/legion talk <agent>` | channel mode: every prompt goes to that agent until `/legion talk off`; the band shows `Speaking to ✠ Zealot` |
| `/room <name> <text>` | posts to a room |
| `/legion doctor` | runs the checks |

`@agent` is avoided because `@` opens Claude Code's file picker.

### Chat view

Fullscreen, docked, about 100 columns:

```
 ✠ LEGION  1 Chat  2 Rooms  3 Library  4 Board  5 Order                 ~/legion
──────────────────────────────────────────────────────────────────────────────────
 ✠ Zealot      ●  │ ⌘ Builder · Auto-edits · sonnet                  ≈$0.21 · 9 turns
 ⌘ Builder     ◐  │ ┌ fix the flaky replay ┐ tests ✓ │ docs ·                     +2
 ◎ Scout          │
 ⌕ Inquisitor  !1 │  you  Pin the clock in the replay test.
 ✎ Scribe         │  ⌘    Pinned it with an injected clock.
 ▤ Archivist      │       ▸ Read  test/replay.test.ts                           ✓
 ◬ Sentinel       │       ▸ Edit  test/replay.test.ts   +4 −1                   ✓
 ⌶ Forgemaster    │       ▸ Bash  npm test -- replay       Needs your OK  [a] [d]
 n new task       │  ⌘    Executing ▍
```

### The other views

- **Rooms:** list | transcript | meters (`Hops 3/6`, `≈$0.40/$2.00` as fixed 8-cell bars).
  - Freeze is `f`. It uses danger red and has no animation.
- **Library:** Inbox (`y` accept, `n` reject, `e` edit), Activity (undo), search, node detail.
  - The Lattice is a braille mini-map in the node-type palette (`graph/palette.ts`), with green kept for the selection.
- **Board:** a five-column kanban.
  - Below 100 columns it switches to the List layout.
  - `←/→` moves a card; `r` runs the item (the confirm is in the dialog).

### Keys

- `1–5` switch views. `n` new task. `a`/`d` answer the first card. `c` continue. `s` stop. `p` pokes the stage. `?` shows help. Esc returns to the prompt.
- Every click also has a key, because clicks exist only in fullscreen (D:5325).

## 5. The 2D Order (default off)

**What it is:**

- The painted busts, drawn as half-block cells (`▀` with fg = top pixel, bg = bottom pixel), so one cell holds two pixels, in truecolor.
- The stage shows the agent you are looking at. A "muster" row shows every agent that is working, smaller.

**Art rule** (hard rule: the art is untouchable):

- Frames are **machine-made at build time** from the exact layered art (`ui/src/mascot/data/*.json`, which follows the layer contract L-aura … L-halo-front), rendered by the repo's existing headless-browser rig and quantised to cells.
- No hand edits, ever. The pipeline is checked in, so anyone can re-derive the frames.
- Each layer stays a separate cell plane, so effects are composited at runtime and never painted:
  - bob: a 1-pixel row shift;
  - eye glow: tint L-face;
  - halo breath: modulate L-halo brightness;
  - mood tint.

  Motion follows the persona verbs (`verbs.js`: lean, nod, scan, flutter, flare, wave) and the persona tempo.

**Cost:**

| State | Behaviour |
|---|---|
| Off (default) | No frames loaded, no `$.clock` timer registered. A test asserts zero clock registrations. |
| On | Only the shown stage animates, via `$.ui.blit` (no render pass, D:2174-2194), and only when a frame changes. |
| On, frame rate | Idle bob at 8 fps, mood transitions at 12 fps, never above 12. |
| On, Dormant | Everything goes still after 60 s without an event and wakes on the next one. |

- Compositing is plain integer work on about 600–1,200 cells per frame.
- Budget: **under 1% of one core** on the owner's PC with 2D on. It is measured, on vs off, on the same scene with nothing else running (kodawari: measure relatively).
- Palette: at most about 200 colour pairs per bust, under the 1,024-pair limit (D:8431-8458).

**Toggles:**

- `/legion 2d on|off`, plus the Order view.
- Per agent: on the stage only, or also in the muster row.
- `motion: off` freezes everything, including the 2D Order.

**Fallback:** where Raster cannot draw (non-terminal surfaces), the glyph and mood words appear instead.

**Kodawari check:** each bust must be recognisable at the size it ships (about 20×12 cells). If a bust does not read at that size, that bust shows its glyph instead. Nothing gets a hand repaint.

## 6. Details that make it Legion

- **Tokens:** the desktop values unchanged (`ui/src/styles/tokens.css`):

  | Token | Value |
  |---|---|
  | bg | #0b0d10 |
  | surface | #12151a |
  | line | #1e232b / #2a313b |
  | text | #e6e9ef |
  | muted | #8a93a3 |
  | accent | #7CFFB2 |
  | warn | #FFCC66 |
  | danger | #FF6B6B |

  Light terminals get the light set. Accent means "alive and yours" and never danger.
- **Hierarchy:** weight, dim, accent and space only. Numbers are right-aligned in fixed columns so nothing jitters.
- **Wordmark:** `LEGION` in Grenze Gotisch, rasterised once at build time, 6 rows tall. It appears on the first open each day and in the empty Chat view. Never a figlet font.
- **Voice:**
  - Mood words are the desktop's own: Standing vigil, Listening, Deliberating, Executing, Awaiting your word, Victory, Fault detected, Dormant, Annoyed.
  - Quips are read from `ui/src/mascot/personas/*.json` and never rewritten.
  - State uses plain words. Every disabled action says why. Every failure gives a next step.
- **Small joys:**
  - A daily muster: the rail glyphs light top to bottom over about 600 ms.
  - Allow stamps a ✠ seal for one beat; Deny strikes the summary through.
  - A finished run gives a 1.8 s Victory.
  - Five pokes in a row: "Stop poking. I am compiling."
- **Real conditions:** every view must hold at 80, 100, 120 and 200 columns; inline and docked; dark and light; with 0 or 13 agents; with a 300-character title, ≈$1,234.56 and 99+ cards; and with 2D on and off.

## 7. Phases

| Phase | Scope | Leaves when |
|---|---|---|
| **0 Spikes** | S1–S12 below, as a throwaway mod in the dev-mods folder | Each spike has a recorded pass or fail, and this plan is amended |
| **1 The Order** | Agent types, spawn / resume / stop, router and escalation, turn limit and Continue, approvals, bridge ask/tell/agents, status line, band, pane (Chat + Order-as-Ops), commands, dispatch cards, doctor | `claude plugin validate` + `claude plugin test` pass; a scripted real session runs 3 agents in parallel with 1 card; kodawari pass; independent reviewer |
| **2 Library** | kg port on the segment store, `kg_*` tools, briefing, working memory, close-out, taint, Inbox / Activity / undo / lint, mini-map, house tools, desktop import | Ported desktop KG tests pass on the in-memory fs port; two windows write at once without loss |
| **3 Rooms** | hub port, strategies, guards, handoff, comms tools, Rooms view, export | Ported comms tests pass; a guard trip shown live |
| **4 Projects + Board** | Folder-bound projects, board store and tools, run item, Board view | Ported board tests pass |
| **5 2D Order** | Frame pipeline, compositor, stage, muster row, toggles | CPU measured under 1%, on vs off; every bust looked at, at ship size |
| **6 Ship** | Plugin marketplace package, README, screenshots, a kodawari audit of every view and state | Reviewer finds nothing worth fixing; remaining flaws are written down |

### Phase 0 spikes

| # | Question | Pass when |
|---|---|---|
| S1 | Does a background subagent's tool call reach the person as a permission dialog? | Dialog seen, and it names the agent |
| S2 | Does `$.ui.ask` work from a `tool.call` hook for a subagent's call, while the main session is idle? | Allow and Deny both work; the wait is not killed at 10 s |
| S3 | Does `tool.check`'s allow ever override a user deny rule? | We only ever escalate to ask |
| S4 | Does a `turn.step` model rewrite work per `agentId` (escalation)? | The next request runs on opus |
| S5 | What happens to running agents at hot reload and at session end? | Behaviour recorded |
| S6 | Can a `prompt.submit` `{drop}` on `task-notification` keep the main model asleep? | No main turn starts |
| S7 | How many parallel spawns, and how deep? | Limits recorded |
| S8 | Are the roster glyphs one cell wide in Windows Terminal? | Ruler screenshot |
| S9 | Does `watchPaths` drive `FileChanged`? Otherwise polling cost | Recorded |
| S10 | Does a half-block bust read at 20×12, and what does it cost at 12 fps? | Screenshot plus CPU % |
| S11 | Does `Text color` accept hex? | Pixel check |
| S12 | Do vendored modules pass `claude plugin validate`? Do repo-style `./x.js` imports resolve to `.ts`? Do type-only imports of files that are not vendored pass? | Clean validate, imports resolve |
| S13 | Can a plugin named `legion` coexist with an MCP server named `legion`? | Both sets of tools work, or the id is changed |

## 8. Tests and gates

- **Pure logic** stays tested where it lives today (`router`, `approvals`, `library-briefing`, `comms-scrub` and the rest). The vendoring test proves the mod runs the same bytes.
- **Stores** are rewritten against a `StoragePort` interface with two adapters: a Node temp dir for `node:test`, and `$.fs` in the mod. The desktop KG, comms and board store tests are ported to run on the port.
- **Mod UI:** `claude plugin test` mounts each view with fakes, a mock clock and a mock store.
- **Every new test gets a negative:** a scratch mutation that makes it fail, then a revert.
- **Repo gates** (`npm ci && npm run build:ts && npm test && npm run typecheck && npm run build:ui`) plus `claude plugin validate mod`. Exact counts are reported.
- **Hard rules kept:**
  - no BSV code in the mod;
  - mascot art only machine-derived;
  - no secrets anywhere (there are none to hold);
  - zero `process` and `http` calls (§2.7), so the tripwire tests stay as they are.

## 9. Owner decisions

1. **Plugin id.** Recommended: `legion-mod`, giving agent types `legion-mod:zealot` and tools `mcp__legion-mod__kg_search`. Plain `legion` would collide with the MCP server that the desktop app's first-run screen tells every user to add under that name. Revisit only if S13 shows the two coexist.
2. **Data root.** Recommended: `~/.legion-mod/`. The desktop `-Purge` deletes `~/.legion`, and `${CLAUDE_PLUGIN_DATA}` is deleted on plugin uninstall.
3. **Wordmark font licence.** Grenze Gotisch is expected to be OFL, but no licence file sits in `ui/src/fonts/`. Confirm before it ships.
4. **Is the left-out list right** (BSV, VMs, Blender, providers)?
5. **2D Order frame pipeline:** confirm that machine-derived half-block frames from the exact layers count as "effects and logic only" under the art rule.
6. **What `full` means in the mod.** It is Builder's mode. Options:
   - `auto`: Claude Code's classifier decides.
   - `acceptEdits` with Bash still carded. This is the safe choice.

   `bypassPermissions` is ruled out.

## 10. Real-PC checks to record when built

These go to `claude/tracker-pc-checks.md`.

S1–S11 on the owner's PC (Windows Terminal), then:

1. A three-window Library write race.
2. The 2D Order CPU measurement, on vs off.
3. A full session: Zealot hands a room to Builder and Scout; one approval card; the board item ends in Review.

Safety: Claude usage only. No money, downloads or wallet.
