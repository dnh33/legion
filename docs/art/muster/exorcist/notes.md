# Exorcist (Legion muster): painter's notes

Files in this folder:
- `exorcist.layered.svg`: the bust, 88 KB.
- `exorcist.portrait.svg`: the portrait, 600x800, 191 KB.
- `exorcist.json`: the build output, 131 KB (rebuilt in the fix round).
- Proofs: `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png` (dark and light backgrounds).
- Fix-round proofs: `before-after-figure.png`, `before-after-bust.png`, `detail-hands-boots.png`, `detail-right-arm.png`, `detail-visor.png`.
- Detail crops: `detail-helm.png`, `detail-bell-seal.png`, `detail-hem-litany.png`, `detail-portrait-figure.png`, and the full portrait render `exorcist-portrait-full.png`.

Generators live in `/home/claude/pilots/exorcist/`:
- `gen.py`: the bust and shared parts.
- `portrait.py`: the scene and figure. It imports `gen.py`.
- `railtest.py`: the proof sheet.

These are the only generators, and they are current (fix round: stale intermediate scripts deleted).

Build: `build.sh exorcist .../exorcist.layered.svg` runs the real `build-mascot.py` unchanged, and it **passes**. It produces 12 layers: aura, halo-back, body, plume, helm, face, hang-1..4, front, token-1.

I checked these programmatically:
- Strict XML on both SVGs.
- Every id is `exo-*` or `L-*`, with no duplicates.
- No `<style>`, `<script>`, `<image>`, `<foreignObject>` or `on*` attributes.
- `L-visor-shape` uses absolute M/L/Z only.
- The eyes are 50 cells on the 4 px grid, mirrored, filled only with `#ffffff` and `#b9ffd8`.

