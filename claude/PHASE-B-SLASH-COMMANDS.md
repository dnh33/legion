# Phase B — slash commands research & plan (2026-10-04)

**Status:** RESEARCH DONE, NOTHING BUILT. Owner asked for `/steer` `/goal` `/subgoal` and a `/bug` command.
**`/bug` is DROPPED by owner decision — see the DROPPED section below. The remaining scope is B1-B4.**
**Source of truth for behaviour:** the Hermes checkout at
`C:\Users\Danie\AppData\Local\hermes\hermes-agent` (read-only reference; **MIT, Nous Research**).

Nothing here is committed or pushed. Worktree `D:\bots\legion-s5b`, branch `fix/s5b-full-access-approval-card`.

---

## What Hermes actually does (read from source, not guessed)

### The registry — the part worth copying
`hermes_cli/commands.py` → `COMMAND_REGISTRY: list[CommandDef]`. One declarative list, one
`resolve_command(name)`. `CommandDef` is a frozen dataclass carrying the whole contract per command:
`name, description, category, aliases, args_hint, subcommands, cli_only, gateway_only,
gateway_config_gate, busy_policy, busy_handler, execute, argument_mode, desktop`.

**`busy_policy` is the key field and Legion needs it most.** A command declares what happens when the
agent is mid-run: `dispatch` (run it anyway), `reject` (refuse with "Agent is running"), or
`interrupt_then_dispatch` (`/stop`, `/new`, `/reset`). Validated against `VALID_BUSY_POLICIES`.
Without this, every new command has to re-derive it.

Shared execution lives in `hermes_cli/slash_exec.py`: `CommandContext` in, `CommandReply{text, data, format}`
out, with an explicit invariant — *an executor's output depends only on `args`/`options`, never on the
surface*, so CLI/gateway/TUI render identically. `EXECUTORS` maps a command's `execute` string to a pure function.

### `/steer <prompt>` — the cheapest, highest-value one
> "Inject a mid-run note that arrives at the agent **after the next tool call** — no interrupt, no new user
> turn. The text is appended to the last tool result's content once the current tool completes."

Aliases `("s",)`, `busy_policy="dispatch"`, `busy_handler="steer"`.
This is the sharp idea: a running tool must not be yanked, and a steer must not become a user turn —
it rides along on the next tool result, which is already a natural boundary in the agent loop.

### `/goal <text>` — a standing objective with a judge loop
After each turn a **lightweight judge model** returns `done` / `continue` / `blocked`; on `continue` the
loop feeds a continuation prompt back into the same session. A **turn budget** (default 20,
`goals.max_turns`) bounds it. Any real user message preempts. State persists across `/resume`.
Adapted from Codex CLI's `/goal` (Eric Traut, OpenAI).

Subcommands: `status`, `pause`, `resume`, `clear`, `draft <text>`, `show`, `wait <pid>`, `unwait`,
`gate add|list|remove|clear`.

**Completion contracts** — the part that makes it more than a loop:
`/goal draft <text>` uses the aux model to expand a one-liner into a structured contract. Inline fields are
recognised by prefix only (`verify:`, `constraints:`, `boundaries:`, `preserve:`, `scope:`, `stop when:`,
`blocked:`), so a plain goal with an incidental colon is NOT mangled. Persisted in `SessionDB.state_meta`.

**Quality gates** — deterministic, and stronger than any judge:
`/goal gate add <cmd>` must exit 0 before the goal can complete. Gates run **before** the judge; if a gate
fails the judge is **not called** at all, and the gate's exit code + last ~3 KB of output become the
continuation prompt, so the agent iterates against the real failure. Bounded: 3 retries, 5-minute timeout,
then the goal auto-pauses. Re-run at every boundary — a stale result is never replayed.

**`wait`** — the judge sees the session's own live background processes and may return `wait`, which
**skips the turn entirely** (no judge call, no continuation, no turn consumed) until the process exits.
Capped at 30 minutes so a forgotten poller cannot park a goal forever.

### `/subgoal <text>` — mid-loop acceptance criteria
Appends a numbered criterion to the active goal. The continuation prompt gains an
"Additional criteria the user added mid-loop" block, and the **judge prompt is rewritten** so the verdict must
satisfy goal AND every subgoal. `/subgoal remove <N>`, `/subgoal clear`, bare `/subgoal` lists.
Requires an active `/goal`. Setting a new `/goal` replaces the goal and clears the subgoals.

### Access control
`gateway/slash_access.py` — admin vs user tiers; `/whoami` reports the caller's tier.
`gateway gate add` requires an explicitly configured gateway admin, but list/remove/clear stay available for recovery.

---

## How this maps onto Legion

