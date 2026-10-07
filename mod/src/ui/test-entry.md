# Wiring the UI into `hooks/register.tsx`

The UI registers its hooks through one call. `hooks/register.tsx` needs two lines (they are already in place):

```ts
import { registerUi } from '../src/ui/register-ui.tsx'
// inside register, after registerLegion(on):
registerUi(on)
```

What `registerUi(on)` hooks (each with a literal matcher):

- `ui.render` `{ component: 'Pane', requestId: 'legion' }`
- `ui.render` `{ component: 'AbovePrompt' }`
- `ui.render` `{ component: 'CommandOutput', props: { command: 'to' } }`, and the same for `'say'`
- `state.set` `{ plugin: 'legion-mod' }`: the status line. It skips `threads` and `live`.

It registers no `session.start`. The validator refuses a second unmatched hook on one event.

## How Buttons act

A Legion Button acts through its key. Its `onPress` is a no-op. Its key is `encodeAction(action)`, and the lead's `ui.press` hook answers with `decodeAction(e.element)`. The grammar is in `actions.ts`.

An index key (`allow#3`, `dismiss#1`) resolves with `cardAt(cards, n)` / `bandItemAt(band, n)`.

## The view flags the pane reads, and the press branches they need

The pane reads two view flags that the contract does not hold yet: the key-help view and a task's open steps. `views/common.ts` `uiFlags` reads them defensively. Until these land, `k` and the "N steps" control raise their keys and nothing changes.

```ts
// types/index.d.ts, UiState:
/** The key-help view (k) is open. */
keysOpen?: boolean
/** The task whose finished tool lines are unfolded, or null. */
stepsOpen?: string | null

// the ui.press hook, beside the other kinds:
case 'keys': ctx.ui = { ...ctx.ui, keysOpen: a.open }; await $.state.set(UI, ctx.ui); break
case 'steps': ctx.ui = { ...ctx.ui, stepsOpen: a.taskId }; await $.state.set(UI, ctx.ui); break
```

`selectView` and `selectTask` should also clear `keysOpen`, so a tab press leaves the help view.
