# Review: BSV T1 plumbing (`claude/bsv-t1-plumbing`, 2 commits, base `integration/v1`)

Reviewer: independent, default "not fixed". Defensive framing only. Port 3321 never touched; no secrets seen or written.
Linux only: nothing here was run on Windows.

## Verdict: SHIP AFTER FIXES (one blocking item, F1)

## Gates (branch head, `npm ci`, then the four commands)
| step | result |
|---|---|
| `npm run build:ts` | ok |
| `npm test` | **tests 1434, pass 1430, fail 2, skipped 2** |
| `npm run typecheck` | ok (no errors) |
| `npm run build:ui` | ok (vite built in 3.1 s) |

The 2 failures are both in `test/bsv-module-wallet.test.ts` (see F1). The task said the baseline is all green and the file is not in the branch diff, so these are regressions from T1's `state.ts` change. I did not re-run the baseline myself.

## Scope check (diff `origin/integration/v1...origin/claude/bsv-t1-plumbing`)
- Source changed: `audit.ts`, `policy.ts`, `state.ts`, `wallet-probe.ts`, `wallet-tool.ts` only. Tests changed: `bsv-audit`, `bsv-config`, `bsv-fix-round`, `bsv-policy`, `bsv-wallet-probe`, new `bsv-spend-restore`. All T1-owned. OK.
- `test/bsv-scan.ts`, tripwire and hedge tests: untouched (empty diff). OK.
- Added-line grep for `signAction|createAction|abortAction|listOutputs|getPublicKey|createSignature`: no hits. No new wallet method names. OK.
- No new child-process or network code. `extraTools` is a pass-through only.

## Findings, ranked

### BUGS

**F1 (blocking). Two existing tests fail; the branch is red.**
`test/bsv-module-wallet.test.ts` (owned by T2 per plan section 8, so T1 could not edit it) asserts the old behaviour:
- line ~181-183, test "an unreachable wallet is 'not detected'; ...": expects `not-connected` for a config.json address, now gets `not-configured`.
- line ~198-204, test "walletUrl survives toggling BSV mode": expects the address kept in config and in state; now `undefined` and the toggle rewrites `bsv` without it.
Both are exactly the owner decision "ignore a hand-edited walletUrl", so the code is right and the tests are stale. Why it matters: plan says full suite green at each task end, and T2 would inherit a red tree. Fix: update these two tests in the same merge (either let T1 touch `bsv-module-wallet.test.ts` for just these two tests, or have T2 land them first). The new expected values are in `test/bsv-fix-round.test.ts` of this branch (`not-configured`, `walletUrl === undefined`, `bsv` rewritten as `{enabled, network}`).

**F2 (medium, control gap). Dedupe and seed dedupe keep the FIRST line, so a smaller first amount under-counts.**
- `policy.ts` `ledgerFromAudit`: two `executed` lines for one request id with different sats (`x1`: 1 then 900) give one record of 1 sat. Verified by script.
- `policy.ts` constructor, `unknown` seed: two entries with id `req-dup-0001` (100 then 900) reserve 100 (`this.requests.has(id)` skips the second).
Why it matters: the dedupe exists because the spend path and the engine event both write the line; if the two ever disagree (the engine writes `actualSats`, the card writes the approved total, or a mismatch spend), the cap window under-counts the larger one. The fail-safe direction for a spend cap is the larger value. Fix: when a duplicate id is seen, keep `max(sats)` (ledger) / `max(totalSats)` (seed); add a test with differing amounts.

**F3 (low). Seeded `unknown[].net` is dead data and its test is blind.**
`Record_.network` is set from `u.net` but nothing reads it for an unknown record (`snapshot().unknown` has no net, the cap code ignores it). Mutation: replace `network: u.net === 'main' ? 'main' : 'test'` with `network: 'test'`: `bsv-policy` "net:" test stays **green** (survived mutant). Fix: expose `net` in `snapshot().unknown` (and assert it), or drop the claim from the test title.

**F4 (low). Unrecognised `net` strings load as testnet.**
`ledgerFromAudit`: `fields.net === 'main' ? 'main' : 'test'`, so `"MAIN"`, `"mainnet"`, garbage -> `test`. Fine today (net is not used for any cap), but once mainnet exists a mislabelled line would be counted as testnet. Fix: only a missing `net` is legacy-testnet; an unknown string should be kept as `main` (stricter) or skipped with a warning, and decided before the mainnet task.

**F5 (low). Live ledger pushes carry no `net`.**
`settle(executed)` and `resolveUnknown('sent')` push `{requestId, sats, at, session}` with no `net`; after a restart `ledgerFromAudit` reads net from the audit line, so correctness depends on the later spend task writing `net` on every `executed` / `resolved` line. Note for T2: assert it. Optional: let `settle` take the record's `network` (the engine already stores it).

**F6 (low). Constructor can throw on hostile `unknown` input.**
Mutation-free probes: an entry with a throwing `requestId` getter, or a non-iterable `unknown`, throws out of `new PolicyEngine`. Non-hostile input (null, NaN, negative, string, Infinity, `{}`) is dropped correctly (only 0 survives, intended). Callers are Legion's own restore code, so low; fix with `Array.isArray` plus try/catch per entry. 200 000 seeds take about 1 s and reserve 200 000 sats (no cap on array size; fine because it only blocks).

