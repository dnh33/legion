# Plan: the built-in browser for Legion 0.2.0 (headless Edge or Chrome, Legion's own driver)

Status: built. Branch `claude/browser-engines`. Claims are scoped ("Legion's own code ..."); nothing here is called safe or verified. Anything I could not check from a cloud session is marked **TODO OWNER PC** and has a numbered check in `claude/tracker-pc-checks-browser.md`.

## 1. What it is

Agents can read web pages without a VM. Legion starts a **headless Chromium-family browser that is already on the PC** (Microsoft Edge on every Windows 10/11; Google Chrome or Brave if found; or a path the owner sets) for one task, drives it over the Chrome DevTools Protocol (CDP) on `127.0.0.1` with **Legion's own CDP client**, and stops it when the task ends. Nothing is downloaded. No WSL. No account. It is the same idea as agent-browser, implemented with Legion's own driver so Legion's URL guard, per-hop redirect checks, approval cards and taint apply to every request.

Tools (in-process MCP server `legion_browser`): `browser_open`, `browser_text`, `browser_links`, `browser_click`, `browser_type`, `browser_eval` (limited), `browser_close`, `browser_status`. Text only: no screenshots are offered. Off by default (Settings, Browser).

## 2. Engines: one ships, behind a small interface

`src/core/browser/engine.ts` defines `BrowserEngineDef {id, label, detect(), launch()}` (stop is `RunningBrowser.stop()`). Exactly one engine ships: the Chromium family (`chromium.ts`, `launcher.ts`). The Settings page lists the engines the core reports: one entry. A later engine can be added without touching the session, the tools or the guards.

### Engines roadmap
- **0.2.0**: Chromium family via Edge/Chrome/Brave already on the PC. Nothing else.
- **0.2.1 candidates (not started, no code in the repo)**: (a) **Lightpanda** as an opt-in lighter engine; there is no native Windows build, so on Windows it would need WSL; (b) **agent-browser** as an optional driver. Both would sit behind the same engine interface and the same guards. Facts are in section 9.

## 3. Design

