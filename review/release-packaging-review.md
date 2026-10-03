# Independent review: `claude/release-packaging` (against `rel2`)

Reviewed commit `652c5d2` on 2026-10-02. The branch was not modified. No secret value is printed in full anywhere below.

## Verdict: SHIP AFTER FIXES

The history is clean: I found no real secret. The tests and typecheck are green. Three things should be fixed before the repo goes public:

- F1: the process matcher can be fooled into killing another app's Electron.
- F2: `-Yes` plus an unchecked `-InstallDir` can wipe a foreign folder.
- F3: the audit's own claims are wrong in two places.

None of these is a leaked credential. F1 and F2 are one-hour fixes.

## 0. Results

| Check | Result |
|---|---|
| `npm ci` | ok |
| `npm run build:ts` | ok (exit 0) |
| `npm test` | **1374 tests, 1373 pass, 0 fail, 1 skipped** (rel2 baseline 1368, so +6 new tests) |
| `npm run typecheck` | ok (root and `ui`, exit 0) |
| The skipped test | `process matcher ... runs in real PowerShell`: no PowerShell on this Linux box |
| Same test with PowerShell 7.4.6 on PATH (downloaded for this review) | 6/6 pass |
| `[Parser]::ParseFile` on setup, uninstall and legion-procs | 0 parse errors (PowerShell 7 parser; Windows PowerShell 5.1 not available) |
| `.cmd` and `.ps1` encoding | all 5 files are pure ASCII with CRLF in the working tree; the index holds LF and `.gitattributes` (`*.cmd`, `*.ps1` text eol=crlf) converts them. No `??`, `?.`, `&&` or `\|\|` constructs that 5.1 lacks. |

### Which new tests are real and which are string matching
`test/installer-scripts.test.ts`:
- Tests 1 to 5 are regex checks on file text. They prove the strings are present, not that the scripts behave. `setup.cmd`, `setup-yes.cmd`, the setup flow, uninstall and the shortcut handling are never executed.
- Test 6 is the only behavioural test. It runs `Select-LegionProcesses` in real PowerShell on a list of fake process objects.
  - It passes `-RootCheck { $r -notlike '*other-app*' }`, so `Test-LegionRoot` (the real marker check) is never exercised.
  - `Stop-LegionProcesses` is never exercised.
  - `findPowerShell()` tries `pwsh` before `powershell`. On the Windows CI runner that is PowerShell 7, so Windows PowerShell 5.1 (what users run) is never tested.
  - CI (`.github/workflows/ci.yml`) triggers only on push to main/master and on pull requests.

## 1. Secrets scan of full history

Method: `git log --all -p`, 17.4 MB of patch text, 80 commits including this branch. My own patterns:
- API keys and tokens: `sk-`, `sk-ant-`, `gh*_`, `github_pat_`, JWT, `AKIA`, `AIza`, `xox*`.
- PEM headers (the grep for these errored on my first run; they were re-checked via the file-name scan, which found no `.pem`/`.key`).
- boat.dev prefixes: `bk_`, `boat_`.
- xprv, WIF, BSV address shape, 40 to 64 hex strings.
- `apiKey|secret|token|password|bearer = <20+>`.
- E-mails, Windows `C:\Users\..`, `/home/..`, public IPs, port `3321`.
- File names: `.env`, `.pem`, `.key`, `.sqlite`, `.db`, `.exe`, `.zip`, `.legion`, `state.json`, `config.json`, `*.log`, wallet, credentials.

**Confirmed: no real secret in history, no rewrite needed.**
- Test fixtures: every `sk-ant-api03-…` is 25 to 37 chars of placeholder text (`ABCDEFGHI…`, `zzzz…`, `keykey…`). The JWT (60 chars, `eyJhbGciOiJIUz…`), the `AKIA…` string and the `xoxb-1234…` string are redaction-test fixtures. The `bk_live_*` and `boat_*` values are 20 to 29 chars and spell words (`TOPSECRET`, `SHOTKEY`, `ROUND2_SEC…`).
- The `apiKey:` and `token=` hits (`key-A`, `k_test…`, `abcd…`, `sk-con…`) are placeholders.
- No file with a secret-bearing name was ever committed. The name hits are only `wallet-probe.ts`, `wallet-tool.ts`, `BSV-WALLET-DESIGN.md`, `bsv-wallet*.test.ts`, `library-review-secrets.test.ts` and tsconfig files.
- Authors: `m <a@b>`, `Rune <rune@localhost>`, `dnh33 <…@users.noreply.github.com>`, `Claude <noreply@anthropic.com>`. No personal e-mail, no `@gmail`/`@outlook`/`@proton`.
- Windows paths are `C:\Users\Dan\…`, `\you\…`, `\a\…` (fixtures) plus `D:/bots/legion-v5` (commit message).
- The only public IPs are the documentation addresses `1.2.3.4` and `172.20.0.1`.
- Port 3321 appears only in docs, tests and test-perf guards (`shots.mjs`, `titlebar-shots.mjs` refuse to use it), plus two non-wallet hits: a prose note in `bsv.json` ("Legion's only wallet contact today is…") and a base64 SVG blob in `scout.json`. It appears nowhere in `src/` code paths.

