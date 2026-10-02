# Plan: BSV rung 3, manual testnet spend (`bsv_spend_request`)

Status: PLAN ONLY, 2026-10-02, branch `integration/v1`. Nothing here is built. Source of truth for owner decisions: `docs/BSV-WALLET-DESIGN.md` section 12 and `claude/legion-release-tracker.md` (decisions approved 2026-10-02, not to be re-asked). Everything the wallet is claimed to do is UNVERIFIED (tag `U#`, confirmed only by the VM steps in section 7). Defensive framing: this lists gaps in controls and how each is closed or accepted, not ways to defeat them.

## 1. Goal and non-goals

1. Goal: the owner can run testnet exercises end to end: the Assayer proposes ONE testnet payment, the owner reads a native dialog (amount, recipient, network, fee), then the wallet's own prompt decides.
2. Exactly one new source file, `src/core/bsv/spend.ts`, one new agent tool, `bsv_spend_request`; everything else is plumbing, tests and docs.
3. Non-goals: mainnet (refused at the tool boundary, no input can select it), autonomous or scheduled spends, standing grants, paymail or pubkey recipients, multiple payment outputs, balance or output reads (rung 2 skipped), keys of any kind in Legion.
4. Legion never approves a wallet prompt, never retries a signing call, never re-sends after an unknown outcome, never stores signed bytes (only the txid).
5. Tests and scripts NEVER touch the real wallet at `127.0.0.1:3321`; cloud tests use a fake BRC-100 server on a random loopback port.
6. Stop condition (design section 10): if VM step V1 or V2 fails, no spend path ships; report to the owner instead of improvising.

## 2. Module, surface and wiring

### 2.1 The one new module: `src/core/bsv/spend.ts`
Public surface (exports, all in this file): `createSpendService(deps): SpendService`, `SPEND_METHODS` (`createAction`, `signAction`, `abortAction`, a const tuple, the only wallet names in the file), `decodeSignable(bytes): Decoded | null`, `p2pkhScript(address): Uint8Array | null` (base58check, SHA-256 only, testnet version byte), `SPEND_REASON_CODES`.
`SpendService` methods: `buildTool(agent, job): SdkMcpTool` (registered inside the existing `legion_bsv` server), `pending(): CardView[]`, `decide(id, {decision, cardHash, confirmations})`, `resolve(id, 'sent'|'not-sent')`, `restore(auditEntries)`, `onFreeze()`.
Dependencies are injected (policy, probe, audit, state, `transport`, clock): `spend.ts` imports NO node network module and no `fetch`. It reaches the wallet only through the exported `Transport` type and the module's injected transport (default `httpTransport` from `wallet-probe.ts`), with the path built from `SPEND_METHODS` and the URL from `probe.connectedUrl` (new getter, T1).

### 2.2 Tool contract
- Name `bsv_spend_request` on server `legion_bsv`, Assayer only (`requires:'bsv'`), BSV mode on. Not a Legion-trusted tool name, so in `ask` mode the ordinary tool card still appears (kept, as for `bsv_status`); in `full` mode no card appears, so the native dialog is the only gate there (test for it, C9).
- Input (zod): `requestKey` string 8-64 `[A-Za-z0-9_-]` (idempotency), `recipient` string 26-35 base58, `sats` integer 1..1,000,000 (policy caps decide), `purpose` string 1-200. The handler also checks the RAW argument keys against these four and denies any extra key (a `network` field has no effect and is denied `extra-input`). Network is never an input.
- Legion mints `requestId` = first 40 hex of sha256(`taskId` + LF + `requestKey`). The same key returns the stored status and makes NO new wallet call (replaces blind retry). A different payload under a used key is denied `key-reused`.
- The handler waits at most 100 s for a terminal state, then returns `pending-owner` or `pending-wallet`; re-calling with the same key returns the current state. The flow itself is owned by the service, not by the tool promise, so a cancelled run, a slow SDK or a short tool timeout cannot orphan it (U9, test C14).
- Returns `<bsv-spend-result untrusted="true">{json}</bsv-spend-result>` plus one fixed sentence. JSON: `{requestId, network:'testnet', status, reasonCodes?, totalSats?, txid?}`. `status` is one of `denied`, `pending-owner`, `pending-wallet`, `declined`, `expired`, `failed`, `unknown`, `executed`. `reasonCodes` come from the fixed list `SPEND_REASON_CODES` (`bsv-off`, `not-assayer`, `not-human-run`, `frozen`, `busy`, `too-many-requests`, `rate-limited`, `extra-input`, `bad-recipient`, `not-allowlisted`, `not-connected`, `wallet-not-testnet`, `wallet-unreachable`, `build-failed`, `undecodable`, `unexpected-outputs`, `over-cap`, `fee-too-high`, `unknown-outcome-pending`, `audit-unavailable`, `key-reused`). No wallet text, script, reference, card hash or engine reason string ever reaches the agent. `txid` only if `/^[0-9a-f]{64}$/`.

