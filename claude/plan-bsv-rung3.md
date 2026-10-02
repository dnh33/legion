# Plan: BSV rung 3, manual testnet spend (`bsv_spend_request`)

Status: PLAN ONLY, 2026-10-02 (AMENDED the same day: mainnet capability is now in scope, OFF by default; section 12 supersedes anything in sections 1-11 that says mainnet is out of scope or the network is always `test`), branch `integration/v1`. Nothing here is built. Source of truth for owner decisions: `docs/BSV-WALLET-DESIGN.md` section 12 and `claude/legion-release-tracker.md` (decisions approved 2026-10-02, not to be re-asked). Everything the wallet is claimed to do is UNVERIFIED (tag `U#`, confirmed only by the VM steps in section 7). Defensive framing: this lists gaps in controls and how each is closed or accepted, not ways to defeat them.

## 1. Goal and non-goals

1. Goal: the owner can run testnet exercises end to end: the Assayer proposes ONE testnet payment, the owner reads a native dialog (amount, recipient, network, fee), then the wallet's own prompt decides. The same flow also exists for mainnet, switched off by default and enabled only by the owner (section 12).
2. Exactly one new source file, `src/core/bsv/spend.ts`, one new agent tool, `bsv_spend_request`; everything else is plumbing, tests and docs.
3. Non-goals: an agent-chosen network (no input selects it; mainnet is built but disabled by default, section 12), autonomous or scheduled spends, standing grants, paymail or pubkey recipients, multiple payment outputs, balance or output reads (rung 2 skipped), keys of any kind in Legion.
4. Legion never approves a wallet prompt, never retries a signing call, never re-sends after an unknown outcome, never stores signed bytes (only the txid).
5. Tests and scripts NEVER touch the real wallet at `127.0.0.1:3321`; cloud tests use a fake BRC-100 server on a random loopback port.
6. Stop condition (design section 10): if VM step V1 or V2 fails, no spend path ships; report to the owner instead of improvising.

## 2. Module, surface and wiring

### 2.1 The one new module: `src/core/bsv/spend.ts`
Public surface (exports, all in this file): `createSpendService(deps): SpendService`, `SPEND_METHODS` (`createAction`, `signAction`, `abortAction`, a const tuple, the only wallet names in the file), `decodeSignable(bytes): Decoded | null`, `p2pkhScript(address, net): Uint8Array | null` (base58check, SHA-256 only, version byte per network from `networks.ts`, 12.1), `SPEND_REASON_CODES`.
`SpendService` methods: `buildTool(agent, job): SdkMcpTool` (registered inside the existing `legion_bsv` server), `pending(): CardView[]`, `decide(id, {decision, cardHash, confirmations})`, `resolve(id, 'sent'|'not-sent')`, `restore(auditEntries)`, `onFreeze()`.
Dependencies are injected (policy, probe, audit, state, `transport`, clock): `spend.ts` imports NO node network module and no `fetch`. It reaches the wallet only through the exported `Transport` type and the module's injected transport (default `httpTransport` from `wallet-probe.ts`), with the path built from `SPEND_METHODS` and the URL from `probe.connectedUrl` (new getter, T1).

### 2.2 Tool contract
- Name `bsv_spend_request` on server `legion_bsv`, Assayer only (`requires:'bsv'`), BSV mode on. Not a Legion-trusted tool name, so in `ask` mode the ordinary tool card still appears (kept, as for `bsv_status`); in `full` mode no card appears, so the native dialog is the only gate there (test for it, C9).
- Input (zod): `requestKey` string 8-64 `[A-Za-z0-9_-]` (idempotency), `recipient` string 26-35 base58, `sats` integer 1..1,000,000 (policy caps decide), `purpose` string 1-200. The handler also checks the RAW argument keys against these four and denies any extra key (a `network` field has no effect and is denied `extra-input`). Network is never an input.
- Legion mints `requestId` = first 40 hex of sha256(`taskId` + LF + `requestKey`). The same key returns the stored status and makes NO new wallet call (replaces blind retry). A different payload under a used key is denied `key-reused`.
- The handler waits at most 100 s for a terminal state, then returns `pending-owner` or `pending-wallet`; re-calling with the same key returns the current state. The flow itself is owned by the service, not by the tool promise, so a cancelled run, a slow SDK or a short tool timeout cannot orphan it (U9, test C14).
- Returns `<bsv-spend-result untrusted="true">{json}</bsv-spend-result>` plus one fixed sentence. JSON: `{requestId, network:<label from networks.ts>, status, reasonCodes?, totalSats?, txid?}`. `status` is one of `denied`, `pending-owner`, `pending-wallet`, `declined`, `expired`, `failed`, `unknown`, `executed`. `reasonCodes` come from the fixed list `SPEND_REASON_CODES` (`bsv-off`, `not-assayer`, `not-human-run`, `frozen`, `busy`, `too-many-requests`, `rate-limited`, `extra-input`, `bad-recipient`, `not-allowlisted`, `not-connected`, `wallet-network-unknown` (was `wallet-not-testnet`), `wallet-unreachable`, `mainnet-disabled`, `not-armed`, `address-network-mismatch`, `wallet-network-changed` (the last four: 12.1), `build-failed`, `undecodable`, `unexpected-outputs`, `over-cap`, `fee-too-high`, `unknown-outcome-pending`, `audit-unavailable`, `key-reused`). No wallet text, script, reference, card hash or engine reason string ever reaches the agent. `txid` only if `/^[0-9a-f]{64}$/`.

### 2.3 Plumbing around it (existing files, owners in section 8)
- `policy.ts`: constructor option `unknown: {requestId, agentId, totalSats}[]` creates `unknown` records that keep their reservation; `ledgerFromAudit` dedupes by `requestId`. `approve/settle/evaluate` are NOT loosened (engine reused as is).
- `audit.ts`: `AuditLog.verifiedEntries(filter)` (entries only from files whose chain verifies). `append` is already synchronous and throws on I/O failure; the spend path calls it directly (no `note()`, which swallows).
- `wallet-probe.ts`: getter `connectedUrl` (the URL only while `connected`), nothing else changes; the probe's four-method list is untouched.
- `state.ts`: `walletUrl` is no longer read from `config.json` at load (only `Connect` sets it, in memory); the owner decision "ignore a hand-edited `bsv.walletUrl`". The panel loses the prefill; the owner types the address.
- `wallet-tool.ts`: `buildBsvStatusServer` accepts `extraTools`; its description and render line are reworded (section 10).
- `index.ts`: builds the service, adds routes, composes `mcpServers`, runs `restore()` at start, flips `spendTools` to a boolean.
- Routes (contract frozen for T3): `GET /api/bsv/spend/pending` (admin) returns cards and unknown items; `POST /api/bsv/spend/:id/decision` (admin + native secret) body `{decision:'approve', cardHash, confirmations}` or `{decision:'deny'}`; `POST /api/bsv/spend/:id/resolve` (admin + native secret) body `{outcome:'sent'|'not-sent'}`. None is on the MCP client list in `admin.ts` (default deny: the bearer token reaches none of them; Freeze stays the one open route).

