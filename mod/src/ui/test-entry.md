# Wiring the UI into `hooks/register.tsx`

The UI registers its hooks through one call. `hooks/register.tsx` needs two lines:

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

Buttons act through their keys. A Legion Button's `onPress` is a no-op. Its key is `encodeAction(action)`, and the lead's `ui.press` hook answers with `decodeAction(e.element)`. The grammar is in `actions.ts`. An index key (`allow#3`, `dismiss#1`) resolves with `cardAt(cards, n)` / `bandItemAt(band, n)`.

Once wired, `mod/test/plugin/ui-wired.test.tsx` passes (5 tests). Before then those 5 fail with "no implementation for ui.render". This was verified in a scratch copy wired as above: 17/17 plugin tests passed and `claude plugin validate` passed.