### 2.3 Plumbing around it (existing files, owners in section 8)
- `policy.ts`: constructor option `unknown: {requestId, agentId, totalSats}[]` creates `unknown` records that keep their reservation; `ledgerFromAudit` dedupes by `requestId`. `approve/settle/evaluate` are NOT loosened (engine reused as is).
- `audit.ts`: `AuditLog.verifiedEntries(filter)` (entries only from files whose chain verifies). `append` is already synchronous and throws on I/O failure; the spend path calls it directly (no `note()`, which swallows).
- `wallet-probe.ts`: getter `connectedUrl` (the URL only while `connected`), nothing else changes; the probe's four-method list is untouched.
- `state.ts`: `walletUrl` is no longer read from `config.json` at load (only `Connect` sets it, in memory); the owner decision "ignore a hand-edited `bsv.walletUrl`". The panel loses the prefill; the owner types the address.
- `wallet-tool.ts`: `buildBsvStatusServer` accepts `extraTools`; its description and render line are reworded (section 10).
- `index.ts`: builds the service, adds routes, composes `mcpServers`, runs `restore()` at start, flips `spendTools` to a boolean.
- Routes (contract frozen for T3): `GET /api/bsv/spend/pending` (admin) returns cards and unknown items; `POST /api/bsv/spend/:id/decision` (admin + native secret) body `{decision:'approve', cardHash, confirmations}` or `{decision:'deny'}`; `POST /api/bsv/spend/:id/resolve` (admin + native secret) body `{outcome:'sent'|'not-sent'}`. None is on the MCP client list in `admin.ts` (default deny: the bearer token reaches none of them; Freeze stays the one open route).

### 2.4 Policy engine use (no new verdicts)
`policy.evaluate({requestId, network:'test', walletNetwork, agentId, taskId, reason:purpose, tainted: job.taint(), decoded})` where `decoded` comes ONLY from `decodeSignable` of the wallet-built unsigned transaction (never from agent fields). Required confirmations are the engine's (`approve`, plus `untrusted-content` when tainted). The card shown is the engine's `ApprovalCard` (hash-bound). `approve()` is called only from `decide()`.

## 3. State machine of one spend

Order (changed from the design doc, forced by the fee: the engine needs `inputSats` and `feeSats`, so the wallet builds an UNSIGNED transaction first; Legion decodes it; policy evaluates; the owner confirms; only then does the wallet sign):
`gates -> proposed(audit) -> fresh probe -> createAction(signAndProcess false) -> decode -> evaluate/reserve -> card -> native dialog(s) -> decision(re-checks) -> executing(audit) -> signAction -> verify -> executed(audit) -> settle`.
Unverified wallet behaviour used: U1 `createAction` with `options.signAndProcess:false` returns a signable transaction (`tx`, `reference`) and does not broadcast; U2 the `tx` encoding (BEEF, possibly atomic BEEF; bytes, hex or base64); U3 `abortAction(reference)` releases the wallet's locked inputs; U4 `signAction` shows the wallet's own prompt every time and nothing grants `legion.local` a standing permission; U5 the signed result carries `txid` and `tx`; U6 how the wallet reports a user decline (default: treated as `unknown`); U7 the wallet's change is one standard P2PKH output; U8 the testnet network string and address version byte; U9 a short MCP tool timeout (mitigated, 2.2); U10 Electron dialogs on a real desktop. Each is confirmed or refuted in section 7.

