# BSV wallet design, version 1: for owner review

Status: a proposal. Nothing in this document beyond rung 1 is built, and nothing beyond rung 1 ships until the owner has answered the questions in section 12. Written for Daniel (the owner) to read in one sitting; it says what is verified, what is guessed, and what can still go wrong.

Plain summary: Legion's BSV mode today can ask a wallet "are you there, and which network are you on?" and nothing else. The controls that a spending phase would need (caps, allowlist, expiring arming, freeze, a tamper-evident log, confirmation that comes from outside the window) are built and tested, but connected to nothing. This document proposes two more rungs, human-approved reads and a manual testnet-only spend, and lists everything that could go wrong with them.

## 1. The ladder

| Rung | What the Assayer can do | Status |
|---|---|---|
| 0 | Read the knowledge pack and explain BSV | Built (v0) |
| 1 | `bsv_status`: ask a loopback wallet four harmless questions (version, network, signed in, block height) | Built (this release) |
| 2 | Human-approved reads: one card per read, for example "total of spendable outputs" | Design only |
| 3 | Manual testnet spend: a two-stage flow, Legion's card first, then the wallet's own prompt | Design only |
| 4 | Anything on mainnet | Not designed. A separate review. Today "arming" is a policy state that nothing consumes |

Each rung adds a tool name, an allowlist entry in `test/bsv-scan.ts`, and a new owner review. The tripwire fails the build if wallet vocabulary appears anywhere else, so a rung cannot arrive by accident.

## 2. What exists today (rung 1 and the controls behind it)

| Part | File | What it does | Tests |
|---|---|---|---|
| Status probe | `src/core/bsv/wallet-probe.ts` | The only file that names wallet methods. Four methods, loopback only, no redirects, 1.5 s per call, 4 s total, 4 KiB body, one real probe per 5 s, single flight. No default address, and nothing is contacted until the owner presses Connect (in memory only). A version is shown only if it is valid semver | `bsv-wallet-probe.test.ts` (fake wallet on a random port; the wire is asserted) |
| Status tool | `src/core/bsv/wallet-tool.ts` | `bsv_status`, MCP server `legion_bsv`, Assayer only, six calls per task, result is untrusted text | `bsv-module-wallet.test.ts` |
| Policy engine | `src/core/bsv/policy.ts` | Caps, allowlist, output and fee limits, expiring arming, freeze, idempotent ids, injection guard, decoded approval card. Pure and synchronous. No "allow" verdict | `bsv-policy.test.ts` |
| Audit log | `src/core/bsv/audit.ts` | Append-only JSONL, SHA-256 chain, head anchor file, torn-tail tolerant, rotation that keeps the chain, redaction, a bounded reader over every log file for the time-ordered 24-hour ledger | `bsv-audit.test.ts` |
| Native confirmation | `src/electron/main.ts`, `admin-logic.ts` | Arm, unfreeze, limits, allowlist and Connect need a dialog worded by the Electron main process and a secret the window never holds; Freeze, Disarm and Disconnect do not | `bsv-electron-logic.test.ts`, `bsv-electron-emu.test.ts` (real core, stubbed Electron) |
| Static UI | `ui/src/bsv/`, `src/shared/bsv-view.ts` | No animation, 60 s focused-only poll, countdown only while armed, Freeze button, panel, Activity list | `bsv-ui-view.test.ts` |
| Tripwire | `test/bsv-scan.ts` | Wallet method names only in the probe file, only the four allowlisted names; any new network or process user fails until listed | `bsv-tripwire.test.ts`, `bsv-review-tripwire.test.ts` (plant cases) |

Three secrets exist and do different jobs. The MCP token (in `config.json`) can run agents and read state. The admin secret (stdin line 1, also given to the app window) opens every other route. The native secret (stdin line 2, held only by the Electron main process) is demanded by the core for every BSV policy change. A bot that reads `config.json` has the first only. A compromised page in the window has the first two but cannot change policy, because the change has to pass main's parser, sender check and dialog.

Defaults and ceilings (all in `policy.ts`; a policy file or route can lower but never exceed the ceilings):

