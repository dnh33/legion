# Testing BSV mode

Companion to [TESTING.md](TESTING.md). It covers how to test Legion's BSV code without any real wallet and without spending anything, what the harness and the test suite do and do not show, and where the not-yet-merged spend work plugs in. What BSV mode is today: [BSV-MODE.md](BSV-MODE.md). The design and the open questions: [BSV-WALLET-DESIGN.md](BSV-WALLET-DESIGN.md). The plan for the spend tool and the mainnet amendment: [claude/plan-bsv-rung3.md](../claude/plan-bsv-rung3.md).

Scope of every claim here: "Legion's own code, in this version, against fakes". Nothing on this page shows how a real BRC-100 wallet behaves, and nothing shows that a person's funds are safe.

## 1. Safety rules (agents and scripts)

1. **Never contact the owner's real wallet.** It listens on a fixed loopback port on the owner's PC (the number is in [BSV-MODE.md](BSV-MODE.md)). No test, script, harness scenario or agent may connect to it, probe it, scan for it or configure Legion to use it. The number is refused in `src/` by the tripwire (`test/bsv-scan.ts`, `bsv-tripwire.test.ts`), and the harness adds its own refusal in `scripts/harness/fake-wallet.mjs` (the one file of the harness that names it): the fake wallet will not bind that port and `assertSafeWalletTarget()` refuses it and any non-loopback host. Do not write the number in new tests, scripts or docs; the harness smoke test fails if a harness file or a `docs/TESTING*.md` names it.
2. **No test touches a real network or a real wallet.** The knowledge mode (`BsvNetwork`) is the literal `testnet`. Legion's own code has a spend tool for testnet and mainnet (mainnet built and OFF by default, see [BSV-MODE.md](BSV-MODE.md)); every test of it runs against a fake wallet on a random loopback port, and none of it has been verified against a real wallet or with real funds until the owner's checks are recorded.
3. **In the cloud and in CI the wallet is the fake.** Two fakes exist: the in-test `fakeWallet(behaviour)` in `test/bsv-wallet-probe.test.ts` (scripted per test, records the wire) and the harness fake `scripts/harness/fake-wallet.mjs` (a long-lived loopback server on a random port, for the stack).
4. **A real wallet only inside a VM, with the owner present,** and only a TESTNET wallet funded with testnet coins (steps V0-V12 in the plan, section 7.2). An agent never drives that session; the owner reads the dialogs and the wallet prompts. The owner's funded host wallet is only ever used by the owner, by hand (plan section 12.6b), and not by this page's procedures.
5. **Keys never live in Legion**; there is nothing to test that creates, stores or logs a key, and a test must never put one in a repo file, a log or a report. Use short prefixes if you must show a secret-shaped value.
6. **Never weaken**: the admin gate, the native-secret flow, taint wrapping, `test/bsv-scan.ts`, `test/bsv-tripwire*.test.ts`, `test/bsv-hedge.test.ts`. If a test of yours needs one of them to change, stop and report.
7. **Wording** in anything you write: "Legion's own code has no tool that ..." not "no one can ..."; no "guarantee", "tamper-proof", "cannot be bypassed", "fully safe" (`test/bsv-hedge.test.ts` lists the banned phrases for the BSV docs).
8. Review BSV safety code with a defensive framing: find gaps in controls; do not write exploit payloads.

## 2. What exists on this base, and what does not

Exists (and is tested): the on/off toggle and the knowledge pack, the Assayer bot, the read-only `bsv_status` tool and its loopback probe of four harmless methods, the pure policy engine (caps, allowlist, arming, freeze), the hash-chained audit log with a head anchor, the policy file fingerprint, the native-secret route guard, Freeze from the bearer token, the T1 restore plumbing (`test/bsv-spend-restore.test.ts`).

Merged since this page was first written (its sections 8.1 to 8.3 below were written before the merge and are kept as the extension points): the spend tool `bsv_spend_request` (T2), the native spend dialogs and panel (T3), per-network policy and the mainnet switch (T5). `GET /api/bsv/policy` reports `spendTools` as a boolean. Their tests are `test/bsv-spend-*.test.ts`, `test/bsv-policy-nets.test.ts`, `test/bsv-mainnet-defaults.test.ts`; the fake wallet is `test/bsv-fake-wallet.ts`. What they cannot show is in [BSV-MODE.md](BSV-MODE.md), "Not verified".

## 3. How the existing code is tested

