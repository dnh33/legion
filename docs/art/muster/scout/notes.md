# Scout (Legion muster): painter's notes

Files in this folder:
- `scout.layered.svg`: the animated bust (63 KB).
- `scout.portrait.svg`: the portrait, 600 x 800 (103 KB).
- `scout.json`: the bust built by the real `build-mascot.py`, unchanged (80 KB, 13 layers).
- Proofs: `rail-test.png` and `rail-test-48zoom.png`, `portrait-vs-zealot.png`, `engine-states.png` (dark and light backgrounds), `detail-helm.png`, `detail-mapcase-seal.png`, `detail-portrait-map.png`, and for the fix round `fix-before-after-halo-case.png` and `fix-before-after-portrait.png`.

Generator: `/home/claude/pilots/scout/gen_scout.py` is the only generator. It writes both SVGs. `proofs.sh` rebuilds everything and re-renders every proof. `railsheet.py` and `cmp.py` are proof helpers only.

**Build:** `build.sh scout scout.layered.svg` passes with the script unchanged. Layers, in order: aura, halo-back, body, plume, helm, face, hang-1..5, front, token-1.

## Palette
| role | hex |
|---|---|
| Dusk blue-grey cloth (cloak, the dominant mass) | `#8191ad` `#62718e` `#485673` `#343f56` `#242c3d` `#161c28`, outline `#0c1018` |
| Dusk steel (helm, pauldron, gauntlets, caps) | `#c9d3e0` `#9aa8bb` `#71809a` `#505d72` `#343d4d` `#1f2530`, outline `#0e1219` |
| Ash (scarf, tags) | `#dedbd3` `#b9b6ae` `#8f8e89` `#666870` `#41454d`, cloth outline `#34342f` |
| Secondary hue: muted olive, used for the gambeson (second colour mass), the map case, the halo, the scarf stripes and the cloak lining | `#b7b37e` `#959264` `#75734a` `#535233` `#36351f`, outline `#201f12`; gambeson `#6c6b3e` `#4f4e2e` `#33321d` |
| Halo (olive brass, dimmed) | `#b9b583` `#8d8a5d` `#55532f`, engraving `#2c2b18` |
| Map paper (cool ash, not warm bone) | `#d8d4c6` `#bfbaa8` `#9a9584`, ink `#2a2f3a` |
| Dusk leather (strap, belt, bracers) | `#4a4f58` `#30343c` `#1e2127`, outline `#101216` |
| Brass, sparing (rivets, compass bezel, feather clasp) | `#efdc9c` `#c4a65a` `#7a6430` |
| Crimson, wax seal only | `#ff6a78` `#b3202f` `#5e0d18`, sigil `#f3dc94` |
| Phosphor (slit, eyes, the `[?]` guess mark only) | `#7CFFB2` `#b9ffd8` `#ffffff`; slit interior `#0d3a26` to `#03100a`; ink-green `#2a8a5a` for the guess mark on paper |
| Cool rim light (right only) | `#b4c9e6` |

No amber, no red identity colour, no gold mass. Olive is yellow-green-brown at moderate saturation, so it does not read as Builder's verdigris-teal or Sculptor's dim green, and it never reads as "thinking" green.

## Identity
- **Silhouette:** the most sideways and asymmetric bust in the roster.
  - The scarf streams right as a pale horizontal bar.
  - The map case pokes out up and left across the ring (in front of it).
  - A barred feather sweeps up and right from the cap.
  - The cloak is thrown over the left shoulder; the right shoulder has a light pauldron.
  - At 48 px greyscale it reads as a compact cocked cap, a thick closed ring with four short points, a white streak to the right and a short diagonal tube to the left.
- **Helm:** a complete small skullcap of two lapped plates. Its rim band is cut on a slant, low over the left eye and lifted on the right: the cocked brow.
  - Below the cap is a tapered mask with a centre ridge, a full rolled lower rim with three rivets, and a slanted row of cheek vents on the right only.
  - A single ear disc on the left carries a struck compass rose. It is not a hood.
