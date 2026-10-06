# Spec: "The Legion is taking over Claude" (takeover art, splash, title-bar egg, README, the Ŧ mark)

Status: approved by the owner and built (2026-10-06), uncommitted. Deviations from the first draft are in section 11. Reference prototype, approved by the owner:
[docs/art/takeover-prototype.html](../docs/art/takeover-prototype.html).

## 1. Goal

Show, in a memetic way, that the Legion is taking over Claude: Claude Code's orange critter glitches and is converted, right to
left, into the Legion great helm in the style of the app icon (`assets/icon.ico`). The same art and one mark (`Ŧ`) carry the
joke into the boot splash, a title-bar easter egg, the README/social image and, as one quiet line, into Claude Code itself.

Success: the owner reads the splash and the README GIF as "insane"; the mark renders in the owner's terminal and in the Claude
Code desktop app; nothing adds boot time; nothing in Claude Code's model-facing text changes except one short tag line.

## 2. Decisions (owner, 2026-10-06)

| Decision | Source |
|---|---|
| The start frame looks like the normal Claude Code critter, then transforms into the Legion helm | owner, in chat |
| The converted state follows the app icon: steel great helm, green T-visor with bright eye squares, gold laurels and circuits, red plume, binary ring halo | owner ("look more like the attached image"), `assets/icon.ico` |
| Glitch: row slices with red/cyan ghosts, a torn seam, block-character text corruption | owner ("add some glitch") |
| Copy: "THE LEGION IS TAKING OVER CLAUDE" while converting, "THE LEGION HAS TAKEN CLAUDE" after | owner |
| The terminal panel look (dark panel, mono, blinking cursor, "The Order has the terminal.") stays | owner ("we want to keep that") |
| Mark: `Ŧ` (U+0166), a single glyph | owner; renders in all 7 fonts tested (section 6) |
| In Claude Code: a separate last result line, not tool titles (titles are not shown in the tool-call line) | owner; research in section 6 |
| Placements: splash, title-bar egg, README/social; Claude Code via the tag line | owner |

Risks the owner chose to accept, recorded so nobody re-asks:
- **Trademark.** The critter is Anthropic's brand element. Its trademark guidelines (https://www.anthropic.com/legal/trademark-guidelines) and the Claude Code legal page (https://code.claude.com/docs/en/legal-and-compliance) restrict using its logos and brand elements. The critter appears only as the "before" frames and is converted every time; it is never Legion's mascot. Section 7 lists the mitigations.
- **"Takeover" optics.** In a security-minded app, "taking over" can read as malware. Mitigation: the README says plainly that Legion is an independent app and does not modify Claude Code. The Claude Code tag line carries no takeover wording and no instructions.

## 3. Components

### 3.1 One art source: `src/shared/takeover-art.ts` (new)
- Pixel rows for the critter (18x10) and the helm (26x24), the palette, the binary-ring generator, and two timelines:
  - `full`: the prototype loop, 110 ms ticks: idle 16, flicker 8, sweep 44, hold 22 (about 10 s).
  - `boot`: compressed, about 1.4 s: critter 250 ms, flicker 150 ms, sweep 800 ms, lands about 1.2 s.
- Pure data and pure functions only (frame at tick t, seed for the glitch): no DOM. Every placement renders from it, so the busts, the splash and the GIF cannot drift apart.
- The glitch takes a seeded random, so tests and the GIF are deterministic.

### 3.2 Boot splash (`assets/splash.html`)
- The splash already holds at least 1200 ms (`src/electron/main.ts`, `boot()`), then fades 450 ms. The `boot` timeline fits inside that floor: **it never adds time**.
- A slow core: the converted helm holds and the binary ring's bits scroll, until the existing fade.
- The text lines keep their meaning (the real boot steps); the headline line above them shows the takeover copy.
- `splash.html` is a static file, so it gets the frames as an inline JSON block written by `scripts/copy-static.mjs` from `takeover-art.ts` at build time (no hand copy).
- `prefers-reduced-motion`: one still frame (fully converted), no glitch; also stop the splash's existing endless pulse, caret and sweep bar, which today have no reduced-motion rule.
- Error path: the still helm, no loop.

### 3.3 Title-bar easter egg (`ui/src/components/TitleBar.tsx`, new `ui/src/mascot/Takeover.tsx` + `takeover.css`)
- Trigger: three clicks on the title-bar glyph within 1.5 s, or the command-palette entry "Deus vult" (keyboard path).
- The glyph sits in the window drag region today, so it must become a `nodrag` button with `aria-label`.
- Plays the `full` timeline once in a small overlay under the title bar, then fades. 30 s cooldown. Skipped while the window is in the background.
- `pointer-events: none` and `aria-hidden` on the overlay; reduced motion shows the still for 2 s.
- It never touches the painted busts or the Relic files (their golden hashes in `test/mascot.test.ts` stay as they are).

### 3.4 README hero and social GIF (dev script, not shipped)
- New `ui/dev/shots-rig/takeover-gif.mjs` renders the `full` timeline to PNG frames (seeded), then a GIF and a still at 50 %.
- GIF encoding needs a tool: proposal `npm i --no-save gifenc` in the rig, like the rig already does with `playwright-core`. No new dependency in `package.json`.
- README: the GIF, plus the existing "independent, not affiliated with or endorsed by Anthropic" line, plus "Legion does not modify Claude Code."

