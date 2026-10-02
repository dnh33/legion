# Trailer v2 audit (first version, 2026-10-03)

Status: **first cut for owner feedback. The independent reviewer pass has NOT been run yet.** What follows is the maker's own pass only.

## What was built
- 105 s (42 bars at 96 BPM), 1920x1080 30 fps. `node docs/video-v2/check.mjs` passes (reading time, beat grid, chips on every built-not-tried scene, banned words, no UI in the NEXT block, caption gaps).
- Every UI frame is a screenshot of the built React UI against a real core with the repo's fakes (`shots/MANIFEST.md`, `capture/`). The board shots come from a scratch build of `origin/claude/project-board` (a78b362); that code is not on this branch.
- Score: `score.py`, measured on the first render: integrated -13.3 LUFS, true peak -1.5 dBFS, LRA 4.6 LU (not listened to).
- The committed MP4 is a 26 MB re-encode (crf 25) of the 53 MB render. `node docs/video-v2/render.mjs` rebuilds the full-quality one (Node, Playwright Chromium, ffmpeg, Python with numpy and scipy; set `PLAYWRIGHT_PATH` if Playwright is not installed).
- GIF 960x540, 6.7 MB (64 colours); poster-v2.png is the end card.

## Honesty decisions
- Board: shown in 0.2.0 per the orchestrator's note, with the chip "Built and tested. Not yet tried on a real PC." Per the facts file the board is BUILT, BEING FINALISED, not merged yet. The delete approval card could not be captured: on the board branch `mcp__legion_board__*` is not on the Legion-tool list in `src/core/approvals.ts`, so any board tool call marks the run as having touched outside content, and then delete and assign are refused. That looks like a bug on that branch. The caption "You mark Done. You approve deletes." rests on `docs/PROJECT-BOARD.md` and the UI note text, not on a captured card.
- Browser tool: not shown (facts file: IN PROGRESS).
- NEXT: providers (no names), knowledge-graph audit button, Sentinel scheduler, lighter package, more browser engines, real-wallet BSV checks. No dates. Lightpanda is not mentioned.
- Digest card text is the real digest block from a fake run, unedited.
- Screenshots show the real UI's own words, including "Log verified" in the BSV panel (camera avoids it) and the harness's fake wallet address (a random local port).

## Known imperfect
- Install route cards are tall and mostly empty; the Relic overlaps the wordmark cables for part of the end-card draw.
- The Update panel is an honest dull state ("Updates are off in this build"), cropped to the panel.
- Blender "Get Blender" shows the Linux state ("Only available on Windows"); the Windows state was not captured.
- The Folder card in some shots shows a temp path; cameras are set to avoid it.
- Muster, rooms and two shots show the app's own mascot panel next to ours.
- Music was measured, not listened to.