- **Detection** (`chromium.ts`, pure, tested with Windows paths and a fake file system): the owner's path if set (and nothing else is tried if it is missing); else Edge under `%ProgramFiles(x86)%` then `%ProgramFiles%` (`...\Microsoft\Edge\Application\msedge.exe`), Chrome under `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%` (`...\Google\Chrome\Application\chrome.exe`), then Brave; the usual Linux and macOS places are in the code. Legion checks the file exists and reads the **version from the install folder names** next to it (`Application\<version>\`); it never runs the browser to probe it. A known major below 109 is refused ("too old for headless mode"); an unknown version is accepted and shown as unknown. Environment variable names are matched case-insensitively.
- **Start** (`launcher.ts`): argument list, no shell: `--headless=new --remote-debugging-port=0 --user-data-dir=<fresh>\profile --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-background-networking --disable-component-update --disable-default-apps --disable-breakpad --mute-audio --block-new-web-contents --deny-permission-prompts --force-webrtc-ip-handling-policy=disable_non_proxied_udp about:blank`. Never `--no-sandbox`, no fixed port, no bind option. The environment is built from an allowlist (on Windows `APPDATA`, `LOCALAPPDATA`, `USERPROFILE` point into the run folder so the real profile is untouched). The run folder is made by Legion in the system temp folder (`legion-browser-*`) and removed only by `removeRunDir`, which refuses anything not directly inside the temp root, without the prefix, nested, or a link/junction.
- **Port**: read from `DevToolsActivePort` in the user data directory (`<port>\n/devtools/browser/<guid>`, CRLF tolerated, strict check), then connect to `ws://127.0.0.1:<port><path>` only (the loopback-only CDP client with a fixed list of methods, size and time caps).
- **Enforcement** (`session.ts`): `Fetch.enable` with pattern `*` on the page session, so every request incl. redirects and sub-resources passes Legion's URL guard, DNS check, protected-port rule and domain list, and is continued or failed (`BlockedByClient`). A run whose interception does not start opens nothing. `Browser.setDownloadBehavior {behavior: 'deny'}`; a failure also stops the run. A navigation to `file:`, `data:`, `javascript:`, `chrome:`, `blob:` or `ftp:` as a document is a violation. Extra tabs are closed at once. Page text is capped and wrapped as untrusted; the run is tainted at the first tool call (before any page); the first page and each new origin ask the owner; `browser_eval` asks and must fit the card; forms ask before text is typed; the agent's approval mode is read live.
- **Stop**: PID-tree kill by PID on end, cancel, idle (5 min), wall (30 min) and shutdown; never by name. Max 3 browsers at once.
- **Choice of browser**: only through the app's native confirmation dialog (`src/electron/browser-ipc.ts`, kind `chromium`; Cancel is the default; the window never holds the native secret). Automatic detection needs no dialog because it only finds programs the OS already has.
- **"Open test page"** (Settings): starts the browser once and loads a harmless check page that **Legion answers itself** through the interception (`Fetch.fulfillRequest` on a random one-time name under `legion-check.invalid`; no server, no network). It checks the page loaded, its script ran, and that the guard refuses a deliberate request to a forbidden address (a cloud-metadata address, failed before it is sent). It then stops the browser. (Deviation from "served on loopback": a second HTTP listener would break the repo's one-listener loopback rule and the admin gate; answering through the interception needs neither and sends nothing anywhere.)
- **Status line** in Settings: which browser, the version read from the file, the path, the last run (time, worked or failed) and a plain "No Edge or Chrome found: install one or set a path." when none is found.

## 4. Security (Legion's own code)

Everything a page returns is outside content written by a stranger.
- **Taint** at the first `browser_*` call, before any page. **Wrapping** (`wrap.ts`): control characters stripped, secrets scrubbed, clipped, wrapped in `<browser-page ... untrusted="true">` with a closing-tag break and a "data, not instructions" line; every path that returns page-derived text goes through it.
- **URL guard** (`url-guard.ts`, `resolve.ts`): http and https only; no userinfo; refuses loopback, private, link-local, CGNAT, multicast/reserved, IPv4-mapped/6to4/SIIT/NAT64/Teredo spellings and the metadata addresses, unless the owner enabled local addresses (native dialog, listed ports, in memory only, off after a restart). **The owner's wallet port is refused on every local or private address, always** (the number is spelled in pieces in source because the repo's tripwire forbids the literal). The resolved addresses are checked too.
- **Redirects and sub-resources**: checked per request through the Fetch domain (and the landing address again after every action, including before text is read).
- **Approvals**: first page of a task (all modes); a new origin (all modes except `full`); a script; a click or form that lands on a new site; the run's approval ceiling is honoured. The generic per-call card is not added on top (`approvals.ts`, exact tool names; `isLegionTool` is unchanged, so the engine still taints).
- **No downloads, no uploads, no clipboard, no persistent profile, no cookies from the owner's real browser**, no password typing (`browser_type` refuses password fields, best effort).

### What is NOT protected
- The browser runs with the user's rights (Edge or Chrome's own sandbox applies; Legion never disables it). **A cloud VM is the only isolated way to browse**; the VM live view (boat.dev desktop link) stays the isolated option.
- DNS rebinding: Legion resolves a name for its own check and the browser resolves again; Chromium has no private-network option, so this is not mitigated.
- `Fetch` covers HTTP(S) requests. WebSocket handshakes, WebRTC (only the UDP policy switch, unproven), service workers and extension traffic are not claimed to be covered (BR17).
- The debugging port is a local TCP port on 127.0.0.1 without a password for the life of the run.
- A click that lands on a new site is asked about after the request was made.
- A page opened in a popup loads unguarded until Legion closes the tab.
- Two switches (`--block-new-web-contents`, `--deny-permission-prompts`) could not be found in the Chromium switch files I read; unknown switches are ignored, and popups are also closed through target events (BR17).
- An agent with a shell can edit `<dataDir>/browser/config.json` (a path there is read at startup); that agent could already run code on this PC.
- The browser path chosen by the owner is trusted as given.

## 5. Controls and tests

