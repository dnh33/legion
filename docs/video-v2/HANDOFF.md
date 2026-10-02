# Trailer v2: handoff for the next agent

Read this first, then `BRIEF.md` (plan, fact table), `AUDIT.md` (state, known flaws), `claude/release-facts-0.2.0.md` (source of truth; re-read it before every render, it changes), `claude/skills/cinematic-trailer-pipeline/SKILL.md` (the method). Hard rules in `CLAUDE.md` apply (no keys, no real wallet port, mascot art untouchable, no invented claims).

## 1. What exists
| Path | What it is |
|---|---|
| `timeline.mjs` | single source of truth: every time (`b(bar,beat)`, 96 BPM, bar 2.5 s), `S` scene bars, `SHOTS` (screenshot, in/out, camera keys, rings), `CAPS` (captions), `CHIPS` (honesty chips), `NEXT_CARDS`, `CUTS`, `LOG` (terminal), `T` (relic keys, states, end card), `GIF_SEGMENTS`, `cues()` |
| `trailer.html` | the composition; exposes `window.render(t)`; imports `timeline.mjs`, the real mascot engine (`ui/src/mascot/engine.js`) and the real bust data |
| `render.mjs` | deterministic renderer: `--keys`, `--t=a,b`, `--encode-gif`, or no flag for MP4+GIF+poster. Writes `cues.json`, runs `score.py`, muxes at -14 LUFS |
| `check.mjs` | editing and honesty rules; run after EVERY timeline edit (`node docs/video-v2/check.mjs`, must print no FAIL/SHORT) |
| `score.py` / `cues.json` | the original synthesized score; reads `cues.json` (regenerate it from the timeline before running) |
| `shots/` + `shots/MANIFEST.md` | the real UI screenshots, how each was seeded, what could not be captured |
| `capture/` | `stack.mjs` (real core + fakes + same-origin proxy), `seed.mjs`, `capture.mjs`, `board-capture.mjs` |
| `legion-trailer-v2.mp4` (26 MB, crf 25), `.gif`, `poster-v2.png` | the first cut |

## 2. Rebuild everything
```
npm ci && npm run build:ts && npm run build:ui
pip install numpy scipy                      # score (python3)
export PLAYWRIGHT_PATH=<folder of a playwright package>   # or npm i --no-save playwright; Chromium via PLAYWRIGHT_BROWSERS_PATH
node docs/video-v2/check.mjs
node -e "import('./docs/video-v2/timeline.mjs').then(m=>require('fs').writeFileSync('docs/video-v2/cues.json',JSON.stringify(m.cues(),null,1)))"
WORKERS=4 node docs/video-v2/render.mjs      # ~25 min on 4 cores: 3150 frames; writes mp4 (53 MB), gif, poster
```
Quick look without a full render: `node docs/video-v2/render.mjs --keys` (about 2 min) or `--t=40,41.5`. Contact sheet: `ffmpeg -i f.mp4 -vf "fps=1/3.3,scale=480:-1,tile=4x4" s%d.png`. GIF over budget: `GIF_COLORS=64 GIF_DITHER=bayer:bayer_scale=4 node docs/video-v2/render.mjs --encode-gif` (reuses `$TMP/gif` frames; no gifsicle here). Committed MP4 is `ffmpeg -c:v libx264 -preset medium -crf 25 -maxrate 2200k -bufsize 4400k -c:a aac -b:a 128k -movflags +faststart` of the render (the full render is above the 40 MB commit limit). After the render, measure: `ffmpeg -i x.mp4 -af ebur128=peak=true -f null -` (got -13.3 LUFS, TP -1.5).
To re-capture screenshots: `PLAYWRIGHT_PATH=... PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node docs/video-v2/capture/capture.mjs [shot ...]` after the builds; board shots need a tree that has the board (`board-capture.mjs`, built from a scratch worktree of `origin/claude/project-board`, never from this branch).

## 3. How it was made (the method that gave this quality)
1. Brief and fact table before anything (BRIEF.md); the orchestrator verified it, then said GO. Every on-screen sentence has a row; status words SHIPS / BUILT-NOT-TRIED / PLANNED come from the facts file, not from the README (the README was older and wrong in places).
2. Timeline on a beat grid, scene changes on bar lines, every change a `CUTS` entry (hard / dissolve / match), black only at the first and last frame, one anchor (the Relic, bottom-right beside every UI shot, moving on screen between homes).
3. Screenshots are the real built UI (`dist-ui`) talking to a real Legion core with the repo's own fakes (fake model, fake boat.dev, fake wallet, fake Blender). `capture/stack.mjs` spawns `scripts/harness/core-entry.mjs` like the harness does, keeps the admin and native secrets in memory only, serves `dist-ui` plus a same-origin proxy that strips Origin/Sec-Fetch headers (the core's net guard refuses cross-origin pages), and injects `window.legion` like Electron's preload so buttons render. Demo data is seeded through the real HTTP API and fake-model scripts. Read each PNG at full size; reshoot empty states, spinners, temp paths.
4. Layout: UI frame left (1280x800 inner, gold frame), copy column right (x 1400, kicker + 54 px Grenze caption + honesty chip at y 540), Relic bottom right. Cameras push into the exact region a caption names (`cam` keys are zoom + centre as fractions of the image; clamp: centre must stay within `0.5/zoom` of an edge or the frame shows blank). Rings (`marks`) sit on real UI elements. Non-1.6 images (the update panel) are letterboxed automatically.
5. The muster uses the 12 real painted busts through `createMascot(rail:true)` plus the Relic itself moving into Zealot's slot. Art untouched.
6. Determinism: no wall-clock. `window.render(t)` sets everything; CSS animations are seeked per frame; the mascot engine's own timers are neutralised at creation (`setTimeout` stub) and blinks are driven from `t`; seeded PRNG for embers and grain.
7. Reviews: key frames at full size, contact sheets, cut frames, measured sound. `check.mjs` encodes the rules so they cannot regress. The independent, mistrustful reviewer pass (BRIEF section 9) is still to do.

