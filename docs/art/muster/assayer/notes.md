# Assayer (Legion muster): painter's notes (fix round 1 applied)

The Assayer is the Legion's BSV (Bitcoin SV) development specialist. The app shows it only while the owner's BSV toggle is on (an app rule; nothing in the art). It weighs every claim twice and spends once.

## Files
Deliverables are in `/mnt/user-data/outputs/muster/assayer/`:
- `assayer.layered.svg`: the bust, 80 KB.
- `assayer.portrait.svg`: 600x800, 137 KB.
- `assayer.json`: the real build output, 103 KB.
- `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png` (dark on top, light below).
- `detail-bust-helm.png`, `detail-portrait-upper.png`, `detail-portrait-lower.png`, `detail-portrait-backdrop.png`.

Generators are in `/home/claude/pilots/assayer/`. Only these three remain, and they are current (re-running them reproduces the delivered SVGs byte for byte):
- `parts.py`: the shared helm, face, plume, halo and seal, plus the `rim_edge` helper.
- `bust.py`: writes the layered bust.
- `portrait.py`: writes the portrait (it imports the other two).

Proof scripts: `railsheet.py`, `sheet.py`. `fx/` holds the before/after scratch renders and the pre-fix copies of the generators and SVGs (`fx/*.orig.*`).

Build: `build.sh assayer …` with the real, unchanged `build-mascot.py` **passes**. It writes 12 layers: aura, halo-back, body, plume, helm, face, hang-1..4, front, token-1.

Checks: both files parse as strict XML. There is no style, script, image, foreignObject or `on*` attribute. Every id is `asy-` or an exact `L-*` id, with no duplicates. The halo, rendered alone at 7 rotation angles, stays inside `data-crop` and inside `data-crop-rail` (bounding box x 171-429, y 103-363).

## Palette
| role | hex |
|---|---|
| Bright silver (helm, beam, plate highlights) | `#f1f4f8` `#e2e8ef` `#d8dfe7` `#b6c0cc` `#7f8b9b` `#465161` `#2a323e` |
| Light plate (body, mid-value so the helm and beam lead) | `#b9c3cf` `#8f9bab` `#525d6c` `#2a323e`; shadow side `#1a2029` → `#6b7786` |
| Steel-blue, the one secondary hue (tabard, arming sleeves, coat, halo tag) | `#86a6c8` `#5f82a8` `#4a6a8f` `#385473` `#273d56` `#18283a`; coat panels `#3d5b82` → `#090f18` |
| Chain halo (blue-tinted steel, lifted about 25 % in the fix round) | `#c4d0e0` `#8a9db9` `#46566e`, edge links `#b3c0d2` → `#3c495e` |
| Outlines (darker local hue, no pure black) | silver `#161c25`, blue `#0f1a27`, ember brick `#0a0807` |
| Gold, hairline trim only | `#e6cf86` `#b8964a` `#7a6128` |
| Crimson, the wax seal only | `#ff6a78` `#b3202f` `#5e0d18`, sigil `#f3dc94` |
| Phosphor (visor, eyes and code scroll only) | `#7CFFB2` `#b9ffd8` `#ffffff` `#eafff3`, slot base `#06231a` |
| Cool rim light | `#a9c3ff` |
| Portrait-only environment (dim) | ember `#5e2e18` / `#32180e`, glow `#c06838` at 14 % opacity; furnace bounce on the lit left plates `#c9895a` at 34-50 %; wood `#3a3530` → `#141210`; brick `#2a2422`; boot mud `#3a3329` |

