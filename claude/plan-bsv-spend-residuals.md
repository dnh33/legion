# Plan: BSV spend residuals after the wallet-prompt fix (2026-10-06)

Branch `fix/bsv-spend-residuals`, worktree `D:\bots\legion-bsv-residuals`, base cloud/main `2bc28ce`. Comes back as a PR.
Follows the 0.2.5-g wallet-prompt fix (tracker section "2026-10-06 — BSV: the wallet's own prompt ...", KNOWN RESIDUALS).

## Facts (looked up, with sources)

| Documented fact | Source |
|---|---|
| wallet-toolbox `createAction` forces `signAndProcess:false` for a non-admin originator, builds, then asks for a spending grant if the net spend is > 0; `signAction` passes straight through | `bsv-blockchain/wallet-toolbox` master `src/WalletPermissionsManager.ts` L3989-4200, L4229 |
| No prompt inside a stored grant (monthly sum); a one-time ("ephemeral") grant exists | same file L1476-1530, L848 |
| BSV Desktop builds that manager with `seekSpendingPermissions: true` by default | `bsv-blockchain/bsv-desktop` master `src/lib/services/PermissionQueueManager.ts:955`, `src/lib/WalletContext.tsx` |
| An unsigned action nobody signs or aborts is set to `failed` by the toolbox monitor once it is idle for `abandonedMsecs` (5 min); the task runs every 5 min; failing it returns the inputs to spendable | wallet-toolbox `src/monitor/tasks/TaskFailAbandoned.ts`, `src/monitor/Monitor.ts:104` (clone at 320a82b) |
| Legion's `httpTransport` timeout and a closed connection both reach `walletCall` as kind `lost` | `src/core/bsv/wallet-probe.ts:118`, `src/core/bsv/spend.ts` walletCall |
| While the wallet builds, the request shows `pending-wallet`; the tool call waits `toolWaitMs` (100 s) then returns the current state; calling again with the same key only reads it | `src/core/bsv/spend.ts` handle(), buildTool() |

| Assumption | Check that proves it |
|---|---|
| BSV Desktop holds the HTTP `createAction` open while its grant prompt is shown, and answers after the owner decides | W1, W3 (real PC) |
| A denied grant reaches Legion as a non-200 or an error body (so `build-failed`, not a hang) | W1 deny path (real PC) |
| BSV Desktop runs the toolbox monitor, so an orphaned unsigned action is released within about 10 min | W3 (real PC) |

| Unknown | Owner-only check |
|---|---|
| How long a person needs for the grant prompt (reading amount, choosing one-time) | W1 timing |

## Problems

1. `spend.ts` agent-facing text is now false: the tool description says the owner confirms "in Legion and again in the wallet"; the result sentence says "the wallet asks again itself". The Assayer repeats both.
2. `createTimeoutMs` is 30 s. A wallet-toolbox wallet keeps `createAction` open while it asks the owner for a grant, so a careful owner can lose the race: Legion reports `build-failed`, the wallet may still show the prompt, and an approval then builds an unsigned action that Legion cannot abort (no reference) and that the wallet keeps until its monitor fails it (about 5-10 min).
3. The agent cannot tell "the wallet did not answer in time" from "the wallet refused": both are `build-failed`, so it may simply ask again and stack a second prompt in the wallet.
4. Stale comments: `spend.ts` A6 (signAction prompts every time), `index.ts` header ("the wallet's own prompt as the last gate").
5. Pack note `bsv-safety-ts-stack-server-keys` says Legion "has no wallet in this version and sets no spending limits"; Legion has per-network caps on its own spend tool.
6. No hermetic rehearsal of the wallet-toolbox behaviour: the fake wallet prompts nowhere, so W1-W5 have nothing to rehearse against before the real-PC run.

## Changes