- **Light slot:** a narrow slanted slit cut into the mask as a recess, `M260,174 L352,166.5 L340,192.5 L248,199 Z`.
  - It is a parallelogram that rises about 4.7 degrees to the right, with ends sheared about 25 degrees, 25 units tall.
  - The lower lip catches the key light and the upper wall is in shadow.
  - It is clearly not the Inquisitor's level 88 x 18 slit or the Builder's rectangle.
- **Eyes:** 7 x 4 per eye, mirrored, 42 cells, set close together (8 px gap) for a keen look, not a cute one. The pattern is half-lidded: a flat glow lid line, a 5-wide core, then a 3-wide core. It reads deadpan and appraising.
  ```
  .++++++
  +#####+
  .+###+.
  ..+++..
  ```
- **Halo (fix round):** a full, closed compass ring in dimmed olive brass, built to be rotation-invariant because the engine spins this layer. R 116, a 19-unit band (was 10), an inner bearing ring at R 99.
  - The band is a radial bevel about the ring centre (dark inner edge, lit outer shoulder), so no light direction turns with the layer. No offset shadow, no linear overlay, no letters.
  - Graduations every 5 degrees, longer every 15, all the way round.
  - Four equal needles (N, E, S, W, 26 units proud of the band centre line; the old N needle was 40) on four equal raised plates with brass rivets, and four short intercardinal points. The figure repeats every 90 degrees, so a spin looks the same at every quarter turn. There is no longer a gap or a marked north.
  - Needle-tip radius is 142 around (300, 178). Measured: no pixel beyond r 145 at 0, 30 and 45 degrees, and a 0 vs 90 degree render differs by 0.01 grey levels on average.
  - The map case now sits in front of the ring (L-body paints after L-halo-back).
- **Signature prop (fix round):** a sealed rolled-map case of waxed olive canvas, slung across the back on a leather strap that carries a small brass-bezel compass at the chest, with the needle on 041. No spyglass and no optics.
  - The top end is a flat steel lid with a solid end face (no bore), a lid seam and lip line, and a brass ring pull on a staple.
  - A curled edge of map paper pokes out of the lid seam, so the prop is a map case, not a launcher. (The lower end is under the cloak and is not shown.)
  - Two leather straps: the first carries the cord ring, the second a brass buckle.
  - The visible tube is about 25 percent shorter: the cap end moved 30 units in along the axis, and the tube is 120 long (was 150).
- **Family mark:** a pressed crimson wax seal with the `>_` sigil, hanging on a short cord from the first case strap, beside the shoulder at (170, 286). It is the only `L-token-1`. The cord end runs behind the seal, so cord and seal cannot visibly part during the flutter.
- **Hang strips (5):** two pale ash scarf tails with olive woven stripes and frayed ends (hang-1, hang-2), the map case's carrying cord with a steel toggle (hang-3), and two steel bearing tags (hang-4 under the compass: `041 / deg mag`; hang-5 from the pauldron: `3/3 / src ok`).
- **Code-as-liturgy:** coordinates, bearings and citation footnotes, kept small:
  - Bust: a folded map tucked under the strap. It reads `55.68N 12.57E`, `brg 041 [1]`, `ridge [2]`, `pass? [?]`, and has a dashed bearing route. Only the `[?]` is green: the guess is marked as a guess.
  - Bust: the cap band is engraved `brg 041 . src [1][2][?]`.
  - Portrait: the half-unrolled map in the right hand carries contours, a river, a station with two bearing rays and an angle arc, `041`, `[1]`, `[2]`, and a circled green `?`.
  - Portrait: survey graticule labels in the sky, a dashed `brg 041` line to a trig pillar whose plate reads `041 TRIG`, and two `[1]` `[2]` tags on the belt.
- **Portrait backdrop:** a ridge-line lookout at dusk.
  - Three layered ridges with lit crests and valley haze.
  - A dim moon with limb darkening, set low and to the right beside the figure (not behind the head), which motivates the cool rim light.
  - A stone cairn with a pole flying a wind-torn ash banner (olive band, compass device, torn holes) that streams the same way as the scarf.
  - A trig pillar on the right, and a rock ledge as the floor line, with a lit lip and the figure's cast shadow.
  - No arch, window, candles, lattice or shelves.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | soft dusk glow | – |
