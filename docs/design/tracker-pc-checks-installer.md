# Installer bootstrap: checks that need a real Windows PC

Cloud/Linux covered: pure logic, fake-nodejs.org download tests under pwsh 7 (good, wrong sha256, truncated, oversize, zip-slip, redirect, existing Node, no/yes, idempotent, uninstall ownership, link not followed). Not verified anywhere yet: everything below. No .exe in v0.2.0.

| # | Check (Windows 10/11 PC) | Expect |
|---|---|---|
| I1 | Machine with NO Node: run `setup.cmd`, answer n | Prints the winget line, nothing downloaded, no `runtime\` folder |
| I2 | Same, answer y (Windows PowerShell 5.1) | About 36 MB from nodejs.org, sha256 checked, `<install>\runtime\node\node.exe` + `.legion-owned`, setup continues through `npm ci` and build |
| I3 | Run `setup-yes.cmd` with no Node | No question; installs Node, Legion, starts it |
| I4 | After I2, check system PATH / registry | Unchanged; `where node` still finds nothing outside the Legion folder |
| I5 | Launch Legion from the Desktop shortcut | Core starts using `runtime\node\node.exe` (core.log, Task Manager path); no "Node not found" message |
| I6 | Re-run setup.cmd | No question, no download, same runtime reused |
| I7 | Machine with Node 22 on PATH | Used, no download, no `runtime\` |
| I8 | Machine with Node 18 on PATH | Treated as too old (needs 20.10), asks |
| I9 | Windows on ARM (if available) | arm64 zip chosen, runs |
| I10 | Corporate proxy / offline | Download fails with a plain message plus the winget line, nothing left in `runtime\` |
| I11 | Antivirus/SmartScreen on the downloaded `node.exe` | Note any block (the file is the official signed Node build) |
| I12 | `uninstall.cmd` on an install with runtime | `runtime\node` gone, install folder gone; on a source checkout only `runtime\node` goes |
| I13 | Put a junction at `<install>\runtime\node` to a folder with a test file, run uninstall | Junction removed, test file still there |
| I14 | Setup with a read-only or antivirus-locked `runtime` | Clear error, no half install |
| I15 | Update from an install made before this change (no runtime) with robocopy /MIR | `runtime\` and `.update\` survive the mirror |
| I16 | Confirm `nodejs.org/dist/v24.21.0/` still serves the x64 and arm64 zips and SHASUMS256.txt (pin) | 200, no redirect (verified from the cloud on 2026-10-02 for x64: sha 158f7685..., 37,618,919 bytes) |