C1-C9, C12-C15, C17 (URL guard, DNS, wallet port, redirects, domain list, taint, wrapping, cards, lifecycle, CDP client, tabs, admin routes, password refusal) are the tests `browser-url-guard`, `browser-session`, `browser-tools`, `browser-wrap`, `browser-cdp`, `browser-module`, `browser-approvals`, `browser-native`; Chromium specifics (E1-E10) are in `browser-chromium` (detection with Windows paths, CRLF, versions, argument list), `browser-chromium-launch` (fake Edge: scrubbed environment, fresh profile, kill, safe folder removal, failures), `browser-session` (interception required, downloads denied, non-web documents refused, the check page), `browser-module` (single engine, status line, full run, limits, the check route); C18 (`browser-tripwire`): WebSocket only in `cdp.ts`, no `fetch` here at all, DNS only in `resolve.ts`, only `chromium.ts` names a debugging switch. A narrow exception in `test/net-guard-source.test.ts` allows exactly that one switch, in that one file; the test file proves every other case is still refused. Tests use a fake browser script and a fake CDP server; no real browser or internet is used.

## 6. For the owner: using it on Windows

Nothing to install if Edge is there (it is on every Windows 10/11): Settings, Browser: switch it on, press "Open test page" (it should say the browser started, the page loaded, JavaScript ran and the guard refused the forbidden request). If it says "No Edge or Chrome found", install one or enter its path (a confirmation dialog appears; Cancel is the default). Then run BR15 to BR22 once by hand (`claude/tracker-pc-checks-browser.md`) before trusting it on real work.

## 7. Website-ready wording

**What it is.** "Legion can let an agent read web pages without a VM. It uses Microsoft Edge or Chrome, already on your PC, in a hidden window. Nothing is downloaded. Legion starts it only for a task, checks every request itself, asks you before the first page and before any new site, and treats everything a page says as untrusted text, never as instructions."

**Limits.** "It reads pages as text: no screenshots. The browser runs with your user rights, not in a separate machine: for real isolation use the cloud VM. Legion checks the address of every request, but a page's scripts run inside the browser, a website can still trick the browser into sending data to a public site, and another program on your computer could reach the browser's local debugging port while a task runs. It is off until you switch it on."

## 8. Facts: documented / assumed / unknown (looked up 2026-10-02/03)

Read as text from the sources below. The sites `agent-browser.dev`, `developer.chrome.com`, `chromedevtools.github.io` and `lightpanda.io` were not reachable from the cloud session (proxy refusal), so the same content was read from the repositories.