| L-halo-back | compass arc | 300 178 (ring centre) |
| L-body | map case (behind), gambeson, right sleeve, cloak, pauldron, gorget, seal cord; faded out from y 462 to 532 | – |
| L-plume | barred feather on its cap clasp | 351 126 (clasp) |
| L-helm | skullcap, cocked rim band, mask, slit recess, lower rim, ear disc | 300 262 |
| L-face | slit light, scanlines, `L-visor-shape`, eyes inside a slit clip | 300 262 |
| L-hang-1, 2 | scarf tails | 340 262 / 342 274 (the knot) |
| L-hang-3 | case cord and toggle | ring on the first case strap |
| L-hang-4, 5 | bearing tags | under the compass / pauldron edge |
| L-front | strap and D-ring, folded map, compass, scarf wrap and knot | – |
| L-token-1 | wax seal (the only token) | 170 280: the alarm glow (pivot + 6) lands on the seal centre, 170 286 |

`data-crop="124 14 386 516"`. `data-crop-rail="150 14 336 336"` (was 122 10 362 362) holds the whole halo at any rotation (needle-tip radius 142 around 300 178: 7 units clear on the left, 35 on top), the feather tip, the case cap, the seal, the collar, the shoulders and the scarf tip (x 483 against the edge at 486).

**Engine check:** all 8 states through the real `engine.js` and `mascot.css`, on dark and light backgrounds (`engine-states.png`).
- Recolouring stays on the slit.
- The code scroll is clipped to the slant.
- The alarm glow sits on the seal.
- Victory shows `^ ^`.
- In error, the helm leans and the slit flickers red.
- In sleep, the helm sinks behind the scarf wrap.
- The helm stays complete in every state.

## Five idle behaviours (verbs from shared primitives)
1. **Take a bearing** (stepped spin): the halo eases 15 degrees off, then clicks back to true north in two steps.
2. **Side-eye** (scan and hold): the eyes slide fully to one side, hold for 1.5 s, blink once, then return. The look that says "one of these is lying".
3. **Gust** (wave and flutter): both scarf tails and the feather flutter fast together for about 1 s, then settle. Hang-3 follows half a beat late.
4. **Check the map** (nod and eye set): a 2-degree dip toward the chest, with `narrow` eyes for 1 s.
5. **Cocked brow** (lean and eye set): the rig tilts 2.5 degrees toward the lifted side of the cap, with one beat of `narrow`. It is the skeptic's tilt, used after a quip.

## Quips (wry, observant)
1. Three sources. Two agree. One is lying.
2. Short answer: no. Long answer below, with footnotes.
3. That is a guess. I have labelled it as one.
4. The docs say yes. The code says no. The code wins.
5. Read the whole thread. You want the third reply.
6. Confidence: medium. Sources: excellent.
7. Nobody has tried this. Or nobody wrote it down.
8. Citation needed. I checked. Still needed.
9. The changelog and the release notes disagree. Again.
10. I did not touch anything. I only looked.
11. Last updated 2019. Treat it as folklore.
12. Found it. Page four, footnote two.
- Annoyed (five pokes): "Poking is not a primary source."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is ignored** by `build-mascot.py` (same as both pilots).
   - Fix: after `crop = ...`, add `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop` (and include it in `out`).
   - The engine then needs a `{rail: true}` option that uses `data.cropRail` for the viewBox and the pivot percentages.
2. **`L-body` is not in the contract.**
   - Add the row `L-body | optional | static (torso, cloak) | – |` and the paint order `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-N, L-front, L-token-N, L-halo-front`.
   - The build script and the engine already handle it.
