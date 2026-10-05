# Legion Mod: build brief

This is the one shared context block for every agent working on the mod. Read it whole, then read `claude/plan-legion-mod.md`.

## Product

**What it is.** "Legion Mod for Claude Code" is a Claude Code plugin made of function hooks. It rebuilds the Legion desktop app's agent orchestration on Claude Code's own engine:

- 13 named agents
- threads
- approvals
- a shared Library (knowledge graph)
- later: rooms and a project board

There is no Legion core and no network.

**Who it is for.** People who run Claude in terminal windows and do not want a desktop app.

**The bar.** The owner wants the best version of this, not just a working one. Take deep care.

## Where things are

| What | Where |
|---|---|
| Worktree | `D:\bots\legion-mod`, branch `claude/legion-mod` |
| The mod | `mod/` |
| Desktop source | `src/` and `ui/` in the same worktree (read-only for you) |
| Mod API (the authority) | `mod/.claude/types/claude-code.d.ts`, 18k lines. Grep it; don't read it whole. |
| API long form | `C:/Users/Danie/AppData/Local/Temp/claude/bundled-skills/2.1.286/208140aba3a18a6c7b6a271d2c8b012f/plugin-authoring/reference.md` |
| API examples | the `examples/` folder beside `reference.md` |
| Contract | `mod/types/index.d.ts`: every shared domain type and every `$.state` value. Import types from it with `import type { ... } from '../../types/index.d.ts'`. |
| Theme | `mod/src/theme.ts`: desktop tokens, mood words, marks |
| Storage port | `mod/src/store/port.ts` |
| Desktop logic | `mod/vendor/legion/src/...`, byte copies of pure desktop files: router, model-cap, roster, kg text, briefing, capture, quota, types, and shared types. **Never edit them.** To change one, change the desktop source and re-run `node scripts/build-mod.mjs`; that is the lead's job. |

## Conventions (spike-proven 2026-10-05)

**Imports**
- Relative imports use the `.ts` extension: `import { x } from './y.ts'`.
- This works in the engine, in `claude plugin test`, and in Node.

**Node specs, for pure logic**
- Location: `mod/test/node/**/*.spec.ts`. Test files use `.spec.ts`.
- Run from the worktree:
  ```
  node --experimental-transform-types --no-warnings --test "mod/test/node/**/*.spec.ts"
  ```
- Your own runs target only your own files.
- Use `node:test` and `node:assert/strict`.

**Plugin tests, for hooks and drawing**
- Location: `mod/test/plugin/**/*.test.tsx`. Test files use `.test.tsx`.
- Run: `claude plugin test mod`.
- Import `test`, `expect`, `mock` from `claude-code/testing`.
- Hooks a test registers sit **beneath** the plugin. So a test can feed the plugin's `$.state` reads by hooking `state.get` with a matcher on `{ plugin: 'legion-mod', key }`. Check the result shape in the d.ts.
- Loop UI tests over `['terminal', 'desktop'] as const`.

**Runtime limits**
- No Node at run time inside the mod (no `node:*`), no DOM, no `setTimeout`. Use `$.clock`.
- Globals you can use: `crypto.randomUUID`, `crypto.subtle.digest`, `TextEncoder`/`TextDecoder`, `URL`, `structuredClone`, `performance.now`.
- **Banned at run time: `$.process` and `$.http`.** The mod makes no network calls and starts no programs, and a gate checks this.

**JSX**
- The factory is `h`.
- Elements come from `$.ui.resolve(e)` (terminal: `Box, Text, Button, Input, Select, Link, Code, Markdown, Client, Raster, Image`).
- A prop outside an element's allowlist makes the whole tree refused.

**Passing `$`** (validator rule, spike-proven)
- `$` may be passed only to a function declared at the top of the **same file**: a function declaration, or a const bound to one.
- Always spell it `$.noun.method(...)`.
- Never pass `$` or `$.fs` as a value to an imported function. Build plain objects from closures inside a hook instead, e.g. `{ read: p => $.fs.read(p) }`.
- `read`, `update` and `atom` from `'claude-code'` are fine.
- **A top-level function that takes `$` must be reachable from a hook.** A dead or not-yet-called helper that writes state fails validation with a misleading message: "the const X ... is also written through, handed on or exported here". Delete it, or call it, before validating.
- **A state reference const is only ever a reference.** Never export it, and never also use it as a hook matcher. Give the matcher its own const.
- **Register hooks with literal matchers.** `on('command.run', { command: 'to' }, …)`: inside a loop, validate lists the command as `?`.

