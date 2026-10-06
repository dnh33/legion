# Testing Legion (guide for agents, local or cloud)

Read this one page and the small harness under `scripts/harness/` and you can: understand what Legion is and how its parts fit (section 1), test it end to end without spending money, without a real Claude call, without a real boat.dev, without any real wallet and without Blender (sections 4 to 6), and know what can be verified where and what only a person can verify (section 7). Specifics for the two risky areas are in [TESTING-BSV.md](TESTING-BSV.md) and [TESTING-BLENDER.md](TESTING-BLENDER.md). The hard rules for agents are in [CLAUDE.md](../CLAUDE.md); they apply to everything below.

Wording note: when this page says a test "proves" something it means Legion's own code, in the fake setting described. It never means the real Claude, the real boat.dev, a real wallet or real Blender.

## 1. What Legion is, in one minute

A local, Claude-only multi-agent desktop app. One Node process (**core**, `src/bin/legion-core.ts`) owns all state and side effects and listens on `127.0.0.1:4747`. An Electron shell (`src/electron/`) starts it and hands it two per-launch secrets over stdin; the React UI (`ui/`) talks to it over HTTP and SSE. Agents are Claude Agent SDK runs (`src/core/engine.ts`). Optional parts plug in as modules (`src/core/modules.ts`): the Lattice/Library knowledge graph (`kg/`), the rooms and bot-to-bot bridge (`comms/`), BSV read-only mode (`bsv/`) and the Blender bridge (`blender/`). Per-agent cloud VMs live on boat.dev (`boat.ts`, `vm-manager.ts`). Full detail: [ARCHITECTURE.md](ARCHITECTURE.md).

```
caller --HTTP--> server.ts --gate (admin.ts)--> routes
                     |                              \
                     |                               modules: kg, comms, bsv, blender  (routes + in-process MCP tools per agent)
                  Engine --queryFn--> Claude Agent SDK query()     <- the scripted model replaces this in tests
                     |--> ApprovalBroker (cards)    |--> VmManager --> BoatClient --> boat.dev REST    <- fake boat in tests
                     `--> Store (JSON files)        `--> bsv wallet probe --> loopback wallet          <- fake wallet in tests
```

The three trust classes you will keep meeting:

| Caller | Credential | Reaches |
|---|---|---|
| Anyone | none | `GET /health` only |
| MCP-class client (Claude Code, Cowork, a bot that read `config.json`) | `Authorization: Bearer <authToken>` | `/mcp`, the short client list in `src/core/admin.ts`, and BSV Freeze. Tasks it starts run under an `ask` ceiling |
| The app window | bearer + `X-Legion-Admin: <per-launch secret>` | every other route |
| Electron main, after a native dialog | bearer + admin + `X-Legion-Native: <second secret>` | BSV policy changes (arm, unfreeze, caps, allowlist, Connect) |

## 2. Product-to-test map

Tests are `node:test` files in `test/*.test.ts`, compiled to `dist/test/*.test.js`. Where several files cover one area they are grouped by prefix. A file named `*-review*` or `*-fix*` is a regression or review-round suite for the same area.

