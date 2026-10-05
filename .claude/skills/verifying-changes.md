# Verifying a change actually works

**A green suite proves nothing if the test cannot fail on the bug.** An assertion of "the run finished" passed against
code with the defect, because the defect did not stop the run finishing. Measure the discriminator, not the outcome.

## When this applies

- Before claiming a change works, is safe to merge, or is ready to ship.
- Before writing a test meant to catch a specific known bug.
- When a test fails and you do not know why, or a suite is green after a large change.

## The rules

**1. Measure before you theorise.** A failing assertion says two values differ; it never says which. Print the thing
itself — the request, the DOM, the file — not your model of it. Write a probe that imports the real module and runs the
scenario.

```bash
# Windows: a probe FILE, not node -e. Backticks and ${} in a nested shell string fail
# in ways that look exactly like product bugs.
node probe.mjs
```

**2. Prove your test fails without the fix.** Build the parent commit in a scratch worktree, copy the new test in, run
it there. A test never observed failing is not evidence.

```
git worktree add -d <scratch> <parent-sha>
cd <scratch> && npx tsc -p tsconfig.json --outDir dist-old
node --test dist-old/test/the-new.test.js      # must FAIL
```

**3. Assert the discriminator, not the outcome.** "It finished" is satisfiable with the bug present. Ask: what can
only the fixed code produce? Assert that.

**4. Never refute a finding with a helper you have not read.** Read what the helper inspects and confirm it can *fail*
on the input in question. A helper that tracks ids in a **set** could not see a row landing between a call and its
results — so it could not rule out the bug it was used against.

**5. A validator with a blind spot makes every assertion using it decorative.** If a helper has a known gap, assert
the property directly in the new test rather than leaning on it.

**6. Absence needs its own test.** The most expensive bug class is a control or invariant that is *missing*, not
wrong: nothing fails, nothing throws, the suite is green.

**7. Check states, not just the happy path.** A control that disappears on a state change is invisible to a test that
exercises only the start. Assert what exists **in each** state — staged, error, empty.

**8. Load-sensitive failures are not regressions, but prove it.** A failing set that changes between runs is timing.
Check the durations, run the file in isolation, compare against a baseline. `node --test` uses one worker per CPU;
`--test-concurrency=4` is honest for suites that spawn processes.

**9. Record what a fix cost.** If a fix broke a pre-existing test, that test asserted something you did not intend.
Find out what before you adapt it — sometimes the old assertion was right.

## Two meanings must never be one flag

Give a state machine one boolean per question. A single `compactedThisRun` meaning both "a summary was produced" and
"the retry was spent" disabled the rescue retry — needed precisely when the size estimate was wrong. For every
boolean, ask what question it answers and whether two answers could ever disagree.

## Assert what would be LOST, not what was built

"A summary was produced" is not a claim. "The decision made in turn two is still in the request in turn forty" is. For
any feature whose failure mode is a silent omission rather than a crash, the end-to-end test asserts the guarantee,
not the function.

- Drive the real thing end to end (real engine, fake provider), not the unit.
- **Assert preconditions before the claim.** Did a compaction actually happen? An assertion over an empty transcript
  passes forever and proves nothing.
- Write the regression test at the level of the guarantee, not the level of the function.
- **When a test fails, decide whether the CODE or the TEST is wrong, and say which.**

## Reporting

State counts against a baseline: "2489 tests, 3 fail — the same 3 that fail before the change", not "tests pass". Name
the failures. If a failure is unexplained, say so and stop; do not ship around it and call it done.

## Verify a report before relaying it

A subagent's report is a **self-report**. Its line numbers, its branch and its arithmetic are all claims. A report that
has not been verified is a hypothesis with citations; relaying it as fact is the same error as shipping unverified
code.

1. **Which branch and directory did it read?** Prove it with `git rev-parse --abbrev-ref HEAD` and
   `git worktree list`, then `git diff <branch-that-shipped> <branch-it-read> -- <files>`. An audit that read a topic
   worktree and reported `main` line numbers is wrong the moment the branches differ.
2. **Spot-check citations mechanically.** Extract `file:line -> token` pairs and grep each one; do not eyeball them.
3. **Re-derive the arithmetic yourself.** A subagent that found a real bug can still quote the wrong magnitude for it.

## Windows and tooling traps that produce phantom results

- **`node --test` dying with "stdin is not a tty"** from a redirected/background shell is a *refusal*, not a crash. Use
  `--test-reporter=spec`, or `npm test`.
- **A fuzzy `patch` may silently reindent neighbours.** Pass the file's exact leading whitespace, or normalise the tail
  with a short node script.
- **A cleanup script that edits source with a regex will eat a `return`.** Remove diagnostics with a targeted patch
  and re-read the file.
- **Use `fileURLToPath`, never `new URL(...).pathname`** — on Windows that yields `/D:/...`, the wrong drive.
- **Never kill processes by name pattern.** Kill by PID.
- **The exit code of a redirected `node --test` is not a signal.** Identical empty output returned 0, 0, 0 and 1
  across four runs. Trust the `ℹ pass N` / `ℹ fail N` lines or nothing.
- **The default reporter is NOT TAP.** `grep "^not ok"` matches zero lines on a run that executed nothing, which
  reads as a clean suite. Always grep for `^✖` and `^ℹ fail`, and require the counts to be present.
- **The full suite exceeds one tool call.** Batch it and check each batch reports counts:
  `ls dist/test/*.test.js | sed -n '1,40p' | tr '\n' ' ' | xargs node --test --test-reporter=spec`
- **Never run a build and a suite concurrently.** Two writers on `dist/` produce meaningless results, and the
  failure looks like a real test failure.
- **Test a fix against state written by the PREVIOUS version, not only state the fix wrote itself.** The one that
  keeps costing us. A `state.json` written before a feature existed has no field for it, so a fix keyed on that field
  reads "absent" and takes the branch nobody tested. Three times in one session: the shipped-trust manifest assumed
  a manifest the agent could rewrite; the rollback lock had no expiry for entries recorded before expiry existed; and
  the panel promised a date-driven release for a block with no recorded date, which could never arrive. All three were
  green against freshly-created state.
  **Write the old-shape fixture by hand, assert the new code does the safe thing with it, and keep that assertion.**
  "It works on a clean install" is not the claim being made.
- **Never measure a competing tool on a benchmark built to favour the incumbent.** Numbers that decide an architecture
  have to be adversarially fair or they are decoration. The caveat recorded beside
  `test/runtime-migration-tripwire.test.ts` is the worked example.
- **Pass native `D:/...` paths to `git worktree add`.** A `/d/bots/foo` argument creates a literal `D:\d\bots\foo`.

## Do not invent scope

Fix what was asked and raise anything else rather than folding it in silently. A mockup is a sketch: absence of a
section means "not drawn", never "remove it".

Add capability only when asked. The exception is a **missing control on a path the owner will actually walk** — saying
the button does not exist is the deliverable, not a scope expansion.