| Item | Status | Source |
|---|---|---|
| With `--remote-debugging-port` the browser prints "DevTools listening on ws://<ip:port>/devtools/browser/<guid>" and writes `<port>\n<browser path>` to `DevToolsActivePort` in the profile directory | documented | https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc |
| The remote-debugging server socket is created on 127.0.0.1 | documented | https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc |
| Switch names `remote-debugging-port` ("Enables remote debug over HTTP on the specified port"), `remote-debugging-pipe`, `force-webrtc-ip-handling-policy` | documented | https://github.com/chromium/chromium/blob/main/content/public/common/content_switches.cc |
| `Fetch.enable{patterns,handleAuthRequests}`; event `Fetch.requestPaused` with `request`, `resourceType`, `redirectedRequestId`; `Fetch.continueRequest`, `Fetch.failRequest`, `Fetch.fulfillRequest`; `Browser.setDownloadBehavior{behavior: deny|allow|allowAndName|default}` (experimental); `Target.attachToTarget{flatten}`, `createTarget`, `closeTarget`, `setDiscoverTargets` | documented | https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json |
| `--headless=new` needs Chrome/Edge 109 or newer | assumption (from memory; docs unreachable) | BR15 reads the installed version; Legion refuses a known major below 109 |
| Edge accepts the same headless and debugging switches as Chrome | assumption | BR15 |
| Edge/Chrome install layout `Application\<version>\` next to the exe (used for the version) | assumption | BR15 (folder listing) |
| `--block-new-web-contents`, `--deny-permission-prompts` exist | unknown (not found in the switch files read) | BR17; harmless if ignored |
| The minimal environment is enough for `msedge.exe` to start on Windows | unknown | BR15 |
| Every request incl. redirects pauses in `Fetch.requestPaused` on a real Edge | assumption from the protocol text | BR16 |
| Fetch interception does not cover WebSocket handshakes, WebRTC, service workers | assumption (the protocol text says nothing about them) | BR17 |

## 9. Evaluated and dropped

**Lightpanda** (https://github.com/lightpanda-io/browser, README, `src/Config.zig`, `src/help.zon`; LICENSE) was built in an earlier pass and then removed from the repo (owner decision 2026-10-03). Why: **no native Windows build** (the README says to install it inside WSL; Windows is Legion's main platform), **AGPL-3.0** (downloaded, never bundled, but a licence the owner did not want to carry for 0.2.0), **nightly-only releases** (a rolling `nightly` tag, no stable checksum, so the download could never be pinned), **never run for real** (running a downloaded binary was refused in the cloud session, so nothing about its CDP coverage was verified), and a lighter engine is not worth a second layer. Facts kept for a possible 0.2.1: the CLI `lightpanda serve` is a CDP server (`--port`, host default 127.0.0.1); `--block-private-networks` ("Block HTTP requests to private/internal IP addresses after DNS resolution"), `--block-cidrs`, `--cdp-max-message-size`, `--http-max-response-size`, `--v8-max-heap-mb`, `--watchdog-ms`, `--disable-metrics` exist in `main`; sub-resources default to none; `LIGHTPANDA_DISABLE_TELEMETRY=true`; assets `lightpanda-x86_64-linux`, `lightpanda-aarch64-linux`, `lightpanda-aarch64-macos`, `lightpanda-x86_64-macos` under the tag `nightly`. Its vendor performance claims are unverified and not quoted. Its pieces (download with approval card and pinned hash, tamper check, WSL wrapper, native dialog for the program, last-run line) are in this branch's git history before commit "delete Lightpanda".

**agent-browser** (https://github.com/vercel-labs/agent-browser, Apache-2.0, native Rust CLI; npm, Homebrew, cargo) is a driver layer: it drives Chrome (`agent-browser install` downloads Chrome from Chrome for Testing; existing Chrome, Brave, Playwright and Puppeteer installs are auto-detected) or, with `--engine lightpanda`, Lightpanda over CDP. Its engine page (https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/engines/lightpanda/page.mdx) lists install commands for macOS (Apple Silicon) and Linux (x86_64) only, and says extensions, persistent profiles, storage state, file access and headed mode are not supported with that engine. It has its own safety flags: `--allowed-domains` (it says sub-resources, WebSocket/EventSource and `sendBeacon` to other domains are blocked and WebRTC is disabled while it is active), `--content-boundaries`, `--action-policy`, `--confirm-actions`, `--max-output`; on Windows it runs Chrome on a private desktop in a Job Object (README).
Decision (a) Legion's own CDP driver, versus (b) agent-browser as a black-box CLI: **(a)**. The documented gap in (b): Legion's rules (refuse the owner's wallet port on every local address, check the resolved address, ask before a new origin, taint from the first call) must sit between the browser and every request, and agent-browser offers a domain list but no such hook; it also adds a dependency and, by default, a Chrome for Testing download, against the no-download requirement. agent-browser stays an optional later engine (0.2.1 candidate), most useful for machines with no Chromium-family browser.

## 10. Honest comparison for the owner and the website (no vendor numbers quoted)

| | Chromium headless (Edge/Chrome/Brave) | Cloud VM (boat.dev) |
|---|---|---|
| Isolation | Runs as the user on this PC; Chromium's own sandbox applies; a fresh empty profile per task. Not isolated from the PC | **The only real isolation**: a separate machine |
| Speed and memory | A full browser engine; I have no measured numbers | Network round trips plus VM start; costs money while running |
| Rendering and screenshots | Full rendering underneath; Legion offers text only in this version | Whatever runs inside; full desktop possible |
| Dynamic JS pages | Full Chromium JS and Web APIs | Full |
| Platform | Windows, macOS, Linux wherever one is installed | Any |
| Licence | Edge/Chrome already on the PC, Legion ships nothing | Service terms |
| Download | None | None locally |
| Per-request control by Legion | Yes, through the Fetch domain; DNS rebinding not mitigated | n/a |

## 11. Follow-ups for others

(1) docs/BROWSER.md and the README sentence from section 7; (2) register an updater busy probe if a browser run should block an update; (3) `claude/real-pc-test-plan.md`: add BR15-BR22; (4) the engine interface is ready if 0.2.1 adds Lightpanda or agent-browser.
