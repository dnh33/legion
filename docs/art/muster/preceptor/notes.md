# Preceptor (Legion muster): painter's notes

Files: `preceptor.layered.svg` (bust, 60 KB), `preceptor.portrait.svg` (600x800, 134 KB), `preceptor.json` (built, 85 KB), `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png`, `detail-helm.png`, `detail-calipers.png`, `detail-portrait-hem.png`, `detail-portrait-coat.png`.

Generators (the only two, both final): `/home/claude/pilots/preceptor/gen.py` (bust and every shared part) and `portrait.py` (imports gen.py, adds the long robe mode, legs and the workshop). `railsheet.py` and `compare.py` only make proof sheets.

Build: `build.sh preceptor preceptor.layered.svg <work>` passes with the real `build-mascot.py`, unchanged: 12 layers `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-1..4, L-front, L-token-1`. Checked: strict XML (both files), every id `prc-` or contract `L-*`, no style/script/image/foreignObject/on*, 40 eye cells (4x4, on the 4 px grid, mirrored, `#ffffff`/`#b9ffd8` only), `L-visor-shape` uses absolute M/L/Q/Z only. All 8 states run through `engine.js` + `mascot.css` on dark and light grounds (`engine-states.png`): recolouring stays in the window, the code scroll is clipped to it, the alarm glow lands on the seal, victory shows ^ ^, and the helm (dome, frame, full lower rim) is complete in every state; in sleep the rim tucks behind the collar.

## Palette
| role | hex |
|---|---|
| Undyed linen (dominant mass) | `#f6f4ee` `#ebe8df` `#dcd8cc` `#c5c0b2` `#a29d90` `#79756b` `#55524b`, outline `#3f3c36` |
| Lacquer black (plate, helm) | `#6d6a76` `#45424d` `#2b2932` `#1b1a20` `#121115` `#0a0a0c`, outline `#060507`, gloss `#f4f6ff` |
| Pewter (the one secondary hue, cool, low saturation) | `#c9ccd0` `#a4a8ae` `#868a91` `#6c7077` `#50545a` `#383b40`, outline `#25272b` |
| Halo (dimmed pewter + linen scale) | band `#8e9298` to `#3c3f44`, scale `#c9c4b5` to `#8f8a7d`, smoked glass `#c9ced4` at 12 to 26 % |
| Gold thread (trim only) | `#efdc97` `#c4a24c` `#6f5823` |
| Crimson, wax seal only | `#ff6a78` `#b3202f` `#5e0d18`, sigil `#f3dc94` |
| Phosphor (window, eyes, code only) | `#7CFFB2` `#b9ffd8` `#ffffff` `#eafff3`, window `#0b3b25` `#06261a` `#04170f` |
| Cool rim light (right edges) | `#b4c2ff` |
| Portrait scene only | wall `#4a5056` to `#0b0d10`, pegboard `#666c73` to `#1c1f23`, tool steel `#c3c8ce` `#8b9198` `#4e535a`, bench (desaturated) `#6a625a` `#4e4740` `#3a352f` `#26221f` |

The linen is kept cool-neutral and greyed (`#ebe8df`), not the Scribe's warm bone (`#f0e8d3`/`#d3c7a6`), and it sits over lacquer black instead of indigo, with no parchment, quills or scroll anywhere.

