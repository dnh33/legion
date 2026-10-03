---
name: "painted-mascot-engine"
description: "Turn an approved hand-painted SVG mascot into a live, expressive app mascot without redrawing it: layer contract, GPU-composited layers, states, eyes, and an expression lab."
---

# Painted mascot engine

The reference implementation is Legion:
- the contract, `docs/art/MASCOT_CONTRACT.md`;
- the build script, `scripts/build-mascot.py`;
- the engine, `ui/src/mascot/engine.js` + `mascot.css`;
- the lab page, `docs/demo/relic-lab.template.html`.

## Golden rule
The owner approves a specific painting. **Never redraw or simplify it.** A previous agent "rebuilt" the art for runtime, cropping the helm at the mouth and adding details, and the owner rejected it immediately. Use the exact painted paths. Only regroup them and add overlay layers.

## Steps
1. **Regroup to the layer contract.** Write a one-off script (like `scripts/relic-to-contract.py`) that moves the original top-level groups into contract groups, changing no path. The groups, in paint order:
   - `L-aura`, `L-halo-back`, `L-plume`, `L-helm`, `L-face`, `L-hang-N`, `L-front`, `L-token-N`, `L-halo-front`;
   - each with a `data-pivot` (document coordinates), plus `data-crop` on the root.
   - Find the layer indices by rendering subsets of the original.
   - `L-face` holds the visor-light parts and the pixel eyes (`L-eyes`, 4px rect cells, 7×4 per eye) and the `L-visor-shape` path.
2. **Verify the regroup.** Render the original and the regrouped versions side by side at the same crop. They must look identical. Also check that the crop doesn't clip plumes or wings.
3. **Build the data.** `build-mascot.py` splits the layers into separate SVG documents and prefixes every id per mascot. It also:
   - wraps the original eyes as `xe-base` and adds expression eye sets on the same grid (narrow, happy, wince, shut, angry);
   - adds a visor code-scroll clipped to `L-visor-shape`.
4. **Engine.** Each layer is its own absolutely-stacked `<svg>` inside a `will-change: transform` div, so motion is composited instead of repainting the art.
   - Plume, helm and face sit in one rig div.
   - Use one hidden defs svg.
   - Overlay FX (sparks, `!`, z's, cloud, alarm glows) are positioned from the art's own pivots.
   - Recolour state with CSS filters on the face layer only. For accurate colour use sepia-based chains: amber is `sepia(1) saturate(3.4) hue-rotate(-14deg)`, red is `sepia(1) saturate(6) hue-rotate(-48deg)`. Plain hue-rotate gives pink.
5. **States:** idle, listening, thinking, hacking, awaiting, victory, error, sleeping, annoyed.
   - Interactions: eyes follow the pointer, hover lean, click bonk plus quip, double-click spin, five pokes makes it annoyed.
   - Blinks and idle tricks run on jittered timers. Respect reduced motion.
6. **Pitfalls:**
   - Namespace the state classes (`mxs-*`). An app class `.st-error` once painted a red box over the mascot.
   - Keep the motion solemn: float about 7s, halo 100s+, typing bob about 1.1s. The owner said the faster version "looks sped up".
   - Apply a minimum dwell (about 1.8s) between derived states so rapid events don't make it flicker. Attention states switch instantly.
7. **Expression lab.** Publish a page with every state, a tour, VM and eye-tracking toggles and quips. The owner uses it to judge expressiveness.
8. **Kodawari.** Screenshot every state at the shipped size (around 200px) in dark and light. Compare with the original art. Sample the computed transforms to confirm the real periods.