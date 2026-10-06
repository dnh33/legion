# BSV pack v10: source probe (2026-10-06)

Method: all 145 http(s) refs of the v9 pack fetched read-only by six parallel readers (curl, npm registry, Go proxy, GitHub raw and API). 7 refs are Legion-internal files (not probed). npmjs.com pages return 403 to scripts (registry used); DeepWiki pages return 429 (unreachable: bsv-src-ts-stack-deepwiki, bsv-src-batch3-repos, bsv-src-teranode and similar; their notes already mark them unverified). Plus brc100.org and the BRC-100 text.

## Moved or gone

| Ref | Status | Now | Done in v10 |
|---|---|---|---|
| github.com/bitcoin-sv/bsv-skills-center (+ raw README, SUMMARY, mockchain.md) | moved | bsv-blockchain/gitbook-bsv-skills-center, content identical | refs fixed |
| github.com/runonbitcoin/run | moved | runonbitcoin/run-sdk (README: no longer supported; GitHub archived flag false) | ref fixed |
| github.com/bsv-blockchain/wallet-toolbox (WalletPermissionsManager.ts) | archived 2026-06-12 | live copy in ts-stack/packages/wallet/wallet-toolbox | ref fixed, facts re-read |
| bsv-blockchain/ts-sdk, overlay-express standalone repos | archived 2026-06-12 | in ts-stack | notes already said so |
| bsvblockchain.org/?p=28986 | 301 to home page | home still shows the figures | not changed |
| github.com/sCrypt-Inc/scrypt-ts | 404, not in the org list | n/a | NOT changed (body wording "could not load" still true); candidate |
| coingeek 2024 Teranode article | page says live early 2025, not Q4 2024 | | wording fixed |

## Changed facts applied in v10

@bsv/sdk 3.0.0 and the cascade (2026-10-03): ts-stack-facts, overlay-packages, did-package, create-bsv-app-and-simple, 402-pay, wallet-toolbox-architecture, wallet-relay (0.5.2), message-box-client (SDK 2.8.0-2.8.5 reject valid PeerPay payments; paymentOutcome), ts-sdk-class-map. Teranode v0.16.0 stable (timeline, release-licence-networks). go-wallet-toolbox v0.189.0. BSV Desktop pins toolbox 2.14.5, port 2121 HTTPS plus 3321 HTTP fallback (desktop-toolbox-wiring, wallet-choice). BRC-69 (counterparty linkage removes BRC-2 confidentiality; corrected 2026-09-30), BRC-2 (raw X coordinate, tag), BRC-52 (now normative for fields/keyrings), BRC-140 (share positions random), wallet-toolbox permissions (grants never cached; signAction checks the reference; real-wallet-facts).

## Unchanged (checked, notes still right)

arc repo and docs, arcade, simple-mcp, 1sat-university (CC BY 4.0), BRC-22/24/26/28(minor)/29/30/35/36/48/53/57/62/64/67/74/77/87/88/95/96/101/103/104/105/116/120/121/151/160/161/176/179/181/204, ts-stack layers/packages/conformance docs, teranode docs (propagation, p2p, blockAssembly, utxo/alert, stores, networks), teranode-quickstart, bsv-claude-agents (OBSL v4, npm 1.2.0), bap (PROVISIONAL), mnee.io (issuer claims only), MNEE docs, chronicle (press-confirmed 7 Apr 2026 block 943,816).

## Not applied (candidates for a later pack; not in v10)

- 1sat-sdk: ~1,297 commits, packages 0.0.100+, sidebar says MIT but no LICENSE file on master (bsv-1sat-sdk, bsv-src-1sat-sdk).
- go-wallet-toolbox gaps: more documented (aborted status, spent inputs left spent on double-spend, 10 of 27 conformance vectors, 4 vs 19 monitor tasks); ts monitor task list longer than the note's (bsv-go-wallet-toolbox-gaps, bsv-wallet-results-delayed-broadcast).
- bsv-bsv20-bsv21: 1sat docs nav labels BSV-20 "(deprecated)". bsv-brc-status-map: BRC-28 now names BRC-29/105/121; BRC-31 has a status note (predecessor of 103/104).
- b-open-io claude-plugins: 24 bsv-skills (note says ~26), new plugins (bitplan, send-secret, sigma-auth).
- BRC index titles seen but not read: 177 (noSend expiry), 182, 166, 202, 203, 153-155, 164, 171, 172.
- go-sdk: possible "monorepo move" line not in README now (bsv-other-language-sdks); py-sdk 5,400+ tests.
- ts-stack README lists ~26 public packages, the note says 33 (agent could not find 33 in the README; stack-facts page agrees with 33). Unresolved.

## Contradictions with Legion design or existing behaviour claims (NOT rewritten; owner to decide)

1. (Withdrawn: a misreading, corrected by the BSV session after reading ts-stack `WalletPermissionsManager.ts` L1717.) ts-stack `ensureSpendingAuthorization` still returns without a prompt when a stored monthly grant has room left; "never cached or reused" refers to the removed per-request cache. The pack's "asks once, not again inside a grant" wording stands; real-wallet-facts is consistent with it.
2. Same sources: `signAction` is no longer a pass-through (reference-owner check, abort on error). real-wallet-facts updated; the bsv-safety-real-wallet-facts "Not yet observed" line unchanged.
3. BRC-219 (wallet/0219): apps should not time out permission-pending requests. The BSV session proposed, and the owner picked from three options in the question UI on 2026-10-06, that Legion follow it with a safety cap; the 15-minute value is the BSV session's proposal and stays open until the BRC research is in (wallet-no-answer after that); the note says so. Note: BRC-219 also says status probes must not prompt (matches the observed read-only probes).
4. HandCash docs: a monthly cap from the manifest does not by itself enable silent payments (auto-pay is a separate user switch). bsv-wallet-choice: "a monthly limit removes the wallet's per-spend ask" may not hold for HandCash. Left unchanged.
5. brc100.org / BRC-100 text: no way for a wallet to authenticate a local non-browser app is defined, no rule for createAction vs signAction prompts, no spending-grant format, no decline code. Written as "left open" in bsv-brc100-originator-permissions; bsv-safety-real-wallet-facts old sentence "the specification says nothing about user prompts or decline codes" corrected (the text does mention originator authentication and seeking user permission).
6. Ports: BSV Desktop README says HTTPS 127.0.0.1:2121 with HTTP fallback 3321 (a source comment says 3321). The owner's by-hand probe used 3321. Pack now says so; wallet-choice's "both use 3321" kept as "fallback".
7. Pack note bsv-safety-ts-stack-server-keys said Legion "sets no spending limits": fixed (testnet defaults given; mainnet lower).
