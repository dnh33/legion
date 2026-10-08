---
name: procedural-texture-anti-slop
description: Use when you write or review procedural colour or texture code (terrain bands, speckle, stripes, noise, erosion marks) for a renderer that fills cells or tiles. A short list of the mathematical tells that make procedural art look machine-made, and the fix for each.
---

# Procedural texture: the tells and the fixes

Proven in: Steinbock seasons, erosion and rock bands, 2026-10-08 (`projects/proj_7c95a305f9e5/concepts/visual/`).

Each tell below was found in real work and fixed. Check for all of them before you show a texture.

| Tell | Cause | Fix |
|---|---|---|
| Checkerboard | A product of two sines, `sin(a)*sin(b)`, draws a checkerboard by construction. | Use a sum of three or more sines at incommensurate angles, plus the project's existing noise. |
| Pixel mosaic | Per-cell random values (hash per render cell). Blur or a lens turns them into visible squares. | Vary tone with smooth functions at the simulation's scale, never per render cell. |
| Stair-steps on a thin feature | The renderer fills each cell with one flat colour, so a narrow band or edge follows the cell grid. | Make the feature at least two render cells wide, or raise the render subdivision. Measure the build-time cost. |
| Dashed scribbles | Flow channels (D8 drainage) drawn on flat ground meander cell by cell. | Keep only channels above a slope and height threshold. Blur the flow field once (3x3) before you draw it. |
| Hard wedge shadows | Cuts in the height map are too deep for the light model. | Keep cosmetic cuts small; the light should only pick the groove out. |
| Rice terraces / a topo map | Evenly spaced bands. | Make the spacing irregular, for example by adding a slow sine of height to the band phase. |
| Invisible change | A later rule (an override for steep ground, snow, water) paints over your rule. | Apply your rule after the overrides, weighted by how much of the feature is present. Check by rendering shipped vs proposed. |
| Two features clash | A pale deposit lies under dark objects (trees on scree), and the gaps read as a checker. | Suppress the objects where the deposit is strong. |
| Perfect geometry | Discs, rings and straight edges in something natural (a fan, a patch). | Wobble the radius with an angle-dependent term and use a soft power falloff. |

## How to check
1. Render at the zoom the player sees most, and look at a 1:1 crop enlarged with nearest-neighbour.
2. Render the shipped version next to yours with the same camera.
3. Look for regular patterns your eye did not intend: grids, repeats, steps, perfect circles.
4. Report each tell you found and fixed, and the image that proves it.
