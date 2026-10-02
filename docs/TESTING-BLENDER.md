# Testing the Blender bridge

Companion to [TESTING.md](TESTING.md). What the bridge is and what protects it: [BLENDER.md](BLENDER.md). The plan for the local headless mode: [claude/plan-blender-local-first.md](../claude/plan-blender-local-first.md). This page says how the sandbox and live paths are tested today without Blender, what only real Blender on the owner's PC can show, and where the local headless mode (not on this base) plugs in.

Scope of every claim: "Legion's own code, in this version, against fakes". No test here ran Blender, `bpy`, a real add-on or a real boat.dev VM. The static check is a filter, not a sandbox ([BLENDER.md](BLENDER.md), "Limits, stated plainly").

## 1. Rules

- No downloads, no accounts, no Blender install, no spending in any test or scenario. Anything that needs one is in section 4 and is for the owner.
- Child processes may be spawned only in files the tripwire lists (`test/bsv-scan.ts`; for Blender that is `src/core/blender/system.ts`). Do not add a spawn elsewhere to make a test easier; inject a fake port instead.
- The Blender add-on's socket has no password, and that is a documented limit. Never point a test at a real add-on port on a machine with a real Blender open.
- Script text in tests is for exercising the static check and the guard. Review it with a defensive framing: find gaps in the controls, do not write payloads meant to harm.

## 2. How each path is tested today

| Path / piece | Source | Tests and fakes | What the fake is |
|---|---|---|---|
| Static check (script filter) | `blender/static-check.ts` | `blender-static-check` (bypass attempts, linear time) | pure; no Python runs |
| Guard: card, audit, backup, taint, busy, order of steps | `blender/guard.ts`, `audit.ts` | `blender-guard`, `blender-helpers.ts` (`rig()`: `FakeBackend`, `FakeSandbox`, auto-answering approvals, `connectTools()` over an in-memory MCP transport) | scripted backend and sandbox objects; the guard itself is real |
| Community backend (JSON socket) and official backend (MCP over stdio) | `blender/backends/*` | `blender-backends`: in-process fake servers | a loopback server that speaks the add-on's JSON, a stdio MCP server; not the real add-on |
| Sandbox runner (headless Blender in the boat.dev VM) | `blender/sandbox.ts` | `blender-sandbox`: the "VM" is a temp folder driven by real `bash` and real `python3` with a **stub `bpy` module**, so the runner script, run command, hash check, export copy-back and its limits run for real. POSIX only (skipped on Windows with a stated reason) | stub `bpy`; no Blender; no boat.dev |
| Sandbox via the fake boat | `vm-manager.ts` | `fake-boat-server.ts` serves create/resume/commands/files; the Blender tests use `FakeSandbox` instead of it. The harness stack has the same fake boat | a REST fake; command output is canned |
| Host-side file safety (no-follow, links, quarantine of `.blend`) | `blender/fs-safe.ts` | `blender-fs-safe` with real temp folders and real links: symlinks on POSIX, junctions and hard links on Windows (`test/fs-links.ts`) | real file system |
| Detection of installs | `blender/detect.ts` | `blender-detect` with injected `DetectEnv` (fake file system, registry, `blender --version` output) | pure |
| Managed Set up (download, hash pin, trust on first use, add-on install) | `blender/setup.ts`, `system.ts` | `blender-setup` with a fake `BlenderIo` (no network, no real files, no real Blender) | scripted io |
| Config, status light, routes, exposure | `blender/index.ts`, `state.ts`, `server.ts` | `blender-config`, `blender-module` (real Engine, Store and HTTP server; checks that only the Sculptor gets `legion_blender`, that raw Blender MCP names are disallowed for every agent, admin-only routes, config persistence) | real code |
| UTF-8 environment for every Python Legion starts | `blender/*` | `blender-utf8-env` (simulates a cp1252 locale) | simulated locale |
| Approval card helpers (line numbers, hidden characters) | `ui/src/blender/` | `blender-ui` (pure helper block cut from the TSX and run) | no browser |