### Where the audit is wrong or incomplete

**F3a. The audit says "No xprv/WIF" (H3). That is false.** Three key-shaped strings are in the tests and in history:
- A WIF `5HueCGU8…` (51 chars), in `test/bsv-audit.test.ts:15` and `test/bsv-review-pack.test.ts:168`. The hex `0c28fca3…` is also in history, which matches the well-known Bitcoin-wiki private-key example.
- A WIF `L1aW4aub…` (52 chars), in `test/library-review-secrets.test.ts:24`.
- An xprv `xprv9s21ZrQH143K3QTDL4…` (111 chars), in `test/library-review-secrets.test.ts:22` and `test/library-graph.test.ts:82`. It matches the public BIP-32 test-vector master key.

These are published test vectors, not wallet material, so the verdict stands. They are still not "none": they will trip GitHub secret scanning or any partner-pattern scanner, and the audit text should say so. Optional fix: build them in the tests (`'xprv' + '9s21…'`) so no scanner matches the literal.

**F3b. L5 understates the BSV licence risk.** The audit says "about 60 unverified nodes". My count over `src/core/kg/seeds/bsv.json` is:
- 133 of 157 nodes have at least one source tagged `unverified` or `no LICENSE file`.
- **91 nodes have only unverified or no-licence sources.**
- 24 nodes cite the private `legion-specs/…` documents.

**F3c. The audit cannot be checked from here for the GitHub side** (issues, PRs, Actions logs, forks). It says so itself. Run GitHub secret scanning and push protection as it recommends.

## 2. Licence re-check

- `package-lock.json` totals match the audit exactly: MIT 207, ISC 14, BSD-3 3, BSD-2 2, Apache-2.0 3, Unlicense 1, CC-BY-4.0 1 (`caniuse-lite`, dev only), and 9 `SEE LICENSE IN …` entries for `@anthropic-ai/claude-agent-sdk` plus its 8 platform packages. Nothing is copyleft and nothing lacks a licence.
- The Anthropic SDK is proprietary (`© Anthropic PBC. All rights reserved`). Its own `LICENSE.md` links `https://code.claude.com/docs/en/legal-and-compliance`; NOTICE links `https://www.anthropic.com/legal`. Point NOTICE at the same page the SDK points to. The new sentence "Legion does not include it" is accurate: it is installed by `npm ci` and is not vendored.
- No `.blend`, `.zip`, `.exe`, `.dll`, `.so` or `.node` file is tracked, which matches the Blender statement in NOTICE. The only files under `licenses/` are `OFL-1.1.txt` and `LICENSE.md`. The OFL copyright lines are in NOTICE.
- The BSV pack's licence position is the one open item:
  - NOTICE says the pack "summarises public documentation, in our own words" and that unverified sources have "no text copied".
  - I could not verify "no text copied" for the 91 nodes above. It is an unprovable claim in a public NOTICE.
  - **Owner decision, not code:** either ship as is (low practical risk, since the pack is prose summaries), or soften the NOTICE sentence to "written in our own words from public documentation; licence status of some sources was not established", or remove or re-source the 91 nodes (needs a pack version bump).

## 3. Findings, ranked

### Bugs

**F1. Medium-high: the process matcher can kill an unrelated Electron app.**
`scripts/lib/legion-procs.ps1:18-24` (`Test-LegionRoot`). A root counts as Legion if it has `package.json` and either `dist\src\electron\main.js` or `src\electron\main.ts`. The `src\electron\main.ts` branch is a common layout in third-party Electron+TypeScript projects. Any such project that has its own `node_modules\electron\dist\electron.exe` running is matched and killed by PID (`-Force`) by the default `setup.cmd` path (no `-OnlyUnder`, `setup.ps1:89`). That includes a developer's other Electron project. The test cannot catch this because it stubs the root check.
- Fix: require the `package.json` `name` to equal `legion` (parse the JSON) in addition to one of the two paths, and require `dist\src\bin\legion-core.js` or `src\bin\legion-core.ts` to exist.
- Add a test with real temp directories and the real `Test-LegionRoot`.
- Until fixed, the README sentence "other Node or Electron programs are left alone" (`README.md:97`) is an overclaim, as is the SECURITY.md row "stops only Legion's own processes" (`SECURITY.md:54`).

