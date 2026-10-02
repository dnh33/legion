# Independent review: BSV T5 mainnet policy core (`claude/bsv-t5-mainnet` against `integration/v1`)

Reviewer stance: default verdict "not fixed", builder's report not trusted. Defensive framing: gaps in controls only, no exploit payloads. Reviewed head `12d2f42`. Nothing on the T5 branch was modified; scratch probes and mutations were reverted (`git status` clean).

**Verdict: SHIP AFTER FIXES.** The switch, arm, per-network limits and the route hold up under 104 scratch mutations (the survivors are listed below) and the probes. The gaps are at the seams with the spend path and `index.ts`: audit lines that lose the network, an engine that accepts a transaction with no payment output, a tamper path that leaves the switch on, and a warning string that is false once the owner enables mainnet.

## 1. Gates (exact counts)

| Gate | Result |
|---|---|
| `npm ci` | ok |
| `npm run build:ts` | ok, no errors |
| `npm test` (includes `build:ts`) | tests 1484, pass 1482, fail 0, skipped 2, cancelled 0 |
| `npm run typecheck` (core and ui) | ok, no errors |
| `npm run build:ui` | ok (vite build, 3 s; only the usual chunk-size notes) |

## 2. Scope (by diff only)

- 16 files, all T5-owned: `networks.ts` (new), `policy.ts`, `policy-store.ts`, `types.ts`, `wallet-probe.ts` (strings only), `mainnet-routes.ts` (new), `test/bsv-policy-nets.test.ts`, `test/bsv-mainnet-defaults.test.ts` (new), `test/bsv-net-helpers.ts` (new helper), plus shape updates in `bsv-policy`, `bsv-config`, `bsv-wallet-probe`, `bsv-fix-round`, and three the plan did not list: `bsv-electron-emu`, `bsv-guard`, `bsv-module-wallet`. All three are necessary: arm now needs the switch, and `networks.ts` joins the crypto-hashing list.
- `test/bsv-scan.ts`, `bsv-tripwire*.test.ts`, `bsv-hedge.test.ts`: no diff.
- Added source lines contain none of: `signAction`, `createAction`, `abortAction`, `listOutputs`, `fetch(`, `child_process`, `spawn`, `node:http`, `node:net`, `3321`. No `'allow'` verdict (`Verdict` is still `'deny' | 'needs_approval'`). `networks.ts` imports only `node:crypto` and exports only `NET`, types and the two pure functions.
- Not wired: `index.ts` is untouched (the route registration, `restore`/`unknown` seeding, `voidPending` on a probe flip and the audit lines for `mainnet`/`voided` events are T2's). So today there is no way to turn mainnet on in the product. That is safe, but it means the route is tested only against a stand-in `requireNative`/`persist`, not the real module.
- Weakened existing tests (disclosed in the diff, acceptable): `bsv-electron-emu` now asserts that the arm dialog is refused while the switch is off, and the `policy:armed` audit assertion is dropped. Until T3's second pass there is no automated test of the native arm flow or its audit line.

## 3. Findings, ranked

### Bugs and control gaps

**B1. HIGH (fix before T2 merges): the network is lost in the audit lines that rebuild the ledger.**
`policy.ts:199-202` `approved`, `settled`, `expired` and `resolved` events carry no `net`; `index.ts:135` writes the `executed` line as `{requestId, sats}`. `ledgerFromAudit` (`policy.ts:847`) reads a missing `net` as testnet.
Evidence (probe P6): an executed line without `net` is rebuilt as a testnet spend; with `net:'main'` as mainnet; the same id with both counts once per network. After a restart a mainnet spend recorded by the engine's own event is therefore charged to testnet, and mainnet headroom is under-counted (the 24 h cap, 5,000 sat default). Only a second line written by `spend.ts` with `net:'main'` would fix mainnet, and then testnet gets a phantom spend.
Also: `index.ts` ignores the `mainnet`, `voided`, per-network `caps` and `allowlist` events (the `switch` has no case), so there is no audit line for `voidPending`, and `caps-changed` cannot say which network changed. The `armed` line still says "nothing in this version can spend".
Fix: add `net: Net` to `approved`/`settled`/`expired`/`resolved` (and `unknown` outcomes), pass it through `onPolicyEvent`, add `case 'mainnet'` and `case 'voided'`, add `net` to `caps-changed` and `allowlist-changed`; add a module test that executes a mainnet spend, restarts, and checks the mainnet 24 h usage and zero testnet usage.

**B2. MEDIUM-HIGH: the engine accepts a transaction with no payment output.**
`policy.ts:611-623`: caps, allowlist and the output limit are applied to `outputs.filter(!change)` only, and nothing requires at least one payment. Probe P2: a decoded tx with a single output flagged `change` to an arbitrary string returns `needs_approval` on both `main` and `test` (total = fee only, allowlist loop empty, caps see the fee). Plan C4 and 12.1 say the caps are enforced on real decoded values; if the decoder or step 4 of `spend.ts` ever mislabels, the engine is not a second line. `maxOutputs` is a maximum, never a minimum.
Fix: in `evaluateChecked` deny with `bad-request` unless `payments.length >= 1`; on main require exactly `payments.length === 1`. Add a test and a mutant.

**B3. MEDIUM: nothing in the engine stops an approved mainnet spend after the owner disables mainnet.**
`mainnetOff` (`policy.ts:488`) voids pending cards only; approved records are left (P5: status stays `approved`, 620 sat stays reserved, `settle(executed)` still succeeds). Plan 12.1 row 10 re-probes the wallet network before `signAction` but never re-reads the switch. Owner presses Disable (dialog-free, "always available") between approve and sign and the spend can still go out.
Fix: add an engine query for the spend path, for example `canSign(requestId)`: status `approved`, not frozen, and for main `mainnetEnabled`, called immediately before `signAction`; make it a plan row and a T2 test (Disable between approve and sign: zero `signAction`).

**B4. MEDIUM: a policy-file tamper detected while running does not switch mainnet off.**
`index.ts:164-176` `checkPolicyFile` freezes and then `persistPolicy()` writes the in-memory config back, which keeps `mainnetEnabled: true`. Plan 12.1 "Auto-off" and C33 list a tamper. Only the startup path is fine (`untrustedConfig` is off and frozen; covered). Plain Unfreeze afterwards (P8: unfreeze keeps the switch) leaves mainnet on without the owner choosing it again.
Fix: call `policy.mainnetOff(why)` before `freeze` in `checkPolicyFile`; add a C33 test through the module.

**B5. MEDIUM: the file can still say `mainnetEnabled:true` while memory says off.**
Three ways: (a) `mainnet-routes.ts:35-38` freezes in memory only when the off-save fails, and the frozen flag is not saved either, so a restart loads switch on and unfrozen; (b) `policy.ts:387` the restart seed turns the switch off in memory only (no hook, no save, no audit); a restart before any other save re-enables it; (c) the hook fires only on an on to off change (`policy.ts:494`), so the owner's Disable when memory is already off does nothing and cannot repair the file, and still answers `persisted: lastSaved` (`mainnet-routes.ts:49`, a stale `true`).
Fix: make Disable always call `persist()` and report that result; treat the audit log as a second source (a `mainnet-off` line after the last `mainnet-on` forces off at load, same verified-chain rule as the policy hash); route the seed path through the hook once it is registered.

**B6. LOW-MEDIUM: on testnet the engine passes any recipient that is not a valid mainnet address.**
`policy.ts:619` `an === null ? net === 'main' : an !== net`, and `recipientFitsNet('test')` is `an !== 'main'`. Probe P3: `alice@example.com` and a mainnet-version string with a corrupted checksum are accepted on a testnet allowlist and get `needs_approval`. Plan 12.1 says the version byte must match the network; for main that holds, for test only half. `spend.ts` is planned to validate base58check, so this is defense in depth.
Fix: for `test`, require `addressNet(recipient) === 'test'` in `evaluate`, `setAllowlist` and `sanitizeNet` (old tests that use token-shaped testnet entries need a fixture update), or record it as an accepted residual and make `spend.ts` do it.

**B7. LOW: a legacy-shaped file with `mainnetEnabled:true` loads ON.**
`policy.ts:310` reads the flag even when `nets` is absent (P1: `legacy+true true`). No old Legion ever wrote that key, so it is a hand edit, and the fingerprint (`index.ts:147-150`, covered by tests) catches it. Fix: `hasNets && o.mainnetEnabled === true`, so the legacy shape can never enable mainnet.

**B8. LOW: restart seeds with a malformed id or amount are dropped silently.**
`policy.ts:382` (probe P7: id `short` gives 0 unknown). The unknown-outcome block can vanish on both networks. Fix: seed a sanitised placeholder or freeze on any dropped seed.

### Polish

- `MAINNET_WARNING` and `describeWallet` (`wallet-probe.ts:238,251`): "Mainnet spending is off in Legion's own code until you turn it on" is accurate only while off. After the owner enables or arms mainnet, the panel text still says off. The wording is properly scoped ("Legion's own code"; no banned phrase; hedge test green), but it states a state it does not know. Pass the switch into `describeWallet` or reword to "needs the owner's switch (off by default), Arm, your confirmations and the wallet's own prompt".
- `DEFAULT_CAPS`, `HARD_CAPS`, `MAX_ALLOWLIST` (`policy.ts:41-46`) are exported un-suffixed and are the testnet values. A T2 author who reaches for `HARD_CAPS` on a mainnet path gets testnet ceilings. Rename or deprecate.
- Arm design note (accepted by the plan, R5): a declined, expired, voided or hash-mismatch outcome keeps the arm; only an approval consumes it (P4). A mainnet spend that fails after approval burns the arm. Both are consistent with "one arm, one approved spend"; say so in the dialog text.
- Per-network `change` outputs are trusted from the decoder: a change output of any amount to any address is outside the caps (the plan's accepted "wallet-claimed" residual). B2's fix narrows it.

## 4. Control by control: mutation results

Method: one literal edit to the source, `tsc`, run all `dist/test/bsv-*.test.js` except `bsv-review-tripwire` (36 s, no relation to T5 code) and `bsv-pack`, expect red, revert via `git checkout`. 104 mutants in total; `T1` and `N8` are deliberate no-op controls (green as they should be). Anchors that did not match (`T10`, `N1`) were no-ops or typos and are not counted.

| Control | Mutants that went RED | Survivors |
|---|---|---|
| C25 default off, fail closed | default true when absent (`C25a`); drop `mainnet-disabled` reason (`b`); untrusted file loads on (`c`); file never stores switch (`e`, `f`) | `C25d` `buildPolicyConfig` coerces a non-boolean to on: unreachable for typed callers (all pass booleans), equivalent in practice. Spend-flow half ("zero `createAction`") not reviewable: no `spend.ts` |
| C26 network never an input (engine part) | no network literal check (`a`); no wallet-network literal check (`b`) | none. The `extra-input` key rule is `spend.ts`, not reviewable |
| C27 route | drop `requireNative` on enable (`a`); disable needing native (`b`, tests expect dialog-free); enable while BSV off (`c`); apply before save (`e`); extra body keys (`f`); skip file check on enable (`g`); failed off-save does not freeze (`i`); no audit on off (`j`); no audit on on (`k`) | `C27d` enable-while-frozen check: NOT equivalent. The route saves before it applies, so with the check gone the file is written `mainnetEnabled:true` and only then does the engine refuse (409); the test looks at memory and the status code, not the file. Add a file assertion; **`C27h` the disable path skips `checkPolicyFile`: no test** |
| C28 arm | arm not consumed on approve (`a`); evaluate skips arm check (`b`); approve skips it (`c`); arm with switch off (`d`); expiry off-by-one at the tick (`e`); ignores monotonic clock (`f`); ignores wall clock (`g`); arm while frozen (`h`); minutes unvalidated (`j`) | `C28i` enable does not clear a stale arm: unreachable (arm is refused while off and `mainnetOff` disarms), equivalent |
| C29 per-network caps, allowlists, reservations, ledgers | all 9: shared applies (`a`), testnet ceilings in `validateCaps` (`b`) and in `sanitizeNet` (`c`), allowlist size (`d`), shared reservations (`e`), shared session (`f`), shared 24 h window (`g`), file caps unclamped (`h`), evaluate on testnet limits (`i`) | none |
| C30 version byte equals network | no check in evaluate (`a`); null recipient passes on main (`b`); `setAllowlist` accepts other net (`c`); file allowlist accepts it (`d`); `recipientFitsNet` always true (`e`); no checksum compare (`f`, rerun after the first mutant failed to compile); unknown version accepted (`g`); `addressNet` always test (`h`); wrong mainnet byte (`T19`) | **`C30i` removing the `bytes.length !== 25` check survives.** A 26-byte payload `[00, hash160, checksum over the first 21 bytes, extra byte]` encodes to 35 characters, inside the string length gate (probe P10: the real decoder returns null for it, but no test holds that vector). Add it to `bsv-policy-nets` |
| C31 flip (engine part) | approve ignores flip (`a`); propose ignores mismatch (`b`); unknown wallet network accepted (`c`); flip refuses but card stays pending (`d`) | none. Flips before sign and after sign are `spend.ts` |
| C33 auto-off | no `mainnetOff` on settle-unknown (`a`), mismatch (`b`), freeze with approved main (`c`), overdue approved (`d`), restart seed (`e`); no void (`f`), no disarm (`g`), hook never runs (`h`), does not turn off (`i`) | none at engine level. Runtime tamper and audit-failure triggers are not implemented here (see B4) |
| C34 unknown blocks both | only testnet blocks (`a`), only mainnet blocks (`b`), evaluate ignores it (`c`); seeded record network lost (`N2`) | none |
| C35 ships off, no overclaim | warning says "cannot be bypassed" (`a`) and "no spend tool" (`b`): the hedge test goes red | docs statement removal not run (T4) |
| 12.1 rows | per-network ledger net (`N3`, `N4`, `T4`, `T5`), legacy migration (`T6`, `T7`), voidPending filter (`N5`), dedupe keeps larger (`N6`), mainnet allowlist (`N7`), approve checks hash, confirmations, unknown, pending-only, live-funds and untrusted confirmations (`A3`-`A8`), caps, fees, outputs, reservations (`T13`-`T18`) | **`H1` and `H2`: `requestHash` without `net` or without `tainted` is not detected** (the hash binds the approval to the card; add a test that a different net or taint gives a different hash). `A1`, `A2`: the approve-time freeze and switch checks are redundant because `freeze`/`mainnetOff` already void pending cards: equivalent, fine as defense in depth. `T3` voidPending skips invalid-net records, `T9` `setMainnetEnabled('yes')`, `T11` card TTL at the exact tick, `T12` 24 h window at the exact edge: untested |

Surviving mutants worth a test: C27d, C27h, C30i, H1, H2, T11, T12, T3, T9. None changes money behaviour today, but T11 and T12 are exactly the "clock edge" rows the plan lists for C10 and C22.

## 5. Probe results (scratch tests, not committed)

- Hostile `policy.json` shapes: strings, numbers, arrays and objects in `mainnetEnabled` load false; `NaN`, negative, string and `Infinity` caps fall to defaults; `1e308` is not a safe integer and falls to defaults; `1e15` clamps to the hard ceiling; a tx cap above the session cap is clamped down; `__proto__` and `constructor` keys do nothing and pollute nothing; mainnet `maxOutputs` is forced to 1. Truncated file loads untrusted (frozen, off). A hand-edited `config.json` cannot carry any switch (the branch's own test passes; I read it, I did not write a separate probe).
- Fingerprint: edited, replaced, unrecorded and missing files all load off and frozen (existing tests, mutation `C25c` red).
- Arm: decline, hash mismatch and missing confirmation keep the arm; approval consumes it; a failed settle after approval leaves it burned; expiry works at the tick on both clocks, a wall clock set back an hour still expires on the monotonic clock, forward expires on the wall clock; restart disarms (arm is memory only); one arm then a second card is `not-armed`.
- Addresses: lower-cased, upper-cased, padded and one-character-changed mainnet addresses all fail (`not-allowlisted` plus `address-network-mismatch`); a testnet address on a mainnet request and the reverse fail.
- Ledger: duplicate ids across networks count once per network; `MAIN` (wrong case) becomes `invalid` and counts on both networks (over-counts, safe); the 24 h window excludes a spend at exactly now minus 24 h.
- Concurrency: all engine methods are synchronous; an `onEvent` observer that calls `evaluate` re-entrantly (3 nested requests) reserves correctly and stays under the cap.
- Same request id on the other network is `bad-request` (the stored hash differs), but see `H1`.

## 6. What this review could not cover

Not in this branch, so not reviewed: `spend.ts` flows (network pinned per request, `extra-input` keys, probes before approve and sign, post-sign flip), native dialogs D1-D3 and the arm and enable dialogs, the real module wiring of the route, the tripwire pins (`SPEND_PINS`, `NET_LITERAL` rule) and the hedge docs (T4). B1 to B5 should be re-checked when T2 lands.

## 7. What only a real testnet wallet VM or the owner's real-funds check can verify

- U8, U11: the strings and address version bytes the wallet really uses for test and main (`readNetwork` and `NET[...].versionByte` are assumptions); whether any wallet claims `main` for a testnet-address transaction.
- U12: the unsigned-transaction shape and a standard P2PKH change output on both networks; the decoder's inputs, fee and change labelling against real BEEF.
- U13: whether the wallet shows its own prompt for every mainnet `signAction`, with no "always allow" default (stop condition).
- U14: real fee levels (is a 100 sat mainnet fee ceiling workable); the 1,000 / 2,000 / 5,000 sat mainnet defaults against real use.
- U6: how the wallet reports a user decline (drives the `unknown` path and mainnet auto-off, R9).
- R0 to R11 of plan 12.6b: the dialogs reading correctly (full address, LIVE FUNDS wording), the wallet balance falling by the fee only, the explorer check. Every document keeps saying "has not been verified with real funds" until those are recorded.
- Electron main: native dialog defaults (Cancel, Escape) and the button position for D2 on a real Windows desktop.
