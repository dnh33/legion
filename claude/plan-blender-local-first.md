# Plan: Blender local-first (tracker item D)

Status: PLAN for owner approval, 2026-10-02. Nothing built, nothing committed. Branch `integration/v1`. Read first: `docs/BLENDER.md`, `SECURITY.md` (Blender rows), `src/core/blender/*`, `ui/src/blender/*`, Settings Blender section, `test/blender-*.test.ts`, `test/bsv-hedge.test.ts`.

## 1. Goal and non-goals

- Goal: `blender -b` runs on THIS PC against a per-task `scene.blend` in a per-task folder, wrapped by Legion's own runner. It becomes the default when Blender is found.
- Goal: the VM stays selectable (`vm`), live stays selectable (`live`). Reuse unchanged: static check, full-script card (no one-key Allow, 10 min auto-deny), backup, hash-chained audit, taint wrapping, 120 s timeout.
- Goal: close the tracker-D review items: pin the community add-on, install the official add-on as an EXTENSION, mark live Blender busy while a script runs, fix the line counts.
- Non-goal: calling local mode a sandbox. A local script has the Windows user's rights; the check is a filter. Controls are the card, backup, audit and the cheap hardening in section 3, each with a stated limit.
- Non-goal: authenticating the add-on socket, OS-level isolation (job objects with memory caps, AppContainer), changing the VM runner's behaviour.
- Non-goal: new agent-visible tools. Same five tools; `mode` argument gains `local`.

## 2. Design of the local headless mode

### 2.1 Facts found while reading (they shape the design)

