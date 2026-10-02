# Independent review: merge/blender (local-first Blender) against integration/v1

Reviewer: independent agent, Linux cloud session. Head reviewed: `origin/merge/blender` at `fea34d2`. Branch not modified. Default verdict was "not fixed".
Everything below was read in code or run. Anything needing Windows or a real Blender is listed in section 6.

## Verdict: BLOCK (one blocker; the rest is SHIP AFTER FIXES quality)

The controls are well built and their tests are real. But the local runner is not connected to the running program, so local mode does not exist for a user.

## 1. Gates (Linux, Node, fresh `npm ci`)

| Step | Result |
|---|---|
| `npm run build:ts` | exit 0 |
| `npm test` | tests 1525, pass 1523, fail 0, skipped 2, cancelled 0 (the 2 skips: "real PowerShell" tests, no PowerShell here) |
| `npm run typecheck` | exit 0 (core and UI) |
| `npm run build:ui` | exit 0 |

Windows reference was 1552 tests / 35 skipped; Linux has fewer registered tests and fewer skips (blender-local-runner runs here because `python3` exists). I did not reconcile the 27-test difference; no Linux-only failure.

## 2. Findings, ranked

### BLOCKER

**B1. `LocalRunner` is never constructed in production.**
- `src/bin/legion-core.ts:68`: `createBlenderModule(moduleDeps, { vms, boatConfigured, log })`: no `local`.
- `src/core/blender/index.ts:43-46`: comment says the wiring "is added where local.ts lands"; it was not. `grep -rn "new LocalRunner\|createProcessPort" src` finds only the definitions (`system.ts:208`, `local.ts`). `opts.local` has no default (unlike `sandbox`, line 73).
- Effect: `lr = { ready:false, 'Local Blender is not available in this build.' }` (index.ts:139). Mode `auto` then goes to the VM or errors; mode `local` always errors. The upgrade notice and docs say scripts "now run on this computer", which is false. All local tests pass only because they inject fakes, so no test would ever catch this.
- Also: `dispose()` (index.ts:329) never stops a local child; the plan says core exit kills it.
- Wiring needs care: `LocalDeps.install` and `routeFacts()` are synchronous, but detection is async and cached. Before the first status call or `detect()`, `installs` is empty and local reads as "not found", so the first `blender_exec` after a core start would be routed to the VM. Await `detect()` before routing, or make readiness async.
- Fix: in `createBlenderModule`, default `local = new LocalRunner({ proc: createProcessPort(() => pickInstall(installs)?.path), config: cfg, install: () => pickInstall(installs), dataDir: deps.dataDir, workspaceOf })`, call `detect()` before `routeFacts` in guard exec/read, call `local.dispose()` from module `dispose`. Add a module test that builds the module with NO `local` option and a fake detect and asserts local is ready and used.

### MEDIUM

**M1. C7 test survives the plan's mutation.** Plan mutation "ignore the copy error": wrapping `copyFileSync(scene, dest)` at `local.ts:~343` in try/ignore leaves `blender-local` green (fail=0). The C7 failure test only plants a file where `backups/` should be, which fails earlier in `resolveFolder`. Swallowing the whole catch at `local.ts:374` is caught (red), so half of C7 is proven. Fix: add a case where `scene.blend` is a directory or otherwise uncopyable (do not rely on chmod: tests may run as root) and assert not spawned + `backup_failed`.

**M2. Runner script is not re-verified.** `runner.py` is written once per core start (`local.ts:353`, `runnerWritten`) and spawned by path every time. The agent script cannot reach it at Python level (guard), but Blender C-level writes are only governed by the static check (filter). Fix: rewrite every run (it is small) or compare its sha256 before spawn.

**M3. Task folder grows with no way to shrink.** `tmp/` (TEMP for Blender) and up to 5 backups are never cleaned (`local.ts` cleanup removes only script/result). `prepare` (line ~328) refuses a run above `maxTaskBytes` (500 MB) with "clear it first", but there is no Clear button (the plan defers it). A 100 MB scene plus 5 backups reaches the cap and the task is then permanently refused. Also the size check happens only before the run; on Windows nothing caps what a script writes during the 120 s (RLIMIT_FSIZE is POSIX only). Fix: empty `tmp/` after each run; count `backups` separately or prune by size; ship the Clear button or a refusal text that says where the folder is.