| Area | Source | Test files |
|---|---|---|
| Engine, run loop, taint, MCP ceiling | `src/core/engine.ts`, `tainted-paths.ts`, `model-cap.ts` | `engine`, `catalog`, `doctor`, `mcp-isolation`, `token-v1-core`, `token-v1`, `token-v1-fix`, `token-v1-fix2` |
| Router (auto Sonnet/Opus) | `router.ts` | `router` |
| Approvals | `approvals.ts` | `approvals` |
| Store and migrations | `store.ts`, `shared/config.ts`, `settings.ts` | `store`, `store-migration`, `settings`, `roster`, `no-key-literals` |
| HTTP server and admin gate | `server.ts`, `admin.ts`, `sse.ts` | `server`, `token-v1-*`, `vm-fixes-http` |
| MCP tools for Claude Code/Cowork | `mcp-tools.ts`, `mcp-status.ts`, `bin/legion-mcp-stdio.ts` | `mcp`, `mcp-isolation` |
| Agent bridge (`ask`/`tell`) | `bridge.ts`, `agent-tools.ts` | `bridge`, `bridge-model` |
| boat.dev client, VMs, key probe | `boat.ts`, `boat-health.ts`, `vm-manager.ts`, `shared/vm-usage.ts` | `boat`, `boat-lazy-probe`, `vm-fixes`, `vm-fixes-round2`, `vm-fixes-http` (fake: `fake-boat-server.ts`) |
| Rooms, comms hub, room requests | `comms/`, `shared/comms.ts` | `comms-*`, `rooms-polish` (fakes: `comms-fakes.test.ts`) |
| Lattice and Library (knowledge graph) | `kg/`, `shared/kg*.ts` | `kg-*`, `library-*`, `perf-l-core`, `perf-l-store` (fakes: `library-fakes.ts`, `kg-helpers.ts`) |
| BSV read-only mode | `bsv/`, `shared/bsv-*.ts`, `electron/admin-logic.ts` | `bsv-*` (including the tripwire `bsv-tripwire`, `bsv-review-tripwire` via `bsv-scan.ts`, and the hedge test `bsv-hedge`), `kg-bsv-seed` |
| Blender bridge | `blender/`, `shared/blender.ts` | `blender-*` (fakes: `blender-helpers.ts`) |
| Electron main, emulated | `electron/main.ts`, `electron/admin-logic.ts` | `token-v1-electron`, `token-v1-emu`, `bsv-electron-emu`, `bsv-electron-logic`; scenarios in `test/electron-emu/` run the compiled `main.js` with `electron` stubbed (POSIX only) |
| Installer scripts | `setup.cmd`, `scripts/setup.ps1`, `scripts/uninstall.ps1` | `installer-*` (PowerShell paths are skipped off Windows) |
| UI logic (no browser) | `ui/src/chat/`, `ui/src/graph/`, `ui/src/bsv/`, `ui/src/mascot/` | `chat-*`, `mascot`, `mascot-m`, `titlebar-layout`, `library-ui-*`, `bsv-ui-view`, `bsv-review-ui`, `blender-ui`, `perf-l-lattice`. The UI also gets `npm run typecheck` and `npm run build:ui`; browser benchmarks are in `test-perf/` (manual) |
| **Whole stack, real core process, fakes** | `scripts/harness/` | `harness-smoke`, plus the scenarios in section 5 (run by hand) |

