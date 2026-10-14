# PR 3a: The project page, what needs you first. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Replace the single-scroll project page with the tabbed page whose Overview opens on "what needs you": Working-now strip, capped digest with inline answers behind a client-side hold, state groups and By-agent units, side column, banners, plus the rail Option A sub-line and run count and the project menu with the cross-project dot.

**Architecture:** All decisions are pure modules under `ui/src/projects/` (`hold.ts`, `focus.ts`, `page/pageLogic.ts`, `page/askLogic.ts`) with node tests; React components in `ui/src/projects/page/` only render what the modules return. Counts come from the one derivation in `src/shared/attention.ts` (`deriveAsks`, `countAsks`, `sortAsks`, `capAsks`, `mergeReads`, `digestEvents`, `digestState`). Away settings, `lastLooked` and spend come from the PR 2 routes through a small external store (`awayStore.ts`). The hold is an in-memory object: nothing reaches the core until its countdown ends or Send now.

**Tech Stack:** React 18 + Vite IIFE bundle (`ui/`), TypeScript, node:test on `dist/test` (no DOM runner), Playwright against the repo harness for the real check.

**Spec:** `docs/superpowers/specs/2026-10-14-runs-without-you-design.md` sections 3.1, 3.2, 3.5, 3.7, 3.8, 4.2, 8, 9, 10 "PR 3". Target: `docs/superpowers/specs/assets/2026-10-14-project-page/project-page-v1.html`.

## Global Constraints

- Hold: 5 s for every Allow-type answer, 10 s for irreversible asks (consequence level 3 and certain). Keyboard A on an irreversible ask needs a second A within 2 s. Deny and Reject send at once. A reload or crash during the hold sends nothing. (decisions-log 2026-10-14 "Allow hold length")
- Inline Allow only when `consequence.certain`, the card is not `clickOnly`, and not `noRemember` (spec 3.2 / 5.4). Otherwise the row's primary action is Open.
- Allow buttons are neutral. Mint only on New task, live dots, live status icon, live card border. No side stripes.
- Targets 24 px minimum. Text 4.5:1 in both themes. Names on every digest button carry agent and item.
- Copy: no em or en dashes, "your computer", no outside product names. Strings come from the spec section 12 table.
- Tab and lens live in memory only (one `pageState` seam), no new localStorage key.
- Every resting bust is a still (PR 1). Never mount a live engine for a row.
- No `Co-Authored-By`. Local gate: `npm run typecheck` plus touched test files. CI is the full gate.

## Review Focus

- A ask that disappears (answered elsewhere, run ended) while its hold is counting: the hold must not send for a vanished ask and must say so. (`hold.test.ts`, `askLogic.test.ts`)
- Pointer resting under the button at click time must not freeze the countdown. (`hold.test.ts`)
- "Nothing new" must still list every open ask (bug B1). (`projects-page.test.ts`)
- Unknown consequence and click-only cards never get an inline Allow. (`projects-page.test.ts`)
- Focus never falls to `body` after a row is removed. (`focus.test.ts`)
- A task with no project, a removed project, an ask with no task: meta and groups do not throw. (`projects-page.test.ts`)

## File structure

Create: `ui/src/projects/hold.ts`, `focus.ts`, `awayStore.ts`; `ui/src/projects/page/{pageLogic.ts, askLogic.ts, ProjectPage.tsx, Overview.tsx, Digest.tsx, AskRow.tsx, WorkingStrip.tsx, StateGroups.tsx, AgentUnits.tsx, SideColumn.tsx, Banners.tsx, RunsMenu.tsx, ProjectMenu.tsx, TabsTasksRooms.tsx, SettingsStub.tsx, Menu.tsx, page.css}`; tests `test/hold.test.ts`, `focus.test.ts`, `projects-page.test.ts`, `project-page-source.test.ts`.
Modify: `ui/src/projects/ProjectView.tsx` (becomes a thin wrapper), `ProjectSwitcher.tsx`, `projectsLogic.ts` (rail line, run counts, menu rows), `ui/src/components/AgentRail.tsx`, `ui/src/mascot/useRelicState.ts`, `ui/src/api.ts`, `ui/src/styles/tokens.css`, `ui/src/projects/projects.css`, `src/core/away/index.ts` (project spend route carries the budget verdict), `CHANGELOG.md`, the spec (hold length).

### Task 1: Hold state machine (`hold.ts`)

- [ ] Write `test/hold.test.ts`: `holdMs` (5000 / 10000 / unknown stays 5000 but never offered), tick to zero sends once, pause by hover only after the pointer left once, pause by focus-visible, resume, Undo before zero never sends, Send now sends once, a second Send now or tick sends nothing more, `dispose` then tick sends nothing, `ok:false` ends as `refused` with the core's reason, a throwing `send` ends as `refused`, source grep: no storage, fetch or beacon in `hold.ts`; `digestKey`: A on a normal ask allows when armed, A on an irreversible ask arms then allows on the second A within 2 s, a second A after 2 s only re-arms, any other key clears the arm, D denies when armed, click-only A does nothing.
- [ ] Run it, see it fail (module missing).
- [ ] Implement `createHold`, `holdMs`, `digestKey`.
- [ ] Run, see it pass; mutate the pause rule (hover pauses at once) and the single-send guard, see each fail, restore.
- [ ] Commit `projects page: the hold that delays an Allow, in memory only`.