## Identity
- **Silhouette.** A slim, upright figure in a tall ogival great-helm, with a flared full lower rim and a narrow comb. Above the head is a **horizontal balance beam on a short post** (a wide T), with a shallow pan hanging from each end. The beam is wider than the halo, so the pans hang outside the ring's shoulders. No other bot has a bar over its head carrying two hanging dishes.
- **Signature prop.** The balance itself, which is the `L-plume`. Graduated beam (now about 11-15 px thick, up from 8-14), knife-edge fulcrum block, pointer, fine three-chain pan hangers. Each pan has a darker underside and holds a tiny ingot weight stamped `3F` and `A9`, together `0x3fa9`. In sleep it tips 7 degrees.
- **Halo.** A thick ring of 18 chunky chain links at radius 114, alternating face-on links with a see-through hole and edge-on bars (bars now 15 px thick, were 11), in blue-tinted steel. Each link is shaded by its own gradient (outer edge lit, inner edge dark), so the ring looks the same at any rotation. One link is replaced by a steel-blue enamel **assay tag with engraved marks (six ticks and a lozenge) and no letters**, so nothing on the spinning ring can read upside down. There is **no dark backing ring** any more (it showed as a grey smudge on light themes); the ring separates from dark themes by link value plus `L-aura`.
- **Visor / light slot.** One horizontal band, 98 x 22 (was 26) with chamfered outer corners. A **dark-steel middle bar** (6 wide, the visor frame's own ramp, kept dark so `L-face` stays near-black) splits the band between the eyes and runs into the frame. A **near-black brow wedge** (4 to 8 px, sloping down toward the nose) is painted over the top eye row so the eyes read as stern slits. Eye pattern (7x4, mirrored, 46 cells, 4 px grid), pupil moved one cell outward and the inner top corner cut:
  ```
  ++++++.
  +++##++
  .++##++
  ..++++.
  ```
- **Wear on the helm** (all clipped to the shell, in `L-helm`): 6 edge chips, 8 scratch grooves with pale lips, one dent on the dome, one on the bevor, a hairline crack above the brow band, rain-streak grime under the brow rivets.
- **Hang material.** Fine chains of alternating links carrying small stamped test weights, four distinct sway elements: knob weight `3f`, slotted disc `a9`, hex weight `c4`, ingot `1d`.
- **Code-as-liturgy.** Hex is stamped on the beam ingots, the hang weights, the brow cartouche (`0x3fa9…`) and the tabard hallmark strip (`0x3fa9…c41d`; portrait `· ok`). The halo tag no longer carries text (rule: no readable text on a spinning halo). Portrait only: the shelf labels follow a hex weight series (`0x01 … 0x32`), a floor weight is labelled `0x64`, the bench rail is carved WEIGH IT TWICE · SPEND ONCE.
- **Family mark.** Crimson wax seal with the Legion `>_` sigil, the only `L-token-1`, pivot `300 344`.
- **Portrait backdrop.** An assay office: ashlar wall, brick cupellation furnace on the left with a dim ember, shelves of graduated test weights on the right (labels now clear of the pauldron), a workbench, a small leaded window at the upper right, a floor line with a disc stack and a `0x64` weight.

## Portrait figure (fix round 1)
- **Coat:** six overlapping panels. Left side (light side): A in front of B in front of C. Right side: B' in front of A' and C'. Each overlap has a hard terminator and a cast-shadow band on the panel behind. Hems are irregular, with different depths. A dark back lining shows between the legs. Cool rim only on the right silhouette (A') and on the right-facing fold edge of B'; a warm furnace bounce on the left silhouette only.
- **Tabard:** two outer vertical folds, two diagonal pull-folds fanning from the belt buckle (lit lip, hard ridge line, shaded plane), one break-fold crease above the hem, an irregular torn hem with one notch.
- **Legs:** pointed knee-cops (lit plane and shaded plane on a ridge, crease, rivet, side wing on the outer side), greaves split by a shin ridge into a lit and a shaded plane, ankle cuffs, mud at the shin base, scratches. Two different wear variants so the legs are not twins.
- **Boots:** ankle cuff, two curved instep lames with hard shadows under their edges, a domed toe-cap with its own ridge, dark welt, toes splayed outward, mud splash, scratches, and a tight dark contact shadow under each boot plus the wide soft one.
- **Hands:** the under hand now has an articulated thumb (also in the bust).
- **Rim light** is made with `rim_edge()` in `parts.py`: the plate minus a copy of itself shifted 1.5-3 px, painted inside the plate by a mask. It is a crescent on the lit edge and cannot float off the silhouette. All the old detached `#a9c3ff` and `#c07a4a` polylines were removed (0 left in either file).

