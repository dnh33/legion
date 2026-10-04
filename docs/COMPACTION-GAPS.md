# Where Legion's compaction is behind, level with, or ahead

Companion to `COMPACTION.md`. That document describes what Legion does. This one is the other half of the brief:
**a written list of behaviours the reference engine has that Legion does not, or does worse.**

Reading a solved problem is only worth it if you notice what your own stack could do better. So each item below is
marked honestly, and the "worse" column is not padded — where Legion matches or beats it, that is said plainly.

**Provenance:** the reference implementation is not named in this public repository. Ask the owner, or read
`D:/Aetherkeep/06-projects/legion/PRIVATE-context-engine-source.md`.

## Summary

| | Count |
|---|---|
| Applies here — a real gap, worth doing | **6** |
| Already handled differently — Legion's approach is defensible | 7 |
| Does not apply — no counterpart in Legion's shape | 5 |
| Legion is ahead | 4 |

The six that matter are below, ordered by how much damage the gap causes when it bites.

---

## A — Applies here: a real gap

### A1. No proactive re-check inside a run

**What the reference does:** the threshold is evaluated as the conversation grows, not once at the start of a turn.
A single run that makes 30 tool calls re-checks and can compact mid-run.

**Why it bites here:** Legion checks once, before turn 1, and then loops `maxTurns` (up to 200) without re-checking.
A run that starts just under the threshold can add megabytes of tool output and blow past the window with no second
look. The overflow retry catches it — so this degrades to *one wasted turn and a visible error* rather than data loss —
but it is a wasted turn the owner pays for.

**Status: CLOSED (2026-10-04).** `runToolLoop` now re-checks the live `messages` after each turn's tool results and
compacts when it crosses the threshold. Proven by `test/provider-compaction-gaps.test.ts`, "a run that grows past the
window mid-flight still finishes", which fails against the old code.

A note worth keeping, because it is arithmetic rather than opinion: **this gap was invisible to every test that existed.**
The window was checked once before turn 1 and never again, and 34 compaction tests were green throughout. The suite
proved the threshold arithmetic worked and said nothing about when it was consulted.

### A2. No proactive prune of large tool results

**What the reference does:** tool results over a size threshold are demoted to a one-line stub *before* the summary is
needed, keeping the newest few rounds at full size. This is a separate mechanism from summarisation.

**Status: PARTIALLY CLOSED (2026-10-04), and the measurement is the point.** Clipping each result existed; bounding
their *sum* did not. A turn of eight verbose tools measured **397,273 characters** — the overflow arriving through the
back door that per-result clipping was supposed to prevent.

Now a turn's whole tool output is bounded by `MAX_TURN_TOOL_CHARS`, scaled to the model's window with a floor of two
results' worth. The floor is load-bearing and was found by breaking C15: a budget smaller than ONE result deletes that
result, which is worse than any overflow.

What remains open is the reference's *demotion* — replacing an old result with a stub while keeping the newest few at
full size. Legion clips instead. That is a real difference, and it is the right next step: clipping spends the window
on 12k characters of output the model mostly does not need.

**What it would take:** when building the tail, replace tool results over N tokens with a stub naming the tool and the
call id. Cheap, and it composes with everything else here. A good candidate.

### A3. Image and non-text payloads are not specially handled

**What the reference does:** keeps the newest few image-bearing tool results verbatim and retires older image
payloads, even from inside the protected region.

**Why it bites here:** not at all today — Legion's provider tool loop is text-only (`textOf` in `tool-loop.ts`
converts non-text content to the literal `[non-text content left out]`). Provider-model agents have no vision tools
today. **This is a gap that has not opened yet**, and it is recorded so nobody discovers it as a surprise later.

### A4. Summary size is not checked against what it replaced

**What the reference does:** floors the summary at a minimum length, because a summary *shorter* than a trivial
amount of text is a signal the summariser failed rather than succeeded.

**Why it bites here:** partially covered. Legion falls back to the local extract when the summary comes back under 40
characters (`compactOnce`), and the breaker counts two non-shrinking compactions. What is missing is the floor on
*replacement size*: a summary can be 5,000 tokens where the turns it replaced were 400, and it will be accepted
because the conversation did technically shrink. The breaker catches the *repeat* case; a single bloated summary
still costs window on every subsequent turn.

**What it would take:** compare the summary's size to the middle's and fall back if the ratio is absurd. One
comparison, already computing both numbers for the effectiveness check.

### A5. No durability of the cooldown / breaker state