### 2.4 Policy engine use (no new verdicts)
`policy.evaluate({requestId, network: <the fresh probe's network, 12.1>, walletNetwork, agentId, taskId, reason:purpose, tainted: job.taint(), decoded})` where `decoded` comes ONLY from `decodeSignable` of the wallet-built unsigned transaction (never from agent fields). Required confirmations are the engine's (`approve`, plus `untrusted-content` when tainted). The card shown is the engine's `ApprovalCard` (hash-bound). `approve()` is called only from `decide()`.

## 3. State machine of one spend

Order (changed from the design doc, forced by the fee: the engine needs `inputSats` and `feeSats`, so the wallet builds an UNSIGNED transaction first; Legion decodes it; policy evaluates; the owner confirms; only then does the wallet sign):
`gates -> proposed(audit) -> fresh probe -> createAction(signAndProcess false) -> decode -> evaluate/reserve -> card -> native dialog(s) -> decision(re-checks) -> executing(audit) -> signAction -> verify -> executed(audit) -> settle`.
Unverified wallet behaviour used: U1 `createAction` with `options.signAndProcess:false` returns a signable transaction (`tx`, `reference`) and does not broadcast; U2 the `tx` encoding (BEEF, possibly atomic BEEF; bytes, hex or base64); U3 `abortAction(reference)` releases the wallet's locked inputs; U4 `signAction` shows the wallet's own prompt every time and nothing grants `legion.local` a standing permission; U5 the signed result carries `txid` and `tx`; U6 how the wallet reports a user decline (default: treated as `unknown`); U7 the wallet's change is one standard P2PKH output; U8 the testnet network string and address version byte; U9 a short MCP tool timeout (mitigated, 2.2); U10 Electron dialogs on a real desktop. Each is confirmed or refuted in section 7.

| # | Step | Failure edge | What fails closed | Audit (strict = may throw) |
|---|---|---|---|---|
| G | Gates: BSV on, agent is the gated one, `job.origin` undefined (bridge, room and MCP runs refused), chain not frozen, no unknown outcome, no request in flight (single flight), at most 3 requests per task, 5 proposals per 10 min, raw arg keys, base58check testnet address | any gate false | return `denied` + code; no wallet contact, no reservation | `denied` (best effort) |
| P | Write `proposed` (requestId, taskId, sats, purpose hash) | append throws | `denied audit-unavailable`; zero wallet calls | `proposed` STRICT, first thing after G |
| 1 | Fresh probe (`probe.check({fresh:true})`): connected, reachable, authenticated, network known (`test`; `main` only under 12.1) | main, unknown, unreachable, not connected | `denied wallet-*`; zero `createAction` on the wire | `denied` |
| 2 | `createAction` unsigned: one output (recipient script, `sats`), `signAndProcess:false`; body and response capped (256 KiB), 30 s | timeout, refused, HTTP error, garbage, oversize, no `reference` | `failed build-failed`; best-effort `abortAction` if a reference was seen; no reservation yet | `failed` |
| 3 | `decodeSignable`: bounded BEEF parse, input values from parent transactions, outputs list, fee = inputs - outputs | any parse error, missing parent, more than 100 inputs/outputs, over 256 KiB, a zero-sat output | `abortAction`; `denied undecodable` | `denied` |
| 4 | Output check: exactly one output whose script equals P2PKH of the requested address and whose sats equal the request; at most ONE other output (labelled `change`, standard P2PKH, address shown); anything else (second payment, data output, non-P2PKH extra, two extras) | extra or altered output | `abortAction`; `denied unexpected-outputs` | `denied` |
| 5 | `policy.evaluate` (check and reserve, synchronous): allowlist (empty = deny), caps 1,000/5,000/10,000 including reservations, fee ceiling, unknown-outcome block, wallet network, conservation | engine `deny` | `abortAction`; `denied` with mapped codes | engine event (best effort) + `denied` |
| 6 | Card pending in the core (120 s TTL). Main polls `/api/bsv/spend/pending` and reads the card from the core itself | main not running, window hidden, no poll | card `expired` at 120 s (engine sweep), reservation freed, `abortAction`, status `expired` | `expired` |
| 7 | Native dialog 1 (card) then, if the card requires `untrusted-content`, dialog 2 (separate button press). Cancel default and escape | Cancel, closed, a second card meanwhile | `deny` (dialog-free route), reservation freed, `abortAction`, status `declined`; a late Approve after expiry is refused by the core | `declined` |
| 8 | `decide(approve)`: native secret, id exists and pending, `cardHash` equals engine hash, confirmations complete, fresh probe still the card's network (12.1), `job.taint()` re-read (a card made while clean is voided if the run became tainted), not frozen, no unknown | any re-check fails | `denied`/`declined`, `abortAction`; `policy.approve` is not called | `declined` + code |
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
| C1 | Network is never an input; the wallet's fresh network is pinned at propose and re-checked at approve (superseded and extended by C25-C31) | `spend.ts` G/1/8 | flow: wallet says mainnet, then unknown, then flips to main between card and approve: zero `signAction`; `network` key in args denied | drop the step-8 probe re-check |
| C2 | Gates (Assayer, BSV on, no origin, single flight, 3 per task, 5 per 10 min) | `spend.ts` G | flow: MCP-started run, bridge-woken run, room run, second concurrent request, fourth request: all denied, zero wallet calls | remove the `job.origin` test |
| C3 | Recipient exactness: testnet P2PKH only, allowlist exact (empty = deny), script compare | `spend.ts` 4, `policy.ts` | decoder: homoglyph, trailing space, wrong version byte, bad checksum, mainnet address, paymail, 2^53 sats; allowlist empty by default | compare by string prefix instead of script |
| C4 | Caps and reservations on REAL decoded values | `policy.evaluate` via 5 | flow: 1,000 ok, 1,001 denied, 5,000/10,000 cumulative, 100 parallel proposals fit the cap once, fee over ceiling | hand `evaluate` the agent's `sats` instead of the decoded total |
| C5 | Decoder fails closed and is bounded | `decodeSignable` | decoder: 300 fuzz cases (truncation, varint overflow, parent missing, cycle, duplicate parent, oversize, 101 outputs, zero-sat output, negative-looking values): `null`, no throw, time-bounded | treat missing parent value as 0 |
| C6 | Change handling: at most one non-payment output, standard P2PKH, shown with address and labelled "wallet-claimed, Legion cannot verify" | `spend.ts` 4, dialog text | flow: two extras, one data output, one non-P2PKH extra: denied; one P2PKH extra accepted and visible in the card | allow any number of extras |
| C7 | Audit BEFORE sign, fail closed | `spend.ts` P and 9 (direct `audit.append`) | audit: make `append` throw at `proposed`, then at `executing`: fake wallet records zero `createAction`, zero `signAction` | route the write through the swallowing `note()` |
| C8 | Audit AFTER, fail closed | `spend.ts` 12 | audit: throw at `executed`: chain frozen, request `unknown`, spends blocked | ignore the throw |
| C9 | Native confirmation: card read by main from the core, Cancel default, hash from main's read, network from the card (mainnet rules: 12.2), second dialog for untrusted content, `full` mode still blocks | `main.ts`, `admin-logic.ts`, route `decision` | native + emu: Cancel, escape, closed window, forged card from the window ignored, foreign frame refused, `full`-mode agent still waits for the dialog | main sends the window's `cardHash` |
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
- `'main'`/`mainnet` as a literal in the spend file: reported (replaced by the precise rule in 12.5);
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
| T3 native and UI | `src/electron/admin-logic.ts`, `main.ts`, `preload.cjs`, `src/shared/bsv-view.ts`, `ui/src/bsv/*`, `test/bsv-electron-logic.test.ts`, `bsv-electron-emu.test.ts`, `test/electron-emu/*`, `bsv-ui-view.test.ts`, new `test/bsv-spend-native.test.ts` | parse kinds (`spend-review` takes only a `requestId`; `spend-deny` dialog-free; `spend-resolve` native), spend dialog wording built by main from the card main read, 3 s poll of `/api/bsv/spend/pending` only while BSV is on, one dialog at a time and a FIFO queue, refuse a card whose network the core's facts do not allow (12.7), second dialog for untrusted content, UI keeps no animation and no new timers, shows pending, unknown and a Resolve button, `spendTools:boolean`, reworded `NO_SPEND` and Connect text |
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
1. Should a testnet spend also require Arm? Today arming applies to mainnet only and its dialog says LIVE FUNDS. [No. Arm applies to mainnet only (12.2); each testnet spend has its own native dialogs.]
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
- `docs/BSV-MODE.md`: new "Spend" section (testnet and mainnet, 12.8) (tool, flow, dialogs, limits, unknown outcome, what it does not cover), the "What it does NOT do" and "Not built" sections, the tripwire section (pinned spend module, the allowed names), "Not verified" (list `U1-U10`, mark each confirmed or open after the VM run), keep "never been pointed at the real, funded wallet". `docs/BSV-WALLET-DESIGN.md`: section 4 rewritten to the real order (unsigned build, decode, card, dialogs, sign), section 11 gains `U1-U10`, section 12 records the approved owner answers and the five new questions above with their answers, rung table row 3 status. `docs/ARCHITECTURE.md`: the BSV security-model paragraph ("No spend tool exists; the engine is connected to nothing") and the route list.
- `SECURITY.md`: the BSV wallet row and the BSV audit row (a spend path exists, testnet only, wallet prompt is the last gate, same-user residuals unchanged, not verified against a funded wallet), and the paragraphs that say "no spend tool". `README.md`: the BSV line. `CHANGELOG.md` under `[Unreleased]`: Added (`bsv_spend_request`, testnet and mainnet with mainnet off by default, native dialogs, unknown-outcome persistence, `walletUrl` no longer read from `config.json`), Changed (preamble, dialogs, tripwire pinned module), Security notes. `claude/legion-release-tracker.md`: work item F to "plan approved / building" with task states T1-T4 and the V1/V2 gate, and a line that VM results are pending.
- No document may claim the controls are verified against a real wallet until section 7.2 results exist; `test/bsv-hedge.test.ts` additions in section 5 enforce the banned phrases.

