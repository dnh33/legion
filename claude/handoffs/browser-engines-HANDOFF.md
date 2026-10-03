# Handoff: the built-in browser (branch `claude/browser-engines`)

Written 2026-10-03 for the agent that takes this over (Hermes, working directly with git). Everything is on the branch; nothing is unpushed except what this commit adds. No keys, tokens or wallet port numbers are in this file or in the code (the owner's wallet port is built from parts, `Number('33' + '21')`, in tests; the source spells it in pieces; both are required by repo tests).

## 1. Goal and the owner decisions that shaped it

Goal: agents browse the web without a VM, through a headless browser, with Legion's own guards. Owner decisions, in order (quoted or close to verbatim):
- (1) Original request: "use https://github.com/lightpanda-io/browser ... as a natural way for agents to browse WITHOUT needing a VM". Built first as branch `claude/lightpanda` (already merged into `integration/v1`).
- (2) "Windows users (Legion's primary platform) must NOT be forced into WSL. Add a second ENGINE ... that uses a headless CHROMIUM-family browser already on the PC (Microsoft Edge is on every Windows 10/11 ...) through the SAME Legion CDP driver and the SAME guards, so there is no download at all and no WSL."
- (3) "OWNER DECISION (2026-10-03): Lightpanda is NOT part of 0.2.0 (extra layer on Windows: WSL, separate download, AGPL, nightly-only, never run). For 0.2.0 the built-in browser is the CHROMIUM engine ... make it the default and ONLY user-facing engine".
- (4) "OWNER DECISION (supersedes my hide-behind-a-flag instruction): DELETE Lightpanda completely, do not hide it ... Keep a small engine interface (id, detect, launch, stop) so another engine can be added later, but ship exactly ONE engine ... agent-browser is NOT integrated in 0.2.0 ... stays an optional later engine."
- Standing rules that apply: research first and keep a documented / assumed / unknown table; do not ask the owner for facts you can look up; gate the ship, not the build; tests never touch the owner's wallet port, built from parts; downloads need the owner's go-ahead (none exist now); scoped claims ("Legion's own code ..."), never "safe" or "verified".

## 2. Exact state

DONE and committed and pushed (tip is the commit that adds this file; the previous tip was `7fff269`):
1. Single engine: headless Chromium family (Edge, Chrome, Brave, Chromium), Legion's own CDP client (`cdp.ts`), engine interface in `engine.ts`, exactly one entry.
2. Lightpanda removed from code, tests, UI, allowlists, pins, WSL wrapper, download and hash handling.
3. Detection on Windows paths (Edge in both Program Files folders, Chrome in Program Files, Program Files (x86), %LOCALAPPDATA%, Brave), version read from the `Application\<version>\` folder names, never by running the browser; known major below 109 refused; owner's path wins and is not replaced.
4. Launcher: `--headless=new --remote-debugging-port=0 --user-data-dir=<fresh>\profile ...`, never `--no-sandbox`, no bind option (the repo's loopback source scan refuses one), scrubbed environment (Windows: APPDATA/LOCALAPPDATA/USERPROFILE point into the run folder), port read from `DevToolsActivePort` (CRLF tolerated), connect only to `ws://127.0.0.1:<port>/devtools/browser/<guid>`.
5. Session enforcement through `Fetch.enable` (every request incl. redirects and sub-resources), downloads denied (`Browser.setDownloadBehavior deny`), non-web documents refused, popups closed, interception mandatory, re-check of the landing address before reads, form submit asked before typing.
6. Module: tools `browser_open/text/links/click/type/eval/close/status`, taint at first call, wrapping, cards (first page all modes, new origin except `full`, script, click/form landing), live approval mode, caps, idle 5 min, wall 30 min, max 3 browsers.
7. Settings panel (`ui/src/browser/BrowserSection.tsx`): single engine list, status line (browser, version, path, last run), "Open test page", browser path (native dialog), allowed sites, local ports (native dialog), the isolation sentence.
8. "Open test page": `POST /api/browser/check`: Legion answers a one-time page under `legion-check.invalid` itself through `Fetch.fulfillRequest` (no server, no network), checks load + JavaScript + that a deliberate request to a cloud-metadata address is refused and never sent.
9. Native dialog IPC `src/electron/browser-ipc.ts` + registration in `main.ts` + `browserChange` in `preload.cjs` (kinds `chromium` path/null and `local`).
10. `approvals.ts`: exact-name exemption so only the module's own cards appear; `isLegionTool` unchanged so the engine still taints.
11. Narrow exception in `test/net-guard-source.test.ts` (one file `src/core/browser/chromium.ts`, one exact switch `--remote-debugging-port=0`), mutation-tested.
12. Plan and checks: `claude/plan-browser.md` (current plan, Evaluated-and-dropped, roadmap, website wording, facts), `claude/tracker-pc-checks-browser.md` (BR15-BR24; BR1-BR14 marked dropped), pointer section in `claude/tracker-pc-checks.md`.

IN PROGRESS: nothing.

NOT done (in order of value): see section 8.

## 3. Files that matter

Source (`src/core/browser/`): `cdp.ts` loopback-only WebSocket client with a fixed method list (only file that opens a WebSocket); `chromium.ts` detection, arguments, port-file parser, engine definition; `engine.ts` the interface; `launcher.ts` start/stop of one browser, scrubbed env; `session.ts` one run's page, Fetch enforcement, redirects, check page; `manager.ts` per-task sessions, idle/wall timers, process cap; `tools.ts` the MCP tool server, cards, taint; `index.ts` module, routes (`GET /api/browser`, `POST /api/browser/config|check|local`), status, check; `resolve.ts` DNS check (only file using node:dns); `state.ts` `<dataDir>/browser/config.json` (enabled, chromiumPath, allowDomains; reads only known fields); `system.ts` real ports, guarded run-folder removal `removeRunDir`; `url-guard.ts` address/URL rules incl. the protected local port rule; `wrap.ts` untrusted wrapping.
Other source: `src/shared/browser.ts` types and limits; `src/electron/browser-ipc.ts`; edits to `src/electron/main.ts`, `src/electron/preload.cjs`, `src/core/approvals.ts`, `src/bin/legion-core.ts` (module list), `scripts/harness/core-entry.mjs` (same list), `test/bsv-scan.ts` (allowlist entries for `browser/cdp.ts` fetch-kind and `browser/resolve.ts` socket-kind), `ui/src/api.ts` (`browserChange` type), `ui/src/components/Settings.tsx` (import + one mount line).
Tests (`test/`): `browser-url-guard` `browser-session` `browser-tools` `browser-wrap` `browser-cdp` `browser-chromium` `browser-chromium-launch` `browser-module` `browser-native` `browser-approvals` `browser-tripwire` plus fakes `browser-fakes.ts` (fake CDP server with a vm-based fake DOM; options quiet, fetchOnly, noFetch, noJs, popup, onlyPath, errorFor, silentFor, garbleFor, bigReply) and `browser-fake-chromium.ts` (a node script standing in for msedge.exe; modes ok, crlf, badpath, never, crash, nojs).
Docs: `claude/plan-browser.md`, `claude/tracker-pc-checks-browser.md`, `claude/tracker-pc-checks.md`, this file. `claude/plan-browser-engines.md` was deleted (folded into the plan).

### Mutation checks (each applied to a scratch copy, rebuilt, the named tests run, then reverted)
Scratch scripts are NOT in the repo (they lived in the session scratchpad). To re-run: copy the repo, apply one textual replacement, `npm run build:ts`, run the named test file, expect `# fail` > 0 or a hang (timeout counted as red), `git checkout` the file. Controls and the test file that went red (all went red unless marked):
- url-guard.ts: scheme check, link-local, metadata class, protected-port rule, 6to4 decoding -> `browser-url-guard`; domain list ignored -> `browser-session`. resolve.ts resolved-address check -> `browser-url-guard`.
- session.ts (all `browser-session`): violations never raised, final-URL check, interception not required, download deny removed / allowed, non-web document (events path), non-web document (Fetch path; needed the `fetchOnly` fake to go red), hop cap, popup not closed, password check, reads not re-checked, submit pre-check, click link pre-check, landing-origin approval (with `browser-tools`), launch race, cache key ignores guard settings, check page answers any name (needed the "session WITH a check page" test), probe verdict ignored.
- tools.ts (`browser-tools`): no taint, first-use card, new-origin card, eval card, eval length limit, approval ceiling ignored, live mode ignored, click-landing approval, blocked-link marker, denied first page still opens.
- wrap.ts (`browser-wrap`, `browser-tools`): no scrub, closing tag not escaped, control characters kept.
- cdp.ts (`browser-cdp`): non-loopback accepted, method list off, size cap off.
- chromium.ts: `--no-sandbox` added, headless dropped, fixed debugging port (also `browser-tripwire`), port-file path loosened, CRLF (red only when both the split and the trim are removed), Chrome-before-Edge, version compared as text, too-old check, owner path falls through -> `browser-chromium` / `browser-chromium-launch` / `browser-module`.
- launcher.ts (`browser-chromium-launch`): env copies host, real AppData left, stop does not kill, run folder kept, connect to any path (needed the fake's `onlyPath`).
- system.ts (`browser-chromium-launch`): folder removal prefix check, nesting check. (Link check is redundant behind the real-path comparison: equivalent mutant.)
- index.ts / manager.ts (`browser-module`): task end does not stop, dispose does not stop, process cap, idle timer, wall timer, browser path without native, too-old not refused, last run not recorded, route on client list (`src/core/admin.ts` temporary edit).
- approvals.ts (`browser-approvals`): exemption removed, exemption by prefix, made a "legion tool".
- browser-ipc.ts / main.ts (`browser-native`): confirm skipped, native secret not requested, path check loosened, sender check removed.
- `test/net-guard-source.test.ts`: exception widened to any switch, exception for any file.
- Equivalent (stay green, redundant behind another check): `file:` allowed past the scheme check (empty-host check refuses it), CRLF split alone (the trim also strips it), link-in-folder-removal (real-path check), "guard step always ok" in the check route (the session already fails the run when the probe is let through).

## 4. Build, test, gate

```
npm ci
npm run build:ts
node --test "dist/test/*.test.js"      # or: npm test
npm run typecheck
npm run build:ui
```
Always `rm -rf dist` after switching branches or deleting a test (stale compiled tests fail). Last full gate (tree = `13c3d65`; the two merges of `integration/v1` after it brought a tracker change and then the Blender chip / enable-dialog code, which were NOT re-gated here: run the gate first): 2219 tests, 2216 pass, 0 fail, 3 skipped; typecheck exit 0; build:ui exit 0; browser files 90 of 90. Known flakes (re-run the file alone): `server.test` "task archive / rename / delete"; process-spawning tests can be slow under load (idle/wall timers use 400-500 ms in tests).
Fast loop: `npm run build:ts && node --test dist/test/browser-*.test.js dist/test/net-guard-source.test.js dist/test/bsv-tripwire.test.js dist/test/bsv-review-tripwire.test.js dist/test/bsv-hedge.test.js dist/test/bsv-port-guard.test.js dist/test/harness-smoke.test.js`.
Tests are Windows-aware (path.join, `fileURLToPath`, junction for link tests, CRLF-normalised source reads, port built from parts) but were only run on Linux.

## 5. What is merged and what is not; conflicts to expect

- `claude/lightpanda` (the first browser branch, with Lightpanda) IS merged into `integration/v1`.
- This branch (`claude/browser-engines`) is NOT merged. It contains `integration/v1` as of its last merge (several merges, the last after `266b35c`). Merging it deletes the Lightpanda files that integration still has.
- Expect: `claude/legion-release-tracker.md` and `claude/tracker-pc-checks.md` (both sides append; keep both, the browser section here is "Browser tool (built-in headless Edge/Chrome)"); `test/bsv-scan.ts` allowlist (this branch removed the `browser/system.ts` entry on purpose, keeps `browser/cdp.ts` and `browser/resolve.ts`; the allowlist test fails on dead entries); modify/delete conflicts if integration edited any deleted Lightpanda file or test (`get-lightpanda.ts`, `browser-get.test.ts`, `browser-process.test.ts`, `browser-fake-lightpanda.ts`, `browser-engines.test.ts`): resolve by deleting; module lists in `src/bin/legion-core.ts` and `scripts/harness/core-entry.mjs` must stay identical (both contain `createBrowserModule(moduleDeps, { nativeSecret, log })`; the harness smoke test enforces); `ui/src/components/Settings.tsx` (one import and one mount line); `src/electron/main.ts` / `preload.cjs` (one handler, one bridge function); `test/net-guard-source.test.ts` (the exception block).

## 6. Open bugs and unverified claims (plain)

- NOTHING has run against a real Edge, Chrome or on Windows. Everything is fake browser + fake CDP on Linux. The whole feature is unverified until BR15-BR24 pass.
- Assumed, not looked up (docs unreachable from the cloud session): `--headless=new` needs Chrome/Edge 109+; Edge takes the same switches; install layout `Application\<version>\`; `--block-new-web-contents` and `--deny-permission-prompts` exist (not found in the switch files read; unknown switches are ignored); the minimal environment is enough for `msedge.exe`; every request including redirects pauses in `Fetch.requestPaused` on a real Edge; Fetch does not cover WebSocket/WebRTC/service workers.
- Not protected (also in the plan): browser runs with the user's rights; DNS rebinding (Legion resolves, the browser resolves again; Chromium has no private-network option); WebSocket/WebRTC/service-worker traffic; the debugging port has no password for the run's life; a click that lands on a new site is asked about after the request was sent; a popup loads unguarded until closed; an agent with a shell can edit `<dataDir>/browser/config.json` (read at startup); a user-chosen browser is trusted as given; password-field refusal is best effort.
- The "Open test page" deviates from the owner's "served by Legion on loopback only": it is answered through the interception (no listener at all). Say so if the owner asks.
- `browser_status` and the check route read the version from folder names; an unknown version is accepted.
- No documentation page for users exists (`docs/BROWSER.md` not written; README sentence not edited): wording is in `claude/plan-browser.md` section 7.
- Updater busy probe not registered (a running browser does not block an update).

## 7. Facts looked up (links) and not looked up

Looked up (read as text): Chromium `content/browser/devtools/devtools_http_handler.cc` (DevToolsActivePort written as "port\nbrowser path", stderr "DevTools listening on ws://..."), `chrome/browser/devtools/remote_debugging_server.cc` (server socket on 127.0.0.1), `content/public/common/content_switches.cc` (switch names remote-debugging-port, remote-debugging-pipe, force-webrtc-ip-handling-policy) at https://github.com/chromium/chromium/blob/main/ ; CDP protocol JSON https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json (Fetch.enable/requestPaused/continueRequest/failRequest/fulfillRequest, Browser.setDownloadBehavior, Target.*); agent-browser https://github.com/vercel-labs/agent-browser (README, LICENSE Apache-2.0, `docs/src/app/engines/lightpanda/page.mdx`); Lightpanda https://github.com/lightpanda-io/browser (README, `src/Config.zig`, `src/help.zon`, LICENSE AGPL-3.0). The plan section 8 and 9 hold the table.
Could not look up: the rendered doc sites `agent-browser.dev`, `developer.chrome.com`, `chromedevtools.github.io`, `lightpanda.io` (proxy refusal); the real GitHub API (blocked); Lightpanda's CDP coverage (running its binary was refused, and it was dropped); Windows behaviour of anything.

## 8. What I would do next, in order

1. Merge `origin/integration/v1` into this branch again (fetch first), rebuild with `rm -rf dist`, run the gate (section 4). If green, hand to the orchestrator to merge into `integration/v1` (conflicts in section 5).
2. Windows gate in a separate worktree (`rm -rf dist` first); fix anything path-related that only Windows shows.
3. Owner runs BR15 first (real Edge, "Open test page"); if Edge fails to start with the reduced environment, add the missing variables to `buildBrowserEnv` (`launcher.ts`) with a test; then BR16-BR24.
4. Independent review (default verdict "not fixed"): attack `url-guard`, the Fetch handler in `session.ts`, the check page, the native dialog gating, `removeRunDir`; try to make page text reach the agent unwrapped.
5. Write `docs/BROWSER.md` and the README sentence from plan section 7; register an updater busy probe if wanted; add BR15-BR24 to `claude/real-pc-test-plan.md`.
6. 0.2.1 candidates (not started): Lightpanda or agent-browser as another `BrowserEngineDef` (`engine.ts`); the research is in plan section 9 and git history before the commit "browser: delete Lightpanda".
