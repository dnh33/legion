# Browser (Lightpanda) checks only the owner's PC or the real binary can do

Nothing in this list was run in the cloud session. Tests there use a fake lightpanda and a fake CDP server only.

- BR1 Install Lightpanda inside WSL2 (README: no native Windows binary). Run `lightpanda serve --help` and confirm every option in plan-browser.md section 1 exists in the build you chose.
- BR2 Pick a numbered release (or one nightly), compute sha256, record it in `browser.advanced.managed.sha256` (or the pin). "Get Lightpanda" must refuse with the instruction while it is empty.
- BR3 Set the launcher `wsl.exe -e <path>/lightpanda`. Start a run, call `browser_open` on a harmless public page: the card appears, the page text comes back wrapped.
- BR4 After the run ends, check the Linux `lightpanda` process is gone (`wsl ps`). Also after cancelling a run and after quitting Legion.
- BR5 From Windows, does `127.0.0.1:<port>` reach the WSL process? (WSL localhost forwarding.)
- BR6 Redirect test on a page YOU control that redirects to `http://127.0.0.1:<some port>/`: the result must be a refusal and no content. Also a page whose script does `fetch('http://192.168.x.x/')`: does `--block-private-networks` stop it?
- BR7 DNS rebinding sample (a name you control that flips between public and 127.0.0.1): does the browser block it?
- BR8 Does the build answer CDP `Fetch.enable`? `browser_status` shows it.
- BR9 Never point it at the wallet port; the guard refuses it. Do not test that against the real wallet.
- BR10 Confirm no files appear in the Legion data folder or the WSL home after a run (no profile, cache or cookie jar).
- BR11 Licence: confirm you are happy to have Legion download (not bundle) an AGPL-3.0 program.
- BR12 Native dialogs (safety class: native dialog). In the app: Settings, About, Browser. (a) "Use this program" with `wsl.exe` and the arguments: a dialog names the program and arguments, the default button is Cancel; Cancel changes nothing; Confirm saves and Test passes. (b) "Allow local addresses" with a port: dialog names the ports and says it lasts until restart; after a restart it is off again. (c) Evidence: a screenshot of each dialog. Expected: nothing is saved without Confirm; the Settings page alone (browser dev tools) cannot make the same change.
- BR13 WSL kill (safety class: none). Start a run that opens a page, then cancel the task: the `lightpanda` process inside WSL (`wsl ps aux | grep lightpanda`) must be gone within a few seconds. Also after quitting Legion with a run open. The launcher puts `timeout -s KILL <seconds>` before the program so it cannot outlive the wall time (30 minutes) even if killing wsl.exe does not reach it.
- BR14 Loopback bind (safety class: none). Legion passes no host option because `serve` defaults to 127.0.0.1 (documented in the CLI help). In WSL while a run has a page open: `ss -ltnp | grep lightpanda` must show `127.0.0.1:<port>` and NOT `0.0.0.0` or `*`. If it does, stop: tell the builder, the tool must not ship on that build.

## Chromium-family engine (Edge, Chrome, Brave): checks BR15 to BR22
Nothing here was run in the cloud session; the tests use a fake browser script and a fake CDP server. Safety class for all: none (use a harmless public page you control), unless noted.
- BR15 Real Edge starts. Windows 10/11, Legion with the browser on and the engine automatic. Run a task that opens a harmless page. Expected: the open result says "Engine: Microsoft Edge <version> (headless)"; Settings shows the version Legion read from the install folder; a `legion-browser-*` folder exists in %TEMP% during the run and is gone after; no Edge window appears. Evidence: the result text, the Settings line, `dir "%ProgramFiles(x86)%\Microsoft\Edge\Application"` (version folder names). If Edge does not start with Legion's reduced environment, tell the builder (it may need more variables).
- BR16 Guards on a real Edge (page YOU control): redirect to http://127.0.0.1:<some other port>/, a sub-resource image from a private address, a download link, `window.open`, a `file:` link, a `data:` navigation. Expected: each is refused or blocked and no content returned; no file appears in Downloads; no extra window. Also confirm every redirect hop was checked (a two-hop redirect chain ending on a private address).
- BR17 Gaps to measure (not expected to pass): a page script opening a WebSocket to a private address; WebRTC; a service worker; a DNS-rebinding name. Record what happens; the plan lists these as not protected.
- BR18 Kill: cancel a task with a page open, then quit Legion with one open: no msedge.exe left that Legion started (`tasklist /fi "imagename eq msedge.exe"` before and after; judge by PID, do not kill by name). Note: if the owner's normal Edge is open, its processes are separate.
- BR19 Your own Edge is untouched: open Edge normally before and after; its profile, tabs and logins are unchanged; nothing from them was used.
- BR20 Chrome and Brave if installed: set the path in Settings (native dialog, Cancel is the default) and repeat BR15.
- BR21 Engine switch: set Lightpanda (WSL launcher) then back to automatic; confirm an open task keeps its engine and a new task shows the new one.
- BR22 Too-old or missing browser: temporarily set a wrong path; the open fails with a plain message and Lightpanda is NOT started instead.
