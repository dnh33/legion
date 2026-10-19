# Task 5 + Task 26 part A report

Base 3c2e2657, commit 54918446 (no trailer). Final: 159/159 pass (gates-ipc, gates-registry, gates-routes, gate-parity, bsv-review-tripwire, gates-sign); `npm run typecheck` clean (ts + ui).

## Failing counts first
Not captured as numbers. I wrote `test/gates-ipc.test.ts` and the registry tests before any code; the first `build:ts` failed to compile on the missing `gates-ipc.js` and the missing registry exports, which is the red state. The route tests I added pass at once because Task 4 had already put the native header on the routes (see Deviations). One route test failed on my own regex (`"sig":` vs pretty-printed `"sig": `) and was fixed in the test.

## Files
- Create `src/electron/gates-ipc.ts`: `parseGatesChange`, `gatesChange`, `bypassDetail`, types `GatesChange`, `GatePatch`, `GatesIpcDeps`.
- Modify `src/electron/main.ts` (`legion:gates-change` handler with the same senderFrame/trustedSender checks; `ownCoreCall` accepts `PATCH`), `src/electron/preload.cjs` (`gatesChange`), `ui/src/api.ts` (type).
- Modify `src/shared/gates-registry.ts`: `PERMISSION_GATE_IDS`, `PRESET_LINES`, `NO_SANDBOX_LINE`.
- Tests: new `test/gates-ipc.test.ts` (18 tests); appended to `test/gates-registry.test.ts` (2) and `test/gates-routes.test.ts` (2; `boot()` now returns `base`).

## Behaviour
- The window names a change; main parses strictly (unknown keys, non-permission gate ids, `shellFloorOff`, limits outside 1..100 are refused before any dialog or call), reads `GET /api/gates/settings` and the project name from the core, words the dialog, and calls the core with the native header only after Confirm.
- Tightening (Ask, Bypass to Smart, per agent) shows no dialog and sends no native header. Smart <-> Accept edits is a loosening (same order as the core).
- The core stays the authority: if it answers 403 `native_confirmation_required` to a change the wording logic took for a tightening, a generic confirm is shown and the change is retried with the secret. This avoids copying the store's `looserThan` into Electron.
- `accept` always asks and only for a name in `changedOutside`; `keep` needs no dialog.
- No key (`canSign:false`): a loosening is refused before any dialog with "Your computer has no safe keystore, so only Ask can be used."; `keyUnreadable` gets its own line.
- One dialog at a time (module flag held for the whole call). Every one of the three preset texts carries "deny rules", "safety rails" and `NO_SANDBOX_LINE`. No em dash, "your computer".

