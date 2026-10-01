# Forgemaster (Legion): painter's notes

Files: `forgemaster.layered.svg` (bust, 85 KB), `forgemaster.portrait.svg` (600x800, 152 KB), `forgemaster.json` (built by the real `build-mascot.py` through `tools/build.sh`, 114 KB, 13 layers), `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png`, `detail-helm.png`, `detail-chest-tools.png`, `detail-portrait-anvil-forge.png`, and the fix-round proofs `fix-bust-before-after.png`, `fix-portrait-before-after.png`.

Generators: `/home/claude/pilots/forgemaster/gen.py` (shared parts and the bust) and `portrait.py` (smithy, legs, assembly; imports gen.py). They are the only generators. The `tools/` folder holds proof scripts only (multi-render, rail sheet, states sheet, portrait comparison). Scratch snippets were deleted.

Build: `build.sh forgemaster forgemaster.layered.svg <work>` passes with the script unchanged. Layers: aura, halo-back, body, plume, helm, face, hang-1..5, front, token-1.

Checks run on the final files: strict XML parse; no `<style>`, `<script>`, `<image>`, `<foreignObject>` or `on*`; every id is `frg-*` or an exact `L-*`; no duplicate ids; 44 eye cells, all 4x4 on the 4 px grid, only `#ffffff` and `#b9ffd8`, right eye an exact mirror of the left; `L-visor-shape` uses absolute M/C/Z only.

## Palette
| role | hex |
|---|---|
| Cold gunmetal iron (dominant) | `#0a0c0e` `#13161a` `#1d2227` `#2a3037` `#3b434c` `#525c66` `#6f7a85` `#96a1ab` `#c3ccd4`; plate gradient `#74808c` > `#3f4851` > `#1f242a` > `#0e1013` |
| Gear halo (dimmed gunmetal) | `#1c2025` `#5d6772` `#48515a` `#2b3138` `#5a646e` `#4a535c`, tooth lip `#a9b4be` |
| Secondary hue: burnt copper (one only) | `#24130d` `#3f2318` `#5e3423` `#7d4630` `#985a3d` `#b37552` `#c99272`; ember rim `#a0583a` (bust), `#b0603c` (portrait, beside the forge) |
| Leather (dark end of the same copper family) | `#170f0b` `#251812` `#352219` `#4a3022` `#62412f` `#7a5440`; portrait apron gradient (second colour mass) `#966449` > `#7c533d` > `#5c3d2c` > `#412c21`, lit plane `#b98f72` at 20 % |
| Phosphor (portholes, eyes only) | `#7CFFB2` `#b9ffd8` `#ffffff`, glass `#1c9a62` > `#0a4a2e` > `#03200f`, glints `#eafff3` |
| Crimson, wax seal only | `#ff6a78` `#b3202f` `#5e0d18`, sigil `#f3dc94` (the only gold on the bot) |
| Cool rim light (right) | `#a9bdd6` (bust), `#c9dbf0` (portrait; 3 px edges on the right greave, sabaton and tassets) |
| Portrait leg iron (fix round) | left `#7b8793` > `#58626d` > `#2f363e` > `#1a1f24`; right (lit outer edge) `#7c8997` > `#5a6572` > `#343c45` > `#1c2127` |
| Smithy (portrait only) | stone `#0a0c0e`..`#1a1d21` (darkened in the fix round, wall luminance about 6-17), light pool `#6a7b8f`, timber `#4a3424` `#2e2017` `#120c08`, forge glow `#e08a52` > `#b8653d` fading out (raised to full opacity at the core), warm floor reflection `#b0603c` / `#d9824f` under the left boot, ash `#8a9096`..`#b9bfc5` |

Copper vs the amber state colour: the copper is hue about 20 degrees, value under 60 % and low saturation, and it only appears as thin rim strokes, a tooth inlay, a coal seam and leather. In the awaiting state the amber visor still reads as the only orange-yellow element.

