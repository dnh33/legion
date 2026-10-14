# PR 3b: Task sheet, New task, and Settings for while you are away. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Finish the project page: a side sheet for one task (with its asks answered in place), the New task sheet with To/in pills and the second-run warning, the Settings tab with While you are away, Safety (reads grant), Budget and Notifications, and the `N runs` menu in the chat header. Two review follow-ups ride along: the hold chip must never cover controls, and Claude Code's own `AskUserQuestion` must not surface as a raw-JSON approval card.

**Architecture:** Same rule as 3a. Decisions are pure modules with node tests (`sheetLogic.ts`, `settingsLogic.ts`); React renders what they return. The sheet is one external store (`sheetState.ts`, in memory only). Digest rows are reused in the sheet (`OpenRow`, `AnsweredRow` exported from `Digest.tsx`), so a task's asks follow the same hold rules. Settings writes go to the PR 2 routes (`PATCH /api/away/projects/:id`, `PUT .../board/marshal`) and the existing Gates settings (reads grant). The only new core change: `POST /api/tasks` accepts `startAfter` from the app (admin only).

**Tech Stack:** React 18 + Vite IIFE bundle, TypeScript, node:test on `dist/test`, Playwright (Edge, headed) against the repo harness for the real check.

**Spec:** `docs/superpowers/specs/2026-10-14-runs-without-you-design.md` sections 3.3, 3.4, 3.6, 3.7, 4.8, 8, 9. Target: `docs/superpowers/specs/assets/2026-10-14-project-page/project-page-v1.html`.

## Global Constraints

- Copy: no em or en dashes, "your computer", no outside product names. Exact strings from spec section 12.
- Mint only on New task, live dots, live status icon, live card border. Switches, segmented controls, Allow, Confirm are neutral. Targets 24 px minimum; switches 40x24.
- The sheet is `role=dialog`, `aria-modal=false`; Esc closes and returns focus to the opener; Esc with an unsaved draft says `Press Esc again to close. Your draft is kept.` and keeps focus in the textarea.
- Pause never blocks the owner's own start. Queue after it maps to `startAfter`, sent only by the app (admin).
- Park is offered only when `caps.park` is true. Keep-awake only when `caps.keepAwake`.
- Reads grant: one project-scoped allow gate rule (`source:'card'`, `when:{projects:[id], tools:['reads'], paths:[<folder>/**]}`), created only after Confirm, removed by switching off. The first click grants nothing.
- Tab and lens stay in `pageState` (memory). The sheet adds no localStorage key.
- No `Co-Authored-By`. Local gate: `npm run typecheck` plus touched test files.

## Review Focus

- A second run of the same agent in the same project: Start does nothing until Run anyway or Queue after it is chosen. A run in another project is only the "Also working in" note. (`projects-sheet.test.ts`)
- Queue after it with no live run left by the time Start is pressed: the task just starts (the core resolves `after` to an empty list). (`away-routes`/server test)
- Esc with a draft never discards it; a second Esc closes and the draft is still there when the sheet reopens. (`projects-sheet.test.ts`)
- Park minutes: `0`, `121`, `3.5`, empty and `abc` are refused with the alert text and never sent. (`projects-settings.test.ts`)
- Budget `0`, negative, `NaN` never sent; turning the budget off sends `null`. (`projects-settings.test.ts`)
- Reads grant for a project folder with spaces, backslashes and a trailing slash builds a rule that the real gate matches. (`projects-settings.test.ts` uses `decideGate`)
- A sheet for a task that disappears (archived, project removed) closes instead of throwing. (`projects-sheet.test.ts`)
- Hold chip at 1280 and 960 does not intersect the composer, thread header or title bar controls. (real check, screenshots)

## File structure

Create: `ui/src/projects/page/sheetLogic.ts`, `sheetState.ts`, `Sheet.tsx` (TaskSheet, NewTaskSheet), `settingsLogic.ts`; tests `test/projects-sheet.test.ts`, `test/projects-settings.test.ts`.
Modify: `src/core/server.ts` (`startAfter`), `src/core/engine.ts` (AskUserQuestion off), `ui/src/api.ts`, `ui/src/store.ts` (`sendPromptTo` opts), `ui/src/projects/page/{ProjectPage,Overview,Digest,TabsContent,SettingsTab,taskActions,page.css,HoldChip}.tsx|ts|css`, `ui/src/App.tsx`, `ui/src/components/Thread.tsx`, `CHANGELOG.md`, `test/engine.test.ts`, `test/bridge.test.ts`, `test/questions.test.ts`.

