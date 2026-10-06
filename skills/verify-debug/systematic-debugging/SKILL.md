---
name: systematic-debugging
description: Use for any bug, failing test, broken build or surprising behaviour, before you propose a fix. Find the root cause first, change one thing at a time, and stop after three failed fixes.
license: MIT
metadata: { source: "https://github.com/obra/superpowers", commit: 5bf4e78011075bcfc0dc295f0724994cd123ee71, edited: "for Legion, 2026-10-06" }
---

# Systematic debugging

Adapted from obra/superpowers (MIT, Jesse Vincent). Edited for Legion.

**Rule:** find the root cause before you try a fix. A fix that hides the symptom is not a fix.

```
NO FIX WITHOUT A ROOT CAUSE FIRST
```

If you have not finished phase 1, do not propose a fix.

## When to use it

Use it for every technical problem: failing tests, wrong behaviour, build failures, slow code, broken integrations.

Use it most when:
- you are in a hurry (guessing feels fast, but it costs more),
- a "quick fix" looks obvious,
- a fix has already failed,
- you do not fully understand the problem.

Simple bugs have root causes too. Do not skip the process because the bug looks small.

## Phase 1: find the root cause

Do this before any fix.

1. **Read the error in full.** Read every line of the message and stack trace. Note file paths, line numbers and codes. The answer is often in the text you skipped.
2. **Reproduce it.** Find exact steps that trigger it every time. If you cannot reproduce it, collect more data. Do not guess.
3. **Check what changed.** Look at recent commits, new dependencies, config changes and differences in the environment.
4. **Instrument each boundary.** If the problem crosses components (build, script, service, database), log what goes into and out of each one. Run once. The log shows where the data goes wrong. Then dig into that one component.
5. **Trace the bad value backward.** See "Techniques" below.

Safe way to check an environment variable. Print only whether it is set, never its value:

```bash
# Print SET or UNSET for a named variable. Never print the value itself.
if [ -n "${MY_VARIABLE:-}" ]; then echo "MY_VARIABLE: SET"; else echo "MY_VARIABLE: UNSET"; fi
```

Never run `env`, `printenv` or `echo $SECRET`. Environment variables can hold keys and tokens. Log the name and SET or UNSET only.

## Phase 2: find the pattern

1. Find similar code that works.
2. If you copy a pattern, read the reference fully. Do not skim.
3. List every difference between the working code and the broken code. Do not decide that a difference "cannot matter".
4. Note what the code depends on: settings, config, other components, assumptions.

## Phase 3: one hypothesis at a time

1. Write one hypothesis: "I think X is the cause because Y."
2. Test it with the smallest possible change. Change one variable.
3. It worked? Go to phase 4. It did not? Write a new hypothesis. Do not stack more fixes on top.
4. If you do not understand something, say so. Ask the owner or research it.

## Phase 4: fix it

1. **Write a failing test first.** Use the simplest reproduction. A small script is fine if there is no test framework.
2. **Make one change** that addresses the root cause. No "while I am here" cleanups.
3. **Check the result.** The new test passes. Other tests still pass. The original symptom is gone.
4. **If the fix fails, stop and count.** Fewer than three tries: go back to phase 1 with what you learned. Three or more: stop and question the design.

### After three failed fixes

Signs of a design problem:
- each fix exposes a new problem somewhere else,
- each fix needs a big refactor,
- each fix creates new symptoms.

Stop. Ask whether the approach is sound. Talk to the owner before you try more fixes. This is a wrong design, not a bad hypothesis.

## Red flags

If you think any of these, go back to phase 1:
- "Quick fix now, investigate later."
- "Just try changing X and see."
- "Change several things, then run the tests."
- "I do not fully understand it, but this might work."
- "One more fix attempt" (after two failures).

## Excuses and the truth

| Excuse | Truth |
|---|---|
| "It is simple, I do not need the process." | Simple bugs have root causes. The process is quick for them. |
| "There is no time." | Guessing and re-trying takes longer. |
| "I will write the test after the fix works." | An untested fix does not stay fixed. |
| "Several fixes at once saves time." | You cannot tell which one worked. You add new bugs. |
| "I see the problem." | Seeing a symptom is not knowing the cause. |

## If there really is no root cause

Sometimes the cause is timing, the environment or an outside service. Then:
1. Write down what you checked.
2. Add proper handling (a retry, a timeout, a clear error message).
3. Add logging so the next failure is easier to study.

Most "no root cause" cases are an unfinished investigation.

## Techniques

**Trace backward.** Start at the failing line. Ask what called it and with what value. Keep going up until you find where the bad value began. Fix it there, not where it showed up. If you cannot trace by hand, add a log line before the failing call that prints the arguments and the stack (`new Error().stack` in JavaScript).

**Defence in depth.** After you fix the source, add checks at the other layers the data passes through. Validate at the entry point. Validate in the business logic. Guard dangerous operations in risky contexts (for example, refuse to write outside a temp folder in tests). Keep a debug log. One check can be bypassed. Several make the bug hard to bring back.

**Wait for a condition, not a delay.** Flaky tests often use a fixed `sleep`. Poll for the real condition instead (an event arrived, a file exists, a count reached 5). Always set a timeout and a clear error message. Re-read the state inside the loop. Use a fixed delay only when you are testing real timing, and write down why.

**Find which test pollutes state.** If a test leaves a file or state behind and you do not know which one, run the tests one at a time and check after each. Stop at the first one that leaves the mess.
