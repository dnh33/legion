# Handoff: Blender title-bar pill (branch `claude/blender-chip`)

Written 2026-10-03 by the cloud agent that built it. Plain facts; nothing here was run on Windows.

## 1. Goal and owner decisions (quoted)

Task: "add a small Blender chip to Legion's title bar" because "Blender is only reachable deep in Settings, Blender: users can miss the Sculptor entirely." Rules given: label "comes ONLY from real status ... unknown or failed status shows 'Blender: unknown', never a stale or invented state"; the switch "goes through the SAME code path and rules as the Settings switch"; "when not found it offers 'Get Blender' which opens Settings, Blender (it must not start the download itself)"; tooltip "Blender scripts run on this computer with your rights; every script needs your OK"; no 'safe', 'secure', 'verified'; nothing in `src/core/*`.

Later owner decisions, in order:
1. "OWNER YES: add a confirmation before Blender is turned ON, on BOTH the chip switch and the Settings switch ... Title 'Turn on Blender?' ... Cancel (default) and 'Turn on Blender'. Turning Blender OFF needs no confirmation. Put the one shared function in ui/src/blender (requestEnableBlender())." Text: "Blender scripts run on this computer with your Windows user's rights, in a background Blender. Legion checks a script before it runs, but that check is a filter, not a sandbox, so read each script. Every script still needs your OK on its own card. A cloud VM is the isolated option."
2. Owner on the first design (a chip with two switches): "this header looks completely butchered ... two switches like that with zero indication of what it is ... ensure you're not using AI sloppy colors ... Aesthetics are important." Result: one pill + popover, app colours only (no own colour).
3. "doctor's color in lightmode needs a color fixing ... add a bitcoin icon for the BSV switch."
4. "there's still something about the distance between the two switches ... the green dot feels very random ... they should all have same height etc, consistency is important."
5. "where this 'connected' should be located ... just have 'connected' removed ... or give it a claude or LLM icon" -> presence dot on the logo. Owner: "This is great." (An AI/Claude icon instead of a dot was offered, not asked for.)

## 2. Exact state

Built, committed, pushed (HEAD at time of writing is the commit that adds this file; the last code commit is `c72a50e`):
1. Pure view-model `chipModel.ts` (state -> label/tone/title; unknown/failed/absent handled).
2. Pill `BlenderChip.tsx` (cube + status dot + word "Blender"; popover with status sentence, one labelled switch "Turn on the Blender bridge", button to Settings, Blender / "Get Blender" / "Set up in Settings"; word hidden below 1280 px).
3. Shared enable confirmation: `requestEnableBlender` / `cancelEnableBlender` / `confirmEnableBlender` in `blenderStore.ts`; dialog `EnableBlenderDialog.tsx` mounted in `App.tsx`; Settings checkbox calls `requestEnableBlender()` when ticking on, `saveBlenderConfig({enabled:false})` when off.
4. Store flags `failed` / `absent` (404 = older core without the module -> no pill); a successful save or action clears `failed`.
5. Header polish: Doctor badge softened in light theme, ₿ glyph on the BSV switch, all title-bar items in flow with a 4 px gap and the same 26 px pill height/padding, "Connected" text removed and replaced by a presence dot on the logo (green/amber blinking/red).
NOT done: nothing on the task list is open. Real-app (Windows) look is unverified (see 6).

## 3. Files (path: one line)

- `ui/src/blender/chipModel.ts`: pure model; holds `lightLabel` (moved here from `blenderStore.ts`, re-exported there), `BLENDER_CHIP_TIP`.
- `ui/src/blender/BlenderChip.tsx`: pill, exported `BlenderPopover`, outside-click/Escape handling, aria-live only for meaningful changes.
- `ui/src/blender/EnableBlenderDialog.tsx`, `ui/src/blender/enableCopy.ts`: dialog and its text (no imports so tests read it).
- `ui/src/blender/blenderStore.ts`: flags + the three enable functions.
- `ui/src/blender/blender.css`: pill/popover/dialog styles (app tokens only; avoid the literal "100%" in this file: the hedge scan flags it).
- `ui/src/components/Settings.tsx`: Blender checkbox now calls `requestEnableBlender()` (the only Settings change).
- `ui/src/components/TitleBar.tsx`: mounts `<BlenderChip />` after `<BsvChip />`; presence dot on the logo.
- `ui/src/components/icons.tsx`: `bitcoin` icon. `ui/src/bsv/BsvChip.tsx`: renders it. `ui/src/bsv/bsv.css`: removed the old narrow-width overlay trick; items flow. `ui/src/styles/app.css`: presence-dot rules, light Doctor badge.
- `ui/src/App.tsx`: mounts the dialog. `ui/src/blender/copy.ts`: unchanged in the end.
- Tests: `test/blender-chip.test.ts` (model table, unknown/absent, wording, real render with store spy via esbuild, source guards), `test/blender-enable-confirm.test.ts` (real store bundled; dialog render; both entry points; OFF needs no dialog), `test/blender-ui.test.ts` (one line: reads `lightLabel` from `chipModel.ts`).
- Docs: `docs/BLENDER.md` section "The title-bar chip"; `CHANGELOG.md` [Unreleased] > Blender; PC check **B17** in `claude/tracker-pc-checks.md`.
- Scratch (NOT in repo, in the agent scratchpad, gone with the session): Playwright screenshot scripts against `node ui/dev/mock-server.mjs` (port 47811) with `page.route('**/api/blender**')` returning a fake status. To re-create: launch Chromium (`/opt/pw-browsers`), route that URL to a `BlenderStatusView` JSON, set `data-theme` on `<html>`, screenshot the `.titlebar` at 1440/1000/960 px.

