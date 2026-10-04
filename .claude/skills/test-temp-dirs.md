# Test temp dirs

## When this applies

- A machine's disk fills with `legion-*` dirs in the OS temp folder.
- You add or change a test that makes a temp dir.

## The rules

- **Never call `mkdtempSync(join(tmpdir(), ...))` directly.** Call `tempDir(prefix)` from `test/tmp-cleanup.ts`.
  *Why:* a raw call leaks one dir per test case; the helper removes the dir when the test process exits.
- **Clean up ownership-scoped.** `tmp-cleanup.ts` removes only the dirs its own process made.
  *Why:* `node --test` runs one process per file in parallel. Deleting "every `legion-*` dir" would race and delete a
  sibling process's in-use dir.
- **Verify by count, not by a green suite.** Run the full suite and count the temp dirs before and after. A fixed run
  adds zero. *Why:* a green suite passes with the leak.
- **A killed test process still leaks.** SIGKILL skips the exit sweep. Say so; do not claim full coverage.

## Failure modes

- A snapshot-and-diff cleanup deletes another test process's live dir. The result is a flaky test, which is hard to see.
- An auto-inserted import that lands inside an esbuild template string in a test fixture corrupts the fixture. Insert
  before the first real `import` line, then typecheck.
- A wedged `node --test` tree holds its dir for hours and holds the disk. Find it with a process scan for `--test`, then
  kill it by PID (`taskkill /PID <pid> /T /F`), never by name. Re-check that no `--test` process remains.

## Related

- `test/tmp-cleanup.ts` — the helper.
- `AGENTS.md` — the repository map and rules.