| # | Step | Failure edge | What fails closed | Audit (strict = may throw) |
|---|---|---|---|---|
| G | Gates: BSV on, agent is the gated one, `job.origin` undefined (bridge, room and MCP runs refused), chain not frozen, no unknown outcome, no request in flight (single flight), at most 3 requests per task, 5 proposals per 10 min, raw arg keys, base58check testnet address | any gate false | return `denied` + code; no wallet contact, no reservation | `denied` (best effort) |
| P | Write `proposed` (requestId, taskId, sats, purpose hash) | append throws | `denied audit-unavailable`; zero wallet calls | `proposed` STRICT, first thing after G |
| 1 | Fresh probe (`probe.check({fresh:true})`): connected, reachable, authenticated, network `test` | main, unknown, unreachable, not connected | `denied wallet-*`; zero `createAction` on the wire | `denied` |
| 2 | `createAction` unsigned: one output (recipient script, `sats`), `signAndProcess:false`; body and response capped (256 KiB), 30 s | timeout, refused, HTTP error, garbage, oversize, no `reference` | `failed build-failed`; best-effort `abortAction` if a reference was seen; no reservation yet | `failed` |
| 3 | `decodeSignable`: bounded BEEF parse, input values from parent transactions, outputs list, fee = inputs - outputs | any parse error, missing parent, more than 100 inputs/outputs, over 256 KiB, a zero-sat output | `abortAction`; `denied undecodable` | `denied` |
| 4 | Output check: exactly one output whose script equals P2PKH of the requested address and whose sats equal the request; at most ONE other output (labelled `change`, standard P2PKH, address shown); anything else (second payment, data output, non-P2PKH extra, two extras) | extra or altered output | `abortAction`; `denied unexpected-outputs` | `denied` |
| 5 | `policy.evaluate` (check and reserve, synchronous): allowlist (empty = deny), caps 1,000/5,000/10,000 including reservations, fee ceiling, unknown-outcome block, wallet network, conservation | engine `deny` | `abortAction`; `denied` with mapped codes | engine event (best effort) + `denied` |
| 6 | Card pending in the core (120 s TTL). Main polls `/api/bsv/spend/pending` and reads the card from the core itself | main not running, window hidden, no poll | card `expired` at 120 s (engine sweep), reservation freed, `abortAction`, status `expired` | `expired` |
| 7 | Native dialog 1 (card) then, if the card requires `untrusted-content`, dialog 2 (separate button press). Cancel default and escape | Cancel, closed, a second card meanwhile | `deny` (dialog-free route), reservation freed, `abortAction`, status `declined`; a late Approve after expiry is refused by the core | `declined` |
| 8 | `decide(approve)`: native secret, id exists and pending, `cardHash` equals engine hash, confirmations complete, fresh probe still `test`, `job.taint()` re-read (a card made while clean is voided if the run became tainted), not frozen, no unknown | any re-check fails | `denied`/`declined`, `abortAction`; `policy.approve` is not called | `declined` + code |
| 9 | `policy.approve` then write `executing` (requestId, totalSats, agent) | append throws | `policy.settle(failed)` (nothing was sent), `abortAction`, status `failed audit-unavailable`; ZERO `signAction` | `executing` STRICT, before the sign call |
| 10 | `signAction(reference)` with deadline = 300 s from approval (the engine's `EXEC_TTL_MS`), response cap 256 KiB. The wallet shows its own prompt here (U4) | connection refused before any byte sent | `failed` (nothing reached the wallet) | `failed` |
| 10b | same call | timeout, reset mid-answer, any HTTP error or garbage, structured error (U6), freeze during the call, restart | `unknown` (a wallet may have signed before answering); no retry; all spends blocked until the owner resolves | `unknown` (evidence line) |
| 11 | Verify answer: `txid` hex64; returned `tx` decoded, payment script and sats equal the approved card, other output (if any) equal the previewed one | txid missing, tx absent or not parseable | `unknown` (txid recorded as evidence if valid) | `unknown` |
| 11b | same | outputs differ from the card (a different transaction was signed) | `policy.settle(executed, actualSats)` so the engine freezes on mismatch; owner sees it | `executed` + `mismatch` |
| 12 | Write `executed` (requestId, sats, txid) THEN `policy.settle(executed)` | append throws after a txid exists | `chain frozen`, `policy.settle(unknown)`, best-effort `audit-failed` evidence; tool returns `unknown` | `executed` STRICT |
| 13 | Late answer: the wallet answers after freeze, expiry or unknown | `settle` refuses a non-`approved` request | the answer is written as `late-answer` evidence (valid txid only) and shown to the owner; status is NEVER auto-changed | `late-answer` |
| 14 | Unknown: owner uses the native Resolve dialog ("check your wallet history": Cancel / it was NOT sent / it WAS sent; sats come from the card main read, never typed) | Cancel | stays `unknown`, all spends blocked | `resolved` after a confirmed choice |
| 15 | Restart | `executing` entry with no `executed`, `failed` or `resolved` for that id | `restore()` seeds `unknown` (reservation kept) and freezes; only a `resolved` entry inside a VERIFIED chain clears it; the lenient reader may only add blocks | `restored-unknown` |
| 16 | Freeze at any point | n/a | pending -> denied + `abortAction`; approved -> `unknown`; probe disconnects (existing) | engine `frozen` event |

## 4. Controls: where enforced, proving test, mutant

Mutants (automated): `test/bsv-spend-mutants.test.ts` copies `dist/src/core` to a temp tree, applies one literal replace to one compiled file (anchor must occur exactly once, so a refactor that moves it fails the test instead of silently dropping the mutant), imports the copy, runs the named scenario from `test/bsv-spend-scenarios.ts` and requires that it FAILS. Production code carries no test hook. Scenario names below are the `test/bsv-spend-*.test.ts` files.

| ID | Control | Enforced in | Proving test (positive) | Mutant that must turn it red |
|---|---|---|---|---|
| C1 | Testnet only: no network input; wallet network `test` at propose and at approve; a `main` request is refused at the tool boundary | `spend.ts` G/1/8 | flow: wallet says mainnet, then unknown, then flips to main between card and approve: zero `signAction`; `network` key in args denied | drop the step-8 probe re-check |
| C2 | Gates (Assayer, BSV on, no origin, single flight, 3 per task, 5 per 10 min) | `spend.ts` G | flow: MCP-started run, bridge-woken run, room run, second concurrent request, fourth request: all denied, zero wallet calls | remove the `job.origin` test |
| C3 | Recipient exactness: testnet P2PKH only, allowlist exact (empty = deny), script compare | `spend.ts` 4, `policy.ts` | decoder: homoglyph, trailing space, wrong version byte, bad checksum, mainnet address, paymail, 2^53 sats; allowlist empty by default | compare by string prefix instead of script |
| C4 | Caps and reservations on REAL decoded values | `policy.evaluate` via 5 | flow: 1,000 ok, 1,001 denied, 5,000/10,000 cumulative, 100 parallel proposals fit the cap once, fee over ceiling | hand `evaluate` the agent's `sats` instead of the decoded total |
| C5 | Decoder fails closed and is bounded | `decodeSignable` | decoder: 300 fuzz cases (truncation, varint overflow, parent missing, cycle, duplicate parent, oversize, 101 outputs, zero-sat output, negative-looking values): `null`, no throw, time-bounded | treat missing parent value as 0 |
| C6 | Change handling: at most one non-payment output, standard P2PKH, shown with address and labelled "wallet-claimed, Legion cannot verify" | `spend.ts` 4, dialog text | flow: two extras, one data output, one non-P2PKH extra: denied; one P2PKH extra accepted and visible in the card | allow any number of extras |
| C7 | Audit BEFORE sign, fail closed | `spend.ts` P and 9 (direct `audit.append`) | audit: make `append` throw at `proposed`, then at `executing`: fake wallet records zero `createAction`, zero `signAction` | route the write through the swallowing `note()` |
| C8 | Audit AFTER, fail closed | `spend.ts` 12 | audit: throw at `executed`: chain frozen, request `unknown`, spends blocked | ignore the throw |
| C9 | Native confirmation: card read by main from the core, Cancel default, hash from main's read, network `test` only, second dialog for untrusted content, `full` mode still blocks | `main.ts`, `admin-logic.ts`, route `decision` | native + emu: Cancel, escape, closed window, forged card from the window ignored, foreign frame refused, `full`-mode agent still waits for the dialog | main sends the window's `cardHash` |
| C10 | Decision re-checks (hash, freeze, expiry, taint, network, unknown) | `spend.ts` 8 and `policy.approve` | flow: approve at the tick of expiry, at freeze, with a stale hash, after taint appeared | skip taint re-read |
| C11 | Execution window 300 s | `spend.ts` 10 (deadline to the transport) | flow with a fake clock: wallet silent past 300 s gives `unknown`, never `failed` | map timeout to `failed` |
| C12 | Unknown outcome blocks everything, survives restart, cleared only by owner resolution | `policy.ts` seed, `audit.verifiedEntries`, `restore()` | audit: kill mid-sign (fake wallet closes socket), restart a new module on the same dir: spends denied `unknown-outcome-pending`; forged `resolved` line in a broken-chain file does not clear; native Resolve clears | read `resolved` from the lenient reader |
| C13 | Late answers are evidence, never state changes | `spend.ts` 13 | flow: answer after freeze: evidence line, status stays `unknown` | call `settle` on late answer |
| C14 | No automatic retry; same key = stored status | `spend.ts` service map | flow: same key twice, tool call cancelled mid-flight, SDK re-call: exactly one `createAction` and one `signAction` | drop the key lookup |
| C15 | Post-sign verification | `spend.ts` 11 | flow: wallet signs a different amount or recipient: chain frozen, mismatch audit | skip the output compare |
| C16 | Freeze semantics | `spend.ts onFreeze`, engine | flow: freeze during pending, during dialog, during sign: aborted / denied / unknown | do not call `abortAction` |
| C17 | Wallet text isolation | `spend.ts` parsers, tool renderer | injection: wallet answers with instruction text in every string field and error body: nothing appears in the tool result, card, dialog or audit | echo the wallet's `message` |
| C18 | Taint and hop | `job.taint()`, `job.origin` | injection and flow (section 6) | take `tainted` from the input |
| C19 | Hand-edited `walletUrl` ignored | `state.ts`, `probe.connectedUrl` | config: edit `config.json` to a loopback fake, start core: zero requests until Connect | read `walletUrl` in the constructor again |
| C20 | No keys, no signed bytes stored, no new dependency | tripwire, `package.json` check | tripwire test (unchanged regex) plus audit scan of a full run for the signed bytes | persist `tx` |
| C21 | Wallet vocabulary closed | `SPEND_METHODS`, point-of-use check, scanner | tripwire (section 5) | add a fourth method name |
| C22 | Allowlist, caps and limits survive restart | `policy-store.ts`, `ledgerFromAudit` | audit: executed lines rebuild the 24 h window; duplicate lines count once | remove the dedupe |
| C23 | Only owner paths change money state | routes + `admin.ts` | module: MCP bearer token and admin-only calls get 403 on `decision` and `resolve`; no native secret = 403 | drop `requireNative` on `decision` |
| C24 | Tests and scripts never reach port 3321 | `test/bsv-port-guard.test.ts`, `fakeTransport` | guard test (section 7) | plant the port literal in `test/` |

## 5. Tripwire change (`test/bsv-scan.ts`)

Principle: the allowance is for ONE path whose content hash is pinned, grants three method names and one tool name, and every other rule in the BSV area keeps applying to that file.
Touch points (each is a place the scan currently says "never" or "probe only"):
1. `FORBIDDEN` matches `createaction` everywhere, comments included: remove it from the global regex; check it per file (`forbiddenFor(file)`), exempting only the pinned spend file.
2. `WALLET_METHODS_FORBIDDEN` lists `signAction` and `abortAction`: same per-file carve-out for those two names only (`listOutputs`, `getPublicKey`, `internalizeAction`, `createSignature` and the rest stay forbidden in the spend file).
3. The quoted `METHOD_SHAPED` check knows only "probe file" and "everywhere else": make the permitted set per file: probe = the four, spend file = exactly `createAction`, `signAction`, `abortAction` (it may not name the probe's four; it gets the network from `probe`), all others = none.
4. `HIDDEN_IDENT_OK` (empty today) gets exactly `src/core/bsv/spend.ts#createAction` and `src/core/bsv/spend.ts#signAction`. Rule for the author: no other quoted identifier-shaped token starting with `sign`, `spend`, `broadcast` or `inscribe` in the file (use hyphenated audit words).
5. `ALLOWED_WALLETY_TOOLS` becomes `{bsv_status: wallet-tool.ts, bsv_spend_request: spend.ts}`; `test/bsv-review-tripwire.test.ts` line 188 (a deep-equal against the single entry) is updated to the two-entry map in the same commit.
6. New importer rule: `httpTransport` may be named only in `wallet-probe.ts`, `index.ts` and `spend.ts` (today nothing scans who uses the exported transport).
7. `ROOTS` is `src` and `ui/src`; add a separate port-literal check over `test/` and `scripts/` (section 7).
Pin: `SPEND_PIN = {file:'src/core/bsv/spend.ts', sha256:'<64 hex>'}` in `bsv-scan.ts`, hash over the file content with CRLF normalised to LF (and `.gitattributes` `src/core/bsv/spend.ts text eol=lf`). `scanTree(root, allow, opts?: {spendPin?: string})` takes an injectable pin so tests can prove the RULES reject a planted file even when its hash is pinned. If the file's hash differs from the pin, the scan reports `spend.ts differs from the reviewed pin; re-review and update SPEND_PIN` and grants NONE of the exemptions (so the same edit also fails rules 1-5). A pin update must come with the reviewer's sign-off in the PR; the helper `scripts/bsv-spend-pin.mjs` only prints the hash (no network).
Negative tests (`test/bsv-spend-tripwire.test.ts`, planted in a temp copy like `bsv-review-tripwire.test.ts`):
- flip one byte of `spend.ts`: pin violation plus the three names report;
- `createAction` / `signAction` / `abortAction` in any other file (comment, string, split `'sign'+'Action'`, template): reported;
- a second file under `src/core/bsv/` naming `createAction`: reported;
- with the pin injected to match, spend file plus `listOutputs`, `getPublicKey`, `internalizeAction`, `getVersion` or `3321`: reported;
- spend file plus `fetch`, `node:http`, `node:net`, `child_process`, `eval`, `globalThis[...]`, a non-ASCII look-alike, a computed call `x[k]()`: reported;
- spend file registering a second tool (`tool('bsv_send', ...)`), a computed tool name, or `bsv_spend_request` registered in another file: reported;
- `'main'`/`mainnet` as a literal in the spend file: reported (new rule, the existing check covers `mainnet` only);
- any other file importing `httpTransport`: reported;
- dead-allowance check: pin or tool entry present while `spend.ts` is missing: fails (same spirit as the existing dead-entry loop);
- `SPEND_METHODS` in `bsv-scan.ts` deep-equals the exact three names (cannot be widened silently);
- `package.json` regex test stays untouched and green (no bsv, bitcoin, wallet or secp256k1 dependency).
Hedge honesty (`test/bsv-hedge.test.ts`, T4): rule 2 (`NEG`+`VERB` needs `SCOPE`) stays; new sentences must read like "Legion's own code has one tool that asks a wallet to build and sign a TESTNET transaction; every call needs your confirmation and the wallet's own prompt follows". The check also scans `spend.ts` strings automatically (it reads `src/core/bsv/*.ts`). Add: banned phrases `risk-free`, `cannot lose`, `can't lose`, `no way to overspend`, `safe to spend`; required statements: BSV-MODE.md says testnet only, the wallet's own prompt is the last gate, an agent's ordinary tools are outside the controls, and Legion "has never been pointed at the real, funded wallet" (the existing regex `never (been )?(pointed|talked)[^.]*real` must still match); the old sentence "has no spend tool" must be gone from every scanned source (negative assertion). Mutation: re-adding "Legion has no spend tool in this version." to `NO_SPEND` makes the hedge test fail.

## 6. Taint and prompt injection

- Sources: chain data (OP_RETURN, inscriptions, token names), web pages, files, other bots' messages (rooms, bridge), wallet text, the agent's own `purpose` and `recipient`.
- Chain data, web, files: they reach the run through tools the engine already taints (`WebFetch`, `Bash`, external MCP) and through `kg` content already labelled. `spend.ts` reads `job.taint()` itself at propose and again at decide; the agent cannot set or clear it. A tainted run needs the `untrusted-content` confirmation (second native dialog). `bsv_status` taints every run that used it, so in practice nearly every spend shows two dialogs; that is intended and the docs say so.
- Bot-to-bot: a run with `job.origin` (bridge hop >= 1, a room, or `mcp`) is refused (`not-human-run`), so a chain of bots cannot reach the spend path. The existing hop caps (`MAX_HOP = 6` in `bridge.ts`, room `maxHops`) stay as they are; the audit `proposed` line records `origin` and `hop` when present. Bot text that reaches the Assayer is data under the existing comms wrapping; `spend.ts` never consumes it.
- Wallet text: only whitelisted, type-checked fields are read (`reference`, `tx`, `txid`); every string from the wallet other than a valid txid is discarded unread and unlogged; errors map to fixed codes. The tool result is wrapped `<bsv-spend-result untrusted="true">` with the fixed "data, not instructions" sentence, like `renderWalletStatus`. The run is marked tainted after any wallet contact (`job.markTainted?.()`).
- Agent text: `purpose` is flattened by `safeText` (control, bidi and zero-width removed, 200 chars, secrets scrubbed), shown on the card and dialog labelled "Written by the agent. Not checked by Legion.", and is never used for any decision. `recipient` is validated as base58check before any other use and shown in full in the dialog (never abbreviated).
- Tests (`test/bsv-spend-injection.test.ts`): a corpus of at least 50 strings (fake system tags, fake approval or card JSON, base64 and zero-width disguised text, other-language instructions, "owner approved", fake dialog text) delivered through chain-data-like tool output, kg notes, a bot message, the wallet's version string and error bodies, `purpose` and `recipient`, against a scripted model that obeys. Expected in every case: no `createAction` before the owner-visible card exists, no `signAction` without a native `approve` from the test's stub dialog, no policy change, no text from the corpus in the audit log, tool result or dialog fields other than `purpose`, taint flag true on the card. Also: `purpose` containing newlines or bidi marks renders as one line; a `requestKey` collision across two tasks gives different `requestId`s.

## 7. Fake wallet in cloud tests, and what only the owner can verify

### 7.1 Cloud tests: `test/bsv-fake-wallet.ts` (a helper, not product code)
- Node `http` server on `127.0.0.1:0` (random port; the helper asserts `port !== 3321` and refuses any non-loopback address), a recording log of method, path, headers, body and order, and `fakeTransport(port)` (wraps the module's `Transport` and throws on port 3321 or a non-loopback host). Every spend test passes `fakeTransport` as `createBsvModule`'s `transport` option.
- It implements BRC-100 JSON for the four probe methods plus `createAction`, `signAction`, `abortAction` as ASSUMED in `U1-U5`; a small tx and BEEF builder in the helper creates parent transactions, signable transactions and signed answers (test keys are fixed constants; the fake never validates a signature).
- Scripted behaviours (each a flag): wrong network at probe 1 or 2, `main`, unknown; hang; trickle; oversize; garbage; HTTP 500; socket close mid-answer; extra output, two extras, data output, changed amount or recipient after sign; fee above ceiling; missing parent; wrong txid format; second answer after freeze; abort failing; a different transaction signed; a restart-able data dir.
- `test/bsv-port-guard.test.ts`: walks `test/` and `scripts/` and fails on any `3321` token except an explicit allowlist (this guard file, the fake-wallet helper's assertion, `bsv-scan.ts`'s regex), each with a reason; plus a test that the helper rejects port 3321 at runtime. Agent and builder prompts for this work carry the same ban (reviewer checklist).
- What it cannot prove: any real BRC-100 wallet behaviour (U1-U8), the real prompt text, the real Electron dialog.

### 7.2 Owner-only: VM with a TESTNET wallet, owner present (never the funded wallet)
Setup V0: a VM with its own BSV Desktop in testnet mode funded with testnet coins; Legion built from the branch inside the VM; no port forwarding to the host; check inside the VM that the host's wallet is not reachable. Nothing below is run on the owner's host.
Gate V1/V2 (BEFORE builder T2 starts; read-only on a throwaway testnet wallet, by hand, no Legion code): V1 ask the wallet to create an unsigned transaction without signing: expect a signable object with a reference, NO wallet prompt, nothing broadcast; save a scrubbed sample (encoding, parents present, change shape, address version byte) as `test/fixtures/` input for the decoder (U1, U2, U7, U8). V2 abort that reference: expect the coins to be spendable again (U3). If V1 or V2 fail: STOP, report (design section 10).
After the build (V3-V12), with expected observations:
| Step | Action | Expected |
|---|---|---|
| V3 | Connect to the VM wallet, run `bsv_status` | testnet, reachable, signed in (U8) |
| V4 | Panel: allowlist one testnet address (the VM wallet's second address) | native dialog; list saved |
| V5 | Assayer requests 600 sat | dialog 1 shows 600 sat, full address, TESTNET, fee, caps; dialog 2 (untrusted); wallet prompt only after both; txid returned; owner opens the txid in a testnet block explorer in the browser (Legion does not check it) |
| V6 | Second request right after | wallet prompts AGAIN (no standing grant for `legion.local`, U4) |
| V7 | Cancel at Legion's dialog | no wallet prompt; reservation freed; a following request for the same amount works (abort released the coins, U3) |
| V8 | Deny at the wallet's prompt | record exactly what the wallet sends back (U6); Legion shows `unknown` unless a reviewed mapping exists; owner resolves it natively |
| V9 | Kill the wallet during its prompt | `unknown`; restart Legion: still blocked (C12); resolve natively; then spends work |
| V10 | Request 1,001 sat; request a non-allowlisted address | denied before any dialog; wallet untouched |
| V11 | Freeze while dialog 1 is open | dialog answer refused; no wallet prompt |
| V12 | Hand-edit `bsv.walletUrl` in `config.json`, restart | not used; panel asks for Connect |
Also record: the real wallet prompt wording (for the docs), whether a persistent-permission option appears (must be declined; if it cannot be avoided, report as a blocker per design section 10), and the real Electron dialog on the VM desktop (U10). Results go into `claude/tracker-pc-checks.md` by the owner or a later task.

## 8. Work breakdown (max 4 tasks, file ownership, order)

Order: V1/V2 gate (owner) in parallel with T1; T2 and T3 after T1 and the gate (the route contract in 2.3 is frozen, so they run in parallel); T4 last.

| Task | Owns (no other task edits these) | Does |
|---|---|---|
| T1 plumbing | `src/core/bsv/policy.ts`, `audit.ts`, `state.ts`, `wallet-probe.ts`, `wallet-tool.ts`; tests `test/bsv-policy.test.ts`, `bsv-audit.test.ts`, `bsv-fix-round.test.ts`, `bsv-wallet-probe.test.ts`, `bsv-config.test.ts`, new `test/bsv-spend-restore.test.ts` | engine unknown seed, ledger dedupe, `verifiedEntries`, `connectedUrl`, `extraTools`, state ignores a hand-edited URL; keeps all existing tests green |
| T2 spend module | `src/core/bsv/spend.ts` (new), `src/core/bsv/index.ts`, `test/bsv-scan.ts`, `test/bsv-review-tripwire.test.ts`, `test/bsv-tripwire.test.ts`, `.gitattributes`, `scripts/bsv-spend-pin.mjs`, `test/bsv-module-wallet.test.ts`, new `test/bsv-fake-wallet.ts`, `bsv-spend-decoder|flow|audit|injection|tripwire|mutants|scenarios`, `bsv-port-guard` tests, `test/fixtures/brc100/*` | module, wiring, routes, `BSV_PREAMBLE` (still exactly four lines), scan exemptions and pin, all spend tests; module and scan entry land in ONE commit so the build is green |
| T3 native and UI | `src/electron/admin-logic.ts`, `main.ts`, `preload.cjs`, `src/shared/bsv-view.ts`, `ui/src/bsv/*`, `test/bsv-electron-logic.test.ts`, `bsv-electron-emu.test.ts`, `test/electron-emu/*`, `bsv-ui-view.test.ts`, new `test/bsv-spend-native.test.ts` | parse kinds (`spend-review` takes only a `requestId`; `spend-deny` dialog-free; `spend-resolve` native), spend dialog wording built by main from the card main read, 3 s poll of `/api/bsv/spend/pending` only while BSV is on, one dialog at a time and a FIFO queue, refuse a card whose network is not `test`, second dialog for untrusted content, UI keeps no animation and no new timers, shows pending, unknown and a Resolve button, `spendTools:boolean`, reworded `NO_SPEND` and Connect text |
| T4 docs and pack | `docs/BSV-MODE.md`, `docs/BSV-WALLET-DESIGN.md`, `SECURITY.md`, `README.md`, `CHANGELOG.md`, `claude/legion-release-tracker.md`, `src/core/kg/seeds/bsv.json` (+ `bsv-legacy-hashes.json` if needed), `test/bsv-hedge.test.ts`, `test/bsv-review-pack.test.ts`, `test/kg-bsv-seed.test.ts` | section 10 list, pack version 8, hedge additions |

Builder rules: never run anything against port 3321, never open a wallet, no `git commit` of the pin without the reviewer; a builder who needs a file owned by another task stops and says so. Full suite (`npm test`) green at each task end.

Reviewer checklist (adversarial, in this order):
1. `sha256` of `spend.ts` (CRLF stripped) equals `SPEND_PIN`; the file names exactly the three methods; no `fetch`, no node network or process module; no literal `main`; no 3321.
2. Walk the section 3 table against the code: every failure edge has a test; `audit.append` is called directly (not via `note`) at P, 9, 12.
3. Run every mutant by hand once (revert, rerun) and confirm red; check that anchors are unique.
4. Read the decoder against the fuzz corpus; confirm input values come from parents only.
5. Confirm `decide` takes `cardHash` from main's read, not from the window; confirm main refuses non-`test` cards.
6. Confirm `restore()` seeds unknown from the lenient reader and clears only from the verified reader.
7. `git grep -n 3321 -- test scripts` is only the guard allowlist; `package.json` has no new dependency.
8. Hedge scan: no sentence anywhere still says there is no spend tool; the new wording keeps its scope ("Legion's own code ...").
9. VM results (section 7.2) attached before any "built" claim is written in docs; every `U#` is marked confirmed or still unverified.

## 9. Risks and open questions

Residual risks (accepted, to be written in the docs): same-user malware can read secrets, click dialogs and call the wallet directly; Legion cannot prove which output is change (it holds no keys): one extra P2PKH output is accepted and labelled; a wallet that signs something other than the card is caught only after the fact (freeze); a rogue local listener can impersonate the wallet but cannot move funds; pinned `spend.ts` does not pin the files it imports (`policy.ts`, `audit.ts`, `wallet-probe.ts`: they stay under the existing scans, tests and the reviewer checklist); approval fatigue (mitigated by the 5-per-10-minutes rate limit, 1,000 sat cap and empty allowlist); a tool timeout shorter than expected (mitigated by 100 s waits and idempotent re-calls); a user decline in the wallet is reported as `unknown` until a reviewed mapping exists (annoying, safe).

Open questions that need the owner (default in brackets; the builder uses the default unless told otherwise):
1. Should a testnet spend also require Arm? Today arming applies to mainnet only and its dialog says LIVE FUNDS. [No. A `main` request is refused at the tool boundary; each testnet spend has its own native dialogs.]
2. May a run woken by another bot, a room or an MCP client request a spend (the owner would still confirm natively)? [No: only a run you started in the app.]
3. Accept "one unattributed extra output is wallet change", shown in the dialog with its address and labelled as unverifiable by Legion? [Yes, after V1 shows the real wallet returns one standard P2PKH change output; otherwise stop.]
4. If the wallet cannot return an unsigned transaction first (it builds and prompts in one step), may rung 3 fall back to "sign first, show the fee afterwards"? [No: stop, as design section 10 says; the fee must be in the dialog before any signing.]
5. Recipients: testnet P2PKH addresses only, one payment output per request (no paymail, no public keys, no multi-output) for v1? [Yes.]

## 10. Documentation and string updates (T4, plus the strings inside T2 and T3 files)

Every place that today says "no spend tool" and becomes false (found by grep; each needs the new wording AND a test update):
- `src/core/bsv/index.ts`: `BSV_PREAMBLE` (still exactly four lines; names `mcp__legion_bsv__bsv_spend_request`, says it needs the owner's confirmation and the wallet's own prompt, never asks for keys); `spendTools: false` in `BsvPolicyView` becomes `boolean` (T2). `src/shared/bsv-view.ts` same (T3). Tests asserting `spendTools: false`: `test/bsv-module-wallet.test.ts` (T2), `test/bsv-electron-emu.test.ts`, `test/electron-emu/run.mjs`, `test/bsv-ui-view.test.ts` (T3).
- `src/core/bsv/wallet-tool.ts`: the `bsv_status` description and `renderWalletStatus` line ("Legion has no tool to sign, spend..."), reworded with scope ("Legion's own status tool cannot ..."). `src/core/bsv/policy.ts` and `index.ts` header comments (they say the engine is connected to nothing).
- `src/electron/admin-logic.ts`: `NO_SPEND` and the Connect dialog text; `ui/src/bsv/BsvPanel.tsx`, `bsvStore.ts`, `ChainOverlay.tsx` strings.
- `src/core/kg/seeds/bsv.json`: pack version 8; `bsv-status-today` rewritten; spend-flow lessons move from `[Design]`/`built:false` to `[Partly built]`/`built:'partly'` until V3-V12 pass; `test/bsv-review-pack.test.ts` and `test/kg-bsv-seed.test.ts` updated; upgrade notes (nodes edited by the owner stay untouched, as today).
- `docs/BSV-MODE.md`: new "Spend (testnet)" section (tool, flow, dialogs, limits, unknown outcome, what it does not cover), the "What it does NOT do" and "Not built" sections, the tripwire section (pinned spend module, the allowed names), "Not verified" (list `U1-U10`, mark each confirmed or open after the VM run), keep "never been pointed at the real, funded wallet". `docs/BSV-WALLET-DESIGN.md`: section 4 rewritten to the real order (unsigned build, decode, card, dialogs, sign), section 11 gains `U1-U10`, section 12 records the approved owner answers and the five new questions above with their answers, rung table row 3 status. `docs/ARCHITECTURE.md`: the BSV security-model paragraph ("No spend tool exists; the engine is connected to nothing") and the route list.
- `SECURITY.md`: the BSV wallet row and the BSV audit row (a spend path exists, testnet only, wallet prompt is the last gate, same-user residuals unchanged, not verified against a funded wallet), and the paragraphs that say "no spend tool". `README.md`: the BSV line. `CHANGELOG.md` under `[Unreleased]`: Added (`bsv_spend_request`, testnet only, native dialogs, unknown-outcome persistence, `walletUrl` no longer read from `config.json`), Changed (preamble, dialogs, tripwire pinned module), Security notes. `claude/legion-release-tracker.md`: work item F to "plan approved / building" with task states T1-T4 and the V1/V2 gate, and a line that VM results are pending.
- No document may claim the controls are verified against a real wallet until section 7.2 results exist; `test/bsv-hedge.test.ts` additions in section 5 enforce the banned phrases.

## 11. Owner decisions (2026-10-02)

1. Arm for testnet spends: **No** (confirmed). A `main` request stays refused at the tool boundary.
2. Runs woken by another bot, a room or an MCP client may NOT request a spend (confirmed): only a run the owner started in the app.
3. One unattributed extra P2PKH output accepted as wallet change, shown in the dialog (assumed, not confirmed; only after V1 shows the real wallet returns one standard P2PKH change output).
4. No fall back to "sign first" if the wallet cannot return an unsigned transaction (assumed, not confirmed): stop.
5. Testnet P2PKH recipients only, one payment output (assumed, not confirmed).
6. Mainnet: stays OUT of v1 (earlier decision). Owner asked on 2026-10-02 whether adding it would be a lot: answered in chat (code delta small, verification and risk large, needs its own review and a real-funds check with the owner present); no change of scope unless the owner says so.
7. The owner's own BSV Desktop (127.0.0.1:3321, almost certainly mainnet with real funds) is NEVER used for V0-V12 or any test. V1/V2 need a separate testnet wallet in a separate environment. Environment choice and timing: open.
