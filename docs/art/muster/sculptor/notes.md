# Sculptor (Legion muster): painter's notes

Files in this folder:
- `sculptor.layered.svg`: the animated bust (88 KB).
- `sculptor.portrait.svg`: the portrait, 600x800 (153 KB).
- `sculptor.json`: built by the real `build-mascot.py` through `tools/build.sh`. The build passed with the script unchanged (112 KB, 12 layers); byte-identical to the build output of the delivered SVG.
- `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png` (dark and light backgrounds).
- Detail crops: `detail-helm.png`, `detail-portrait-tools.png`, `detail-portrait-block-and-statue.png`, `detail-portrait-lower.png` (skirt, greaves, boots, cloak), `detail-portrait-rim.png` (filled rim slivers).

Generator: `/home/claude/pilots/sculptor/gen.py` is the only generator; it writes both SVGs from one set of parts. `railsheet.py` builds the rail proof, and `patchlib.py` is a small editing helper. There are no stale generators.

Checks:
- Both SVGs parse as strict XML.
- There is no `style`, `script`, `image`, `foreignObject` or `on*` attribute.
- Every id is `scl-*` except the contract ids.

## Identity
- **Silhouette:** a stonecutter in a dusty linen smock over light plate. The helm is complete (dome, visor frame, full lower rim):
  - The front and left of the helm are carved limestone.
  - The crown, the right of the dome, the right cheek and the right end of the rim are a cold-white wireframe: a quad mesh over flat-shaded dark faces, with vertex dots.
  - The edge where the stone stops is a chipped chisel line, and the stone casts a shadow onto the mesh.
  - The mesh's edge loops continue onto the stone as faint charcoal layout lines that fade out to the left. These are the carver's guide marks.

  The head stoops 5 degrees to the viewer's right, and the right pauldron sits 11 px lower than the left. In the portrait a dust-sheet cloak fans off the viewer's-left pauldron (behind the figure, linen hue, four fan planes of different widths), and the skirt's right panel is hiked on a diagonal hem, so the mass is asymmetric.
- **Crest (`L-plume`):** a small rough-hewn block of limestone on a short thin stem that joins the dome (block lowered 9 px in the fix round), with one corner already knocked off: "the block with opinions". It replaced two earlier tries:
  - a rag knot, which read as a chess pawn's point;
  - a side knot, which read as a ponytail.
- **Visor / light slot:** a sharp trapezoid window (88 wide at the top, 68 at the bottom, 26 tall), offset to the viewer's left of the helm's centre, so the face is asymmetric. Its chisel-bevelled walls follow the key light: the top and left walls are in shadow, the bottom and right walls are lit, and parallel tool strokes run across them. A brow ridge overhangs it.
  - `L-visor-shape` is `M240,168 L320,168 L320,161 L325,161 L325,168 L328,168 L318,194 L250,194 Z` (absolute M/L/Z only): the trapezoid plus a 5 px vertical chisel gap cut through the top-right of the bevel (fix round). The helm's bevel walls still use the plain 4-point trapezoid.
  - The eyes sit inside a clip of the aperture.
- **Eyes:** 7x4 per eye, 40 cells on the 4 px grid, `#ffffff` and `#b9ffd8` only. Deliberately NOT mirrored (fix round): the viewer's-left eye has its lid lowered (top row empty) and the inner top core cell dropped, so it squints; the right eye stays open.
  ```
  left          right
  .......       .++++..
  .+###++       +####+.
  ++####+       +####++
  .+++++.       .+++++.
  ```
  The build script reads this fine (it measures `lx` from the leftmost cell and `right_x0` from the rightmost, and generates the expression sets itself, mirrored); every other state is symmetric as before.
- **Halo:** a thick broken limestone ring (R 96 to 126) with a 52-degree break.
  - The broken faces are jagged, with six stone chips just separating from them and short cracks running into the ring.
  - The missing segment is drawn as a dim wire model (three arcs, five spokes, vertex dots), so the ring is complete in the model and broken in the stone.
  - The ring's shading is a radial drafted-margin profile (lit arrises, a tooled field), so no baked highlight swings round as it rotates.
  - Its base value is dimmer than the helm and far below the visor (a further 9 percent darker after review: every ring gradient stop mixed 9 percent toward black). The victory flare stays stone-coloured and does not go white (see `engine-states.png`).
