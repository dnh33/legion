# BSV mode: what it is today

BSV mode is an optional toggle in Settings, off by default, with the network fixed to testnet. This page is the plain truth about it; the pack lesson `bsv-status-today` says the same to the Assayer.

## What it holds

- The toggle (`src/core/bsv/`). Turning it on shows the Assayer bot, loads the bundled knowledge pack once into the Lattice scope `bsv`, and gives the Assayer a four-line preamble. Turning it off hides the Assayer and the scope again (the nodes are kept).
- The Assayer: approval `ask`, VM off by default, answer-only. It explains, drafts and reviews. A human does every wallet step, in their own wallet.
- The pack (`src/core/kg/seeds/bsv.json`, 157 nodes in 8 modules). Bots can read it and cannot change it; only you can. The Assayer reads it with `kg_recall` and `scope: "bsv"`.
- `bsv-status-today`, `bsv-wallet-choice` and the safety lessons. Lessons about a later wallet phase are marked **`props.built:false`**, start with "Design, not built in v0." and sit at confidence 0.6. The Assayer is told never to say those controls exist.

## What it does NOT do

No wallet, no keys or seed phrases, no signing, no broadcasting, no chain or wallet network call (nothing in `src/core` talks to port 3321 or imports `@bsv/*`; `test/bsv-tripwire.test.ts` fails the build if that changes). No spend caps, no approval card for spends, no audit log, no Freeze, no mainnet (`BsvNetwork` is the literal `testnet`), no Legion-owned bsv tool. While BSV is off the Assayer cannot be run at all: not from the app, not over MCP (`legion_run`, `legion_continue`, `legion_vm`), not by the HTTP routes that start a task or drive its VM.

## Pack versioning

The pack has a `version` (now 2). Loading stores it on the index node (`props.seedVersion`), and every seeded node gets `props.seedHash`, a hash of the title, body, tags and confidence it was seeded with.

- Nothing loaded: every node is added.
- An older version loaded (toggle off and on, or **Load BSV pack**): missing nodes are added, nodes you never edited take the new text, and nodes you edited are left alone and returned as `skippedEdited`. Edges are added, never removed.
- The same version loaded: nothing is written. A plain re-seed no longer touches your edits.
- A node the new pack dropped is never deleted or archived: that is your call. A snapshot of the graph log is taken before anything is written.
- "Edited" means the current text no longer matches the stored `seedHash`. An install from before hashes counts a node as untouched when it was never changed or still matches a text an earlier pack shipped (`seeds/bsv-legacy-hashes.json`). To take the pack text for a skipped node, delete the node in the Lattice and toggle again.

## Not built (design only)

Spend tool, spend caps, approval broker for spends, audit log and Freeze, native mainnet arming, VM boundary for wallet tools, the Legion-owned bsv tool, the wallet connection itself. The plan is in the pack lesson `bsv-wallet-choice` (BSV Desktop first, HandCash BRC wallet beta second, BSV Browser later; never Yours/Panda, the old Metanet Desktop, bsv-mcp or any wallet that holds keys for Legion; never grant a monthly limit or auto-pay; two-stage approval, Legion's card then the wallet's own prompt; originator `legion.local`; `@bsv/sdk` `WalletClient` only, not wallet-toolbox) and in the research note `bsv-wallets.md` kept with the project docs. None of it ships until you have reviewed the wallet phase.

## BSV pack refresh

A human release step, never a runtime fetch: nothing in Legion downloads pack text. To refresh, re-read the primary sources, edit `seeds/bsv.json`, bump `version`, and ship. Sources to re-check: the BSV Association docs hub (docs.bsvblockchain.org) and the BRC index (bsv.brc.dev), ts-stack (README, package manifests on npm: `@bsv/sdk`, `@bsv/wallet-toolbox`, `@bsv/simple`), the BSV Desktop repo and README (licence, ports, permissions), the HandCash BRC wallet docs, the Teranode repository and release notes (version, licence, networks), the Chronicle release page and node release notes (activation facts that are press-sourced), the ARC repository (bitcoin-sv/arc), and the 1Sat docs and SDK. Keep `props.verify` labels honest, keep controls that do not exist marked `built:false`, and run `npm test` (the seed tests refuse unmarked design claims and leftover Update/Correction paragraphs).