### Task 2: Focus restore (`focus.ts`)

- [ ] Test `pickFocusKey(keysBefore, anchor, keysAfter)`: same key survives; else the next surviving sibling after it; else the previous; else the region key; never null when a region key is given.
- [ ] Implement it plus `restoreFocus(root, anchorKey, regionKey)` (DOM, thin).
- [ ] Commit `projects page: focus lands on the next row after an answer`.

### Task 3: Page logic (`pageLogic.ts`, `askLogic.ts`)

- [ ] Test, from fixtures: `metaParts` (full, archived, empty, paused, zero parts omitted), `tabDefs` (pip + count), `workingAgents` and `runsOf` (all projects), `digestModel` (top 3, `N more`, folded line text, header text, quiet state keeps asks, spend), `askRowModel` per kind (command with chip, merged reads, question options, proposal) with `inlineAllow` false for unknown / clickOnly / noRemember, `waitLine` (deny / park / quiet / parked), `stateGroups` (caps 5 and 3, queued reason, stopped vs failed, review from board), `unitModel` (lead line priority needs-you > working > queued > failed > stopped > review, asks without a task), `railLine` priorities (this project's asks, working, also elsewhere, role), `projectMenuRows` (counts, elsewhere dot), `budgetBanner`.
- [ ] Implement.
- [ ] Commit `projects page: one derivation for every count and line`.

### Task 4: Core spend route carries the budget verdict

- [ ] Extend `test/away-routes.test.ts`: `GET /api/spend?scope=project&project=ID` returns `budget: { limited, reached, overridden, spent, limit?, period?, periodEnd? }`; absent budget gives `limited:false`.
- [ ] Implement in `src/core/away/index.ts`.
- [ ] Commit `spend route: say whether the project's budget is reached`.

### Task 5: API and away store

- [ ] `api.ts`: `away()`, `patchAwayProject`, `markSeen`, `projectSpend`, `holdApproval`, `budgetOverride`. `awayStore.ts`: policy, looked, spend per project; refreshed on `away.updated`, `budget.reached`, and project open. Typecheck.
- [ ] Commit `projects page: the away settings and spend reach the window`.

### Task 6: The page (frame, Overview, digest, groups, units, side, banners)

- [ ] Components and `page.css` from the mockup, the pure models above. Tabs: roving tabindex, arrows, Home, End, `aria-controls`, `tabpanel`. Board tab keeps `BoardPanel`; Tasks and Rooms reuse the existing lists; Settings tab keeps the old cards and links the new areas as they land in 3b.
- [ ] Digest answers: Allow, Allow all, a question option, Accept go through `createHold`; Deny and Reject send at once. Live region announces each state. `restoreFocus` after each render.
- [ ] Tokens added to `tokens.css`: `--control-line`, `--warn-line`, `--live`, `--danger-ink`, `--warn-ink` (values from the mockup).
- [ ] `npm run typecheck`, `npm run build:ui`. Commit in two: frame + tabs, then digest + hold + groups + units + side + banners.

### Task 7: Rail, switcher, mascot

- [ ] `AgentRail.tsx`: Option A sub-line (one priority), run count at 2+, row `aria-label`, `title`. `ProjectSwitcher.tsx`: menu button with `N elsewhere` dot, `menuitemradio` rows. `useRelicState.ts`: awaiting only for the selected agent's own asks (test in `test/relic-state.test.ts`).
- [ ] Commit `rail: one sub-line and a run count` and `big mascot: asks only for its own agent`.

### Task 8: Verify for real

- [ ] Harness core with a scratch `LEGION_HOME` under the scratchpad, seed a busy project (asks of every kind, working, queued, failed, stopped, done, a second project with an ask), built UI in headed Edge, dark and light at 1280x820, 1280x720, 960x600, compare with the mockup, read every screenshot. Fix, re-shoot once.
- [ ] CHANGELOG, `npm run typecheck`, touched tests, push to `cloud`, PR "The project page: what needs you, first".

## Self-review

Spec coverage: 3.1 frame (tasks 3, 6), 3.2 digest + hold + focus + states (1, 2, 3, 6), 3.5 rail (7), 3.7 runs menu (6), 3.8 banners (6), 4.2 `lastLooked` (5, 6), 8 accessibility (6, 8), 9 tests (1 to 3), the mascot fix (7). Not in 3a: sheet, composer second-run box, project Settings areas, thread-head runs menu, Park (PR 5).
