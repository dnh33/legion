# Task 4 report: signed gate settings files

Commit 92ffd23c (base 8c9fff81). Branch feat/gates-pr2. No push, no stash, no subagents.

## Files
- New: `src/core/gates-settings/sign.ts` (Signer, makeSigner, canonicalize), `test/gates-sign.test.ts` (35 tests).
- Changed: `src/core/gates-settings/store.ts` (signer option, verify on read, outside/pending, accept, keepMine, canSign, changedOutside, isLoosening, allowedHosts, envKeep, overrides, view fields), `src/core/gates-settings/index.ts` (`keyring` option, `PRESETS` allowed, exported `requireNative`, `nativeSecret` option, PATCH loosening needs native, `POST /api/gates/accept/:name` (native) and `/keep/:name`), `src/bin/legion-core.ts` (keyring and nativeSecret passed), `src/shared/gates-registry.ts` (shellFloorOff, `expert` and the rail-shell-floor `ifOff` removed; `allowedHosts`, `envKeep` added), `test/gates-registry.test.ts`, `test/gates-routes.test.ts`, `test/gate-parity.test.ts` (one line, see deviations).

## Red first
`npm run build:ts` failed with 72 TS errors (missing sign.js, isLoosening, changedOutside, allowedHosts, keyring, nativeSecret). After the first implementation, 13 tests failed; 10 were test-harness bugs I fixed (folder not created, `mk(undefined)` hit the default parameter, GET with body, old routes tests needing native). Real behavior fixes: none needed after that besides the parity test (below).

## Final
`gates-sign` 35, `gates-store`, `gates-routes`, `gates-registry`, `gate-parity`, `gates-settings`, `gates`, `gates-ui`, `gates-remember`: 127 tests, 127 pass, 0 fail. `engine-mode-resolver` and `gate-suggestions` (use gates types): 13 pass. `npm run typecheck`: clean. Full suite not run.

## Rulings applied
- F2: Keep mine keeps the in-memory Ask, rewrites signed; Accept test uses one store instance.
- F3: option `signer`; `createGatesCore({ keyring })` added.
- Shell floor switch cut: patch naming `shellFloorOff` is 400 "no switch"; an old signed file with it verifies (signature covers every key but `sig`), field dropped, file rewritten signed without it (test). Unsigned Ask file with it: same.
- `allowedHosts` (cap 200, lowercase, deduped, app file only) and `envKeep` (cap 50, `NAME` or `NAME*`, app only) are signed and adding an entry is a loosening.

## Design notes
- A file needs a valid signature only when it is looser than blank. Ask and blank files (PR 1) stay valid unsigned; with a key they are signed on first load.
- `isLoosening` compares what would change: preset rank, limit, the effective value of every permission gate (so dropping an override that held a gate on is a loosening), new hosts or env names. Invalid body counts as a loosening (fail closed).
- `overrides` in a patch is the whole list (a gate left out returns to the preset value).
- No key: `merge` refuses anything looser (400 with the keystore message); `writeOne` refuses to write a looser file; accept refuses.

## Deviations
1. Routes are in this commit (brief had them in Task 5): PATCH loosening needs the native header, accept needs it always, keep needs admin only, `requireNative` exported. Without this an admin token alone could loosen between Task 4 and Task 5. Task 5 can build on them.
2. `test/gate-parity.test.ts`: one line, the core gets a test keyring, because the test switches `limit` off on a project with no preset, which is now a loosening. Assertions unchanged.
3. With no key AND no native secret, a loosening returns 403 native_unavailable (native is checked first); the key message shows only when native passes.

## Concerns
- A missing project file reads blank (no cap), so deleting a signed Ask file removes the cap. This existed in PR 1 and is not fixed here.
- Resolver still maps `smart` to the agent's own mode and `bypass` to `full`; Task 3 owns that. With a key and the native confirm, a loosened preset is now storable, so Task 3 must land before this reaches users.
- Task 5 UI/IPC (dialog wording, `GatesChange`) not started.
- CHANGELOG not touched (PR level).