### POLISH
- P1. `restore()` itself is not in T1. `test/bsv-spend-restore.test.ts` uses a test-local `restoreUnknown()`. The "lenient adds, verified clears" rule is therefore proven for the readers but NOT for product code; T2's `restore()` must re-prove it (plan reviewer item 6). The helper also ignores `net`.
- P2. `index.ts:297` still wraps `state.setWalletUrl` in try/catch with "not saved" logging; `setWalletUrl` can no longer throw. Dead code (T2 owns the file).
- P3. `shared/config.ts:103` still parses `bsv.walletUrl` from disk; harmless (state ignores it) but misleading. A stale address stays in config.json until the owner toggles BSV (toggle rewrites `bsv` without it). Consider saying so in docs (T4).
- P4. `connectedUrl` returns the current `getUrl()`, not the URL validated at Connect. Safe today because `setWalletUrl` is only called from the native-confirmed connect route, which re-runs `probe.connect()`. A future caller of `setWalletUrl` outside that route would silently redirect. Cheap hardening: snapshot the URL inside `connect()`.
- P5. Other places may still say "Legion has no spend tool" (docs, UI `NO_SPEND`, KG seed). Those are T3/T4's; the hedge test passes on this branch.

## Control checks (code read, then mutation: scratch edit, named test, revert)
| control | mutation | result |
|---|---|---|
| (a) unknown seed keeps reservation | drop `'unknown'` from `RESERVING` | **red** (`bsv-policy` "unknown option") |
| (a) blocks all spends | `hasUnknown` compares `'unknownX'` | **red** |
| (a) seed status | seed as `'failed'` | **red** (2 restore tests) |
| (b) dedupe by requestId | remove the `seen` skip | **red** (`bsv-policy` and `bsv-spend-restore`) |
| (b) not across nets | key without `net` | **red** |
| (c) `rep.ok` check in `verifiedEntries` removed | | **red** (1 fail among forged/verified tests) |
| (c) head-anchor check removed | | **red** |
| (c) forged `resolved` in broken file | covered by the previous two; test "forged resolved ... does NOT clear" passes on the real code, and the lenient reader does return the forged line (proves the test is meaningful) | green on code, red on mutants |
| (d) `connectedUrl` needs connected | remove flag check | **red** |
| (d) needs enabled | remove enabled check | **red** |
| (d) loopback | return raw | **red** |
| (e) state ignores walletUrl (config.json) | `this.url = norm.walletUrl` | **red** |
| (e) same for `bsv.json` fallback | same mutation | **red** |
| (f) missing `net` -> testnet | invert default | **red** |
| (f) seed carries `net` | hard-code `'test'` | **GREEN, survived** (F3) |
Every mutation was reverted; `git status` clean after each batch.

## Gap hunt results
- Torn / truncated last audit line (script): `open()` reports "end of the log was cut off", `verifiedEntries()` returns nothing from that file, the lenient reader still shows the `executing` line, so the spend stays unknown (fail closed). After the next append the file is quarantined and the new chain is verified. A genuinely executed spend with a torn `executed` line shows up as unknown for the owner to resolve; the 24 h window loses that spend, but its reservation covers it until resolved.
- Duplicate ids, different amounts: F2.
- `executing` with no terminal line: seeds unknown (test + script). OK.
- Negative / NaN / string / Infinity `totalSats` and `sats`: dropped by `isSats`. OK.
- Huge `unknown` array: no cap, about 1 s for 200k, only adds blocks. Acceptable.
- Prototype-shaped ids (`__proto__`, `constructor`): stored in a `Map` / `Set`, no pollution; the `REQUEST_ID` regex allows them. OK.
- Clock: seed `createdAt/settledAt = now`, `expiresAt = 0`; `sweep()` only expires `pending`, so a seeded unknown never expires or auto-clears. Future-dated audit `ts` only adds to the window. Unparseable `ts` is dropped (could under-count; the lenient reader is the source, existing behaviour).
- Loosening: no change to `approve`, `settle`, `evaluate`; no `allow` verdict added (the seed's stored decision is `deny`). Seed + ledger with the same id double-counts (conservative). Only `resolveUnknown` clears, unchanged.
- `verifiedEntries`: skips files over the per-file size cap or the byte budget, so a clearing line in a huge or old file is not seen: stays unknown (fail closed, may annoy the owner).

## Wording (item 4)
Reworded text is scoped: "Legion's own status tool cannot read ... it is read-only", "Legion's own status tool is read-only: it has no tool to sign...". The unscoped "nothing in Legion can in this version" is gone. `bsv-hedge` passes in the full suite. No banned phrase added.

## Fix list for the builder
1. F1: update the two stale tests (or let T2 do it) so the suite is green.
2. F2: keep the maximum amount for duplicate ids in both places, plus a test.
3. F3: expose and assert `net` on unknown records or drop the claim.
4. Decide F4 before the mainnet task; tell T2 about F5 and P1.