3. **A slanted light slot and the level eye grid.** The contract keeps the eyes axis-aligned and mirrored on the same rows, so a slanted slot clips them unless it is tall enough.
   - Add this rule: "a slanted slot must be at least 16 + (rise across the eye span) + 4 units tall; wrap `L-eyes` in one clip-path group set to the slot".
   - The Scout uses a 25-unit slot with a 4.7-degree rise and a 64-unit eye span. The eyes clear it by about 1 to 3 units at rest. In `thinking` (eyes up 4 px) the top glow row of the left eye is trimmed by about 1 unit. In `listening` (down 3 px) the bottom row of the right eye is trimmed by about 2 units. Both read as a squint, which suits him; no change needed.
4. **`L-eyes` inside a clip-path wrapper** works unchanged (the script finds `L-eyes` by id and appends the sets inside it), as on the Inquisitor. Contract wording: "`L-eyes` may sit inside one clip-path group".
5. **`L-visor-shape` must use absolute M/L/C/Q/Z only**, because the script reads the path numbers as x,y pairs. The Scout's slot is M/L/Z only.
6. **The victory flip mirrors the `>_` on the seal** for about 0.45 s (as on the Relic). Proposal: per-token `data-flip="none"`, so text-bearing tokens only flutter.
7. **Victory flare:** brightness 2.2 settling at 1.25 turns the olive-brass halo a pale yellow-brass for the first beat. It is not white and it is not amber, but a per-bot `haloFlare` (about 1.12 for the Scout) would keep it olive.
8. **Clip paths defined inside layer markup** (the feather vane and the scarf tails each carry their own `<clipPath>`) are prefixed correctly by the build script. Worth noting in the contract as allowed.

No edits were made to the references, the build script or the engine.

## Still weaker than Zealot (honest)
- **The portrait is quieter.** Dusk blue-grey and olive are muted by the brief, so there is no single saturated mass like his crimson, and no bright value accent as large as his bone tabard. The map paper and the scarf carry the light values. The figure reads clearly at 300 px but not heroically.
- **The cloth is drawn planes,** not painted cloth. The cloak now has four wedge-shaped fold planes with hard terminators on the left mass, but they are vector wedges, not the soft overlapping cloth of Zealot's cape. The gambeson quilting is a regular pattern.
- **The moon is still a simple disc** (darker, with limb darkening and a few soft craters), not a rendered surface.
- **The hands are simple gauntlets.** The fist on the strap is small. The map hand now has the back of the hand, three visible fingers wrapped over the top edge and a thumb in front, but it is still a stylised mitt.
- **The legs and boots are plain.** The greaves and knee cops are clean shapes, and the front-view feet are rounded blocks with a sole and heel line.
- **At 48 px, the slit's slant does not resolve.** It reads from 64 px @2x. At rail size the identity is carried by the cocked cap band, the open compass ring with its north needle, the white sideways scarf and the diagonal case.
- **Small text is texture below full size.** The folded-map lines and tag text are 4.2 to 5.2 units, legible at full size only. The tag sub-labels (3 units) are texture on purpose.

## Fix log (round 1, after the adversarial review)

Evidence files are in this folder. A work-folder note: `/home/claude/pilots/scout/gen_scout.py` is still the only generator and emits exactly the delivered SVGs (checked by regeneration and byte comparison); `proofs.sh` rebuilds everything.

