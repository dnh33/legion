# Trailer v2 audit (first version, 2026-10-03)

Status: **first cut for owner feedback. The independent reviewer pass has NOT been run yet.** What follows is the maker's own pass only.

## What was built
- 105 s (42 bars at 96 BPM), 1920x1080 30 fps. `node docs/video-v2/check.mjs` passes (reading time, beat grid, chips on every built-not-tried scene, banned words, no UI in the NEXT block, caption gaps).
- Every UI frame is a screenshot of the built React UI against a real core with the repo's fakes (`shots/MANIFEST.md`, `capture/`). The board shots come from a scratch build of `origin/claude/project-board` (a78b362); that code is not on this branch.
- Score: `score.py`, measured on the first render: integrated -13.3 LUFS, true peak -1.5 dBFS, LRA 4.6 LU (not listened to).
- 2026-10-03 render-integrity pass (orchestrator, frames pulled from the FINAL mp4): intro t5 clean, browser scene t76 PASS (caption + engine line + the honest "runs with your user rights" text + the BUILT-NOT-TRIED chip), board digest t47 full (~85% of the card; the t46 frame is mid-type-in and transiently sparse — not a defect), end card t100 clean (no mascot/wordmark overlap). Audio verified technically: aac stereo 48 kHz, 10,080,000 samples = the full 105 s, mean -15.3 dB, no silence/dropout, true peak -1.5 dBFS. The ONE gap that cannot be closed by tooling: no human has listened to the music.
- The committed MP4 is the full render: `legion-trailer-v2.mp4` 47.6 MB h264+aac (105 s). `node docs/video-v2/render.mjs` rebuilds it (Node, Playwright Chromium, ffmpeg, Python with numpy and scipy; set `PLAYWRIGHT_PATH` if Playwright is not installed).
- GIF 960x540, 5.8 MB; poster-v2.png is the end card.

## Honesty decisions
- Board: shown in 0.2.0 per the orchestrator's note, with the chip "Built and tested. Not yet tried on a real PC." Per the facts file the board is BUILT, BEING FINALISED, not merged yet. The delete approval card is now captured in the final cut (board-delete-card.png): the approvals bug (mcp__legion_board__* missing from the Legion-tool list in src/core/approvals.ts) was fixed at the board merge (f726780), so the delete tool reaches the approval card. The caption "You mark Done. You approve deletes." rests on `docs/PROJECT-BOARD.md` and the UI note text, not on a captured card.
- Browser tool: shown (facts file: SHIPS IN 0.2.0, merged and gated 2026-10-03).
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