| Control (what Legion's own code does) | Where | Tests | Harness scenario |
|---|---|---|---|
| Policy changes (arm, unfreeze, caps, allowlist, Connect) need the admin secret AND the native secret | `bsv/index.ts` `requireNative`, `admin.ts` | `bsv-module-wallet`, `bsv-electron-emu`, `bsv-electron-logic` | `bsv-readonly`, `mcp-token-limits`, `bsv-policy-tamper` |
| The bearer token can Freeze and nothing else in BSV | `admin.ts` client list | `bsv-module-wallet`, `bsv-fix-round`, `bsv-electron-logic` | `mcp-token-limits`, `bsv-readonly` |
| Wallet address must be loopback `http` with nothing else in it; no default address; nothing is contacted until Connect | `bsv/wallet-probe.ts` `parseWalletUrl`, `bsv/state.ts` | `bsv-wallet-probe` (url rule, SSRF), `bsv-fix-round` (item 4) | `bsv-readonly` |
| The probe sends exactly `getVersion`, `getNetwork`, `isAuthenticated`, `getHeight`, as POST with `{}` | `wallet-probe.ts` `PROBE_METHODS` | `bsv-wallet-probe` (wire assertions with a forbidden-method list) | `bsv-readonly` asserts the wire at the fake wallet and `offAllowlist` stays empty |
| A "changed" network report can only make Legion more careful; mainnet claim gives a warning and nothing else | `wallet-probe.ts`, `bsv/index.ts` | `bsv-wallet-probe`, `bsv-fix-round` (5) | not yet: set `h.walletState({network:'main'})` and read `GET /api/bsv/wallet` (extension point) |
| `bsv_status` result is untrusted-wrapped and taints the run; it needs an approval card (not a Legion-trusted tool name) | `wallet-tool.ts`, `engine.ts` | `bsv-module-wallet` ("the answer is wrapped as untrusted data ... taints the run") | `bsv-readonly` |
| Hand-edited `bsv.walletUrl` in `config.json` is not used until Connect | `bsv/state.ts` | `bsv-config`, `bsv-fix-round` (4) | `bsv-readonly` (restart with a hand-edited URL: not connected, zero wallet requests) |
| Policy file fingerprint: an edited, removed or unreadable file freezes the chain; the edited file is kept as evidence | `bsv/index.ts` `checkPolicyFile`, `policy-store.ts` | `bsv-fix-round` (1) | `bsv-policy-tamper` |
| Audit log: append-only, hash chain, head anchor, recovery, time-ordered 24 h window | `bsv/audit.ts` | `bsv-audit`, `bsv-fix-round` (3), `bsv-spend-restore` | `bsv-policy-tamper` reads the log through `/api/bsv/audit` |
| Policy engine verdicts (caps incl. pending, allowlist, max outputs, fee ceiling, arming expiry, freeze, unknown outcome) | `policy.ts` | `bsv-policy` | none (pure; not connected to any tool) |
| The Assayer is hidden everywhere while BSV is off | `engine.ts`, `comms/`, `server.ts` | `bsv-review-hidden`, `bsv-final-agents`, `bsv-final-comms` | none yet |
| No wallet names, wallet port, `@bsv/*`, `fetch`, process spawning or wallet-shaped tool names outside the allowlist | static scan of `src/` and `ui/src` | `bsv-tripwire`, `bsv-review-tripwire` (planted cases), scanner `bsv-scan.ts` | none (static) |
| No guarantee-style wording in the panel, dialogs, agent text and BSV docs | text scan | `bsv-hedge` | none (static) |
| Pack content honesty (design lessons marked, no unhedged claims of controls that do not exist) | `kg/seeds/bsv.json` | `bsv-pack`, `bsv-review-pack`, `bsv-review-seed`, `kg-bsv-seed` | none |
| Electron main parses and words the native dialogs, passes the native secret only after Confirm | `electron/main.ts`, `admin-logic.ts` | `bsv-electron-logic`, `bsv-electron-emu` (stubbed electron; POSIX) | emulated only by sending the native header (`--auth native`) |

What the harness gives that the in-process tests do not: the same controls through a **separate core process that received both secrets over stdin**, with an HTTP client that cannot reach into memory.

## 4. Procedure: BSV read-only end to end, in the cloud

```bash
npm run build:ts
npm run --silent harness -- scenarios bsv-readonly bsv-policy-tamper mcp-token-limits
```

By hand, with a long-lived stack (`H="node scripts/harness/legion-harness.mjs"`):

```bash
$H start                                        # prints the handle; fakes are on loopback random ports
$H call POST /api/bsv '{"enabled":true}'        # as the app window (admin)
$H status                                       # note fakes: wallet url
$H call POST /api/bsv/wallet/connect '{"url":"<wallet url from status>"}'              # admin only -> 403 native_confirmation_required
$H call POST /api/bsv/wallet/connect '{"url":"<wallet url from status>"}' --auth native # what Electron main sends after its dialog -> connected
$H call GET /api/bsv/wallet
$H call POST /api/bsv/policy/freeze '{"reason":"try"}' --auth token                    # the token class can freeze
$H call POST /api/bsv/policy/arm '{"minutes":5}' --auth native                         # 409: frozen
$H stop
```

The `--auth native` class stands in for "Electron main after the owner pressed Confirm". It proves the core demands the native secret and acts on it; it does **not** prove that the dialog exists, is worded correctly, defaults to Cancel, or that a compromised window cannot reach it (that is `electron/main.ts` and `admin-logic.ts`, tested through the stub in `bsv-electron-*`, and finally only a human on a real desktop can check).

Reading the fake wallet's log: `h.wallet()` (in a scenario) returns `{seen, offAllowlist, state}`. `seen[i]` is `{httpMethod, method, body, origin}`. A scenario that cares about "nothing else reached the wallet" asserts `offAllowlist` is empty and `seen.map(s => s.method)` is exactly the expected list.

Changing what the fake wallet claims: `h.walletState({network: 'main' | 'testnet' | 'weird', authenticated: false, version: '1.2.3', height: 9})`; `h.walletClear()` resets its log.

## 5. The mutation method for BSV controls

Every new BSV test needs a negative (see [TESTING.md](TESTING.md) section 8). BSV-specific advice:

- Mutate the **product** line that implements the control, in `src/core/bsv/` or `src/core/admin.ts`, with one literal replace whose anchor occurs exactly once. Keep the mutation tiny: `if (false) throw ...`, `return;` at the top of a check, widening a regexp or list.
- Rebuild (`npm run build:ts`; note that `tsc` may report an error for an unused value yet still emit, so check the exit and the output), run the single scenario or test, expect red with your message, `git checkout -- <file>`, rebuild, expect green.
- Mutants run on this base: removing the native-secret comparison turned `bsv-readonly` red ("admin alone cannot connect"); ignoring the policy-file fingerprint turned `bsv-policy-tamper` red ("the next policy read freezes the chain"); letting the bearer token answer approvals turned `approval-card-flow`, `rooms-bot-room-request` and `mcp-token-limits` red. The recorded outputs are in [TESTING.md](TESTING.md), section 12.
- The plan for the spend tool adds an automated mutant harness (`test/bsv-spend-mutants.test.ts`, plan section 4): it copies `dist/src/core`, applies one literal replace to one compiled file, and expects the named scenario to fail. The harness scenarios below use the same idea by hand.

## 6. Owner-only verification

Nothing on this list can be done by an agent or a cloud session.

- **V0-V12**, testnet wallet in a VM, owner present: [claude/plan-bsv-rung3.md](../claude/plan-bsv-rung3.md) section 7.2. V1 and V2 are a gate before the spend tool is built (read-only experiments with a throwaway testnet wallet and no Legion code). V3 to V12 are the end-to-end observations (connect, `bsv_status`, allowlist, a 600 sat request with two dialogs and the wallet's own prompt, a second request prompting again, Cancel, wallet Deny, killing the wallet mid-prompt, caps and allowlist denials before any dialog, freeze while a dialog is open, hand-edited `walletUrl`). Results go into [claude/tracker-pc-checks.md](../claude/tracker-pc-checks.md).
- **R0-R11**, mainnet real-funds steps, owner by hand, tiny amounts, separate from V0-V12: plan section 12.6b. Until they are recorded, every document says "has not been verified with real funds".
- **Unverified facts** the status probe already depends on (list in [BSV-MODE.md](BSV-MODE.md), "Not verified"): whether BSV Desktop answers the four status methods without a prompt, the real response shapes, the origin rules, the wallet's prompt wording.
- The real Electron dialogs on a real desktop (wording, default button, focus).

## 7. Scenario backlog for what exists today (not yet written)

Cheap additions with the current harness: `bsv-wallet-network-claims` (wallet claims `main`, then `unknown`, then `testnet`: warning only, never raises a limit, a "changed" report disarms), `bsv-hidden-assayer` (BSV off: the Assayer is absent from `/api/state`, task start 404, `legion_run` refuses), `bsv-audit-verify` (read `/api/bsv/audit`, assert chain status after a restart with a truncated log file via `h.homeFile('write', ...)`).

## 8. Extension points (written before the spend work merged)

The spend tool T2, the native dialogs T3 and mainnet T5 are merged on `integration/v1`. The harness scenarios below may still be pending; do not describe a scenario as passing until it runs on the branch you test. The extension points are fixed here so the harness work and the product work meet.

### 8.1 PENDING: spend tool (T2), `bsv_spend_request`

Plan: [claude/plan-bsv-rung3.md](../claude/plan-bsv-rung3.md) sections 2-4 and 7.

Fake wallet methods to add in `scripts/harness/fake-wallet.mjs` (the plan's `test/bsv-fake-wallet.ts` is the in-process twin; keep their behaviours aligned; both assume the BRC-100 JSON shapes listed there as unverified items U1-U8):

- `createAction` (with `options.signAndProcess:false`): returns a signable object with a `reference`; records the request; never broadcasts.
- `signAction`: returns `txid` and `tx`; scripted behaviours as flags on `h.walletState`: `signDelay`, `signFails`, `closeMidAnswer`, `answerAfterFreeze`, `signDifferentTx` (changed amount or recipient after sign), `extraOutput` / `twoExtras` / `dataOutput`, `feeAbove`, `missingParent`, `badTxid`.
- `abortAction`: records the reference; flag `abortFails`.
- Keep `offAllowlist` meaningful: after the spend methods land, the allowlist for the status probe stays the four methods; spend methods may only be seen inside spend scenarios, and a status-only scenario must still assert `offAllowlist` is empty. Add a `phase` field to `seen` entries rather than relaxing the check.
- Network flags (plan 12.6a): `network: 'test' | 'main' | 'unknown'`, `flip: {after: 'probe#n' | 'createAction' | 'signAction', to}`, `prompt: 'always' | 'never'` (the harness cannot see a wallet prompt; this flag only proves Legion's own gates still hold).
- Test keys are fixed constants; the fake never validates a signature.

Scenario names to add in `scenarios.mjs` (each with proves / doesNotProve, run against the stack with `--auth native` standing in for Electron main's role):

- `bsv-spend-happy-testnet`: allowlist one address (native), the Assayer requests 600 sat, the card appears via `GET /api/bsv/spend/pending`, `POST /api/bsv/spend/:id/decision` with `cardHash` and confirmations (native), the fake wallet saw `createAction` then `signAction`, the tool result is untrusted-wrapped and carries a `txid`, audit has `proposed`, `executing`, `executed` in order.
- `bsv-spend-denied-before-wallet`: 1,001 sat, a non-allowlisted address, frozen chain, MCP-started run, bridge-woken run, second concurrent request, fourth request: all denied with zero `createAction` at the fake wallet.
- `bsv-spend-token-class`: the bearer token and admin-without-native get 403 on `decision` and `resolve`; only freeze is open to the token.
- `bsv-spend-unknown-outcome`: the fake closes the socket mid-answer; the status is `unknown`, spends are blocked, the block survives `h.restartCore()`, and only a `resolve` with native clears it.
- `bsv-spend-freeze-midflight`: freeze while a card is pending, and during sign.
- `bsv-spend-tainted-run`: a run that used `WebFetch` first needs the extra confirmation (`untrusted-content`).
- `bsv-spend-idempotent`: the same `requestKey` twice makes exactly one `createAction` and one `signAction`.
- `bsv-spend-wallet-text-isolation`: instruction text in every string field of the wallet's answers never reaches the tool result, card or audit.

What these will NOT prove (write this into each scenario): the real wallet's prompt, the native dialog, real transaction encodings (U2/U7/U8), what the real wallet returns on Deny (U6). Those are V1-V12.

Also to update when T2 merges: the table in section 3 (add rows for each spend control C1-C24 with its test and mutant), the "spendTools" statement in section 2, and `docs/BSV-MODE.md`'s "What it does NOT do".

### 8.2 PENDING: native dialogs (T3)

Today: `test/electron-emu/` runs the compiled `main.js` with `electron` stubbed and records the options `dialog.showMessageBox` receives; scenarios `bsv` and `hygiene` exist in `test/electron-emu/run.mjs`. When T3 lands, add emu scenarios for the spend cards: Cancel default and Escape, dialog 1 then dialog 2 for untrusted content (separate button press), card read by main from the core (not from the window), full address shown, network word shown, the resolve dialog ("NOT sent" / "WAS sent" / Cancel), and main polling `GET /api/bsv/spend/pending`. In the harness, the only emulation is the header class `--auth native`; add nothing that pretends to be a dialog. The pure formatting lives in `src/electron/admin-logic.ts` (test: `bsv-electron-logic`). Human-only: how the dialogs look and read on a real desktop (plan V5, U10).

### 8.3 PENDING: mainnet (T5)

Plan section 12. Extension points: the harness stack's config (`h.restartCore({bsv: {...}})` applies a config patch and rotates the secrets, like a tray restart) for per-network settings; fake wallet `network: 'main'` and the `flip` flag; address fixtures for both version bytes (plan: `test/fixtures/addresses.ts`, fixed constants, no keys); scenarios to add: `bsv-mainnet-default-off` (switch off, denied `mainnet-disabled`, zero wallet prompt calls), `bsv-mainnet-enable-arm-one-spend` (enable and arm need native; one arm allows one spend; auto-off after an unknown), `bsv-mainnet-flip` (testnet wallet flips to main between card and approve: zero `signAction`), `bsv-mainnet-injection` (text asking to "enable mainnet" or "arm" changes nothing). The R0-R11 real-funds table stays owner-only and is never scripted by an agent. Until R0-R11 are recorded, say "has not been verified with real funds".
