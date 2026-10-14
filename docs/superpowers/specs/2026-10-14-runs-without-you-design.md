# Legion 0.3.0 "Runs without you": design spec

Date: 2026-10-14. Branch: feat/0.3.0-runs-without-you (main 3028d59). Status: APPROVED 2026-10-14 by Rune under the owner's overnight goal (D1-D5 accepted, O1-O5 defaults kept, one 8 s hold for every allow). Path: architectural.
Approved target: `docs/superpowers/specs/assets/2026-10-14-project-page/project-page-v1.html` (the mockup). Every state, string and interaction below comes from its source unless a section says "deviation".
Code facts are cited as `file:line` at 3028d59. Anything not checked is marked **unverified**.

## 1. Goal, non-goals, blocking check

### Goal
Work continues while the owner is away, and coming back takes under a minute:

1. A project page that opens on a **"since you last looked" digest**: asks sorted by consequence, capped, answerable inline, with failed and finished work folded into one line and a "Working now" strip above the fold.
2. **Truthful waiting**: what happens to an unanswered ask is a visible, per-project choice (wait 10 minutes then deny, or park); quiet hours never turn into overnight denials; nothing is ever auto-allowed.
3. **Truthful concurrency**: one agent can run several tasks; the page, the rail and the composer say so, say why a task is queued (free slot, paused, budget, queued after another run), and warn before a second run of one agent in the same project.
4. **Cross-project awareness and desktop signals**: an ask in another project is visible and answerable from anywhere; Windows taskbar overlay, desktop notifications, quiet hours, a spending view.
5. **Control you can reach**: Pause new starts, an optional budget, per-project notification level.

### Non-goals (each is its own spec or release)
- Taint labelling for project notes and the "Trust my folders" switch; the built-in read-only command list ("fewer cards"). Their Settings rows render only when the core reports the capability (section 4.9).
- Check verdicts ("3 of 3 checks passed"), diffs, "Review diff", "edit before approve", keyboard triage beyond section 3.2. No data exists for them (section 11.2).
- Routines/schedules (0.3.1). This spec only leaves the pause hook they will use.
- Layouts (Classic, Agent-first, Minimal), mods, customization. This spec honours the decide-now list (section 11.4) so they are not blocked.
- Mascot redesign (parked), per-view remembered side panel (separate decision, 2026-10-13).
- Remote or phone access, approve-from-notification.

### Blocking check (owner rule, 2026-10-13): can this stop or slow work the owner did not ask to stop?

| Feature | Can it stop or slow work? | Answer |
|---|---|---|
| Hold-then-send | Delays an Allow typed in the digest by 8 s | Only in the digest, only after the owner clicked Allow, "Send now" skips it. The thread card is unchanged (immediate). |
| Wait 10 min, then deny | Same as today (core already denies at 10 min, `src/core/approvals.ts:155`) | Default unchanged. |
| Quiet hours | An ask waits longer | Off by default. Extends a wait, never shortens it. |
| Park | Stops a run | Off by default, per project, opt-in, explained in the row. |
| Pause new starts | Stops automatic starts | Off by default. Owner clicks and chat still run (section 4.4). |
| Budget | Queues new runs at the cap | Off by default. The owner sets the cap. Live runs finish. |
| Consequence sorting | Reorders asks | Never hides one. Unknown sorts first. |
| Stop asking for reads | Removes cards | Needs a confirmation step. Narrow gate rule. |

## 2. Ground truth: what exists, what is new

### 2.1 Already in the code (build on it, do not redo it)

| Area | Where | What it does today |
|---|---|---|
| Approvals | `src/core/approvals.ts:147-193` | `ApprovalBroker`: one global `timeoutMs` default 10 min (`:155`), `request()` (`:158`), `resolve()` (`:176`), `cancelForTask()` (`:178`), events `approval.requested/resolved`. No project, no consequence, no park. |
| Questions | `src/core/questions.ts:263-302` | `QuestionBroker`: same shape and the same 10-minute auto-decline (`:269`). |
| Where cards are raised | `src/core/engine.ts:1261, 1304, 1342` (`webEgressCard`, `shellFloor`, `toolDecider`); other modules call the broker directly (`blender/guard.ts:340,598`, `comms/index.ts:19`, `browser/tools.ts:52`, `projects/board/index.ts:156`) | Only the three engine sites sit inside a run the engine owns. |
| Hook timeout | `src/core/engine.ts:1462` `cardHookSeconds = timeoutSeconds + 60`, used at `:1467, :1477, :1495` | Fixed from the global 10 min. **A longer or quiet-hours wait would outlive it** (section 5.6). |
| Card UI | `ui/src/components/ApprovalCard.tsx:60-62, 77` | Primary Allow, hard-coded "Auto-denies after 10 min". Click-only cards (Blender) via `src/shared/approval-keys.ts:15`. |
| Thread-wide A/D | `src/shared/approval-keys.ts:30-47` (`ARM_MS` 1 s, shipped 0.2.6-z) | Stray keys never allow. The digest must use the same rule. |
| Limit pauses | `src/shared/continue.ts:2-22`, `src/core/engine.ts:1000-1021` | A paused run is `status:'error'` with a text prefix; the app shows an amber "Paused" card; Continue resumes the session. Park reuses this convention. |
| Concurrency | `src/core/engine.ts:340-368` (`maxConcurrent` default 4, never set by `src/bin/legion-core.ts`), `:862-876` (`pump`), bridge children bypass the cap (`:864-870`) | Global cap. `queue` is in memory; `Store.recoverInterrupted()` (`src/bin/legion-core.ts:77`, `src/core/store.ts:279`) handles tasks left queued or running at start. |
| Queue reason | `src/shared/types.ts:219` `TaskStatus` has no reason | **Missing on the wire.** |
| Marshal busy | `src/core/marshal/orchestrator.ts:144-146, 238`; port text "busy in <project>: <title>" at `src/core/projects/board/index.ts:120-130` | Only the Marshal refuses a busy bot. |
| Board run | `src/core/projects/board/index.ts:240-257` ("Run this item", `source:'ui'`), Marshal start `:104`, loop tick `src/core/marshal/driver.ts:~82-105` | Both start with `source:'ui'`, so the core cannot tell an owner click from the loop. |
| Rail | `ui/src/components/AgentRail.tsx:47-77` | Row busy counts any project (`railRowBusy`, `projectsLogic.ts`), row ask count is this project only (`railPending`), "Needs you in other projects" section (`:35-45`, `waitingElsewhere`), "Also working in" line (`railAlsoWorking`). Shipped in 3028d59. |
| Bust state | `ui/src/mascot/useBustState.ts:147` + `awaiting.ts:5` | `awaiting` already counts questions and every project. |
| Busts | `ui/src/mascot/Bust.tsx:36-58` | Every `<Bust>` mounts a live engine (`createMascot`). The rail mounts ~13. No stills exist in the repo. `ui/vite.config.ts` ships one IIFE bundle loaded from `file://`. |
| Project page | `ui/src/projects/ProjectView.tsx:25-192` | One scrolling page of cards (name, folder, members, task list, rooms) plus `BoardPanel` (`board/BoardPanel.tsx`, tabs board/list/inbox/marshal). To be replaced by the tabbed page. |
| Project store | `src/core/projects/store.ts:73-208`, `src/shared/projects.ts:310-322` | `<dataDir>/projects.json`, keeps unknown fields (`extras`), atomic write. `Project` has no per-project settings. |
| Native confirmation | `src/core/projects/index.ts:31-36`, `src/electron/project-ipc.ts`, `src/electron/preload.cjs`, `main.ts:571` | Folder and member changes need the per-launch native secret. |
| Admin gate | `src/core/admin.ts:1-60` | Every route not in `CLIENT_ROUTES` is admin-only (default deny). MCP bearer tokens reach a short list. |
| Bot-editable files | `src/core/engine.ts:262-263`, `main.ts:70, 554` ("a bot can edit it"), `engine.ts:1141-1146, 1440-1447` | Agent shell can read and write `config.json`. File tools are blocked only in module `protectedPaths()` dirs (Armory only, `armory/index.ts:222`); "this stops the file tools, not Bash". |
| Gate rules | `src/shared/types.ts:32-75`, `src/core/gates.ts`, `ui/src/gates/` | Project-scoped allow/deny/ask rules in `config.json`; cards offer "Remember". |
| Usage | `src/shared/usage-summary.ts` (`summariseUsage`), `GET /api/usage` (`server.ts:295`), `ui/src/components/UsagePopover.tsx` | Per-task cumulative `costUsd`, attributed to the task's last-updated day; no project dimension. |
| Cost sites | `src/core/engine.ts:1672` (provider), `:1924-1929` (Claude `spent`) | Where new spend is known. |
| Tray, window | `src/electron/main.ts:364-370` (`showWindow`), `:414-416` (close hides to tray), `:507-523` (`createTray`), `:525` (`setAppUserModelId`) | No `Notification`, no overlay, no badge anywhere in `src/electron` or `ui/src` (searched). |
| Updater idle | `src/core/updater/idle.ts`, `index.ts:133, 296-310` | Pending approvals count as busy; `drain()` denies all pending approvals and cancels runs. |
| Title bar | `ui/src/components/TitleBar.tsx`, `Settings.tsx:21-35` (sections list) | Settings is a full view; no Notifications or Spending section. `UsageButton` exists. |
| Tests | `test/*.test.ts` (node:test on `dist/test`); UI logic tested as pure modules plus source greps (`test/projects-ui.test.ts`); no DOM runner | New UI logic must be pure modules. |

