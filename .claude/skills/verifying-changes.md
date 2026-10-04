# Verifying a change actually works

**The failure this prevents: a green suite that proves nothing.**

On 2026-10-04 an adversarial review found that a test written to prove a compaction defect existed **passed against the
code with the defect**. The assertion was "the run finished", and the bug did not stop the run finishing. Thirty-four
other compaction tests were green throughout. The commit message claimed every test failed before the fix; one did not.

## When this applies

- Before claiming a change works, is safe to merge, or is ready to ship.
- Before you write a test that is meant to catch a specific known bug.
- When a test fails and you do not yet know why.
- When a suite is green after a large change.

## The rules

**1. Measure before you theorise.** A failing assertion tells you two values differ. It never tells you which values.
Print the thing itself — the request, the DOM, the file — not your model of it. Write a probe that imports the real
module and runs the scenario.

```bash
# Windows: a probe FILE, not node -e. Backticks and ${} in a nested shell string fail in ways
# that look exactly like product bugs.
node probe.mjs
```

**2. Prove your test fails without the fix.** Build the parent commit in a scratch worktree, copy the new test in, run
it there. A test that has never been observed failing is not evidence.

```
git worktree add -d a scratch folder <parent-sha>
cd a scratch folder && npx tsc -p tsconfig.json --outDir dist-old
node --test dist-old/test/the-new.test.js      # must FAIL
```

**3. Assert the discriminator, not the outcome.** "It finished" is satisfiable with the bug present. Ask: what can only
the fixed code produce? Here it was *"the summariser was asked to compress a conversation containing a tool row"* —
impossible for a pre-flight-only implementation, so it discriminates.

**4. Never refute a finding with a helper you have not read.** I dismissed a review finding by running
`firstConversationBreak`, which returned "valid". The finding was that the helper tracked ids in a **set**, so a row
landing between a call and its results neither matched nor rejected. It could not see the bug it was being used to rule
out. Before using a check as evidence: read what it inspects, and confirm it can *fail* on the input in question.

**5. A validator with a blind spot makes every assertion that uses it decorative.** If a helper has a known gap, assert
the property directly in the new test rather than leaning on it.

**6. Absence needs its own test.** The most expensive bug class here is a control or invariant that is *missing*, not
wrong: nothing fails, nothing throws, the suite is green. When a flow has states, assert what exists **in each** — the
update panel's staged state, the error path, the empty case.

**7. Check states, not just the happy path.** A control that disappears on a state change is invisible to any test that
exercises only the start.

**8. Load-sensitive failures are not regressions, but prove it.** A failing set that *changes between runs* is timing.
Check the durations, run the file in isolation, and compare against a baseline. `node --test` uses one worker per CPU
(16 here); `--test-concurrency=4` is the honest setting for suites that spawn processes.

**9. Record what a fix cost.** If a fix broke a pre-existing test, that test was asserting something you did not
intend. Find out what before you adapt the test — sometimes the old assertion was right.

## Reporting

State the counts against a baseline: "2489 tests, 3 fail — the same 3 that fail before the change", not "tests pass".
Name the failures. If a failure is unexplained, say so and stop; do not ship around it and call it done.

**If something is genuinely ambiguous, stop and say so plainly.**

## The flag that was two flags

The mid-run compaction had a single `compactedThisRun` meaning both *"a summary was produced"* and *"the retry was
spent"*. Sharing them disabled the rescue retry — which is needed **precisely** when the size estimate was wrong. The
code read correctly and the safety net was gone.

The fix was a separate `hard` flag, and forcing on the routine path then sent a conversation's own tool results into a
summary. So: **two meanings must never be one flag, however much tidier it looks.** For every boolean in a state
machine ask what question it answers, and whether two of them could ever disagree.

## Assert what would be LOST, not what was built

"A summary was produced" is not a claim. *"The decision made in turn two is still in the request in turn forty"* is.
For any feature whose failure mode is a silent omission rather than a crash, the end-to-end test must assert the
guarantee, not the function.

Checklist for such a feature:

- Drive the real thing end to end (real engine, fake provider), not the unit.
- **Assert preconditions before the claim.** Did a compaction actually happen? An assertion over an empty transcript
  passes forever and proves nothing. This caught a green "evidence" test that had never compacted once.
- Write the regression test at the level of the guarantee ("a compaction always has something to summarise"), not the
  level of the function.
- **When a test fails, decide whether the CODE or the TEST is wrong, and say which.** Several failures here were
  wrong premises in my own tests; fixing those is not the same as weakening them.

## Windows and tooling traps that produce phantom results

- **`node --test` dies instantly with "stdin is not a tty"** from a redirected/background shell. Use
  `--test-reporter=spec`, or `npm test`. A 19-byte output file and `exit=1` is a *refusal*, not a crash.
- **A `patch` tool that fuzzy-matches may silently reindent neighbours.** Pass `old_string` with the file's exact
  leading whitespace, or normalise the tail with a short node script. Then `write_file` refuses with "last read with
  offset/limit pagination" and you have lost the layout.
- **A cleanup script that edits source with a regex will eat a `return`.** Remove diagnostics with a targeted patch
  and re-read the file.
- **Use `fileURLToPath`, never `new URL(...).pathname`** — on Windows that yields `/D:/...`, the wrong drive.
- **Never kill processes by name pattern** on the owner's machine. Kill by PID.

## Do not let a review invent scope

A council reviewing a redesign returned a cut-list (drop the architecture diagram, cut the screenshot gallery) that
was never requested. A mockup is a sketch: absence of a section means "not drawn", never "remove it". Same for a
review finding — fix what was asked, and raise anything else rather than folding it in silently.

## Do not helpfully extend a feature past the ask

Copying a template was requested; filling the form fields with it was an addition, and the owner rejected it twice.
Add capability only when asked. The exception is a **missing control on a path the owner will actually walk** — if the
button they need does not exist, saying so is the deliverable, not a scope expansion.