## Drift check
1. Stayed inside Task 4 plus the two route/parity edits named above; no unrelated files.
2. No processes started, no temp files outside the tests' own temp dirs; D:/bots/legion, %APPDATA%/legion and real key files untouched.

## Fix round 1 (review: task-4-review.md)

Red first, on commit 92ffd23c plus stubs for the new key files: `test/gates-sign-r1.test.ts` 19 tests, 13 failed (C1 x4, I1 x2, C2 x2, I2, I3 x3, I5 wiring), 6 passed (the I5 key helpers, written first). Final: 170 of 170 pass across gates-sign-r1, gates-sign, gates-store, gates-routes, gates-registry, gate-parity, gates-settings, gates, gates-ui, gates-remember, connectors-key-handoff, connectors-store, engine-mode-resolver. `npm run typecheck` clean. Full suite not run.

Fixed
- C1: the signed app file lists every project file with its counter (`files`). A listed file that is missing reads Ask and is listed (Keep mine rewrites it; Accept has nothing to apply). With a key, an unsigned project file is applied only if it is an Ask file with a cap and not listed (PR 1 migration, signed on first save); an unsigned blank or `limit:false` file reads Ask and is listed, and is never re-signed. `store.ts` readOne.
- C2: a project with no preset or limit off has "no cap", ranked above Bypass; going to it from any cap is a loosening (native header; keyless refuses). Route test: admin-only `preset:null` is 403.
- I1: every signed file carries `gen` (one counter, only goes up); a file below the listed counter is changed outside. Signature already binds the name (A's file as B fails, tested). App list is written after the project files.
- I2: app `overrides` refused on patch (400) and ignored on read.
- I3: `reload()` writes pending changes first and throws 409 if one cannot be written (nothing re-read). Route wrapped. The old "reload drops unsaved changes" test now says reload saves them.
- I5: own gates key, independent of GitHub. `src/electron/connector-key.ts` (`ensureGatesKey`, `loadGatesKey`, `gatesKeyLine`) wraps a random key with the same OS keystore (`safeStorage`, same wrapping as the connector key) into `<dataDir>/gates-key.bin`. `src/electron/main.ts` creates it at launch (first launch) and sends it as its own stdin line `GATESKEY <hex>`; `src/core/gates-settings/keyring.ts` (GatesKeyring) installs it; `src/bin/legion-core.ts` passes it to `createGatesCore`. No usable keystore (Linux without a real backend, safeStorage unavailable): no key, fail closed, only Ask. `connectors-key-handoff.test.ts` regexes updated for the new launch line.
- Minors fixed: M1 (BOM stripped), M2 (comment), M3 (message says keystore, no "Connect once"), M4 (tests above).

Remains / accepted gaps
- Deleting the whole gates folder (app.json too) or replaying an old app.json looks like a fresh install; needs state outside the folder.
- M5 (a patch to a listed-changed name silently clears the banner) not changed: safe, UI should disable editing; Task 5/12.
- First-launch key creation can show a Keychain prompt on macOS once; Windows DPAPI none. If the owner wants lazy creation, move `ensureGatesKey` into the first loosening confirm (Task 5, needs a core restart).
- Keyless core after a keyed past: signed files read as Ask; the list is used as a hint only (adds Ask), the app file is flagged.
- I4: Task 3 lands next. Task 4 must never be merged or built into a release without Task 3 (a Smart cap is no cap until then).

## Fix round 2

Failing before the fix (same tests run against d3f5ce3e in a scratch worktree, since removed): gates-sign-r2: 8 of 10 failed (the key-state test did not compile there), data-folder-guard: whole file failed (module missing, 5 tests), data-folder-engine: 1 of 3 failed (the mv, cp, rm card test; the read-free and Bypass tests pass by design). Final: 215 of 215 pass over gates-sign-r1, gates-sign-r2, data-folder-guard, data-folder-engine, gates-sign, gates-store, gates-routes, gate-parity, gates-settings, connectors-key-handoff, engine-mode-resolver, engine. `npm run typecheck` clean.

Findings:
- A (controller ruling) FIXED. New pure helper `src/core/exec/data-folder-guard.ts` (`dataFolderHit`: names / hidden / none; resolves `~`, `$HOME`, `%APPDATA%`, `$env:...`, any env var, both slashes, case, `..`, `/c/` and `/mnt/c/`, wildcards, 8.3 names). Wired in `engine.ts` `shellFloor` (right after the floor refusals, before any gate allow; covers the PreToolUse hook for Bash/PowerShell/Monitor/mcp__host__shell and the provider decider). Card has `noRemember`, appears in every mode but Full, reads stay free (consequence tags all `reads`). Comment marks where Task 17 folds it into askGuards. Gates module: `shellProtectedPaths()` = whole data folder; file-tool `protectedPaths()` now also covers gates-key.bin, projects.json, config.json. Engine tests: mv/cp/rm/redirect cards with no Remember in Ask and Auto-edits through the hook. Smart is not reachable in the resolver yet (ApprovalMode has no smart), so the Smart case is covered by the guard being mode-independent plus the level test (mv and cp are level 2).
- B FIXED. `GATESKEY <hex> new|old|lost` (`gatesKeyState()` decided in main.ts before the key file is made; a line with no state reads as old). Old or lost key with app.json missing or unverified: every project reads Ask, all names listed, patchApp refused (409), Accept on app refused, Keep mine on app writes Ask everywhere (route passes the project ids) and imports nothing (N1, N2, N3, N8c). App counter below any verified project counter: same lost state (N4). A project file is genuine only if the verified list names it. Keyless: a listed project file with no Ask cap reads Ask and is listed; a signed app.json with its list is not rewritten keyless (N5). Startup prune removed, so no cap file or list entry is deleted for a project missing from projects.json (N7; `prune()` stays for an owner's project delete, not wired).
- C: N9 test added (BOM). N10 comments fixed (sign.ts, index.ts). N11 message "There is no file to apply. Choose Keep mine." N12 NOT done: lazy key creation needs the running core to get the key without a restart; larger than small.
- D / N8: no code. Sentence for the PR body: "Legion's signed settings stop agents and outside edits; they cannot stop other programs running as you, and Bypass can change anything."

Costs and limits to know: (1) a user upgrading with an in-use data folder and no key file sees the lost banner once and presses Keep mine (the ruling's "lost" rule). (2) A crash between a project write and the app write now reads as lost (fail closed). (3) A new install writes a blank signed app.json at first start so that a later missing one means deleted. (4) Not done: `GATESKEY unreadable` for a key file that does not open (N6 message part); a key file that does not open means keyless (still fail closed, and listed project files now read Ask).

## Fix round 3 (stopped at the context cap: N13 and N14 done, the rest NOT done)

Failing before the fix (against 5bc277de): the new N13 test failed (app.json was rewritten from the partial list, P read full after a restart); the N14 tests did not compile there (no `unreadable` key state, no `keyUnreadable` on the view, no `GATESKEY - unreadable` line). Final: gates-sign-r1, gates-sign-r2 (14 of 14), data-folder-guard, data-folder-engine, gates-sign, gates-store, gates-routes, gate-parity, gates-settings, gates-registry, gates, gates-ui, engine-mode-resolver, connectors-key-handoff: 174 of 175 pass. The one failure is `main.ts: the keyless launch line is untouched` in connectors-key-handoff: its regex needs LF and this Windows checkout has CRLF in main.ts (HEAD is LF); it reads the same text as before my edit and is not caused by it (not re-proved on 5bc277de). `npm run typecheck` clean.

- N13 FIXED. `writeDirty` never adds `app` to the write order while `lost`. Test covers tighten Q, Keep mine on Q, and tighten + Reload; app.json stays absent, P is Ask and listed after a restart.
- N14 FIXED. `GATESKEY - unreadable` (Electron sends it when the key file exists but does not open); keyring state `unreadable`; the store treats it as lost for good (every project Ask and listed, patchApp 409 with its own message, Keep mine on app writes Ask files but does not end it). Gates view carries `keyUnreadable`. NOT done: the Gates page text "the key could not be opened" (UI reads `keyUnreadable`; no UI change made).
- N16, N17, N18, N19, N22: NOT done (canonicalLocal helper, cwd/cd-aware shell guard, workspaces free, same protected set for file tools and shell, plain reads free). Design chosen, for the next round: protected set = gates folder, gates-key.bin, config.json, state.json, projects.json plus other modules' protectedPaths; one `canonicalLocal` in `src/core/exec` used by the file-tool hook (engine.ts ~1636, deny on opaque `\?\Volume{`/GLOBALROOT) and by `dataFolderHit` (new `cwd` argument, token pass with cd/pushd/Set-Location/-C tracking, write-verb list gates the `hidden` answer, junction targets checked against the data folder).
- N21: no stale comment found in store.ts (the writeDirty comment already says only Keep mine on app ends it); moot after N13.
- N15 / N4b limit sentence for the PR body: "Signed settings catch a changed, deleted or older single file, but an old copy of the whole gates folder put back together is not detected, so a program running as you (or an agent in Full) can restore an older, looser state."
- Gotcha for the next run: Python text-mode writes turned LF into CRLF here; use the Edit tool or `newline=''`.

## Fix round 4a (N16, N18, N19: canonical paths, one protected set for the file tools)

Failing before the fix (against 097d8c38): canonical-local.test: whole file failed to compile (module missing, 6 tests); file-tool-protected.test: 1 of 1 failed (the `\localhost\c$\...\state.json` Write was allowed, with the new helper present but the hook not yet using it). Final: 238 of 238 pass over canonical-local, file-tool-protected, gate-parity, data-folder-guard, data-folder-engine, gates-settings, gates-store, gates-routes, gates, engine, engine-mode-resolver, gates-sign, gates-sign-r1, gates-sign-r2. `npm run typecheck` clean.

New module `src/core/exec/canonical-path.ts` (exports for the shell-guard agent):
- `canonicalLocal(p: string, opts?: { cwd?: string }): string` folds `\?\`, `\?\UNC\`, `\localhost|127.0.0.1|[::1]|<hostname>\<d>$\` (both slashes) to the drive path, strips trailing dots/spaces per segment, resolves `.`/`..`, resolves relative paths against `cwd`, expands 8.3 names and junctions through `realpathSync.native` of the deepest existing parent, lower-cases on Windows.
- `isProtected(p: string, set: readonly string[], cwd?: string): boolean` canonical compare (equal or inside); opaque device paths always true.
- `isOpaqueDevicePath(p: string): boolean` (`\?\Volume{`, `\.\GLOBALROOT`, `HarddiskVolume`, `Device\`).
- `dataFolderTargets(dataDir: string): string[]` = gates folder, gates-key.bin, config.json, state.json, projects.json (NOT the whole folder: workspaces stay free).
- `protectedTargets(dataDir: string | undefined, modules: ReadonlyArray<{ protectedPaths?(): string[] }>): string[]` = dataFolderTargets (when dataDir given) + every module's `protectedPaths()`.

Wiring: the gates module's `protectedPaths()` is now `[store.folder, ...dataFolderTargets(dataDir)]` (adds state.json); engine `protectedDirs()` returns `protectedTargets(undefined, this.modules)`; the file-tool PreToolUse hook calls `isProtected(target, this.protectedDirs(), cwd)`.

NOT done (for the shell-guard agent): `dataFolderHit` still uses `shellProtectedPaths()` = the whole data folder, so agents' workspaces still get a shell card (N18 shell half); wire it to `protectedTargets` + `isProtected`/`canonicalLocal` with cwd and cd tracking. The 8.3 test only asserts when the temp drive makes a short name different from the long one (skipped silently otherwise; not confirmed which on this PC). Tests skip off Windows.

## Fix round 4b (N17, N18, N22: the shell guard reads real paths and guards only writes)

Failing before (against 64aa282e, run with tsx): shell-guard-paths.test failed in 9 of 10 tests (new signature with cwd; the first assertion of each group answered `none`); the workspace case already passed there only because the old rule covered the whole folder (it is N18 from the other side: it carded `cd <ws> && npm install`). Final: 194 of 194 pass over shell-guard-paths (new), data-folder-guard, data-folder-engine, canonical-local, file-tool-protected, gate-parity, gates-settings, gates-store, gates-routes, gates, gates-ui, engine, engine-mode-resolver. `npm run typecheck` clean.

- `dataFolderHit(command, kind, protectedSet, { cwd, env })` in `src/core/exec/data-folder-guard.ts` is rewritten. It cuts the line into simple commands, keeps a working folder through `cd`, `chdir`, `pushd`/`popd`, `Set-Location`, `sl` and `git -C`, and compares every path with `isProtected` (canonical: `..`, admin share, `\?\`, trailing dot, 8.3, existing junctions). Opaque volume paths always count.
- One set: the engine passes `protectedDirs()` (= `protectedTargets`), so `shellProtectedPaths` is gone (modules.ts, gates module). Workspaces inside the data folder are free (N18).
- Only writers are read (explicit verb list in `WRITERS`, git writing subcommands, `sed -i`, tar/unzip/Expand-Archive, `node/python -e/-c`, `bash -c`, `cmd /c`, `powershell -Command` one-liners, `>`/`>>`). Reads and the engine's old level shortcut: the shortcut is removed, the guard decides alone.
- Links: every path token of mklink/ln/New-Item is also tried relative to the link's own folder.
- Unknown (`hidden`, card, no Remember): a variable, `$(...)`, backtick, `~user`, brace list, `^` (cmd), `+`/`::` (pwsh), an unresolved 8.3 name, an unknown cwd after `cd $x`/`cd -`, in a command that writes. Variables in non-writing commands and in `git commit -m "$x"` keep Remember.
- Wildcards are matched segment by segment against the protected set (`rm -rf *` in the data folder cards; in a workspace it does not).
- Existing data-folder-guard test moved to a fake user (`Fakeuser`), so no test reads the owner's folders.

NOT done: item 4 (Gates page message for `keyUnreadable`). The worktree has no view that reads `/api/gates/settings` (ui/src/gates holds only the old rules section; `changedOutside` and `keyUnreadable` appear nowhere in ui/src), so there is nothing to add the sentence to. Text to use when that view lands: "Legion could not open its signing key, so every project is on Ask. Restart Legion; if this stays, choose Keep mine to make a new key."
Limits: text matching only. A script or program that builds its path elsewhere (python script.py, npm run x) is not read; a junction created in the same line cannot be followed, but its creation cards. Tests skip off Windows.

## Fix round 5 (default deny; N14b, N16b, N23-N28, N30, N31)

Failing before (against 40968dfe): new `shell-guard-default-deny.test`: 8 of 8 failed (N23, N24, N25, N26, N16b, N27, N31, and the false-card test; I did not record which row of the false-card test failed first. rereview3 N30 documents that the for-loop row carded at 40968dfe). In file-tool-protected, connectors-key-handoff and canonical-local: 3 of 17 failed (own-address share, hardlink and connectors through the Write tool; no launch line; connectors missing from the set). Final: 253 of 253 pass over shell-guard-default-deny, shell-guard-paths, data-folder-guard, data-folder-engine, canonical-local, file-tool-protected, connectors-key-handoff, gate-parity, gates, gates-settings, gates-store, gates-sign, gates-sign-r1, gates-sign-r2, engine and engine-mode-resolver. `npm run typecheck` is clean. One existing assertion changed: in data-folder-guard, `mv "$(echo C:/Users/Fakeuser/AppData/Roaming)/legion/..."` now answers `names` (the substitution names a folder above the data folder), not `hidden`. It still gets a card.

Reviewer probe corpus (t4rev4/guard.mjs, run again against a FAKE folder in scratchpad/t4fix5): every attack row gets a card. One row answers `none`: `(cd ../..); rm gates/app.json`. That is correct, because the subshell's cd does not last. Of the ordinary rows, only `cp $f out.txt` and `rm -rf $TMPDIR/build` get a card (N30, see below).

- **N23 fixed.** Default deny replaces the writer list. Every word is checked, including the command word. A hit counts unless every part of the line only reads (cat, type, more, less, head, tail, Get-Content/gc, Get-ChildItem/gci/dir/ls, Get-Item/gi, Test-Path, Select-String/sls, rg without `--pre`, grep, findstr, wc, stat, pwd/Get-Location, git status/log/diff/show/rev-parse without `--output`, and echo/Write-Output with no redirection). Echo words are text, so only a protected name in them counts. Hidden commands are read too: `$(...)`, backticks, `<(...)`, heredoc bodies (parsed as commands for a shell, as code for an interpreter, otherwise as text whose `$(...)` is still read), `<<<`, iex/Invoke-Expression strings, Start-Process -FilePath/-ArgumentList, cmd /c /k /r, powershell -Command (and its prefixes), bash/sh -c, and node/python/perl -e/-c. Paths inside a longer word (`-o<path>`, `'/c','del','<path>'`, code) are found and checked.
- **N24 fixed.** A word that holds a protected entry (the data folder, the home folder, the drive root) is a hit. A workspace or any other subfolder that is not protected stays free (N18 still passes).
- **N25 fixed.** Bash backslash escapes are undone, and the backslash spelling is tried as well. `$'...'` is decoded. The pwsh backtick and the cmd caret are undone. Only HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and TMP are expanded. A line that sets one of these or CDPATH (`X=`, `export`, `$env:X=`, `set X=`, `read`, `unset`, `for X in`, `Set-Item env:`, `Set-Variable`, `SetEnvironmentVariable`), or that redefines cd/pushd/Set-Location (a function, alias, Set-Alias or doskey), is unknown: card, no Remember. An encoded PowerShell command (`-e`, `-ec`, `-enc...`) is unknown too.
- **N26 fixed.** The guard tracks every folder the line can be in. A cd, pushd, Push-Location, Pop-Location, Set-Location or sl that is not followed by `&&` adds the new folder to the possible folders. A relative word is checked against each one; after an uncertain move, a relative word in a line that is not read-only is `hidden` when no possible folder hits. A sh subshell `( )` restores the folder at `)`. pwsh and cmd parentheses only group, so a move inside them stays possible. A cmd `cd` to another drive without `/d` is uncertain.
- **N16b fixed.** A UNC host is local when it is 127.x (in any IPv4 spelling: `127.1`, `0x7f.1`, decimal), `0.0.0.0`, localhost, the host name (bare, with a trailing dot or with a domain), any `os.networkInterfaces()` address (v4 or v6, with or without a zone, `[v6]`, `::ffff:` mapped), or a `.ipv6-literal.net` name. The list is cached for a minute. A remote UNC path is never stat'ed or resolved against cwd. The test checks that `//10.255.255.1/...` answers within 2 s.
- **N27 fixed.** Making a hardlink cards through default deny: fsutil hardlink, mklink /H, ln without -s, and New-Item HardLink with -Target or -Value, relative to the link too. `isHardlinkToProtected` compares (dev, ino) via `statSync(bigint)`, on local paths only, and only for a file with more than one link. It walks the protected set once per run (file tools: a per-run cache in `buildOptions`) or once per command (shell). The file-tool hook refuses such a target, and the shell guard counts it.
- **N14b fixed.** main.ts always sends a gates line. No key (a missing file that could not be made, or a file that does not open) sends `GATESKEY - unreadable`. Test: connectors-key-handoff (its CRLF-sensitive regex is fixed too).
- **N28 fixed.** The protected set is made canonical once per command (`canonicalSet`). Each word's canonical form is memoised per command. Remote UNC paths are never stat'ed.
- **N31 fixed.** `connectors` is in `dataFolderTargets`, so it is protected for both the file tools and the shell.
- **N30 (listed, fail closed).** A variable that is not a known folder variable, in a line that is not read-only, gets a card with no Remember. Examples: `cp $f out.txt`, `rm -rf $TMPDIR/build`, `cd "$(git rev-parse --show-toplevel)" && rm -rf dist`, and any relative word after `cd x;`. Exception: a sh `for X in <literal words or globs>` loop variable is replaced by each of its words, so `for f in *.ts; do cp "$f" "out/$f"; done` stays free. Other false cards by design: a line that sets TEMP, TMP or HOME (`TMP=./tmp npm test`); a lone `/` or `~` as a word in a writing line (`tr / _`); and a read of a protected file in a line that also writes (`cat ../../state.json && npm test`), because the whole line must be read-only.
- **N29 not changed.** Claude Code's Bash keeps its cwd between calls; the guard still starts from `agent.cwd`.
- **Unparseable means a card** (added after reading the precedent). An unclosed quote, `$(`, backtick, `$'...'` or heredoc makes the line unknown, even when it only reads. Exceptions: a cmd apostrophe is a plain letter, and a bash `\"` inside double quotes is an escape (`grep -o "[^\"]*"` stays free). Test: shell-guard-default-deny.
- **Providers folder** (coordinator item). `providers` (the provider API keys) is in `dataFolderTargets`. Tests: Write to `providers/keys.json` or a new file there is refused (file-tool-protected); `mv`, `rm`, `Remove-Item`, `cat x >` and a relative `rm` get a card; `cat` and `Get-Content` stay free (shell-guard-default-deny).
- **Network tripwire.** I added an allowlist entry in `test/bsv-scan.ts` for `data-folder-guard.ts`, kind `decode`, because the `$'...'` decoder uses `fromCodePoint`. The six bsv-review-tripwire failures that remain are all `src/shared/web-verdict.ts: network module node:net`. That file is not in this diff; it was last changed by 8c9fff81, from another task. Not fixed here.

Final counts after these additions: 472 of 478 pass, over the 20 targeted files plus the four repo guard files (bsv-review-tripwire, house-theme-tokens, ui-kbd-nav, prebuilt-contract) and gates-routes, gates-ui, gates-registry and gates-remember. The 6 failures are the web-verdict tripwire above. `npm run typecheck` is clean.

Precedent:
- **Parser.** `codex-rs/shell-command/src/bash.rs:29-98` (`try_parse_word_only_commands_sequence`) parses with tree-sitter bash. A command counts as plain only when every node is in a small allowed set (`program`, `list`, `pipeline`, `command`, `word`, `string`, `raw_string`, `number`, `concatenation`), its words are literal, and its only operators are `&&`, `||`, `;` and `|`. Anything else (redirections, substitutions, parentheses, control flow) or a parse error returns None, which means "not safe". Legion has no shell parser among its dependencies (package.json: no tree-sitter, no shell-quote), and the brief does not allow new ones. So I kept the hand tokenizer, but borrowed the rule: a line that cannot be parsed is not safe (a card).
- **Where I go further than Codex.** Codex rejects every substitution and redirection outright. Legion reads inside them (`$(...)`, heredocs, `bash -c`, iex, Start-Process), because Legion must also answer "does this touch a protected file" for lines that are not read-only. A read-only line keeps its exemption only when its inner commands are read-only too.
- **Destination rule.** `hermes-agent/tools/approval_detection.py:56-69`: `_SENSITIVE_WRITE_TARGET`, and the cp/mv/install rule that treats only the last argument (the destination) as a write target. I did NOT adopt it, because it would loosen the guard. A cp source is not always a read: `cp -l` and `cp -s` make links to the source, and `mv` removes it. Default deny cards a protected source too. The cost is a false card on `cp <protected> <backup>` in Smart.
- **Malformed quoting.** Hermes `detect_hardline_command` (`:199-224`) blocks malformed quoting, and its own comment records 118 false blocks from benign `grep -o "[^\"]*"`. I adopted the unparseable rule with that fix built in: escapes are honoured before quotes are judged, and cmd apostrophes are letters. There is a test for both.
- **Sensitive targets.** Hermes's list (system config, ssh, shell rc, credentials, its own env and config) overlaps with Legion only at "the harness's own config and keys". Legion covers that with its own set (gates, key, config, state, projects, connectors, providers, armory, away). System folders and home folders are the separate shell floor's job (`shell-floor.ts`), not this guard's.
- **Dangerous patterns.** Hermes `detect_dangerous_command` (`:1548`, DANGEROUS_PATTERNS at `:228`) is a pattern deny-list. Legion's guard is default-deny over every word, so its options-after-operands lessons (`rm build/ -rf`) do not apply here.

PR limit sentences:
- Full (Bypass) can change anything.
- Any program running as you can change Legion's local files or unwrap the key.
- The shell guard reads command text. It cannot see a path that a script or program builds when it runs (`python script.py`, `npm run x`, `node -e` with `os.homedir()`). Only an OS sandbox stops that.
- A share name other than the drive's admin share (`\\localhost\<custom share>`) that points into the data folder is not mapped.

## Final fixes

N29 (cwd kept across shell calls). Per-run flag `Active.shellMoved` (engine.ts). `dataFolderRead` (data-folder-guard.ts) returns `{hit, moved}`; `moved` is set when a `cd`/`pushd`/`popd`/`Set-Location`/`sl`/`chdir` leaves a folder that is not the starting folder and is not provably outside the protected set (not in, not above, not a protected entry), when its target is unreadable, or when the line is already unknown (redefined `cd`, CDPATH). The engine passes it back as `cwdUnknown` for the rest of the run, for Claude's Bash/PowerShell/Monitor only (the host shell takes a folder per call). While set, a relative word in a command that writes is `hidden` (card, no Remember); reads stay free. A failed guard read also sets the flag. Tests: engine path (cd into the data folder, then `rm gates/app.json` and `Remove-Item` card in Ask and Auto-edits; `cd <outside subfolder>` then `rm build/x` stays free) plus unit tests of `moved`.

N30 (false cards). In `one()` the `!where.exact` rule is gone: a relative word is `hidden` only when no folder is known or the set hit the 8-entry cut. An unreadable `cd` target now clears the set (before, it kept the old folder, which `exact` used to cover). TMPDIR added to the known variables. `cd x; npm run build` (sh, pwsh) is `none`; `cd x; rm ../../<data>/gates/app.json` and `cd /nonexistent; rm ...` are `names`. Two older N26 rows changed by design: `cd /nonexistent; cp a b` is now `none` (both folders tried, neither protected), and a pwsh row now uses `rm gates/app.json` (`names`) instead of `rm x`.

Seen failing first on aab56ba3: the N29 engine test, both N30 tests. Precedent: Claude Code docs, tools reference, "What persists between commands" (code.claude.com/docs/en/tools-reference): a `cd` in the main session carries over to later Bash calls while it stays inside the project or an added directory; PowerShell follows the same rule. Codex (shell-command/src/bash.rs has no `cd` handling; parse_command.rs lines ~404-451, 1520) only strips a leading `cd x &&` to describe one command and carries nothing between calls, so there was nothing to adopt; I kept Claude's persistence model and made the guard conservative about it instead.

Known limit: a proven-outside `cd` (a project subfolder) is not carried, so `cd sub` then `rm ../../<data>/...` in the next call resolves from the starting folder, not `sub`. Not covered here.

Carried folder. `dataFolderRead` also returns the folder(s) the shell may be in after the line (`cwds`); the engine stores them on the run (`Active.shellCwds`) and starts the next Claude shell call's resolution there, as Claude Code's Bash does. After an unproven cd the N29 flag stays as well. This closes the "proven-outside cd is not carried" limit above: `cd <project>/sub` then `rm ../../<data>/gates/app.json` now cards, and `rm build/x` stays free. Seen failing first on ee3ba697.