**M4. Hedge test lost coverage (task c).** Real strings mutated, the scan is red for: a real doc sentence turned into "safe sandbox" (H1), the UI copy (H2), `BLENDER_SAFETY_NOTE` ("fully isolated", H3), the `blender_exec` tool description (H4), "cannot be bypassed" in a code comment (H5), plain JSX text (H8). It stays GREEN (not caught) for:
- H6: a sentence split across two string literals joined by `+` ("Local mode runs on this computer " + "in a sandbox that is safe.");
- H7: JSX text containing `(`, `)`, `;` or `=`: `<p>Local mode on this computer is sandboxed (safe).</p>` (the JSX regex `[^<>{}();=]*` skips it);
- H9: a template literal with `${}` in the middle of the sentence (halves judged separately);
- H10: "Unlike the cloud VM, local mode on this computer is a safe sandbox." (a sentence naming VM/cloud is exempt from rules a/b; this exemption existed in the first version too).
By reading the first version (`fea34d2^`, whole code text, sentence split) H6, H7 and H9 would have been caught; I did not run it. So the (c) edit made H6/H7/H9 invisible. Fix: in code, scan the joined literal text per statement as well as per literal; allow `( ) ; =` in the JSX text regex (exclude only `<>{}`); tighten the VMISH exemption to "sentence that is about the VM only".

**M5. Extension verify step is loose.** `setup.ts` verify: regex for the word `mcp` anywhere in the `extension list` stdout AND `stdout.includes('1.0.3')` anywhere. Another extension with that version string passes; "enabled" is not checked. Fix: match the line of the extension (repo block, id, version together).

### LOW

- L1. `fs-safe.ts findLink`: depth 4 and 3000 entries, then returns null (fail-open). It guards the per-task folder where the script can create entries. Fail closed when the limit is hit.
- L2. Task-id collisions: `safeSegment` (exports.ts) and a copy `taskSegment` (guard.ts:157) map different ids to one folder (`a/b`, `a_b`; ids longer than 60 chars sharing a prefix). Two tasks share a scene. Include a short hash of the id in the segment; use one function.
- L3. `resolveMode` default branch: an unknown setting falls through to `live` (the loosest). `normalizeBlender` makes it unreachable today. Make the last branch explicit and default-deny.
- L4. Auto fallback text always says "Blender was not found on this computer" even when Blender is found but older than 3.0 (`readiness` note). The routing uses a constant; use `localNote`.
- L5. `local.ts:392,428`: `this.current` is cleared before the kill wait, so `dispose()` during a timeout kill does nothing. A stuck PID is compared with `process.kill(pid,0)` only (PID reuse can falsely block).
- L6. Output cap kill (`system.ts` spawnManaged) does not mark a stuck PID if `killTree` fails; only the timeout path does.
- L7. `exports.ts SAFE_NAME` allows Windows reserved device names (`CON.png`). Pre-existing (moved code).
- L8. Live path `backup_failed` is not a `completed` audit line (guard.ts ~391). Pre-existing; the checklist wording says one `completed` line "on every path". Local, VM and live-run paths are fine.
- L9. Audit `summary` stores the full script output (scrubbed only for known secrets).

### Polish
UI/doc wording is scoped and carries the required statements. `copy.ts` and `shared/blender.ts` agree. Docs keep "not yet tried".

## 3. Plan section 7 checklist, against the code

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Each control has a failing test under mutation | PASS except C7 | section 4 |
| 2a | no `process.env` spread in the local path | PASS | `local.ts` only reads names via `pick(host, name)` (line ~212); `buildEnv` returns a fresh object; test C11 proves keys. (`process.env` appears only as the default `host` argument, line 385, read-only) |
| 2b | no `shell:true` | PASS | `system.ts spawnManaged`: `shell: false`; setup `spawn/execFile` also no shell |
| 2c | no spawn outside `system.ts`; only the allowlist reason edited | PASS | `local.ts` calls the `ProcessPort`; `test/bsv-scan.ts` diff is the `system.ts` reason text only; tripwire tests green |
| 3 | `resolveMode` equals plan 2.3; no vm/local to looser | PASS | `guard.ts:54-82` read against the table; `blender-routing.test.ts` is the table row by row plus a no-loosening property; mutations C18a/b/c red |
| 4 | approval awaited before any directory or process | PASS | `guard.ts:315` await; folders only created in `local.ts prepare` (after `approved`, `guard.ts:337`); guard only resolves paths, creates nothing; test "C3 local" |
| 4b | `approved` before spawn; one `completed` on every path | PASS for local | `guard.ts:337` then `:343-358`: try/catch/finally around `local.run`, `completed` always written; "C4 local" test |
| 5 | local card: full script, line count, "On this PC", no key | PASS | `BlenderApproval.tsx` (full lines, `splitScriptLines`, badge "On this PC"); `ApprovalCard.tsx:39-41` only `D` works for Blender, no `A`; `countLines` shared (C20 red) |
| 6 | exports: `.blend` never in blender-exports | PASS | `exports.ts`; mutation C10/C10b red |
| 7 | config migration both directions | PASS | `normalizeBlender`, `mirrorSandbox`, `state.update`; C19 red; downgrade: local/auto mirror to `auto`, vm to `vm`, live to `off` |
| 8 | pin exactly as plan 5.2 + TODO OWNER PC | PASS | `shared/blender.ts` commit `91cd735c...` sha `eb0facf6...97fa5`; marker in `shared/blender.ts:147`, `docs/BLENDER.md:30,152`, `claude/tracker-pc-checks.md` B9 |

