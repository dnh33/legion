# Part A review fixes (for Builder, branch fix/comms-efficiency, worktree D:\bots\legion-comms)

Source: Inquisitor review task_223849ed110d, 2026-10-06. b5c2ab1 and 4053562 are OK. 8b1f8a2 needs the fixes below before merge.
Add each as a new commit, written test-first (the test fails before the fix). Run the suite with LEGION_PORT unset. Known baseline: R5.6 (symlink) fails; a browser-module timing test is flaky.

1. **Double count (defect).** `sessionCost` (engine.ts:140) treats any lower total as a /clear. The SDK may report a total of 0 on crash or startup-error results.
   - Scenario: the session is at $2.00. An error result reports 0, so base becomes $2.00. The next good resume reports $2.30, and the task shows $4.30.
   - Fix: ignore the total on error results and on a total of 0.
2. **/clear loss (defect).** If the first result after a /clear is at or above the old total (old $0.50, new $0.60), the $0.50 is lost.
   - Fix: when Legion sends /clear, move the current total into base at that moment, instead of inferring a /clear from a drop.
3. **Mixed tasks (minor).** Provider runs add to costUsd (engine.ts:1010) but not to costSession, so the next Claude result overwrites them.
   - Fix: carry provider spend in base or in a separate field.
   - Also: the migration skips any task with a provider set, so a task with Claude history and a later provider run stays over-counted with no mark. Decide how to handle it.
4. **Nits.**
   - Bridge requests into a thread the owner has typed in should pass source 'agent' (bridge.ts:306/339).
   - A reply in a thread pinned to haiku or a full model id is forced to sonnet (router.ts:47). Keep the thread's current model.