## Deviations
1. Routes and `requireNative` were already done by Task 4 (`92ffd23c`) and Task 3 fix round 2; I built on them and only added two route tests (bearer token on all six routes incl. accept/keep; signed file after a native PATCH).
2. No `ensureKey` and no core restart in `gatesChange`: since Task 4 main creates the gates key at every launch (`ensureGatesKey`, `main.ts:178`), independent of GitHub (ruling I5). So the brief's "first loosening with no key" flow collapses to the refusal message.
3. Deps are `call(method, route, body, native)` and `confirm({title,message,detail,confirmLabel}): Promise<boolean>` (preflight F11), not `showDialog`/`core`. Cancel is the default button via the existing `makeConfirm`, so the brief's `defaultId` test is covered by that, not re-tested here.
4. Shell-floor dialog, second click, title-bar marker, `legion:shell-floor`: not built (Strike). One test proves a `shellFloorOff` patch is refused with no dialog and no call.
5. `GatesChange` is written as separate `accept` and `keep` members (same shape as the interface) so TypeScript can narrow.
6. Dialog titles for Smart and Bypass are mine (the brief only gave Accept edits): "Let Legion decide when to ask?", "Turn off permission cards?".
7. No CHANGELOG line (the brief's commit list excludes it); needed at PR level.

## Precedent
Read `D:/bots/plans-033/gates-reference-map.md` Task 5 and Task 26. Reference code in `D:/bots/_ref` was NOT reopened this pass; the map's cites were used as given: Codex `tui/src/onboarding/trust_directory.rs:251` (trust is a user keypress, not a file edit), Grok `folder_trust.rs` and its decline-writes-nothing pty tests (I copied the checklist: cancel makes no write, tested), Hermes `approval_yolo.py:31` (yolo toggled by the user command), Claude Code bypass warning dialog (confirm lives outside what an agent can write). Differences: Legion confirms every single loosening, and the secret check is in the core (native header) so a compromised window cannot skip the dialog. In-repo precedent followed: `provider-ipc.ts` (`makeConfirm`, `dialogLine`, open flag) and `project-ipc.ts` (strict parse, facts from the core). Task 26: Claude Code docs, Hermes, Codex per map row 41 (not reopened).

## Concerns
- Part B of Task 26 (`PAGE_NOTES`, `GatesSection.tsx`) is Task 12's; not done here.
- Over-confirming is possible only for an override change that is a tightening in practice (override false where the preset already has it off): the dialog shows although the core would not require it. Safe direction.
- `ensureGatesKey` runs at each launch, so a macOS Keychain prompt at first launch stays (Task 4 note).
- Not run: Electron (per the brief), so the handler and preload wiring are checked by typecheck only.
- Working copies of `main.ts`, `preload.cjs`, `api.ts`, `gates-routes.test.ts` are CRLF; git warns it will normalise to LF (index is LF). Diff is clean.

## Drift check
Stayed inside Task 5 + 26A. No owner data read or listed, no Electron started, no process left running, no stash, no push, no subagents. Context well under 150k.

## Fix round 1

Commit: see `git log` ("gates: the dialog shows exactly what the core will change; a different change is refused"). Result: 247/247 (gates-ipc, gates-routes, gates-registry, gate-parity, bsv-review-tripwire, gates-sign x3, gates-settings, gates-store, gates-ui); `npm run typecheck` clean. 22 of the new or rewritten tests fail on 54918446 (reverse-applied the src diff, saw them fail, re-applied).

- C1, I1: the Electron-side loosening guess (`askForPatch`, `looser`, the generic retry dialog) is gone. The core's `describeChange` (store.ts) is the one place that decides what a loosening is; `looserThan` is now "has a loosening line". It compares the whole result: preset (incl. Smart <-> Accept edits), limit, the project cap (Per agent has its own line), every permission gate (a dropped override counts; a limit raise and "limit removed" have lines), `allowedHosts`, `envKeep`.
- New `POST /api/gates/preview` (admin): body `{name, patch}` or `{name, accept: true}`; returns `{lines, loosening, loosens, digest}`. `lines` has the loosening and tightening sentences, `loosening` is the loosening subset (what the dialog shows, with the deny-rules line and, when commands run with fewer questions, the no-sandbox line). Digest = sha256 of name + canonical full result.
- Electron `gatesChange`: preview, dialog text = `loosening` joined (Cancel default), then PATCH/POST with native header and `x-legion-gates-digest`. A tightening sends the digest too. Preview that cannot be read gives "Legion could not describe this change, so it was not made."
- Core: a loosening PATCH or any Accept without a digest, or with one that differs from what the core would apply now, gets 409 "The change differs from what you confirmed". A digest sent with a non-loosening change is checked too.
- I2: `allowedHosts` and `envKeep` pass the IPC parse (app scope only, shape and size checked; the core checks the names) and have lines.
- I3: Accept previews the pending file's settings against the current ones; the digest binds the file content, so a file swapped and reloaded during the dialog is refused (test).
- I4: tests run the real store and routes over HTTP; the dialog is asserted equal to the core's lines for each loosening kind; C1 probe and limit-raise probe; digest mismatch for patch and accept; confirm fake records the text.
- M1 (sandbox line for tool-cards, module-cards, limit off, Per agent), M2 (test replaced), M3 (source-shape test for the handler and the extra-header plumbing), M5 (message says `the project "X"` or `all projects`) done.
- Not done: M4 (cool-down after Cancel). A native change always needs a digest now, so the routes tests send one through a small `confirmed()` helper that asks the preview first, as the app does.

Precedent: re-read `D:/bots/_ref` is not needed for this round; the design is the controller's. Same ideas as Grok `folder_trust.rs:80` (do not act on content that can change after the check: here the digest binds the exact result) and Codex `trust_directory.rs` (explicit user action after the prompt is visible; Cancel default). Different: neither binds the confirmed content to the write; Legion does, in the core.

Drift check: stayed inside Task 5 fix round 1. No owner data read, no Electron started, no process left running, no stash, no push, no subagents.

## Fix round 2

Commit: see `git log` ("gates: every loosened gate is named; Bypass lists what it changes; digest binds the start"). Result: 257/257 (gate-parity, bsv-review-tripwire, gates-routes, gates-sign x3, gates-ipc, gates-store, gates-describe, gates-settings, gates-registry, gates-ui); `npm run typecheck` clean. The new store tests (property, N1 to N4) fail on 774e498d (src diff reverse-applied, seen failing, re-applied); the new ipc tests (N5, M4) cannot even compile there.

- N1, I4: the "preset line already says it" skip in `describeChange` is gone. Every permission gate whose effective value loosens gets its own line, whatever caused it (preset, override, dropped override). New `test/gates-describe.test.ts`: a seeded generator (mulberry32, no dependency), 2200 random (before, patch) pairs over every registry gate, an oracle written in the test, not imported. Asserts every loosened gate is named and a change with no loosening has no loosening line and `loosens:false`; it also checks the generator covers both sides.
- N2: Bypass lists each consequence from the per-gate comparison (cards, Allow undo, update consent, retry 4 to 8, goal 12 to 24, proposals, your ask rules), under the preset headline. No fixed string for them.
- N3: digest = sha256 of name, canonical before, canonical next and, for a project, the canonical app settings.
- N4: `parseOverrides` (strict) refuses `{on, limit}` on a gate without a limit with a 400 "has no limit"; the IPC parse refuses it too (new `LIMIT_GATE_IDS` in the registry). A file read from disk with such a value reads as plain on/off (signature still checks the raw file). Limit wording is now only reachable for gates with limits.
- N5: titles per change: "Let agents do more without asking?" (presets, gates, mixed), "Allow these sites?", "Keep these variables?", "Raise these limits?" (overrides only, every line is a limit gate). More than 12 change lines show the first 10 and "and N more (see the Gates page)"; the closing deny-rules and no-sandbox lines are not counted and never cut. Kept variables are listed before sites. `DENY_LINE` moved to the shared registry.
- M4: after Cancel the same change (name + digest) is refused quietly for 3 seconds ("You cancelled this change a moment ago..."), no dialog. A different change is not held back. `GatesIpcDeps.now` is optional (tests drive the clock); the existing "second change while a dialog is open" test now retries with a different change.

Precedent: no new reference code was opened this round; ideas are the controller's rulings. Same principle as round 1 (Grok `folder_trust.rs:80`, Codex `trust_directory.rs`): the confirmed content is what is applied. Different: the digest now also binds the start state, so a tightening that lands during the dialog refuses the confirm instead of widening the change. Searching the clones for a dialog pause after Cancel: not done; the 3 s value is the controller's.

Drift check: stayed inside Task 5 fix round 2. No owner data read, no Electron started, no process left running, no stash, no push, no subagents.