## Identity
- **Silhouette:** low, wide and heavy. A squat welder's helm sits low between two huge three-plate pauldrons, the elbows stick out and the fists are hooked into the belt. The bust is 384 x 486; the portrait figure spans the full Zealot height but stands on thick greaves and wide sabatons.
- **Helm:** complete: a riveted skull dome; a flip-shield face plate made of two planes meeting at a hard centre ridge; a goggle bar under a heavy brow (engraved `QUENCH · TEMPER · TEST`); ratchet hinge knobs at the temples; a chin grille; and a heavy rolled lower flange with rivets, sitting in a separate gorget (`L-front`).
- **Visor / light slot:** two welder's lens windows in thick riveted bezels (not a held optic). Fix round: each aperture is a radius-19 circle with a flat chord cut off the top, slanted 10 degrees and falling toward the nose, so the scowl is built into the glass shape and a heavy iron lid plate (lit outer end, dark inner end) sits flush on each chord. The two lids meet in a V at the centre seam. The brow plate and its engraving were dropped 4 to 5 units so they sit on the lids. `L-visor-shape` is the two slanted lenses as one compound path (absolute M, L, C, Z only); `frg-cPort` (the eye clip) is the same path.
- **Eyes:** a heavy, scowling pattern: the outer top corner is lit and the inner top is cut, with a 5- then 6-cell core.
  ```
  ++++...
  +####+.
  +#####+
  .+++++.
  ```
- **Halo:** a thick, gear-toothed iron ring: 28 trapezoid teeth, a 20-unit band, a dark groove and engraved liturgy (`TEMPER · TEST · SHIP · NO SHORTCUTS · ... · IT SHIPS WHEN IT IS READY`). All the shading is concentric (lit tooth lip, dark inner groove), so it stays correct at any rotation. A single burnt-copper inlay on one tooth shows the spin. The halo is mid-grey, never brighter than the visor.
- **Plume:** a riveted exhaust stack on the dome, offset right, with a rain cap, a dull ember line deep in its mouth and a dim cool-grey smoke curl.
- **Signature prop:** a cross-peen forging hammer (cheek stamped `7c2d`) hung head-down at the right hip: an iron frog plate with two rivets pinned over the belt line, a stitched leather strap (6 units wide, rivet) down to an iron lanyard ring, and the ash handle passing through the ring. The whole tool ends at y 497, 23 units inside the crop bottom. Forge tongs are an accessory at the left hip on a matching frog and strap, hung by their pivot ring, jaws up and reins down.
- **Hang strips (5):** heavy chains with quenched iron tags (blue-black temper band at the foot, stamped `e1c9a07 PASS`, `3f0b2d ok`, `9d41e8b TEMP`) and two stitched leather straps with iron buckles.
- **Code-as-liturgy:** maker's marks stamped as short build hashes: the anvil plate on the chest (`a3f9c1e / TEMPERED`), the tags, the hammer cheek, the portrait anvil (`a3f9c1e / BUILD 4190 · TEMPERED`) and a chalk build tally on the smithy wall (`#4186 ok ... #4189 re-temper`). Also the engraved gear and brow.
- **Family mark:** a crimson wax seal with the `>_` sigil, hanging on a cord from the apron's right neck strap. It is the only `L-token-1`, with its pivot at 334 337, so the engine's alarm glow (pivot + 6) lands on the seal centre at 334 343.
- **Portrait backdrop:** a stone smithy. Rough ashlar courses, a timber beam with iron straps, a chain hoist and hook, a stone forge hood with a voussoir-arched mouth and a dim coal bed on the left (the forge side, where the copper rim light comes from), a tool rack with tongs, a fuller and a file on the right wall, and an anvil on an iron-banded stump with a cooling bar at the front right. The floor line has a pale ash drift, and a cool light pool on the back wall sits behind the gear. There is no window, arch niche, lattice or bookshelf.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | faint cool glow | – |
| L-halo-back | gear ring | 300 196 |
| L-body | cuirass, faulds, leather apron, anvil plate, belt, arms (deeper forearms, faceted couters) with fists on the belt, tongs and hammer with their belt hangers (static) | – |
| L-plume | exhaust stack and smoke | 327 122 |
| L-helm | dome, stack flange, hinge knobs, shield, goggle bar, bezels, brow, grille, lower flange | 300 292 |
| L-face | green bloom and spill, lens glass, scanlines, brow shadow, `L-visor-shape`, `L-eyes` (inside one porthole clip group), glints | 300 292 |
| L-hang-1..5 | chain (3 links) + tag (left pauldron), strap (belt), chain + tag (belt), chain (2 links) + tag (right pauldron), strap (right pauldron). The pivots are unchanged; the two pauldron chains were shortened so the tags clear the elbow plates | each attachment point |
| L-front | gorget, apron neck straps, both pauldrons | – |
| L-token-1 | wax seal | 334 337 |