### 2.2 New in this spec

| New thing | Home |
|---|---|
| `Consequence` classifier (pure, fail-safe) | `src/shared/consequence.ts` |
| Ask model, counts, merge, digest events (pure) | `src/shared/attention.ts` |
| Ask clock: deny and park deadlines with quiet hours (pure) | `src/shared/ask-clock.ts` |
| Hold state machine (pure, client only) | `ui/src/projects/hold.ts` |
| One strings module | `src/shared/away-copy.ts` |
| Away store (per-project and app settings, lastLooked) | `src/core/away/` |
| Spend ledger | `src/core/away/ledger.ts` |
| Queue truth on the wire, start trigger, queue-after | `engine.ts`, `src/shared/types.ts` |
| Attention tracker, taskbar and notification plan | `src/core/away/attention.ts`, `src/electron/attention.ts` (pure plan) + `main.ts` glue |
| Bust stills | `scripts/build-bust-stills.mjs`, `ui/src/mascot/stills/`, `Bust.tsx` |
| Tabbed project page, Option A surfaces, Spending and Notifications settings | `ui/src/projects/page/`, `ui/src/components/Settings.tsx` |
| Park and resume | `src/core/away/parked.ts`, engine park path |

## 3. User-visible behaviour per surface

Region ids are stable and used as `data-region` attributes (decide-now item, section 11.4): `banner`, `working`, `digest`, `body`, `side`, `sheet`, `acts`.

### 3.1 Project page frame (mockup `.ph`, `#tabs`)
- Header: back link, title (`h1`, 2-line clamp, `title` attribute), meta line, actions. Meta line is built from one derivation (section 4.2): `13 members / 3 working here / 5 need you / new starts paused / $41.20 this week` (separator is an `aria-hidden` slash). Parts appear only when non-zero. Archived: `Archived / N members / N tasks`. Empty: `New project / no members yet`.
- Actions: split-less **New task** button (neutral mint exception: this button is the only mint control besides live dots and live card border) and a **More** menu: Pause new starts (checkbox item), Rename project, Archive project. Disabled New task shows "Add a member first" beside it (Light theme: ghost style, not a green fill).
- Tabs `Overview, Board, Tasks, Rooms, Settings`: `role=tablist`, roving tabindex, Arrow/Home/End, `aria-controls` and `role=tabpanel`. The Overview tab shows a pip with a screen-reader text "N need you" when asks exist. Counts on Board/Tasks/Rooms come from the same data. The lens radiogroup (By status / By agent) sits outside the tablist, only on Overview with 2 or more members and an active project.
- Overview is the landing tab on open. Tab and lens are in memory only (no new localStorage key); a single `pageState` seam holds them so the layouts work can move them (section 11.4).
- Archived banner sits inside the list column: "This project is archived. It starts no new tasks and its board is read-only. Nothing was deleted." Content width capped at 1180 px.
- The old single-scroll `ProjectView` cards map to tabs: name, instructions, folder, members move to **Settings** (General, Folders, Members); tasks to **Tasks**; rooms to **Rooms**; `BoardPanel` stays as the **Board** tab content (its Inbox sub-tab remains reachable; inbox proposals also appear in the digest).

### 3.2 Overview: digest on top, then state view
Order in `#content`: banner, Working-now strip, digest, body (state groups or By-agent units), and the side column.

**Working-now strip** (`working`): one compact line above the digest at 1280x820, 1280x720 and 960x600. Header "Working now" + count of working **agents**; one chip per agent with a 24 px still bust, name, and "x2" when it has 2 or more live runs in this project. Clicking a chip opens the runs menu (3.7). Empty: "No run is working right now." Queued runs add one trailing note: `Scout and 1 more: waiting for a free slot (4 of 4 running in all projects)`.

**Digest** (`digest`, `<section aria-label="Since you last looked">`):
- Header "Since 09:40" + `5 need you` (or `Nothing needs you`) + `$6.10 spent` + **Mark as seen**. The time is `lastLooked` for the project (4.2).
- "Nothing new" state (no new events and no new asks since `lastLooked`): a single status line `Nothing new since 11:30. 4 still wait on you.` (or `Nothing waits on you.`) **and the open asks still listed**. Hiding open asks behind "nothing new" was bug B1.
- List "Needs you (N), riskiest first": top 3 asks at full size; the rest behind `N more need you` (expands in place; "Show fewer"). Order: consequence level descending, then oldest first (mockup `RISK_SORT`).
- Failed, stopped and finished fold into one line `1 failed, 1 stopped, 5 finished or in review since 09:40` with Show/Hide. Expanded lists "Failed and stopped" (Open, Retry/Continue) and "Finished" (Open). Finished work lives in the state groups only otherwise.
- Ask rows by kind: **command/tool approval** (consequence chip, command in `<code>`, wait line, Allow / Deny / Open), **untrusted board proposal** (tinted row + chip, "Read it" strong, "Accept, keep it marked", "Reject", trust line), **merged reads** (one row for repeated asks of one kind: "Allow all 3", "Review", trust ledger line `22 of 22 file reads approved this week.`), **question** (one button per option, Open).
- Inline Allow is offered only when the classifier is certain (5.2). Otherwise the row's primary action is Open. This holds for `clickOnly` cards (Blender scripts and downloads), for `noRemember` cards (a command the core cannot read), and for unknown consequences.
- Allow buttons are neutral. A divider separates the risky Allow from Deny. Digest buttons are 32 px with 8 px gaps. Finished and failed rows use links, not ask-style buttons.
- By-agent lens: the digest folds to its header with "Show asks" so the units are the first thing seen.
- Keyboard: Tab through rows; J/K move between asks; A allows and D denies only under the same arming rule as the thread (`threadKey`, `ARM_MS`) and never on click-only rows. Stray keys never answer (0.2.6-z).

**Answers and the hold** (resolves A2; deviation D1 in 11.1):
- **Allow-type answers are held on the client for 8 s, then sent.** This is every answer that makes something happen: Allow, Allow all, a question option, Accept. The row becomes `Publishing in 8 s.` (verb from the classifier, else `Allowing in 8 s.`) with a visible bar, **Undo** and **Send now**. The countdown pauses while the pointer is over the row (only after the pointer has left the row once, so a resting pointer does not freeze it) or while keyboard focus is inside it (`:focus-visible`). Focus and a live-region announcement follow each state.
- **Deny and Reject are sent at once** and show a final row (`Denied. Builder was told no.`) with no Undo. A mistaken deny is recoverable (the agent asks again); a mistaken allow is not.
- **The hold lives only in the renderer's memory.** Nothing is sent until the countdown ends or "Send now" is pressed. A crash, a reload or a power cut during the hold sends nothing; the ask is still pending in the core and reappears as open. This is the safety property, tested (section 9).
- If the core settled the ask during the hold (its own deadline passed), the send returns `ok:false`; the row says `This approval was already denied after 10 min.` and nothing else happens. To avoid that race for an ask in its last 20 s, the client first calls `POST /api/approvals/:id/hold` (4.5), which only delays the core's deny.
- Rows keep their height after an answer and nothing moves under the pointer or focus: removal and promotion of the next ask wait until the pointer and focus leave the digest (B8).
- Focus never falls to `body`: one helper `restoreFocus(anchorKey)` runs after every re-render and re-finds the control by `data-fk`, else the nearest surviving sibling, else the region (B-review item 1). Retry, Continue and Stop land on the next row, not the list region (the mockup note that this still lands on the list region is a fix here).
- After "Allow all 3": `Scout will read files in this project without asking.` / `Writes and commands still ask. You can turn this off in Settings, Safety.` with **Confirm** / **Not now**. Confirm creates one project-scoped allow gate rule (4.8). Nothing is granted by the first click.