## Layer map (bust)
| layer | content | pivot |
|---|---|---|
| L-aura | soft steel-blue glow | – |
| L-halo-back | chain ring and assay tag | 300 232 (ring centre) |
| L-body | neck mail (wider), faulds, breastplate, steel-blue tabard with hallmark strip, belt, pauldrons, arms, clasped gauntlets with both thumbs (static) | – |
| L-plume | post, fulcrum, beam, pointer, chains, pans, ingots | 300 166 (crown socket) |
| L-helm | ogival shell with wear, flutes, comb, brow band with ticks and cartouche, visor frame, faceted bevor with vents, full flared rim with rivets, clipped right-edge rim light | 300 318 |
| L-face | slot glow, scanlines, `L-visor-shape` (absolute M/L/Z), eyes in a slot clip, middle bar, brow wedge | 300 318 |
| L-hang-1..4 | chain + stamped weight | each attachment point |
| L-front | two-lame standing collar (clipped rim on the right), clasp plate | – |
| L-token-1 | wax seal (the only token) | 300 344 |

- `data-crop="134 54 332 512"`, `data-crop-rail="134 54 332 332"`. Both hold the whole ring at any rotation, the beam and pans (also through the ±2 degree sway), the helm rim, the collar, the seal and the pauldron tops.

## Five idle behaviours (from shared primitives)
1. **Weigh it twice** (lean + plume tilt): the beam dips about 3 degrees left, settles, dips right, then centres. The eyes follow each pan (scan).
2. **Squint** (eye set + hold): the eyes switch to `narrow` for 1.5 s while the face dims 10 %. Then one slow blink.
3. **Tare** (stepped spin): the chain ring advances exactly one link (20 degrees) in a single eased tick, so the assay tag steps round like a counter.
4. **Check the weights** (wave): the hang weights swing one after another, left to right.
5. **Spend once** (nod + pulse): a single small nod with one visor pulse, after a long idle or a clean finish.