## 11. Owner decisions (2026-10-02)

1. Arm for testnet spends: **No** (confirmed). Arm applies to mainnet only (12.2).
2. Runs woken by another bot, a room or an MCP client may NOT request a spend (confirmed): only a run the owner started in the app.
3. One unattributed extra P2PKH output accepted as wallet change, shown in the dialog (assumed, not confirmed; only after V1 shows the real wallet returns one standard P2PKH change output).
4. No fall back to "sign first" if the wallet cannot return an unsigned transaction (assumed, not confirmed): stop.
5. Testnet P2PKH recipients only, one payment output (assumed, not confirmed).
6. Mainnet: IN SCOPE (owner decision 2026-10-02, replaces the earlier "out of v1"). Testnet AND mainnet capability must be built and independently reviewed before v0.2.0; mainnet ships disabled; the real-funds check is the owner's, by hand, tiny amounts (section 12).
7. The owner's own BSV Desktop (127.0.0.1:3321, almost certainly mainnet with real funds) is NEVER used for V0-V12 or any test. V1/V2 need a separate testnet wallet in a separate environment. Environment choice and timing: open.

## 12. Mainnet amendment (owner decision 2026-10-02)

Scope change: Legion's spend tool gets BOTH testnet and mainnet capability, built and independently reviewed before v0.2.0. Mainnet ships OFF. Unchanged posture: keys never in Legion; every spend manual with native confirmation; Freeze always one click; no autonomous or scheduled spend; only a run the owner started in the app may ask (`job.origin` undefined); allowlists empty by default; no test, script or agent ever touches the owner's wallet at 127.0.0.1:3321 (C24 and the guard stay); the owner's funded wallet is used only by the owner, by hand, present, tiny amounts (12.6b). Sections 1-11 are the testnet baseline: where they conflict with this section, this section wins. New unverified items: U11 the wallet's mainnet network string (`readNetwork` maps it; anything else is `unknown`), U12 the unsigned-transaction shape and P2PKH change on mainnet, U13 the wallet prompt on mainnet (does it prompt every time, any "always allow" default), U14 realistic fee levels (sets the mainnet fee ceiling).

### 12.1 Network model (fail-closed, never an agent input)

Read from the code: `policy.ts` already has `Net = 'test'|'main'`, `SpendRequest.network`, `walletNetwork`, ONE global `armedUntil`, ONE caps set, ONE allowlist, ONE ledger; `evaluate` denies `main` unless armed and adds `live-funds`; `approve` re-checks `walletNetwork === r.network`; `hasUnknown()` is global; `types.ts` `BsvNetwork` is the literal `testnet` (the knowledge mode, unrelated to spending); `index.ts` already calls `policy.disarm` when the probe's network changes.