**F2. Medium-high: `-Yes` and non-interactive setup mirror (`/MIR`) into any `-InstallDir` with no check.**
`scripts/setup.ps1:109`. Robocopy `/MIR` deletes everything in the destination that is not in the source. Nothing checks that the destination is empty or an existing Legion install. `-Yes` removes any chance to notice:
- `setup-yes.cmd -InstallDir "C:\Users\me\Documents"` purges that folder.
- `-InstallDir C:\` becomes `C:` after `TrimEnd('\')` (`setup.ps1:55`), which robocopy treats as the current directory on drive C.
- `-InstallDir "%USERPROFILE%\.legion"` would wipe the user data folder, because only the install-inside-source case is guarded (`setup.ps1:63`).
- The `/MIR` logic itself is not new in this diff, but the new unattended entry points are.
- Fix: before robocopy, refuse unless the destination is missing, empty, or contains a Legion marker (`package.json` with `name: legion`). Refuse drive roots, `$env:USERPROFILE`, the data dir and `LEGION_HOME`. Print the resolved path.
- Confirmed otherwise: `-Yes` itself deletes nothing extra. It only skips prompts, so the scope is the install dir plus processes.

**F3. Medium: the audit has factual errors.** See §1 (F3a, F3b). The verdict "no real secret" is still right, but the document is about to be public and should be corrected.

**F4. Medium: `setup-yes.cmd` closes the window on failure.**
`setup-yes.cmd:6-7`. Double-clicked, a failure (Node missing, `npm ci` fails) flashes and vanishes, with no message the user can read. This is the one case where a pause is wanted.
- Fix: reuse the `IsInputRedirected` test from `setup.cmd`. If not redirected and `%ERRORLEVEL% != 0`, `echo` the exit code and `pause`.

**F5. Medium (test gap, not a code bug): the Windows PowerShell 5.1 claim is untested.**
See §0. Add a `windows-latest` CI step that runs `powershell.exe -NoProfile -File scripts\setup.ps1 -DryRun -Yes -InstallDir "$env:RUNNER_TEMP\Legion x"` and the same for `uninstall.ps1 -DryRun`, plus a test that calls `Test-LegionRoot` and `Stop-LegionProcesses` on a throwaway `node.exe` child. In the test, change `findPowerShell()` to run both `powershell` and `pwsh` when present.

**F6. Low-medium: setup can kill its own caller.**
`SelfPid` excludes only the setup process (`setup.ps1:89`). If setup is run by an agent inside Legion (a Bash tool call), the Legion core or Electron process that is its ancestor is matched and killed, ending the update halfway.
- Fix: also exclude the ancestor chain (walk `ParentProcessId` from `$PID`).
- `Stop-Process -Force` gives no graceful close. Legion state written non-atomically could be cut off. Not tested.

**F7. Low: non-interactive setup without `-Yes` stops a running Legion silently.**
`setup.ps1:33` returns the default (`yes`) for "Stop it now?". The README says setup "asks before stopping" (`README.md:97`), which is true only on a console. It is by design but worth one clause: "unless input is redirected".
- The comment at `setup.ps1:26` says "or -NonInteractive", but only `[Console]::IsInputRedirected` is checked. Under `powershell -NonInteractive`, `Read-Host` throws and setup fails with a generic error.
- Fix: also treat `-not [Environment]::UserInteractive` as non-interactive.

**F8. Low: uninstall edges.**
- `scripts/uninstall.ps1:14-16`: if an older `uninstall.cmd` copies only `uninstall.ps1` to `%TEMP%\legion-uninstall.ps1`, the helper is missing. The dot-source fails outside the `try`, with a raw PowerShell error. Setup rewrites `uninstall.cmd`, so this affects only a partial update.
- The generated `uninstall.cmd` checks `if errorlevel 1` only after the second `copy` (`setup.ps1:183`), so a failed first copy is not caught.
- `%TEMP%\legion-uninstall` is left behind.
- `uninstall.ps1:25-29,78`: on an in-place install (setup run from a checkout), uninstall deletes the whole source checkout including `.git`. The marker `scripts\uninstall.ps1` matches any checkout.
- `uninstall.ps1:22,85`: `-Purge` deletes whatever `LEGION_HOME` points to, with no marker check. (Without `-Yes` the user must type `DELETE`.)

**F9. Low: the matcher fails safe, not always usefully.**
Verified with PowerShell 7 against crafted process objects. Spaces and case differences match correctly (`C:\Users\Zoe Orsted\Legion`, `c:\users\…\NODE_MODULES\Electron\DIST\ELECTRON.EXE`). A nested `node_modules\foo\node_modules\electron\dist` path gives the wrong root, and a sibling `C:\Legion2` is not under `C:\Legion`. False negatives happen for UNC paths, relative paths, 8.3 short names, junctions and subst drives. Legion itself launches core with an absolute path (`src/electron/main.ts:13`), so the normal case is covered. When a process is missed, setup stops later with "Is a file in … still open?", not a silent failure.

### Polish
- `scripts/setup.ps1:43-47` keeps a second path helper (`Test-Under`) next to `Test-PathUnder`; merge them.
- `Select-LegionProcesses` and `Stop-LegionProcesses` return `$null` for empty; callers wrap with `@()`, which is fine, but a comment would help.
- `setup.cmd` parses `%*` in `for %%A in (%*)`; an unquoted argument containing `)` or `&` would break the loop. Rare.
- README anchor check: `#later`, `#the-muster`, `#bsv-mode` resolve; the duplicate "BSV mode" section was removed correctly.
- NOTICE: point the SDK link at the same URL as the SDK's own `LICENSE.md`.

## 4. Documentation claims

- **"Claude-only" is stated plainly** at `README.md:19`. Codex and ChatGPT appear only once in README/SECURITY/NOTICE/docs, under "## Later" (`README.md:222`), flagged "not promised". Good.
- **Overclaim scan:** the full test suite includes `test/bsv-hedge.test.ts`, which passes. I found no "cannot be bypassed/forged/disabled" wording in the changed docs.
- **Spot-checked against code and found accurate:** `room_create`/`room_add_member`/`room_remove_member`; `botRoomDefaultBudgetUsd = 1`, `botRoomMaxBudgetUsd = 5`, `botRoomMaxMembers = 6` (`src/shared/config.ts:43`); Blender default port 9876; `claude.inheritClaudeCodeSettings` default true; the 10-minute approval timeout (`src/core/approvals.ts:67`); the NOTICE statement that no Blender component is in the repo.
- **Not verified:** the VM usage and cost-estimate paragraph, the Tables paragraph, and the Blender backend download behaviour (only the docs were read).
- **Overclaims to fix:** the two installer sentences under F1. The SECURITY row "Same-user processes" is conservative and accurate.
- **Honest hedges present:** installer unsigned, "no wide testing yet", BSV "not checked against a real wallet", MCP inheritance and room budget described as decided but not shipped.

## 5. Needs a real Windows PC

1. Run `setup.cmd` by double-click on Windows 10/11 with Windows PowerShell 5.1. Check the window stays open on success and on a forced failure, and check `setup-yes.cmd` on both.
2. Run `setup.cmd < nul` and `echo | setup.cmd` from cmd, and `cmd /c setup-yes.cmd` from Task Scheduler or a CI step with no console. Confirm `IsInputRedirected` gives the same answer in each.
3. Run setup with Legion running from (a) the install dir, (b) a source checkout on another drive, (c) an unrelated Electron app that has `src\electron\main.ts` (F1), and (d) VS Code and a `node` dev server open. Confirm only Legion's PIDs are listed and stopped.
4. Install to a path with spaces and non-ASCII characters, for example `C:\Users\Zoë Ørsted\Legion Test`. `%~dp0` goes through the OEM code page in cmd and may be garbled. Check setup, `uninstall.cmd` and the shortcuts.
5. Try `-InstallDir C:\`, a non-empty foreign folder, and `%USERPROFILE%` with `-DryRun` first (F2).
6. Uninstall: confirm that shortcuts pointing at another install are kept, that Desktop and Start menu entries go away (including a OneDrive-redirected Desktop), and that `%USERPROFILE%\.legion` is intact without `/purge`.
7. Confirm a downloaded ZIP of the repo (and a `git clone` on a machine with `core.autocrlf=input`) still gives CRLF `.cmd`/`.ps1` files, since the index stores LF.
8. SmartScreen and antivirus behaviour on the unsigned `.cmd` files.
9. A fresh `npm ci` on Windows plus `npm run build`, and launching from the shortcut with the real Electron binary.

## 6. Do before going public
1. Fix F1 and F2; add the real-directory tests (F5).
2. Correct the audit text (F3a, F3b). Decide the BSV-pack position (§2).
3. Add the pause on failure to `setup-yes.cmd` (F4).
4. Turn on GitHub secret scanning and push protection; optionally split the three test key vectors in the tests so no scanner matches the literal.