**Blocking**
1. **Map case reads as a bazooka: FIXED.** Flat steel lid with a solid end face (no bore), lid seam and lip line, brass ring pull, curled map paper poking out of the lid seam, two leather straps (ring, brass buckle), visible tube about 25 percent shorter, same shared drawing in the portrait. See `detail-mapcase-seal.png` and `fix-before-after-halo-case.png`. One deviation from the review: the review asked for paper at the lower end, but the lower end is under the cloak in both the bust and the portrait, so the paper pokes out of the lid seam instead. The cap is a sealed disc, so the "launcher" read of the open bore is gone; it still reads as a cylinder at 48 px, and the olive canvas, strap and paper curl are what say "map case" from 64 px at 2x upward.
2. **Halo too thin: FIXED.** Band 10 to 19 units, edge value lifted (inner `#6d6b41`, shoulder `#d0cc9e`, still far dimmer than the visor), needles cut from 40/26/26/22 to four equal 26, rail crop tightened 362 to 336 (head about 8 percent larger at 48 px). At 48 px the ring is a clear 3 px band in colour and grey (`rail-test-48zoom.png`, `fix-before-after-halo-case.png`). Rotation-invariance: the ring is now closed, the bevel is radial, the letters N E W S, the offset shadow and the linear light overlay are gone. What is left is 4-fold symmetry (needles and plates at 90 degree steps): a render rotated by 90 degrees differs by 0.01 grey levels on average, and nothing lies beyond r 145 at any tested angle. It is not invariant under arbitrary angles, because the four needles and plates are what shows the spin. If a strictly featureless spin is wanted, delete the needle and plate loop in `halo()`; the ring stays.
3. **Portrait right arm has no upper arm: FIXED.** A sleeve now runs from under the pauldron to the elbow cop: vertical channel stitching (not the torso diamonds), lit plane on the key side, hard terminator on the shadow side, shadow under the pauldron lames, compression wrinkles, a leather cuff band with two brass studs, and a cast shadow on the torso; the torso quilting is darkened beside it. Right hand: back of the hand above the paper's edge, three fingers wrapped over the top edge, thumb in front on the paper, with its cast shadow. See `fix-before-after-portrait.png`, `detail-portrait-map.png`. The fourth finger is hidden behind the thumb.
4. **Hard haze rectangles and the trailing glow: FIXED.** The ridge haze and the floor haze now carry a vertical feathered mask (`sct-hazeM`), so no band has a straight edge (checked on a gamma-lifted crop). The blurred rim stroke that trailed off the cloak hem is deleted. The cloak-back rim is now an inner band clipped to the silhouette plus a crisp edge line that stops at the same point. Also removed the dark bar behind the map hand (a cloak fold that started with a flat top edge) and a detached rim line beside the trig pillar.
5. **Portrait finish and proportions: PARTLY.**
   - Cloak: FIXED in kind. Four overlapping wedge planes on the left mass, each with a lit face, a hard terminator and a shadow strip, plus the existing lit edge on the key side only.
   - Value accents: FIXED. A bright band along the pauldron's top and outer lames, a brighter clipped rim band along the cloak's right edge.
   - Proportions: FIXED in part. The gambeson skirt is 30 px shorter, there are steel cuisses on the thighs, and the greaves are 25 percent wider. The head was not enlarged (the review did not list it as a fix), so the figure is still a little small-headed.
   - Moon: FIXED. Moved lower and to the right (centre 494, 318, radius 98 against 118), about 20 percent darker, with limb darkening; it no longer sits behind the head as a second halo.
   - Overall it still looks like clean vector illustration, not painted metal and cloth. The Zealot gap in finish is not closed; see the list below.

**Non-blocking (cheap ones done)**
- Seal isolated at the far left: FIXED. It now hangs from the first case strap beside the shoulder (x 170 against 150), inside the rail crop and tied to the figure.
- Seal cord static against a fluttering token: FIXED. Shorter cord, its end runs behind the seal.
- Halo letters upside down: FIXED (letters removed).
- Compass bezel glint pure white: FIXED (`#f4ecd0`).
- Trig pillar clipped by the canvas edge: FIXED (pulled in 12 units; its right edge is now inside the frame).
- Incidental: the shared blur filters now use a fixed large user-space region, so thin blurred strokes are no longer clipped to their own bounding box (this removed faint straight edges beside the folds). Rendering is otherwise unchanged.
- NOT FIXED, left as they were: eyes reading slightly "bowl", the ear disc, the slit's slant at 48 px, the scarf and wrap merging at 48 px, the quilting regularity, the left-hand bracer, the thin boot shadow.

**Rebuild:** `build.sh scout scout.layered.svg` passes, 13 layers, the delivered `scout.json` is byte-identical to the build output (it grew from 80 to 81 KB). Both SVGs parse as strict XML. Bust 63 KB, portrait 103 KB. States rendered through the real engine on dark and light (`engine-states.png`): helm complete, recolouring confined to the slot, alarm glow on the seal, no artefacts.

**Contract or engine changes needed by this round:** none new. The existing proposals still stand (`data-crop-rail` is dropped by the build; `L-body` is outside the contract).