## Identity
- **Silhouette:** the only light-dominant bust besides the Sculptor: broad linen shoulders (a capelet with a ruler hem), a tall black ogival helm on the centre line, and a flat D (a protractor) standing behind the head. Perfect bilateral symmetry; everything that matters sits on one vertical axis: finial, gold plumb line, plumb bar, seal, SEEN/PROVEN tag, calipers, gauge block.
- **Helm:** lacquer-black, ogival dome with a raised medial keel inlaid with a gold plumb line from finial to brow; pewter brow band engraved as a rule; a separate raised face plate hinged on two pewter temple rosettes; three breathing slots each side of a centre keel with a small pewter plumb-bob inlay; full riveted pewter lower rim. The lacquer carries a crisp two-pane window reflection (the workshop's light) instead of worn-iron texture.
- **Finial (`L-plume`):** a plain turned pewter ball with a short point on a black stem, gold collar, seated in a pewter socket on the apex.
- **Visor aperture:** one wide rectangular window (100 x 32) split in the middle by a thin vertical plumb-line bar that ends in a tiny bob. Eyes sit either side; the eye group is clipped to the window so pointer tracking never leaves it.
- **Eyes:** a calm, centred almond (glow rim, 3-cell core over 3-cell core, narrowing):
  ```
  .+++++.
  ++###++
  .+###+.
  ..+++..
  ```
- **Halo:** a thick protractor: a 180-degree pewter band (R 110 to 138) with an inlaid linen scale ticked every 2 degrees (long every 10), engraved numerals 20 to 160, a base bar ruled every 4 units with end screws, an index pointer at 90, and a smoked-glass face with engraved radials. Its pivot is the protractor's origin, which is the visor centre (300 230), so at rest the base bar runs through the eye line like a level. Dimmed: the band is mid pewter and the brightest halo value (the linen scale) is far below the window.
- **Signature prop:** pewter outside calipers (fix round 1): two straight legs leave a riveted hinge washer, splay out under the gauntlets (three articulated fingers and a thumb each, pewter fingertips), then turn inward as pointed feet that stop 2.5 px short of the two sides of a small linen-white gauge block marked with a centre cross. It reads as a Lambda with feet, not a ring; the legs use the light pewter step (`#a4a8ae` lit leg, `#8c9096` far leg, `#c9ccd0` hairline on the left edge only, `#25272b` outline). No lens, no glass optics. In the portrait the same graded blocks sit on the bench.
- **Hang strips (4):** two linen measuring tapes ticked and numbered 1 to 8 with pewter end tabs (`L-hang-1`, `L-hang-4`), a cord with a pewter plumb bob (`L-hang-2`), and a knotted rope-stretcher cord ending in a pewter ring weight (`L-hang-3`). All hang from the capelet hem and pass behind the forearms.
- **Code-as-liturgy:** the verdict tag `SEEN` / `PROVEN` (5.4 px bold, black ink, the second in a stamped box) in static `L-front`; the capelet hem is a rule numbered 1 to 5 and 7 to 11 (4.4 px) with ticks; the brow band and halo bar are rules; the halo scale 20 to 160 (6.2 px). Portrait adds: the robe hem as one continuous rule 0 to 100 (6.4 px, 50 falls under the opening), the facing bands ticked down both front edges, the bench edge rule 0 to 15, labelled drawers (GAUGE, SQUARE, PLUMB, CORD), a tape on the floor and the motto SHOW ME AT THE SIZE IT SHIPS.
- **Family mark:** crimson wax seal with the Legion `>_` sigil (the pilots' geometry) on the collar clasp; the only `L-token-1`, pivot `300 335`, so the engine's alarm glow (pivot + 6) lands on the seal's centre `300 341`.
- **Portrait backdrop:** a craft workshop wall: a steel-framed pegboard in a pool of cool skylight from the upper left, hung with a framing square, wing dividers, three plumb bobs, ring gauges, a try square, a steel rule, a sliding bevel, a spirit level and a coil of knotted cord, each with its cast shadow; a long workbench behind the figure with a plane, graded gauge blocks and a vise; floor line with shavings and a tape; one cool rim light on the right; the figure's own cast shadow on the wall to the right. No arch, window, niche, candles, shelves or lattice.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | soft cool-pewter glow | – |
| L-halo-back | protractor (glass face, D band, scale, bar) | 300 230 (origin = visor centre) |
| L-body | gorget lames, linen torso and sleeves, black breastplate with lames, capelet with ruler hem (fades out at the crop bottom) | – (static) |
| L-plume | finial | 300 122 (apex) |
| L-helm | complete helm, brow rule, face plate, frame, lower rim | 300 300 |
| L-face | window glow, scanlines, `L-visor-shape`, eyes (in a window clip), plumb bar | 300 300 |
| L-hang-1..4 | tape, plumb bob, knotted cord, tape | 170 410, 226 413, 374 413, 430 410 |
| L-front | standing linen collar and clasp plate, SEEN/PROVEN tag, calipers and block, rolled cuffs, forearms and gauntlets | – |
| L-token-1 | wax seal | 300 335 |

`data-crop="140 52 320 482"` (20 units more headroom for the victory lift); `data-crop-rail="150 56 300 320"` holds the whole protractor at any rotation (farthest point 139 from 300 230: x 161-439, y 91-369), the finial with lift headroom, collar, seal and shoulders.

## Five idle behaviours (from the shared primitives)
1. **Level check** (lean): the rig leans 1 degree left, 1 degree right, and settles exactly upright with no overshoot.
2. **Plumb** (plume settle): the finial swings once and damps to dead vertical, then holds still for 2 s while everything else keeps breathing.
3. **Read the scale** (stepped spin): the protractor ticks 2 degrees at a time to about 10 degrees, pauses, and ticks back to zero. It measures; it does not spin.
4. **Look closer** (eye set + pulse): eyes switch to `narrow` for 1.5 s and the window brightens 10 percent, then one slow blink.
5. **Check the tapes** (wave): the hang layers sway one after another, left to right, then stop together.

## Quips (exacting, encouraging)
1. Show me at the size it ships.
2. Again. Smaller.
3. It works. Now why?
4. Seen. Not yet proven.
5. Render it first. Then tell me.
6. Two pixels left. There. Feel that?
7. Plausible is not a unit.
8. Good. Now on the slow machine.
9. You fixed the symptom. Find the cause; I'll wait.
10. Nice line. Half a pixel off the grid.
11. Measure twice. You measured once.
12. Proven. Well made. Ship it.
- Annoyed (five pokes): "Poking is not measuring."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is ignored** (same as the pilots). In `build-mascot.py` `main()`, after `crop = ...`: `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`, and give `createMascot` a `{rail: true}` option that uses `data.cropRail` for the viewBox and pivot percentages.
2. **`L-body` is used but not in the contract.** Add the row `L-body | optional | static (torso, robe) | – |` and the paint order `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-N, L-front, L-token-N, L-halo-front`. No script or engine change needed (verified).
3. **A protractor should not spin 360 degrees.** The engine's `mx-spin` turns the D upside down half the time. Proposal: a per-layer `data-motion="swing"` on `L-halo-back` (rotate between -18 and +18 degrees on the same timings; thinking = faster swing, victory = one full sweep). Until then it spins and still reads as a dial (checked in `engine-states.png`).
4. **Victory flare whitens light halos** (`brightness(2.2)`): the pewter band and linen scale go nearly white for about 1.4 s. Make it a persona value, e.g. `"haloFlare": 1.15`.
5. **Eye clip wrapper:** `L-eyes` sits inside one `<g clip-path="url(#prc-cWin)">` within `L-face` (the build appends the alternate eye sets inside it, unchanged). Contract wording: "`L-eyes` may sit inside one clip-path wrapper."
6. **`L-visor-shape` absolute commands only** (the bounds parser reads `nums[0::2]`): add to the contract. Mine uses M/L/Q/Z.
7. **Secondary hue collision:** the constitution's starting palette gives the Archivist "walnut and pewter", and this brief gives the Preceptor pewter. Proposal: the Preceptor keeps pewter (it is his only metal accent and carries the calipers, rules and halo); the Archivist moves to walnut with aged brass, or the colour test settles it.
8. **Text in sway layers:** the tape numerals live in `L-hang-1`/`L-hang-4`. Hangs only rotate (never flip), so they never mirror; the readable verdict tag is in static `L-front`.

## Still weaker than Zealot (honest)
- **Drama.** The portrait is monochrome by design (linen, black, pewter, green window). There is no coloured light, no glow behind the figure and no warm accent, so it reads calmer and quieter than Zealot at 300 px.
- **Cloth.** Folds are drawn planes (lit plane, hard terminator, shadow plane) with a fine weave pattern, not painted cloth. The long robe folds are long and fairly straight; the capelet still reads slightly as regular pleats.
- **Anatomy.** The forearms are foreshortened and the elbows are hidden under the rolled cuffs, so the arms read short; the gauntlets are clean but mechanical. The legs are long relative to the torso.
- **Helm.** A smooth lacquer capsule is on-concept (immaculate) but less heroic than Zealot's great helm; at 48 px the bust is carried by the D halo, the white shoulders and the green window more than by the helm outline.
- **Scene rendering.** The pegboard tools are clean gradients with cast shadows, not painted objects.
- **Engine items** above (halo spin, victory flare) affect the read of the halo until fixed.

## Fix log (round 1, after review)
Generators `gen.py` and `portrait.py` were edited and are in sync with the delivered SVGs (re-run emits byte-identical files); `HEAVY=True` is set only by `portrait.py`, so the approved bust cloth is untouched. Proof renders are in `/home/claude/pilots/preceptor/fix/` and the deliverable PNGs.

### Blocking
1. **Calipers read as a closed hoop: FIXED.** Bowed oval legs replaced by straight legs from the hinge (300,396) that splay under the hands and turn in as tapered pointed feet ending 2.5 px from the gauge block; block moved up 6 px (476-494) so both tips clamp its sides at mid-height; legs lightened to `#a4a8ae` / `#8c9096` with a `#c9ccd0` highlight on the left edge only and a `#25272b` outline; rim light on the far leg. Evidence: `detail-calipers.png` (open V, visible gap and tips), `/fix/full_small.png` (64, 96, 160 px full-crop: the Lambda with feet is visible at 64 px), `detail-portrait-coat.png` and the portrait at 600 px (same drawing, reused). Note: the rail crop (`150 56 300 320`) ends above the hands, so the calipers only show in the full data-crop view and the portrait.
2. **Finial clipped in victory: FIXED.** `data-crop="140 52 320 482"`, `data-crop-rail="150 56 300 320"` (20 units more top margin). Checked through the real engine with the built JSON at 150, 250, 400, 500, 640 and 900 ms of `victory`: the spike and ball are complete in every frame and the top three pixel rows of the cell are empty at every sampled time (`/fix/v640_top.png`, `/fix/v250_top.png`, `/fix/st_v640.png`).
3. **Portrait not Zealot-grade: PARTLY FIXED.**
   - (a) Capelet: 3 overlapping fold planes per side (uneven widths 15/10/19, different shadow widths, hard terminators, lit plane on the left, deeper cool shadow `#23252e`), plus a cast shadow of the hem on the coat; coat chest: 3 drapes per side, replacing the faint folds. FIXED, see `detail-portrait-coat.png`. It is still a drawn-plane cloth, not painted cloth.
   - (b) Belt: bowed (about 15 units sag centre to ends), tapered to the flanks, stitched in two rows, sag shadow under it, ends shaded as they wrap away round the coat; no square plank ends. FIXED, see `detail-portrait-coat.png`.
   - (c) Headroom: figure scale .8 to .74 and moved down so the feet stay on the floor line; finial tip is now about 70 units from the top edge (was 14; Zealot about 100); halo no longer jammed against the frame, the pegboard header bar sits behind it. FIXED to the review's "60+" target.
   - (d) Cool key pool: radial cool-white pool on the left capelet shoulder (clipped to the capelet) and a floor reflection plus a thin lit floor line under the boots. DONE, subtle.
   - (e) Backdrop darkened around the figure (blurred black mass, 34 percent), so the linen separates harder. DONE.
   - NOT done (still the weakest part): no extra dynamics for the legs (two parallel columns under an A-line coat), arms are still short wedges, the pose stays symmetrical; no secondary focal accent beyond the window and the seal. `portrait-vs-zealot.png` shows it is calmer than Zealot.

### Non-blocking
- No identity hue: NOT FIXED (left as deliberate, as the review allowed).
- Pewter collision with the Archivist: NOT FIXED here by design (Preceptor keeps pewter; the Archivist fixer moves away). The calipers legs are now the lightest pewter on the bust, so they stay distinct.
- White shoulders dominate the rail: PARTLY. The top of the linen gradient `prc-linF` drops from `#f6f4ee` to `#f0eee6` (this also applies to the portrait); the highlight on the left shoulder is kept. The rail still shows white shoulders at 48 px, green eyes still win (`rail-test.png`).
- Helm gloss reads as vinyl: FIXED (partly). The soft blob and ellipse near 276,146 are replaced by one hard-edged lit facet with a keel-side edge and three tiny hard scratches; the soft window-reflection band stays. See `detail-helm.png`.
- Rim light fragmentary: NOT FIXED.
- Eyes read as pills: NOT FIXED (contract grid and eye sets left alone).
- Gold rim around the visor window: FIXED (`#8d7a3b` at 60 percent).
- Floor curls: FIXED (the shavings at the bench legs are removed).
- Boots on dark floor: FIXED (thin lit floor line and a cool reflection pool on the floor behind the boots).
- Code-as-liturgy: unchanged, accepted by the review.

### Checks
- `build.sh preceptor preceptor.layered.svg build`: pass, 12 layers `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-1..4, L-front, L-token-1`; built JSON copied to the deliverables (`cmp` clean, 85 KB).
- Strict XML parse: both SVGs OK; all ids `prc-` or contract `L-*`, no duplicates; no style/script/image/foreignObject/on*; 40 eye cells (4x4, 4 px grid, `#ffffff`/`#b9ffd8` only); sizes 60 KB bust, 134 KB portrait.
- `states.mjs` on dark and light (`engine-states.png`): all 8 states, helm complete, no artefacts; finial intact in victory.
- `rail-test.png` regenerated with the new rail crop at 48/64 px, colour and grey, 1x/2x, beside Relic, Inquisitor, Scribe.
- Contract/engine notes 1-8 above are unchanged (cropRail still ignored by the build script and engine; halo still spins 360 degrees).