### Task 1: AskUserQuestion is off (review follow-up 2)
- [x] Update the three exact `disallowedTools` assertions (`engine.test.ts` x2, `bridge.test.ts`) and add a source check in `questions.test.ts`; see them fail; add `'AskUserQuestion'` to the engine's `disallowedTools`; see them pass.

### Task 2: Core accepts `startAfter` from the app
- [ ] Test (`test/away-routes.test.ts` neighbour): `POST /api/tasks {startAfter:true}` as the app queues behind the agent's live run with reason `after`; a bearer-only client gets 403. Implement in `server.ts`: parse boolean, admin only, pass `startAfter: true`.

### Task 3: Pure sheet logic (`sheetLogic.ts`)
- [ ] Tests first: `secondRun(f, agentId)` (same project live run -> `{ name, title }`, other project -> null, ignores queued), `bestFit(members, f)` (fewest live runs, ties by member order), `typicalCost(tasks, agentId)` (mean of done costs, default 1.5), `newTaskPlan({ choice: 'run'|'after'|undefined, warning })` (start blocked until chosen), `escStep(dirty, armed)` -> `'close' | 'arm'`, `layoutFor(areaWidth)` -> `'push' | 'over'`, `taskCard(f, taskId, rows)` per status (working, queued, stopped, failed, done, cancelled, waiting) with headline, detail, actions, last message; unknown task -> null.
- [ ] Implement; see pass.

### Task 4: Sheet store and components
- [ ] `sheetState.ts`: `{ kind:'task', id } | { kind:'new' } | null`, opener element, per-key drafts (module level, memory).
- [ ] `Sheet.tsx`: TaskSheet (head with title, agent, status, cost, `N runs` button at 2+ live runs; body = card by status with the task's ask rows reused from Digest, last message; foot: Open full thread, Stop / Stop waiting / Continue / Retry / Mark done), NewTaskSheet (textarea, To and in pills with menus, second-run box with `aria-pressed` Run anyway / Queue after it, typical cost foot, Start task).
- [ ] `ProjectPage.tsx`: area wrapper `pushed`/`over` (ResizeObserver), mounts the sheet, New task button opens it, the 3a `To:` select goes away. `taskActions.openTask` opens the sheet on the page; `openThread` keeps the old behaviour.
- [ ] `api.createTask` and `sendPromptTo` carry `startAfter`.

### Task 5: Settings (`settingsLogic.ts`, `SettingsTab.tsx`)
- [ ] Tests first: `parseParkMinutes`, `parseBudget`, `changedFromDefault(away)`, `readsGrantRule(project)`, `findReadsGrant(rules, project)` and a `decideGate` round trip.
- [ ] Left nav with scroll-spy and changed dots (General, Folders, Members, While you are away, Safety, Budget, Notifications, Archive). While you are away: radiogroup (Park only with `caps.park`), Pause new starts, Marshal switch, keep-awake only with `caps.keepAwake`. Safety: reads grant with Confirm. Budget: switch, amount, Day/Week/Month. Notifications: three-way radiogroup.

### Task 6: `N runs` menu in the chat header
- [ ] `Thread.tsx`: at 2 or more live runs of the agent, a `N runs` button reusing `RunsMenuView` with facts built from the store.

### Task 7: Hold chip placement (review follow-up 1)
- [ ] Test: the chip is not `position: fixed`, and `App.tsx` renders it inside `main.center` before the views. Move it; verify at 1280x820 and 960x600 that it covers nothing.

### Task 8: Real check, changelog, PR
- [ ] Build UI, run the harness with a scratch `LEGION_HOME`, headed Edge, dark and light at 1280x820 and 960x600, compare with the mockup, read every screenshot. Exercise: second-run warning, Queue after it, reads grant Confirm, pause and budget round trip through the core.
- [ ] CHANGELOG lines, `npm run typecheck`, touched tests, push to `cloud`, open the PR (base: the 3a branch until #129 merges).