**What the reference does:** persists the failure ladder and the breaker, because the summariser object is rebuilt
often and an in-memory counter restarts at zero.

**Why it bites here:** `CompactionGuard` is a process-wide `Map`. On restart, every thread's cooldown resets — so a
provider that is down produces one summariser attempt per thread per restart rather than one. Not a correctness
problem (the transcript is untouched), but it is the reason the cooldown is weaker than it looks.

**What it would take:** persist alongside the task. **Deliberately deferred** — it would mean writing state into the
store, and this feature's whole design is that it rewrites nothing.

### A6. The threshold cannot be tuned per model

**What the reference does:** per-model threshold overrides plus a family catalog for context length.

**Why it bites here:** a single `contextWindow` per provider entry, clamped, with a conservative default. There was no
per-model lookup, so an owner running a 32k local model and a 200k hosted one off the same provider entry got the same
number for both. The direction is safe (compacting early costs detail, not runs), but it is not *right*.

**Status: CLOSED (2026-10-04).** `src/core/providers/data/model-windows.tsv` ships 466 models with their windows, and
`contextWindowFor(model, entryOverride)` resolves per MODEL, not per entry — one entry on an aggregator serves hundreds of
models whose windows differ by 60x. A snapshot rather than a runtime call, because compaction decides *before* the request
and a network call there fails exactly when a provider is already in trouble.

Precedence: the owner's value for the entry (a self-hosted model can differ from any catalogue) > the table, matched
exact then longest-prefix so `id:free` and `id:batch` resolve > the conservative default. Unknown means SMALL: over-
compacting costs detail, under-compacting ends the run. Covered by `test/provider-model-window.test.ts`.

**Measured consequence:** the old 32k default compacted a 1M-token model at 16% of what it could hold.

---

## B — Already handled differently, and Legion's way is defensible

| # | Behaviour | Legion's choice | Why that is not a gap |
|---|---|---|---|
| B1 | Rewrites the message store: soft-archive rows, insert compacted rows, re-sequence concurrent appends | **Rewrites nothing.** The transcript is already append-only JSONL | Legion has no reason to mutate history, and not touching it is what makes the lossless-failure path a one-liner. This is an *advantage*. |
| B2 | Originals archived with `active=0, compacted=1`, retrievable by a search tool | Originals never leave the transcript at all | Strictly better: there is no second copy to fall out of sync, and no re-sequencing race. |
| B3 | Summaries land in a session store with their own lifecycle | Summaries land **inline in the thread** as system messages | The decided choice. A knowledge-graph node would bury curated notes under machine churn, and the thread is where the next turn of the same conversation looks. |
| B4 | A dedicated summariser model, usually smaller and cheaper | **The same model**, no extra seat | One fewer knob and one fewer key. The cost — a weak model summarises badly — is bounded by the local fallback and the breaker. Worth revisiting if summaries are routinely poor. |
| B5 | Iterative update with the previous summary as explicit prior context | Same, via `summariserInput` | Identical behaviour, less machinery. |
| B6 | Micro-compaction with a cadence (`every_n_turns`) | **Off.** One batch compaction per thread, on threshold | The reference has it off by default too, for the same reason: every commit invalidates the prompt cache. Across 13 agents the per-exchange cost would be worse. Not a gap. |
| B7 | Many telemetry fields on every compaction attempt | None | Legion has no metrics sink. Not a gap; a missing *observability* story, which is different and is listed as a possible later item. |

---

## C — Does not apply

| # | Behaviour | Why not |
|---|---|---|
| C1 | Server-side / native compaction on supported routes | Legion's routes do not offer it. N/A. |
| C2 | Per-exchange micro-compaction | Off in both, deliberately. |
| C3 | A managed local runtime that grows the window instead of paying for a summary | No such runtime tier in Legion. |
| C4 | Restart-handoff decay detection (inferring "already compacted" from a resumed summary) | Legion's transcripts are local and append-only; a resumed thread finds its summary by the same scan as any other turn. |
| C5 | Pruning `[SKILL_PRUNED]` skill markers through summarisation | A concept from the reference runtime's own skill-pruning mechanism. Legion has no equivalent, and no marker of that kind can reach a summary here. |

---

## D — Where Legion is ahead

Worth writing down, because "we took their design" is only half the story.

1. **Lossless failure is structural, not a policy.** Legion's store is append-only, so "return the conversation
   unchanged" costs nothing and cannot desynchronise. The reference has to *make* that true with archive rows.