### What Legion already has (reuse, do not rebuild)
| Piece | Where | Reusable for |
|---|---|---|
| Busy detection | `ui/src/chat/busy.ts` — `busyReason()`: `run`/`approval`/`other` | `busy_policy` decisions |
| Queue + queue runner | `ui/src/chat/queue.ts` (246 lines), `queueStore.ts` | `/queue`-like behaviour; the next-turn delivery path |
| Composer | `ui/src/components/Composer.tsx` | Where a `/` command is parsed |
| Per-task abort | `POST /api/tasks/:id/cancel` | `interrupt_then_dispatch` |
| Task continue | `continueTaskId` on `startTask` | The `/goal` continuation turn — **already exists** |
| Approval cards + `full` bypass | `core/approvals.ts` (S5b) | `/goal gate` must respect the same mode rules |
| Provider runtime | `core/providers/` | The judge needs a cheap model; Legion already has provider routing |

**The single biggest win: Legion already has `continueTaskId`.** The `/goal` loop is "judge, then start
another turn on the same task with a continuation prompt". The plumbing exists.

### What Legion does NOT have — verified, do not assume
- **No mid-run text injection, and the SDK does not offer one.** Checked
  `@anthropic-ai/claude-agent-sdk/sdk.d.ts` (the version Legion builds against):
  - `Query.interrupt()` exists (`sdk.d.ts:2847`) — that **kills** background tasks, it does not steer.
  - There is **no** `streamInput` / `setInput` / `submitMessage` / streaming-input mode on `Query`.
    Grep for `streamingInput` returns nothing.
  - The `PreToolUse` hook (`engine.ts:715`) returns `{ continue: true }` only. It observes via `noteToolUse`
    but **cannot append text** to the tool result the model will see.
  - `Engine` exposes no `steer`/`inject` entry point.

  **Consequence: `/steer` cannot be built the way Hermes builds it.** Hermes steers by appending to the last
  tool result's content — a capability Legion's SDK surface does not have. Three honest options, none free:
  1. **Queue-to-next-turn** (cheap, honest): `/steer` while busy appends to the existing queue, delivered as the
     next user turn. Not mid-run; say so plainly in the UI rather than pretending.
  2. **Tool-result rewrite** (closer to Hermes, needs SDK support): intercept the tool result in the engine and
     append the steer text. Requires a place to rewrite streamed tool results — verify feasibility first.
  3. **Abort-and-continue** (works today, heavy): cancel and restart the task with `continueTaskId` carrying the
     steer text. Loses the current turn's work-in-progress; must be labelled as such.

  **Recommendation: ship B1 first, then spike option 2 to find out whether it is possible, and fall back to
  option 1 with honest wording if it is not.** Do not promise `/steer` semantics Legion cannot deliver.
- **`/goal`-style state does not exist** on `Task`. No turn budget, no goal record, no subgoals.
- The **`hooks: { PreToolUse }`** object is the only hook; there is no PostToolUse hook. The `/goal gate`
  boundary is naturally a turn boundary, which Legion already models as a task transition.

### What Legion must add
1. `src/shared/commands.ts` — `CommandDef` + `COMMANDS` + `resolveCommand()`, mirroring the frozen-dataclass
   registry. One list, so `/help` and completion are derived, never hand-maintained.
2. Composer parse: leading `/word` → command; the rest is the argument string. Bare text stays a normal message.
3. `steer`: a pending-steer slot on the running task + injection at the **next tool boundary**. The engine
   already has a `PreToolUse` hook and an approval broker — the injection point is that hook.
4. `goal`: goal record (text, contract fields, subgoals, gates, turn budget, status) on the task; the judge;
   the continuation turn via `continueTaskId`.
5. `gate`: run a shell command at the turn boundary; on failure, skip the judge and feed the tail back.

### Legion-specific constraints (these are the design decisions)
- **Multi-agent.** A goal belongs to one agent. Legion must refuse `/goal` on an agent whose provider route
  has no judge model, rather than silently burning money.
- **Cost.** A judge is a model call per turn. Legion's existing `maxTurns`/budget guards must bound it.
  Default budget must be conservative; the owner pays.
- (The `/bug` zero-cost constraint is moot: `/bug` was dropped. See the DROPPED section.)
- **Do not re-implement `busy_policy` per command.** One helper, so `/steer` and `/goal` cannot disagree.

---

## `/bug` — original requirement and the options considered (SUPERSEDED — dropped below)

**Owner's words:** "send a bug report to my email, as long as my email can remain encrypted and hidden away
but this still works. The bug thing has to be something that when its not in use it takes 0 of anything. It
only lives when it's needed and waken up only to send that bug report securely."

Decomposed into hard requirements:
1. **Zero cost when unused.** No timer, no scheduled task, no resident model, no poll loop. Nothing that
   spends, wakes, or holds a connection while idle.
2. **Lives only when needed.** Cold-start on invocation; nothing persisted between uses except configuration.
3. **Email stays encrypted and hidden.** The address must never appear in the repo, in settings the UI renders,
   in a log, or in a crash report. Not plaintext-in-config.
4. **Wakes only to send.** One-shot: compose → encrypt → send → exit.

### The honest open question
"Encrypted and hidden" needs a decision I must not make silently. Three viable shapes, and they differ a lot:

| Option | How the address is hidden | What "hidden" costs |
|---|---|---|
| **A. Env var / OS keystore** | Address never written to Legion's disk; read at send time | Owner sets it once per environment; a fresh machine needs it again |
| **B. Owner public key** | Legion holds only a **public key**; mail is encrypted to it, so the ciphertext is useless without the owner's private key | Needs a keypair; the private key must live outside Legion |
| **C. Send-to-self relay** | Address lives in the relay config (outside Legion entirely); Legion only ever holds a relay token | Legion never sees the address at all — strongest, but needs an external service |

Option B is the one that matches "encrypted and hidden" most literally: **Legion physically cannot read the
address**, because it only holds a public key. But it needs the owner's keypair, and Legion would need an SMTP
or API path that encrypts.

**SUPERSEDED.** The owner was asked to choose between these and answered "Yes drop it" — the escalation
itself was the mistake. Kept as a record of what was considered and why none of it was needed.

---

## `/bug` — DROPPED. Owner decision 2026-10-04. Do not build it.

**Owner:** "Yes drop it."

**Why, so it is never re-proposed:**

The original ask was a `/bug` that mails a report to the owner, "encrypted and hidden", costing
nothing when unused. **I escalated that into three architectures** (OS keystore / owner public key /
external relay) and asked the owner to choose. That was the error, not the requirement.

Checked before dropping it:

- Legion's config lives in `%USERPROFILE%\.legion\config.json` (`src/shared/config.ts:88`) — **outside
  the repository**, and `.gitignore`d regardless.
- The repo is public, but an address in the owner's own home-directory config would never be in it.
- The actual threat is "the address leaks into a screenshot, a log, or a settings view" — not "someone
  with disk access reads it". For a single-owner desktop app on one machine, encrypting that string at
  rest buys nothing and costs a key-management subsystem the app would then have to be trusted to get right.

**The deciding argument is simpler than security.** A bespoke encrypted mail channel duplicates a
public, searchable issue tracker that collaborators already read, at zero cost, while adding a
secret-bearing field to an app whose security posture was just tightened (S5b).

**If it is ever re-proposed, the cheap version is ~30 lines and no crypto:** one masked settings field
(`d***@gmail.com`) in the existing config, one action, compose → transport → done. The "zero cost when
unused / wakes only to send" constraint is satisfied by *not having a background anything* — no timer, no
resident process, no schedule. That is the default shape, not a feature to engineer.

**Lesson recorded:** when a requirement is "encrypted and hidden", check what the threat model actually
is before proposing key management. Escalating a simple requirement into a crypto subsystem, and making
the owner arbitrate, is the same failure as S5b — finding a seam and presenting the space of
sophisticated answers instead of asking what the thing needs.

---

## Proposed build order (each its own release, per the D12 pivot)

Nothing below is built. Each step is small, testable, and independently releasable.

1. **B1 — the command registry + `/help`.** No behaviour, just the spine: `CommandDef`, `COMMANDS`,
   `resolveCommand`, composer parsing, and a `/help` that lists what exists. Everything after this is cheap,
   and it proves the parse path end to end before any of it can do damage. **Start here.**
2. **B2a — spike: can Legion inject text mid-run at all?** Not a feature. A throwaway experiment that answers
   the question in the "does NOT have" section above: can a tool result be rewritten before the model sees it?
   Output is a yes/no and, if yes, the mechanism. **Do not build `/steer` before this spike answers.**
3. **B2 — `/steer`, at whatever fidelity B2a proves is possible.** If mid-run injection works, match Hermes.
   If not, ship queue-to-next-turn and **say so in the UI and the tool description** — a `/steer` that quietly
   waits for the next turn is worse than one honestly named `/queue`.
4. **B3 — `/goal` + `/subgoal`.** The big one, and the one Legion is genuinely ready for: judge + continuation
   via the existing `continueTaskId` + a turn budget. Subgoals fold into the judge prompt. Ship **without**
   quality gates first.
5. **B4 — `/goal gate`.** Deterministic completion: gates run *before* the judge, a red gate means the judge
   is not called at all, and the gate's output tail becomes the continuation prompt. This is the piece that
   stops a goal loop burning turns on a vibe-based "done" — arguably higher value than the loop itself.
6. ~~**B5 — `/bug`.**~~ **DROPPED by owner decision 2026-10-04.** Not in scope. See the DROPPED section.

### Verification each step must pass
- The registry is the only source of truth: `/help` output must equal the registry, asserted by a test.
- A command's behaviour must be identical whichever surface invokes it (Hermes' surface-independence
  invariant). Legion has Composer + RoomComposer; assert they agree.
- No command may bypass `busy.ts`. One helper, one decision, tested. `busy_policy` per command, never re-derived.
- Every loop (`/goal`, `/goal gate`) must be bounded and must stop on a real user message. Test the bound.
- (Dropped with `/bug`.)
- A `/steer` that cannot actually steer must not be named `/steer`.