## 4. Gotchas that cost time (do not repeat)
- `render.mjs` refuses placeholders by scanning page text; the painted mascots' own code-scroll contains "TODO", so the scan skips `.mx`, svg and canvas.
- Playwright: set `PLAYWRIGHT_PATH`; do not `playwright install`.
- Captions in one slot must be 0.72 s apart (fades are 0.35 s each side) or they ghost over each other during dissolves; `timeline.mjs` trims earlier captions automatically and `check.mjs` verifies. A short shot cannot host a long caption: reading time is 0.3 s per word + 0.8 s minus 0.5 s grace. When you add a scene, budget the seconds first.
- Shifting bars: all later `b(n, ...)` numbers must move together (the first trailer's time map is hard-coded in `trailer.html` as well as `timeline.mjs`; both were shifted by regex when the board scene was added; `BAR` in the html is a constant 2.5, not `dur/40`).
- Muster busts differ in height: they are bottom-aligned to their labels.
- The real UI's own words show up in screenshots ("Log verified", the fake wallet's local port). Keep cameras off words the trailer must not claim ("verified", "safe"), and off temp paths (Folder card).
- Hard cuts add a 2-frame scanline hit; dissolves overlap 0.5 s; both are double exposures on a still, which is by design.
- `score.wav` is generated (38 to 40 MB), excluded locally through `.git/info/exclude`, never commit it.
- Do not edit `docs/video/` (the first trailer).

## 5. Decisions and facts that must survive an edit
- Beta wording is the owner's: "0.2.0 · BETA", dry and confident; never "young", "safe", "secure", "verified", "cannot be bypassed", no dates, no provider names, no "works with X", no Lightpanda, no repo URL, no "open source" claim until the owner says the repo is public (the facts file says it will be MIT).
- Built-not-tried scenes keep their chip for the whole scene: BSV spend ("Built against fakes. Not tried with real funds."), Blender, prebuilt package, updater, project board ("Built and tested. Not yet tried on a real PC."). `check.mjs` enforces it.
- Project board: IN 0.2.0 per the orchestrator (owner decision), "BUILT, BEING FINALISED" until the facts file says SHIPS. Delete approval card was not captured (bug on the board branch: `mcp__legion_board__*` missing from the Legion-tool list in `src/core/approvals.ts` makes every board call count as outside content). Re-check once the board is merged and re-capture with `board-capture.mjs`; add the card if it then appears.
- Browser tool: show only if the facts file says SHIPPED (it said IN PROGRESS at render time); ONE engine (Edge/Chrome on the PC); honest limit "a local browser runs with your rights; only a cloud VM is isolated".
- NEXT list (planned 0.2.1, text cards only, no UI): more model providers, a knowledge-graph audit button (refreshes stale notes), the Sentinel scheduler (scheduled runs do not exist today, never imply them), an optional lighter package, more browser engines, real-wallet BSV checks.
- BSV pack count is 163 notes (version 8) per the facts file; the trailer shows no counts. First shots said 157 and were retaken.
- Herald is draft-only; Sentinel does not run on a timer.

## 6. Known flaws and next steps (ordered)
1. Run the independent reviewer pass (fresh agent, default "not fixed", every 0.5 s and cut frame at full and phone size, every on-screen string against BRIEF's fact table).
2. Polish: shrink the install route cards (`#cardA/#cardB` height 330 to about 200, chip up), start the Relic's end-card rise earlier (`T.relic` keys around `b(40,*)`), re-time the 2.5 s board shots if the owner wants more air.
3. Re-capture after merges: board shots (and delete approval card), Blender "Get" in the Windows state, Update panel with a configured update state, BSV with the final pack.
4. Update `BRIEF.md` to match the shipped storyboard (it still describes Variant B and 100 s; the cut is 42 bars = 105 s with the board in 0.2.0).
5. Score: mid-section is flat (about -18 dBFS until install); sub energy is near the 45% limit; nobody has listened.
6. Optional: a 60 s cut using the same timeline (drop rooms, install, VM/MCP) and a poster with the BETA line.
