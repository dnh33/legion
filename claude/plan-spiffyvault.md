# Plan: SpiffyVault as a native wallet in Legion's BSV mode

Status 2026-10-06: DRAFT for owner review. Nothing built. Order agreed with the CI session: A2a, then SpiffyVault, then Release B (re-check with that session before SpiffyVault ships ahead of Release B).

## 1. Owner decisions so far

- "Native integration almost": avoid leaving Legion where possible; offer both paying from Legion and a SpiffyVault draft as options (2026-10-06).
- Token: memory only, pasted at Connect, once per launch (2026-10-06).
- Testnet only for this backend in v1 (SpiffyVault itself is testnet-only, v0.3.1).

## 2. Facts, assumptions, unknowns

| Documented fact (source) | Assumption (check that proves it) | Unknown (owner-only check) |
|---|---|---|
| MCP over HTTP at `127.0.0.1:47321/mcp`, bearer token `sv_mcp_...`, "agent access" toggle in the app (seen on the owner's PC, 2026-10-06) | A wrong or rotated token returns HTTP 401 (fake server test + PC check SV-2) | Whether the token survives a SpiffyVault restart |
| 12 tools; tool descriptions are the only docs (MCP `tools/list`, read 2026-10-06) | Response shapes match what a read-only probe returned: `get_balance` -> `{network, balance_sats, limits{single_sats, day_sats, week_sats, payments_per_hour, ask_above_sats}, spent{...}}` | Error shapes for refusals (over limit, unknown payee) |
| `pay`: recipient = contact name, SpiffyVault payment link, or BRC-100 payment key; no plain addresses; `request_id` is idempotent; above some amounts or to a new payee the owner is asked in SpiffyVault and `pay` returns `waiting_for_owner` after up to 55 s; owner has 10 min | `pay` returns a txid on success in the same answer (PC check SV-4) | What the SpiffyVault prompt looks like; whether it raises its window |
| `prepare_payment`: draft the owner sends in SpiffyVault within 24 h; SpiffyVault limits do not apply | | |
| `resolve_recipient{to, amount_sats}`: who it is, and whether `pay` would go through, ask, or be refused | The answer includes a stable identity key we can pin (PC check SV-3) | |
| `get_payment` by `request_id` or txid; `list_waiting_payments` with outcomes (waiting_for_owner, sent, declined, approved_and_paid, denied, expired) | | |
| Owner's wallet now: testnet, 99,998,662 sat, limits 100 single / 5,000 day / 8,000 week / 6 per hour / asks above 2,000; no contacts | | |

## 3. Design

### 3.1 Backend choice
One active wallet backend at a time in the BSV panel: "BRC-100 wallet" (today's) or "SpiffyVault". Switching disconnects the other. The BRC-100 path (`spend.ts`, `parseWalletUrl`, P2PKH allowlist) stays byte-for-byte unchanged; it is hash-pinned.

### 3.2 Connect
Panel: address (default shown as a placeholder, never contacted before Connect) + token field (password input, memory only). Connect runs through the native dialog like today. On connect Legion calls `tools/list` and refuses if any tool it needs is missing or its input schema differs (SpiffyVault is a beta; fail closed on API drift), then `get_balance` and refuses anything but `network: "testnet"`.

### 3.3 One spend, two ways to finish it (the owner picks on the card)
Agent calls the same `bsv_spend_request` tool (recipient, sats, purpose). For SpiffyVault the gates run in a new file, not in `spend.ts`:
1. Same synchronous gates as today: BSV on, Assayer only, run started by the owner, not frozen, no unknown outcome, sats in range, one in flight.
2. Recipient must be on the SpiffyVault allowlist (its own list: contact names / payment keys, exact match).
3. `resolve_recipient(to, amount)`: Legion pins the identity key it returns; the allowlist entry stores name + key, and a key change refuses (a renamed or re-pointed contact cannot redirect money).
4. Legion caps check-and-reserve (unchanged engine).
5. Native dialog, worded by main. Shows: recipient name + key prefix, amount (sat + BSV), agent's purpose (labelled unverified), Legion caps left, SpiffyVault limits left (from `get_balance`), and SpiffyVault's own verdict ("goes through" / "SpiffyVault will ask you too" / "SpiffyVault will refuse"). Buttons: **Cancel** (default) / **Pay from Legion** / **Draft in SpiffyVault**.
6. Pay from Legion: `pay(request_id = Legion spend id, wait_seconds = 30)`. Success -> txid, settle, audit. `waiting_for_owner` -> card says "Waiting for you in SpiffyVault", the reservation stays held, Legion polls `get_payment` by request_id for up to 10 min. Timeout, garbage, HTTP error -> unknown outcome, global lock (no retry). The resolve dialog offers "Check SpiffyVault" (a `get_payment` lookup) to fill in the answer; the owner still confirms.
7. Draft in SpiffyVault: `prepare_payment(request_id)`; reservation held up to 24 h or until `list_waiting_payments` reports sent/declined/expired.

### 3.4 What agents never get
- SpiffyVault's raw MCP tools. Never registered through the external-MCP provider or passed through; Legion refuses a `localhost:47321` external MCP entry and the docs warn against adding it by hand (it would skip every Legion control).
- Balance or payment history (that is rung 2, an open owner question). The agent sees only a status word and the txid.

### 3.5 Other rules
- Mainnet refused for this backend.
- Agent's note to the payee: not sent in v1 (it would leak agent text to a third party); Legion sends a fixed note "Legion payment <id>".
- `sv_mcp_` token shape added to the secret scrubber and redaction tests.
- Audit entries carry `backend: spiffyvault`; recipient stored as a hash, as today.

## 4. Blind spots and residual risks (say these in BSV-MODE.md)

1. **No independent check of what was sent.** With BRC-100 Legion decodes the transaction before the dialog. With SpiffyVault it cannot: Legion trusts SpiffyVault for the outputs and fee. The txid is shown; Legion has no chain access to verify it (the tripwire allows no outside fetch).
2. **The token is a spending key within SpiffyVault's agent limits.** Any program with it can call `pay` without Legion. Memory-only storage keeps it off disk on Legion's side, but SpiffyVault's own config and Claude Code's `claude mcp add` entry still hold it. The real cap is SpiffyVault's limits; keep them small.
3. **Two sets of limits.** The effective limit is the smaller one. The card shows both, so a refusal is never a surprise.
4. **"Never leave Legion" is not always possible.** A new payee or an amount above SpiffyVault's ask threshold makes SpiffyVault ask in its own window. Legion says so on the card before you click.
5. **Contacts can change.** Pinning the key at step 3 covers a renamed or re-pointed contact.
6. **Beta API.** Schema check at Connect fails closed; contract tests run against the fake server.
7. **Two dialogs for one payment** (Legion, then maybe SpiffyVault) adds fatigue; the card's SpiffyVault verdict keeps it predictable.

## 5. Tripwire and files (to agree with the reviewer)

- New file `src/core/bsv/spiffyvault.ts`: MCP client (SDK `StreamableHTTPClientTransport`, already a dependency; `redirect: 'manual'`, loopback only, own URL parser that allows the `/mcp` path). Needs its own `ALLOWLIST` entry (kind 'fetch', reason) and an `ALLOWED_WALLETY_TOOLS` review for any new tool name. No new tool name planned: SpiffyVault reuses `bsv_spend_request`.
- UI in `ui/src/bsv/` (own component); `Settings.tsx` untouched.
- Native dialog text in `src/electron/admin-logic.ts` (third button).
- Port 3321 nowhere.

## 6. Tests (fake SpiffyVault MCP server on a random port; each with a negative mutation)

Connect (wrong token, mainnet, missing tool, schema drift, redirect, non-loopback), allowlist and key pin, caps race, dialog buttons, pay success / waiting_for_owner -> approved / denied / expired, timeout -> unknown lock, garbage body, draft lifecycle, scrubber, raw-tool refusal, tripwire plant cases.

## 7. Real-PC checks (new, not W1-W6)

SV-1 Connect with the token; SV-2 rotated token -> clear error; SV-3 add a contact and pin it; SV-4 pay 10 sat from Legion; SV-5 new payee -> SpiffyVault asks; SV-6 draft and send in SpiffyVault; SV-7 SpiffyVault closed mid-pay -> unknown lock and resolve. Every payment is clicked by the owner. A recipient is needed first: a second SpiffyVault wallet or a friend's payment key.

## 8. Later (not v1)

Receiving payments (`request_payment`) for agents that sell work; mainnet when SpiffyVault supports it; BRC-181 if SpiffyVault adopts it.