## Quips (dry, exact)
1. Weigh it twice. Spend once.
2. Claim noted. Not yet weighed.
3. The fee is wrong. By one satoshi. It matters.
4. Your test passes. Show me the one that fails.
5. Signed is not the same as verified.
6. That script is valid. It is also wrong.
7. Ran it again. Same hash. Now I believe you.
8. A promise is not a proof. Neither is a screenshot.
9. Change output missing. Somebody just paid a miner a tip.
10. Broadcast later. Read it first.
11. Assayed: sound. Stamped. Next.
12. I do not round. I check.
- Annoyed (five pokes): "Each poke is logged. None of them are tests."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is ignored** by `build-mascot.py`. After `crop = …`, add `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`. Then `createMascot(host, data, {rail: true})` should use `data.cropRail` for `vb` and `pct()`.
2. **`L-body` is used but not in the contract.** Add the row `L-body | optional | static (torso, tabard, arms) | – |`, paint order `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-N, L-front, L-token-N, L-halo-front`. The script and engine already handle it.
3. **Eye clip, and things painted over the eyes.** `L-eyes` sits inside one `clip-path` wrapper. The middle bar (dark steel gradient) and the brow wedge (near-black) are painted in `L-face` after the eyes. Contract wording to add: "L-eyes may sit inside one clip-path wrapper; near-black tracery (mullions, bars, brow lips) may be painted over the eyes inside L-face." The bar uses a dark steel gradient (`#46505f` → `#10151b`), which is the only non-black, non-light fill in `L-face`; the reviewer asked for it to read as part of the frame.
4. **The pans swing rigidly with the beam (exact engine fix).**
   - Facts. `L-plume` rotates about its pivot (300,166). Idle is -1.6° to 2.2°, sleeping is 7°. The pan suspension eyes are at (176,101) and (424,101). At 7° the left eye moves to about (185,86) and the right to about (431,117), so the eyes rise and fall about 15 px and the chains lean 7°. On a real balance the pans hang plumb from the moving eyes.
   - Why the art alone cannot fix it: any `L-hang-N` or other top-level layer is a sibling of `L-plume`, so it does not follow the beam ends. The pans must be nested inside the plume's transform and counter-rotated about their own eye.
   - Art change once the engine supports it: move each pan assembly (three chains, pan, ingot, label) out of `L-plume` into `<g id="L-part-1" data-parent="L-plume" data-pivot="176 101">` (left) and `<g id="L-part-2" data-parent="L-plume" data-pivot="424 101">` (right). Place both after `L-plume` and before `L-helm` in paint order. Two parts are needed because the two eyes move in opposite directions; one part cannot track both.
   - `build-mascot.py`, in the layer collection loop, add the parent to each layer: `layers.append({'id': lid, 'pivot': …, 'z': …, 'parent': el.get('data-parent') or '', 'markup': inner})`.
   - `engine.js`, in the `for (const L of data.layers)` loop, keep a map and nest by parent:
     ```js
     const layerEls = {};            // before the loop
     // in the loop, replace the parent selection with:
     let parent = float;
     if (L.parent && layerEls[L.parent]) parent = layerEls[L.parent];
     else if (RIG.has(L.id)) { /* existing rig code */ parent = rig; }
     // after creating the layer div:
     layerEls[L.id] = layer;
     ```
     The class becomes `mx-part mx-L-part-1` automatically (kind `part`), and `transformOrigin = pct(L.pivot)` already works because every layer box is `inset: 0` over the same crop.
   - `mascot.css`: drive the plume angle from a registered custom property so the child can read it, and counter it exactly:
     ```css
     @property --pa { syntax: '<angle>'; inherits: true; initial-value: 0deg; }
     .mx-plume { transform: rotate(var(--pa)); animation: mx-plume 4.6s ease-in-out infinite; }
     @keyframes mx-plume { 0%, 100% { --pa: -1.6deg; } 50% { --pa: 2.2deg; } }
     .mx-part { transform: rotate(calc(var(--pa) * -1)); }
     /* replace the sleeping rule: */
     .mx.mxs-sleeping .mx-plume { animation: none; --pa: 7deg; transition: --pa 1.6s ease; }
     ```
     The `hacking` rule (`.mx-plume { animation-duration: 1.6s }`) keeps working unchanged. `@property` is supported in Chromium (WebView2, Electron). If a target lacks it, the fallback is a `requestAnimationFrame` loop that reads the plume's computed matrix (`angle = Math.atan2(m.b, m.a)`) and sets `part.style.transform = rotate(-angle)`.
   - Cost: two extra layers that only rotate. Count them in the rail layer budget, or skip them in rail mode and keep the rigid pans there.
   - Until then, 7° in sleep is tolerable; the right pan then overlaps the right ring link by about 6 px. A per-bot sleep tilt of 5° (persona value) would remove most of it.
5. **The awaiting "!" badge covers the beam's right end (exact fix).**
   - Facts. The engine puts it at `hp + (R*0.78, -R*1.05)` with `R = min(cw,ch)*0.36`. For the Assayer that is (393, 106), right on the beam end and the right pan hanger. Any bot with a wide top element has this problem.
   - `build-mascot.py`: `out['badge'] = [float(v) for v in svg.get('data-badge').split()] if svg.get('data-badge') else None`.
   - `engine.js`: `const bp = data.badge || [hp[0] + R * 0.78, hp[1] - R * 1.05];` and use `translate(${bp[0]} ${bp[1]})` for the `fx-bang` group.
   - Art: add `data-badge="446 322"` to the root of `assayer.layered.svg` (right of the shoulder, below the ring, inside both crops; 17 px radius clears the ring, the pauldron and the beam). I have not added the attribute yet because the current engine ignores it; add it with the engine change.