| Piece | Change | File |
|---|---|---|
| Network table | New data-only module: frozen `NET` with per-network label ("TESTNET", "LIVE FUNDS (main network)"), P2PKH address version byte (U12), hard ceilings, default caps; `addressNet(address)`, `decodeAddress`. The only place besides policy and probe that spells `main` | `src/core/bsv/networks.ts` (new, pinned, 12.5) |
| Hard-off switch | `PolicyConfig.mainnetEnabled: boolean`, default `false` in `sanitizePolicyConfig`, inside the fingerprinted `policy.json` (a missing, tampered or unreadable file loads `false` and frozen, as today). Engine: getter `mainnetEnabled`, `setMainnetEnabled(true)` (route only), `mainnetOff(reason)` (can only turn it off; the one setter `spend.ts` may call), `voidPending(reason)` | `policy.ts`, `policy-store.ts` |
| Route | `POST /api/bsv/policy/mainnet` body `{enabled:boolean}`: admin + native secret, NOT on the MCP client list. Enable = native dialog (kind `mainnet-enable`, warning, Cancel default and Escape: "Allow Legion to consider spending REAL BSV? Off by default. Each spend still needs Arm, your confirmations here and the wallet's own prompt."). Disable = no dialog (safer direction, like Disarm) | `src/core/bsv/mainnet-routes.ts` (new; one registering line in `index.ts`), `admin-logic.ts` |
| Auto-off | `mainnetOff` + disarm + freeze on: a mainnet `unknown`, a post-sign mismatch (11b), an audit failure on a mainnet request, a policy-file tamper. A plain Freeze leaves the switch as it is | `spend.ts`, `index.ts` |
| Source of the network | The wallet's fresh probe at step 1 is pinned into the request as `network`; the agent supplies nothing (`network`, `chain`, `mainnet` keys are `extra-input`). The recipient's version byte must equal the pinned network, checked in `evaluate` (`address-network-mismatch`). The on-chain P2PKH script is identical on both networks, so Legion cannot see the network in the transaction: it rests on the wallet's claim, the version byte, per-network allowlists and the owner reading `MAINNET` in the dialog | `spend.ts`, `policy.ts`, `networks.ts` |
| Refusal | Step 1: probe says `main`, switch off: status `denied`, code `mainnet-disabled`, audit `denied`, ZERO `createAction` (only the four probe questions went out). Switch on, not armed: `not-armed`. Probe `unknown`: `wallet-network-unknown` | `spend.ts` step 1 |

Per step of the section 3 machine for mainnet (G, P, 2, 3, 6, 13 unchanged; every audit line gains a `net` field):

| Step | Mainnet change |
|---|---|
| 1 fresh probe | Network may be `main`; then switch and arm are checked before anything else (above); `net` pinned |
| 4 outputs | One payment plus at most one change as before; recipient version byte must equal `net`; the mainnet `maxOutputs` is 1 |
| 5 evaluate | Per-network caps, allowlist, reservations (12.3); adds "mainnet is switched off" and the arm check; confirmations `approve`, `untrusted-content` (tainted), `live-funds` |
| 7 dialogs | The LIVE FUNDS dialogs of 12.2, one native press per required confirmation, all inside the one 120 s card TTL |
| 8 decide | Re-check order: frozen, switch still on, still armed, fresh probe network equals the card's network (both directions), hash, confirmations, taint, unknown. Any failure: `denied`/`declined`, `abortAction` |
| 9 approve | `policy.approve` for `main` consumes the arm in the same synchronous step (one arm, one spend), then the strict `executing` write |
| 10/10b sign | A fresh probe immediately before `signAction`: network differs from the card: no sign, `abortAction`, `wallet-network-changed`, `mainnetOff`. Mainnet `unknown`: also `mainnetOff` + disarm; the Resolve dialog says LIVE FUNDS |
| 11/11b verify | Mismatch on mainnet: engine freeze (existing) plus `mainnetOff`; a probe after the answer that shows a changed network: freeze + audit `network-flip-during-sign` (Legion cannot prove which network the wallet signed on) |
| 12 executed | Strict write carries `net`; a throw on mainnet: freeze, `mainnetOff`, `unknown` |
| 14 resolve | Native Resolve dialog titled LIVE FUNDS for mainnet; sats still come from main's read of the card |
| 15 restart | `restore()` seeds `unknown` with its `net`; the switch is read from the fingerprinted file (a mainnet `unknown` had already cleared it); arm is memory only, so a restart is disarmed |
| 16 freeze | Pending cards of both networks denied, arm gone, switch untouched |

### 12.2 Arm and the mainnet dialogs

- Arm requires the switch on and the chain not frozen (else `PolicyError`, route 409). Choices stay 5/15/30/60 (`ARM_CHOICES_MINUTES`); the dialog preselects 5 and says shorter is better.
- Per session and one spend: the arm lives in memory only (monotonic and wall clock, existing) and ends on restart, expiry, Disarm, freeze, BSV off, Disconnect, a probe-reported network change, `mainnetOff`, and the first approved mainnet spend (step 9). The next mainnet spend needs a new Arm dialog: one more click per spend, accepted for real funds.
- Arm dialog (replaces `NO_SPEND` for this kind): "Arm LIVE FUNDS mode for N minutes? ONE mainnet spend request may be considered, then it disarms. Each request still needs your confirmation dialogs here and the wallet's own prompt. Limits that apply (mainnet): ...". With the switch off, main sends no dialog and the panel says "Mainnet is switched off".
- Spend dialogs, built by main from the card main read itself, Cancel default and Escape:
  - D1 card: "Send N sat (X BSV) on MAINNET?" with the LIVE FUNDS frame in title and message; network MAINNET (a wallet claim, version byte matches); FULL recipient, wrapped, never abbreviated; allowlisted yes; change output with its address labelled "wallet-claimed, Legion cannot verify"; fee in sat; total leaving the wallet; MAINNET caps remaining (tx, session, 24 h); arm time left; purpose labelled "Written by the agent. Not checked by Legion."; taint warning if any.
  - D2 live funds (always, mainnet only): a second native box with another title ("Last Legion check before your wallet"), the confirm button in a different position than in D1 and labelled with the amount and the last 8 characters of the recipient ("Send 200 sat to ...Qx7Zk2Ab"), repeating network and full recipient, and "This cannot be undone. Your wallet will show its own prompt next; that prompt is the last gate and Legion cannot see it."
  - D3 `untrusted-content` (tainted runs): the existing separate press. A clean mainnet spend is two dialogs, a tainted one three, then the wallet prompt.