`data-crop="108 34 384 486"` (the whole bust, including the smoke tip). `data-crop-rail="164 60 272 272"` holds the whole gear at any rotation: its tip radius is 119, plus about 12 for the drop shadow, around 300 196. It also holds the dome stack, the helm rim, the gorget and the shoulder tops.

## Five idle behaviours (engine verbs)
1. **Temper check (nod):** a single slow 1 % nod, with the face dimming to 75 % and back, as if reading a colour off hot steel.
2. **Ratchet (stepped spin):** the gear advances exactly one tooth (12.86 degrees) in one hard tick, holds, and after a long pause ticks again. Clockwork, never a free spin.
3. **Vent (plume puff):** the stack's plume sways once to its extreme while the smoke layer brightens briefly. One exhale.
4. **Count the tags (flutter in order):** the three chain-tag hangs swing one after another, left to right, like being counted off a hook.
5. **Squint (eye set):** the eyes drop to `narrow` for about 1.5 s while the rig leans 1.5 degrees toward the cursor, then return. It looks at your diff and does not like it.

## Quips (12, gruff and short)
1. It ships when it's tempered.
2. Green build. Run it again.
3. Hot fixes crack.
4. Pinned it. Tested it. Tagged it.
5. Flaky test is a cracked weld. Find it.
6. Didn't say fast. Said done.
7. Your VM's cold. Lighting it.
8. Logs first. Opinions after.
9. Rollback's forged. You won't need it.
10. One more pass on the anvil.
11. Merged. Quenched. Moving on.
12. Not tested? Not mine.
- Annoyed (five pokes): "Hit the anvil, not me."

## Contract and engine problems, with exact fixes
1. **Eyes inside a clip group.** The pointer tracking (up to ±11 units sideways, ±8 up and down) would push the eye cells past the porthole rims, so `L-eyes` sits inside `<g clip-path="url(#frg-cPort)">` within `L-face`. The build script finds `L-eyes` by id and appends the alternate sets inside the same clip, so it works unchanged. Contract line: "`L-eyes` may sit inside one clip-path wrapper inside `L-face`."
2. **`data-crop-rail` is still ignored by `build-mascot.py`.** In `main()` after `crop = ...`, add `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`, and give `createMascot` a `{rail: true}` option that uses `data.cropRail` for the viewBox and pivot percentages.
3. **`L-body` should be in the contract** (used here, as in Scribe). Row: `L-body | optional | static torso, apron, arms, belt props | – |`, painted after `L-halo-back` and before `L-plume`.
4. **The victory flare brightens the iron gear** (brightness 2.2 at the start). It reads as a white-hot gear for about 0.3 s, which suits a forge, but a per-bot `haloFlare` value (for example 1.4 for metal halos) would keep the material.
5. **The `L-face` state filters** (sepia, hue-rotate) also tint the porthole green spill on the bezel lips. That is intended here (the bezel glints amber in awaiting and red in error), so keep the rule "only light and near-black inside `L-face`".
6. **Text-bearing tokens:** none. The seal's sigil is a path and mirrors in the victory flip exactly as the Relic's does. All stamped text sits in static layers or hangs, which only sway.
7. **Rail eye weight.** At 48 px a cell is about 0.7 device px. The two slanted lenses carry the read and the scowl resolves from 64 px at 2x. The same rail-mode 1.5x eye proposal as the pilots applies.

