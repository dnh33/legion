# Review: claude/rooms-probe-upgrade (vs rel2)

Reviewer: independent. Branch not modified. Commits: e9fa8c4 (R1), 78c59d4 (K1), f811a17 (U1).

## Gate results (run on the branch head, `npm ci` first)

| Step | Result |
|---|---|
| `npm run build:ts` | OK |
| `npm test` | **1378 tests, 1378 pass, 0 fail, 0 skipped** (rel2 baseline 1368, so +10) |
| `npm run typecheck` | OK (core + ui) |
| `npm run build:ui` | OK (only the usual chunk-size warning) |

Admin gate, native-secret flow, taint wrapping and tripwire/hedge tests are in that green run. The new route `POST /api/boat/ensure` is added to the admin-only list in `test/vm-fixes-http.test.ts`, so a token-only caller gets 403. `test/bsv-hedge.test.ts` passes. BSV port 3321 was not touched.

## Ranked findings

### Bugs

**B1 (Medium, R1): a bot-named budget above $10,000 is approved by the owner and then fails.**
- `src/core/comms/hub.ts` `planBotRoom` ~L649 only checks the ceiling when `cap !== null`. With the new default (no ceiling), any finite budget passes.
- `botCreateRoom` L566 then calls `createRoom`, which goes through `mergeGuards`, and that enforces 0.05 to 10,000 (L165). It throws 400 after the user clicked Allow.
- Reproduced (probe test, since deleted): `budgetUsd: 1e9` and `10001` give "APPROVED-THEN-ERR guards.budgetUsd must be a number between 0.05 and 10000". `10000` is created. `-1, 0, NaN, '5', 0.01, Infinity` are rejected up front (zod plus hub check). Good.
- Why it matters: the owner sees a card saying `Budget: $1000000000.00`, approves, and the bot gets a confusing error. It also breaks "what you allow is exactly what is created". Before this branch the $5 ceiling hid it.
- Fix: in `planBotRoom` and `recheckRoomPlan`, reject `b > 10_000` (export a `MAX_ROOM_BUDGET_USD` and share it with `mergeGuards`, the UI and `normalizeComms`). Add a test for 1e9 and 10001.

**B2 (Medium, R1): an operator-set ceiling is silently bypassed by omitting the budget.**
- `planBotRoom` L645 starts from `botRoomDefaultBudgetUsd` (now `null`). The `cap` check at L649 only runs when the bot names a budget.
- A user who set `botRoomMaxBudgetUsd: 2` (and no default) now gets unlimited rooms from a bot that leaves `budgetUsd` out. `normalizeComms` (config.ts) also clamps the default only when both are set. Old configs with an explicit max and no default used to get a $1 default.
- Why it matters: a configured max means "no bot room above this". Omitting the field is the easiest way around it.
- Fix: if `cap !== null` and the budget is `null`, use `cap` (or the default clamped to it). If the owner wants "no limit unless asked", document that the ceiling applies only to named budgets. Add a test with `botRoomMaxBudgetUsd` set.

### Design risk (not a bug, owner-approved)

**D1: an unattended bot room can now spend without a cap.** What still bounds it:
- Hop limit 6 consecutive bot-to-bot hops after the last human message, plus cycle repeats 3 and the `@everyone` cooldown. These are unchanged and still tested.
- Member cap 6 is unchanged and tested. 5 room requests per bot per 10 minutes. The owner must approve creation.
- **Not** bounded: the per-turn cost floor (`turnCostFloorUsd`) feeds only the budget guard, so it does nothing here. I found no daily or global cap in the room path. The R1 test shows cost 500 in one turn does not pause the room.
- The hop limit resets on every human message, so a chatty human plus long turns can still accumulate cost with no stop.
- UI: the header Cost meter shows "$x.xx · No limit" with an empty bar, so running cost is visible. There is no warning at a cost threshold, and the room list or other surfaces were not checked for cost.
- The approval card says plainly: "No spend limit: the room never pauses on cost, so it can spend without bound until you pause it or set a budget in room settings." This is clear. The room name is still `cardText`-sanitised and the taint line is still added (hub.ts L555-L561).
- Suggestion: consider one soft guard that does not need a budget, such as a toast or pause at some total (for example $25), a "set a limit" prompt in room settings, or an optional global daily cap. Still a decision for the owner.

### R1 checks that passed (code proof)

- **Null arithmetic.** `budgetStop` (hub.ts L776) returns `undefined` first when `budgetUsd === null`, so `Math.max(null, ...)`, `costUsd >= null` (which would coerce to 0) and `costUsd + estimate > null` are unreachable. The only other readers are the pause messages (L809-L816), which use `?? 0`. They run only after `budgetStop` returned a stop, so `?? 0` is dead code. No divide anywhere: the UI meter divides only when `max !== null && max > 0`.
- **Unintended pause.** None from null. A room already paused for `budget` stays paused until resumed. After the user removes the limit, resume works.
- **Persistence.** JSON keeps `null`. `RoomStore` (rooms.ts L43-L48) keeps finite numbers and `null`, and replaces missing/junk with the default `2`. A stored 4 stays 4. A legacy room with no `guards.budgetUsd` becomes **$2, not unlimited**. This is intended and tested. A persisted `"null"` string or `NaN` goes to the default 2. Good.
- **Validation.** Humans (`mergeGuards`): `null` allowed, anything else must be a finite number in 0.05..10,000. Bots: see B1 and B2. Zod `positive()` plus the hub check reject negative, 0, NaN, strings, 0.01 and Infinity.
- **UI.** `RoomHeader` Meter handles `null` (no divide, no `aria-valuemax`). `RoomSettings` shows an empty box with the placeholder "No limit". Empty saves `null`, a number must be 0.05..10,000, and you can add a limit and remove it (tested at hub level). `NewRoomDialog` is unchanged: human rooms default $2 and need a number, so no no-limit option there (fine, documented).
- Tests still cover member cap 6, hop/cycle guards and the 0.05 minimum.