- Typed confirmation versus second dialog: second dialog. Typing needs a main-owned input window (new window code, focus and IME edge cases, a surface the stub-based emulation cannot test, a string a script can fill as easily as it clicks); a second native box reuses the tested mechanism, and the binding to this payment is the card hash plus the content-bearing button label. Residual (accepted): approval fatigue; a same-user process can click native boxes (unchanged).
- The wallet's own prompt remains the last gate: Legion never approves it and never retries it. If the wallet does not prompt for a mainnet `signAction` (U13), that is a stop condition like design section 10: the owner aborts the real-funds check (12.6b) and no document says otherwise.

### 12.3 Policy per network

| Item | Testnet | Mainnet |
|---|---|---|
| Default caps per tx / session / 24 h | 1,000 / 5,000 / 10,000 sat (unchanged) | 1,000 / 2,000 / 5,000 sat (Q1) |
| Payment outputs, fee ceiling | 3 (`spend.ts` sends 1), 200 sat | 1, 100 sat (revisit after U14) |
| Hard ceilings (code only) | 1,000,000 / 5,000,000 / 10,000,000, fee 10,000 | 100,000 / 250,000 / 500,000, fee 1,000 |
| Allowlist | up to 50, empty by default | up to 10, empty by default, own list; `setAllowlist(net, list)` refuses an entry whose version byte is the other network's |
| Arm | not needed | needed, one spend |
| Confirmations | approve (+ untrusted) | approve (+ untrusted) + live-funds |

- Engine data: `PolicyConfig.nets: Record<Net,{caps, allowlist}>`; the legacy top-level `caps`/`allowlist` load as `nets.test`, and the file is rewritten in the new shape on the next owner change (the old file still matches its recorded hash, so no tamper alarm). `LedgerRecord.net` (absent in old audit entries = `test`); `executedSince(net)`, `sessionSats(net)`, `reserved(net)` are per network, so testnet traffic can never consume or hide mainnet headroom.
- Unknown outcome is global: `hasUnknown()` blocks BOTH networks until the owner resolves it.
- Wallet network flips between propose and approve: `approve` already requires `walletNetwork === r.network`, which holds for test to main and main to test; add a fresh probe before sign and one after (12.1). On a probe-reported change `index.ts` also calls `voidPending` for the old network and disarms.
- Caps for mainnet (`POST .../caps` gains `net`) use the same native dialog; its text names the network.

### 12.4 Control additions (same mutant harness as section 4)

| ID | Control | Enforced in | Proving test | Mutant that must turn red |
|---|---|---|---|---|
| C25 | Mainnet hard-off, default off, fail-closed | `sanitizePolicyConfig`, `evaluate`, `spend.ts` step 1 | defaults: fresh install, tampered file, `mainnetEnabled:true` without a matching hash all load `false`; flow: wallet says `main`, switch off: `mainnet-disabled`, zero `createAction` | default `true`; drop the evaluate reason |
| C26 | Network never an input | `spend.ts` G (raw keys) | flow: `network`, `chain`, `mainnet` keys denied `extra-input`; a test wallet request cannot become `main` | honour `args.network` |
| C27 | Switch changes only through the native-confirmed route; disable is dialog-free | `mainnet-routes.ts`, `admin-logic.ts`, `main.ts` | module: bearer token and admin-only get 403 on `/policy/mainnet`; native: enable shows the warning dialog, Cancel leaves it off | drop `requireNative` |
| C28 | Arm needed, expiring, one spend | `policy.approve`, `arm` | policy + flow: a second mainnet request after an approved one is `not-armed`; arm without the switch refused; expiry at the tick | skip the arm consume; skip the arm check |
| C29 | Per-network caps, allowlists, reservations, ledgers | `policy.ts` | policy: testnet spends leave mainnet headroom untouched and the reverse; 100 parallel mainnet proposals fit once; hard ceiling per network | one shared ledger; reuse testnet ceilings |
| C30 | Recipient version byte equals the pinned network | `evaluate`, `setAllowlist` | policy + flow: test address on a main wallet, main address on a test wallet, bad checksum: `address-network-mismatch`; list entry of the wrong network refused | compare the string only |
| C31 | Network flip both ways at approve, before sign, after sign | `spend.ts` 8, 10, 11 | flow: test to main and main to test between card and approve (zero `signAction`), between approve and sign (zero `signAction`, `abortAction`), after the answer (freeze, `mainnetOff`) | drop each of the three probes |
| C32 | Mainnet dialogs: LIVE FUNDS frame, D2 always, FULL recipient, content-bearing button, none while the switch is off | `admin-logic.ts`, `main.ts` | native + emu: dialog options asserted (default button, Escape, labels, full address, caps, network); a mainnet card is ignored while facts say off or not armed | skip D2; abbreviate the address |
| C33 | Auto-off on unknown, mismatch, audit failure, tamper | `spend.ts`, `index.ts` | flow: each event leaves the switch false and disarmed, and the policy file shows it | skip `mainnetOff` |
| C34 | Unknown outcome blocks both networks | `hasUnknown` | policy + audit: unknown on test blocks main and the reverse; a restart keeps it | per-network `hasUnknown` |
| C35 | Mainnet ships off; docs do not overclaim | `policy.ts` defaults, hedge test | hedge: required statements (12.5), banned phrases; defaults test | remove the statement |

### 12.5 Tripwire and hedge impact

The section 5 rule "no `main`/`mainnet` literal in spend.ts" is replaced by one precise rule in `test/bsv-scan.ts`: `NET_LITERAL = /^(main|mainnet|test|testnet|live)$/i` as a quoted token, a property key (`main:`) or a member access (`.main`) is allowed ONLY in `NET_LITERAL_FILES`, each with a reason: `networks.ts` (the table), `policy.ts` (`Net` and the mainnet-only rules), `wallet-probe.ts` (`readNetwork`), `types.ts`, `index.ts` and `mainnet-routes.ts` (views, routes), `admin-logic.ts`, `src/shared/bsv-view.ts`, `ui/src/bsv/*` (display). `spend.ts`, `audit.ts` and `wallet-tool.ts` allow none: `spend.ts` takes the network as an opaque value from the probe result and looks everything up through `NET[net]`. Further rules:
1. `networks.ts` joins the pin: `SPEND_PINS` holds `spend.ts` and `networks.ts`, same CRLF-normalised sha256, same injectable pin for rule tests; `networks.ts` imports only `node:crypto`, exports only the frozen `NET` and the two pure functions, and names no network or process module.
2. `spend.ts` may call on the policy object only `evaluate`, `approve`, `deny`, `settle`, `resolveUnknown`, `status`, `snapshot`, `freeze`, `disarm`, `mainnetOff`, `voidPending`; naming `setMainnetEnabled`, `arm`, `unfreeze`, `setCaps` or `setAllowlist` there is reported (the agent path can only make things safer).
3. `setMainnetEnabled` may be named only in `policy.ts` and `mainnet-routes.ts`; the route string `/api/bsv/policy/mainnet` only in `mainnet-routes.ts`, `admin-logic.ts`, `main.ts`, `index.ts` and the UI store; `mainnet-routes.ts` is a listed HTTP-route file with its reason.
4. Plant cases (`test/bsv-spend-tripwire.test.ts`): `'main'`, `"mainnet"`, `{main: 1}`, `x.main` planted in `spend.ts` (pin injected to match), `audit.ts` and `wallet-tool.ts`: reported; `setMainnetEnabled` in `spend.ts`: reported; `networks.ts` with an import, a fetch or an extra function: reported. A default flipped in `policy.ts` is covered by C25, not by the scan.
5. Hedge (`test/bsv-hedge.test.ts`), required in `docs/BSV-MODE.md` and `SECURITY.md`: mainnet is OFF by default and only the owner turns it on in the app; "has not been verified with real funds until the owner's check is recorded" (kept until the record exists in `claude/tracker-pc-checks.md`, then replaced by a dated, scoped sentence, never "safe"); the wallet's own prompt is the last gate on mainnet; "has never been pointed at the real, funded wallet" stays true for code, tests and agents. Banned: `risk-free`, `cannot lose`, `safe on mainnet`, `production-ready`; `verified with real funds` is banned unless the test finds the record in the tracker file. Required negatives: no scanned source says "testnet only" or "refuses mainnet".