Shared test helpers: `test/helpers-c.ts` (`start(ctx)` mounts the real server on a free port with a test admin secret; `AUTH` vs `asClient` headers), `test/token-harness.ts` (`mount(script)`: a real Engine, real HTTP server and real kg/comms/bsv modules in ONE test process with a scripted `queryFn`), `test/fake-boat-server.ts` (a stateful fake boat.dev REST server), `test/library-fakes.ts` (`setup`, `init`, `ok`, `toolUse`, `kg()` to call an agent's tool the way the model would), `test/comms-fakes.test.ts` (`makeHarness`, a `FakeEngine`).

The difference to the harness: those fixtures run the product code inside the test process, one slice at a time. The harness runs a **separate real core process** with real stdin secrets and real HTTP, driven from outside like a client, so it also covers process wiring (secrets, config, restart) that in-process tests cannot.

## 3. Commands and the gate

```bash
npm ci                    # installs Electron too; add ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip the binary
npm run build:ts          # tsc -> dist/ (also copies static files)
npm test                  # the full suite: refuses locally (CI only, see below); build:ts, then node --test "dist/test/*.test.js"
npm run typecheck         # core (tsconfig.json) and UI (ui/tsconfig.json), no emit
npm run build:ui          # vite build -> dist-ui/
```

**The full suite runs on the PR's CI, not on a dev PC.** `npm test` and `npm run test:run` start with `scripts/dev/test-guard.mjs`, which exits 1 unless `CI` is set or `LEGION_LOCAL_GATE=1` (`LEGION_LOCAL_GATE=1 npm test` in sh, `$env:LEGION_LOCAL_GATE=1; npm test` in PowerShell). `ci.yml` calls `node --test` directly and sets `CI`, so it is unaffected. Locally: `npm run build:ts`, then single files with `node --test dist/test/<name>.test.js` (or `npm run test:affected`, `npm run harness:smoke`). Before you finish, stop what you started and run `npm run tidy` (report only; `--apply` removes merged, clean worktrees, merged local branches and old dev leftovers).

The gate before anyone says "done" is what CI runs on the PR: `npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui`. Read the counts from the PR's CI run; run the chain locally only with `LEGION_LOCAL_GATE=1`, from a clean checkout of the exact commit you are reporting on.

It compiles the core once. `build:ts` already fails on any type error (tsc exits 2 even while it emits), so `test:run` runs the tests on that build and `typecheck:ui` checks only the UI project. The older gate compiled the core three times (`build:ts`, again inside `npm test`, again in `typecheck`), about 15 s each on the owner's PC. `npm test` and `npm run typecheck` still work on their own.

**Counts are never hard-coded in docs; read them from the run.** `node --test` prints a TAP summary at the end:

```bash
npm test 2>&1 | tee /tmp/test.log | grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)'
```

Report `tests`, `pass`, `fail`, `skipped` as printed. Skips are normal off Windows (PowerShell, Windows paths) and off Linux (the Electron emulation and the stand-in VM need POSIX); name the reason of any skip you rely on. A run that prints `# fail 0` but also `# cancelled` above 0 did not finish: treat it as failed.

**Run one file, or one test.** Tests import the compiled output, so build first:

```bash
npm run build:ts
node --test dist/test/engine.test.js
node --test --test-name-pattern="R6.1" dist/test/library-review-integrity.test.js   # a regexp on the test name
```

Never run `node --test` on the `.ts` files, and never edit `dist/` by hand: it is rebuilt from `src/` and `test/` on every `npm test`. `dist/` is not committed.

**Rebuild after every source change.** ESM caches modules inside one process, and the compiled tree is what runs: a running core (and a running harness stack) keeps the old code until restarted.

### Only the tests a change can affect (`test:affected`)

While you work, run only the test files your change can reach. The full gate above is still what "done" means.

```bash
npm run test:map        # once, and again now and then: one full run with a recorder in every process -> .testmap/map.json
npm run test:affected   # compile, then run only the test files the changes since the map's commit can affect
node scripts/test-map/select.mjs --why   # list them, and the changed path that picked each one
```

How it decides, and why it can be trusted:

- The map records, per test file, what its run actually touched: every module it loaded, every file or folder it read through `node:fs`, and every path it handed to a child process. Processes a test spawns inherit the recorder. A script handed to another program counts as its whole folder.
- A test is selected when a changed path is a file it touched or sits inside a folder it read. "Changed" means everything that differs from the map's commit: committed, staged, unstaged and untracked.
- Why that is enough: if a test now behaves differently, it now reads a file whose content differs. A test only reads a file it did not read before because code it did read has changed, and that change selects it.
- A test that starts a program the recorder cannot see inside **always runs**: PowerShell, git, a shell command, or a Node child whose environment drops the recorder. Such a program can read a file named only inside a temp script, or a path it works out itself. The installer tests are the reason for this rule: they write a temp `.ps1` that dot-sources `scripts/setup.ps1`, which no recorded read shows.
- It runs the **whole** suite whenever the map cannot vouch for a change. That covers no map, a different Node major version, a change to `package.json`, the lockfile, a `tsconfig`, `copy-static.mjs` or the recorder itself, and a path read by a process it could not tie to a test file. A test file the map does not know (new, or it crashed before it could record) always runs. So does a test that reads build output with no source behind it.
- The BSV tripwires scan the whole source tree as text, so **any** source change selects them. That is correct: a change anywhere could add a wallet call.
- It assumes tests are deterministic. A test that depends on the clock, the network or the machine can still differ without any file changing; that is what the full gate is for.

### The harness, quickly

```bash
npm run build:ts
npm run --silent harness -- scenarios --list          # what each scenario proves and does NOT prove
npm run --silent harness -- scenarios                 # all scenarios, a fresh stack each, JSON result, exit 1 on any FAIL
npm run --silent harness -- scenarios approval-card-flow rooms-bot-room-request
npm run harness:smoke                        # the smoke test (also part of npm test)
```

`npm run --silent harness -- <args>` is `node scripts/harness/legion-harness.mjs <args>`. Details in section 4.

## 4. The harness (`scripts/harness/`)

Zero dependencies (Node ESM). Needs `dist/` (`npm run build:ts`) because it runs the compiled core and `dist/test/fake-boat-server.js`. Nothing it creates is inside the repo.

| File | Role |
|---|---|
| `legion-harness.mjs` | The CLI: `start`, `status`, `call`, `stop`, `scenarios`. |
| `stack.mjs` | The supervisor (started detached by `start`). Owns the temp folder, the fakes and the core process; serves a loopback control port. |
| `core-entry.mjs` | The core, composed exactly like `src/bin/legion-core.ts` but with the scripted model as `queryFn` and a static catalog and doctor. `harness-smoke` fails if the module list drifts from the product's. When you change the composition root, change this file too. |
| `fake-model.mjs` | The scripted, deterministic model (section 4.2). |
| `fake-wallet.mjs` | The fake BSV wallet: random loopback port, the four probe methods only, refuses the real wallet port and any non-loopback peer. |
| `fake-blender.mjs` | A fake `blender` executable (a Node script): `--version`, and `--background --python F` without running F. |
| `scenarios.mjs` | The scenarios (section 5). |
| `lib.mjs` | Client code: `startHarness`, `stopHarness`, `client(handle)`. |

### 4.1 Commands

```bash
node scripts/harness/legion-harness.mjs start
```

prints one JSON handle (base URL, handle file path, pids, temp folder, fake addresses) and returns; the stack keeps running detached. It is a **real core process** with a temp `LEGION_HOME`, a random loopback port, and the per-launch admin secret and native secret written to its stdin exactly as the Electron main process does (`LEGION_ADMIN_STDIN=1`, line 1 admin, line 2 native, pipe closed). The secrets live only in the memory of the supervisor and the core: never in a file, env var, argv or log, and never printed. The handle file (`<tmp>/legion-harness-XXXX/handle.json`) holds the control token of the harness itself, not a Legion secret. A pointer to the latest handle is kept at `<os tmpdir>/legion-harness-current.json` so later commands need no `--handle` (**for parallel runs always pass `--no-pointer` to `start` and address each stack with `--handle <file>`**: the pointer is last-writer-wins, so a command without `--handle` hits the latest stack; to skip it, `--handle <file>` or `LEGION_HARNESS_HANDLE` to pick one).

| Command | What it does |
|---|---|
| `status` | JSON: core pid/port/alive, whether it holds both secrets, request counts at the fakes. |
| `call METHOD PATH [JSON] [--auth A]` | One request to the core. The supervisor adds the credentials for the auth class `A`: `admin` (default, bearer + admin: the app window), `token` (bearer only: an MCP client), `none`, `admin-only` (admin without bearer), `native` (bearer + admin + native: what Electron main sends after its dialog). Prints `{status, json}`. |
| `stop` | Asks the supervisor to shut the core and the fakes down and delete the temp folder; if anything is still alive it kills the **recorded pids** (never by name), then removes the folder. Exit 1 if a pid or the folder is left. |
| `scenarios [names] [--list] [--verbose] [--handle F]` | Runs scenarios. Without `--handle`, each gets its own fresh stack that is stopped afterwards. With `--handle` they share that stack. Prints JSON `{ok, passed, failed, results:[{name,status,ms,checks,error?}]}` (a scenario with zero checks, or one whose cleanup left a process or folder, is a FAIL); `--verbose` adds `proves`/`doesNotProve`; exit code 1 on any FAIL. |

**Crash cleanup.** If a supervisor is killed hard (`kill -9`, power loss) its `<tmp>/legion-harness-*` folder stays. The next `start` (and every scenario run, which starts stacks) sweeps such folders: it removes only a folder that is named `legion-harness-*`, carries the `harness-marker.json` file the harness writes with the supervisor pid, and whose recorded pid is no longer alive. It never kills anything and never matches by process name; a folder without the marker, or whose supervisor is alive, is left alone. **Environment.** The core gets an allowlist of the caller's variables (PATH/Path, HOME/USERPROFILE, TMP/TEMP/TMPDIR, the Windows standard variables, locale) plus the `LEGION_*` ones the harness sets; other secrets in your shell (cloud or CI tokens) do not reach it (`scripts/harness/core-env.mjs`). **Runner floor.** A scenario FAILs if it ran zero checks or if stopping its stack left a process or folder behind.

`call` examples:

```bash
node scripts/harness/legion-harness.mjs call GET /api/state --auth token
node scripts/harness/legion-harness.mjs call POST /api/bsv '{"enabled":true}'
node scripts/harness/legion-harness.mjs call POST /api/tasks '{"agentId":"scout","prompt":"hello"}'
```

A bare `call POST /api/tasks` runs the default reply `[harness] scout done` (no script registered). To script a model, use the library from a scenario (4.2) or `scripts/harness/lib.mjs` from your own `.mjs`.

### 4.2 The scripted model

`fake-model.mjs` replaces the Claude Agent SDK `query()`. A scenario registers scripts with `h.script(matcher, steps)`; the first unused script whose `agent` (the agent id, from the run's working directory) and optional `promptIncludes` match is used for the next run, then consumed. No match: the run answers `[harness] <agent> done`.

Steps are plain JSON: `{say: 'text'}`, `{tool: 'Bash', input: {...}, as: 'key'}`, `{wait: ms}`, `{result: 'text', costUsd?, error?}`. For a `tool` step the model plays the part Claude Code plays between messages, so Legion's own gates run for real:

1. the engine's `PreToolUse` hook is called first (this is where Legion marks a run **tainted**: `WebFetch`, `Bash` and unknown tools taint, file tools and Legion's own do not);
2. the engine's `canUseTool` is called when the engine set one (`ask` and `auto-edits` agents, and every run under an `ask` ceiling). A denial comes back as the tool result with `decision: 'deny'`. A `full` agent started by the app has no `canUseTool` (bypass mode), exactly like the real thing;
3. an in-process Legion tool (`mcp__legion_comms__room_create`, `mcp__legion_kg__kg_capture`, `mcp__legion_bsv__bsv_status`, `mcp__legion__ask` ...) is called through a real MCP client over an in-memory transport, so its input schema is validated;
4. any other tool (`Bash`, `Write`, `WebFetch` ...) is **not executed**; the script gets a fixed "tool not executed" text.

The outcome lands in `vars[as]` (`{decision, isError, text}`) and in the run log (`h.modelLog()`: agent, prompt, permission mode, whether `canUseTool` existed, the servers the agent got, tool calls). Scenarios assert on that log, so "the full agent still got a card" is checkable.

### 4.3 The fakes and their limits

- **Fake model**: described above. It cannot tell you whether a real model would call that tool; it tells you what Legion does when one does.
- **Fake boat.dev** (`test/fake-boat-server.ts`): a stateful REST fake with the three error bodies seen in real use (`api_key_action_forbidden`, `trial_machine_class_not_allowed`, `provider_not_configured`). `h.boatConfig({trial, forbidden, providerConfigured, providerFirst, stopSticks})` flips them; `h.boat()` returns the request log. Everything else about boat.dev's wire behaviour is a guess ([VM-NOTES.md](VM-NOTES.md), "Not verified against the real boat.dev").
- **Fake wallet** (`fake-wallet.mjs`): only `getVersion`, `getNetwork`, `isAuthenticated`, `getHeight`; any other method is answered 404 and listed in `offAllowlist`. `h.walletState({network:'main'})` etc. change the answers. It refuses to bind the real wallet's port and refuses non-loopback peers. See [TESTING-BSV.md](TESTING-BSV.md).
- **Fake blender** (`fake-blender.mjs`): see [TESTING-BLENDER.md](TESTING-BLENDER.md).
- **Not faked, not contacted**: the network beyond loopback. Every address in a stack is `127.0.0.1`.

Safety properties of the harness itself (checked by `harness-smoke` and the `harness-guards` scenario): the temp folder and all processes are gone after `stop`; no 64-hex value (the admin and native secrets are 64 hex) appears in the handle, config or logs; nothing under `scripts/harness/` or `docs/TESTING*.md` names the real wallet port except the refusal guard in `fake-wallet.mjs`.

## 5. Scenarios

Run `npm run --silent harness -- scenarios --list` for the authoritative proves / does-not-prove text. Summary:

| Scenario | Proves (Legion's own code, in the fake setting) | Does NOT prove |
|---|---|---|
| `core-task-run` | A task over HTTP runs through the real engine with a scripted model; result, cost, chat log; read-only tool needs no card; zero boat.dev and wallet calls | Real SDK, real model, real tool execution |
| `approval-card-flow` | Bash from an `ask` agent stops on a card showing the command; the MCP token cannot answer (403); Allow continues, Deny returns the denial text | Card UI, keys, the 10-minute timeout |
| `rooms-bot-room-request` | A bot's `room_create` makes nothing until the card is answered, even for a `full` bot; the card says "No spend limit"; deny leaves no room; allow creates it marked by the bot with no default budget; only admin deletes | Room behaviour after creation (hops, cycle, budget guards: `comms-*` tests) |
| `mcp-token-limits` | The token reaches only the client list; everything else, including unknown paths and BSV policy changes, is 403; Freeze is allowed; a token-started task for a `full` agent runs under the `ask` ceiling with cards | Same-user memory/file access; MCP transport calls |
| `library-capture-taint` | A clean `kg_capture` is live; after a `WebFetch` the note is untrusted and pending in the Inbox; Inbox is admin-only; reject works | Real web wrapping, the Library UI, the full taint matrix |
| `boat-lazy-key-probe` | Zero boat.dev calls at core start; the key probe runs on first VM use, creates no sandbox, runs once | The real boat.dev (owner check K1) |
| `vm-start-stop` | VM start/usage/stop through the real manager to the fake boat; a stop boat.dev ignores is not reported as success; token cannot start | Real boat.dev, billing, the desktop stream |
| `bsv-policy-tamper` | A policy change (admin + native) is saved and audited; a hand edit of `bsv/policy.json` freezes the chain, keeps the edited file as evidence, leaves the recorded caps in force and survives a restart | A same-user program that rewrites the file, the audit log and its anchor consistently |
| `bsv-readonly` | Connect needs admin AND native; non-loopback refused with zero contact; exactly the four probe questions reach the wallet; `bsv_status` needs a card and its answer is untrusted-wrapped and taints; a hand-edited `walletUrl` is not used after restart; token Freeze works and blocks arming | A real wallet, the native dialog, spends, mainnet |
| `blender-off-and-fake-exe` | Bridge off by default and admin-only; normal agents get no `legion_blender`; the fake executable behaves | Real Blender, sandbox, live socket, local mode (not on this base) |
| `harness-guards` | The fake wallet refuses the real wallet port and non-loopback targets | Anything about Legion |

Writing a new scenario: add `scenario({name, proves, doesNotProve, async run(h, t) {...}})` in `scenarios.mjs`. Use `h.resetModel()` first, unique names for what you create (scenarios can share a stack with `--handle`), `h.script(...)` for the model, `h.call(method, path, body, auth)`, `h.runTask(agent, prompt)`, `h.waitApproval()` / `h.pendingApprovals()`, `h.until(fn)`, `h.restartCore(configPatch)` (new process, new secrets, config shallow-merged first: emulates a hand edit plus a tray restart), `h.homeFile('read'|'write'|'list', path, content)` (a file inside the temp `LEGION_HOME`, to emulate a hand edit of a state file), the fake controls `h.boatConfig / h.boat / h.wallet / h.walletState` and `h.modelLog()`, and `t.ok / t.eq` for checks (a failed check throws and names itself). If you add an extension point (a fake wallet method, a boat flag), add its negative first.

## 6. How to test a change

1. Find the area in the map (section 2) and read its doc.
2. Write the test at the lowest level that can fail for the right reason: a pure function test, then an in-process fixture (`token-harness.ts`, `library-fakes.ts`), then, for cross-process behaviour (secrets, config, restart, gate), a harness scenario.
3. **Prove the test can fail** (section 8), then run the gate (section 3).
4. For anything in the "only a human can verify" column of section 7, say so in your report instead of implying it passed.

## 7. What can be verified where

| Layer | Where | Verifies | Cannot verify |
|---|---|---|---|
| Unit and in-process integration (`npm test`) | Cloud/Linux, any dev box | Logic, gates, contracts, taint, approvals, policy engine, fakes of boat/wallet/Blender, UI logic | Anything involving a real service, a real OS shell, real Electron, real drawing |
| Harness scenarios and smoke | Cloud/Linux, works on Windows | Process wiring: stdin secrets, config, restart, HTTP gate, scripted agent runs against fakes | Same as above |
| Owner's Windows PC | Owner or a local agent on the PC | Windows paths, PowerShell 5.1, `taskkill`/`netstat`, installer, SmartScreen, tray, real Electron window, the real Claude sign-in, real boat.dev key (K1), real MCP hookup. List: [claude/tracker-pc-checks.md](../claude/tracker-pc-checks.md) (P1-P10, M1-M3, K1, U1, R1 and the handoff items) | A funded BSV wallet is never touched by automation |
| Testnet-wallet VM, owner present | A VM with its own BSV Desktop on testnet, funded with testnet coins; Legion built inside it | Real BRC-100 behaviour for the status probe and (when built) the spend flow: steps V0-V12 in [claude/plan-bsv-rung3.md](../claude/plan-bsv-rung3.md) section 7.2 | Mainnet; the owner's host wallet |
| Real Blender on the owner's PC | Owner at the machine | Official/community backend start, add-on install, a real live script, screenshots, Windows detection; list in [TESTING-BLENDER.md](TESTING-BLENDER.md) | The VM sandbox (needs a real boat.dev key too) |
| Human only | The owner, at the keyboard | The wording and look of native dialogs and approval cards, wallet prompts, whether a flow feels safe, the mainnet real-funds steps R0-R11 (plan section 12.6b), any decision that spends money, accounts, CAPTCHAs, downloads | - |

If you cannot run something (you are on Linux and it needs Windows), say "not verified" and why. Do not write "should pass".

## 8. How to prove a new test (scratch mutation)

Every new test needs a negative: show it can fail.

1. Make the test pass on the real code. Record the exact command and the pass line.
2. Edit the **product code** the test claims to protect so that the protected behaviour is wrong (flip a comparison, remove a check, widen a route). Keep the edit tiny and in one place.
3. Rebuild and run the same command. Expect red, with the message you wanted. A test that stays green proves nothing: strengthen it (the harness work found two weak tests this way: a token-limits scenario that never tried the approvals route, and a drift test that compared creation calls but not the module list).
4. Revert with `git checkout -- <file>`, rebuild, rerun: green again. Confirm `git status` shows no leftover change in `src/`.
5. Put the result (edit, red message, revert) in your report.

Mutating the harness itself (not the product) is allowed for harness tests, as `harness-smoke` was proved.

## 9. What an independent reviewer should check

Default stance: "not fixed". The builder's report is never the proof.

- Re-run the whole gate yourself from a clean `npm ci` on the exact commit; compare the printed counts, not the report's.
- For each new or changed test: apply the mutation yourself (section 8) and see red; look for tests that cannot fail (no assertion on the claimed behaviour, a catch that swallows, a pattern that matches anything).
- Read each scenario's `doesNotProve` and check that the report does not claim more than `proves`.
- Check the hard rules in CLAUDE.md: no edit weakens the admin gate, the native-secret flow, taint wrapping, the tripwire (`test/bsv-scan.ts`) or the hedge test (`test/bsv-hedge.test.ts`); no wallet port number in any new file except the refusal guard; no keys or `.legion` data; no new child-process spawning outside files the tripwire lists (the harness lives in `scripts/` and `test/`, which the scan does not cover; the product's `src/` is untouched).
- Wording: claims scoped ("Legion's own code ..."), no "cannot be bypassed", no "fully safe".
- `git diff origin/<base> --stat`: nothing unexpected under `src/`.
- Leftovers: no running `legion-harness-*` process or temp folder after the run (`ls <tmpdir>/legion-harness-*`).

## 10. Windows pitfalls (tests and scripts)

- Build file paths with `fileURLToPath(import.meta.url)` and `path.join`; never `new URL(...).pathname` (it gives `/C:/...` on Windows).
- Windows PowerShell 5.1 does not unroll a JSON array from `ConvertFrom-Json` into the pipeline; pipe through `ForEach-Object { $_ }` to get the elements.
- File symlinks need a privilege on Windows. In tests use directory junctions or hard links (`test/fs-links.ts` has `linkOrSkip`, `fileLinkOrSkip`).
- Environment variable names are case-insensitive on Windows (`Path`), case-sensitive elsewhere (`PATH`): when copying `process.env`, normalise before you compare.
- Never kill processes by a name pattern (`pkill`, `taskkill /IM`, `Get-Process | Where Name -like`) on the owner's PC or in a shared cloud box: you will kill someone else's work (or your own shell). Kill by PID, from the handle you recorded. The harness does this.
- Never switch git branches (or `git checkout` files) while a test run is going: the tests read `src/`, `docs/` and seed files directly (the BSV tripwire and hedge scans do), and `dist/` is built from whatever is checked out, so a run that straddles a switch tests a mix.
- Line endings: `.cmd` and `.ps1` need CRLF on the PC; the repo stores LF (installer tests cover it).
- POSIX-only tests (`test/electron-emu`, the stand-in VM runner) are skipped on Windows with a stated reason; do not read a skip as a pass.

## 11. Known flakes

- **`R6.1 replay fidelity`** in `test/library-review-integrity.test.ts`: failed intermittently on Windows ("reloaded graph differs from live", diff list empty), never on Linux. Likely cause: search scores multiply by a recency factor from the wall clock, rounded to 4 decimals, and the two graphs were compared at different instants. The comparison now pins one instant and its failure message names the differing part (nodes, edges, search, inbox). **Not proven fixed** and never mutation-checked on Windows; the Library's "restart equals live" guarantee is not confirmed on Windows ([claude/legion-release-tracker.md](../claude/legion-release-tracker.md), "Open item: R6.1"). If it fails: read the message, rerun the single test (`--test-name-pattern="R6.1"`) three times, then report which part differed with the seed/step; do not skip or loosen it.
- **`kg-routes` under full-suite load**: timing-sensitive on a busy machine (the file starts real HTTP servers and a debounced writer). If `kg-routes` fails in the full run, rerun that file alone: `node --test dist/test/kg-routes.test.js`. Alone it should pass; if it also fails alone it is a real failure. Do not rerun the full suite until it goes green and call that a fix: say which run failed and which passed.
- A flake is a claim about a test, not a cause. A failure that reproduces on a rerun, on a second machine, or alone is real. Never skip, disable or quarantine a test to get green.
- Heavy parallel work (a second `npm test`, a build, many harness stacks) while the gate runs adds load and makes both flakes more likely: run the gate alone.

## 12. Verified output

The text below is the real output of the commands on the commit named, in a Linux cloud container (Node 22), not hand-written. Re-run to refresh.

<!-- VERIFIED-OUTPUT-START -->
Commit: the tip of `claude/test-harness` when this section was written (parent `792a0b3`, base `integration/v1` `1ed80f8`). Node v22.22.0, Linux container.

**The gate** (`npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui`, fresh `node_modules` and `dist`, all five exit codes 0, `npm ci` reported 0 vulnerabilities):

```
# tests 1441
# suites 5
# pass 1439
# fail 0
# cancelled 0
# skipped 2
# todo 0
```

The count includes the 3 tests in `harness-smoke`. The 2 skips are the real-PowerShell tests ("no PowerShell on this machine; the Windows CI job runs these"). Not run here: Windows, real Electron, real Claude, real boat.dev, a real wallet, real Blender.

**All scenarios** (`npm run --silent harness -- scenarios`, a fresh stack per scenario, exit code 0):

```
core-task-run                PASS  10 checks    930 ms
approval-card-flow           PASS  12 checks    920 ms
rooms-bot-room-request       PASS  10 checks   1044 ms
mcp-token-limits             PASS  27 checks   1055 ms
library-capture-taint        PASS   8 checks    927 ms
boat-lazy-key-probe          PASS   4 checks   3008 ms
vm-start-stop                PASS   7 checks  20093 ms
bsv-readonly                 PASS  17 checks   2200 ms
bsv-policy-tamper            PASS   9 checks   2520 ms
blender-off-and-fake-exe     PASS   6 checks    996 ms
harness-guards               PASS   6 checks    824 ms
=> ok=true passed=11 failed=0
```

**Smoke test** (`npm run harness:smoke`; it starts a stack, calls `status` and `call`, runs `core-task-run` and `mcp-token-limits` in it, stops it, then asserts the supervisor and core pids are gone, the temp folder is gone and no 64-hex value is in the handle, config or logs; `ls <tmpdir>/legion-harness-*` afterwards: nothing):

```
ok 1 - harness: start, run two scenarios, stop; no process and no temp folder is left; no 64-hex secret on disk
ok 2 - harness: the harness core entry composes the same modules as src/bin/legion-core.ts
ok 3 - harness: nothing the harness adds names the real wallet port except the refusal guard
# tests 3
# pass 3
# fail 0
# cancelled 0
# skipped 0
```

**Scratch mutations of the product code** (edit one line in `src/`, rebuild, run the scenario, expect FAIL, `git checkout -- <file>`, rebuild, all green again; `git status -- src` clean afterwards). Each line is `mutation  scenario  result  first failed check`:

- M1 `src/core/admin.ts`: add `POST /api/approvals/:id` to the token's client list.
- M2 `src/core/engine.ts`: tasks started by the token get ceiling `full` instead of `ask`.
- M3 `src/core/comms/hub.ts`: a denied room request goes ahead (`if (false) throw`).
- M4 `src/core/engine.ts`: `taintsRun` returns false for every tool.
- M5 `src/core/vm-manager.ts`: `startReaper` runs the key probe at start.
- M6 `src/core/bsv/index.ts`: the native-secret comparison is removed.
- M7 `src/core/bsv/index.ts`: the policy-file fingerprint check returns early.

```
M1-token-may-answer-approvals approval-card-flow FAIL check failed: token-only caller is refused ({"actual":200,"expected":403})
M1-token-may-answer-approvals rooms-bot-room-request FAIL check failed: token cannot answer ({"actual":200,"expected":403})
M1-token-may-answer-approvals mcp-token-limits FAIL check failed: POST /api/approvals/apr_none refuses the token ({"actual":400,"expected":403})
M2-token-task-ceiling-full mcp-token-limits FAIL check failed: origin is the MCP origin with the ask ceiling ({"actual":["mcp","full"],"expected":["mcp","ask"]})
M3 rooms-bot-room-request FAIL check failed: bot was told the user did not approve ({
M4 library-capture-taint FAIL check failed: clean run is not tainted, the WebFetch run is ([null,null])
M5 boat-lazy-key-probe FAIL check failed: zero boat.dev requests after core start ({"actual":[{"method":"GET","path":"/me"},{"method":"GET","path":"/sandboxes"},{"method":"POST","p
M6 bsv-readonly FAIL check failed: admin alone cannot connect ({"reachable":true,"authenticated":true,"network":"test","version":"1.2.3","height":1234567,"checkedAt":"2026-10
M7 bsv-policy-tamper FAIL check failed: the next policy read freezes the chain (null)
```

Seven scenarios were shown red by a product mutation. Two weak spots were found and fixed on the way: `mcp-token-limits` stayed green under M1 until it also tried `POST /api/approvals/...` with the token, and the drift check in `harness-smoke` stayed green when a module was dropped from the list until it compared the `const modules = [...]` line. The three smoke assertions were then each shown red by a scratch mutation of the harness itself: a 64-hex value added to the handle file, the temp folder cleanup removed from both the supervisor and `stop`, and `blender` dropped from the harness core's module list (all three: `harness-smoke` red; harness files reverted).
<!-- VERIFIED-OUTPUT-END -->