### Polish

- **P1** `ui/src/rooms/roomsUtil.ts` L57: a room paused for `budget` whose limit was then removed reads "spent $x of its No limit limit". Reachable. Use a separate string when `budgetUsd === null`.
- **P2** `RoomSettings.tsx`: clearing the Budget box on a room with a limit removes it on Save with no confirmation. Intended, but a one-line hint ("this room will have no spend limit") when the box is blank and the room had a limit would help.
- **P3** `SECURITY.md` "Bots cannot make rooms on their own" bullet: the edited sentence runs the guard clause into "marked with who made them", which now reads as if the guards are marked. Split the sentence.
- **P4** `hub.ts` L812/L816 `?? 0` is dead code that would print "$0.00 budget" if it ever ran. Prefer an explicit unreachable guard.

## K1: lazy probe

- Probe count: `checkKey` is about 8 calls (test asserts `n >= 5`). Before first use there are none from the probe: `legion-core.ts` L53-L58 now calls `health.probe()` only when `keyChanged` (a key save in Settings). `restartReaper()` at core start (L78) passes `false`. `boat-health.ts` constructor and `view()` make no calls (tested).
- **Race:** `ensure()` (boat-health.ts) is fully synchronous up to `probe()`, which stores the in-flight promise in `this.probing`. A second caller returns that promise. Node is single threaded, so exactly one probe runs. Tested ("shares a probe in flight").
- **Re-open:** `Settings.tsx` effect calls `POST /api/boat/ensure` on every open, but the core answers from cache when `checkedAt !== null`. Tested: a second open adds no requests; Check again does.
- **Reset on key/base change:** `sync()` compares the client object and calls `clear()`, which resets `checkedAt`, so the next `ensure` probes once. Tested ("a new key forgets the old findings and looks again, once").
- **Failure path:** `doProbe` sets `checkedAt` even when boat.dev is unreachable or the key is rejected, so there is no retry loop. The finding goes to `keyProblem`/`keyOk` and the `boat.health` event, which Settings renders. Only a key change mid-probe leaves `checkedAt` null, and that is correct. First VM use calls `ensure()` fire-and-forget (vm-manager.ts L81), so it does not delay the start.
- **K1-F1 (Low, doc overclaim):** `docs/VM-NOTES.md` says "Legion makes no boat.dev call at start". That is true of the **probe** only. `startReaper()` (vm-manager.ts L253-L255) runs `refreshAll()` at start, which does `boat.get(sandboxId)` for every stored VM. A user with existing VMs makes N boat.dev calls at start. The new test starts a core with no VM records, so it cannot see this. Fix: reword to "no key-permission probe at start" (and mention the state refresh), or make `refreshAll` lazy too.
- **K1-F2 (Info):** saving a key still probes immediately. That matches the stated behaviour (a user action) but the brief lists only first VM use and opening Settings. Confirm it is wanted.

## U1: migration (tested with a scratch script against `dist`, then removed)

- Fresh install (`seedDefaults`, Builder seeded `default`): flag recorded, nothing changed.
- Legacy state (no flag, Builder `large`): Builder becomes `default`, flag written. Another agent set to `large` was untouched (`zealot:large` kept).
- Manual `large` set after the flag: kept on the next start. Re-run: migration skipped, never re-applies.
- No builder agent: no-op, flag recorded, no throw. Run twice: idempotent. A junk (non-array) `migrations` field is ignored, so the migration would run again once; harmless.
- Residual: a paying user who had deliberately chosen `large` before upgrade is reset once, since the data cannot tell it from the old seed. This is accepted by the brief and written in the CHANGELOG.
- Minor: `m.run` reads `b.vm.size`; an agent entry with no `vm` object would throw in the constructor. Use `b.vm?.size`.

## Overclaiming / copy

- No banned phrase ("cannot be bypassed", etc.) was added; `bsv-hedge` passes. CHANGELOG/SECURITY/COMMS-BRIDGE/ROOMS-UI-NOTES are scoped. SECURITY.md keeps "Residual: you are the control", which is honest. Only K1-F1 and P3 above need editing.

## Verdict: **SHIP AFTER FIXES**

Fix B1 (cheap, user-visible) and B2 (or consciously document it), and correct the "no boat.dev call at start" wording (K1-F1). The rest is polish. The no-cap risk (D1) is the owner's call; I suggest at least a soft warning.
