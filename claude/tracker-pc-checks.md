# Checks that need the real Windows PC (collected from reviewer reports)

Source: `review/release-packaging-review.md` section 5 (branch `claude/review-release-packaging`) and `review/mcp-isolation-review.md`. Cloud reviewers ran Linux only; none of these is proven yet. Update the State column as each is run on this PC.

## Installer (release-packaging review, sec. 5)

| # | Check | State |
|---|---|---|
| P1 | Double-click `setup.cmd` and `setup-yes.cmd` on Windows 10/11 with Windows PowerShell 5.1: window stays open on success and on a forced failure (Node missing, `npm ci` fails) | todo |
| P2 | `setup.cmd < nul`, `echo \| setup.cmd` from cmd, and `cmd /c setup-yes.cmd` with no console (Task Scheduler): `IsInputRedirected` gives the same answer everywhere | todo |
| P3 | Setup with Legion running from (a) the install dir, (b) a source checkout on another drive, (c) an unrelated Electron app that has `src\electron\main.ts` (review F1), (d) VS Code and a `node` dev server open: only Legion's PIDs are listed and stopped | todo, after fix |
| P4 | Install to a path with spaces and non-ASCII (e.g. `C:\Users\Zoe Orsted\Legion Test`): `%~dp0` OEM code page, `uninstall.cmd`, shortcuts | todo |
| P5 | `-InstallDir C:\`, a non-empty foreign folder, and `%USERPROFILE%` with `-DryRun` first (review F2: robocopy /MIR) | todo, after fix |
| P6 | Uninstall: shortcuts pointing at another install are kept; Desktop (incl. OneDrive-redirected) and Start-menu entries go; `%USERPROFILE%\.legion` intact without `/purge` | todo |
| P7 | CRLF survives: downloaded ZIP and a `git clone` with `core.autocrlf=input` still give CRLF `.cmd`/`.ps1` (index stores LF) | todo |
| P8 | SmartScreen / antivirus behaviour on the unsigned `.cmd` files | todo |
| P9 | Fresh `npm ci` + `npm run build` on Windows, launch from the shortcut with the real Electron binary | todo |
| P10 | Setup run from inside a Legion agent (Bash tool) must not kill its own ancestor Legion (review F6) | todo, after fix |

## MCP isolation (mcp-isolation review)

| # | Check | State |
|---|---|---|
| M1 | Review F1: with `inheritMcp` off, does a project/user `.claude/settings.json` `env` block re-enable `ENABLE_CLAUDEAI_MCP_SERVERS`? Reviewer could not verify offline. Fix adds `settings.disableClaudeAiConnectors`; confirm on the real PC with real connectors that none connect (status panel + owner's connector server logs) | todo, after fix |
| M2 | With `inheritMcp` on and `claude mcp add legion http://127.0.0.1:4747/mcp` configured: self-server is switched off after init, no loop (review F6) | todo |
| M3 | The owner's broken `plugin:data:definite` server (ENDPOINT_NOT_FOUND) is the owner's Claude setup, not Legion: tell the owner | note |

## Rooms / key probe / upgrade (review still running)

| # | Check | State |
|---|---|---|
| K1 | Core start makes zero boat.dev calls with the real key; first VM use or opening Settings -> boat.dev runs the probe once | todo |
| U1 | Upgrade from v6-5 state on the PC: Builder resets to `default` once | todo |
| R1 | Room created by a bot with no budget: approval card says no spend limit, running cost visible | todo |

## Also still open from the handoff (section 6.2/6.3)

Real boat.dev checks, real Blender 5.x (official add-on is a Blender extension), tray/second-instance/title bar, Sentinel schedule firing, Forgemaster VM run, Cowork over MCP, approval-card flows end to end, BSV on a testnet wallet in a VM only, perf re-record.