**State groups** (`body`, default lens "By status"): Working (running only), Waiting for a slot (queued, with the queue reason), In review, Stopped (failed and stopped), Done today. Item cap 5 (Done 3) with "N more". Each row: status icon, title link (opens the sheet), `agent / detail`, cost, age. Stopped rows have **Continue**; failed rows have **Retry**.

**By-agent lens**: Active units (bust 40 px with the run count badge at 2+, name, role, mode, "Cloud computer" when the VM is on; lead line; `+N more` link; `Also working in Atlas: ...`; tail `1 in review / 6 done today`; this-week cost, model, `N runs` menu, one action button). The lead line is derived from **all** open asks of the agent plus its runs, in priority needs-you, working, queued, failed, stopped, review (fixes the missing Scout asks, review item 6). Idle section: bust 20 px, `Idle. Last worked 2 d ago.`, week cost. Footer line: `3 members have no tasks here yet: ... Give one a task`. Legend: the mode explanation line.

**Side column** (`side`): "This week" block (amount, optional budget bar and `New runs wait at $50.00, you get one notification.`, link Budget / Set a budget), Rooms block (stacked 20 px busts, title, `1 needs you` chip, `Builder is answering` or `No messages for 2 h`), Members block (20 px busts with a live dot and an accessible name; hidden in By-agent lens).

