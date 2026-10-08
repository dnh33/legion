# Updater UX states + single instance — recorded negatives

Branch `feat/updater-ux` (based on `cloud/main` @ `2f02236`, PR #71). Changes are UNCOMMITTED in
`D:\bots\legion-uxud`. No commit, no push, no PR.

Per AGENTS.md rule 3, every new test was seen RED under a temporary scratch mutation of the source that was then
reverted. The panel and `main.ts` were restored byte-for-byte (a Python harness asserted equality after each case).

## What changed and the negative that proves the test bites

| # | Behaviour change | Scratch mutation | Observed red |
|---|---|---|---|
| 1 | Check control is a real busy state: spinner + "Checking update state…" vs "Check now" | label reverted to `st.phase === 'checking' ? 'Checking…' : 'Check now'` | `✖ the check control is a real busy state…` (exit 1) |
| 2 | `check.lastCheckedAt` is displayed (formatted) | last-check paragraph reverted to the old single line | `✖ shows when the last check happened, not only its result` |
| 3 | Download progress names bytes of the route-correct total | label reverted to `${pct}%` only | `✖ download progress names bytes of the route-correct total…` |
| 4 | Committing says Legion restarts to finish | text reverted to "Installing. Legion restarts when this finishes…" | `✖ committing says Legion restarts to finish…` |
| 5 | A failed outcome offers a one-click **Try again** | `Try again` button removed from the failure branch | `✖ offers a one-click Try again that re-offers the download or re-checks` |
| 6 | Release notes are withheld exactly when the panel refuses (`notifyOnly`) | gate removed: `a.notes && <pre …>` | `✖ withholds the release notes exactly when the panel refuses to install` |
| 7 | `decideSingleInstance` quits a second process (pure function) | returns `{ primary: true, quit: false }` unconditionally (the stacking bug) | `✖ a process that does not get the lock quits and never becomes primary` |
| 8 | `main.ts` routes the lock answer through the pure decision | reverted to the inline `if (!app.requestSingleInstanceLock())` | `✖ asks Electron for the lock and routes the answer through the pure decision` |

## Negatives recorded as tests (name starts with `negative:`)

- `update panel: the check control…` → `negative: the label is a branch, not the fixed string "Check now"`
- `update panel: a failed outcome is actionable…` → `negative: the Try again button sits inside the failure branch, not the success branch`
- `update panel: a refusal does not print the notes that contradict it` → `negative: an unconditional notes render would show "installs in place" beside "cannot be installed"`
- `single instance: the first process wins…` → `negative: a second instance is never primary, which is what stacks two windows over one core`
- `single instance: main.ts is wired to the rule…` → `negative: main.ts does not keep the old inline !requestSingleInstanceLock check`

## Why notes are withheld on a refusal

The manifest notes can read "installs in place from 0.2.5-o" while the same status refuses the install ("cannot be
installed") — the owner hit exactly that pairing. The notes are untrusted release text, so on the `notifyOnly` route
(`requiresFullInstall && !canFullInstall`, or `mode !== 'apply'`) only the refusal/support line is shown; the
"Release notes" link (which leads to the release page) is kept.

## Verification commands (node v24.13.1 at /c/nvm4w/nodejs/node.exe — the task said v22; PATH/`which node` is Hermes'
## own v26.7.0)

```
npm run build:ts
node --test dist/test/single-instance.test.js dist/test/update-panel-states.test.js \
  dist/test/update-retry-lock.test.js dist/test/updater-surface.test.js \
  dist/test/updater-module.test.js dist/test/updater-apply.test.js dist/test/armory-ui-store.test.js
# -> tests 143, pass 143, fail 0
npm run build:ui    # vite build of the panel + css -> built in ~4.5s
```