**State**
- References use literal `plugin` and `key` values: `{ plugin: 'legion-mod', key: 'tasks' } as const`.
- Use `atom`, `read`, `update` from `'claude-code'`.
- Never write state while drawing.

## Art direction and voice (Legion as of 0.2.5-a)

**Colours**
- Desktop tokens only, from `src/theme.ts`.
- Accent `#7CFFB2` means "alive and yours". It is never danger.
- Warn `#FFCC66`. Danger `#FF6B6B`.

**Hierarchy**
- Use weight, dim, accent and space. No other means.
- Numbers are right-aligned in fixed columns, so nothing jitters.
- No ALL-CAPS except the `LEGION` wordmark.

**Glyphs**
- Roster glyphs: ✠ Zealot, ⌘ Builder, ◎ Scout, ⌕ Inquisitor, ✎ Scribe, ▤ Archivist, ◬ Sentinel, ⌶ Forgemaster, ☾ Exorcist, ⊥ Preceptor, ⚑ Herald, ⊜ Assayer (hidden: it needs BSV, which the mod leaves out), ◈ Sculptor.
- Marks come from `theme.ts` `MARK`.

**Words**
- Plain words for state: "Needs your OK · Bash", "Paused at the turn limit", "Continued where it stopped".
- Mood words exactly as `MOOD_WORDS`.
- Character only in mascot quips, read from `ui/src/mascot/personas/*.json` and never rewritten, and in empty states.
- Every disabled action says why. Every failure gives a next step.
- No AI-isms (delve, seamless, elevate...). No exclamation marks.

**Motion**
- Calm: 1.8 s minimum mood dwell.
- At most two things move. Everything stills after 60 s with no events.
- `settings.motion === false` freezes everything.

**Mascot art is untouchable**
- Never redraw or alter the painted art.
- The 2D Order (later phase) derives frames by machine only.

## Hard rules

- **Never commit.** The lead commits.
- Never run `npm ci`, `npm test` or `npm run build` at the repo level. Gates run one at a time, by the lead.
- Edit only the files you own (below).
- **Shared files belong to the lead:** `mod/types/index.d.ts`, `mod/src/theme.ts`, `mod/src/store/port.ts`, `mod/hooks/register.tsx`, `mod/vendor/**`, `scripts/**`, `test/**` at the repo root.
  - If you need a change to one, put the exact code you want in your report.
  - If you are blocked without it, write a local shim in your own folder and say so.
- No BSV code, no network, no processes, no secrets.
- Claims in comments and copy are scoped ("Legion's own code ..."), never absolute.
- Desktop parity: when you port a rule, cite the desktop file and line in a comment, and keep its constants equal.

## Ownership

| Workstream | Owns |
|---|---|
| Store | `mod/src/store/**` (except `port.ts`), `mod/test/node/store/**` |
| Engine | `mod/src/engine/**`, `mod/test/node/engine/**` |
| UI | `mod/src/ui/**`, `mod/test/node/ui/**`, `mod/test/plugin/**` |
| Lead | everything else, plus the wiring in `register.tsx` |

## QA gate G1: every workstream, before you report

Strict enough to catch real defects. Not so strict that it blocks on nitpicks.

1. **Typecheck clean:**
   ```
   node D:/bots/legion/node_modules/typescript/bin/tsc -p mod/tsconfig.json
   ```
2. **Your specs pass.** Report exact counts.
3. **Every new test has a negative.** Make a temporary scratch mutation of the code under test, show that the test fails, then revert. List each mutation and its failing output, in one line each, in your report.
4. **`claude plugin validate mod` passes** and lists no `process.*` or `http.*` calls.
5. **Self-review against the kodawari checklist**, as it applies to your area:
   - empty, long, max and error states;
   - widths 60 / 80 / 100 / 120 / 200;
   - dark and light;
   - no silently swallowed errors.
6. **Report:**
   - files written;
   - test counts;
   - negatives;
   - requested shared-file changes (as code);
   - open questions;
   - what is still imperfect.

   Bugs and polish go in separate lists.

**Gates after G1:**

| Gate | Who | What |
|---|---|---|
| G2 | the lead, at merge | full mod gate, plus the repo vendor-parity test |
| G3 | an independent reviewer, at the phase end | default verdict "not fixed"; re-runs everything and tries to refute it |
| Visual | real terminal | kodawari visual pass in a real terminal, recorded as a real-PC check |
