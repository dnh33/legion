# Review: claude/test-harness vs integration/v1

Reviewer stance: default "not fixed". Linux container, Node 22.22.0. No Windows, no real Claude/boat.dev/wallet/Blender.

## Verdict: SHIP AFTER FIXES (small; nothing blocks safety)

No safety rule is broken. The harness works as documented on Linux. The fixes are about a harness that can pass while checking nothing or while leaking a temp dir, and a few doc inaccuracies.

## Ranked findings

1. **MEDIUM - a scenario can pass with zero checks, and a leftover process/dir does not fail the run.** `scripts/harness/scenarios.mjs:380-396`: status is FAIL only when `run()` throws; `checks: 0` is PASS, and `cleanup` (pidsAlive / dirLeft) is reported but `ok` ignores it. I neutered `Check.eq` (line 20, `if (false) throw`): `core-task-run` + `mcp-token-limits` stayed green (ok=true failed=0). That is expected for a self-mutation, but the runner has no floor. Fix: FAIL when `t.checks.length === 0` and when cleanup left anything.
2. **LOW - `npm run harness -- ...` output is not pure JSON.** TESTING.md (section 3/4: "JSON result") and TESTING-BSV.md use `npm run harness`; npm prepends a `> legion@0.2.0 harness` banner, so piping to a JSON parser fails (I hit this). Document `npm run --silent harness --` or `node scripts/harness/legion-harness.mjs`.
3. **LOW - crash leaves a temp dir.** `kill -9` of the supervisor: the core exits (good, `disconnect` handler), fakes die, but `/tmp/legion-harness-XXXX` stays (supervisor owns the rmSync, `stack.mjs:~185`). TESTING.md says nothing about orphan cleanup. Document `rm -rf <tmpdir>/legion-harness-*` or have `start` sweep dead dirs.
4. **LOW - pointer file is last-writer-wins.** Two parallel `start` (without `--no-pointer`) share `<tmp>/legion-harness-current.json`; later commands without `--handle` hit the latest. Stacks themselves do not collide (separate dirs, random ports, own secrets; I ran two, drove each by `--handle`, stopped both clean). Docs mention `--no-pointer`; add "use it for parallel runs".
5. **LOW - core env is `process.env` minus `ANTHROPIC_*|BOAT_API_KEY|CLAUDE*`** (`stack.mjs:58-59`). Other secrets in the caller's environment (e.g. GitHub tokens) reach the core process. Nothing reads them (fake model), but an allowlist (PATH, HOME, TMP, SystemRoot) is safer. Also `HOME` is passed, so product `src/core/blender/system.ts:51` reads the real home dir for detection only (read-only, no write); `LEGION_HOME` is set so `~/.legion` is not used.
6. **LOW - scenario `bsv-readonly` sends a connect URL `http://example.com:8080`** (`scenarios.mjs:270`). Safe only because the product refuses non-loopback before any contact; if that control regresses, the harness itself would reach the internet. Use a `.invalid` host.
7. **INFO - doc stale text:** TESTING-BLENDER.md has section numbers out of order (the "3." procedure sits after "4."); TESTING-BSV.md likewise. Cosmetic.

## 1. Safety (checked)

- Port 3321 appears in exactly one harness file, `fake-wallet.mjs:12`, as the refusal guard (`grep -rn 3321 scripts/harness test/harness-smoke.test.ts docs/TESTING*.md`). The smoke test builds the number from parts (`33`+`21`). Fake wallet binds `127.0.0.1:0`, refuses the port, and destroys non-loopback peers; answers only getVersion/getNetwork/isAuthenticated/getHeight, everything else 404 + `offAllowlist`.
- Every address in the stack is 127.0.0.1. The only non-loopback strings are `example.invalid` (WebFetch, not executed by the fake model) and finding 6.
- Temp `LEGION_HOME` per stack; config.json gets a random authToken and a fake boat key (`harness-fake-boat-key`). No read or write of `~/.legion`; `/home-file` control route refuses paths outside the home (`stack.mjs`, `resolve` + prefix; symlinks not resolved, minor).
- Secrets: admin and native secrets are generated in the supervisor, piped on the core's stdin via the product's own `readLaunchSecrets`, held in memory. Harness `call` adds them only per auth class. Smoke test asserts no 64-hex in handle/config/logs.
- Gates untouched: `git diff origin/integration/v1...origin/claude/test-harness` shows nothing under `src/`, `ui/`, or `test/bsv*`. The only test added is `test/harness-smoke.test.ts`. No tripwire/hedge edits. The tripwire scans only `src` and `ui/src` (`test/bsv-scan.ts:52`), so `spawn`/`fetch` in `scripts/harness` and `test/` are outside it (same as the existing `test/` files); the harness spawns only its own supervisor and core.
- Docs edits: CLAUDE.md (one pointer sentence), ARCHITECTURE.md (tests line), package.json (two scripts). No weakening.