- **Signature prop:** a carver's mallet (iron-banded beech head, ash handle) in the viewer's-left fist, and a point chisel (octagonal steel, mushroomed striking end) in the viewer's-right fist, crossed at the chest.
- **Hang strips (4):** two torn dust-sheet linen strips with frayed bottoms and dust-darkened ends, and two plumb-cord offcuts (twisted cord, a knot, a frayed cut end). They hang from under the outer pauldron lames.
- **Family mark:** a crimson wax seal with the `>_` sigil, now sitting on the diagonal leather strap of the smock at (268,334), below and clear of the pauldron rim, so the strap visibly carries it. It is the only `L-token-1`. Its pivot is 6 px above its centre, so the engine's alarm glow (pivot + 6) lands on the seal.
- **Code-as-liturgy:** all of it is chiselled (a dark groove with a lit lower lip), never printed:
  - The helm's lower rim carries `bpy.ops.mesh.subdivide(cuts=2)` at 5 px, on a static layer, so it never flips.
  - The halo carries a vertex and face list at 5.6 px: `v 0.000 1.250 0.372 · v 0.118 1.244 0.372 · … f 4 5 9 8 · …`.
  - In the portrait, the raw block's face carries three vertex lines, a face line and `bpy.ops.mesh.bisect(plane_co=(0, 0, 1.2))` at 7.2 px. The statue's plinth carries a short vertex list at 7 px.