In the harness (real core process, fakes), today:

- `blender-off-and-fake-exe`: the bridge is off by default and admin-only (`GET /api/blender`, `POST /api/blender/config`), a normal agent's run has no `legion_blender` server (the scripted model's run log lists the servers the engine gave it), and `scripts/harness/fake-blender.mjs` answers `--version` and records a `--background --python F` call without running `F`.

What the harness does not do for Blender yet: turn the bridge on and run `blender_exec` for the Sculptor against the fake boat. That is a reasonable next scenario (section 5) and needs the static check's accepted script, a card answered by `h.waitApproval()`, and the fake boat's `commands` route to return a result the sandbox runner will accept (its protocol is in `sandbox.ts`; the existing tests show the shapes).

## 3. Procedure: the Blender bridge without Blender

```bash
npm run build:ts
node --test dist/test/blender-guard.test.js dist/test/blender-module.test.js      # guard and wiring
node --test dist/test/blender-sandbox.test.js                                     # needs bash and python3 (POSIX)
npm run --silent harness -- scenarios blender-off-and-fake-exe
```

Using the fake `blender` by hand:

```bash
node scripts/harness/fake-blender.mjs --version                      # Blender 5.1.0 ...
FAKE_BLENDER_VERSION=4.2.3 node scripts/harness/fake-blender.mjs --version
FAKE_BLENDER_LOG=/tmp/fake-blender.log node scripts/harness/fake-blender.mjs --background --python x.py   # logs the call; x.py is NOT executed
```

`fake-blender.mjs` is a Node script, so it runs the same on Windows and POSIX when launched as `process.execPath fake-blender.mjs ...`. The supervisor copies it to `<harness dir>/bin/fake-blender.mjs` (path in `status`, key `blender`) with the executable bit and a Node shebang. The stack does **not** yet point the Blender module at it (detection looks for a program named `blender`; `blender-detect` uses an injected `DetectEnv` instead). Wiring it in is part of the PENDING work in section 5.

Mutation method for Blender controls ([TESTING.md](TESTING.md) section 8): mutate one line of `static-check.ts`, `guard.ts`, `fs-safe.ts` or `sandbox.ts` (for example let `os` into the import allowlist, skip the audit write before the run, follow a link), rebuild, run the matching test file, expect red, revert. The plan lists, for each planned control, the mutation that must turn it red (plan section 3).

## 4. What only real Blender on the owner's PC (or a real boat.dev key) can verify

Source: [BLENDER.md](BLENDER.md) "Not verified yet" and [claude/tracker-pc-checks.md](../claude/tracker-pc-checks.md) (the Blender line of "Also still open"). None of these can be run by a cloud agent.

**Official backend (real Blender 5.1+).** Start the server against a real Blender; whether `uv run` and the first dependency download work behind the owner's network; whether the official add-on, which is an extension (it has a `blender_manifest.toml`), installs through Legion's headless step or needs Blender's own "Install from Disk"; Test connection and a real scene read.

**Community backend.** The JSON socket protocol and command names against the real add-on; `startExpr` opening the socket; the moving upstream download address.

**Sandbox on a real boat.dev VM** (key needed): does Blender for Linux download and start in the VM image; a cube plus GLB export coming back to `<workspace>/blender-exports/<task>/` with the binary intact; `blender_screenshot` rendering within the timeout; the 600 second command limit and what happens at it; two tasks keeping separate `scene.blend` files.

**Windows.** Detection of Program Files, Steam and registry paths, `reg query`, `tar -xf` on a `.zip`, starting Blender detached, add-on install into the user's Blender folder.

**Human-only judgement.** Whether the LIVE approval card shows what Blender will actually run, in a way a person can read before clicking; whether a script that passes the static check can still wreck a scene (it can; that is why the card, the backup and the sandbox exist).