## 2. Truth (commands run as written)

- Gate: `npm ci` ok; `npm run build:ts` ok; `node --test "dist/test/*.test.js"`: **tests 1441, suites 5, pass 1439, fail 0, cancelled 0, skipped 2, todo 0** (matches TESTING.md section 12 exactly; the 2 skips are PowerShell off Windows). `npm run typecheck` ok (core + UI). I did not run `build:ui` (not in the requested gate).
- `scenarios --list` ok. Full `scenarios`: 11 scenarios, exit 0, all PASS, no leftover dirs or processes (`ls /tmp | grep legion-harness`, `pgrep`).
- TESTING-BSV.md section 4 by-hand sequence, run exactly: enable BSV 200; connect with admin only 403 `native_confirmation_required`; with `--auth native` 200 (`legionNetwork: testnet`, wallet saw only the four probe methods); token freeze 200; arm 409 frozen. All match the doc.
- TESTING-BLENDER.md: fake-blender `--version` prints `Blender 5.1.0`; `FAKE_BLENDER_VERSION=4.2.3` works; `--background --python x.py` logs the call and does not execute. `blender-guard/module/sandbox` tests: 80 pass, 0 fail; scenario `blender-off-and-fake-exe` PASS. The docs say honestly that local mode is PENDING and the stack does not point the Blender module at the fake.
- TESTING.md claims "harness works on Windows" (section 7 table): **unverified** (see 5).

## 3. Usefulness

Following only the docs, a zero-context agent can: build, list scenarios, run all, start a stack, drive the BSV testnet flow with the fake wallet and Blender fake, stop. Gaps: findings 2 and 3; no copy-paste for scripting the model from the CLI (needs a scenario or `lib.mjs`, doc says so); "PENDING" Blender/spend features mean there is nothing yet to test beyond the off-by-default bridge. Adequate.

## 4. Isolation and cleanup

Normal stop: pids gone, dir gone, pointer removed. Two parallel stacks: no collision (random ports, per-stack secrets and temp dir). `kill -9` supervisor: core exits, dir leaks (finding 3). Kill is by recorded PID only, never by name.

## 5. Windows

POSIX-only items: none fatal in code (`chmodSync` is try/caught; the fake blender is run as `process.execPath script`; paths use `path.join` and `fileURLToPath`; `#!` shebangs are inert on Windows). Risks to check on a real PC: `child.kill('SIGTERM')` and `process.kill(pid,'SIGKILL')` are hard kills on Windows, so the core's graceful `shutdown` (store flush) never runs and the "stop leaves nothing" path (`stopHarness`, EBUSY on `rmSync` of a dir a just-killed process holds) is untested; `detached` + `windowsHide` supervisor; the stdin-pipe secret handoff; the `harness-smoke` test; temp path with spaces or 8.3 names (`resolve`/`startsWith` check in `/home-file`); `tmpdir()` pointer. Only a real Windows PC can verify these; no result is claimed here.

## 6. Mutations (harness, reverted with `git checkout`; branch under review untouched)

| Mutation | Run | Result |
|---|---|---|
| `Check.eq` never throws (`scenarios.mjs:20`) | core-task-run, mcp-token-limits | stays green (shows finding 1: no floor) |
| `stack.mjs`: native header never sent | bsv-readonly | RED: `non-loopback refused ({"actual":403,"expected":400})` |
| `stack.mjs`: every auth class sends the admin header | mcp-token-limits | RED: `no bearer is 401 ({"actual":200,"expected":401})` |

The builder's product mutations (M1-M7 in TESTING.md section 12) were not re-run by me; only the harness-side ones above.

## 7. Full gate

See section 2: 1441 / 1439 pass / 0 fail / 0 cancelled / 2 skipped; typecheck clean.

## Not verified here

Windows (everything in section 5), real Electron, real Claude/boat.dev/wallet/Blender, `npm run build:ui`, the builder's product-mutation table.