## Still weaker than Zealot (honest)
- **The portrait has two masses now (iron and leather) but the leather is a flat tan-brown, not Zealot's saturated crimson with a bright backlight.** The figure reads heavy and gruff, not heroic. The leather is an unbroken trapezoid with three planes; it has no cloth drape.
- **The lower body is blockier than the top.** The faulds and tassets are plain stacked bands, and the greaves are simple two-plane shapes. Zealot's legs and cape have more varied, overlapping planes.
- **Hands are mittens with a thumb.** The finger lames are lines, not separately modelled fingers.
- **The face plate below the goggles is mostly flat dark iron.** It reads at rail size, but at full size it is the least painted part of the helm.
- **The halo text is texture at rail size.** The engraving start was rotated 21 degrees so `SHIP` and `NO SHORTCUTS` both clear the stack at rest; the stack now only covers the separator dot.
- **The forge glow is stronger but still not a single strong backlight.** It warms the left wall and the left rims; the cool wall pool behind the gear still does the separation work at the head.
- **Fonts:** the monospace stack falls back to DejaVu Sans Mono on Linux. Stamped text is 4 to 7 px (readable at full size); the gear and brow engraving is texture below 200 px.
- **The head is still small against the pauldrons** and the face plate below the goggles is mostly flat iron with a four-line grille (not repainted this round).
- **Hands are still mittens with a thumb** (three finger lines); not touched this round.
- **More than one prop competes in the portrait:** the hammer, the chest anvil plate and the large portrait anvil on its stump are all present. The anvil was not removed (see Fix log).
- **The 48 px bust is still dark-on-dark** for the helm; only the eyes, the gear and the dome rim carry the read. The slanted lenses now read as a scowl from 48 px at 2x, not at 1x.

## Fix log (round after the adversarial review)

Process: `gen.py` (bust and shared parts) and `portrait.py` (smithy, legs) are the only generators and were edited in place, so the delivered SVGs are exactly their output (checked with cmp before the edits and regenerated after). Before and after renders: `fix-bust-before-after.png`, `fix-portrait-before-after.png`. Build: `build.sh` passes, 13 layers, JSON copied. Strict XML parse passes for both SVGs; no style, script, image, foreignObject or on* attributes; all ids `frg-` or exact `L-*`; 44 eye cells, all 4x4 on the 4 px grid, only `#ffffff` and `#b9ffd8`, right eye an exact mirror; `L-visor-shape` uses only M, L, C, Z. Bust 85 KB, portrait 152 KB. Eight states checked through the real engine on dark and light (`engine-states.png`): complete helm, no artefacts, scowl holds in every state, the awaiting glow still lands on the seal.