## Palette
| role | hex |
|---|---|
| Charcoal cloth (dominant) | `#0c0d0f` `#141619` `#1c1f23` `#262a2f` `#33373e` `#3b3f46` |
| Blackened steel | `#08090b` `#121418` `#1d2026` `#2e333a` `#4a5059` `#6c737e` `#a3abb6` |
| Bone / salt | `#5c5548` `#8a8270` `#b3ab96` `#cfc7b2` `#e6dfcc` `#f1ebdb` |
| Secondary hue: cold ash-grey (the only one; now also the halo and the portrait's second mass) | `#39414a` `#56606a` `#6c7580` `#7d8792` `#8b949e` `#97a0ab` |
| Bell pewter (prop) | `#9aa1aa` `#6b727b` `#363b42` |
| Cool rim light (clipped inside each owner, right side only) | `#aac4dc` |
| Phosphor (visor, eyes only) | `#7CFFB2` `#b9ffd8` `#ffffff` `#eafff3` |
| Wax seal (the only crimson) | `#ff6a78` `#b3202f` `#5e0d18`, sigil `#f3dc94` |

There is no gold anywhere, and no amber or red as an identity colour. Outlines are dark local hues (`#07080a` steel, `#08090a` cloth, `#4a463b` salt, `#4d473a` bone), never pure black.

## Identity
- **Silhouette:** a true church-bell helm on square shoulders: a narrow crown, a concave waist, and a hard flare to a full lip that is wider than the neck. This lip is the identity line at 48 px. In the portrait the body repeats the bell: narrow shoulders (the capelet is 1.55x the helm lip), a cinched waist, a flared charcoal chasuble over a flared ash alb that piles on the floor. The Exorcist has no hood (the Inquisitor's cowl has none of this outline).
- **Visor / light slot:** a slender horizontal eye-arm with pointed tips, crossed by a much thinner and dimmer vertical slit. The slit is short above the arm (about 14 units) and longer below (about 42 units).
  - The eye-arm carries all the light. The vertical slit (fix round: fill 40%, glow 14%, upper stub shortened from 24 to 14 units) is a dim keyhole seam with a 1.2-unit full-brightness core line.
  - My round 1 had a bright, even cross, and it read as a pharmacy "+" at 48 px. I fixed that in round 2.
  - The visor has no top stub like Zealot's T. It is not a flag cross and not a medical cross.
- **Halo:** a thick (25-unit) salt ring, fix round: recoloured from bone to cold ash-grey (`#39414a` to `#7d8792`, about 30% darker than before, off Scribe's bone-silver), with a 34-degree break.
  - The ring is a granular crystalline band: jagged inner and outer edges, low-contrast facets attached to the ring, and a broken incised groove along its middle. The gap ends are crumbled teeth.
  - The shading is radial (inner edge dark, mid band light), so it does not swing when the ring rotates.
  - Unlike Scribe's arch, which is open at the bottom by 144 degrees, this ring is nearly closed and the break sits off-axis. Unlike the Inquisitor's, it is not thin, silver and closed.
- **Signature prop:** a small handbell with a turned bone handle, a blackened pewter body, a bone lip, a stitched inscription band and a visible clapper. In both the bust and the portrait, a gauntleted fist holds it by its cord at chest height (portrait fist: four separate finger plates and a thumb).
- **Family mark:** the crimson wax seal with the `>_` sigil, threaded on the bell cord just under the fist. It is the only `L-token-1`.
- **Hang strips:** prayer-bead cords. They use ash and steel beads with every fifth bead in bone, and end in either an ash linen salt pouch (bone drawstring and a crystal peeking out) or a bone tag (`#42`, `EOF`).
- **Code-as-liturgy:**
  - Main piece: a stack-trace litany embroidered in charcoal thread on the bone hem band: `at parse() line 42 · at load() line 7 · at main() line 1 · amen`. It is 5.6 px in the bust and 6 px in the portrait.
  - Echoes:
    - A bell inscription cast round the helm's shoulder: `REPRO · NAME · CAST OUT` (5.8 px, about 3.9 px in the portrait).
    - Stoles embroidered with debugger breakpoint rings. The chalk text on the piers is now 9 units (about 4.5 px at 300 px wide).
    - The broken-ring emblem on the portrait's orphrey.
    - A chalked call stack round the floor circle (`#0 parse()` ... `#3 ???`).
    - Chalk on the crypt piers: a tally of 14 marks with `cast out`, and `line 42`.
- **Salt crust:** a few low-contrast bone deposits caught in the helm's lower mouldings. The bell has been working.
- **Portrait backdrop:** a crypt bay.
  - Architecture: a heavy round arch of voussoirs on squat piers with cushion capitals, with receding rib arches inside.
  - Window: a small barred window high in the right spandrel, outside the halo's field. It throws a cold shaft down to the left and a barred patch of moonlight on the floor.
  - Floor: flagstones, a floor line, and a thick chalk-and-salt circle round the figure, drawn in two halves so the back arc passes behind the legs and the front arc in front of the feet.
  - It has no candles, no pointed window and no lattice, so it is distinct from Zealot and both pilots.
- **Light:** the key light comes from the upper left. The single cool rim light is on the right (helm, capelet, sleeve, chasuble, alb).

## Layer map (bust)
| layer | content | pivot |
|---|---|---|
| L-aura | ash glow and a faint green under the visor | – |
| L-halo-back | the broken salt ring | 300 196 (ring centre) |
| L-body | gorget, pauldron lames, ash scapular, capelet with stole and the litany hem band (static) | – |
| L-plume | the bell's canon loop with bone binding and a hanger ring | 300 110 |
| L-helm | complete bell: crown cap, shoulder mouldings with the inscription, waist moulding and rivets, raised visor frame, sound-bow mouldings, full flared lip with bone inlay | 300 300 |
| L-face | arm glow, dim vertical seam, scanlines, `L-visor-shape`, and `L-eyes` inside a clip of the visor shape | 300 300 |
| L-hang-1..3 | bead cords (pouch, tag `#42`, tag `EOF`) | 163 394 / 203 419 / 444 360 |
| L-hang-4 | bell cord and handbell (it sways from the fist) | 362 433 |
| L-front | right arm: rerebrace, couter, vambrace, bone cuff, fist | – |
| L-token-1 | the wax seal | 362 440 (the engine's alarm glow, pivot + 6, lands on the seal's centre at 362 446) |

- `data-crop="134 44 332 478"`.
- `data-crop-rail="144 40 312 324"`. This crop holds the whole ring at any rotation (outer radius about 151 round 300 196), the canon, the helm lip, the collar and the shoulder line.
- The torso fades out at the bust's lower edge through a mask, as Scribe's does.

**Eyes:** a heavy-lidded base. The flat glow lid row and the narrowing core read as calm and unimpressed; the engine's expression sets still read in every state (see `engine-states.png`).
```
+++++++
+#####+
++###+.
.+++++.
```

## Five idle behaviours (engine verbs)
1. **Toll** (swing + pulse): `L-hang-4` swings one wide arc of about 10 degrees, and on the return the face pulses to 1.2 brightness once. One ring, no repeat.
2. **Salt the circle** (stepped spin): the halo turns exactly to put its gap at the top, holds 1.5 s, then resumes its slow spin. It is checking for a breach.
3. **Name it** (eye set + nod): the eyes switch to `narrow` for 1 s, then one small nod, as if a verdict had been reached.
4. **Count the beads** (wave): hangs 1 to 3 flutter in sequence, left to right, at low amplitude.
5. **Listen to the bell** (lean + hold): a 2-degree lean toward the hand that holds the bell, with the plume still for 2 s and blinking suppressed. Then back.

## Quips (grim, dry)
1. Name the bug. Then it leaves.
2. It reproduced. Good. Now it is mine.
3. Line 42. It is always line 42.
4. Do not panic. Panic is not a stack frame.
5. I have seen worse. I have buried worse.
6. The bug is not haunted. It is uninitialised.
7. Salt the inputs. Trust nothing that comes in at night.
8. One fix, one line. The rest is superstition.
9. It works now. Do not ask it why.
10. Rang the bell. The race condition heard it.
11. Root cause found. It was us. It is usually us.
12. Cast out. Write the test so it stays out.
- Annoyed (five pokes): "Poking it will not make it reproduce."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is still ignored** by `build-mascot.py`. In `main()`, after `crop = ...`, add `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`. Then give `createMascot` a rail mode that uses `data.cropRail` for the viewBox and pivot percentages. Same as the pilots' notes.
2. **`L-body` is not in the contract.** Add the row `L-body | optional | static torso/mantle | –` with the paint order `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-N, L-front, L-token-N, L-halo-front`. The build script and engine already handle it (verified here).
3. **The victory flare** (`mx-flare` brightness 2.2, settling at 1.25) no longer whitens the ash halo noticeably (see `engine-states.png`); a per-bot `haloFlare` value would still be a good generic fix.
4. **A sway prop has to be a hang to move.** The handbell is `L-hang-4` so that it swings. The engine treats every hang the same (`mx-sway` ±1.5 degrees, and a "hot" brightness flicker in hacking), so the bell's swing is very small. Proposal: per-layer `data-motion="swing"` with an amplitude (for example `data-amp="6"`) from the constitution's planned enum, so the bell can toll properly in the "toll" idle.
5. **`L-eyes` inside a clip wrapper.** As on the Inquisitor, the eyes sit in `<g clip-path="url(#exo-cVisor)">` inside `L-face`, so pointer tracking (up to about ±11 px horizontally) cannot push cells out over the steel. The build script works unchanged. The contract should allow "`L-eyes` may sit inside one clip-path wrapper."
6. **Visor bounds.** The code scroll uses the path's min/max numbers. With a cross-shaped slot, the scroll fills the cross bounding box but is clipped to the cross, which is correct. No change is needed. Contract wording should still say "absolute M/L/C/Q/Z only".

No reference, engine or contract file was touched.

## Rounds
1. Silhouette and blocking, plus the 48 px lineup against the Relic, Inquisitor and Scribe. The bell and broken ring were instantly distinct, but the bright cross read as a "+" sign. Fix: the eye-arm became dominant and the vertical became a dim hairline seam.
2. Bust detail, contract and build.
   - The arm was redrawn: a clean rerebrace from under the hem, a couter, a foreshortened vambrace, and a fist with the thumb over the index finger.
   - The bell was raised so it no longer crops.
   - The bead cords moved off the litany so the text is not covered.
   - The stole now runs over the capelet.
   - The floating salt chunks at the halo gap were removed.
3. Portrait, in three passes:
   - A tall narrow column (too grey and flat).
   - A squat barrel (read as a sack).
   - The final bell-on-bell: square shoulders, wide ash bell sleeves that open negative space, a rope cincture, a flared chasuble with the litany hem, and an ash alb.
   - The barred window moved out of the halo's field.
4. Polish and proofs:
   - Capelet fold planes; helm scratches and salt crust.
   - The ring's dark backing reduced, because it showed as a grey smudge on the light background.
   - The rim light reinforced, at low opacity so it never becomes a white outline.
   - The hard shadow band under the chasuble hem became a gradient.
   - All 8 states checked on dark and light backgrounds; the rail lineup re-run.

## Still weaker than Zealot (honest)
- **The portrait is quieter.** It is monochrome by design (charcoal, ash, bone, and one green slot). There is no warm or saturated mass to answer Zealot's crimson and gold. At 300 px it reads as severe, not heroic.
- **The cloth is still flat-shaded planes**, not painted cloth: folds are hard-edged lens planes with a darker valley, uneven in width, but with no texture or colour shift inside a plane. The capelet is four lobes, the chasuble is charcoal and the alb is ash, but the mass is still tonally close to the backdrop.
- **The hands are armoured but stiff.** Each has separate finger plates, knuckle studs and a thumb, but they are capsule plates, not articulated gauntlets like Zealot's.
- **The right sleeve mouth reads a little like a cup** when seen close (a flared cone with a dark lining and a thin bone hem). It is opaque and cloth-coloured now, and the steel wrist fades into the lining.
- **The sabatons are simpler than Zealot's**: three lames, a toe ridge and a bone strap, with no spurs or gold. They are about 1.5x the old size.
- **The halo** reads well at 48 px and at full size.
- **The bell's swing** is barely visible with the engine's generic hang sway (engine note 4).
- **The tiny tag text** (`#42`, `EOF`) is about 4.2 px in the bust and is texture at rail size. The litany and the bell inscription are legible at full size only.

## Fix log (round 5, after the adversarial review `exorcist.md`)
Evidence PNGs are in this folder. Statuses are my own; a second reviewer should check them.

**Blocking**
1. **Tent, no second colour mass: FIXED.**
   - The capelet is now four overlapping drape lobes of unequal width (52, 74, 57 and 56 units, with different hem heights). Each has its own hem trim, a cast shadow on the next lobe, a hard-terminated fold plane and a lighter upper-left edge. The 8 even stripes are gone. The capelet is 212 units wide, which is 1.55x the helm lip (137 units). The pauldron lames are tucked under it.
   - The alb is the second mass, in ash (`#97a0ab` to `#3c444c`). It is a flared skirt with four folds of unequal width, deep valleys and a hem in weighted lobes that pile on the floor. The chasuble hem was raised, so about 150 units of alb show instead of 100. The chasuble is charcoal with uneven fold planes. Both sleeves are the same ash.
   - Evidence: `before-after-figure.png`, `portrait-vs-zealot.png`, `detail-portrait-figure.png`.
   - Still weaker: it is flat-shaded, and the tone is still tight against the backdrop (see above).
2. **Glass sleeve and detached rim strokes: FIXED.**
   - The global list of rim strokes is deleted. Every rim and key-light edge is now a crescent made by a mask (the owner shape minus itself shifted 2 units), so it can only exist inside its owner: cool on the right, pale on the upper left.
   - The right sleeve is opaque ash and is rebuilt as a bell sleeve with fold planes, a bone hem, a dark lining at the mouth and a narrow steel wrist. The wrist fades into the lining, and the bone cuff is at its end. The teardrop pod and the flat-ended vambrace are gone.
   - Evidence: `detail-right-arm.png`, `before-after-figure.png`.
   - Still weaker: the mouth can read a little like a cup.
3. **Hands and boots: FIXED (PARTLY by Zealot's standard).**
   - Left hand: hangs from a curved-hem sleeve (the cut is no longer a flat rectangle), with a wrist guard, a bone cuff, a back-of-hand plate, a knuckle row of 4 studs, 4 two-segment finger plates and a thumb. The bead strand hangs from the fingers.
   - Right fist: four separate finger plates with knuckle studs and joints, a thumb over the index finger, and rim light clipped inside each plate.
   - Boots: about 1.5x larger, with a toe cap and ridge, 3 lames, a bone ankle strap, rivets, a lit upper-left edge, a cool rim on the right foot only, and a contact shadow. The alb hem is raised above them, so nothing overlaps them.
   - Evidence: `detail-hands-boots.png`, `detail-right-arm.png`.
   - Still weaker: the hands are stiff capsule plates (see above).
4. **Halo too bright and sharing Scribe's hue: FIXED.**
   - Ring recoloured to the declared ash secondary (`#39414a`, `#56606a`, `#7d8792`, `#6c7580`, `#4a525b`). It is about 30% darker than the old `#c9c1ad` peak, and cooler. The thickness, gap and silhouette are kept.
   - In the 48 px grey crop the ring is now darker than the eyes and the helm lip.
   - Evidence: `rail-test.png`, `before-after-bust.png`.
   - Still weaker: next to the Inquisitor's silver ring it is distinct by thickness and the break, not by a strong hue difference.
5. **Visor slit reads as a cross: FIXED.** Fill is at 40% opacity, the glow at 14%, and only the 1.2-unit core line is full brightness. The upper stub is cut from 24 to 14 units (the rivet above it moved to y 172). Evidence: `detail-visor.png` against `before-after-bust.png`. It still reads as a thin cross at close range, but as a keyhole seam, and it is invisible at 48 px.

**Non-blocking**
- Bell lip too close to the cape at 48 px: FIXED. There is a lighter edge on the left half of the lower lip (`detail-helm.png`).
- Chalk text on the piers under 4 px: FIXED (9 units now, though still faint chalk texture).
- Floor chalk ring bleeding across the hem and boots: PARTLY. A contact shadow now darkens the chalk between the boots, and the hem no longer overlaps the boots. The back arc still passes behind the figure.
- Halo whitening in victory: it no longer shows with the ash halo.
- Tag text `#42` and `EOF`, the moon shaft crossing the left sleeve, and the bell swing: NOT CHANGED. The first two are texture, and the third is an engine limit.

**Checks:** both SVGs parse as strict XML; no `<style>`, `<script>`, `<image>`, `<foreignObject>` or `on*` attributes; ids are `exo-*` or `L-*` with no duplicates; the contract groups and pivots are unchanged; `L-visor-shape` is still absolute M/L/Z; `L-eyes` is still 50 4x4 cells; `build.sh` passes (12 layers); the states run on dark and light with no artefacts. Sizes: bust 88 KB, portrait 191 KB, JSON 131 KB. The portrait uses `mask`, `clipPath`, `use` and `href` (all already present or standard in the earlier file); fewer ring facets and chalk grains (detail 0.4) were needed to stay under 200 KB.