### 3.5 The mark in Claude Code (`src/core/mcp-tools.ts`)
- `legion_run`, `legion_continue` and `legion_status` results get a **second, last text block**: `Ŧ LEGION · <state>`, where state is `sworn · running`, `sworn · done`, `sworn · fault`, `sworn · awaiting your word` or `sworn · cancelled`.
- `content[0]` (the JSON or the error text) is untouched; existing tests read `content[0].text`.
- No change to tool descriptions, titles, or server instructions (they are model-facing and cost tokens in every session).
- The tag has no imperative and no second person, and is at most 48 characters. It costs about 6 tokens per call.
- The same mark replaces ⛨ wherever the UI or docs would show it.

## 4. Data flow

`takeover-art.ts` (rows, palette, timelines) feeds three renderers:
- `copy-static.mjs` writes the frames into `splash.html`, which plays the `boot` timeline.
- `Takeover.tsx` plays the `full` timeline in the title-bar egg.
- `takeover-gif.mjs` renders the `full` timeline to the README GIF.

`mcp-tools.ts` appends the tag line from the task's status; it does not use the art.

## 5. Error handling

- Missing frames in `splash.html` (a build without the step): the splash shows today's look. Never a blank window.
- Any exception in the egg is caught and the egg is skipped. The title bar works as before.
- The tag line is built from status only; if status is unknown, no tag is added.

## 6. Research (documented fact / assumption / unknown)

| Item | Status | Evidence or check |
|---|---|---|
| ⛨ U+26E8 in the owner's terminal font | **Fact: missing** | Glyph-map check on this PC: CaskaydiaCove NF, Cascadia Code, Cascadia Mono, Consolas, Lucida Console, Courier New, Segoe UI: none has it. Only Segoe UI Symbol does (advance width 1.02 em, wider than a cell) |
| `Ŧ` U+0166 in those fonts | **Fact: present in all 7** | Same check |
| Claude Code shows MCP tool `title` in the tool-call line | **Not shown** (undocumented; docs show `mcp__server__tool`) | https://code.claude.com/docs/en/mcp ; open feature request #37542 "Render MCP tool title field in /mcp tool list and tool call headers" |
| A second text block in a tool result is visible in Claude Code | Assumption | Real-PC check TK-3 |
| `Ŧ` renders in Windows Terminal and the Claude Code desktop app | Assumption (font has the glyph) | Real-PC check TK-2 |
| The critter sprite is close enough to read, but not a pixel copy | Unknown (drawn from memory) | Real-PC check TK-4: side by side with Claude Code's banner |

## 7. Guardrails

- The critter is only the "before" state and is always converted; Legion's mascot is the helm.
- The critter is redrawn by hand in Legion's palette, never traced or extracted from Claude Code's binary or assets.
- No "Claude", "Claude Code" or "Anthropic" in a file, asset or feature name; plain factual mentions only.
- No added boot time; reduced motion honoured everywhere.
- The painted busts, the Relic and their hashes are untouched.
- No new runtime dependency.

## 8. Testing

- `test/takeover-art.test.ts`: frame 0 is the critter, the last frame is the full helm; the `boot` timeline lands within 1200 ms; same seed gives the same frames. Negative: shorten the hold or change the seed handling and see red.
- `test/takeover-splash.test.ts`: the frames inlined in the built `splash.html` equal `takeover-art.ts` (drift guard). Negative: edit one row.
- `test/mcp-tag.test.ts`:
  - `content[0]` still parses for `legion_run`/`legion_status`, and the tag is the last block.
  - The tag is at most 48 characters and contains no "you", "please", "must" or "ignore".
  - The read-only listings have no tag.
  - Negative: put the tag first.
- Gate: `npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui`, with exact counts.
- Real-PC checks, appended to `claude/tracker-pc-checks.md`:
  - **TK-1:** the splash plays on a real launch and the window opens no later than today.
  - **TK-2:** `Ŧ` is visible and single-width in Windows Terminal (CaskaydiaCove NF) and in the Claude Code desktop app.
  - **TK-3:** the tag line is visible after a `legion_run` from Claude Code.
  - **TK-4:** the critter side by side with the real Claude Code banner.

## 9. Out of scope

Repainting any bust; a new mascot for the Relic; theme text in MCP descriptions or instructions; sound; anything in `mod/`
(the Legion Mod worktree has its own art plans).

## 10. Order of work

1. `takeover-art.ts` and its test.
2. The splash.
3. The MCP tag line.
4. The title-bar egg.
5. The README GIF (needs `gifenc` in the rig, no-save).

Each step passes the gate on its own.

## 11. As built (2026-10-06): deviations from the draft

- **No tag on `legion_status`.** Its whole answer is one JSON block, and the existing test (like any client that joins text
  blocks) parses all the text blocks joined together. The tag is on `legion_run` (with or without wait) and `legion_continue`
  only. States: running, done, fault, cancelled ("awaiting your word" is not a task status, so it is not used).
- **The splash gets its art from a generator, not from `copy-static.mjs`.** `assets/splash.html` is loaded from `assets/`
  (not `dist/`), so `node scripts/gen-splash-art.mjs` bundles `takeover-art.ts` with esbuild (present through vite) into
  an inline block between two markers. The output is committed with the splash, and `test/takeover-splash.test.ts`
  re-bundles it and fails if the splash is stale.
- **No `gifenc` download.** `ui/dev/shots-rig/takeover-gif.mjs` rasterises the pixel grid itself and has its own encoders
  for GIF (LZW) and PNG (built-in zlib). It writes `docs/images/legion-takeover.gif` (90 frames, 380x360, loops) and
  `legion-takeover.png` (the still).
- **The splash's Zealot image is replaced by the takeover stage.** `assets/zealot.svg` itself is unchanged.
