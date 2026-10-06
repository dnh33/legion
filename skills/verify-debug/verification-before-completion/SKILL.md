---
name: verification-before-completion
description: Use before you say work is done, fixed or passing, and before you commit or open a pull request. Run the check, read the output, then make the claim with the evidence.
license: MIT
metadata: { source: "https://github.com/obra/superpowers", commit: 3be5aad3dd2400ef23b15680969f4bcd3b6d7b8b, edited: "for Legion, 2026-10-06" }
---

# Verification before completion

Adapted from obra/superpowers (MIT, Jesse Vincent). Edited for Legion.

**Rule:** evidence before claims. Always.

```
NO "DONE" WITHOUT FRESH PROOF
```

If you did not run the check in this turn, you cannot say it passes.

## The gate

Before you claim any status:

1. **Identify** the command that proves the claim.
2. **Run** the full command, fresh.
3. **Read** the whole output. Check the exit code. Count the failures.
4. **Compare** the output with the claim.
   - It does not match: report the real status, with the output.
   - It matches: state the claim and show the evidence.
5. Only then make the claim.

Skipping a step is not verifying.

## What counts as proof

| Claim | Needs | Not enough |
|---|---|---|
| Tests pass | Test output with 0 failures | An earlier run, "should pass" |
| Lint is clean | Linter output with 0 errors | A partial check |
| Build works | Build command, exit code 0 | "The linter passed" |
| Bug is fixed | The original symptom now passes | "I changed the code" |
| Regression test works | Red then green (see below) | The test passed once |
| Another agent finished | The diff shows the changes | The agent said "success" |
| Requirements met | A line-by-line checklist | "Tests pass" |

## Red flags

Stop if you catch yourself:
- writing "should", "probably" or "seems to",
- feeling pleased before you checked,
- about to commit or open a pull request without a check,
- trusting another agent's report,
- relying on a partial check,
- tired and wanting it over.

## Patterns

**Tests:** run the command, see `34/34 pass`, then say "all tests pass". Never say "should pass now".

**Regression test:** write it, run it (pass), undo the fix, run it (it must fail), restore the fix, run it (pass).

**Build:** run the build and read the exit code. A passing linter does not prove the build works.

**Requirements:** re-read the plan, make a checklist, check each item, report the gaps.

**Delegated work:** when another agent reports success, look at the diff yourself, check the changes, then report the real state.

## When to apply it

Before any claim of success or completion, any positive statement about the state of the work, any commit or pull request, any move to the next task, and any hand-off to another agent. The rule covers the exact words, paraphrases and anything that implies success.

If you could not run a check (for example it needs a tool or machine you do not have), say so plainly. Do not imply it passed.
