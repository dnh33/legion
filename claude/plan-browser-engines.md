# Plan: a second browser engine (Chromium family) for Legion's browser tool

Branch `claude/browser-engines`. Part of the browser item already in 0.2.0, not new scope. Base: `origin/integration/v1` plus `claude/lightpanda` merged in (the integration tip I was told contained it did not yet when I started; if it has since been merged, git sees the shared history and nothing changes).

## 1. Owner requirement and the short answer

Windows must not need WSL. So the browser module gets a second **engine**: a headless Chromium-family browser that is already on the PC (Microsoft Edge on every Windows 10/11; Google Chrome and Brave if found; or a path the owner sets), driven by the SAME Legion CDP client (`cdp.ts`) and the SAME guards (`url-guard.ts`, `resolve.ts`, `session.ts`, taint, wrapping, cards). No download, no WSL, no Chrome for Testing. Lightpanda stays as the other engine. Settings: Engine = Edge/Chrome or Lightpanda; the default on Windows is the Chromium-family browser found; elsewhere whatever is configured. The engine is fixed for the life of a task's browser and every `browser_open` result names it.

## 2. Decision: (a) Legion's own CDP driver for both engines, versus (b) agent-browser as a black-box CLI

| | (a) Legion's own CDP driver (chosen) | (b) agent-browser (`vercel-labs/agent-browser`) as a CLI |
|---|---|---|
| What it is | The code already in `src/core/browser/*`, extended with one more launcher | A separate native Rust CLI and daemon (Apache-2.0; npm, Homebrew, cargo; Windows, macOS, Linux) that drives Chrome, or Lightpanda with `--engine lightpanda` |
| Extra install | None. Uses Edge/Chrome already on the PC | `agent-browser install` downloads Chrome from Chrome for Testing (README), unless an existing Chrome/Brave/Playwright/Puppeteer is auto-detected; Lightpanda must be installed separately and its official binaries on that page are macOS ARM and Linux x86_64 only |
| Who checks each request | Legion: every request and redirect hop passes `Fetch.requestPaused`, then Legion's URL guard, DNS check, the protected-port rule and the domain list | agent-browser's own `--allowed-domains` (it says it blocks sub-resources, WebSocket/EventSource and `sendBeacon` to other domains and disables WebRTC while the list is active); Legion cannot see or add to its per-request decisions, so no DNS-resolved private-address check, no protected-port rule, no per-origin approval cards |
| Taint, wrapping, cards | Native: the tools mark the run tainted before the first page, wrap everything, ask the owner | Legion would parse a CLI's stdout; wrapping is possible (`--content-boundaries`) but the approval cards for a new origin cannot sit between agent-browser's navigation and the request |
| Safety flags | Legion's own | `--allowed-domains`, `--content-boundaries`, `--action-policy`, `--confirm-actions`, `--max-output` (README) |
| With the Lightpanda engine | n/a (Legion drives Lightpanda itself) | "does not support extensions, persistent profiles, storage state, file access or headed mode" (engine page) |
| Failure modes | One more code path to test (done with a fake browser) | A daemon with its own lifecycle and state files; Windows process cleanup is its job (README: Job Object) rather than Legion's PID-tree kill |