- **Portrait backdrop (a quarry-workshop):**
  - A stepped quarry face of sawn benches with plug-and-feather drill marks along some split edges.
  - Timber scaffolding with linen lashings, a plank deck holding a rope coil and an offcut.
  - A pulley block with a rope sling down to a sawn raw block, which carries the code.
  - On the left, a half-carved veiled marble figure: head and shoulders finished, the drapery roughed out and still in the block, and the unfinished right arm present only as a wire model.
  - Behind the head and shoulders is a quarry mouth cut in stepped benches, open to a cold dusty-blue sky (about 40 percent lightness against the helm's 87, so roughly 60 points of value contrast). It is the portrait's second big colour mass. Two receding stepped ridges sit in it; the ledge tops and right-hand walls catch the light, the left-hand walls fall into shade. The scaffold timber and rope were lifted to a lit value with a light edge on the left (key-light) side.
  - The floor line is drifted with marble dust and knocked-off chips. One cool rim light is on the right edges only.

## Palette
| role | hex |
|---|---|
| Limestone (helm, crest, halo), light to dark | `#f3eee4` `#ddd6c8` `#c3bbab` `#a39b8b` `#7f7869` `#5a544a` `#3a362f`; outline `#4a443b` |
| Halo stone (dimmer profile) | `#bcb4a4` `#a49c8c` `#958d7e` `#8a8274` `#7d766a` `#5e584d`; outline `#433e36` |
| Cold-white wire (never cyan) | `#e3e8eb` lines, `#ffffff` vertices, `#aeb5bb` diagonals |
| Mesh faces (neutral viewport greys) | `#121418` `#1e2126` `#2e3238` `#454b52` `#5f666e` |
| **Secondary hue: dusty linen** | `#dcccaa` `#c2ae8a` `#a08b69` `#7a684d` `#534634` `#362e23`; outline `#2c271f` |
| Leather strap and belt (linen family, darker) | `#8a7c62` `#6c604b` `#433a2d` |
| Light plate (warm pewter) | `#bdb8af` `#8d8880` `#625e58` `#423f3b` `#2a2826` `#171615` |
| Mallet: beech, ash and iron | beech `#e6dcc4` to `#4f4636`; ash `#e2d6ba` `#c0b292` `#7a6d55`; iron `#6e6a66` `#4a4642` `#2c2a27` `#171614` |
| Chisel steel | `#eef0f1` `#a9adb1` `#5f6367` `#2c2f32` |
| Phosphor (aperture, eyes; nothing else) | `#7CFFB2` `#b9ffd8` `#ffffff`; aperture `#0b3a24` `#05170e` `#0d4a2e` |
| Wax seal | `#ff6a78` `#b3202f` `#5e0d18`; sigil `#f3dc94` (the only gold on the bot) |
| Cool rim light (portrait) | `#c9d5e6` (filled slivers only) |
| **Portrait sky (the second colour mass)** | `#1c4257` `#34647c` `#6b9aaf`; far ridge `#3d6b82`, near ridge `#27495b`; ledge light `#8d9298` |
| Portrait marble statue | `#f1eee8` `#cbc7be` `#6f6b64` |

Notes on the palette:
- There is no amber or red identity colour.
- The linen is low saturation (hue about 38 degrees).
- Outlines are darker shades of the local hue, never pure black. Only soft cast shadows use black.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | warm stone glow, a cool glow, a faint green | – |
| L-halo-back | broken ring, chips, wire ghost, vertex list | 300 172 |
| L-body | linen smock torso with curved fold planes (static) | – |
| L-plume | stone-block crest on its stem | 315.51 84.68 (the crown point 300 84, after the 5-degree tilt about 300 262) |
| L-helm | neck plates, mesh half, stone half, bevelled window walls, rim with the `bpy` line | 300 262 |
| L-face | aperture fill, glow, scanlines, spill on the lower bevel, `L-visor-shape`, eyes (clipped) | 300 262 |
| L-hang-1..4 | linen strip, cord, cord, linen strip | 172 330 / 187 336 / 413 346 / 428 338 |
| L-front | strap, belt, collar and gorget, rolled sleeves, arms, mallet, chisel, fists, pauldrons | – |
| L-token-1 | the wax seal | 268 328 |

- `data-crop="146 34 308 470"`.
- `data-crop-rail="155 34 290 292"`. It holds the whole halo, chips included, at any rotation (radius about 134 around 300 172), plus the crest, the collar and the seal.
- The helm, face and plume contents sit inside `rotate(5 300 262)`.

## Five idle behaviours (verbs the engine could play)
1. **Sight the plane:** the rig leans 2 degrees toward the mesh side, the eyes switch to `narrow` for 1.2 s, then he straightens. (lean + eye set)
2. **Tap test:** two small nods 0.5 s apart, with the plume crest settling a beat late, like listening to the stone ring under the chisel. (nod x2 + delayed plume)
3. **Turn the stand:** the halo rotates exactly 90 degrees with an ease-in-out and stops, as if he turned the banker to see the next face. (stepped spin)
4. **Shake out the dust sheets:** the hangs sway in sequence from right to left, a single wave. (wave)
5. **Measure twice:** two slow eye sweeps left to right, one blink, then nothing for a long while. (scan + blink hold)

## Quips (patient, tactile)
1. Every mesh is a block with opinions.
2. Measure twice. Cut once. Undo never.
3. That face has a triangle in it. I can hear it.
4. Stone has no Ctrl+Z. I prefer it that way.
5. Edge loops follow the form. Yours follow the deadline.
6. Scale applied. Now the modifiers believe us.
7. Normals recalculated. Half of them were facing inward.
8. Fourteen thousand vertices for a teacup. We should talk.
9. The figure was in there already. I am removing the rest.
10. Nothing is finished. Some things are exported.
11. Merge by distance first. Then merge by judgement.
12. Patience is a bevel with three segments.
- Annoyed (five pokes): "Tap the stone, not the sculptor."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is still ignored.** In `build-mascot.py` `main()`, after `crop = ...`, add:
   ```
   cr = svg.get('data-crop-rail')
   out['cropRail'] = [float(v) for v in cr.split()] if cr else None
   ```
   (Put `cropRail` in the `out` dict before it is dumped.) `createMascot(host, data, {rail: true})` should then use `data.cropRail` for the viewBox and the pivot percentages.
2. **`L-body` is used but is not in the contract.** Add the row `L-body | optional | static (torso, smock) | – |`. Paint order: `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-N, L-front, L-token-N, L-halo-front`. The script and engine need no change.
3. **Rotated rig content (new with this bot).** I tilt the head by wrapping the contents of `L-plume`, `L-helm` and `L-face` in `<g transform="rotate(5 300 262)">`. This works unchanged, because:
   - The script copies the visor `d` into a `clipPath` and inserts the code roll beside the visor path, inside the same rotated frame. With `userSpaceOnUse`, the clip resolves in that frame.
   - The code-scroll bounds parsed from the `d` numbers are in that same local frame.
   - The alternate eye sets are appended inside `L-eyes`, so they rotate too.

   Two caveats for the contract:
   - Add the line: "the 4 px eye grid is measured in the coordinate frame of `L-eyes`' parent; a rotated wrapper is allowed".
   - `data-pivot` stays in document coordinates, so a pivot inside a rotated wrapper must be given already rotated. The plume pivot is the crown point (300, 84) rotated 5 degrees about 300 262, which gives `315.51 84.68`.

   Keep the tilt small (5 degrees or less). At 48 px, rotated 4 px cells start to anti-alias.
4. **Eyes inside a clip.** As with the Inquisitor, `L-eyes` sits inside `<g clip-path="url(#scl-cVis)">` in `L-face`, because pointer tracking moves the eyes up to about ±11 px horizontally and ±9 px vertically (cursor, look-around and state offsets combined). Contract wording: "`L-eyes` may sit inside one clip-path wrapper".
5. **A rigid crest on a sway animation.** The stone-block crest uses the generic `mx-plume` sway (−1.6 to +2.2 degrees, plus a fixed 7 degrees when sleeping). It reads as a balanced block rocking, which is acceptable. A persona value would suit rigid crests better: `"plumeSway": 0.5` (an amplitude multiplier), or `data-motion="rock"` from the planned enum (half amplitude, slower).
6. **Victory token flip.** `mx-flip` mirrors the seal, so the `>_` sigil briefly reads `_<`. This is the same on the Relic. The per-token `data-flip="none"` from the engine-changes list would fix it. No text-bearing layer flips on this bot: the `bpy` line is in `L-helm` and the vertex list is on the halo.
7. **Halo light.** Pilots baked a directional highlight into the rotating halo, so the highlight swings round as it turns. I used a radial profile gradient (light on both arrises, darker field), which is rotation-invariant. I recommend this as a rule for rotating layers: "no directional lighting baked into `L-halo-*`; use radial profiles".
8. **Halo text rotates with the ring** (readable only part of the time). This is accepted as texture. It is never the only carrier of the code-as-liturgy.

No reference file, engine, script or other bot's folder was touched.

## What is still weaker than Zealot (honest, after the fix round)
- **Colour drama.** The portrait now has a real second mass (dusty-blue sky in the quarry mouth), but it is a flat gradient with two ridges, not Zealot's glowing green window with runes; the beige figure is still the only warm mass and the bold accent (green visor) is tiny at 300 px.
- **Skirt cloth.** Mottle is gone, folds vary in width and lean and there are drag folds, but the panels are still a large pale slab of near-vertical wedges; the folds are drawn, not sculpted, and the right panel's hiked hem is a simple diagonal.
- **Silhouette.** Asymmetry now comes from the cloak and the hiked panel; the shoulders and arms are unchanged and still symmetric, and the cloak is a plain fan, not Zealot's heroic cape.
- **Rim light.** Now filled slivers clipped to the silhouette, but they read as flat grey-blue bands with stepped ends where the arm and torso edges differ by 1-3 px; there is no tapering.
- **Arms (not changed).** Forearms still run nearly horizontally into the fists, so the arms look short (review's idle-arm suggestion was not done: it means moving both fists, tools and couters of the approved bust).
- **Hands.** Four-lame gauntlets with a thumb; still mechanical at full size.
- **Rail.** At 48 px 1x the wire half now shows a few brighter loops and reads as a lighter lattice, but it is still only a few pixels; the 3x nearest-neighbour row shows it best.
- **Helm dome.** Mostly smooth stone; the dome is unchanged except for the lowered crest.
- **Marble figure and plinth code.** The statue now has a lit left edge and a shaded right side, but it is still a simple veiled figure. The plinth code is legible only at detail size and is decorative texture at 300 px.
- **Eyes and visor gap.** The left-eye squint and the 5 px chisel gap break the stock-robot look, but at 48 px the eye cells are sub-pixel and only the glow shape survives; the gap reads as a dark tick at 1x.

## Fix log (round 1 review: /home/claude/reviews/sculptor.md)
Evidence PNGs are in this folder unless stated. Before images: `/home/claude/pilots/sculptor/f/p0.png` (portrait before), `f/before-after-portrait.png` (side by side).

**Blocking**
1. **Proportions and silhouette: FIXED (mostly).** Skirt hem narrowed from 304 px (x 148-452) to 248 px (x 176-424), which is 86 percent of the 288 px pauldron span; the A-line flare dropped from 44 px per side to 16 px. Greaves thickened 30 percent (x scale 1.3), cuisses widened, stance wider by 12 px each way (centres 254 and 350). Boots rebuilt: two ankle lames, vamp plate, capped toe with a lit crescent on its top edge, thick sole, a heel block, and a 9 degree outward splay, with a contact shadow. Symmetry broken by a dust-sheet cloak off the viewer's-left pauldron and a hiked right skirt panel. Not done: the review asked to lengthen the panels to mid-thigh; I kept the hem at the knee top (it contradicted the narrowing and would have hidden the knee cops). See `detail-portrait-lower.png`, `portrait-vs-zealot.png`.
2. **Colour and backdrop: FIXED.** Option (a): a stepped quarry mouth open to a dusty-blue sky behind head and shoulders. Measured lightness: helm dome 87, sky beside the helm 22-26, sky beside the shoulders 38-40, so at least 47 points of contrast against the helm. The wall behind is 13. Scaffold timber lifted (gradient start from `#5a5145` to `#b4a589`) with a light edge band on the left of each pole, rope lifted to the lit linen values, the dark overlay on the scaffold cut from 0.3 to 0.1. At 300 px beside Zealot the blue patch and the poles read (`portrait-vs-zealot.png`). The old cool pool ellipse is removed.
3. **Skirt cloth noise and stripes: FIXED.** `scl-mottle` removed from both skirt panels (was 0.35); the blurred hem highlight, the blurred pale ghost-hand strokes and the pale vertical strip are deleted. Dust is now three hard-edged ragged bands at each hem, plus a darker hem band. Folds now have varied widths (lit/shadow 14/31, 9/14 on the left panel; 10/22, 17/9 on the right), opposite leans (the second left fold leans the other way) and S-bends, one diagonal drag fold per panel from the belt toward the knee (tapering wedges), and a soft darker contact shadow under the belt. The lit wipe stroke was dropped: it read as a Y when crossing the drag fold, and the review only allowed it as optional. Torso mottle in the portrait only was also cut from 0.35 to 0.12 (the bust L-body is unchanged). See `detail-portrait-lower.png`.
4. **Detached hairline rim strokes: FIXED.** All rim strokes (`rim_light()`) are replaced by one mask: the silhouette parts (right pauldron, right arm tube, sleeve, couter, torso below the arm, right skirt panel, right greave, knee and boot) minus the same shapes shifted 3.8 px left, filled `#c9d5e6` at 0.55 opacity. No strokes, nothing outside the shapes, the orphan boot arc is gone, and the skirt edge ends where the skirt ends. The baked 1 px torso edge line in `body()` is skipped in the portrait only. See `detail-portrait-rim.png`. Residual: slight stepped ends where arm and torso edges differ.
5. **Eyes generic / robot head: PARTLY FIXED.** Left eye lowered and squinting (empty top row, inner top core cell dropped), right eye open; a 5 px vertical chisel gap notched into the top right of the aperture (`L-visor-shape` stays absolute M/L/Z). Checked in all 8 states on dark and light (`engine-states.png`): helm complete, expression sets (happy, error, annoyed, sleeping) intact. Partly, because at 48 px the effect is sub-pixel and the head silhouette is still a dome with a trapezoid window. Deliberate deviation: the eyes no longer mirror (the contract says the right eye mirrors the left; see problem 9 below).

**Non-blocking**
- 48 px wire half: **FIXED (partly visible)**. Five brighter edge loops (2 px, opacity 0.9) hug the cut; `rail-test.png` x3 rows show a lighter lattice, at 1x it is still a small patch.
- Crest block on the ring: **FIXED**. Block moved down 9 px, stem thinned to 10 px so it joins the dome; it still overlaps the ring's lower edge a little (`detail-helm.png`).
- Wax seal: **FIXED, different direction**. The review said lower and left; left would have put it further under the pauldron, so it moved 16 px right and 18 px down onto the strap, where the strap visibly carries it (`engine-states.png`, `detail-helm.png` shows the collar area). The pivot and alarm glow follow (checked in the `awaiting` cell).
- Halo ring dimming: **FIXED**. 9 percent darker; in the 48 px grey cells the helm is now the brightest large shape (`rail-test.png`).
- Halo on light theme: no change requested.
- Statue lit left edge and shadow side: **FIXED** (mask sliver on the left edge, a horizontal shade gradient on the right; `detail-portrait-block-and-statue.png`). The cropped wire arm was not touched.
- Block-code text contrast: **PARTLY FIXED**. Light chiselled text over a dark shadow offset; legible at detail size, still texture at 300 px.
- Idle arms near horizontal: **NOT FIXED**. Raising both fists 10 px and angling the forearms would redo the arms, tools, couters and fists of the approved bust; left for a later round.

## Contract and engine notes added in the fix round
9. **Asymmetric eyes.** The contract says the right eye mirrors the left. The base pattern is now deliberately asymmetric (left eye squints). `build-mascot.py` copes (it only needs the leftmost and rightmost cells of the base set and generates expression sets mirrored), but if the engine ever derives the right eye from the left, it needs a per-eye base. Proposed contract wording: "the base eye pair may be asymmetric; expression sets are always mirrored".
10. **Visor path with a notch.** `L-visor-shape` has 8 points (a notch above the top edge). The build script copies it into a clipPath and takes the bounds from the path numbers (y min is now 161, not 168), so the code scroll starts 7 px higher; no change needed.