| Limit | Default | Hard ceiling |
|---|---|---|
| Per transaction | 1,000 sat | 1,000,000 sat |
| Per session | 5,000 sat | 5,000,000 sat |
| Per rolling 24 hours | 10,000 sat | 10,000,000 sat |
| Outputs per transaction | 3 | 10 |
| Fee | 200 sat | 10,000 sat |
| Recipient allowlist | empty (no recipient allowed) | 50 entries |
| Arming | off; 5, 15, 30 or 60 minutes, memory only | 60 minutes |

## 3. Rung 2: human-approved reads

Purpose: let the Assayer answer "do I have testnet coins to run this exercise?" without ever seeing outpoints, scripts, keys or addresses.

Proposed tool: `bsv_balance` (name to be added to the tripwire allowlist with its reason).

- Input: none. Output: `{ network, totalSats, outputCount }` computed inside Legion. Legion calls the wallet's output-listing method for the default basket, sums the satoshis, and throws the rest away in the same function. No outpoint, locking script, tag, label or custom instruction is ever returned, logged or stored.
- Every call is gated by a card (in the app, one call at a time, no "always allow"): "The Assayer wants to read the total and the count of spendable outputs in your wallet." Denied after 120 s with no answer.
- The wallet may prompt as well. That is unverified (section 11). Legion's card never replaces the wallet's prompt, and Legion never presses it.
- It refuses unless a fresh status probe says the wallet is on testnet. A mainnet wallet never gets this call.
- The run is tainted by the answer, like any outside content.
- Audit: agent, task, tool, decision, and the rounded result class (none, some), never the amount's source data.

What is deliberately not offered at this rung: public keys (a key identifies the owner across sites), outputs by basket or tag, action history, certificates, anything that waits on the wallet's own window.

## 4. Rung 3: a manual testnet spend, in two stages

Purpose: so that the owner can run the testnet exercises in the pack end to end, with a human reading every transaction before a coin moves. Testnet coins have no value; the point is to prove the controls under real wallet behaviour before anything is considered for mainnet.

Proposed tool: `bsv_spend_request`. It does not spend. It starts a request that a person must complete.

Preconditions, all checked by code, in this order, and each recorded in the audit log whether it passes or not:

1. BSV mode on, and the chain not frozen.
2. A fresh status probe says the wallet is on testnet (checked again at stage 2).
3. The recipient is on the allowlist, exactly (no trimming, ASCII only, paymails compared case-insensitively).
4. Outputs, amounts and fee are within the caps, including pending and unknown reservations.
5. The transaction is decoded by Legion's own decoder, not described by the agent. The decoded inputs must equal outputs plus fee, so a mislabelled change output cannot hide a payment.
6. The request id has not been used before.

Stage 1, Legion's card. The card is built from the decoded transaction. The decision is made by the owner in a native dialog (the same mechanism as arming: main reads the card from the core by id, words the dialog itself, Cancel is the default). A run that read untrusted content needs one more explicit confirmation ("untrusted-content"), shown as a second button press, not a tick box. Expires in 120 s.

Stage 2, the wallet's own prompt. Only after stage 1, Legion asks the wallet to create exactly the transaction the card showed, bound by the card's hash. The wallet shows its own prompt and the owner approves there. Legion never approves a wallet prompt for the owner and never asks for a standing grant (no monthly limit, no auto-pay; the pack lesson `bsv-wallet-choice` says the same). Legion has its own deadline (proposed 120 s). When it passes, the outcome is "unknown", not "failed".

After the wallet answers, Legion records the transaction id, settles the reservation, writes the audit entry, and tells the agent only the transaction id and a status word.

Unknown outcome: a spend that was approved but not settled in 300 s (or interrupted by a restart or a freeze) is "unknown" and blocks every new spend until the owner resolves it with a native confirmation. There is no automatic retry anywhere (a wallet may have broadcast before the timeout).

Mainnet: not designed here. If rung 3 is ever extended, the arming state would be required in addition, and the card would say LIVE FUNDS. That needs its own document and review.

### The approval card

Everything on it is derived by Legion except the purpose line.

| Field | Source |
|---|---|
| Network and label | Legion (mode) and the wallet's fresh answer; mismatch refuses |
| Agent and task | The engine |
| Purpose | The agent's text, sanitised, one line, labelled "written by the agent, not verified" |
| Outputs | Legion's decoder: index, recipient, satoshis, BSV (8 decimals), payment or change, allowlisted yes or no |
| Fee | Decoder, in satoshis and BSV |
| Total leaving the wallet | Payments plus fee |
| Caps left | Per transaction, per session, per 24 hours, after this request |
| Warnings | For example recipient not on the allowlist, wallet network mismatch |
| Required confirmations | approve, untrusted-content, live-funds |
| Hash | SHA-256 over the content; binds the approval to exactly this card |

