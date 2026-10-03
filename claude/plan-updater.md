# Plan: in-app updates from public GitHub releases

Status: PHASE 1 (design) written 2026-10-02 on branch `claude/updater` (base `integration/v1`). Phase 2 (build) follows without waiting for approval. Scope claims in this plan are scoped to "Legion's own code"; nothing here is "secure" or "cannot be bypassed".

## 0. What exists today (read before designing)

- **Install model**: `setup.cmd` -> `scripts/setup.ps1` copies the SOURCE tree to `%LOCALAPPDATA%\Programs\Legion` (robocopy /MIR with `dist`, `dist-ui`, `node_modules`, `.git` excluded), then `npm ci` + `npm run build` on the user's PC, writes shortcuts that start `node_modules\electron\dist\electron.exe "<InstallDir>"` and `uninstall.cmd`. There is no packaged binary and no installer EXE. Legion's own code is plain JS; the core is started by Electron main with the system `node` (`LEGION_NODE` or `node`).
- **Electron shell** (`src/electron/main.ts`): single-instance lock, `second-instance` shows the window, per-launch admin + native secrets over the core's stdin, the core is spawned detached on POSIX and killed with `taskkill /T /F` on Windows (a hard kill: the core's SIGTERM handler `shutdown()` does NOT run on Windows), `before-quit`/`will-quit` kill the core, closing the window only hides it (tray).
- **Core** (`src/bin/legion-core.ts`): `/health` returns `{ok, version, pid, admin}` with no auth. Everything else is default-deny (`src/core/admin.ts`): only the short client list is reachable with the MCP bearer token; any new route is admin-only unless someone adds it to that list. BSV policy changes additionally need the native secret (main only).
- **Work state**: `Store` (tasks in `state.json`, messages in `messages/*.jsonl`), `Engine.running()`/queue, `ApprovalBroker.pending()`, `VmRecord.state`. `Store.recoverInterrupted()` at core start turns every `running`/`queued` task into `error: "Legion restarted"`. **There is no resume.** Nothing re-runs a task after a restart; this plan does not invent one.
- **There is no in-core scheduler.** "Sentinel" is a role prompt (`roster.ts`); recurring jobs would be external (the user's own cron calling Legion over MCP). The core cannot see those; the plan gives the idle check a probe registry so a future scheduler can register (and says what happens to an external caller, section 7).
- Blender managed download, BSV spend approvals and room requests all go through `ApprovalBroker`, so a pending approval is one idle signal that covers them. The Blender download that runs AFTER its approval is not an approval; it is covered by a probe (section 5).
- Existing patterns reused: the strict zip reader `src/core/blender/zip.ts` (imported, not edited), the manual-redirect downloader idea in `blender/system.ts`, approval cards as in `blender/index.ts`, the tripwire `ALLOWLIST` in `test/bsv-scan.ts`.

## 1. Decisions (and why)

| # | Decision | Why |
|---|---|---|
| D1 | **Source = GitHub Releases** of `dnh33/legion` (not tags), fixed asset names, fetched through `https://github.com/dnh33/legion/releases/latest/download/<name>` and `.../releases/download/v<version>/<name>`. | Tags carry source only, so a tag update would mean `npm ci` + build on the user's PC from code nobody pinned. A release carries a built package plus a manifest and signature, one request each. `releases/latest/download/` needs no API token and is not the 60/hour unauthenticated REST API, so no `api.github.com` host is needed. "Latest" excludes drafts and pre-releases. The repo is public at release, so no token is ever needed. |
| D2 | **Private-repo mode is out of scope.** Before the repo is public (or if it is made private again) the check gets a 404 and shows "no update source reachable". There is no token field, no token storage, no `Authorization` header anywhere. | Owner constraint: no tokens in the app. |
| D3 | **Update unit = a built "app package"** `legion-<version>-app.zip`: the code set only (`dist`, `dist-ui`, `assets`, `scripts`, `licenses`, `package.json`, `package-lock.json`, `NOTICE`, `LICENSE`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `setup.cmd`, `setup-yes.cmd`, `start-legion.cmd`). No `node_modules`, no `src`, no `.git`, no `docs`. | `node_modules` (Electron alone is ~200 MB) does not change on most releases. If the dependency lock changes the update is `requiresFullInstall` (notify only: "download the source zip of this release and run setup.cmd, as for a first install"). Honest limit: the in-app path never updates Electron, Node or npm dependencies. |
| D4 | **Apply = journaled rename swap of the code-set entries** inside the install folder, by a small helper that runs after the app has exited; ONE previous version kept in `<install>\.update\prev\`. Not a full side-by-side copy of the install folder. | A side-by-side folder would have to copy or junction `node_modules`; a junction makes rollback and delete fragile (CLAUDE.md lessons), a copy is 300+ MB per update. Renames inside one volume are atomic per entry; a journal makes the group recoverable. `robocopy /MIR` is NOT used by the updater at all. |
| D5 | **Trust = Ed25519 signature over the raw bytes of the manifest**, public key(s) compiled into the app (`src/core/updater/trust.ts`). The manifest binds version, publish time, asset name, size, sha256 and the lock-file hash. | Any account/CDN/MITM tampering with the zip fails the hash; tampering with the manifest fails the signature. Ed25519 via `node:crypto` (no dependency). |
| D6 | **Consent**: a notice plus Update button; click -> an approval card (ApprovalBroker) -> only then download. Optional, OFF by default: "Install updates automatically when idle" (the toggle is the standing go-ahead; it is admin-gated and its wording says what it does). The version check itself is one plain GET of two small files, ON by default with an off switch (owner's rule, section 3). | Owner rule: downloads need explicit go-ahead. |
| D7 | **Restart only when idle**; busy -> "Update ready, will install when idle", never forced. "Restart now" exists, goes through a NATIVE confirmation (main process) that names what will stop, then a bounded drain. | Owner rule. |
| D8 | **Dev checkout (`.git` present at the app root), non-writable install dir, or non-Windows**: notify only ("new version X; run `git pull` and rebuild"). Never run git, npm or anything. | Never touch a developer's tree. |
| D9 | **No pre-releases, no channels in v1**: manifest `channel` must be `stable`. | Smaller surface. |
| D10 | The helper runs under the already-installed Electron binary in node mode (`ELECTRON_RUN_AS_NODE=1`, `process.execPath`), not under a new download and not under `node` from PATH. | It exists on every install, no PATH dependency. |

## 2. Release side (the owner, by hand)

Scripts (all new, `scripts/`, plain Node, no dependencies):

- `release-keygen.mjs --out <dir outside the repo>`: makes an Ed25519 pair, writes the private key (PEM, mode 0600) to `<dir>`, prints the PUBLIC key PEM and its `keyId`. REFUSES an `--out` inside the repo or the current git work tree. The private key never exists in the repo or in an agent session. Owner stores it offline (a hardware key or an encrypted USB / password manager attachment), never in GitHub secrets or CI, never on the build machine longer than the signing step. Back it up twice.
- `release-package.mjs --out <dir>`: builds `legion-<version>-app.zip` from an already BUILT tree (refuses if `dist/`, `dist-ui/` are missing or older than `src/`), deterministic order and timestamps, only the code set, zip entries under one top folder `legion-<version>/`.
- `release-manifest.mjs --zip <file> [--notes <file>] --out <dir>`: writes `legion-update-manifest.json` (canonical, UTF-8, LF) and `SHA256SUMS.txt`. Reads `package.json` for the version, sha256 of the zip and of `package-lock.json` (from inside the zip), size, `publishedAt = now`. Refuses a version that is not greater than the last manifest the owner passes via `--previous`.
- `release-sign.mjs --key <private key file> --manifest <file>`: writes `legion-update-manifest.json.sig` (`{"keyId","alg":"ed25519","sig":"<128 hex chars>"}`); verifies the signature again with the public key before it finishes. Refuses a key file inside the repo.
- Publishing is manual: tag `v<version>`, create the GitHub release, attach the four files (zip, manifest, manifest.sig, SHA256SUMS.txt). The names are fixed.
- **Embedded key + rotation story**: `UPDATE_KEYS` in `trust.ts` is a list `{id, publicKeyPem}`. Empty list = updates OFF, fail closed ("this build has no update key"). Release checklist: the manifest script refuses to run if its key is not in the built `trust.js` list. Rotation: ship a normal signed release whose `trust.ts` contains the old AND new key; once every user has it, a later release drops the old one. A compromised key has NO remote revocation channel (anyone who has the old key can still sign for builds that trust it); recovery is "tell users to reinstall from a trusted copy of the repo" (section 9). Key id in the signature file is untrusted until the signature verifies against the embedded key of that id.

Manifest (signed bytes, parsed only after the signature verifies):

```json
{ "schema": 1, "product": "legion", "channel": "stable", "version": "0.2.1",
  "publishedAt": "2026-10-20T10:00:00Z",
  "asset": { "name": "legion-0.2.1-app.zip", "size": 45000000, "sha256": "<64 hex>" },
  "depsSha256": "<sha256 of package-lock.json in the package>",
  "requiresFullInstall": false,
  "notes": "plain text, max 2000 chars" }
```

## 3. Check (metadata only)

- On core start (after 30 s) and every `intervalHours` (default 12, range 1-168) while the core runs; manual "Check now" (min 60 s apart). Setting `checkEnabled` (default true) is the off switch; off means no request is made at all. A manual check works while the periodic check is off.
- Request: GET `https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json` and `.sig`. No cookies, no tokens, static `User-Agent: Legion-Updater/<version>`, nothing about the user or machine in the request (GitHub sees an IP and the version in the user agent; documented).
- Failure handling: offline/DNS/timeout/HTTP 5xx -> `lastResult: "offline"` and retry at the next interval (no tight loop; jitter); 403/429 -> honour `Retry-After` up to 24 h else back off 1 h; 404 -> "no release found"; a bad manifest/signature -> `lastResult: "rejected: <reason>"` and the notice is NOT shown (never offer something unverified), the reason is visible in Settings -> Updates for the owner.

## 4. Verification chain (nothing is applied before every step passes)

1. URL is built by Legion from constants + a validated version; never taken from the manifest or from a redirect it did not allow.
2. https only, port 443, no userinfo, no IP literal; host in `{github.com, objects.githubusercontent.com, release-assets.githubusercontent.com}` on EVERY hop (the owner's list plus `release-assets.githubusercontent.com`, which GitHub now uses for release assets; confirm on a real PC, check U2). Manual redirects, max 3, each hop re-validated, no scheme downgrade.
3. Size caps: manifest <= 64 KiB, sig <= 4 KiB, package <= 150 MiB AND exactly `asset.size`; the stream is aborted at the cap; `Content-Length` greater than the signed size is refused up front.
4. Signature over the raw manifest bytes with the embedded key of the stated `keyId`. No key, unknown id, malformed or wrong signature -> rejected.
5. Strict manifest schema (unknown fields ignored, wrong types rejected, `product=legion`, `channel=stable`, plain semver without pre-release, asset name EXACTLY `legion-<version>-app.zip`, hex lengths, `notes` length-capped).
6. Downgrade/replay: `version` must be greater than the RUNNING version (semver compare, not string); `publishedAt` must not be earlier than the running build's own `publishedAt` (from `build-info.json` in a package-installed build; unknown for a source-built install, then only the version rule applies) nor more than 24 h in the future; a version recorded as failed (rolled back) is not offered again unless a newer one appears.
7. Streamed sha256 of the zip equals the signed `asset.sha256`, size equals `asset.size`, BEFORE any byte is extracted.
8. Extraction through the strict zip reader (refuses absolute, drive-letter, colon, `..`, device names, trailing dot/space, symlinks, encrypted, duplicates by case, zip64, entries outside `legion-<version>/`, size lies, CRC mismatch) into a fresh `<install>\.update\staging\<version>` (checked as a real directory inside the install folder, not a link). Plus: top-level names must be in the code set; path length <= 200; entry count <= 20,000; unpacked <= 400 MiB.
9. Package content: `package.json` version == manifest version; sha256 of its `package-lock.json` == `depsSha256`; required files exist (`dist/src/electron/main.js`, `dist/src/bin/legion-core.js`, `dist-ui/index.html`); `depsSha256` == sha256 of the INSTALLED `package-lock.json`, otherwise the update is `requiresFullInstall` (notify only, never staged).
10. Consent was given (card, or the auto setting) before step 3's download started; the apply step re-checks that the staged tree's `stage.json` matches (catches a half-written stage after a crash).

**Not covered by this chain** (also in section 9): a compromised maintainer account WITH the signing key, a compromised signing key, malicious code that the owner builds and signs, the first install, same-user local malware, withholding/freeze.

## 5. "Idle" (exact definition) and "do not interrupt"

`computeBusy()` in `src/core/updater/idle.ts` returns a list of reasons; idle = empty list for 60 continuous seconds.

Busy when ANY of:
1. a task in the store with status `queued` or `running` (archived included); 
2. `engine.running()` non-empty (covers bridge-started child runs and rooms: a room turn is a task);
3. `approvals.pending()` non-empty (tool approvals, Blender script/download cards, BSV spend cards, room requests, our own update card);
4. a VM in state `provisioning` or `archiving` (an install/stop operation in flight; `running`/`idle`/`ready` VMs are billing, not work, and do not block);
5. any registered busy probe returns true: at start the Blender managed download/setup (`blender.status().getting`), plus `updater.registerBusyProbe(name, fn)` for later modules (the future BSV spend executor MUST register one when T2 lands; tracked in the release tracker);
6. a probe or read throws or returns an unreadable value: busy (fail closed);
7. the core started less than 60 s ago;
8. the updater itself is mid-download/verify/stage.

Quiet period: sampled every 5 s; any busy sample resets the 60 s clock. When the update is staged AND consent exists AND the quiet period holds, main performs the apply. Before applying, the core's `commit` route re-evaluates `computeBusy()` once more and refuses (409) if busy, then FREEZES task starts (`engine.startTask` is wrapped to throw "Legion is restarting to install an update" with 503) until the process exits, so nothing new can begin between the check and the kill; the freeze auto-lifts after 60 s if no restart follows (`abort-commit`).

Busy -> the Settings card and a tray tooltip say "Update ready, will install when idle" and why (reasons list, plain words). Never forced. If busy for days, the notice stays; the user may use Restart now.

**Restart now** (explicit): the window asks main over IPC (only the Legion window frame is accepted, like `legion:bsv-policy`); main shows a NATIVE dialog that lists what will stop ("2 running tasks: Builder, Scout; 1 pending approval; a Blender download") with buttons Cancel / Stop work and restart. On confirm main calls the core `drain` (admin + native secret): every running and queued task is cancelled through `engine.cancel` (a graceful abort: approvals denied, bridge children cancelled, status saved as `cancelled`), wait up to 15 s for them to settle, pending approvals denied, `store.flush()`, VM records are not touched (their cloud VMs keep running and billing; the dialog says so). Then main kills the core and quits. After restart: tasks that did not settle become `error: "Legion restarted"` (existing `recoverInterrupted`), tasks cancelled by the drain stay `cancelled`; NOTHING is resumed automatically. The updater records the ids it stopped and Settings shows "Stopped for the update: ..., re-run from the task list".

## 6. Apply, atomicity, rollback

Layout under the install dir (all owned by the updater, deleted only after a containment + not-a-link check): `.update/staging/<ver>/`, `.update/run/apply.mjs` (copy of the helper, so it does not live in the folders it swaps), `.update/prev/` (exactly one previous version), `.update/failed/`, `.update/journal.json`, `.update/outcome.json`, `.update/apply.log` (no secrets). The data folder (`%USERPROFILE%\.legion` / `LEGION_HOME`) is never touched by the swap. Additionally, before the swap the core copies `state.json` to `<dataDir>\updater\state-before-<from>.json` (additive, one file kept) so a human can recover if a newer build migrated the state; rollback does NOT restore it automatically (it would lose what happened in between).

Sequence (helper, started detached by main with `ELECTRON_RUN_AS_NODE=1`, arguments: install dir, parent pid, port, from, to, relaunch command):
1. Wait up to 30 s for the parent pid to exit (poll `process.kill(pid, 0)`); still alive -> abort, nothing changed. Then require nothing answers `/health` on the port for 10 s (a core is never swapped under).
2. Journal `swapping` (list of entries). Remove the old `.update/prev` contents (owned dir), recreate.
3. For each code-set entry present in staging: rename live -> `prev/<entry>`, rename staging -> live. `EBUSY/EPERM/EACCES` (a file in use, antivirus) -> retry every 500 ms for up to 15 s, then roll back the entries done so far and finish as `failed: files in use`.
4. Journal `awaiting-health`; relaunch the new app exactly as the shortcut does (`electron.exe "<install>"`), remembering its PID.
5. Health check: within 60 s `GET http://127.0.0.1:<pinned port>/health` returns `ok` and `version == to`. Success -> journal `committed`, outcome `ok`, staging removed.
6. Failure or timeout -> kill the new app's process tree BY PID (never by name), wait for the port to free, move the new entries into `.update/failed/`, move `prev/*` back, journal `rolled-back`, relaunch the old app, outcome `rolled-back: <reason>`. The next core start records the version in `failedVersions`.
7. **Killed mid-update** (power loss, the helper killed): on every app start, BEFORE the core is spawned, main runs `recoverInterrupted()` from the journal: `swapping` -> finish the rollback; `awaiting-health` with a stale heartbeat and the running build equal to `from` -> rollback; running build equal to `to` and healthy -> mark `committed` (the app also confirms itself once its core proved healthy, so a dead helper cannot leave it unconfirmed). Rename-only steps and the journal make every interruption point recoverable; the journal is written (fsync'd temp + rename) before each step.
8. Disk full: preflight `statfs` needs >= 3x the signed size free on the install volume (download + staging) and the data volume check is not needed (nothing is written there but the state copy). `ENOSPC` while staging -> staging removed, live tree untouched, the error is shown.

Dev checkout / non-Windows / unwritable install dir: `mode = notify-only`. A checkout is detected by `.git` at the app root. Notice text: "Version X is out. This is a git checkout: run `git pull`, `npm ci` and `npm run build`." No command is executed.

What the updater does NOT do: kill processes by name pattern, touch `node_modules`, `uninstall.cmd`, shortcuts, the data folder, or anything outside the code-set names; follow links; delete outside `.update/`.

## 7. Failure matrix

| Situation | Behaviour |
|---|---|
| Offline / DNS / timeout | `offline`, retry next interval, no change, no dialog |
| Rate limit (403/429) | back off per `Retry-After` or 1 h |
| Bad manifest / bad signature / wrong key id | rejected, no notice, reason in Settings, nothing downloaded |
| Manifest older or equal to running version | "up to date", reason shown |
| Manifest not newer by `publishedAt`, or future dated | rejected |
| Hash or size mismatch, redirect to a foreign host, http | download aborted, staging deleted |
| Disk full | preflight message; during staging: staging deleted |
| App killed during download/stage | staging is rebuilt from scratch next time (a `.part` file is never trusted); `stage.json` absent = not staged |
| App killed during swap | recovered at next start (section 6.7) |
| New build never gets healthy | rolled back, version marked failed |
| Files in use at swap | retry 15 s, then roll back, "try again after closing other Legion windows or Claude Code sessions started in the Legion folder" |
| Update requires a dependency change | notify only, link to the release |
| A client (the stdio MCP proxy) calls the core during the restart | it may start a headless core on the port; the new app's `ensureCore` treats an idle foreign core as `replace` (existing behaviour); during the swap the proxy's files may be in use (a source of "files in use") |

## 8. Hooks into shared files (all minimal, additive)

- NEW: `src/core/updater/{types,semver,trust,manifest,net,package,idle,state,index,apply}.ts`, `src/electron/updater-main.ts`, `ui/src/UpdatePanel.tsx` (+ its CSS in the same file), `scripts/release-*.mjs`, `scripts/lib/release-lib.mjs`, `test/updater-*.test.ts`, `claude/tracker-pc-checks-updater.md`.
- `src/bin/legion-core.ts`: create the module and add it to `modules` (about 4 lines; passes `root`, `nativeSecret`, a Blender busy probe). It passes NO policy/URL override.
- `src/electron/main.ts`: `recoverInterrupted()` before `boot()`, `initUpdater({...})` with the helpers main already has (about 10 lines). Nothing else changes.
- Settings UI: one line mounting `<UpdatePanel/>`.
- `test/bsv-scan.ts` ALLOWLIST: three new entries with reasons (never a loosened rule):
  - `src/core/updater/net.ts`: `fetch` - the update check and download, https to the three pinned GitHub hosts only, redirects re-checked on every hop;
  - `src/core/updater/apply.ts`: `fetch`, `child-process` - the apply helper: loopback `/health` poll of the new build, relaunch of the app, PID-based kill of the new build on rollback;
  - `src/electron/updater-main.ts`: `child-process` - starts that helper detached and nothing else.
  A new test, `updater-surface.test.ts`, pins that those are the ONLY updater/electron files with network or process use and that production code passes no URL/host/policy override; the tripwire and hedge tests are not edited otherwise.
- Not touched: BSV, Blender, providers, `engine.ts`, `server.ts`, `store.ts`, `admin.ts`.

## 9. What is NOT protected (say it plainly)

- A compromised maintainer GitHub account together with the signing key, a compromised signing key, or a malicious change the owner builds and signs: that is code execution on every updating install. There is no remote key revocation; recovery is a manual reinstall from a trusted copy and a release that changes the key.
- A compromised GitHub account WITHOUT the key can only withhold updates, serve an older valid release (rejected by the version rule) or delete assets; it cannot make Legion install its own code.
- Withholding/"freeze": an attacker (or an outage) who keeps serving the same valid manifest keeps users on the old version silently.
- The first install (the source zip + `setup.cmd`) is trust-on-first-use of the repository, and the embedded key is only as trustworthy as that copy.
- Same-user local malware can edit the install folder or `~/.legion` directly; the updater does not defend against it.
- Node, Electron, npm dependencies and the Claude Code CLI are not updated by this mechanism.
- No reproducible build check: the signature says "the owner signed this zip", not "this zip is the source in git".
- GitHub learns the IP and Legion version of each check.

## 10. Controls, tests, mutations

Each control has one test file (`test/updater-*.test.ts`), fake HTTP/HTTPS-policy servers on 127.0.0.1 and temp dirs, test key pairs generated at test time; no real host is contacted. The production network policy is a frozen constant; tests construct a separate loopback policy through the constructor, never through config or env. "Mutation" = a temporary scratch edit of the code that must turn the named test red (run, record, revert; recorded in the phase 2 report).

| ID | Control | Test (file: case) | Mutation that must turn it red |
|---|---|---|---|
| C1 | production policy: https only, 3 allowed hosts, port 443, no userinfo/IP | net: policy table | add `http:` or `evil.example` to the constant |
| C2 | redirects: manual, <=3, every hop re-validated, no downgrade | net: redirect to foreign host / to http / 4 hops / allowed hop | skip `validate()` on a redirect hop |
| C3 | URL built from constants; manifest cannot supply URL/asset name | manifest: asset name must equal derived; net: URL builder | take URL from the manifest |
| C4 | size caps (manifest, sig, package, content-length, stream) | net: oversize at each layer | raise/remove a cap |
| C5 | Ed25519 verify over raw bytes; empty key list fails closed; unknown keyId; tampered byte; wrong key | trust | return true when the key list is empty; verify parsed JSON instead of raw bytes |
| C6 | strict manifest schema | manifest | accept `channel: beta`, or a wrong product |
| C7 | downgrade/replay: version, publishedAt, future date, failed versions | manifest: policy table | compare versions as strings; drop the equality case |
| C8 | sha256 + size verified before extraction | package: hash mismatch leaves no staging | extract before hashing |
| C9 | safe extraction + code-set allowlist + staging containment | package: traversal, absolute, symlink, `node_modules` entry, outside-top-folder, bomb | drop the code-set check |
| C10 | package.json version, lock hash, requiresFullInstall | package: lock changed -> notify only | skip the lock comparison |
| C11 | consent: no download without a card approval; deny -> nothing fetched; auto setting default OFF; routes admin-only (a bearer-token call gets 403) | index: install flow; admin gate test | start the download before the card resolves; add an update route to the client list |
| C12 | commit/drain need admin AND native header | index: header matrix | accept admin only |
| C13 | idle definition: one test per reason; unreadable probe = busy | idle | drop the approvals reason; make a throwing probe count as idle |
| C14 | quiet period and boot grace | idle (fake clock) | zero the quiet period |
| C15 | freeze: `startTask` refused after commit, lifted by abort/timeout | index | skip the wrapper |
| C16 | swap touches only code-set names inside the install dir; `node_modules`, data dir, `uninstall.cmd`, shortcuts untouched; one previous kept | apply (temp dirs) | add `node_modules` to the code set; keep two previous |
| C17 | journal crash recovery at every step (injected failure after step N) | apply: crash matrix | skip the journal write |
| C18 | health failure/timeout -> rollback, old build relaunched, version marked failed | apply (fake health server) | treat timeout as success |
| C19 | `.git` / unwritable / non-win32 -> notify only, nothing executed | install-mode | ignore `.git` |
| C20 | offline, 403/429 backoff, ENOSPC preflight and mid-stage, staging cleanup | net + package + index | swallow ENOSPC and keep a partial stage |
| C21 | tripwire/hedge green; allowlist entries and the only-three-files surface pinned | updater-surface + existing tripwire | add a `fetch` to `idle.ts` |
| C22 | no private key or token material in the repo, in the manifest scripts' output, or in logs; keygen refuses a path inside the repo | release scripts + a repo scan | write the key next to the manifest |
| C23 | release scripts round trip: package -> manifest -> sign -> app verifies; script refuses a key not embedded | release scripts | sign the wrong bytes |
| C24 | `notes` is untrusted text: only shown (escaped), never given to an agent prompt or tool | updater-surface: static + UI test | pass notes into a preamble |

Owner-only real-PC checks: `claude/tracker-pc-checks-updater.md` (U1..). Windows-only behaviour (locks, `taskkill`, junction install dir, shortcut relaunch, antivirus, the real GitHub redirect host) cannot be verified in the cloud and is listed there, not claimed.

## 11. Wording for README, SECURITY.md, docs (scoped, not absolute)

- README (Updates): "Legion can check GitHub for a new release and tell you. It downloads and installs only after you click Update (or if you turn on 'install automatically when idle', which is off by default), and it never restarts while a task, approval or install is in progress. Updates are checked against a signature made with the maintainer's key, which is built into your copy of Legion."
- SECURITY.md: "Legion's own update code accepts a release only if its manifest verifies against a public key compiled into the app, the package matches the signed sha256 and size, it is newer than the running build, and every download hop is https to github.com or GitHub's release-asset hosts. This does not protect against a compromised maintainer signing key or account with the key, a malicious change the maintainer signs, a compromised build machine, or local malware running as you. There is no remote key revocation. Unsigned build; first installs are trust-on-first-use of the repository."
- Never write: "secure updates", "tamper-proof", "cannot be bypassed", "safe to auto-update".
- Settings text for the auto toggle: "Install updates automatically when idle. Legion will download a new release without asking again and restart itself when no task or approval is running. Off by default."

## 12. Build order (phase 2, tests first)

1. `semver`, `trust`, `manifest`, `net` (+ tests C1-C7). 2. `package` (C8-C10, C20). 3. `idle`, `state`, `index` (C11-C15, C19). 4. `apply` + `updater-main` (C16-C18). 5. release scripts (C22-C23), `updater-surface` + ALLOWLIST (C21, C24). 6. UI panel, hooks, docs, CHANGELOG ("Updater" heading), real-PC checks file. Mutations recorded in the final report. Gates: `npm ci && npm run build:ts && node --test "dist/test/*.test.js"`, `npm run typecheck`, `npm run build:ui`.