### 12.6 Tests

a) Fake wallet additions (`test/bsv-fake-wallet.ts`; still loopback on a random port, `fakeTransport`, port guard unchanged): option `network: 'test'|'main'|'unknown'` for the four probe answers; `flip: {after: 'probe#n'|'createAction'|'signAction', to}` changes the claimed network at a chosen point (propose to approve, approve to sign, after sign); a mainnet wallet that answers a testnet-address request and a testnet wallet that answers a mainnet-address request; address fixtures `test/fixtures/addresses.ts` for BOTH version bytes from fixed constants (no keys), with bad-checksum and cross-network variants; `prompt: 'always'|'never'` (Legion cannot see the wallet UI, so this only proves its own gates still hold). New files: `bsv-spend-mainnet.test.ts` (flow, flips, auto-off, one-spend arm), `bsv-policy-nets.test.ts`, `bsv-mainnet-defaults.test.ts`; mainnet cases in the mutant scenarios; injection corpus strings asking to "enable mainnet" or "arm" must change nothing.

b) Real-funds verification: OWNER ONLY, by hand, never scripted, never by an agent, separate from V0-V12 (which stay in a testnet VM). Preconditions, recorded first: V1-V12 passed; independent review of spend, policy-nets and the dialogs signed off; Legion built from the reviewed commit; owner at the keyboard; a mainnet receive address of the owner's OWN (a second address, so the net cost is the fee). Amount 200 sat (0.00000200 BSV), mainnet caps at defaults.

| Step | Owner action | Expected observation |
|---|---|---|
| R0 | Note the wallet balance and history; open Legion's panel | Switch OFF, not armed |
| R1 | Connect to the real wallet; ask the Assayer for 200 sat | Denied `mainnet-disabled`; NO wallet prompt; audit `denied` with `net` main |
| R2 | Enable mainnet, read the dialog, confirm | Panel: enabled, not armed |
| R3 | Allowlist the own address on the mainnet list; ask again | Denied `not-armed`; no wallet prompt |
| R4 | Arm 5 minutes (read the dialog); ask again | D1 then D2 (D3 if tainted); compare amount, network, FULL address (character by character against the wallet) and caps with this table |
| R5 | Press Cancel on D2 | `declined`, no wallet prompt, reservation freed, still armed |
| R6 | Ask again, confirm D1 and D2 | The wallet shows its OWN prompt: 200 sat, the recipient, ONE payment output; approve there only if all match |
| R7 | Read the result | txid returned; the owner checks it in a mainnet explorer in a browser (Legion does not): one 200 sat output to the own address plus change; balance fell by the fee only |
| R8 | Ask once more | Denied `not-armed` (one arm, one spend); no wallet prompt |
| R9 | Arm, ask, confirm D1 and D2, then Decline in the WALLET | Legion shows `unknown`, switch is off (auto-off); owner reads the wallet history and resolves natively ("NOT sent") |
| R10 | Enable, arm, ask; Freeze while D1 is open | Dialog answer refused; no wallet prompt |
| R11 | Disable mainnet, Disarm, Disconnect | Panel shows off; owner reads the audit lines for R1-R10 and records dated results in `claude/tracker-pc-checks.md` |

Who watches what: the owner watches the dialogs, the wallet prompt, wallet balance and explorer; an independent reviewer may watch by screen share and reads the audit log afterwards (read-only); agents and scripts do nothing here. ABORT at once (Freeze, Disable, no retry, record) if: a dialog differs from the table in amount, network word or one character of the address; the wallet prompt comes before D1 and D2 are answered, shows another amount or recipient or more than one payment output, offers "always allow" or a monthly limit (do not tick it), or does not appear at all in R6 (U13); the fee shown exceeds 100 sat; Legion returns any status other than the expected one; a second prompt appears; the txid is not 64 hex or the explorer shows anything unexpected. After an abort, read the wallet history before anything else. Until R0-R11 are recorded, every document says "has not been verified with real funds".

### 12.7 Work breakdown changes