**Local headless mode checks (plan 6.2), once it lands:** `blender.exe --version` detection and mode "Automatic"; a cube and a GLB/FBX/PNG through the real runner (the write guard must not block the exporters); a hand-written script that writes outside the task folder is blocked; an infinite loop is killed at the limit and no `blender.exe` or child remains; the environment seen inside the run holds no Legion or API variables; with the community add-on's auto start on, a local run opens no socket on its port; paths with a space, long paths and OneDrive-redirected Documents; mode switching and a legacy `"sandbox":"off"` config; SmartScreen or antivirus prompts noted.

Record dated results in `claude/tracker-pc-checks.md`.

## 5. PENDING: local headless mode (branch `merge/blender`, not merged on this base)

Do not describe local mode as working here. When the branch is merged into the base you test, fill this section from what the merged tests and code really contain. The plan (sections 2, 3, 6) defines the intended shape; the extension points are:

**Fake `blender` binary.** `scripts/harness/fake-blender.mjs` is the harness's fake. The plan's unit test does the same inside the process: `LocalRunner` with an injected `ProcessPort` whose fake blender is a Node script started as `process.execPath fake-blender.mjs ...` (so it works on Windows and POSIX). Keep one behaviour set for both: `--version`; `--background --python <runner>` that reads the runner's arguments (run id, hash, paths) and either writes a result file the runner would write (for a "success" mode) or misbehaves on demand. Extend `fake-blender.mjs` with env switches, not new files: `FAKE_BLENDER_MODE=ok|hang|spawn-child|print-env|big-output|wrong-run-id|wrong-hash`, and a `FAKE_BLENDER_ENV_DUMP=<file>` to write its environment and cwd as JSON (for the scrubbed-environment control, plan C11). A `hang` or `spawn-child` mode lets a scenario check that the timeout kills the process and its child by PID (plan C14).

**Config for the harness core.** The stack's config is written by `stack.mjs` (`config.json` in the temp `LEGION_HOME`). Add a `blender: {enabled: true, installPath: <the fake blender's folder>, mode: 'local'}` patch through `h.restartCore({blender: {...}})` once the setting names exist on the merged branch (the plan renames `sandbox` to `mode` with a migration; check `src/shared/blender.ts` on the merged tree before writing it).

**Scenarios to add** (each with proves / doesNotProve; run through the scripted model as the `sculptor` agent, tool `mcp__legion_blender__blender_exec`):

- `blender-local-run-card`: bridge on, fake blender found, the Sculptor's `blender_exec` waits on a card that shows the full script and "On this PC"; deny runs nothing (zero spawns recorded in `FAKE_BLENDER_LOG`); allow records one `--background` call with `--factory-startup` and a scrubbed environment.
- `blender-local-routing`: the decision table (plan 2.3) through `GET /api/blender` statuses: Blender not found, VM not configured, mode `vm` with no boat key, live without a socket: each answers the stated notice and starts nothing.
- `blender-local-timeout-kill`: fake `hang` mode; after the limit the tool reports "may still be running" only where the plan says so, and the fake's pid is gone.
- `blender-local-exports`: the fake writes a `.glb` and a `.blend`; the `.glb` lands in `blender-exports/<task>/`, the `.blend` is quarantined as `.untrusted`.
- (Not a harness scenario) "the audit line is written before anything runs, and an unwritable audit stops the run" stays an in-process test (`blender-guard`): the harness has no way to make a file unwritable portably.

What these will NOT prove: that the real Blender runs the runner script, that the write guard lets the real exporters through, Windows process-tree behaviour, antivirus behaviour. Those are section 4.

**Also update when the branch merges:** the table in section 2 (new rows for `local.ts`, `exports.ts`, `blender-local*.test`), the "owner-only" list (drop what a test now covers), `docs/BLENDER.md`'s "Not verified yet", and the harness scenario list in [TESTING.md](TESTING.md) section 5.
