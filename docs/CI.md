# CI: how Legion is tested on every push

Every push to `main` and every pull request runs the whole test suite on GitHub's hosted runners: Windows, Ubuntu and macOS (Apple Silicon). The workflow is [.github/workflows/ci.yml](../.github/workflows/ci.yml). This page says what runs, what it costs in time, how it is locked down, and what the runners taught us about the code.

## What runs

| Job | What it does |
|---|---|
| `test windows-latest 1/4` … `4/4` | `npm ci`, `npm run build:ts`, then a quarter of the test files |
| `test ubuntu-latest 1/2`, `2/2` | the same, half the files each |
| `test macos-latest 1/2`, `2/2` | the same, on Apple Silicon (arm64) |
| `typecheck + UI build` | `npm run typecheck` (core and UI), `npm run build:ui` |
| `installer (Windows PowerShell 5.1)` | the real `setup.ps1` / `uninstall.ps1` / `setup-yes.cmd` under Windows PowerShell 5.1, from folders with spaces, including the refusals (a foreign folder, `C:\`, `C:`) |
| `install scripts (syntax)` | `sh -n` on `scripts/install/install.sh`, a check that it has no CR bytes and starts with `#!/bin/sh`, and a PowerShell parse check of `scripts/install/install.ps1` |

The split uses Node's own `node --test --test-shard=<i>/<n>`, which deals out test **files** round-robin. Each OS's shards add up exactly to that OS's full run. Jobs do not stop each other on failure (`fail-fast: false`), and a newer push to the same branch cancels the older run.

## Installer smoke tests (separate workflow)

[.github/workflows/install.yml](../.github/workflows/install.yml) runs the one-line installers for real, from the checkout, into a temp folder, never launching Legion:

- `install.ps1 -NoLaunch` on Windows PowerShell 5.1 and on PowerShell 7. It downloads the release zip (the full app), checks its SHA-256, runs the package setup, then checks the installed version, `electron.exe` and that the temp folder was removed. The 5.1 job then runs the script-block form (as `irm | iex` with options) as an update over the same folder.
- `install.sh --no-launch` on Ubuntu and macOS, with a fresh `HOME`. It clones the real latest tag, runs `npm ci` and `npm run build`, then checks the build output, the launcher in `~/.local/bin`, that the Electron binary exists, and the version. A second run checks the in-place update.

When it runs: on a pull request or push to `main` that changes the installer paths (`scripts/install/**`, `scripts/setup.ps1`, `scripts/lib/package-*`, `scripts/lib/legion-procs.ps1`, the workflow itself), nightly, and by hand (`workflow_dispatch`) after a release.

A red nightly run emails the repository owner by GitHub's default notification settings.

It installs the live latest release by design, so it is not part of the per-push gate: a broken release or a GitHub outage would turn every unrelated pull request red. The fast, hermetic `install scripts (syntax)` check stays in `ci.yml`. The workflow has the same lock-down as `ci.yml` (read-only token, no `pull_request_target`, SHA-pinned actions, time limits).

## Before and after

Measured on run [37433983238](https://github.com/dnh33/legion/actions/runs/37433983238) (the last run before this setup, red) and run [37451985877](https://github.com/dnh33/legion/actions/runs/37451985877) (green).

| | Before | After |
|---|---|---|
| Whole run, wall-clock | 4 min 58 s, red | 3 min 53 s, green |
| Windows | 1 job, 4:50 | 4 shards, slowest 2:36 |
| Ubuntu | 1 job, 3:29 | 2 shards, slowest 2:25 |
| macOS (Apple Silicon) | not tested | 2 shards, slowest 3:44 |
| Typecheck + UI build | inside each OS job | 0:34, once |
| Installer job | 0:23, red | 0:31, green |
| Test runs per push | 5,632 | 8,477 |

Per OS on the green run, with 0 failures everywhere:

| OS | Tests | Pass | Skipped |
|---|---|---|---|
| Windows | 2,837 | 2,792 | 45 |
| Ubuntu | 2,797 | 2,790 | 7 |
| macOS | 2,843 | 2,822 | 21 |

The skips are platform-bound tests, each with its reason in the test file (for example, POSIX-only emulation on Windows, a Windows-only file-lock behaviour elsewhere).

So: 50 % more test runs, a third operating system, and 65 s less wall-clock. The slowest shard decides the run now, and it is macOS.

## How it is locked down

- The workflow token can only read the repository (`permissions: contents: read`, also the repository default).
- It runs on `pull_request`, never `pull_request_target`, so a pull request from a fork gets no secrets and no write access. The workflow uses no secrets at all.
- `actions/checkout` runs with `persist-credentials: false`: the token is not left in the checkout's git config.
- Every action is pinned to a full commit SHA (checkout v7.0.1, setup-node v7.0.0), with the version in a comment. Dependabot keeps the pins current.
- Every job has a time limit, and every test has a 3-minute limit (`--test-timeout=180000`). A test that hangs fails with its name, and so does a test file that stays open after its tests (seen on macOS: `browser-chromium-launch.test.js` "timed out after 180000ms"), instead of stalling a job until GitHub cancels it.

## What the runners taught us

Moving the suite onto clean machines found three real bugs and several environment traps.

**Real bugs, fixed:**

- **House files on Linux never updated.** On Linux, `fs.copyFileSync` gives the copy the time of the copy (libuv copies with `copy_file_range`); on Windows, `CopyFileW` keeps the original's time. The house sync compared times, so on Linux every shipped file looked newer than the release, and each update was kept back as "your newer copy". The copy is now stamped with the source's time. A second trap sat inside the fix: Node rounds a `Stats` date to the nearest millisecond, so stamping with `st.mtime` can put the copy 1 ms in the future. The stamp uses seconds as a number, and the comparison allows 1 ms.
- **A backslash path did not work in the house tools on macOS and Linux.** On POSIX a backslash is a filename character, so `docs\adr\x.md` did not resolve, and `..\x` named a file instead of an attempt to leave the folder. Backslashes are now separators everywhere.
- **Blender refused its own export folder under a short-name `LEGION_HOME`.** Windows can spell a folder in its 8.3 short form (`C:\LEGION~1`). Node's JS `realpathSync` keeps that form; `realpathSync.native` expands it. Legion's Blender safety check refuses any path with `~` (it would be a home-folder shortcut), so it refused paths inside Legion's own folder. It failed safe, but it did not work. The folder resolver now returns the long form. GitHub's Windows runner found this: its temp folder is `C:\Users\RUNNER~1\...`.

**Environment traps (the tests were fixed, not the product):**

- GitHub ends every PowerShell step with `exit $LASTEXITCODE`. The installer check proved `setup.ps1` refuses `C:\`, `C:` and a foreign folder, then failed because the last refusal correctly exited with 1. The steps now end with `exit 0` after their own checks.
- The Windows runner user is the built-in Administrator (SID ending in `-500`). Under that elevated token a new file can be owned by the Administrators group, so the config-file permission test also accepts the user's own SID. Everyone, Users and Authenticated Users are still refused.
- POSIX has no share-mode file locks: a file held open can still be moved. The "folder held open" installer test runs on Windows only.
- macOS has no `/proc`. The emulator tests read a process's arguments and environment with `ps -E` there, and first check that `ps` really shows the environment, so an empty answer cannot pass.
- macOS adds `__CF_USER_TEXT_ENCODING` to every process, and its temp folder `/var/...` is a link to `/private/var/...`. Test temp folders are created in their real, long form for both reasons.
- The Blender sandbox tests fake the Linux VM with the host shell. The runner lists exports with GNU `find -printf`, which macOS's BSD `find` lacks, so those tests run on Linux, where the real VM's userland matches.
- One browser test stopped its fake browser only when every assertion passed. On macOS a failed assertion left the browser running, which kept the test file alive for 20 minutes until the job was cancelled. It now always stops the browser.

## Running the same thing locally

```bash
npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui
```

One shard, as CI runs it:

```bash
node --test --test-shard=1/4 "dist/test/*.test.js"
```

See [TESTING.md](TESTING.md) for the fake-backed harness and what can only be checked on a real PC.