- Today: `resolveMode()` in `guard.ts` knows `off|vm|auto`; `auto` means VM unless the agent passes `mode:"live"`. `RunMode = 'live' | 'sandbox'` is also in `audit.ts` (`AuditEntry.mode`) and in the card input.
- `RUNNER_PY` in `sandbox.ts` is the model: hash check against the approved sha256, per-run `script-<id>.py` and `result-<id>.json`, `scene.blend` open or create, redirect stdout, save scene. `INSPECT_PY` and `previewPy()` are fixed Legion scripts and are reusable as is.
- The export copy-back rules (`SANDBOX_EXPORT_EXT`, `QUARANTINE_EXT`, `SAFE_NAME`, 20 files, 15 MB, host folder real-path and link checks, `safeWriteFile`) are a private method `fetchExports` of `SandboxRunner` and read from a VM. Local needs the same rules reading from local disk, so they move to a shared module.
- Child processes are only allowed in files listed in `test/bsv-scan.ts` (`src/core/blender/system.ts` is listed). A new spawn in a new file would trip `bsv-tripwire.test.ts`. Design: the real spawn lives in `system.ts` (new `spawnManaged`), `local.ts` stays pure and takes a `ProcessPort`; only the reason text of the `system.ts` entry changes.
- Detection (`detect.ts`) already returns `blender.exe` (never `blender-launcher.exe`, which detaches and loses stdout); `exeName()` and the PATH scan use `blender.exe`. A user-set `installPath` pointing at the launcher must be rejected by a `--version` probe that returns text (add to `detectInstalls` test).
- Blender docs (checked 2026-10-02 against the 5.2 LTS manual, `advanced/command_line/arguments.html`): `--factory-startup`, `--disable-autoexec` (default), `--offline-mode` (disallows Blender's own internet access), `--python-exit-code`, `--python-use-system-env` (off by default, so PYTHONPATH is ignored), `--command <cmd>` implies background and consumes the rest of the arguments. Env overrides `BLENDER_USER_CONFIG`, `BLENDER_USER_SCRIPTS`, `BLENDER_USER_DATAFILES`, `BLENDER_USER_EXTENSIONS` exist (documented in the same manual; confirm names on the PC with `blender --help`).
- The community add-on has `blendermcp_auto_start_server`; a local headless run must not load the user's add-ons, or it could open a listening socket inside the background process. `--factory-startup` plus a Legion-owned `BLENDER_USER_*` folder prevents that. Test on the PC.

### 2.2 Config shape and migration

New key `blender.mode`: `'auto' | 'local' | 'vm' | 'live'`. Keep the old `sandbox` key for reading and mirroring.

- `normalizeBlender()` (`src/shared/blender.ts`): if `mode` is valid use it; otherwise derive from legacy `sandbox`: `auto` -> `auto`, `vm` -> `vm`, `off` -> `live`. `off` is NOT a new mode; it stays only as the legacy alias of `live` (old meaning: live Blender only).
- `BlenderState.update()` (`state.ts`) writes `mode` and mirrors `sandbox` (`auto`/`local` -> `auto`, `vm` -> `vm`, `live` -> `off`) so a downgrade still opens. `POST /api/blender/config` accepts `mode`; it still accepts `sandbox` (mapped), so an older UI tab does not break.
- `advanced.local`: `timeoutSeconds` (120, clamp 10-900), `maxTaskBytes` (500 MB), `maxOutputBytes` (4 MB), `extraWriteDirs` (default `[]`), `args` (default list in 2.4; user may add, never remove the fixed hardening flags: those are added by code, not config).
- Upgrade notice: an install whose raw config has `enabled:true` and no `mode` key gets a status notice "Scripts now run in Blender on this computer by default when it is found. Pick Cloud VM to keep the old behaviour." It disappears once any mode is saved (the key then exists). No extra flag file.

### 2.3 Decision table (pure function `resolveMode(setting, requested, facts)`)

Facts: `L` = a Blender >= 3.0 is detected on this PC (`pickInstall`, `--version` answered); `V` = VM ready (`SandboxPort.readiness`: boat key set and the Sculptor's VM on); `A` = live add-on reachable (checked at run time, not by `resolveMode`). `requested` is the tool's `mode` argument: `local`, `vm` (alias `sandbox`), `live`, or absent. Result is `{mode}` or `{error}` (plain text for the agent). A bridge with `enabled:false` refuses everything first.

| Setting | requested | Result |
|---|---|---|
| auto | absent | `L` -> local. Else `V` -> vm and the tool result says "Blender was not found on this computer, used the cloud VM". Else error: "No Blender on this computer and the cloud VM is not set up. Tell the user to install Blender or set boat.dev up in Settings." |
| auto | local | `L` -> local. Else error "Blender was not found on this computer" (never a silent fall back to the VM; the user asked for local) |
| auto | vm | `V` -> vm. Else error "The cloud VM is not ready: <readiness note>" |
| auto | live | live (LIVE card; `A` is checked at run time, error "not reachable" if not) |
| local | absent or local | `L` -> local, else error "Blender was not found on this computer. Install it or set its location in Settings" |
| local | vm or live | error "Settings restrict scripts to Blender on this computer" |
| vm | absent or vm | `V` -> vm, else error with the readiness note ("VM not configured": names the missing key or the VM switch) |
| vm | local or live | error "Settings restrict scripts to the cloud VM" |
| live | absent or live | live |
| live | local or vm | error "Settings restrict scripts to your open Blender" |
| (legacy `off`) | | behaves exactly as `live` |

Rules: never an automatic move from a stricter place to a looser one (vm -> local, local -> live). `auto` may move vm only when local is impossible (loosest-to-stricter direction is allowed because the VM is the more isolated place). Read tools (`inspect`, `screenshot`) follow the same table. `docs` stays live-only. `blender_status` prints the table's answer for "the next script goes to: ...".

### 2.4 Runner flow (new `src/core/blender/local.ts`, class `LocalRunner implements LocalPort`)

`LocalPort` (new tiny `ports.ts`, same shape as `SandboxPort`): `readiness()`, `run({agent, taskId, script, hash, timeoutMs})` -> `{ok, text, files, timedOut?, backup?}`, `inspect(...)`, `preview(...)`.

Per run, in order (the guard has already done check, card and the `approved` audit line):
1. Global queue: one local Blender process at a time (`withLock` like the sandbox, key = whole module). A second run waits; it does not start a second process. This is also the resource limit on concurrency.
2. Task folder `<dataDir>/blender/local/<safeSegment(taskId)>/` (NOT in the agent's workspace, so the agent's file tools do not reach it by default). Layout: `scene.blend`, `backups/`, `exports/`, `tmp/`, `script-<run>.py`, `result-<run>.json`. Re-resolve with `resolveFolder`, refuse a link anywhere in it (`findLink`), refuse when the folder exceeds `maxTaskBytes`.
3. Backup: if `scene.blend` exists, copy it to `backups/scene-<stamp>.blend` (keep the newest 5). Failure -> run refused, audit `backup_failed`. This protects the task's own scene, not anything outside it; the card says so.
4. Write `script-<run>.py` as UTF-8 without BOM, bytes exactly the approved text (CRLF kept). Runner file `<dataDir>/blender/local/runner.py` is rewritten once per core start.
5. Spawn (through `ProcessPort.spawn`, `shell:false`, `windowsHide:true`, argument array, no cmd.exe quoting):
   `blender.exe -b --factory-startup --offline-mode --disable-autoexec --python-exit-code 3 --python <runner.py> -- <taskdir> <runId> <sha256> [readonly]`, `cwd = taskdir`.
   `--disable-autoexec` is Blender's documented default; Legion passes it so a changed preference cannot turn it off.
6. Runner (`LOCAL_RUNNER_PY`, a constant in `local.ts`, Legion's code): reads `script-<run>.py` bytes, compares sha256 with the approved value (refuses on mismatch, writes a failure result), opens `scene.blend` or creates an empty one, installs the write guard (3.2, C12/C13), defines `LEGION_EXPORT_DIR` as the real path of `<taskdir>/exports`, runs the script with stdout and stderr captured, saves the scene (not for `readonly`), disarms the guard, writes `result-<run>.json` via temp file plus rename (`{ok, output, run, hash}`).
7. Host: wait for exit or timeout; read `result-<run>.json`; discard it when `run` or `hash` differ from this run (same rule as the sandbox). No result file -> failure text with the tail of stderr, capped.
8. Exports: `collectExports()` (new shared `exports.ts`, the moved `fetchExports` rules) copies from `<taskdir>/exports` to `<workspace>/blender-exports/<task>/`, a `.blend` to `<workspace>/blender-quarantine/<task>/<name>.blend.untrusted`. Same extension allowlist, `SAFE_NAME`, 20 files, 15 MB, link checks, `safeWriteFile`. After the copy the `exports/` folder is emptied.
9. Cleanup: delete `script-<run>.py`, `result-<run>.json`; keep `scene.blend`, `backups/`. No automatic deletion of scenes in v1 (status shows the folder size; a "Clear local scenes" button is a later item).

Guard side (`guard.ts` `exec`): for `mode === 'local'` the check runs with `{ allowedDirs: [<taskdir>/exports real path], live: true }`. `live:true` already refuses `//` and `wm.open_mainfile/append/link/read_homefile`, which is right here too: a `.blend` on the user's disk can carry code. No change to `static-check.ts` options. Audit `mode:'local'`, `AuditEntry.mode` union extended. Output wrapped with `source="local"`. Tool description text of `blender_exec` is generated per effective mode (the `"//name"` sentence only for the VM).

### 2.5 Windows paths, quoting, encoding

- No shell anywhere: `spawn(file, argsArray)`. The script never travels on a command line; only paths, a run id and a hash do. Spaces and non-ASCII user names are safe because Node builds the CreateProcess line; test with a task folder containing a space and a non-ASCII letter.
- Paths: `path.resolve` then `fs.realpathSync.native` for every compare; the Python side uses `os.path.normcase(os.path.realpath(p))` (case-insensitive, junction-resolving on Windows). Compare with a trailing separator so `C:\data\task1` does not match `C:\data\task10`. Task segment is `safeSegment()` (max 60 chars) under `%APPDATA%\legion\...`; keep full paths under 200 chars (MAX_PATH); refuse and say so when longer.
- Encoding: `PYTHON_UTF8_ENV` (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`) is in the scrubbed env; the runner opens every file with `encoding="utf-8"` and writes JSON with `ensure_ascii=True`, so a cp1252 console can never raise `UnicodeEncodeError` (the existing `blender-utf8-env.test.ts` pattern gets a local-runner case under simulated cp1252).
- Host decodes Blender's own stdout/stderr as UTF-8 with replacement; the real result is the JSON file.

### 2.6 Scrubbed environment (built from an allowlist, never `{...process.env}`)

Pass only: `SystemRoot`, `SystemDrive`, `windir`, `ComSpec` (some Blender builds read it), `PATHEXT`, `PATH` = the Blender folder plus `%SystemRoot%\System32` only, `TEMP` and `TMP` = `<taskdir>/tmp`, `USERPROFILE`/`HOME` = `<dataDir>/blender/local/home`, `BLENDER_USER_CONFIG|SCRIPTS|DATAFILES|EXTENSIONS` = folders under that home, `PYTHON_UTF8_ENV`. Absent on purpose: every `*_PROXY`, `ANTHROPIC_*`, `LEGION_*`, cloud and git tokens, `PYTHONPATH`, `PYTHONSTARTUP`, `BLENDER_*` other than ours, `APPDATA`, `LOCALAPPDATA`. POSIX: `PATH`, `HOME`, `LANG=C.UTF-8`, `DISPLAY` unset. Proves: Legion's own spawn does not hand secrets in the environment to the child. Does not prove: the process cannot read your files or registry by other means (it runs as you).

### 2.7 Timeout, kill, busy

- Timeout `advanced.local.timeoutSeconds` (default 120) counts from spawn. On expiry: Windows `taskkill /PID <pid> /T /F` (via `ProcessPort.kill`, uses `execFile`, no shell); POSIX `detached:true` at spawn and `process.kill(-pid, 'SIGKILL')`. Then wait up to 5 s for the `exit` event.
- If exit is confirmed: result "timed out after 120 s and was stopped"; the scene is NOT saved by the host (the runner never reached its save), the previous `backups/` copy is named in the result. If exit is NOT confirmed within 5 s: the local runner is marked busy (below) and refuses new runs until the PID is gone (`process.kill(pid, 0)` / `tasklist`), and the agent is told "may still be running".
- Output cap: stdout+stderr read through a counting pipe; above `maxOutputBytes` the process is killed the same way.
- Core exit and `dispose()` kill any running child. A crash can orphan one; documented residual (a start-up sweep that kills by recorded PID plus image name is listed as optional hardening, not in v1).
- Not provided: CPU, memory or GPU limits. Windows job objects need a native module or P/Invoke from PowerShell (a new execution surface); not worth it for v1. The timeout kill and the single-process queue are the whole limit. On POSIX the runner sets `resource.RLIMIT_FSIZE` to the export cap as an extra, best effort (skip on Windows).

### 2.8 Busy (item from tracker D)

`BlenderGuard.busy` becomes `{ since, hash, kind: 'running' | 'timed-out', mode }`. A live or local run sets `running` at start (inside `serial()`) and clears it in a `finally`; a timeout sets `timed-out` as today (cleared by the probe or the confirmed exit). `read()` for `inspect`/`screenshot` in live mode returns "Blender is busy running a script (started N s ago); try again" without calling the backend while `running` (the add-on answers on Blender's main thread, so a call would queue behind the script and hit its own timeout). Local reads queue behind the global lock instead. `BlenderStatusView.busy` (`{since, hash12, mode} | null`) and a light `busy` ("Running a script") show it in the Ops card. The 120 s live timeout still does not stop a live script; the text says so.

### 2.9 Line counts (item from tracker D)

`checkScript()` returns `lines: lines.length` and `guard.entryBase()` uses `script.split(...).length`; both count the empty piece after a trailing newline, so `"a\nb\n"` is 3. Fix in one place: `export const countLines = (s) => { const n = s.split(/\r\n|\r|\n/); if (n.length > 1 && n[n.length-1] === '') n.pop(); return n.length; }` in `static-check.ts` (same rule as `splitScriptLines` in the UI, which already drops the last empty row), used by `checkScript` (`lines`), `entryBase` (audit `lines`) and the UI `<b>{lines.length}</b>`. Tests: `"a\nb\n"` -> 2, `"a\nb"` -> 2, `"\n"` -> 1, `""` -> 1 (empty is blocked anyway), lone `\r` still a break; card and audit agree.

## 3. Control list

3.1 Pre-existing controls, reused for `local` (each gets a `local` case in the named test file):

| # | Control | Enforced in | Proving test | Mutation that must fail it |
|---|---|---|---|---|
| C1 | Static check before any card, `live:true` + export dir only | `guard.ts exec` | `blender-guard`: local bypass classes refused, `//` and `wm.open_mainfile` refused | pass `live:false` for local |
| C2 | Card shows FULL script, badge "On this PC", no one-key Allow | `BlenderApproval.tsx`, `ApprovalCard.tsx` | `blender-ui`: local card text + key handler test | let a key press approve for local |
| C3 | 10 min no answer = denied, nothing spawned | `approvals.ts`, `guard.ts` | `blender-guard`: fake `ProcessPort.spawn` call count 0 on timeout and on deny | spawn before the await |
| C4 | `approved` audit line first, fail closed | `guard.ts` | `blender-guard` S6 clone for local | write the line after spawn |
| C5 | Runner refuses a script whose sha256 is not the approved one | `LOCAL_RUNNER_PY` | `blender-local-runner` (real python, stub bpy): tamper the file, expect refusal and no exec | delete the compare |
| C6 | Result with another run id or hash is discarded | `local.ts` | same file: plant a foreign `result-*.json` | skip the check |
| C7 | Backup of `scene.blend` before each run, failure stops the run | `local.ts` | `blender-local`: read-only backups folder -> not spawned, audit `backup_failed` | ignore the copy error |
| C8 | Output wrapped, scrubbed, taints the run | `guard.ts wrapOutput` | `blender-guard`: closing-tag spoof and secret in local output | skip `markTainted` |
| C9 | Hash-chained audit with `mode:'local'`, head anchor | `audit.ts` | `blender-guard` S6 + chain verify with mixed modes | drop `local` from the union and write `live` |
| C10 | Export quarantine: allowlisted extensions, `.blend` -> `.untrusted`, caps, no links | new `exports.ts` | `blender-exports` (moved from sandbox tests, run for BOTH runners, also on Windows with junctions via `fs-links.ts`) | let `.blend` into `blender-exports` |

3.2 New controls (each states what it does NOT prove):

| # | Control | Enforced in | Proving test | Mutation | Does not prove |
|---|---|---|---|---|---|
| C11 | Scrubbed env, cwd = task folder, own `HOME`, `TEMP`, `BLENDER_USER_*`, `--factory-startup` (no user add-ons or prefs load) | `local.ts buildEnv/buildArgs`, `system.ts spawnManaged` | `blender-local`: fake blender prints its env and cwd as JSON; test sets `ANTHROPIC_API_KEY`, `HTTPS_PROXY`, `PYTHONPATH`, `LEGION_ADMIN` in the parent; assert absent, cwd and `TEMP` inside the task folder, exact flag list | spread `process.env` into the child | the child cannot read the user's files; env is only what Legion passes |
| C12 | Python-level write guard in the runner: a `sys.addaudithook` that, while the agent script runs, raises on file-open for write/create/append and on `os.remove/rename/replace/mkdir/rmdir/symlink/link`, `shutil.*` write events, when the real path is outside `<taskdir>` and Blender's own temp dir (plus `extraWriteDirs`) | `LOCAL_RUNNER_PY` | `blender-local-runner` (real python, stub bpy): script does `open(<outside>,'w')`, `os.remove`, `shutil.copyfile` to outside -> result `ok:false`, target absent; and a write inside `exports/` works; `blender-utf8-env` still passes | arm the hook after the script, or allow the task folder's parent | Audit hooks see Python-level events only. Blender's C code (`save_as_mainfile`, image saves, many operators) writes without a Python `open`; those stay governed by the static check's path rules. The hook cannot be removed by Python code but a script that reaches the runner's variables or `ctypes` could still defeat it, which the static check forbids (filter). It is a seatbelt against accidents and sloppy scripts, not a wall |
| C13 | Same hook denies `socket.connect/bind/getaddrinfo`, `subprocess.Popen`, `os.system/exec*/spawn*/startfile`, `ctypes.dlopen` while armed; Blender started with `--offline-mode` | `LOCAL_RUNNER_PY`, `buildArgs` | `blender-local-runner`: script connects to a loopback listener started by the test -> refused, listener saw nothing; `blender-local`: `--offline-mode` in args | never arm network events | Python-level only; `--offline-mode` governs Blender's own online access, not arbitrary C-level sockets; no firewall rule is created |
| C14 | Timeout and output cap kill the whole process tree by PID | `local.ts`, `system.ts kill` | `blender-local`: fake blender that spawns a child and sleeps; after timeout both pids are gone (Windows: `taskkill /T`, POSIX: group kill); on the PC the same with real Blender and a `while True` script | remove the kill, or kill only the parent | A child that detached from the tree before the kill (blocked by C13 for Python code, not by the OS) is not found; no memory or CPU cap |
| C15 | One local process at a time; queue | `local.ts withLock` | `blender-local`: two concurrent runs, `maxInFlight === 1` | remove the lock | |
| C16 | Task folder confinement: real-path checks, no links, size cap, per-task folder outside the workspace | `local.ts`, `fs-safe.ts` | `blender-local` + `fs-links.ts` (junction in `exports/` refused); over-cap folder refuses the run | skip `findLink` | A same-user program that swaps a folder for a link between check and use still wins the race (existing stated limit) |
| C17 | Busy marking: live `running`/`timed-out`, reads refused while running | `guard.ts` | `blender-guard`: slow fake backend, a concurrent `inspect` returns busy and the fake sees 0 inspect calls; after completion it works | clear busy only on timeout | The live script itself still cannot be cancelled |
| C18 | `resolveMode` table, no silent loosening | `guard.ts` | `blender-guard` / new `blender-routing`: full matrix incl. Blender not found, VM not ready, legacy `off` | auto falls back vm -> local, or local -> live | |
| C19 | Config migration: legacy `sandbox` maps, mirror written, no mode written until saved | `shared/blender.ts`, `state.ts` | `blender-config` + `blender-module`: old file `{sandbox:'auto'}` -> mode `auto`, notice present; after save notice gone; `{sandbox:'off'}` -> `live` | map `off` to `local` | |
| C20 | Line counts equal in check, audit, card | `static-check.ts countLines`, `guard.ts`, UI | `blender-static-check`, `blender-guard`, `blender-ui` | revert to `split().length` | |
| C21 | Add-on pin enforced | `shared/blender.ts` default, `setup.ts checkHash` | `blender-setup`: wrong bytes with the pinned sha refused, nothing installed, record untouched; default config has non-empty community sha and a commit URL | empty default sha | A pin proves the file is the one reviewed on 2026-10-02, not that it is safe |
| C22 | Hedge wording | new `test/blender-hedge.test.ts` | see section 4 | add "cannot be bypassed" or "sandbox" for local | |

Honest summary for docs and UI: in local mode the card, the backup and the audit are the controls that matter; C11-C14 reduce accidents and leakage by Legion's own spawn and by Python-level script actions. They do not isolate the script from the user's account.

## 4. UI changes

Files: `ui/src/components/Settings.tsx` (BlenderSection only), `ui/src/blender/BlenderApproval.tsx`, `BlenderCard.tsx`, `blenderStore.ts`, `blender.css`, constants in `src/shared/blender.ts` (`BLENDER_SAFETY_NOTE`).

Settings, Blender section: replace the three-way "sandbox" radio with a four-way "Where scripts run" radio (`mode`), recommended first:
- **Automatic (recommended)**: "On this computer when Blender is found, otherwise in the cloud VM. Your open Blender is used only when the Sculptor asks for it and you approve a LIVE card."
- **This computer, in the background**: "Legion starts Blender without a window on this PC and runs the script in a scene kept per task. The script runs with your Windows user's rights. The control is your OK on the full script, the scene backup and the audit log. Legion's own runner also stops the script's Python code from writing files outside the task folder or opening network connections, which narrows accidents; Legion's check is a filter, not a sandbox."
- **Cloud VM (boat.dev)**: "Runs in the Sculptor's VM, away from this computer's files and accounts. Needs a boat.dev key and VM time. Only exported files come back."
- **My open Blender**: existing live text including the no-password socket notice.
Under it: the hint line shows the table's answer for the next script ("Next script runs: on this computer (Blender 5.1.0)" or the error text). The orange "Sandbox mode is unverified" note becomes two notes: "Cloud VM: not yet tried on a real VM" (unchanged) and "Local mode: not yet tried with a real Blender on Windows" (removed only after the section 6.3 run is recorded in `claude/tracker-pc-checks.md`). Port and add-on controls move under "My open Blender" and are disabled when mode is local or vm.

Approval card (`blenderView`): new `mode:'local'`. `BlenderBadge` gets a third variant "On this PC" (tone like Live, not like Sandbox). `bl-live-warn` text for local: "Runs headless Blender on this computer as you. Read every line: Legion's check is a filter, not a sandbox. Exports are written to <taskdir>/exports and then copied into <workspace>/blender-exports/<task>/." Facts row: Where "Blender 5.1.0, in the background on this computer", Backup "scene copy before this run" with path, sha256, line count (fixed, 2.9). The live warning keeps its own text. No key shortcut for any Blender card (existing handler checks `isBlenderExec`; keep).

Status light and card: new lights `local` ("Local ready", on-tone) and `busy` ("Running a script", warn-tone) in `lightLabel()`; order in `status()`: off, error, busy, live `connected` only when mode is live, `local` when Blender found and mode is auto or local, `sandbox` ("VM ready"), not-found, needs-setup, disconnected. Ops card meta row: "Local: ready | not found", "Cloud VM: ready | not ready", "Live: connected | not connected". The socket notice (`BLENDER_SOCKET_NOTICE`) is shown only when mode is live, or auto and a live backend is reachable (today it shows unless `sandbox === 'vm'`; it must not show for local-only, and the guard text must not claim the local path has the socket problem).

Hedge-test wording rules (`test/bsv-hedge.test.ts` bans `guarantee`, `tamper-proof`, `impossible`, `cannot be bypassed`, `nobody can`, `100%`, `fully secure/safe/protected/isolated`, `unbreakable`, `protects your ...`, and unscoped universal negatives about signing or sending). That test only scans BSV files, so Blender text is unprotected today. New `test/blender-hedge.test.ts` (Builder 3) applies the same banned list to `ui/src/blender/*`, the Blender section of `Settings.tsx`, `src/shared/blender.ts`, `src/core/blender/*.ts` strings, `docs/BLENDER.md`, the Blender lines of `SECURITY.md` and `CHANGELOG.md`, plus Blender-specific rules: (a) any sentence that names local, "this computer" or "on this PC" together with "sandbox" must also contain "not a sandbox" or "no sandbox"; (b) `safe`, `secure`, `isolated`, `protected` are banned in sentences about local mode; (c) claims about what Legion's runner blocks must start with or contain "Legion's own" or "Legion's runner" and the words "Python" or "script's code" (scope), and must be followed in the same paragraph by a limit ("not", "only", "does not"); (d) required statements present: "filter, not a sandbox", "your Windows user" (or "your user"), "not yet tried" until the PC run is recorded. A self-test proves the check catches "Local mode is sandboxed and safe." and passes the wording above. To avoid duplicating the list, move `BANNED` into `test/hedge-phrases.ts` imported by both tests (Builder 3 owns the edit of `bsv-hedge.test.ts`).

## 5. Extension install fix and add-on pin

### 5.1 Official add-on is an extension (facts checked 2026-10-02)

`addon/blender_mcp_addon/blender_manifest.toml` at tag v1.0.3 (read through the projects.blender.org API): `id = "mcp"`, `type = "add-on"`, `version = "1.0.3"`, `blender_version_min = "5.1.0"`, `[permissions] network = "Runs a local TCP socket server ..."`. Folder also holds `weak_sandbox.py` (not reviewed here). So today's `addonInstallPy()` (copies to the legacy `scripts/addons` folder, `addon_utils.enable('blender_mcp_addon')`) cannot work: an extension's module is `bl_ext.<repo>.mcp`, not `blender_mcp_addon`.

Blender manual (5.2 LTS, `advanced/command_line/extension_arguments.html`, read 2026-10-02) lists `blender --command extension <build|validate|install-file|install|remove|list|repo-list|repo-add|repo-remove ...>`, with `build --source-dir DIR --output-filepath ZIP`, `install-file -r REPO [-e|--enable] [--no-prefs] FILE`, `repo-add ID [--name N] [--directory D]`, `repo-list`. Verified: those subcommands and flags exist. UNVERIFIED (needs the PC): the id of the local repo to use (expected `user_default`; read it from `repo-list` output, do not assume), that `-e` persists the enabled state so a later GUI start has it on, whether `install-file` accepts the zip made by `build` unchanged on 5.1, and that `blender --command ...` accepts earlier global flags (`--factory-startup` must come BEFORE `--command`, which consumes the rest).

Steps for `setupLive(... 'official')` in `setup.ts` (Builder 3), chosen by presence of `blender_manifest.toml` in `addonSrc` (else the legacy path stays for the community add-on):
1. `blender --factory-startup --command extension build --source-dir <addonSrc> --output-filepath <root>/mcp-<version>.zip` (steps: `ext-build`). Version read from the manifest text for the file name; a missing zip = failed step with Blender's last lines.
2. `blender --factory-startup --command extension repo-list` -> parse the id of a local, user-owned repo; if none, `repo-add --name "Legion" --directory <root>/extensions legion_local` (step `ext-repo`).
3. `blender --factory-startup --command extension install-file -r <id> --enable <zip>` (step `ext-install`).
4. Verify: `blender --factory-startup --command extension list` contains `mcp` and the version; step ok only then. Report which module name the user will see (`bl_ext.<id>.mcp`) and say: start the server from the add-on's sidebar panel.
5. `record.addonInstalledFor = 'official'` only when step 4 passed. Failure text keeps the by-hand route: Blender, Edit, Preferences, Get Extensions, Install from Disk.
Version gate stays (`OFFICIAL_MIN_VERSION 5.1.0` equals the manifest minimum). `BlenderIo.run` already runs without a shell with UTF-8 env; Set up passes `--offline-mode`? NO: install-file from a local zip needs no network, but `extension list` may try a remote sync; pass no `-s`. Tests with a scripted fake `io.run`: assert the exact argv per step, the order, that a failed build stops the rest, that legacy path is unchanged for community. `docs/BLENDER.md` "Not verified yet" keeps the extension line until the PC run.

### 5.2 Community add-on pin

Research done 2026-10-02 (public GitHub API and raw files; no guessing):
- The project moved: `ahujasid/blender-mcp` redirects to `ahujasid/mcp-for-blender` (repository id 944414751; licence MIT; default branch `main`; last push 2026-09-30). The raw URL currently in `DEFAULT_ADVANCED.community.addonUrl` (`.../ahujasid/blender-mcp/main/addon.py`) still resolves (HTTP 200, via redirect; `download()` follows only public https hops).
- No tags and no releases exist (`/tags` empty, `/releases` empty). So pin a COMMIT.
- Latest commit touching `addon.py`: `91cd735cc09fc75551de3347ebc7afdd69f3492e` (2026-09-30, "feat: add codex plugin"). `addon.py` at that commit and at `main` today is the same file: sha256 `eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5`, 270,889 bytes (limit in `setup.ts` is 5 MB, fine). It identifies as "MCP for Blender" `bl_info` version (1, 8), `ADDON_PROTOCOL_VERSION = 13`.
- The command names Legion uses still exist in this file: `get_scene_info`, `get_object_info`, `get_viewport_screenshot`, `execute_code`; operator `blendermcp.start_server` exists (so `startExpr` still matches). No token or password was found in the socket code (search for token/handshake/password/hmac matched only unrelated provider-secret fields), so the "no password" statement still holds as far as read; not a full audit of a 6,000-line file.
- Things the new file does that the docs do not yet say: it imports `requests`, has network features (Poly Haven, Poly Pizza, a premium and telemetry-consent preference), so the add-on itself can make outbound connections once running in the user's GUI Blender. This is outside Legion's control and must be stated in `docs/BLENDER.md` (live and add-on only; local headless never loads it, 2.1).

Change (Builder 2, `shared/blender.ts`): `addonUrl = https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py`, `sha256 = eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5`. Existing installs whose `setup.json` recorded the old URL see a new source (first use) and one pinned download; the pin makes the re-trust prompt irrelevant for the default. `blender-config.test.ts` asserts a 40-hex commit in the URL and a 64-hex sha; `blender-setup.test.ts` asserts a one-byte change in the fake download is refused.

TODO OWNER PC (clearly marked in the doc and tracker, because the value was fetched in a sandboxed session and the sha must be reproduced on the owner's machine before release): in PowerShell, `curl.exe -sSL https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py -o addon.py; (Get-FileHash addon.py -Algorithm SHA256).Hash.ToLower()` must print `eb0facf6...97fa5`. If it differs, take the PC's value and re-check `git log -1 -- addon.py` on the cloned repo before using it. Renewal procedure for later: pick a new commit, download, compute sha256, diff against the pinned file (`git diff 91cd735..<new> -- addon.py`), read the diff for new imports and network calls, then update both values in one commit.

## 6. Test plan

### 6.1 Cloud / Linux CI (stub `bpy`, fake `blender` binary; follows `blender-sandbox.test.ts`)

- `test/blender-local-runner.test.ts` (new): runs `LOCAL_RUNNER_PY` with real `python3` and a stub `bpy` module on `PYTHONPATH` (same `STUB_BPY` idea). Cases: hash mismatch refusal (C5), result schema, readonly does not save, write guard (C12) and network guard (C13) with scripts that write outside, delete outside, copy outside, connect to a loopback listener, plus the allowed write inside `exports/`; cp1252 simulated env.
- `test/blender-local.test.ts` (new): `LocalRunner` with an injected `ProcessPort` whose fake `blender` is a Node script run as `process.execPath fake-blender.mjs ...` (works on Windows and POSIX; the port's `file`/`prefixArgs` seam exists only for tests, production always spawns the detected exe). Covers env scrub (C11), exact argv, cwd, timeout kill of a sleeping process and its child (C14), output cap, queue (C15), backup (C7), foreign result discard (C6), task folder confinement incl. junction/symlink via `fs-links.ts` (C16), export copy-back through `exports.ts` (C10), task folder with space and non-ASCII name.
- `test/blender-exports.test.ts` (new, moved from sandbox tests): one suite run against both runners' use of `collectExports`.
- Updated: `blender-guard` (local routing, C1-C4, C8, C9, C17, line counts C20), `blender-config` / `blender-module` (C19, status lights, notices, busy field), `blender-static-check` (line counts), `blender-setup` (extension steps with scripted fake `io.run`, pin C21), `blender-ui` (card, selector, lights), `blender-sandbox` (still green after the `exports.ts` move), `blender-detect` (launcher rejection), new `blender-routing` or a section in guard tests (C18 matrix incl. Blender not found and VM not configured), `blender-hedge` (C22), `bsv-tripwire` allowlist reason edit, `bsv-hedge` import of the shared phrase list.
- Existing POSIX-only skips for the sandbox stay; the new local tests must run on BOTH Linux and Windows because the spawn, env, kill and path logic are the Windows-sensitive part.

### 6.2 This Windows PC, real Blender (owner's PC, Claude Code on the PC may run it; no downloads needed if Blender is installed)

1. `blender.exe --version`, then Settings, Blender: detection finds it, mode Automatic says "Next script runs: on this computer".
2. Cube + GLB: approve the card; `<workspace>\blender-exports\<task>\*.glb` exists; `scene.blend` and `backups\` exist under `%APPDATA%\legion\blender\local\<task>\`. Repeat for FBX and a PNG preview (`blender_screenshot`). This is the check that the C12 write guard does not break the glTF/FBX/OBJ exporters (they write through Python `open`); if one is blocked, add its temp location to the guard's allowlist and record why.
3. Negative runs through the real runner by temporarily calling it with a hand-written script (below the static check): write outside the task folder is blocked; an infinite loop is killed at 120 s and `blender.exe` is gone from Task Manager (also child processes).
4. Env check: run a script via the runner that lists `os.environ` (hand-written, bypassing the check) and confirm no Legion or API variables.
5. User add-ons not loaded: with the community add-on installed and `blendermcp_auto_start_server` on, a local run opens no socket on 9876 (`netstat`).
6. Path cases: user name with a space; task folder under a long path; OneDrive-redirected `Documents` as the workspace.
7. Mode switch: Settings to VM and Live shows the right errors from the table; legacy config file with `"sandbox":"off"` loads as live.
8. Antivirus/SmartScreen prompts on first spawn of the runner are noted, not fixed.
Record results in `claude/tracker-pc-checks.md`.

### 6.3 Needs the owner present (downloads or accounts)

- Add-on pin: reproduce the sha256 on the PC (section 5.2 TODO) and run Set up for the community add-on once.
- Official extension install on a real Blender 5.1+: `build`, `repo-list`, `install-file`, `extension list`, then start the server from the sidebar and Test connection (needs Blender 5.1+ and `uv`; the first start downloads the server's Python packages).
- VM mode regression after the `exports.ts` refactor needs the boat.dev key (tracker item C already covers the VM checks).

## 7. Work breakdown (3 builders, no shared files)

Step 0 (Builder 2, small, merged first, ~30 min): `src/shared/blender.ts` types and config (`BlenderMode`, `mode`, `advanced.local`, `BlenderStatusView.busy`, `localReady`, `localNote`, `nextRun`, lights `local` and `busy`), `normalizeBlender` migration, `src/core/blender/ports.ts` (`LocalPort`, `ProcessPort`, `RunMode` incl. `'local'`; `'sandbox'` stays as the internal name of the VM mode to avoid churn, shown as "Cloud VM"). Builders 1 and 3 branch from there.

Builder 1: local runner and exports. Owns: `src/core/blender/local.ts` (new), `src/core/blender/exports.ts` (new), `src/core/blender/sandbox.ts` (only: replace private `fetchExports` by `collectExports`), `src/core/blender/system.ts` (`spawnManaged`, `killTree`), `test/bsv-scan.ts` (reason text only), tests `blender-local.test.ts`, `blender-local-runner.test.ts`, `blender-exports.test.ts`, `blender-sandbox.test.ts`, `blender-utf8-env.test.ts`, `blender-fs-safe.test.ts`. Delivers `LocalRunner` passing against `LocalPort`.

Builder 2: routing, guard, config, status, audit, pin. Owns: `src/shared/blender.ts`, `src/core/blender/guard.ts`, `audit.ts`, `static-check.ts` (`countLines` only), `state.ts`, `index.ts` (wiring `LocalRunner` into the module, status lights, notices, `blender_status` text, Sculptor preamble: it currently says "Scripts default to the sandbox"; update to the table), `detect.ts` (launcher rejection), tests `blender-guard`, `blender-config`, `blender-module`, `blender-static-check`, `blender-detect`, `blender-backends` (unchanged expectations), `blender-routing` (new). Depends on Builder 1 only through `ports.ts`; uses a fake `LocalPort` in tests.

Builder 3: UI, setup, docs. Owns: `ui/src/blender/*`, `ui/src/components/Settings.tsx` (Blender section) and `ApprovalCard.tsx`, `src/core/blender/setup.ts` (extension path), tests `blender-ui`, `blender-setup`, `blender-hedge` (new), `test/hedge-phrases.ts` (new) and `test/bsv-hedge.test.ts` (import only), docs: `docs/BLENDER.md`, `SECURITY.md`, `CHANGELOG.md`, `claude/legion-release-tracker.md`, `claude/tracker-pc-checks.md`. Wording in section 4 is fixed here so the constants in `shared/blender.ts` (Builder 2) and the UI strings agree; Builder 2 copies `BLENDER_SAFETY_NOTE` text from section 4.

Order: Step 0 -> Builders 1, 2, 3 in parallel -> integration merge (Builder 2 owns conflicts in `index.ts`) -> full `npm test` on Linux and on this PC -> section 6.2 run -> reviewer.

Reviewer checklist (a separate agent, adversarial, reads code not the plan):
1. Every row of C1-C22 has a test that fails under its stated mutation (run each mutation, record red).
2. No `process.env` spread anywhere in the local path; no `shell:true`; no spawn outside `system.ts`; tripwire green.
3. `resolveMode` matrix test equals the table in 2.3 line by line; no path from vm or local to a looser place.
4. The approval is awaited before any directory is created or any process spawned; audit `approved` before spawn; a thrown error at any step ends in one `completed` line, never a missing one.
5. Card for local shows the full script, correct line count, "On this PC", no key approval; the live card unchanged.
6. Docs and UI strings: no overclaim; the section-4 required statements present; hedge test mutated and red.
7. Exports: `.blend` never in `blender-exports`; sandbox tests unchanged in meaning after the move.
8. Windows: paths with spaces, junctions, case-insensitive compares, trailing-separator compare, `blender-launcher.exe` refused.
9. Config migration from a pre-change `config.json` fixture, both directions (downgrade mirror).
10. Pin values exactly as in 5.2 and the TODO OWNER PC marker present in docs and tracker.

## 8. Risks and open questions (owner)

1. **Upgrade behaviour.** Existing installs with the bridge on and `auto` start running scripts on this PC after the update (card still required for each script). Recommended default: do as directed (local-first for `auto`) and show the upgrade notice in Settings and the Ops card until a mode is saved. Alternative: keep already-enabled installs on `vm` once. Decide before release.
2. **Is a Python-level write/network guard worth shipping in v1?** It can block a legitimate exporter that writes to an unexpected temp path, and it narrows only Python-level actions. Recommended default: ship it armed with the allowlist (task folder, Blender temp, `extraWriteDirs`), and fall back to log-only (`advanced.local.guard: 'log'`) if the PC run in 6.2 step 2 shows exporter breakage, saying so in the docs.
3. **Where task folders live and how long they stay.** Recommended default: `%APPDATA%\legion\blender\local\<task>`, kept until the user clears them; show total size in Settings; no auto-delete in v1. Alternative: inside the agent's workspace (easier for the user to find, but the agent's own tools can then edit `scene.blend`).
4. **Minimum Blender for local mode.** Recommended default: 3.0 (same as the community backend) with the 4.2+ recommended in the UI; Cycles preview and export operator names vary by version and only the PC run shows what breaks. Alternative: require 4.2+ to cut the support surface.
5. **Windows Job Object / hard resource limits.** Recommended default: not in v1 (timeout kill by PID tree plus output and folder caps only), listed as a known gap in `SECURITY.md`. Alternative: add a small native or PowerShell job-object wrapper later if the owner wants memory caps; it adds a new execution surface to review.

Not owner decisions but flagged: community add-on project moved and the new file makes outbound connections when its GUI server runs (docs); `weak_sandbox.py` in the official add-on was not reviewed (name only).

## 9. Doc updates (Builder 3, same PR as the code)

- `docs/BLENDER.md`: "What it is" (three places a script can run, local is default when Blender is found); new "Local mode" section: flow, task folder layout, the C11-C14 hardening with the "does not prove" column, config `mode` and `advanced.local`, the decision table; "Set up" step 3 (extension install, not the legacy folder); "What is pinned" (community commit and sha, TODO OWNER PC marker, renewal procedure); "Safety model" step 5 (local run, busy while running, kill by PID tree); "Limits" (a local script runs as you; the write guard is Python-level only; no CPU or memory cap); "Not verified yet" (local mode on real Blender/Windows, extension install, pin sha on the PC); "Files" (`local.ts`, `exports.ts`, `ports.ts`); fix the sentence "the .blend is backed up before the first live script" to cover per-run local backups; remove the "legacy add-on may not work for an extension" paragraph once verified, until then reword to "extension path implemented, not yet run on a real Blender".
- `SECURITY.md`: update the "Blender Bridge residuals" paragraph (default is local headless when Blender is found; the VM is the isolated option; live keeps the socket limit) and the two table rows (`Blender add-on socket` applies to live only; `Downloaded Blender parts` now says community add-on pinned to a commit and sha256, add-on makes its own outbound connections when its GUI server runs). Add a row "Local Blender script: runs with your user's rights; Legion's check is a filter; controls are the card, backup, audit; runner write/network guard is Python-level only".
- `CHANGELOG.md` under `[Unreleased]`: Changed (default becomes local headless when Blender is found; `sandbox` setting replaced by `mode`, old value read and mirrored; upgrade notice), Added (local headless mode, per-task scene and backups, `blender_exec`/`inspect`/`screenshot` with `mode:"local"`, busy state while a script runs, extension install for the official add-on, pinned community add-on), Fixed (line count counted the trailing newline, in the check and the audit). Wording through the hedge test.
- `claude/legion-release-tracker.md`: item D state -> "plan approved / building / built, PC run pending" as it moves; add the TODO OWNER PC items (pin sha reproduce, extension install on 5.1+, local mode PC run 6.2) to `claude/tracker-pc-checks.md`.

## 10. Owner decisions (2026-10-02)

1. Upgrade behaviour: **confirmed** - existing `auto` installs switch to local-first, with the upgrade notice until a mode is saved.
2. Python-level write/network guard: **confirmed** - ships armed, with `advanced.local.guard: 'log'` as the documented fallback if the real-Blender run on the owner's PC shows exporter breakage.
3. Task folder `%APPDATA%\legionlender\local\<task>`, kept until cleared: **assumed, not confirmed**.
4. Minimum Blender for local mode 3.0, 4.2+ recommended: **assumed, not confirmed**.
5. No Windows job-object resource limits in v1 (known gap in SECURITY.md): **assumed, not confirmed**.
Independent facts check (2026-10-02, GitHub metadata only, no download): repo moved to `ahujasid/mcp-for-blender` (MIT, id 944414751, not archived), no tags/releases, commit `91cd735c` exists and is the latest to touch `addon.py`, size 270,889 bytes matches. The sha256 is NOT independently reproduced: owner-PC TODO stays.

## 11. Follow-up task B4: managed Blender (owner request 2026-10-02) - starts AFTER B1-B3 merge, not steered into them

Owner: Legion should be able to fetch Blender itself, or let the user install normal Blender, so local mode works without a pre-installed Blender. Decision: do NOT bundle Blender in the installer or repo (GPL-3.0-or-later Blender next to MIT Legion is allowed only as a separate unmodified program with licence text and source offer, but the size of a few hundred MB zipped, patch burden and antivirus noise outweigh it; Windows has no separate headless build, it is `blender.exe -b`). Instead:
1. Settings button "Get Blender for Legion": downloads ONE pinned official portable build (fixed version and URL, sha256 pinned in `DEFAULT_ADVANCED`) into `<dataDir>/blender/app/<version>/`, verifies the sha256, extracts, records it. Needs the owner's/user's explicit go each time (download rule); refuses a hash mismatch and installs nothing; extraction guarded against path traversal and links; size and redirect limits like the existing setup downloads; licence text and source link shown and kept in the folder.
2. Detection (`detect.ts`) prefers the managed copy when present, else the user's own install; the managed copy never touches the user's normal install.
3. Button "Open the Blender download page": opens blender.org in the browser (no Legion download). The winget command is SHOWN as copyable text, never run by Legion (a spawn would need a tripwire allowance and an admin prompt).
4. NOTICE/docs: Blender is downloaded not bundled, GPL-3.0-or-later, separate program; hedge-test wording.
Files (all after B1-B3 merged, so no concurrent edits): new `src/core/blender/get-blender.ts` (pure, takes an injected fetch/fs port; spawn only if extraction needs it and then only in `system.ts`), `detect.ts`, `src/shared/blender.ts` (pins), Settings Blender section and `blenderStore.ts`, tests `blender-get.test.ts`, docs, `NOTICE`. Version/URL/sha256: the cloud agent looks up metadata only (no large download); a hash that cannot be reproduced is marked TODO OWNER PC like the add-on pin (decide the version with the owner; recommend the current LTS that satisfies the local-mode minimum).