## 4. Mutation results (edit, run named test, revert; tree clean afterwards)

| Control | Mutation | Result |
|---|---|---|
| C5 | delete hash compare in runner | RED (blender-local-runner) |
| C6 | skip run/hash check | RED |
| **C7** | ignore the copy error | **GREEN = SURVIVES** (swallowing the whole catch: RED) |
| C8 | skip `markTainted`; remove closing-tag escape | RED / RED (incl. "C8 local") |
| C9 | write `live` for local | RED |
| C10 | `.blend` allowed in exports | RED (exports test and local test) |
| C11 | spread `process.env` into child | RED |
| C12 | never arm the hook | RED (5 tests) |
| C13 | skip network events; skip exec events; drop `--offline-mode` | RED / RED / RED |
| C14 | no kill on timeout | RED |
| C15 | remove the queue | RED |
| C16 | skip `findLink`; skip size cap | RED / RED |
| C18 | vm falls back to local; local falls to live; auto+local falls to VM | RED x3 |
| C19 | legacy `off` maps to local | RED |
| C20 | revert `countLines` (static-check test; guard test) | RED / RED |
| C21 | empty default sha (config test; setup test) | RED / RED |

## 5. Hunt results

- **Path traversal via taskId**: `safeSegment` keeps `[A-Za-z0-9_-]` only, 60 chars, no dots; test "task id cannot climb". Collisions: L2.
- **Task-folder links/races**: `prepare` resolves real paths and refuses links; race window is the stated limit. L1 for the fail-open scan.
- **Unbounded output/size**: output capped (4 MB, kill); folder cap only before the run (M3).
- **Hash bypass**: script is written as the exact UTF-8 bytes (CRLF kept); Python hashes the raw bytes; BOM strips only after the hash; lone surrogates encode the same on both sides. No bypass found.
- **Python guard path compare**: realpath + normcase + trailing separator, so `task1` vs `task10` is safe, case-insensitive on Windows, junction/symlink targets resolve (test "C12 link" on Linux); non-existent tails are resolved through the existing prefix; `os.symlink` checks only the link location, not the target (a link to outside can be made inside the task folder, but writing through it is refused and the next run refuses the folder, L1 aside). 8.3 names and real junctions: Windows only (section 6). Handlers/timers/atexit are banned by the static check, which matters because the guard is disarmed during the final scene save.
- **POSIX env**: PATH, HOME, LANG, TMPDIR, TEMP/TMP, `BLENDER_USER_*`, UTF-8 vars; no DISPLAY, no tokens.
- **Kill path**: POSIX group kill (detached), Windows `taskkill /T`; test C14 proves a child dies (POSIX). Windows: section 6.
- **Queue starvation**: one chain, timeout and 5 s kill wait bound each run; a wedged PID blocks later runs by design and says so.
- **Auto fallback**: only auto + no request + local impossible goes to the VM, with a note; L4 for the wording.
- **Taint**: `wrapOutput` marks taint, scrubs, escapes the closing tag for `source="local"`.
- **Upgrade notice**: shown when enabled, no `mode` key, effective mode auto; not shown to a freshly enabled bridge or any saved mode. It is untrue until B1 is fixed.
- **Extension install**: argv, order, stop-on-failure and legacy path for the community add-on all tested; M5.
- **Integration edits**: (a) the C21 block is closed and both sides are present; (b) C11 on Windows adds only OS-supplied variables to the allowed set, the leak checks (secret names, proxies, PYTHONPATH, tokens) are unchanged; `kernel32` is a valid library for the C13 dlopen attempt; (c) see M4.
- **Overclaiming**: no "safe/isolated/sandbox" claim for local in UI, docs, or source strings that I found; the only gaps are the test's blind spots (M4).

## 6. Only a real Windows PC with real Blender can verify

1. Everything in plan 6.2: `blender.exe -b` with the runner; glTF/FBX/OBJ exporters not broken by the C12 write guard; preview render.
2. Windows kill: `taskkill /T /F` removes `blender.exe` and children after a 120 s infinite loop.
3. Guard path compares with real junctions, 8.3 names, OneDrive-redirected Documents, user names with spaces/non-ASCII, paths near MAX_PATH (200-char refusal).
4. `--factory-startup` really keeps the community add-on (and its auto-start socket on 9876) from loading; `BLENDER_USER_*` names accepted by `blender --help`.
5. Windows env: Blender starts without APPDATA/LOCALAPPDATA; which variables Windows adds.
6. Extension install on Blender 5.1+: `extension build/repo-list/install-file/list` output format (`parseLocalRepoId` is a guess), `-e` persistence, global flags before `--command`.
7. Add-on pin sha reproduced (TODO OWNER PC B9); VM mode after the `exports.ts` move (B11).
8. Antivirus/SmartScreen on first spawn; `blender-launcher.exe` rejection with a real install.