| Task | Status | Exactly |
|---|---|---|
| T1 (running) | Forward-compat only | Carry an optional `net?: Net` (default `test`) through `LedgerRecord`, the `unknown` seed option and `ledgerFromAudit` and its dedupe, so T5 need not reshape them. Not T1's: per-network engine, `describeWallet` mainnet text and `legionNetwork: 'testnet'` (T5) |
| T2 spend module | Network-aware from the start (not yet started) | `spend.ts` takes `net` from the probe, uses `NET[net]` and `p2pkhScript(address, net)`, the reason codes of 2.2 as amended, `network` echoed from `NET[net].label`, only the policy methods of 12.5 rule 2; owns the tripwire edits of 12.5 and the fake-wallet additions of 12.6a; `index.ts` gains the registering line for `mainnet-routes.ts`, a per-network `policyView`, boolean `spendTools` and `mainnet:{enabled, armed}` |
| T3 (running) | Second pass after T5 | Now: build the card dialog from `card.network` and `card.networkLabel`, no hard-coded TESTNET. Revisit: "main refuses any non-test card" becomes "refuse a card whose `network` the core's facts do not allow (`mainnetEnabled && armed` for main)"; `bsv-view.ts` `network: 'testnet'` becomes `spendNetworks` plus `mainnet: {enabled, armed}`; `parseBsvAction` kinds `mainnet-enable` (native dialog) and `mainnet-disable` (none); D2 and dialog sequencing in `main.ts`; Arm dialog and `NO_SPEND` reworded; `BsvPolicyFacts` gains `mainnetEnabled` and `nets`; UI: switch row, per-network caps and allowlist rows, amber frame only while armed; tests `bsv-electron-logic`, `bsv-electron-emu`, `electron-emu/run.mjs`, `bsv-ui-view`, `bsv-spend-native` |
| T4 docs and pack | Extended | 12.8; the hedge tests of 12.5; pack nodes about mainnet stay `[Design]` or `[Partly built]` until R0-R11 are recorded |
| T5 mainnet enablement (new; starts after T1 merges; T2 and the T3 second pass build on its API) | Owns | `src/core/bsv/networks.ts`, `policy.ts` and `policy-store.ts` (ownership passes from T1 after merge), `types.ts`, `describeWallet` strings in `wallet-probe.ts`, new `src/core/bsv/mainnet-routes.ts`; tests `bsv-policy-nets.test.ts`, `bsv-mainnet-defaults.test.ts`, plus shape updates in `bsv-policy.test.ts`, `bsv-config.test.ts`, `bsv-wallet-probe.test.ts`, `bsv-fix-round.test.ts`. Delivers per-network config, ledger and reservations, `mainnetEnabled`, `mainnetOff`, `voidPending`, arm consume, the address-network check, legacy-file migration |

Order: V1/V2 gate and T1 now; T5 right after T1 merges (it is the API T2 builds on); T2 and the T3 second pass next; T4 last; independent review covers spend, policy-nets, the mainnet dialogs and the real-funds checklist before v0.2.0. Reviewer additions: the switch defaults off in a fresh data dir; `spend.ts` has no network literal and no policy setter; every mainnet row of the 12.1 table has a test and a mutant run by hand; R0-R11 reviewed before the owner uses them.

### 12.8 Docs and string changes (T4 unless noted)

- `docs/BSV-MODE.md`: header (no longer "testnet knowledge mode" alone); "What it does NOT do" (the sentence "`BsvNetwork` is the literal `testnet`; armed is a policy state that nothing consumes" goes); new "Spend" section: testnet flow, mainnet OFF by default and how the owner enables it, one arm one spend, dialogs, per-network limits, auto-off, unknown outcome, "has not been verified with real funds until the owner's check is recorded", "the wallet's own prompt is the last gate", tripwire pins including `networks.ts`; "Not built" and "Not verified" gain U11-U14.
- `docs/BSV-WALLET-DESIGN.md`: ladder row 4 and the "Mainnet: not designed here" paragraph point at this design; the threat row "A funded mainnet wallet on the owner's PC" describes switch plus arm plus wallet prompt; section 10 gains the U13 stop condition; section 12 records this decision.
- `SECURITY.md` (wallet and audit rows, "no spend tool" paragraphs), `README.md` BSV line, `docs/ARCHITECTURE.md` (route list: `/api/bsv/policy/mainnet`, spend routes): spend exists on two networks, mainnet off by default, same-user residuals unchanged, unverified with real funds.
- `CHANGELOG.md` `[Unreleased]`: Added mainnet capability (disabled by default), `POST /api/bsv/policy/mainnet`, per-network limits; Changed arming is one spend; Security note that the first real-funds check is the owner's.
- Strings in code: `NO_SPEND` and the arm, unfreeze, allowlist, caps and connect texts in `admin-logic.ts` (T3); `BSV_PREAMBLE` stays four lines and may say mainnet spends need the owner's switch, arm and dialogs (T2); `wallet-tool.ts` description and `renderWalletStatus`, and `MAINNET_WARNING` ("Legion will not use it" is false once enabled; becomes "Mainnet is switched off in Legion" or "armed use needs Arm") (T5); `ChainOverlay.tsx`, `BsvPanel.tsx` (T3); `seeds/bsv.json` pack version 8.
- `claude/legion-release-tracker.md`: item F gains T5, the real-funds check R0-R11 as an owner step, and the v0.2.0 gate of Q3.

### 12.9 Risks and open questions

Risks (to be written in the docs): the network is the wallet's claim and the signed bytes carry no network, so a rogue local listener claiming `main` can only produce cards the owner reads, behind switch, arm, allowlist and the wallet prompt; same-user malware is unchanged (it can click native boxes or call the wallet directly); approval fatigue is higher with two or three dialogs plus a prompt (mitigated by one arm per spend, tiny caps, short TTL); `bsv_status` taints nearly every run, so D3 appears almost always; a wallet that never prompts on mainnet (U13) would leave Legion's dialogs as the only gate (stop condition); fee levels are unknown until U14; the `policy.json` per-network shape is a one-way migration (T5 keeps a test that an old file loads as testnet).

Open questions (default in brackets; builders use the default unless told otherwise):
1. Mainnet default caps lower than testnet: 1,000 / 2,000 / 5,000 sat, fee ceiling 100, hard ceilings 100,000 / 250,000 / 500,000? [Yes. Your example 1,000 / 5,000 / 10,000 is also fine but leaves more headroom per click.]
2. One arm covers exactly ONE mainnet spend, then re-arm? [Yes. The alternative is a window of up to 60 minutes that lets several requests through.]
3. Is v0.2.0 gated on the real-funds check R0-R11 being recorded, or may it ship with mainnet built, reviewed and OFF, saying "not verified with real funds"? [Ship with the statement; the check follows and the docs are updated.]
4. A TAINTED run on mainnet: allow with the extra D3 dialog, or refuse outright? [Allow with D3; refusing would make mainnet unusable because `bsv_status` taints the run.]
5. Network source: the wallet's fresh claim pinned per request, or a Legion setting `spendNetwork` the wallet must match? [Wallet claim: switch, arm, per-network allowlist and the version byte already bind it; a setting adds a knob without adding evidence.]

## 13. Owner decisions on the mainnet amendment (2026-10-02)

Scope: mainnet capability IS in v0.2.0 (confirmed). Answers to 12.9, taken at the recommended defaults (assumed, not confirmed; the owner can overrule): 1 lower mainnet default caps 1,000/2,000/5,000 sat, fee ceiling 100, hard ceilings 100,000/250,000/500,000 [yes]; 2 one Arm covers exactly one mainnet spend [yes]; 3 v0.2.0 ships with mainnet built, reviewed and OFF, saying "not verified with real funds" until the owner's real-funds check R0-R11 is recorded [yes]; 4 a tainted mainnet run is allowed with the extra dialog D3 [yes]; 5 the network is the wallet's fresh claim pinned per request [yes]. T5 starts after T1 merges.