### Blocking
1. **Portrait value separation and a second colour mass: FIXED (one caveat).** Measured on my own render of `portrait-vs-zealot.png` (luminance 0-255, before to after): right greave (350,690) 34 to 65; left greave (240,680) 49 to 70; right sabaton 32 to 53; right tasset/cuisse (350,540) 14 to 47; wall behind the legs 15 to 6-17 (ashlar fills `#0a0c0e`..`#0e1114`, background gradient darkened, soot band 28 %). The apron (300,540) went from 26 to 76: lit plane 102, mid 75, shadow plane 45, bib 81. The skirt was widened to the knee cops (hem 212..388 at the knee line), lifted to the `#966449`..`#412c21` range and given two hard-terminator creases (dark crease, lit lip on the lit side only) plus a hem band. Left side: a 4 px `#b0603c` rim stroke at 65-70 % on the left greave, tasset, sabaton, and a 4.4 px (1.7x) rim on the left pauldron and arm (all clipped to their plates), a stronger forge (core `#e08a52`, wash opacity up), and a warm floor reflection under the left boot. Right side: both greaves and the right sabaton use a lighter outer-face gradient plus a 3.2 px `#c9dbf0` rim at 70 % and a 15 % cool plane on the outer face; inner faces carry two hard-terminator dark planes. Caveat: the legs are now brighter than the torso (about 65-70 against a pauldron mid of 67-91), and the leather is tan-brown, not crimson, so it is still less dramatic than Zealot.
2. **Floating hammer and tongs: FIXED.** Hammer: an iron frog with two rivets over the belt line, a 6-unit stitched leather strap with a rivet, a visible iron ring in front of the forearm, the handle through the ring, head down; the tool ends at y 497 (crop bottom 520), x max 420 (crop right 492). Tongs: a matching frog and strap down to the pivot ring, jaws up behind the fist. Both are in `L-body` and mirrored automatically in `portrait.svg`. Evidence: `detail-chest-tools.png`. Deviation from the review text: the hammer hangs head down by a lanyard ring (a head-up hammer would have put the head in front of its own strap); the tongs are drawn on the belt line, which the forearm covers, so both frogs sit on the forearm edge, as the review asked ("painted over the forearm").
3. **Friendly goggle-eyed robot: FIXED (the lenses and arms), PARTLY (the 48 px read).** Lenses: `L-visor-shape` and `frg-cPort` are now radius-19 lenses with a chord cut at 10 degrees falling toward the nose (the review asked for r 19), with iron lid plates flush on the chords that meet in a V; bezels shrunk to match (outer r 27.5); the goggle bar's brow plate and engraving dropped 4 to 5 units; the lid shadow was rebuilt under the chords; the green spill ring is clipped so nothing floats above the lids. Evidence: `detail-helm.png`, `engine-states.png`. Arms: the forearm is about 30 % deeper (about 35 to 45 units) and the round elbow spheres were replaced by faceted couters with a hard ridge, a lit top facet and a shadow facet; the two pauldron chains were shortened (5 to 3 links, 4 to 2) so the tags hang over the bicep plate and the top of the couter, not across a ball. The tags were not tucked behind the vambrace: hangs paint after `L-body`, and moving the vambrace into `L-front` would hide the tag text. At 48 px 1x the scowl is still only the bright eye shape; it resolves clearly from 64 px and at 2x (`rail-test.png`).

### Non-blocking
- **48 px rail: PARTLY.** Added a 2 px cool rim (`#a9bdd6` at 85 %) along the dome's upper right edge. The tooth lip colour was NOT changed (the review sentence about "70 % of its brightness range" is ambiguous; no change was made). The helm is still dark on dark at 48 px 1x.
- **Stack hides halo text: FIXED.** The text elements are rotated 21 degrees about the ring centre (a static transform on the text, the ring itself stays rotation-invariant); `SHIP` and `NO SHORTCUTS` are both clear of the stack (`detail-helm.png`).
- **More than one signature prop: NOT FIXED.** The hammer is the prop and the tongs now read as an accessory on a hanger, but the chest anvil plate and the portrait anvil are both kept. Removing the portrait anvil would have left a hole in the lower right that needs a new element (a quench tub), which is a redraw the brief forbids.
- **Hands: NOT FIXED.** Not touched this round.
- **Colour (leather mass): PARTLY.** Saturation of the portrait apron was reduced after the first pass (`#a4694a` to `#966449` top stop); it is still a large brown mass by the review's own instruction to make it the second mass. The bust apron was not changed.
- **IP watch: no change needed.** No skull, wings or chest eagle added.
- **Hang tags low contrast: NOT FIXED** (texture only at rail size, as the review accepted).
- **Portrait head small and flat face plate: NOT FIXED.**
- **Forge hearth, hoist, rack flat and dim: PARTLY.** The forge glow and wash were raised; the hoist and rack were left as they were (the wall behind them is now darker, so they sit further back).

### Contract and engine notes added or confirmed
- `L-eyes` inside one `clip-path` wrapper in `L-face` is still used (clip is the new lens path) and works with the build script and pointer tracking.
- `data-crop-rail` is still ignored by `build-mascot.py` (proposed fix unchanged from above).
- The hammer and tongs hangers live in `L-body`, so the hang pivots and layer order are unchanged (`L-hang-1` 176 380, `L-hang-2` 268 458, `L-hang-3` 334 458, `L-hang-4` 424 382, `L-hang-5` 446 370, `L-token-1` 334 337).
