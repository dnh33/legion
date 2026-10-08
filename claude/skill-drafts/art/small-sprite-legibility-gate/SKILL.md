---
name: small-sprite-legibility-gate
description: Use when art must read at a small size (a 24-64 px sprite, an icon, a miniature on a map) or when someone asks "can you tell them apart at N px". Measure height, separation from the real background in 1-bit, and halos, in the real scene, not on swatches. Report pass or fail per case with images.
---

# Small-sprite legibility gate

"It reads" is a claim. This gate turns it into measurements another agent can repeat.

Proven in: Spike 003-A and the Steinbock 24 px gate, 2026-10-08 (`projects/proj_7c95a305f9e5/concepts/visual/`).

## The tests
1. **Size.** Measure the figure's height from the alpha channel (alpha >= 128), not from the canvas size. Report the target and the measured value.
2. **Pairs, not singles.** List the pairs most likely to be confused (similar hue, similar value, same shape) and judge each pair. A list of singles that "all pass" hides the real risk.
3. **In situ, not on swatches.** Put the figures in the real scene, at the real zoom, inside and outside any focus band. A flat colour patch is a first check only.
4. **Worst-case grounds.** Test the lightest figure on the lightest ground (for example, snow) and the darkest on the darkest or mid-grey ground (for example, rock or dark window chrome).
5. **1-bit silhouette.** Convert to grayscale and apply one Otsu threshold over the crop. For each figure, count the share of its silhouette pixels that the threshold flips to the opposite value of the surrounding ground. The clearer the figure, the closer that share is to 1. Report it per figure. Show the colour crop and the 1-bit crop side by side, enlarged with nearest-neighbour only.
6. **Silhouette mask from a reference frame.** Render the same frame without the figures. Pixels whose colour differs from the reference frame by more than a few grey levels (start at 8/255; it is a knob, so report the value you used) are the silhouette. This needs no hand-drawn mask.
7. **Halo.** Inside the sharp area, compare the 1, 2 and 3 px rings outside the silhouette with the reference frame. Changes only at 1 px are anti-aliasing. Changes at 2-3 px are a halo. Exclude things drawn on purpose, such as a contact shadow, and say so.
8. **Colour distance.** Add a mean CIE L*a*b* delta-E per pair, and the edge delta-E against each background. Your eye judges; the numbers back it up.

## Rules
- Paste small art 1:1. Do not resample it. Make enlarged copies for review with nearest-neighbour only.
- Do not tune the art (outline, colours) until the gate passes and then call it a pass. Report the fail, then propose the fix as a separate, tested change.
- Say what the test cannot show (for example, detail that is sub-pixel at this size, or a feature that is identical across all variants).
- If figures overlap and a per-figure split is crude, say the number undercounts and let the image carry the evidence.

## Report
A table per case (figure, ground, measured value, PASS or FAIL), the image paths, and a list of what was not tested.
