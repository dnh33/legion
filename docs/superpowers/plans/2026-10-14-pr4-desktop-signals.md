# PR 4: Desktop signals and Spending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (one implementer, in this session). Steps use checkbox syntax.

**Goal:** Legion tells the owner when something needs them (Windows taskbar number, desktop notifications, tray, quiet hours with one summary, return summary) and shows what was spent (Settings, Spending).

**Architecture:** One pure module `src/electron/attention.ts` decides everything: `plan(state, input, now) -> { state, overlay, notifications, tray, wakeAt }`. A thin Electron-side module `src/electron/signals.ts` feeds it (SSE from the core with the admin secret, a 3 s poll of `GET /api/attention` as the fallback) and performs the Electron calls (`win.setOverlayIcon`, `Notification`, tray). The window reports which project and thread it shows (IPC `legion:view`) so focus suppression is exact. A notification click calls `showWindow()` and sends `legion:open-ask`, which the renderer routes with one function `openAsk(ref)`. Settings gets Notifications and Spending sections over the existing `/api/away` and `/api/spend` routes.

**Tech Stack:** TypeScript, Electron main (`nativeImage`, `Notification`, `setOverlayIcon`), React UI in `ui/`, node:test.

**Spec:** `docs/superpowers/specs/2026-10-14-runs-without-you-design.md` sections 3.9, 4.6, 4.7, 5.8, 9.1 (`taskbar-plan.test.ts`), 9.3 (H9).

## Global Constraints

- Notification text is fixed vocabulary: agent name, class of ask, project name. Never command text or any agent-written text (spec 5.8).
- No em dashes or en dashes in user-facing strings. Say "your computer", never "this computer".
- Windows overlay: `win.setOverlayIcon`; `app.setBadgeCount` is not used. Pre-drawn 16x16 icons for 1 to 9 and `9+`, cleared with `null` at zero, recomputed only when the count changes, no animation.
- Never notify when the window is focused on that project's page or that thread. Bursts group (`3 things need you in Shop`).
- Quiet hours: no popups; one summary at the end (`While you were away: 2 need you, 1 failed, $3.20 spent.`). Same summary on regaining focus after 30 min or more away.
- No outside product is named in code, comments or the changelog. Commits: no Co-Authored-By trailer.

## Review Focus

- A command string inside an approval never appears in any notification field (negative test through the real adapter).
- Count flaps (3, 2, 3) cause one overlay call per real change and none for repeats.
- Quiet window that wraps midnight, and `from == to` (invalid, treated as off).
- A project with notify level `nothing` is silent, `everything` also announces finished runs; app master switch off silences all.
- The window hidden or minimised is "not focused" even if it was last viewing that project.
- Agent or project names with control characters or very long text are cleaned and capped.

### Task 1: The pure plan (`src/electron/attention.ts`)

**Files:** Create `src/electron/attention.ts`, `test/taskbar-plan.test.ts`.

**Interfaces:**
- Produces: `plan(state: PlanState, input: PlanInput, nowMs: number): PlanResult`, `initialPlanState()`, `askSignal(a, names)`, `overlayKey(count)`, `overlayDescription(count)`, `trayTooltip(total)`, `sanitizeName(s)`.

- [ ] Write `test/taskbar-plan.test.ts` covering: overlay count and null, no churn, 9+ clamp, tray text, quiet suppress and one summary, focus suppression, burst grouping, fixed vocabulary, project levels, master off, return summary after 30 min, name cleaning.
- [ ] Run: `npx tsc -p tsconfig.json; node --test dist/test/taskbar-plan.test.js`. Expected: FAIL (module missing).
- [ ] Implement the module until green.
- [ ] Commit `desktop: one pure plan decides the taskbar number, notifications and quiet-hours summary`.

### Task 2: Overlay icons (script + assets)

**Files:** Create `scripts/build-overlay-icons.mjs`, `assets/overlay/*.png` (1 to 9 and 9plus, at 16, 20, 24 px). Test: `test/overlay-icons.test.ts` (every file exists, valid PNG, right size; the key set equals `overlayKeys()`).

- [ ] Failing test, script, generated icons, look at them zoomed (Read), commit `desktop: pre-drawn taskbar number icons`.

### Task 3: Electron wiring (`src/electron/signals.ts`, `main.ts`, `preload.cjs`)

**Files:** Create `src/electron/signals.ts`; modify `main.ts` (start after boot, tray text and menu item, IPC `legion:view`, `legion:open-ask`), `preload.cjs` (`reportView`, `onOpenAsk`), `test/signals-sse.test.ts` for the pure SSE parser.

- [ ] Failing SSE-parser test, parser, signals module, main wiring, `npm run typecheck`, commit `desktop: taskbar number, notifications and tray follow what needs you`.

### Task 4: Renderer: `openAsk`, view report

**Files:** Modify `ui/src/store.ts` (`openAsk`), `ui/src/components/AgentRail.tsx` (click uses `openAsk`), `ui/src/App.tsx` (report view, receive open-ask), `ui/src/api.ts` (window types). Pure part: `ui/src/projects/openAsk.ts` with test `test/open-ask.test.ts`.

- [ ] Failing test, implement, typecheck, commit `app: one function opens an ask, from the rail or a notification`.

### Task 5: Settings: Notifications and Spending

**Files:** Create `ui/src/away/NotificationsSection.tsx`, `ui/src/away/SpendingSection.tsx`, `ui/src/away/spendingLogic.ts`, `ui/src/away/away.css`; modify `Settings.tsx`, `store.ts` (`SettingsSection`). Test `test/spending-logic.test.ts` (money, bars, "until Monday" label reuse `periodEnd`).

- [ ] Failing test, logic, sections, `npm run typecheck`, commit `settings: Notifications with quiet hours, and Spending`.

### Task 6: Changelog, real-Electron verification, PR

- [ ] CHANGELOG lines under `[Unreleased]`.
- [ ] Build; run Electron with a scratch `LEGION_HOME`; raise an ask, minimise, check overlay, toast, click, quiet hours; screenshots; stop the app.
- [ ] Typecheck, touched tests, push to `cloud`, `gh pr create`.