6. **The halo's soft dark backing ring** is gone from the art (fixed here). No engine change needed any more.
7. **Victory flare** (brightness 2.2) pushes the silver chain nearly white for about 0.3 s. Acceptable here (the ring is now lighter, so slightly more so), but it should become a persona value (`haloFlare`).
8. **BSV toggle visibility** is app logic. Add a per-bot `requires: "bsv"` flag in the persona or roster, never in the SVG.
9. **Mask use in `L-body`.** The rim light uses a few `<mask>` elements inside `L-body` and `L-front` (ids `asy-rm*`, prefixed by the build script like any other id). The build script and engine handle them; the contract should say masks are allowed inside a layer, if it does not already.

No shared files, references, the build script or the engine were modified.

## Still weaker than Zealot (honest)
- **The portrait is quieter and less heroic.** Silver on steel-blue on a dark office, no single bold value accent apart from the visor and the seal. The window shaft is stronger than before but still falls on the wall, not across the figure.
- **The cloth is better but still tidy.** The coat has real overlapping panels, but the drape is long and fairly regular. The pull-folds are drawn as clean spindles, and the break fold is one crease, not a heap of bunched cloth. Zealot's cape has more planes and more value range.
- **The legs are short.** The tabard hem still covers most of the thigh, so the visible leg is only about 115 px: knee, shin, boot. The boots now have mass (toe-cap, lames, welt), but they are simple next to Zealot's sabatons.
- **The plate is drawn, not fully painted.** Pauldrons and couters have shading, roped edges and rim crescents, but less variety of material than Zealot's.
- **Proportions in the bust.** A big head and beam over a narrow body still lean a little toward toy-robot at 200 px. The brow wedge, harder eyes and wear help a lot, but the silhouette is the same.
- **At 48 px** the ring now reads as a lighter beaded band, still not as individual links. The pans are about 7 px wide and are readable as two blobs on the bar.
- **The shelf weights and floor props** are simple, flat cylinders.

## Fix log (round 1)
Reviewer file: `/home/claude/reviews/assayer.md`. Evidence images are in the deliverables folder unless noted. "Before" renders are in `/home/claude/pilots/assayer/fx/` (`p0.png`, `b0.png`).

### Blocking
1. **Portrait cloth and plate flat.**
   - Coat, 4-5 overlapping panels with a hard terminator, darker shade each, 1.5 px `#a9c3ff` edge on right-hand lit edges only: **FIXED**. Six panels, hard terminators and cast-shadow bands, cool rim only on the right silhouette and B' fold edge. See `detail-portrait-lower.png`.
   - Tabard, 2 diagonal pull-folds: **PARTLY**. Both are present (lit lip, ridge, shade) but read as clean spindles. Break fold above the hem: **PARTLY** (one crease). Irregular hem: **FIXED** (torn notch, uneven drops).
   - Greaves, knee-cop with crease, shin ridge with hard left/right split, wear: **FIXED** (`detail-portrait-lower.png`).
   - Sabatons, one toe-cap plus 2 articulated lames, ground contact shadow: **FIXED**. Toe-cap, 2 lames, ankle cuff and welt; tight contact shadow under each boot.
   - Missing thumb on the under gauntlet: **FIXED** (portrait and bust; `detail-portrait-upper.png` shows the clasp only small, see `fx/hand1.png`).
   - Overall, "Zealot-grade": **NOT claimed**. See `portrait-vs-zealot.png`; the Assayer is much closer in structure but still quieter.