A. `src/core/bsv/spend.ts` (pinned; re-pin `SPEND_PINS` only after the independent review signs off):
  - Tool description: the owner confirms in Legion's own native dialogs; whether the wallet also asks depends on the wallet; a `wallet-no-answer` answer means check the wallet for an open request before asking again.
  - Result sentence: "only the owner can approve a payment, in Legion's own dialogs" (no claim about the wallet).
  - `createTimeoutMs` 30 s -> 120 s (the card lifetime), with a comment: a wallet may hold this call open while it asks the owner for a spending grant. Still bounded, still never retried.
  - New reason code `wallet-no-answer`: `createAction` answered nothing (timeout or closed connection, kind `lost`). Other build failures stay `build-failed`. The audit line carries the code only (no wallet text).
  - A1/A6 comments rewritten (A6: the wallet may ask at createAction, at signAction, or not at all inside a grant).
B. `src/core/bsv/index.ts` header comment.
C. Pack: fix the `bsv-safety-ts-stack-server-keys` sentence; name `wallet-no-answer` where the spend-flow note lists refusal reasons; the 30 s figure; bump to version 10 (tests pin the version).
D. Fake wallet (`test/bsv-fake-wallet.ts`): a `grant` mode that behaves like wallet-toolbox: the first `createAction` for an originator holds the call until the test answers the grant (approve with an amount or one-time, or deny = an error answer); later calls inside an approved amount answer at once; `signAction` never holds. No real wallet, loopback only.
E. Tests (each with a scratch-mutation negative):
  - `createAction` is sent with a 120 s deadline (a recording transport), and SPEND_LIMITS.createTimeoutMs >= the card lifetime.
  - Grant mode, prompt answered "in time": the card appears; signing needs no second prompt; a second request inside the grant builds at once.
  - Grant mode, prompt left open past the deadline (deadline scaled down by the recording transport): status `failed` with `wallet-no-answer`, no card, nothing signed, one `proposed` and one `failed` audit line.
  - Grant denied: `build-failed`, no card.
  - Agent text: no sentence in spend.ts's readable strings claims the wallet asks (extend `test/bsv-wallet-prompt.test.ts` to spend.ts).
  - Pack v10 note says Legion's own spend tool has caps.
F. Docs: BSV-MODE step 4 (120 s, `wallet-no-answer`), the residual-risk paragraph, TESTING-BSV (grant mode), tracker KNOWN RESIDUALS -> done, W3 expectations (120 s; `wallet-no-answer`), PC-BSVT-26 text, CHANGELOG [Unreleased] (public-copy rules: `.claude/skills/public-facing-copy/SKILL.md`).

## Not in scope
- Anything that signs, spends or contacts the owner's wallet. W1-W5 stay owner-only real-PC checks.
- Changing caps, dialogs or the mainnet path.

## Gates
`npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui`, exact counts; independent review (default "not fixed") before the re-pin; PR to main; tell the mod-planning session (0.2.5-h).

## Round 2 (the BSV session's proposal, 2026-10-06)

| Documented fact | Source |
|---|---|
| BRC-219 Wallet Permission Prompt Liveness (Ty Everett), merged 2026-07-30: apps should not impose permission-specific timeouts; wallets must not abort a permission request on elapsed time alone | `bsv-blockchain/BRCs` `wallet/0219.md` (commit 9682ced, PR #162) |
| wallet-toolbox repo archived 2026-06-12; live code in `bsv-blockchain/ts-stack` `packages/wallet/wallet-toolbox`; same grant model; signAction checks the caller owns the reference, no prompt | ts-stack `WalletPermissionsManager.ts` L1717, L4330-4400, L4857 |

Decision: follow BRC-219 with a 15-minute safety cap. Owner can end a wait with Cancel (panel, reuses native Deny), Deny, Freeze,
Disconnect; a build that arrives later is released (abortAction to the wallet the build was asked of; release-only, also after
Freeze/Disconnect). Tests: scenarios cancel-/disconnect-/freeze-while-the-wallet-asks; mutants M30-M35.