## 5. Threat model

Assets: coins in the owner's wallet (BSV Desktop at `127.0.0.1:3321` on the owner's PC holds a funded wallet, probably mainnet); the keys (never in Legion); the owner's attention (approval fatigue is a real attack); the integrity of the audit trail.

Actors and entry points:

- Text written to manipulate an agent: a web page, an inscription, an OP_RETURN, a token name, a transaction memo, a wallet's version string, a file, another bot's message.
- A malicious or buggy tool result (MCP server, plugin, generated code).
- Another program on the same computer, running as the same user.
- A bot that runs shell commands as the owner (the Assayer's Bash, in ask mode, needs approval; in full mode it does not).
- The owner, tired, clicking Allow.

### What each threat meets

| Threat | What blocks it | Residual |
|---|---|---|
| Prompt injection from chain data or a web page asks the agent to pay | No spend tool exists today. At rung 3: allowlist, caps, card, wallet prompt; a tainted run needs an extra confirmation | The owner can still approve a bad card. Mitigated by tiny caps and an exact allowlist, not eliminated |
| Injection asks the agent to reveal a key or seed | Keys never enter Legion; the preamble forbids it; comms refuse seed phrases; the scrubber redacts keys and seed phrases | A bot can still be talked into pasting something it read elsewhere; the redactor knows English BIP-39 only |
| Injection tries to change policy (arm, raise a cap) | Needs the admin secret and the native secret and a native dialog; the MCP token reaches none of it | A same-user process can read memory (below) |
| Malicious text in the audit log or a card (newlines, bidi, zero width) | Every field is sanitised on write and again on display; the log is JSON lines, one entry per line | None known |
| Amount confusion (BSV versus satoshis, 1e8 errors) | Integer arithmetic only; cards show both units; hard ceilings | None known |
| Recipient swap (homoglyphs, whitespace, case tricks) | Exact ASCII allowlist, no trimming | An allowlisted address the owner mistyped |
| Fee drain | Fee ceiling, conservation check (inputs = outputs + fee) | None known |
| Many small payments (salami) | Per-session and rolling 24-hour caps, pending counts | Caps are per Legion process, plus the ledger rebuilt from the audit log at start |
| Two requests racing under one cap | One synchronous check-and-reserve step | None known |
| Replay or blind retry of an approval | Idempotent ids, one-time ids, card hash, expiry, unknown-outcome blocking | None known |
| Approval fatigue | No always-allow, tiny defaults, a calm single card, freeze one click away | A person can still click through; that is human |
| A compromised window page fakes a card or presses approve | Approvals come from a native dialog worded by main from data main read itself | A same-user process can click the native dialog |
| Stolen MCP token | Opens only client routes; no BSV route | None for BSV |
| Same-user malware | Nothing in Legion can stop it (it can read memory, edit files, click dialogs, rewrite the audit log, call the wallet on 3321) | Real. Only a VM or a separate OS account stops it, and the wallet's own prompts are the last gate |
| A funded mainnet wallet on the owner's PC | Legion is testnet only; a mainnet answer gives a warning and Legion refuses to use it; no balance or output reads exist today | Any local program, including a bot with a shell, can call the wallet directly. The wallet's permission prompts and a small float are the defence |
| Probe retargeted by editing `config.json` (`bsv.walletUrl`) | Loopback only, no path or redirect, harmless fixed body; no default address; nothing is contacted until the owner presses Connect, and the native dialog names the address that will be used | A bot with file access can change the saved address, and the owner may confirm it without looking: four POSTs of `{}` then go to another loopback service. Low impact |
| Clock tricks against the arming expiry | Monotonic and wall clock must both agree | A suspended machine may make the monotonic clock lag; the earlier end wins, so it fails safe |
| Audit log tampering | Hash chain, in-memory head, head anchor file (catches a cut-off, emptied or replaced log at the next start), first-sequence detection, startup verification, freeze on failure | Tamper-evident, not tamper-proof: a same-user program can rewrite the whole file and every hash |
| Log growth or disk-full | Rotation, torn-tail tolerance | Disk full stops appends; policy changes then fail closed |

## 6. What each safeguard is for (one line each)

- Loopback-only, harmless-methods-only probe: nothing the Assayer says can make Legion's own code reveal keys or move funds (its ordinary tools, a shell or a web fetch, are outside that and rest on their approval cards).
- No "allow" verdict: every spend is a human decision; there is no code path to an automatic spend.
- Hard ceilings in code: a hand-edited file or a hostile route cannot raise a cap.
- Allowlist: a prompt-injected recipient is refused before any card.
- Synchronous reserve: concurrency cannot beat a cap.
- Idempotent ids and hash binding: an approval cannot be replayed or applied to different content.
- Unknown-outcome blocking: a timeout is never treated as "it did not happen".
- Expiring in-memory arming: restarts disarm; forgetting to disarm costs at most an hour.
- Freeze: one click from the pill, the panel and the tray; disarms, denies pending, blocks new.
- Native secret and dialog: a compromised window cannot change policy.
- Audit chain: after the fact, the owner can see who asked for what.
- The tripwire: a new wallet-shaped capability fails the build until someone writes down why.
- Static UI: the controls stay cheap enough to leave on and always visible.

### Changes after the independent review (fix round 1)

The review found no path that moves funds, and listed nine things to fix; each has a test. (1) The policy file is fingerprinted: its SHA-256 is recorded in the audit log on every Legion write, and a file that differs, has no record, or is unreadable loads as default limits, an empty allowlist and frozen (kept aside as evidence), and freezes a running core before the next read or change. (2) Text that claimed more than the code gives was rewritten, and a hedge check scans the panel, the dialogs and the docs. (3) The audit log has a head anchor; the rolling 24-hour window is rebuilt from every log file by entry time. (4) There is no default wallet address; the first contact is the owner's Connect, confirmed in a native dialog, in memory only. (5) A "changed" report from the wallet can only disarm. (6) The tripwire folds escapes and string tricks and refuses computed calls, `eval`, `Function`, `Reflect` and look-alike letters inside the BSV code. (7) A wallet version must be valid semver. (8) The policy engine copies everything on the way in and the stored decision on the way out. (9) Freeze works on a core with no app window (bearer token, because it can only stop things).

## 7. Residual risks the owner is accepting today

1. A program running as the owner can read the secrets from memory, click the dialogs, rewrite the log together with its anchor and the policy file's recorded hash, and call the wallet directly. Legion does not sit in front of port 3321.
2. The wallet's behaviour is unverified (section 11). Legion's safety does not depend on it, but its usefulness does.
3. The Assayer, like any agent, has the normal Claude tools. In `full` mode it can run shell commands without a prompt. BSV mode does not change that.
4. Caps are only as good as the allowlist and the owner's reading of a card.
5. Anything that Claude's own sandbox or the SDK does outside Legion's code is outside these controls.

## 8. Test plan and adversarial corpus

Already built (the full suite is 963 tests after fix round 1; main groups: probe, audit with the anchor and ledger, policy with clone-on-entry, module routes, Connect, policy-file tamper, Electron logic and emulation, UI view, the hedge check, and the tripwire plant cases): the probe against a fake wallet that records the wire; caps and races in the policy engine; chain tamper detection; native-secret gating through a real core; dialog cancel and confirm; a UI source guard that fails on animation or extra timers.

To add before rung 2 or 3 ships (each is a release gate; one failing adversarial test blocks release; the Inquisitor reviews independently):

- Injection corpus, 50 or more strings in chain data, memos, wallet version strings, room messages and fetched pages ("ignore previous", fake system tags, fake approval text, fake card JSON, base64 and zero-width disguised commands, instructions in other languages), run against the Assayer with a scripted model that obeys: the expected result is no spend request without an owner card, and no policy change ever.
- Cap bypass: negative, fractional, NaN, string, 2^53, 2^53+1, exactly at each cap, one over, split across outputs, change output relabelled as payment, duplicate outputs, outputs summing past the per-transaction cap, fee spoofing, request id reuse with different content, id collision, id of 7 and 65 characters.
- Races: 100 parallel requests under one cap; approve at the same tick as expiry; approve at the same tick as freeze; freeze while the wallet call is in flight; restart mid-flight; the same id twice in one tick.
- Full-approval mode: an agent in `full` mode must still produce the card; an MCP-started run must still be capped; a woken peer must not loosen anything.
- Recipient tricks: leading or trailing space, homoglyphs, uppercase paymail, null byte, very long strings, mixed networks.
- Wallet behaviour: hangs, trickles, returns a different network between stage 1 and stage 2, returns a different transaction id, returns garbage, returns a huge body, closes the socket mid-answer.
- Log abuse: newline and bidi in every field, a megabyte reason, concurrent appenders, torn tail, deleted tail, swapped lines, replaced head.
- Time: clock jump forward and back, suspend simulation.
- Window abuse (emulated): an IPC message from a foreign frame, from another window, with extra keys, prototype keys, in a flood; a second dialog while one is open.
- Static scan: every plant case in `bsv-review-tripwire.test.ts` stays red until fixed.

## 9. Rollout and kill switches

- Off by default; the BSV toggle hides the Assayer and disarms.
- Freeze in the pill, panel and tray.
- Deleting the new tool file removes the capability; the tripwire then goes quiet about it.
- Pack version 7 says in plain words what exists; the Assayer's preamble names its one tool and says it never asks for keys.

## 10. What would make me refuse to build rung 3

If BSV Desktop's own prompts turn out to be silent for the methods Legion needs (so that Legion's card is the only gate), or if its permission grants can be made persistent by an unsuspecting click, rung 3 should wait for a different wallet or a different design. Verify first with a throwaway testnet wallet in a VM, never the owner's funded one.