Mutations run (temporary, each reverted; each turned tests red): chip `else requestEnableBlender()` -> direct `saveBlenderConfig({enabled:true})` (3 red); Settings `if (e.target.checked) requestEnableBlender();` -> direct save (2 red); `requestEnableBlender` writes instead of opening dialog (3 red); `cancelEnableBlender` also saves (3 red); remove `data-autofocus` from Cancel (2 red); dialog `onClose` = confirm instead of cancel (2 red); earlier model mutations: drop `i.failed ||` (2 red), drop absent check (2 red), drop unknown-light check (1 red), `st.enabled ? st.light : 'off'` -> `st.light` (1 red), remove `disabled={m.switchDisabled}` (1 red). Re-run: edit, `npx tsc -p tsconfig.json`, `node --test dist/test/blender-chip.test.js dist/test/blender-enable-confirm.test.js`, revert.

## 4. Commands and last gate

`npm ci && npm run build:ts && node --test "dist/test/*.test.js" && npm run typecheck && npm run build:ui`. After deleting or renaming tests run `rm -rf dist` first: stale compiled tests failed 8 browser tests once.
Last full gate (before the final push, on `c72a50e`): 2223 tests, 2220 pass, 0 fail, 3 skipped; typecheck clean; build:ui clean. Known flakes seen: `vm-fixes-http.test` "VM fixes over HTTP" failed once under load and passed alone; also the documented ones (server "task archive / rename / delete", blender-local "dispose stops a running Blender"). The full suite takes a few minutes.

## 5. Merged into integration/v1?

In integration/v1 already (verified with `git merge-base --is-ancestor`): `65b4737` pill + popover and `c56fe25` (includes the enable confirmation, `c1dd626`). NOT in integration/v1: `b39d467` (Doctor light colour, ₿), `2794ced` (spacing), `c72a50e` (presence dot) and this handoff. Merge `origin/integration/v1` into the branch first; expect conflicts only if others touched `ui/src/bsv/bsv.css`, `ui/src/styles/app.css`, `TitleBar.tsx`, `claude/tracker-pc-checks.md` or `CHANGELOG.md`. No module list, bsv-scan allowlist or `src/core/*` file was touched.

## 6. Open bugs and unverified claims

- Nothing was looked at in the real Electron app on Windows (B17: keyboard order, both themes, dialog default button and Escape, widths 960/1000/1280/1440, Narrator). Screens were checked only in headless Chromium on Linux with a mock core.
- The `bsv.css` narrow-width change affects the BSV chip (it no longer overlays the old label space); only checked visually and by the existing tests.
- The pill hides "Blender" below 1280 px; the BSV switch has no word when off. Tooltips explain; this is a design choice, not tested with real users.
- The presence dot is only 12 px; the mock "offline" scenario was used, not a real dropped core.
- Settings checkbox flow is verified by source regex and the shared function, not by clicking it in a browser.
- `useSyncExternalStore` needs a `getServerSnapshot` shim in the esbuild test harness (already in the tests).

## 7. Looked up / not looked up

Nothing external was needed: all behaviour comes from this repo (`docs/BLENDER.md`, `src/shared/blender.ts` status fields, the BSV dialog in `ui/src/bsv/ChainOverlay.tsx`, `ui/src/components/Modal.tsx`). Not looked up: how Electron's title-bar drag region treats `title` tooltips on the logo dot (the dot wrapper has the `nodrag` class; unverified in Electron).

## 8. Next, in order

1. `git fetch`, merge `origin/integration/v1` into `claude/blender-chip`, run the gate (rm -rf dist first), push; open a PR or merge into integration/v1 as the orchestrator directs.
2. Owner (or computer-use) runs B17 on the Windows PC and records pass/fail in `claude/tracker-pc-checks.md`; only then drop "not yet looked at" wording in the CHANGELOG/docs.
3. If the owner wants it: swap the presence dot for a Claude/AI glyph, or reconsider showing a word on the BSV switch when off.