### 3.3 Task sheet (`sheet`)
A side sheet, not a modal (`role=dialog`, `aria-modal=false`). At 1280 and up it pushes the list (480 px) when 520 px stay free; otherwise it covers the list, which is dimmed and `inert`. Opens task, ask, board-item or New-task content. Esc closes it and returns focus to the opener; Esc with an unsaved draft says `Press Esc again to close. Your draft is kept.` and keeps focus in the textarea (no blur). Drafts are kept per sheet key.
- Task card by status: asks (command, question, proposal, reads) with the same answer rules as the digest; working (`Builder is working` + latest step + Stop); queued (reason + `Stop waiting`); stopped (`Stopped after 200 steps. Work kept.` + Continue); failed (`Failed: ...` + Retry); in review (`says it is done` + Open full thread, **Mark done**); done; cancelled.
- Last message is per status (queued: `Not started yet. It is waiting in line.`; failed: the error; done: the run's result text). No filler text.
- Head shows the `N runs` menu when the agent has 2 or more live runs.

### 3.4 Composer: "New task" sheet
Type-first. `To:` pill (default "Best fit (Marshal chooses)") and `in` project pill, `@` autocomplete. Foot: `Enter starts it, Shift Enter adds a line.` plus a typical cost (`About $1.50 for a task like this.`, the mean `costUsd` of that agent's done tasks, else a default).
**Second-run warning**: if the chosen agent already has a live run in the same project, a box replaces the free-text note: `Builder is already working here.` / `Publish the package is in progress. Run anyway: both runs work at once and share the project folder. Queue after it: starts when Builder finishes.` with **Run anyway** / **Queue after it** (`aria-pressed`). Start does nothing until one is chosen (focus moves to the box and it announces). Best fit picks the member with the fewest live runs. Queue after it maps to `startAfter` (4.3).
The box appears only for the same project; a run elsewhere stays the existing "Also working in ..." pill (`Composer.tsx:46, 187`).

### 3.5 Rail (Option A)
- Project control: a **menu button** replaces the native `<select>` (`ProjectSwitcher.tsx:210`): project name plus `<dot> 2 elsewhere` when asks wait in other projects; menu items are `menuitemradio` rows with `N need you` and an amber dot. Keeps All projects, archived group, New project.
- "Needs you in other projects" stays (cap 3 rows + `N more`, which opens the project menu).
- Member rows: bust 34 px still at rest; **run count** (plain numeral, text-2 on surface-3, bottom right of the bust, only at 2 or more live runs in any project); one sub-line with one priority: `Needs you: publish package` (this project, amber) > `Working: payment flag` / `Payment flag · also Atlas` > `In Atlas: map theme variables` > role. Row `aria-label` carries the full text and the run count; the sub-line has a `title`. One tab stop, arrows move inside; skip link "Skip to project page".
- Bust and row agree: both count all projects (already true since 3028d59); questions count (already true).

### 3.6 Settings (project) and While you are away
Project Settings tab, left nav with scroll-spy and a dot for "Changed from the default": General, Folders, Members, While you are away, Safety, Budget, Notifications, Archive.
- **While you are away**: radiogroup "When nobody answers": `Wait 10 min, then deny` (Default) or `Park the run after [3] min` (input validated 1 to 120 with an alert `Enter a whole number from 1 to 120.`). Helper text follows the radio. Under Wait, an ask older than 10 min is shown as `Denied after 10 min` (never as waiting). Rows: Pause new starts (switch), Let the Marshal start board items (switch, writes the existing `PUT .../board/marshal`), Keep your computer awake while work runs (switch, only while a run is active in this project; **unverified**: needs `powerSaveBlocker` in main, mark as a stub row until built, section 11.3).
- **Safety**: rows for read-only commands, reads without asking (this spec), Trust my folders (other spec). Only the reads row ships here.
- **Budget**: "Set a weekly budget" switch, `$` input, Day/Week/Month segmented control. Off by default. Text: `At the budget, new runs wait, running work finishes, and you get one notification.`
- **Notifications**: Needs you and problems (default) / Everything / Nothing. Lead: `You hear about what needs you and what failed. Quiet hours are in app Settings.`
- Controls are 24 px minimum; switches 40x24.

### 3.7 "N runs" menu (chat header, By-agent unit, sheet head, Working-now chip)
`role=menu`, grouped by project (current project first), current run checked, each row = status icon, title, step or `Needs you`, cost, and **Stop** for working runs. Header line: `Builder: 2 live runs. 4 of 4 slots in use.` Clamps and flips to the space available (`place()`), including the protection-level menu. Added to `Thread.tsx:221` (`thread-head`), shown only at 2 or more.

### 3.8 Banners
- Budget reached: one line `Budget reached: $50.00 this week. New runs wait until Monday.` + **Change budget** (popover: new amount + Save budget; below it a second, quieter action `Run anyway this week`, which says `Runs that start now cost real money.`).
- Paused: `New starts are paused.` / `Tasks you start yourself still run. Board items and Marshal starts wait.` + **Resume**.

### 3.9 Notifications, taskbar, tray (app level)
- **Desktop notification** (Electron `Notification`), one per thing, in these cases only: a run needs you (approval or question), a run failed, a parked run is waiting, the budget was reached. Never for working or finished, unless the project level is "Everything". Never when the window is focused on that project's page or that thread. Bursts group (`3 things need you in Shop`). Body text is **fixed vocabulary only** (agent name, class of ask, project name): never command text or any agent-written text (untrusted). Click shows the window and opens the ask (section 4.6); there is no Allow in a notification.
- **Taskbar overlay**: `win.setOverlayIcon(icon, description)` (Windows only; `app.setBadgeCount` is macOS and Linux only per Electron docs). One overlay, set from one number: the count of open asks (blocking asks plus proposals). Working runs show no overlay (a progress mode of `indeterminate` is **not** used in 0.3.0). Cleared with `null` at zero. The description (`3 things need you`) is for screen readers. Overlays do not queue and must not animate, so it is recomputed only when the count changes. Icons: pre-drawn 16x16 for 1 to 9 and `9+`, plus a "paused" glyph is **not** shipped.
- **Tray**: tooltip becomes `Legion: 3 need you` (and `Legion` at zero); menu gains `Open what needs you` (shown only when asks exist) above Show Legion. `showWindow()` (`main.ts:364`) stays the one place that raises the window.
- **Quiet hours** (app Settings, Notifications): master switch, from/to time (default 22:00 to 07:00, off). During quiet hours there are no popups and no overlay change beyond the number; asks keep waiting and their deny clock is paused (4.5). At the end, **one summary** notification: `While you were away: 2 need you, 1 failed, $3.20 spent.` Same summary when the app regains focus after being away 30 min or more (digest data, no new store).
- **Spending** (app Settings, Spending): this week and today across projects, by project, by agent, last 14 days (4.7), with the sentence that cost is counted per run from the ledger since 0.3.0 and older tasks are shown by their last-updated day.

## 4. Data model and API

All new routes are admin-only by default deny. None is added to `CLIENT_ROUTES` (`src/core/admin.ts:~50`). A test asserts a bearer-token request to each returns 403.

### 4.1 Away store (new): where settings live and why
`<dataDir>/away/` (a directory so one `protectedPaths()` entry covers it), file `policy.json`, written like `ProjectStore.persist()` (debounced, tmp + rename, `src/core/projects/store.ts:193-207`), unknown fields kept, a corrupt file renamed `.corrupt-<ts>` and defaults used. Not `config.json` (a bot can edit it) and not `projects.json` (outside the Armory-style protection, and the owner's project record should stay small).

```
policy.json  { version: 1,
  app: { quiet: { enabled, from: 'HH:MM', to: 'HH:MM' }, notify: { enabled, returnSummary } },
  projects: { [projectId]: { onSilence: { mode: 'deny' | 'park', parkMinutes },
                             paused, budget: { limit, period: 'day'|'week'|'month' } | null,
                             budgetOverrideUntil?, notify: 'problems'|'everything'|'nothing' } },
  looked: { [projectId]: ISO } }
```
Defaults (absent = this): deny at 10 min, not paused, no budget, notify "problems", quiet off. Setting values are bounded on load (park 1 to 120, limit finite > 0, times valid and `from != to`); an invalid value is replaced by the default.

Nothing in this file can allow an ask: the worst a tampered file does is park sooner, pause starts, set a tiny budget, silence notifications, lengthen a wait, or move the digest window. It CAN undo the owner's own pause or budget after a restart (the same exposure as `config.json`); on load a budget override is cut to the end of the current period and dropped when there is no budget. Allow-capable state (the reads grant) stays in gate rules, which already exist (4.8).

### 4.2 `lastLooked` and the digest window
- `looked[projectId]` is set by `POST /api/away/projects/:id/seen` using the **core's clock**, only from the "Mark as seen" button (explicit; see open point O2 for an automatic rule). Absent: `max(project.createdAt, now - 24 h)`. The window is never longer than 7 days.
- Events in the window (pure, `attention.ts: digestEvents(tasks, board, since)`): failed (`status:'error'` and not a limit or park pause) `updatedAt >= since`; stopped (limit pause); finished (`status:'done'`, or board item in review) by `updatedAt`; `spend` = ledger sum since `since` (zero after Mark as seen). The mockup's `$6.10 spent` uses this.
- Tasks come from the window's store plus `loadProjectTasks` (`ui/src/projects/projectsStore.ts`); the slim snapshot (`server.ts:248-262`) does not carry everything, so the digest asks the paged route for this project on open.
- Cheap invariant, tested: the same `deriveAsks` + `digestEvents` feed the meta line, tab pip, digest header, "Needs you (N)", rail, switcher, room chip and (via the core) the overlay. Scopes are labelled (since 09:40 / this week / done today).

### 4.3 Queue truth, start trigger, queue-after
- `BridgeStartParams` (`engine.ts:383`) gains `trigger?: 'owner'|'marshal'|'schedule'|'room'|'delegation'` (default `owner`) and `startAfter?: true`. Call sites to set it: Marshal port (`board/index.ts:104`) and matcher (`marshal/matcher.ts:85`) pass `marshal`; board "Run this item" (`board/index.ts:250`) stays `owner`; bridge/room starts pass `delegation`/`room`.
- `Job` gets `after?: string[]` (task ids of this agent's live tasks in this project at enqueue time when `startAfter`). `pump()` (`engine.ts:862-876`) skips a job when `blockedReason(job)` is not undefined, in this order: `budget` (project budget reached and no override), `paused` (project paused and `trigger` in marshal/schedule), `after` (any `after` task still active), `slot` (active >= cap, the existing loop condition). Bridge children of a live parent keep bypassing every block (they are part of a live run finishing).
- Wire: `StateSnapshot.queue?: { cap, running, items: [{ taskId, reason: 'slot'|'paused'|'budget'|'after', position }] }` and a new event `{ type:'queue.updated', queue }` emitted whenever the queue or active set changes. `running` is `active.size`; the UI shows `min(running, cap)` because bridge children can exceed the cap. Not persisted: queue state is in memory and `recoverInterrupted()` already settles tasks at start.
- Copy from the reason (strings module): slot `Waiting for a free slot (4 of 4 running in all projects)`, budget `Waiting for the budget`, paused `Waiting: new starts are paused`, after `Queued after Builder's current run`.

### 4.4 Pause new starts: exactly what it blocks
Per project, `paused` in the away store, `PATCH /api/away/projects/:id`.
- **Blocks**: Marshal loop dispatch (`driver.ts` tick returns early when paused; defense in depth: `trigger:'marshal'` is also queued with reason `paused`), future schedules (`trigger:'schedule'`, 0.3.1 reads the same `isPaused(projectId)`).
- **Does not block**: tasks the owner starts (composer, project page, chat, **board "Run this item" and "Start with <agent>"**, which are the owner's click, `board/index.ts:250`), continuing a task, MCP-client starts, agent-to-agent delegations and room replies of a live run (blocking a child would stall its parent; the cap logic already exempts them), and runs already live (they finish).
- Deviation D2: the mockup queues the owner's "Start with Scribe" on a paused project. The owner's click is a manual start, so it runs. Pause copy already says "Tasks you start yourself still run."
- Project switcher and rail show nothing for pause; the page shows the banner and the meta part `new starts paused`.

### 4.5 Ask clock, wait policy, quiet hours, hold
- `ApprovalBroker` and `QuestionBroker` get an optional `AskPolicy` (constructor option, like `projects?` on the engine): `policyFor(projectId) -> { onSilence, parkMinutes }` and `quiet() -> QuietConfig|undefined`. Absent policy = today's behaviour. `request()` opts gain `projectId?: string`, `parkable?: boolean`, `onPark?: () => void`.
- `ApprovalRequest` (and `PendingQuestion`) gain `projectId?: string` (so the cross-project signal needs no task join; the slim snapshot may not hold the task) and `consequence?: Consequence` (4.10). `StateSnapshot.parked?: ParkedAsk[]`.
- `src/shared/ask-clock.ts` (pure, used by core and UI so they cannot disagree): `denyAt(askedAtMs, waitMs, quiet) -> ms|null`. Rule: **the deny clock counts only time outside quiet hours.** An ask raised in quiet hours starts counting at quiet end; one raised 4 min before quiet start has 6 min left when quiet ends. `parkAt(askedAtMs, parkMinutes) -> ms`: parking is **not** extended by quiet hours (parking loses nothing, and overnight parking is the right behaviour). Quiet window is local time, may wrap midnight, DST-safe (computed from local fields, not +24 h), `from == to` is invalid (treated as off). The broker re-arms its timer at each quiet boundary.
- `POST /api/approvals/:id/hold { ms <= 15000 }` (admin): extends the core's deadline so it cannot fall before `now + ms`, once per ask. It never answers the ask and never allows anything; if the client dies, the extension simply runs out.
- Hook timeout: `engine.ts:1462` must use the longest possible wait: `waitMs max + 24 h + 60 s` (**unverified** that the SDK accepts a timeout this large in `HookCallbackMatcher.timeout`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:963-969`; spike in PR 2 with the fake-backed harness. If it is capped, quiet-hours waiting falls back to parking for that ask).
- The wait text sent to the model keeps today's meaning ("No one answered the approval request within 10 minutes, so this action was not run...") and uses the project's wait. The card note becomes dynamic: `Auto-denies after 10 min` / `Parks after 3 min` / `Waiting: quiet hours until 07:00`.
- Questions follow the same policy: deny (declined) or park.

### 4.6 Attention (cross-project, overlay, notifications)
- `src/shared/attention.ts`: `deriveAsks({ approvals, questions, parked, boardInbox, tasks, projects }) -> Ask[]` where `Ask = { id, kind: 'approval'|'question'|'proposal'|'parked', taskId?, agentId, projectId|null, at, consequence }`, and `counts(asks, byProject)`. An ask is anything waiting on the owner, so proposals count (they wait in the Inbox); an ask in a held-but-unsent state still counts in the core (and for the overlay) and is shown as "sending" in the renderer, so counts can differ by up to the hold length. Questions count everywhere (already so in `awaiting.ts`).
- Core: `AttentionTracker` subscribes to the bus (`approval.*`, `question.*`, `task.updated`, `board.updated`, `away.updated`) and emits `{ type:'attention.updated', total, working, byProject }`; `GET /api/attention` returns the same. The renderer does **not** need this event (it derives the same numbers from its store with the same pure function).
- Main process: consumes `/api/events` with the admin secret it already holds (**unverified**: a second SSE subscriber from main; fallback is a 3 s poll of `GET /api/attention`) and feeds `src/electron/attention.ts` (pure): `plan(prev, next, prefs, windowFocusInfo, nowMs) -> { overlay: {count}|null, notifications: Notification[], tray: string }`. Main only performs the Electron calls. Notification click -> `showWindow()` then IPC `legion:open-ask` with `{projectId, taskId|askId}`; the renderer routes it with one function `openAsk(ref)` (the existing `rail-wait-row` click, `AgentRail.tsx:39-41`, becomes that function). Toast delivery for an unpackaged `electron.exe` with AUMID `dev.legion.app` (`taskbar.ts:11`, `main.ts:525`) is **unverified**; hands-on check H9.

### 4.7 Spend ledger, budget, spending view
- `<dataDir>/away/spend-YYYY-MM.jsonl`, append-only, one line `{ at, taskId, agentId, projectId?, usd }`, written at the two cost sites (`engine.ts:1924-1929` using the computed `spent`, and `:1672` for provider runs that report cost). Failure to write never fails a run. The existing task `costUsd` is unchanged.
- Period boundaries are local time: day, ISO week starting Monday 00:00 ("until Monday"), calendar month.
- `isBudgetReached(projectId)` = limit set, no override, `periodTotal >= limit` (the mockup test). A run starting is judged once, at `pump`; live runs finish; one `budget.reached` notification per period; `budgetOverrideUntil` = end of period, set only by "Run anyway this week".
- `GET /api/spend?scope=app|project&project=ID` returns `{ week, today, byProject[], byAgent[], daily[14] }`. This extends `summariseUsage` (`usage-summary.ts:41`) with a `projectId` dimension; the ledger replaces the "last updated day" attribution for runs after 0.3.0.
- Rooms keep their own all-time `Room.costUsd` (`comms.ts:46`); the Rooms tab shows it as `so far` (the mockup's per-week room cost has no source).

### 4.8 Reads grant ("Stop asking for reads in this project")
A project-scoped gate **allow** rule (`GateRule`, `types.ts:53-63`), `source:'card'`, `when: { projects:[id], tools:['reads'], paths:[<project folder>/**] }`, created through the existing Settings gates route after the Confirm step; deleting it (Settings switch off, or Gates) restores asking. It never applies to a capped run (existing rule, `gates.ts` header). The first click grants nothing.

### 4.9 Capability flags
`StateSnapshot.caps?: { readOnlyCommands?: boolean, trustFolders?: boolean, keepAwake?: boolean }`. The Safety and While you are away rows for unbuilt features render only when the flag is true. Absent flag = row hidden (never a "Not built yet" badge in the shipped app).

### 4.10 Consequence classifier (`src/shared/consequence.ts`)
```
classify(call: { kind: 'approval'|'question'|'proposal'|'reads', toolName, input, projectFolders }): Consequence
Consequence = { level: 0|1|2|3, tags: ('spends'|'leaves'|'deletes'|'irreversible'|'edits'|'reads'|'decides'|'unknown')[],
                chip: string, ing?: string, certain: boolean }
```
- Levels: 0 a decision with no side effect beyond the answer (question), 1 read-only inside the project, 2 reversible local change or an untrusted proposal, 3 irreversible, leaves your computer, spends money, or unknown.
- **Unknown is level 3**, `tags:['unknown']`, `certain:false`, chip `Unknown effect, check it`. Any tool name with no rule, any shell program with no rule, an unparseable command, a throw inside `classify` (caught by the caller and mapped to unknown), and `input` of an unexpected shape all land here. The table is data (`TOOL_RULES`, `PROGRAM_RULES`) so a missing entry can never lower a level.
- Recognised level 3 examples: package publish (`npm|yarn|pnpm|cargo publish`, `gh release`), `git push`, network writes (`curl -X POST`, `Invoke-WebRequest -Method`), deletes (`rm`, `del`, `rmdir`, `Remove-Item`, `git clean`, `git reset --hard`), money tools. Recognised level 1: read tools and the read-only program list (`git status|log|diff`, `ls`, `cat`, ...). Reuse the shell tokenising that the shell floor already has (`src/core/exec/shell-floor.ts`); the classifier must not be looser than the floor. The read-only list is shared with the "fewer cards" work when it lands (O3).
- Sort key `(level desc, askedAt asc)`. `certain` gates inline Allow (3.2).
- The core attaches `consequence` when it raises a card (broker option fed by the engine), so every client sees the same value; the UI also imports the function for the New-ask and test paths.

## 5. Safety rules

1. **Nothing is ever auto-allowed.** The only automatic outcomes are deny, park, and wait. There is no timer path to `resolve(id, true)`. A test greps the away module and the broker for any `true` resolution reachable from a timer.
2. **The hold is client-side.** The renderer sends Allow only after the countdown or "Send now". No new core state can send it. A reload, crash or kill during the hold sends nothing and the ask remains pending (5.7).
3. **Fail-safe classifier.** Unknown is the highest level and disables inline Allow (4.10). `classify` never returns a lower level on error.
4. **Inline Allow is never offered** for `clickOnly` cards (`approval-keys.ts:15`), `noRemember` cards, or `certain:false`. The digest cannot become a faster way past a card the thread already makes you read.
5. **Settings that can loosen live where they are protected.** The away store never allows an ask (4.1); it can be edited back to undo the owner's own pause or budget. Allow-capable state is a gate rule in `config.json`, an existing exposure; creating one needs the Confirm step. Folder and member changes keep the native confirmation (`projects/index.ts:31-36`). `main.ts` has **no** protected-path list: it pins port and token at start and does not re-read `config.json` (`main.ts:70, 554`). The real protection hook is `CoreModule.protectedPaths()` (`modules.ts:90`) consumed by the PreToolUse hook (`engine.ts:1141-1146, 1440-1447`); the away module returns `[<dataDir>/away]`. **Stated limit, as for the Armory: this stops the file tools, not Bash.** The core keeps the policy in memory and treats the file as persistence (re-read only at start), so a Bash edit takes effect after the next core start. By 4.1 it can never allow an ask, but it can undo the owner's own pause or budget (same exposure as `config.json`).
6. **Waits can outlive SDK timeouts.** Section 4.5 sets the hook timeout to the longest wait. If the SDK caps it, the run would stop instead of waiting: fail-safe (nothing runs) but not graceful. Spike required before PR 2 ships quiet hours.
7. **Crash and restart.** Pending approvals die with the core (existing: `drain()` denies them, `updater/index.ts:303`). Parked asks are persisted (6.5) and survive. A crash during a hold: nothing sent.
8. **Notifications leak nothing.** Fixed vocabulary only (3.9); no command text, no agent-written text. Click opens the ask; no action from the popup.
9. **Admin gate.** `/api/away/*`, `/api/spend`, `/api/attention`, `/api/approvals/:id/hold` are admin-only; tested.
10. **Pause and budget fail toward running what the owner started.** Owner clicks are never blocked by pause; a budget the owner set blocks their own start too, with the reason shown and a one-click way past it in the banner.
11. **No new key or token storage.** The ledger holds ids and amounts only.
12. **Untrusted rows** keep the 0.2.6 behaviour: "Accept, keep it marked" never clears trust; only "Mark as reviewed" does (`BoardPanel.tsx:311-314`).

## 6. Park and resume (opt-in, per project)

Only for asks raised through the engine's three sites (`engine.ts:1261, 1304, 1342`) and for questions; other modules' asks keep waiting then deny.

1. **Park**: at `parkAt` the broker calls `onPark`. The engine persists a `ParkedAsk { id, kind, taskId, agentId, projectId, toolName, summary, input, consequence, askedAt, parkedAt, sessionId }` in `<dataDir>/away/parked.json`, emits `approval.parked`, then ends the run cleanly: task `status:'error'`, `error` starts with `PARKED_PREFIX = 'Parked, waiting for your answer'`, `resumable:true`; the slot is freed (`runJob` finally -> `pump`). The UI treats it like a limit pause (amber, Continue-like), words it "Parked", and shows `Parked 14 min, work kept` on the ask. Mascot stays calm like a limit pause.
2. **Answer**: `POST /api/away/parked/:id { allow }` (or question picks). Allow stores a **one-shot grant** `{ taskId, toolName, inputHash, expiresAt: +24 h }` and calls `startTask({ continueTaskId, prompt })` with a fixed prompt naming the approved tool and summary. In the resumed run, `toolDecider` consults the grant **after** the gate deny rules and the shell floor (so neither can be skipped) and **instead of** raising a card; match is exact tool name plus canonical input hash; the grant is consumed on use, dies with the task, and expires. A different call raises a normal card. Deny resumes with "The owner denied it. Do not retry it." Question picks resume with the answer text.
3. Parked asks count as asks everywhere, notify once, and appear in the digest, rail and overlay.
4. **Unverified (spike before PR 5)**: that a run aborted while waiting in `canUseTool` is resumable with the SDK `resume` session, and that re-issuing the same call reproduces the same input byte for byte. If the second fails, the grant must match by (tool, normalised command) instead; if the first fails, Park ships off the table and the control is removed.

## 7. Performance

- **Stills at rest.** Every resting bust is a pre-rendered image; the live engine mounts on hover or keyboard focus and is destroyed on leave (mockup `wake`/`rest`). Only needs-you gets an amber ring, drawn by the compositor. Measured in the mockup (headed Edge): sheet slide median frame 83 ms with 12 live rail busts, 7 ms without; the cost is raster of about 1,100 SVG nodes per live tile (research, `mascot.css` rail tiles already `animation:none`).
- Stills: one per bust and state (`idle awaiting sleeping hacking thinking error`, 13 busts incl. `zealot`/Marshal, 2 themes). Source: `scripts/build-bust-stills.mjs` renders from the engine's own CSS (a canvas redraw of the layer SVGs was wrong: hidden eye sets showed) at 80 css px, dpr 2 (160x160 PNG in the mockup, about 37 KB each, 5.8 MB for 156). Ship **WebP at the sizes actually used** (20, 24, 28, 34, 40, 44 px, from the 160 px source scaled by CSS); budget under 1.5 MB total (**unverified**: measure). Light theme uses transparent stills with the dark tile drawn by CSS (`.bslot`), so the theme flip on hover is gone. The Quartermaster has no still (letter tile; no painted bust).
- Files load from `file://` relative to `dist-ui` (the IIFE bundle has no module loader for images): put them under `ui/src/mascot/stills/` and import with `new URL(..., import.meta.url)` or `?url` (**unverified** with the current vite config; PR 1 tests the packaged build). Stills are decoded on idle (`requestIdleCallback`) for the first visit.
- `Bust.tsx` keeps its props; a new `rest` default renders the still and mounts the engine on `pointerover`/`focus`. The Ops panel stage and the Mascot Lab keep `stage`/forced behaviour unchanged.
- Tabs: no view transition; render plus 120 ms opacity fade (B6). Frame budget: tab switch under 16 ms on second visit; first visit of Board/Settings built on idle. Digest rows, strip chips and units use 20 to 40 px stills; never a live engine at rest (a page with 20 busts must cost nothing at rest).
- Counts and sorting are O(asks); `digestEvents` is O(tasks in the project); the attention tracker recomputes on bus events only.
- Ledger writes are one line per run result; reads sum the current and previous month file on demand and cache per period.

## 8. Accessibility (WCAG 2.2 AA, from the mockup review)

- Contrast: text 4.5:1 in both themes (lowest measured 4.77); control borders `--control-line` 3:1 (Dark `#667182`, Light `#737d8f`); Light primary uses the darker accent (white on it 5.41:1). Mint only on New task, live dots, live status icon, live card border. Tab underline, focus ring, switches, segmented controls, Allow and Continue are neutral.
- Targets at least 24 px (switches 40x24, remove x 24, links 24, native radios in 28 px labels).
- Names: every digest button carries agent and item in `aria-label`; groups and inputs are labelled; separators `aria-hidden`; busts `role=img` with name where informative, else decorative; "Show runs" buttons carry the count.
- One polite live region announces answers, holds, restores and queue changes. The countdown and Undo pause on hover and on `:focus-visible` (2.2.1) and say `Paused` visibly when paused. Reduced motion: sheet and fades only, no slide.
- Focus: never `body`; `restoreFocus` after every render; sheet returns focus to the opener; Esc with a draft needs a second press.
- Keyboard: tabs roving with arrows; rail one tab stop; skip link; menus Arrow/Home/End/Esc, `aria-expanded`; board cards focusable with Alt+Arrow move; J/K/A/D rule as 3.2.
- Taskbar overlay description set for screen readers; notifications use plain text.
- Color is never the only signal (member working state is a dot plus the word "working" in the accessible name).
- Not covered by the mockup review, to test in the real app: 0.75x and 1.5x UI scale, a screen reader run, the packaged app.

## 9. Test plan

Rule: every new test has a negative shown by a temporary mutation (repo rule). Local: typecheck + touched test files; CI is the full gate.

### 9.1 Unit tests (pure, node:test, `test/`)
- `consequence.test.ts`: table cases per level; **property**: any program/tool not in the tables returns level 3 `unknown`; throwing input returns unknown via the wrapper; `certain` false disables inline Allow; never lower than the shell floor on a command the floor refuses.
- `attention.test.ts`: `deriveAsks` includes questions, parked and proposals; counts agree across derivations; merge groups repeated reads by (agent, tool, dir); sort `(level desc, askedAt asc)`; top-3 cap and `N more`; quiet state still lists open asks.
- `ask-clock.test.ts`: deny clock outside quiet; raised inside quiet; raised 4 min before quiet; midnight wrap; DST day lengths; `from==to` invalid; park unaffected by quiet; boundaries re-arm.
- `hold.test.ts`: tick, pause on hover only after pointer left once, pause on focus-visible, resume, Undo before 0, Send now, send exactly once, **nothing sent after dispose/reload**, `ok:false` path.
- `queue.test.ts`: `blockedReason` order budget > paused > after > slot; bridge child bypass; `startAfter` waits for the agent's other run; resume pumps.
- `away-store.test.ts`: defaults, bounds, corrupt file renamed, unknown fields kept, atomic write, project delete cleans.
- `ledger.test.ts`: period boundaries (day, Monday week, month, DST), reached/override, append failure does not fail a run, cost sites write once per result.
- `broker-policy.test.ts`: per-project wait, quiet re-arm, `hold` route extends once and never resolves, no timer path resolves `true` (negative: mutate to allow, test fails).
- `away-routes.test.ts`: every new route 403 for a bearer token; 400 on bad bodies.
- `taskbar-plan.test.ts` (`src/electron/attention.ts`): overlay count/null, no churn when count unchanged, quiet hours suppress popups and queue one summary, no popup when focused on that project, burst grouping, fixed-vocabulary bodies (negative: a command string in the ask never reaches a body).
- `park.test.ts` (PR 5): park/answer/grant one-shot, grant after gates and floor, expires, dies with task, persisted across restart, different call raises a card.
- `copy.test.ts`: the strings module has no U+2014/U+2013 and no "this computer"; every string key used in the UI exists.
- `projects-ui` additions: rail priority line, run count at 2+, project menu counts, `railPending` unchanged.
- Source-grep tests (existing pattern): digest buttons have aria-labels with agent and item; no `accent`/`--live` class on Allow, tab underline, switch.

### 9.2 UI tests
No DOM runner exists. Logic stays in pure modules (above). For rendering, extend the existing fake-backed harness (`docs/TESTING.md`, `scripts/harness/`) and add a Playwright-driven check in the real built UI against the harness core, run by hand and in the PR checklist (not in CI): tabs x states x widths (1280x820, 1280x720, 960x600) x themes, focus after each action, the countdown with hover and keyboard. Reuse the mockup's scripts as the reference list.

### 9.3 Hands-on test list in the real app (record each in `claude/tracker-pc-checks.md`; "Needs a real PC")
- H1 Open a project with 6+ asks: top 3 shown, `N more` expands, Working-now strip above the fold at 1280x820 and 960x600.
- H2 Allow an irreversible command: 8 s hold, hover pauses, keyboard focus pauses, Undo restores, Send now sends, closing and reopening the window during the hold sends nothing and the ask is still pending.
- H3 Kill the app (task manager) during a hold: nothing ran; restart: the ask is gone with the run (existing) or open (if the core lived).
- H4 Leave an ask 10 min on "Wait, then deny": denied, row says `Denied after 10 min`, the agent reads the timeout text.
- H5 Quiet hours on, raise an ask inside them: it waits, no popup; at quiet end one summary and the 10 min clock starts; an ask raised 4 min before quiet start keeps its remaining time.
- H6 Park after 3 min: run stops, slot frees, ask stays after an app restart; Allow later resumes and the command runs once; a second identical command asks again.
- H7 Pause new starts: Marshal does not dispatch; an owner-started task and a board "Run this item" run; Resume works; banner and meta agree.
- H8 Fill the cap with 4 runs, start a 5th: reason "Waiting for a free slot (4 of 4 ...)" in strip, tasks, sheet; stop one and it starts.
- H9 Taskbar overlay shows the count of asks and clears at zero (Windows); toast appears for an ask while the window is hidden in the tray; click opens the ask; no command text in the toast.
- H10 Two runs of one agent in one project: warning in the composer, Run anyway and Queue after it behave; run count badge on bust; `2 runs` menu lists both and switches project.
- H11 Ask in another project: switcher dot and `N elsewhere`, rail section, click jumps to it; counts agree after answering.
- H12 Budget: set $1 week, run past it, banner, new run queued with reason, Run anyway this week, notification once.
- H13 Light and Dark: resting bust equals its still (no flip on hover), rail jank during sheet slide gone (median frame under 16 ms).
- H14 Reads grant: Allow all 3, Confirm, rule appears in Settings Gates, next read does not ask; switch off restores asking.
- H15 Screen reader pass over the digest, hold and menus; 0.75x and 1.5x scale; packaged build has all stills.

## 10. Phases: independently shippable PRs, in build order

Each PR ends green on typecheck, its touched tests, and CI. Defaults change nothing the owner has not turned on, so any prefix of this list can ship.

### PR 1: Stills at rest (UI only, ships alone)
Why first: the page puts 20+ busts on screen; without it the mockup's measured jank returns.
- `scripts/build-bust-stills.mjs` (headless render using the engine CSS), `ui/src/mascot/stills/*` (generated, committed), `ui/src/mascot/Bust.tsx` (rest/wake), `ui/src/mascot/mascot.css`, `ui/src/mascot/bust.css`, `ui/src/mascot/busts.ts` (still registry; `zealot` and Marshal mapping), `ui/vite.config.ts` only if asset URLs need it, `test/bust-still.test.ts` (registry covers every bust x state x theme; negative: delete one file).
- Risk: asset loading from `file://`, bundle size.

### PR 2: Core: queue truth and ask policy (no new screens)
- `src/shared/consequence.ts`, `attention.ts`, `ask-clock.ts`, `away-copy.ts`; `src/core/away/{index,store,ledger,attention}.ts` (module, routes, `protectedPaths`); `src/core/approvals.ts` and `questions.ts` (policy, projectId, consequence, hold route); `src/core/engine.ts` (`trigger`, `startAfter`, `blockedReason`, queue snapshot/event, hook timeout, ledger writes at `:1672` and `:1924`, project pass-through at `:1261, :1304, :1342`); `src/core/marshal/driver.ts`, `orchestrator.ts` port, `matcher.ts`, `projects/board/index.ts` (trigger, pause); `src/core/server.ts` (snapshot `queue`, `parked`, `caps`, `/api/attention`, `/api/spend`); `src/shared/types.ts`; `src/bin/legion-core.ts` (wire the module and policy); `ui/src/store.ts` (apply `queue.updated`, `attention` is derived); tests listed in 9.1.
- Includes the SDK hook-timeout spike (section 5.6); if it fails, quiet hours ships as park-on-quiet instead.
- Risk: engine edits are central; keep each behind "policy absent = today".

### PR 3: The project page (the headline)
- `ui/src/projects/page/` (`ProjectPage`, `Overview`, `Digest`, `AskRow`, `WorkingStrip`, `StateGroups`, `AgentUnits`, `SideColumn`, `Sheet`, `NewTaskSheet`, `RunsMenu`, `Banners`, `SettingsTab`), `ui/src/projects/hold.ts`, `focus.ts`, `projectsStore.ts` (away calls), `projectsLogic.ts` (unit lead line, project menu counts), `ProjectSwitcher.tsx` (menu button), `AgentRail.tsx` (run count, sub-line, tooltips, one tab stop), `Thread.tsx` (`N runs` menu), `Composer.tsx` (second-run box feeds the sheet), `ApprovalCard.tsx` (dynamic wait note), `ProjectView.tsx` (replaced), `ui/src/projects/projects.css`, `test/projects-page.test.ts`, `hold.test.ts`.
- Needs PR 2. Board tab keeps `BoardPanel`. Uses stills from PR 1.
- Risk: size. Split in two commits: frame + digest + hold; sheet + composer + settings.

### PR 4: Desktop signals, quiet hours, Spending
- `src/electron/attention.ts` (pure plan), `main.ts` (consume attention, `Notification`, `setOverlayIcon`, tray text and menu item, `legion:open-ask`), `preload.cjs` (open-ask listener), `assets/overlay-*.png`, `ui/src/components/Settings.tsx` (Notifications and Spending sections), `ui/src/projects/page/SettingsTab` (notify level), `ui/src/store.ts` (`openAsk`), `test/taskbar-plan.test.ts`, spending view tests.
- Needs PR 2. Risk: Windows toast delivery (H9).

### PR 5: Park and resume (opt-in)
- `src/core/away/parked.ts`, `engine.ts` (park path, grant check in `toolDecider`), `src/shared/continue.ts` (`PARKED_PREFIX`, `isParkPause`), `server.ts` route, UI rows (Parked wording, digest/sheet), `test/park.test.ts`.
- Needs PRs 2 and 3. Gate: the resume spike (6.4). If it fails, drop the PR and the Settings radio; the rest of the release is unaffected.

## 11. Deviations, data gaps, layouts, open points

### 11.1 Deviations from the mockup (each needs the owner's nod)
- **D1 Undo semantics.** The mockup folds every answer into "Undo 8 s". The core cannot take back an answer once sent. This spec holds every allow-type answer for 8 s (Undo is real) and sends Deny/Reject at once with no Undo. Copy changes from past tense ("Allowed. Builder continues.") to truthful present ("Allowing in 8 s.") until sent.
- **D2** Owner's "Start with <agent>" on a paused project runs (4.4).
- **D3** Native project `<select>` becomes a menu button as in the mockup; a11y requirements in section 8.
- **D4** "Keep your computer awake" and the Marshal switch live in this tab per the mockup; the awake row is hidden until `caps.keepAwake`.
- **D5** Finished rows show cost and the result's first line, not check verdicts or file diffs (11.2).

### 11.2 Data the mockup shows that the core cannot supply yet
| Mockup | Why not | 0.3.0 shows |
|---|---|---|
| `3 of 3 checks passed`, `1 of 3 checks` | No pass/fail verdicts exist; `done_when` text only (`marshal/ledger.ts`, `orchestrator.ts:134`), verdicts are 0.3.3 | `3 checks written` if present, else nothing |
| `1 file, +18 -6`, Review diff | No diff capability until worktree per run (0.3.5) | Open thread; Mark done |
| `Step 18 of about 40` | `maxTurns` is a limit, not an estimate (`types.ts` `TaskProgress`) | The current to-do's active text, else `Step 18` |
| Room cost `this week` | Room cost is all-time | `so far` |
| `Copied from a web page` | Provenance is `trust:'untrusted'` plus `tainted` run | `Written after outside content` (existing term "Not reviewed") |
| Mark as reviewed on a finished task | Only board items have trust and review | Mark done (owner-only, existing) |

### 11.3 Unverified (checked in the plan, not in the code)
- SDK accepts a very long `HookCallbackMatcher.timeout` (4.5, 5.6).
- A run aborted in `canUseTool` is resumable and replays byte-identical input (6.4).
- Main can subscribe to `/api/events` with the admin secret (4.6).
- Windows toast delivery from unpackaged `electron.exe`; overlay icon rendering at 100%, 125%, 150% scale (H9).
- Stills load from `file://` in the built bundle and the WebP size budget (7).
- `powerSaveBlocker` for "keep your computer awake" (not built here).
- Light theme still compositing on the real rail (mockup-measured only).

### 11.4 Layouts decide-now list (2026-10-14 council) and how this spec honours it
1. One main-owned layout file: this spec adds no layout state; tab and lens sit behind one `pageState` seam, in memory.
2. Stable element ids: `data-region` ids (section 3), `data-fk` keys for focus restore, `data-testid` on rail, strip, digest, sheet.
3. Pure fail-safe classifier and `lastLooked` per project: 4.10, 4.2.
4. One shared strings module: `src/shared/away-copy.ts`, keyed (pack-ready), imported by UI and main.
5. Questions count in bust state and ask counts: yes (`awaiting.ts`, `deriveAsks`).
6. Queue reason on the wire: 4.3.
7. Layout-aware `showWindow`: notification click goes through `showWindow()` + `openAsk(ref)`, the only raise path.
8. Vocabulary module/mod/pack: keys, not literals, in the strings module.
9. Neutral Allow everywhere: yes.
Critic risks to keep in mind: ask age vs the 10-minute deny (4.5), quiet hours vs deny (4.5), `protectedPaths` does not stop Bash (5.5).

### 11.5 Open points for the owner (defaults chosen)
- **O1** D1 above (hold every allow, deny immediately). Default: as specified.
- **O2** Should `lastLooked` also advance by itself (for example when you leave the page after 30 s)? Default: no, explicit Mark as seen only, window capped at 7 days.
- **O3** The read-only command list and the classifier share a table when "fewer cards" lands; until then the classifier ships its own conservative table.
- **O4** Overlay counts proposals as asks; notifications do not fire for proposals alone. Default as specified.
- **O5** Digest A/D keys: shipped with the 0.2.6-z arming rule, or left out of 0.3.0? Default: shipped.

### 11.6 Spec self-review
Placeholders: none left; unverified items are listed in 11.3. Consistency: counts have one derivation (4.2, 4.6); the hold is client-only in 3.2, 5.2 and tests. Scope: five PRs, PR 5 optional. Ambiguity fixed: quiet hours pause the deny clock but not the park clock; pause blocks automatic starts only; the owner's own click always starts.

## 12. Copy table (exact strings from the mockup; no em dashes; "your computer")

Keys live in `src/shared/away-copy.ts`. "Ships" differs from the mockup only where marked.

| Where | String |
|---|---|
| Meta | `13 members`, `3 working here`, `5 need you`, `new starts paused`, `$41.20 this week` |
| Empty meta | `New project`, `no members yet` |
| Disabled New task | `Add a member first` |
| Digest header | `Since 09:40`, `5 need you`, `Nothing needs you`, `$6.10 spent`, `Mark as seen` |
| Quiet | `Nothing new since 11:30. 4 still wait on you.` / `Nothing waits on you.` |
| List heading | `Needs you (5), riskiest first`; `2 more need you`; `Show fewer`; `Show asks` / `Hide asks` |
| Folded line | `1 failed, 1 stopped, 5 finished or in review since 09:40` |
| Chips | `Leaves your computer, cannot be undone`; `Deletes files, cannot be undone`; `Read only, inside this project`; `Sets the checkout copy`; `Copied from a web page` (ships: `Written after outside content`) |
| Buttons | `Allow`, `Deny`, `Deny and stop`, `Open`, `Read it`, `Accept, keep it marked`, `Reject`, `Allow all 3`, `Review`, `Undo`, `Send now`, `Retry`, `Continue`, `Stop`, `Stop waiting`, `Mark done`, `Resume`, `Change budget`, `Save budget`, `Run anyway this week` |
| Untrusted line | `Accepting or editing keeps it marked untrusted. Only "Mark as reviewed" clears it.` |
| Reads ledger | `Scout: 22 of 22 file reads approved this week.` |
| Hold | `Publishing in 8 s.` / `Deleting in 8 s.` (ships also `Allowing in 8 s.`), `Hover or focus pauses the countdown.` |
| Hold race | ships: `This approval was already denied after 10 min.` |
| Answers | `Denied. Builder was told no.` (ships); `Denied. Builder was stopped. Work kept.`; `You chose A. Scribe continues.` (ships after send); `Rejected. Nothing was added to the board.`; `Accepted. Still marked untrusted until you mark it reviewed.` |
| Wait line | `Waiting 28 min, denied at 10 min`; `Waiting 7 min, parks at 3 min`; `Parked 14 min, work kept`; `Denied after 10 min`; ships: `Waiting: quiet hours until 07:00` |
| Reads grant | `Stop asking for reads in this project?`; `Scout will read files in this project without asking.`; `Writes and commands still ask. You can turn this off in Settings, Safety.`; `Confirm`; `Not now`; `Stop asking` |
| Working | `Working now`; `No run is working right now.`; `Builder` + `x2` |
| Queue | `Waiting for a free slot (4 of 4 running in all projects)`; `Waiting for the budget`; `Waiting: new starts are paused`; `Queued after Builder's current run`; `Waiting for a slot` (group) |
| Groups | `Working`, `In review`, `Stopped`, `Done today`, `Active`, `Idle`; `Stopped after 200 steps. Work kept.`; `Failed: the build exited with code 1.` |
| Agent units | `Needs you: publish package`; `Working: payment flag`; `Payment flag · also Atlas`; `In Atlas: map theme variables`; `Also working in Atlas: ...`; `+1 more`; `2 runs`; `Idle. Last worked 2 d ago.`; `Sent 1 board item to an agent. Latest 2 min ago.`; `Cloud computer` |
| Rail | `Needs you in other projects`; `2 elsewhere`; `N more`; `Skip to project page` |
| Composer | `To:`, `in`, `Best fit (Marshal chooses)`; `What should happen next?`; `Enter starts it, Shift Enter adds a line. About $1.50 for a task like this.`; `Start task`; `Builder is already working here.`; `Run anyway`; `Queue after it`; `Type @ in the text to pick someone else.` |
| Esc | `Press Esc again to close. Your draft is kept.` |
| Banners | `Budget reached: $50.00 this week.` + `New runs wait until Monday.`; `New starts are paused.` + `Tasks you start yourself still run. Board items and Marshal starts wait.`; `This project is archived.` + `It starts no new tasks and its board is read-only. Nothing was deleted.` |
| Away settings | `When nobody answers`; `Wait 10 min, then deny`; `Default`; `Park the run after [3] min`; `Parked: the run stops and keeps its work. Answer it to pick up where it stopped.`; `Pause new starts`; `Tasks you start yourself still run. Board items and Marshal starts wait until you resume.`; `Let the Marshal start board items`; `Keep your computer awake while work runs`; `Only while a run is active in this project. Your screen can still turn off.`; `Enter a whole number from 1 to 120.` |
| Safety | `Let agents read files in this project without asking`; `Reads inside the project folders stop asking. Writes and commands still ask.` |
| Budget | `Set a weekly budget`; `No budget. Optional.`; `At the budget, new runs wait, running work finishes, and you get one notification.`; `Change the weekly budget`; `New runs start again as soon as the budget is above what you spent.`; `Or spend over the budget until Monday. Runs that start now cost real money.` |
| Notifications | `Needs you and problems`, `Everything`, `Nothing`; `You hear about what needs you and what failed. Quiet hours are in app Settings.` |
| Roles and modes | `Lead`, `Coding and building`, `Strict reviewer`, `Documentation`; `Opus took over after errors`; `Asks first: asks before any edit or command. Auto-edits: edits files freely, asks before commands. Full access: never asks.` |
| Rooms | `1 needs you`; `Builder is answering`; `No messages for 2 h`; `Only rooms whose agents are all members of this project can join it.` |
| Folders note | `On Windows, Legion cannot lock commands away from your files. Guarded blocks file edits and asks you before any command that mentions this folder. A command that reaches the folder another way is not caught. Sandboxed will close that gap.` |
| Desktop (new) | `3 things need you`; `Legion: 3 need you`; `Builder needs you in Shop`; `While you were away: 2 need you, 1 failed, $3.20 spent.`; `Budget reached in Shop` |
| Not shipped | `3 of 3 checks passed`, `1 file, +18 -6`, `Review diff`, `Not built yet` badges, `This control is not part of the mockup.`, the cost-sum sentence under By agent |
