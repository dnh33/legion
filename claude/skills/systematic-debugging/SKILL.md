---
name: "systematic-debugging"
description: Use for any bug, failing test, broken build or surprising behaviour, before proposing a fix, and immediately when a fix has already failed. Root cause first, one change at a time, stop after three failed fixes.
---

# Systematic Debugging

Adapted from the Superpowers skill library by Jesse Vincent (MIT, see LICENSE). It is the discipline layer; a generic `/debug` report template, if installed, is the paperwork layer. Use both.

## The iron law

**No fix without a root cause.** Seeing the symptom is not understanding it. If you cannot yet say "X is the cause because Y, and here is the evidence", you are still in Phase 1.

This matters most exactly when it feels least necessary: the bug looks trivial, time is short, or one fix already failed.

## Phase 1: Investigate

1. **Read the whole error.** Full stack trace, line numbers, codes, and the warnings above it.
2. **Reproduce it reliably.** If you can't, gather more data; don't guess.
3. **Check what changed.** Diff, recent commits, dependencies, config, environment, and the project's own known-issues log if it keeps one.
4. **At component boundaries, instrument before theorising.** In a pipeline (UI → API → DB, build → package → deploy), log what enters and leaves each layer, run once, and let the evidence show which boundary breaks. Log presence and shape (`SET`/`UNSET`, lengths, types), never secret values.
5. **Trace bad data backwards** to where it first goes wrong, and fix it there, not where it finally explodes. See `root-cause-tracing.md`.

## Phase 2: Compare

Find something similar that works, in this codebase or the reference implementation. Read the reference completely rather than skimming it. List every difference between working and broken, including the ones that "can't matter".

## Phase 3: Hypothesise

State one hypothesis in writing. Test it with the smallest possible change, one variable at a time. If it is wrong, form a new hypothesis; don't pile a second fix on top of the first. If you don't understand something, say so.

## Phase 4: Fix

1. Capture the bug in a failing test or a one-off reproduction script first.
2. Make one change that addresses the root cause. No bundled refactors, no "while I'm here".
3. Verify: the reproduction now passes, nothing else broke, and the original symptom is gone in the real environment. Apply `verification-before-completion` before calling it fixed.

## The three-fix rule

Count your attempts. After a failed fix, go back to Phase 1 with the new information. **After three failed fixes, stop.** When every fix uncovers a new problem somewhere else, the design is wrong, not the latest line. Explain the pattern to the owner and discuss the architecture before attempt four.

## Red flags: return to Phase 1

- "Quick fix now, investigate later."
- "Let me just try changing X."
- Several changes before one test run.
- "It's probably X" with no evidence.
- Listing fixes before tracing any data.
- The owner asking "is that actually happening?" or "stop guessing".

## When there truly is no root cause

Timing, environment or an external service can be genuinely at fault. Then: write down what you ruled out, add handling (retry, timeout, clear error), and add logging so the next occurrence leaves evidence. Most "no root cause" verdicts are an unfinished investigation, so be sure before reaching for this.

## Supporting techniques

- `root-cause-tracing.md`: walk a bad value backwards through the call stack.
- `defense-in-depth.md`: once the cause is fixed, add validation at the layers that let it through.
- `condition-based-waiting.md`: replace sleeps and arbitrary timeouts in flaky tests with condition polling.