## 11. What is unverified

- BSV Desktop's behaviour: whether `getVersion`, `getNetwork`, `isAuthenticated` and `getHeight` prompt; what its permission prompts say; which origin rules apply (the origin is self-declared, so any local process can claim `legion.local`); whether the response shapes match Legion's parser (an unexpected shape is read as "network unknown", never as testnet).
- Whether BSV Desktop and the HandCash BRC wallet really both use port 3321 (the pack says so).
- How the wallet reports a testnet configuration and whether switching networks needs a restart.
- The Electron dialogs on a real desktop: the tests use a stub that records the options main passes (default button, text, buttons) and answers cancel or confirm.
- That `window.legion.bsvPolicy` survives a real sandboxed preload exactly as the emulation shows.
- Windows specifics (dialog behaviour with a hidden window, `taskkill`, `netstat`).

Legion has never been pointed at the real wallet. Every test uses a fake loopback server on a random port.

## 12. Questions for the owner

Answer these before rung 2 or 3 is built. My default is in brackets.

1. Do you want rung 2 (approved reads) at all, or is "is the wallet there and on which network" enough? [Skip rung 2 unless you want the Assayer to check for testnet coins.]
2. For rung 3, should the owner's approval be a native dialog (robust against a compromised window) or an in-window card (easier to read, longer text)? [Native dialog showing the decoded card.]
3. Which testnet wallet will you use to verify the real prompts: BSV Desktop in testnet mode inside a VM, or a separate OS account? [A VM. Never the funded wallet.]
4. Initial recipient allowlist: which testnet addresses or paymails? [Empty, so the policy engine would refuse every recipient until you add one.]
5. Are the default caps right for testnet exercises (1,000 sat per transaction, 5,000 per session, 10,000 per 24 hours)? [Yes.]
6. Should Freeze and Disarm stay dialog-free (one click) while Arm, Unfreeze and limits need the native dialog? [Yes.]
7. Is a 120-second card timeout and a 300-second execution window right? [Yes.]
8. Do you accept "unknown outcome blocks all spends until you resolve it" even when it is annoying? [Yes.]
9. Should the Assayer be allowed to run `bsv_status` without an approval card (today it needs one in ask mode, because the tool is not on Legion's trusted list)? [Keep the card until you have seen it used.]
10. Mainnet: confirm that nothing in rung 3 may ever touch mainnet, and that mainnet needs a separate review and document. [Confirmed.]
11. `bsv.walletUrl` is now set only by the owner's Connect (typed in the panel, named in a native dialog) and is never contacted before it. Do you also want the app to ignore a `walletUrl` edited in `config.json`, so that only Connect can set it? [Yes, if it is cheap.]
12. A same-user process is out of scope for these controls. Do you want a setup guide for a separate OS account or a VM for the Assayer? [Yes, as a later step.]