2. **The breaker is local and obvious.** `CompactionGuard` is one small class with a 60/300/900 ladder and a
   two-strike breaker. The reference's equivalent is spread across a durable-stores-and-refresh layer.
3. **Forced compaction cuts harder.** The overflow retry shrinks the tail budget to a quarter and halves the summary
   budget, because the estimator has *already* been proven wrong once. A retry that re-sends the same size would look
   like a working feature while doing nothing.
4. **The verification is an end-to-end claim, not a unit test.** `provider-compaction.test.ts` drives a real thread
   through the real engine against a fake provider and asserts a decision made in the first turn is still in the
   request afterwards. It caught two real bugs that every unit test passed — a causal-coupling rule that compacted
   nothing while reporting success, and a shared flag that disabled the rescue retry.

---

## The recommendation

**A2 (proactive prune of large tool results) first.** It is the only gap that can make a *single turn* exceed the
window before summarisation is even relevant, it is roughly ten lines, and it composes with the tail walk that
already exists.

Then **A1 (re-check inside the run)**, which turns the overflow retry from a rescue into a rare event.

A1, A2 (partly) and A6 are now closed. **A3** (image payloads), **A4** (summary size checked against what it replaced)
and **A5** (persisting cooldown state) remain open: each either needs a decision that belongs in its own session, or is
cheap-and-low-value. A5 in particular is a deliberate trade — the breaker is per-process, so a restart forgets it.

---

## C — How other production harnesses handle mid-run overflow

Checked because a design validated only against one implementation is a design nobody compared. Each row is a mechanism
that exists in a shipped product, and what it implies for Legion.

| Harness | Mechanism | What it implies |
|---|---|---|
| **Claude Code** | Five shapers run before *every* model call over the **live** `messagesForQuery` — per-tool-result budgets, snip, microcompact, read-time context collapse, then auto-compact. On `prompt_too_long`: collapse recovery, then reactive compaction, gated to once per turn. | **Legion matches the important part.** Compaction reads the live array, and the retry is spent once. Legion has one threshold where Claude Code has five graduated stages; that is simpler, not better, and the per-result budget is the stage worth copying next. |
| **OpenAI Responses** | Server-side compaction fires **mid-stream** at a threshold and emits an opaque compaction item carrying prior state forward. Docs: do not prune it — it is the canonical next window. | Not available on the routes Legion uses. Worth recording because it is the one mechanism that survives a *discontinuous* jump, which is exactly the case where Legion's rescue is the only defence. |
| **LangChain** | `SummarizationMiddleware` finds a safe cut point backwards so AI/Tool pairs stay together. Known bug #34794: summarising mid multi-step tool use strips `thinking` blocks and the next request 400s. | **The failure Legion hit, in the wild.** LangChain shipped `INVALID_TOOL_RESULTS` as a first-class error for exactly the invalid sequence the rescue here was producing. Lesson taken: pairing is a hard invariant, not a nicety, and worth an explicit guard — which `compactMessages` now has. |
| **Cline** | `ContextManager` recompiles the payload every turn; removes messages **in pairs**; always keeps the initial task message. One compact-and-retry per run on overflow. | Confirms the pair-removal and retry-once choices. Cline additionally *always* keeps the opening task — Legion decays that to zero after the first compaction, which is a deliberate difference: repeated early turns fossilise into every future summary. |
| **Cursor** | Self-summarisation trained into the model; large tool output written to a **file** the agent reads on demand rather than into context. | The demotion idea in A2, taken further: do not send it at all. Legion has no read-on-demand escape hatch, which is the largest remaining difference in this table. |
| **Dagu / Pydantic AI / Pi** | On overflow, age every tool result and retry **once from the live context**; snapshot only on `complete`; never replay a completed action. | **This is the bug Legion had.** All three explicitly guard against rebuilding a retry from a stale snapshot, and Cursor's forum has a real report of completed work lost to exactly that rollback. The fix in `compactMessages` is the industry-standard shape. |

**The transferable lesson, stated once:** every harness that gets this right compacts the **live** message array and
retries **once**. Rebuilding from a snapshot is the failure everyone converges on having made. Legion now does the
standard thing, and the test that proves it asserts what would be LOST — the tool result the run produced — rather than
that a function was called.

**Honest gap this table exposes:** Legion has no demotion-with-read-on-demand (Cursor), no thinking/reasoning blocks to
preserve (LangChain's #34794), and only one threshold rather than a graduated pipeline. The first is worth building; the
second does not apply until Legion sends thinking blocks; the third is a tuning question, not a correctness one.