2. **Grey smoke ring on light backgrounds.** **FIXED.** Backing ring deleted from `parts.halo()`. `engine-states.png` (lower half, light) shows no dark halo around the ring in any state, and `sleeping` no longer looks dirty. On dark the ring still separates (link values lifted about 25 %).
3. **Toy-robot at 200 px.**
   - Heavier near-black brow lip over the top eye row: **FIXED** (wedge over the top row; `detail-bust-helm.png`, `engine-states.png`).
   - Slot padding 26 → about 22 px: **FIXED** (slot is 22 px, eyes 16 px, `L-visor-shape` and the clip and recess updated to match).
   - Pupil one cell outward: **FIXED** (columns 4-5 → 3-4, plus inner top corner cut; eyes no longer cross).
   - 6-10 edge nicks, scratches and one dent: **FIXED** (6 chips, 8 scratches, 2 dents, one crack, grime streaks; `detail-bust-helm.png`).
   - Middle bar tinted to read as part of the frame: **PARTLY**. It is now a dark-steel gradient with a pale edge, not a flat near-black bar. I kept it dark so `L-face` stays near-black (contract), so it is not as light as the frame.
   - Whether the whole bust still leans toy-robot: **PARTLY**. It reads clearly sterner and more worn at 200 px (`engine-states.png`), but the proportions are unchanged.

### Non-blocking
- Halo weak rail carrier: **PARTLY.** Edge bars 11 → 15 px, link mid value up about 24 % (`#6e7f99` → `#8a9db9`). In `rail-test.png` the grey ring is visibly stronger; at 48 px it is still a beaded band, not a bold ring.
- Beam at 48 px: **PARTLY.** Beam ends 8.4 → 11.6 px thick (centre 14 → 15.4), pan underside darkened. At 48 px it is a 1-2 px line plus pan blobs, as before but a little stronger (`rail-test.png`).
- Under hand has no thumb: **FIXED.**
- Backdrop clash (shelf labels hidden behind the pauldron, sliced `0x32`): **FIXED.** All rows now start at x 444, pitch 24 (`detail-portrait-backdrop.png`).
- Warm accents: **No change needed.** The furnace is unchanged (`#c06838` at 14 %). I added a warm furnace bounce `#c9895a` (34-50 %) on the left silhouette edges of the lit plates and left coat panel, outside `L-face`.
- Specular strokes, dotted pauldron rim to about 0.35: **FIXED** (bust and portrait, 0.6 → 0.35). The other low-opacity white hairlines stay; the review accepted them.
- Rim light on the right, on the helm and right pauldron: **FIXED.** The helm's old rim stroke never rendered (bug: the `RIM` colour constant was shadowed by the rim path variable). Now a clipped, fading rim on the helm's right edge and flared rim, and clipped crescents on the right pauldron, couter, collar, breastplate, tabard, coat, right leg and right boot. No detached `#a9c3ff` or `#c07a4a` polyline is left in either SVG (grep count 0).
- Portrait is quiet, window shaft across the figure: **NOT FIXED** (only the shaft's strength was raised, to 0.24 / 0.9). It still falls on the wall.
- Victory, neck mail narrower than the rim: **FIXED.** Neck mail 52 → 60 px half-width, rows -13..13 (about 8 px more each side). `engine-states.png` victory: no light gap beside the mail.

### Contract and engine notes in the review
- Pans counter-rotation: exact engine and CSS fix is recorded above (problem 4). Art not changed, because the current engine would render pans detached.
- `awaiting` badge on the beam end: exact fix recorded (problem 5). `data-badge` not yet added to the art for the same reason.
- Halo rule from the fix brief: rotation-invariant ring (yes), inside `data-crop` at any angle (yes, rendered at 7 angles), no readable text that can turn upside down (the `3FA9` tag text was removed), readable on light backgrounds (yes, `engine-states.png`).
- Rebuild: `build.sh` passes, 12 layers, ids and pivots unchanged. `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png` and the detail crops were regenerated; `assayer.json` copied.