## 14. Amendment 2026-10-02 (owner): the owner's own wallet may be probed by hand
The rule "the owner's BSV Desktop (127.0.0.1:3321) is NEVER used for V0-V12 or any test" (section 9 item 7) and the handoff's 'NEVER connect' were NOT the owner's rule (they came from the handoff file). The owner authorised the orchestrator, on the owner's PC, to use the owner's desktop wallet to test, by hand, outside the repo. What stays: repo code, tests, scripts, harness and cloud agents never contact 3321 (hermetic tests, C24 guard stays); the wallet's own prompt is the last gate; anything that signs, spends or broadcasts needs the owner's explicit go-ahead for that action with amount and address, tiny amounts first. V1/V2 may therefore run against the owner's wallet (read-only calls first; an unsigned createAction must be followed by abortAction); the wallet is almost certainly MAINNET, so a testnet spend cannot be tested on it (network mismatch must refuse, which is itself a check); mainnet spends are the real-funds check R0-R11 and only with the owner's per-action go-ahead.

### 14.1 Real wallet facts (V0, 2026-10-02, by hand): BSV Desktop reports version 'wallet-brc100-1.0.0' (not semver), network 'mainnet', answers getVersion/getNetwork/isAuthenticated/getHeight with HTTP 200 and a JSON body labelled text/html, no prompt for these four methods; see claude/tracker-pc-checks.md 'V0 result'. Builders: A-assumptions about the version format and the content type are now FACTS; V1 (unsigned createAction then abortAction) is next and needs the owner's per-action go-ahead.

## 15. T3 second pass: facts, assumptions and unknowns (dialogs, Electron, panel)

Built on `claude/bsv-t3-second` against the fake core in tests (`test/bsv-spend-native.test.ts`, `test/electron-emu/run.mjs` scenario `spend`) and, where the real core already has the route, the real core (scenario `bsv`). T3 never touches a wallet: its only network use is the core on its own loopback port. Ids are `T3-A1..` so they do not clash with T2's wallet assumptions; the owner's checks are `ND1..` in `claude/tracker-pc-checks.md`.

### 15.1 Looked up (documented fact)
| Fact | Source | Used for |
|---|---|---|
| `dialog.showMessageBox` options: `defaultId` = "Index of the button in the buttons array which will be selected by default"; `cancelId` = the button that acts as cancel, default "the first button with 'cancel' or 'no' as the label", else 0; pressing Escape or closing the box returns the `cancelId` index; `noLink` stops Windows from turning common buttons into command links | Electron docs `docs/api/dialog.md` (https://github.com/electron/electron/blob/main/docs/api/dialog.md; www.electronjs.org was blocked by the session's egress proxy, so the raw file was read) | every dialog sets `defaultId` and `cancelId` EXPLICITLY (D2 has Cancel last, so the auto-detect is not relied on) and `noLink: true` |
| Address version bytes: mainnet P2PKH 0x00, testnet 0x6f; base58check = 4-byte double-SHA-256 checksum | already coded and tested in `src/core/bsv/networks.ts` (T5) | card and allowlist address checks in main reuse `addressNet` |
| Real wallet: reports `mainnet` for its network, version `wallet-brc100-1.0.0`, HTTP 200 with a `text/html` JSON body for the four read-only calls | V0 result (`claude/tracker-pc-checks.md`, plan 14.1) | panel text for "wallet on MAINNET"; nothing in T3 parses the wallet |

### 15.2 Assumptions, each a named fail-closed check in code and an owner check
| Id | Assumption | Named check in code (what happens if false) | Owner check |
|---|---|---|---|
| T3-A1 | On a real Windows desktop Escape and the window's X return the `cancelId` index | `confirmed()` in `admin-logic.ts` counts ONLY the one `confirmAt` index as yes; any other index, a throw or a non-number is no and sends `deny` | ND1, ND2 |
| T3-A2 | The default (focused) button and the button positions render as set: D1 Cancel first, D2 yes first and Cancel last and still the default | `spendLiveDialog` sets `confirmAt:0`, `defaultId/cancelId:1`; tests pin the numbers | ND3, ND4 |
| T3-A3 | The core's policy answer carries `mainnetEnabled`, `armed`, `remainingMs`, `nets.{test,main}.{caps,allowlist}` (T5 `snapshot()`) | `netAllowed()`: anything absent, mistyped or conflicting reads as "main not allowed" (card denied, no dialog); `mainnetState()` in the UI reads off | ND8 |
| T3-A4 | `POST /api/bsv/policy/caps` and `/allowlist` accept `net` and apply it to that network (plan 12.3; `index.ts` is T2's) | `netChangeProblem()`: after a 200 main compares the core's per-network answer with what the owner confirmed; a difference or no per-network answer for a main change is shown as an error and the panel is told the change did not take. FINDING for T2/orchestrator: a core that ignores `net` would apply the confirmed MAINNET change to TESTNET before main can notice; the route must honour `net` or reject unknown keys | ND9 |
| T3-A5 | `GET /api/bsv/spend/pending` returns `{cards, unknown}`; a card is the engine's `ApprovalCard` (outputs with `allowlisted`, `requiredConfirmations`, `networkLabel`, `hash`); an unknown item carries `net` | `parseSpendCard` / `parseSpendUnknown`: any other shape is refused and the request denied with no dialog (the spend route is a stand-in until T2 lands) | ND10 (with T2) |
| T3-A6 | Testnet addresses are `m`/`n` and mainnet `1` base58check P2PKH with the right version byte; the wallet's own testnet addresses match | `ADDRESS_RE` plus `addressNet(addr) === card.network` for card outputs and for every allowlist entry typed in the panel | V1 (real wallet addresses) |
| T3-A7 | After the last Legion dialog the wallet shows its OWN prompt (U13) | the dialogs only say "will show its own prompt next ... the last gate"; nothing in Legion can see it. If the wallet does not prompt, that sentence is false and the check ND10/R6 aborts | ND10, R6 |
| T3-A8 | The `mainnet-routes` route exists in the core (T2 registers it in `index.ts`) | the `mainnet-enable` request fails closed (404 shown as an error, switch stays off); emu tests that need the route are marked TODO and turn on by themselves when it exists | ND5 |

### 15.3 Unknown (owner-only)
Real Windows dialog rendering and focus (ND1-ND4); whether a real wallet prompt appears after D2 (U13); the real wallet's behaviour with a changed network between dialogs (T2's checks); the real unsigned-transaction shape (T2, V1).

### 15.4 What T3 does NOT protect
A same-user process can click native dialogs; approval fatigue (D1, D2, D3 and the wallet prompt); the network word is the wallet's own claim; the purpose text is the agent's own words; main trusts the core it started (a proven core of its own) for every card; an agent's ordinary tools are outside all of this.
