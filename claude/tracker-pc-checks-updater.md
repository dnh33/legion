# Real-PC checks: updater (owner or a computer-use run; nothing here was verified in the cloud)

Safety class for all: downloads of a Legion release from GitHub only; no wallet, no funds. Use a COPY install (`-InstallDir`) first, not the daily one. Needs a real signed test release in a throwaway repo or the real repo (owner publishes by hand; the signing key stays with the owner).

- U1. Apply on Windows: with Legion running and idle, publish version N+1; check shows the notice, Update asks a card, download, "ready", quiet 60 s, app restarts itself, new version shown, shortcut still works, `~\.legion` unchanged, `.update\prev` holds exactly the old build.
- U2. Real hosts: the download follows GitHub's redirect; record the exact hosts seen (expected github.com then objects.githubusercontent.com or release-assets.githubusercontent.com). If another host appears the allowlist must be changed deliberately, never loosened.
- U3. Busy: start a task, publish an update; it must stay "ready, will install when idle" and never restart mid-task; pending approval card also blocks; finishing and waiting installs.
- U4. Restart now: native dialog lists the running task; confirm; the task is `cancelled`, the app returns, nothing resumes by itself, Settings lists what was stopped.
- U5. Files in use: open a Claude Code session with the Legion folder as cwd (or a cmd window in `dist`); apply must retry, then roll back with the "files in use" message and leave the old build running.
- U6. Rollback: publish a release whose core fails to start (test build only); the old build must come back within about 90 s and the version must be marked failed.
- U7. Killed mid-update: kill the helper (by PID in Task Manager) during the swap; next launch must recover (rollback) before the core starts.
- U8. Antivirus/SmartScreen holding files during the swap; long path; non-ASCII user name; install dir on another drive; install dir through a junction.
- U9. Offline and low disk: unplug network; no dialogs, no CPU spin. Fill the disk to near-full: preflight message, live tree untouched.
- U10. Checkout mode: run from a git clone; notice only, nothing executed.
- U11. `taskkill /PID /T /F` of the new build on a failed health check does not kill unrelated Electron/node processes.
- U12. The stdio MCP proxy (Claude Code session using Legion's MCP) calling during the restart: record whether a headless core grabs the port and whether the new app replaces it.
- U13. Release checklist (owner): generate the real key with `scripts/release-keygen.mjs` outside the repo, paste the PUBLIC key into `src/core/updater/trust.ts`, build, run package, manifest, sign, publish, and install the previous version to test the path end to end before announcing.
