---
name: mockup-through-the-real-renderer
description: Use when you propose a visual change (palette, seasons, terrain marks, a sprite style) to something a renderer already draws. Fork the real renderer, change only the colour or draw code, render it with a browser script, and put it next to the shipped look. The mockup is then the code the builder copies back.
---

# Mockup through the real renderer

A mockup made in another tool (Blender, a paint program) shows a look. It does not show whether the game's renderer can draw it. A mockup made through the real renderer is the proposal itself: the builder copies the changed function back.

Proven in: Steinbock visual direction, 2026-10-08 (`projects/proj_7c95a305f9e5/concepts/visual/`).

## When to use
- A renderer already exists (Canvas 2D, WebGL, a game engine) and you are asked for "visual direction", "palette", "seasonal looks" or "what X should look like".
- Use Blender or a paint tool only for hero art and reference, not for rules the renderer must follow.

## Steps
1. **Read the renderer first.** Find the colour function, the thresholds, the light model and the camera. Write down what already ships, so that you codify it and do not redesign it.
2. **Fork, do not edit.** Copy the renderer file into your own folder. Never edit the builder's tree while they work in it. Note the fork base in your doc: the commit, plus "uncommitted working copy, <date>" if the file had local changes.
3. **Change only marked blocks.** Wrap every change in a comment such as `PROPOSAL`, so the builder merges blocks, not the whole file. Put new values in tables (one key per season or state), so they can be blended later.
4. **Use the real data and camera.** Import the project's own demo data read-only. Do not invent a test scene that the game never draws.
5. **Render headless.** Build one small page that takes URL parameters (season, time, zoom, test case). It sets `window.done` once the frame has settled. A browser-automation script loops over a shot list and saves PNGs. Wait for background builds to finish; do not use a fixed sleep. Time the build and one settled frame with `performance.now()`, and report both.
6. **Always render the shipped look next to the proposal.** Same camera, same settings. If you cannot point at the difference, the change does not work. Say so.
7. **Capture the sharp layer as well as the final frame** when the renderer blurs (tilt-shift, depth of field). Judge colour rules on the sharp layer and legibility on the final frame.
8. **Look at every image you cite.** Never point to a shot you did not open.

## Report
- The rule as code, with the file and block name.
- The shots: proposed vs shipped, at the zoom levels the player uses.
- The cost: build time and frame time, measured, not guessed.
- What does not work yet, said plainly.