**Decision: (a).** The reason is the documented gap in (b): Legion's rules (refuse the owner's wallet port on every local address, check the resolved address, ask before a new origin, taint from the first call) have to sit between the browser and every request, and agent-browser offers a domain list but no such hook. (b) also adds a dependency and, by default, a ~150 MB-class Chrome download (the owner's estimate; I could not find a size in the README), against the owner's no-download requirement. **agent-browser stays on the list as an optional later engine (0.2.1)**, most useful for its Chrome-for-Testing management on machines with no Chromium-family browser.

## 3. Design (Chromium engine)

- **Detection** (`chromium.ts`, pure, tested with Windows paths): the owner's path if set (and nothing else is tried if it is missing); else, in order, Edge under `%ProgramFiles(x86)%` then `%ProgramFiles%` (`...\Microsoft\Edge\Application\msedge.exe`), Chrome under `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%` (`...\Google\Chrome\Application\chrome.exe`), then Brave. The usual Linux and macOS places are listed in the code. Legion checks that the file exists and reads the **version from the install folder names** next to it (`Application\<version>\`), never by running the browser. A known major below 109 is refused ("too old for headless mode"); an unknown version is accepted and shown as unknown. Env variable names are matched case-insensitively.
- **Start** (`launcher.ts`): argument list, no shell, `--headless=new --remote-debugging-port=0 --user-data-dir=<fresh>\profile --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-background-networking --disable-component-update --disable-default-apps --disable-breakpad --mute-audio --block-new-web-contents --deny-permission-prompts --force-webrtc-ip-handling-policy=disable_non_proxied_udp about:blank`. **Never `--no-sandbox`**, no fixed port, no bind option. The complete environment is built from an allowlist (on Windows `APPDATA`/`LOCALAPPDATA`/`USERPROFILE` point into the run folder so the real profile is never touched). The run folder is made by Legion in the system temp folder (`legion-browser-*`) and removed only by `removeRunDir`, which refuses anything that is not directly inside the temp root, lacks the prefix, is nested, or is a link/junction.
- **Port**: read from `DevToolsActivePort` in the user data directory (`<port>\n/devtools/browser/<guid>`, CRLF tolerated), checked strictly, then connect to `ws://127.0.0.1:<port><path>` only (the loopback-only CDP client).
- **Enforcement** (`session.ts`): `Fetch.enable` with pattern `*` on the page session, so every request incl. redirects and sub-resources passes Legion's check, and is continued or failed (`BlockedByClient`); on this engine a run whose interception does not start opens nothing. `Browser.setDownloadBehavior {behavior: 'deny'}` (a failure also stops the run). A navigation to `file:`, `data:`, `javascript:`, `chrome:`, `blob:` or `ftp:` as a document is a violation. Extra tabs are closed at once. Text is capped and wrapped as untrusted; the run is tainted at the first tool call; the first page and each new origin ask the owner; `browser_eval` asks (the same rules as for Lightpanda).
- **Stop**: PID-tree kill by PID (`taskkill /T /F` or a process-group kill) on end, cancel, idle (5 min), wall (30 min) and shutdown; never by name. Max 3 browsers at once, shared with Lightpanda.
- **Choice**: `engine` in the settings (admin route, no native dialog needed: it only selects between programs already approved), `chromiumPath` through the native dialog (`browser-ipc.ts`, kind `chromium`). The engine is read when a task's browser object is created and not again; there is no fallback to the other engine if the chosen one cannot start (the error says what is missing).

## 4. Controls and tests (each with a mutation that must turn a named test red)

E1 detection order, Windows paths with spaces and backslashes, version from folder names, numeric compare, too-old, owner path wins and is not replaced (`browser-chromium`); E2 port-file parsing strict, CRLF (`browser-chromium`, `browser-chromium-launch`); E3 arguments (no `--no-sandbox`, one debugging switch, port 0) (`browser-chromium`, `browser-tripwire`); E4 launch with a fake Chromium script: scrubbed env, fresh profile in the run folder, Windows env redirected, kill on stop, folder removed, failures (`browser-chromium-launch`); E5 safe run-folder removal incl. link refusal (`browser-chromium-launch`); E6 interception required, downloads denied, non-web documents refused, the same private/metadata/protected-port/domain/hop guards on this engine (`browser-session`); E7 default and explicit engine, native gate on the path (`browser-engines`); E8 full run through a fake Edge on Windows paths, engine named in the result, process stopped at run end; E9 no switch during a run, no fallback, too-old refused; N7 native dialog kind; a narrow, mutation-tested exception in `test/net-guard-source.test.ts` (see 6). Fake browsers are node scripts (`test/browser-fake-chromium.ts`) with the fake CDP server; no real browser or internet is used.

## 5. Honest comparison for the owner and the website (no vendor numbers quoted)

| | Chromium headless (Edge/Chrome/Brave) | Lightpanda | Cloud VM (boat.dev) |
|---|---|---|---|
| Isolation | Runs as the user on this PC. Chromium's own site isolation and sandbox apply (Legion never disables the sandbox); Legion adds a fresh empty profile per task. Not isolated from the PC the way a VM is | Runs as the user on this PC (on Windows inside WSL, which adds a layer). A newer, smaller project; its own limits apply | **The only real isolation**: a separate machine |
| Speed and memory | A full browser engine; heavier than Lightpanda. I have no measured numbers | Lighter by design (vendor claim; the vendor's benchmark figures are unverified here and not quoted) | Network round trips plus VM start; costs money while running |
| Rendering and screenshots | Yes (full rendering; Legion does not expose screenshots in this version) | No rendering; no screenshots (README: text-only) | Whatever runs inside; full desktop possible |
| Dynamic JS pages | Full Chromium JS and Web APIs | Runs JavaScript (V8); Web API coverage is partial and published by the vendor; unknown which sites break (the owner's "cheaper on dynamic pages" is a vendor claim: unverified) | Full |
| Platform | Windows, macOS, Linux wherever one is installed | Linux and macOS builds only; Windows via WSL | Any (the browser is remote) |
| Licence | Edge/Chrome: proprietary, already on the PC, Legion ships nothing; Chromium: BSD-style | AGPL-3.0, downloaded, never bundled | Service terms |
| Download | None | The binary, size not verified here, only after an approval card and a recorded hash | None locally |
| Per-request control by Legion | Yes, through the Fetch domain (all requests, redirects, sub-resources); no browser-level private-network option, so DNS rebinding is NOT mitigated by the browser | Yes through Fetch if the build supports it; plus the browser's own `--block-private-networks` ("after DNS resolution") | n/a |

## 6. What is NOT protected on the Chromium engine

- The browser runs with the user's rights. A Chromium bug is a bug on this PC; the sandbox is Chromium's own.
- DNS rebinding: Legion resolves a name for its own check and the browser resolves again; Chromium has no equivalent of Lightpanda's `--block-private-networks`, so this limit is real and unmitigated on this engine.
- `Fetch` interception covers HTTP(S) requests the page makes. WebSocket handshakes, WebRTC (mitigated only by the UDP policy switch, not proven), service-worker and extension traffic are not claimed to be covered. TODO OWNER PC (BR17).
- The debugging port is an ordinary local TCP port on 127.0.0.1 without a password for the life of the run; any local program can connect to it.
- Two switches (`--block-new-web-contents`, `--deny-permission-prompts`) could not be found in the Chromium switch files I read; Chromium ignores unknown switches, and popups are also closed through target events, but they are unverified (BR17).
- Brave and a user-chosen browser are trusted as given.

The one change to a shared test: `test/net-guard-source.test.ts` forbids any "remote-debugging" switch in `src/`. That rule is kept for everything except ONE file (`src/core/browser/chromium.ts`) and ONE exact switch (`'--remote-debugging-port=0'`); a fixed port, a bind address, the pipe variant, a second switch, listening code, or the same switch in any other file are still refused, and the test file proves each by mutation.

## 7. Facts: documented / assumed / unknown

Looked up on 2026-10-02 (text read from the sources; pages on `agent-browser.dev`, `developer.chrome.com` and `chromedevtools.github.io` were NOT reachable from this session, so the same content was read from the repositories):

| Item | Status | Source |
|---|---|---|
| agent-browser: Apache-2.0; native Rust CLI; npm, Homebrew, cargo; `agent-browser install` downloads Chrome from Chrome for Testing; existing Chrome, Brave, Playwright, Puppeteer installs auto-detected | documented | https://github.com/vercel-labs/agent-browser/blob/main/README.md ("Installation", "Requirements") and https://github.com/vercel-labs/agent-browser/blob/main/LICENSE |
| agent-browser flags `--allowed-domains` (sub-resource, WebSocket/EventSource, sendBeacon blocking; WebRTC disabled while active), `--content-boundaries`, `--action-policy`, `--confirm-actions`, `--max-output`, `--engine chrome|lightpanda`; on Windows runs headless Chrome on a private desktop and in a Job Object | documented | same README ("Security", options table, "Windows" notes) |
| `--engine lightpanda`: Lightpanda installed separately; commands shown for macOS (Apple Silicon) and Linux (x86_64) only; not supported: extensions, persistent profiles, storage state, file access, headed mode; screenshots "depend on Lightpanda CDP support" | documented | https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/engines/lightpanda/page.mdx (source of agent-browser.dev/engines/lightpanda) |
| `Fetch.enable{patterns,handleAuthRequests}`, event `Fetch.requestPaused` with `request`, `resourceType`, `redirectedRequestId`; `Fetch.continueRequest`, `Fetch.failRequest`; `Browser.setDownloadBehavior{behavior: deny|allow|allowAndName|default}` (experimental); `Target.attachToTarget{flatten}`, `createTarget`, `closeTarget`, `setDiscoverTargets` | documented | https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json |
| With `--remote-debugging-port`, the browser prints "DevTools listening on ws://<ip:port>/devtools/browser/<guid>" and writes `<port>\n<browser path>` to `DevToolsActivePort` in the profile directory | documented | https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc |
| The remote-debugging server socket is created on 127.0.0.1 (`CreateLocalHostServerSocket`) | documented | https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc |
| Switch names `remote-debugging-port` ("Enables remote debug over HTTP on the specified port"), `remote-debugging-pipe`, `force-webrtc-ip-handling-policy` exist | documented | https://github.com/chromium/chromium/blob/main/content/public/common/content_switches.cc |
| `--headless=new` needs Chrome/Edge 109 or newer | assumption (from memory; docs unreachable) | BR15 reads the installed version; Legion refuses a known major below 109 |
| Edge accepts the same headless and debugging switches as Chrome | assumption | BR15 |
| Edge/Chrome install layout `Application\<version>\` next to the exe (used for the version) | assumption | BR15 (folder listing) |
| `--block-new-web-contents`, `--deny-permission-prompts` exist | unknown (not found in the switch files read) | BR17; harmless if ignored |
| The minimal environment is enough for msedge.exe to start on Windows | unknown | BR15 |
| Every request incl. redirects pauses in `Fetch.requestPaused` on a real Edge | assumption from the protocol text | BR16 |
| Size of the Chrome for Testing download | unknown (owner's ~150 MB figure not verified) | n/a: not used by option (a) |
| Lightpanda facts | see `claude/plan-browser.md` section 10 | |

## 8. Wording for README and docs (not edited here)

"Browser (optional, off by default): agents can read web pages with a headless browser that is already on your PC (Microsoft Edge or Chrome) or with Lightpanda. Legion starts it only for a task, on this computer, checks every request itself, asks you before the first page and before new sites, and treats every page as untrusted text. Nothing is downloaded for the Edge/Chrome engine. It runs with your user rights, not in a VM; use the cloud VM when you need real isolation."
