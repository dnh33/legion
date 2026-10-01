# Builder (Legion muster): painter's notes

Files: `builder.layered.svg` (bust, 85 KB), `builder.portrait.svg` (600x800, 153 KB), `builder.json` (built, 113 KB), `rail-test.png`, `portrait-vs-zealot.png` (now also shows the pre-fix portrait), `engine-states.png` (all 8 states, dark and light, 230 px cells), `detail-helm.png`, `detail-portrait-chest.png`, `detail-portrait-legs.png`, `fix-before-after.png` (fix round: face, legs and boots, portrait).

Generator: `/home/claude/pilots/builder/gen.py` is the single source and writes both SVGs (the fix round edited it in place and it still reproduces the delivered files byte for byte; the stale pre-fix copy was deleted). `railsheet.py` there only builds the rail proof. Fragment scripts used while working were deleted.

Build: `build.sh builder builder.layered.svg` with the unchanged `build-mascot.py` **passes**. Layers: aura, halo-back, body, plume, helm, face, hang-1..4, front, token-1.

## Checks (all pass)
- Strict XML for both files. No style, script, image, foreignObject or `on*` attributes.
- Every id is prefixed `bld-` except the contract ids. In the portrait the contract ids are renamed to `bld-p-*`.
- The only pure black is in blurred cast shadows. Outlines are dark local hues.
- Paint order: L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-1..4, L-front, L-token-1.
- `L-visor-shape` is a rounded rectangle written with absolute M/L/C/Z only.
- `L-eyes`: 44 `<rect width="4" height="4">` cells on absolute multiples of 4. Right eye mirrors left about x 300. Fills are only `#ffffff` and `#b9ffd8`. The eyes sit inside one clip group (the viewport) inside `L-face`.
- `data-crop="142 32 316 480"`.
- `data-crop-rail="136 26 328 332"` (fix round: 4 units more headroom for the crest): the whole brick ring (max radius 148 around 300,186) at any rotation, the full brim, the helm, the lower rim and the gorget.
- One token only, the wax seal. Its pivot is 340 366, so the engine's alarm glow (pivot + 6) lands on the seal centre at 340 372.

## Palette
- Gunmetal (dominant): `#a9b4bf` `#7f8b97` `#56616c` `#353d46` `#1f252c` `#12161b`, outline `#0b0e12`
- Verdigris-teal (the one secondary hue). Fix round: shifted from hue about 178 to about 186 by a post-pass in `gen.py` (`hue_shift`, full +8 degrees at 165-178, tapering to 0 at 190), so it sits about 36 degrees from the phosphor. Source values before the shift: `#8fc7c1` `#62a39e` `#3f807d` `#285a59` `#173a3b`, outline `#0c2324`; the SVGs hold the shifted values.
  - Halo glaze, dimmed (source values, shifted in the SVG): `#3a7270` `#3f7471` `#33676a` `#447a77` `#376b69` `#3d716e`, mortar `#1a2c2b`
- Leather, now a near-neutral dark iron-brown (saturation 8 to 11 percent, no second warm hue): `#464440` `#3b3834` `#2c2a28` `#1e1d1c`, outline `#121110`, stitches teal-grey `#7fa5a3`. It is the bib, straps, belt and a strip of lower apron; the trowel handle uses the same neutral. The only warm things left are the brass ferrule, the rope knots and the crimson seal.
- Trowel steel: `#e4ebf1` `#aab6c2` `#6f7c89` `#262d35`
- Brass, the only gold (trowel ferrule): `#e6d197` `#b99a52` `#6e5727`
- Rope: `#8b8572` `#625d4f` `#36342d`
- Crimson, wax seal only: `#ff6a78` `#b3202f` `#5e0d18`, sigil `#f3dc94`
- Phosphor (viewport, eyes, build-log ticks only): `#7CFFB2` `#b9ffd8` `#ffffff`, viewport `#5df0a6` to `#04190f`
- Cool rim light (right only): `#bfe4ff`
- Portrait backdrop: stone `#525b61` to `#1a1f22`, pale keystone `#9aa29f`, weathered timber `#4f4b45` to `#1d1b18`, opening glow `#36565a`

## Identity
- **Silhouette:** the broadest, squarest mass in the roster.
  - A segmented kettle hat-helm: four riveted plates, a raised comb and a riveted verdigris hatband.
  - A 300-wide flat brim with a rolled, riveted lip that crosses the halo on both sides. At 48 px this gives a ring cut by a bar, a glyph no other bot has.
  - Under the brim: a square face plate, a full riveted lower rim, a two-lame gorget, and slab pauldrons with a top plane, a rolled verdigris edge and two lames.
- **Helm crest (`L-plume`):** a cast verdigris keystone in an iron socket with a chiselled level-and-plumb mason's mark. It is not a plume and has no crimson. In the portrait a pale dressed block hangs from a pulley on the gantry beam, off the focal axis over the laid right-hand stones, waiting for the crown (the crest is the single bright accent over the head).
- **Halo:** a thick brick course of 30 bricks in dimmed verdigris glaze on a shared mortar bed. Headers stand proud on the outside and stretchers on the inside, so both edges are square-notched. This separates it from the Forgemaster's gear (teeth on the outside only) and from every thin ring. One plain stone index brick with a mason's mark makes the rotation visible. Bricks on the right catch the rim light.
- **Viewport:** a welder's window, 108 x 26 with radius 4 (fix round; was 116 x 34 with radius 8), in a thin riveted four-corner bezel. No temple discs: flush riveted gunmetal cheek plates sit on the face either side. Under the window, one row of three narrow breath slots, then a chamfered chin with a lit left facet, a shaded right facet and a hard crease. It is taller than the Inquisitor's slit and has no arches and no T.
- **Eyes:** 22 cells per eye, now centred in the smaller aperture at y 228-244 ("brick" eyes with a flat top and a lower-inner cut, so they squint inward at the work):
  ```
  .+++++.
  +#####+
  +####+.
  .++++..
  ```
- **Signature prop:** a mason's pointing trowel. In the bust it is held upright at the chest in the right gauntlet. In the portrait it is held in a two-handed salute. It has a steel blade with a teal bounce light, a frog, a brass ferrule and a short handle.
- **Hang material (4):** knotted hemp ropes with iron S-hooks carrying small tool tags: a PASS tag with a green tick, a cold chisel, a ring of three forged nails, and a `0 ERR` tag. Tag text is 4.2 to 4.6 px.
- **Code-as-liturgy:** a riveted build-log plate on the apron. The bust shows `$ make`, then `lint`, `test 42/42` and `build`, each with a phosphor PASS tick. The portrait plate shows `$ make all`, then `lint 0 warn`, `test 128/128`, `build 4.2s` and `deploy` with ticks, plus a PASS stamp. Text is 5.4 to 6.4 px. In the portrait the laid voussoirs are chiselled `c01` to `c10` in laying order (each stone a commit), and the threshold sill reads `MEASURE TWICE · MERGE ONCE`.
- **Family mark:** a crimson wax seal with the `>_` sigil, hanging from a ring under the right apron strap. It is the only `L-token-1`.
- **Small extra:** a flat carpenter's pencil tucked in the hatband. It shows from 64 px up and disappears at 48 px.
- **Portrait backdrop:** a half-built stone arch.
  - Coursed ashlar piers with impost blocks.
  - The left half of the voussoirs is laid; the right half has three stones over a timber centering rib, with struts, a tie beam and props.
  - The crown is open where the keystone will go. A pale cool shaft falls from that gap diagonally onto the right pauldron and the halo; the waiting block hangs from a pulley at x 436, clear of the crest and the halo.
  - Lashed timber scaffolding with planks and braces, dressed blocks and a mortar tub on the floor, and a threshold sill with the motto.
  - No window, no candles, no lattice and no bookshelves.

## Five idle behaviours (verbs from shared primitives)
1. **Lay a course** (stepped spin): the halo advances exactly one brick (12 degrees) in one eased step, then holds.
2. **Sight the level** (lean + scan): a 1.5 degree tilt left, a pause, a tilt right, the eyes sweeping to the far side each time, then back to plumb.
3. **Measure twice** (eye set + pulse): `narrow` eyes for 0.4 s, open, `narrow` again for 0.4 s, then one small nod.
4. **Tool check** (flutter per index): the four rope hangs swing in turn, left to right, as if a hand ran along them.
5. **Green build** (flare + pulse, after a passed task): one brightness pulse on the face and a 3 degree settle of the keystone crest. The halo does not spin.

## Quips (laconic, builderly)
1. Measure twice. Merge once.
2. Green. Next.
3. Small change. Ran it. Passed.
4. Spinning up the VM. Not your laptop.
5. VM stopped. Meter's off.
6. Broke it in the sandbox so prod doesn't have to.
7. That's not a refactor. That's a rebuild.
8. Square. Plumb. Next.
9. Mortar's still wet. Don't push yet.
10. It builds here. Now it builds everywhere.
11. Tests pass. Ran them twice.
12. Square, level, shipped.
- Annoyed (five pokes): "Hands off the scaffold."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is ignored** (same as both pilots). In `build-mascot.py` `main()`, after `crop = ...`, add:
   `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`
   Then `createMascot(host, data, {rail: true})` should use `data.cropRail` for the viewBox and the pivot percentages.
2. **The build prefix collides across bots.** The prefix is `name[:1] + 'x-'`: Scout, Scribe, Sentinel and Sculptor all get `sx-`, and Archivist and Assayer both get `ax-`. The generated `visorclip` clipPath becomes `sx-visorclip` for four bots, so a rail with several busts on one page resolves every `url(#sx-visorclip)` to the first one. Fix: `prefix = re.sub(r'[^a-z0-9]', '', name.lower()) + '-x-'`. The engine needs no change, because ids are only rewritten at build time.
3. **`L-body` is not in the contract.** It is used here, as by the Scribe. Add the row `L-body | optional | static torso, painted after L-halo-back, before L-plume | –`.
4. **Eyes inside a clip group are not in the contract.** Add: "`L-eyes` may sit inside one clip-path wrapper; the build appends the expression sets inside it." Builder needs it, because pointer tracking can move the eyes past the 10-unit viewport margin.
5. **The alarm anchor is coupled to the swing pivot.** Pivot + 6 puts the alarm on the seal, but it forces the seal to swing about a point inside the wax instead of its strap ring. Fix in `engine.js`: `const a = L.alarm || [L.pivot[0], L.pivot[1] + 6]`, with `data-alarm="x y"` carried by the build script like `data-pivot`.
6. **The VM cloud lands on the right pauldron.** `fx-cloud` sits at `halo pivot + 0.95R` across and `helm pivot + 0.55R` down, which is about 408, 378 for this bust. The Builder is the bot that lives in a VM, so the marker matters most here. Fix: an optional root `data-vm="x y"` (Builder: `418 236`, beside the brim tip) that overrides the computed position.
7. **The victory flip mirrors the `>_` sigil** for 0.9 s, as on the Relic. Add a per-token `data-flip="none"` (rotate only).

No reference, script or engine file was modified.

## Still weaker than Zealot (honest, after the fix round)
- **Value structure is better but still not Zealot's.** The portrait now has a pale diagonal shaft onto the right pauldron and halo, a cool-white pass on the blade and the build-log plate, and lifted dome and pauldron tops. The figure is still mid-grey gunmetal on a mid-dark backdrop. There is no single large pale mass like Zealot's bone tabard, so the greyscale read in `portrait-vs-zealot.png` is flatter than Zealot's.
- **Coat folds read as pleats.** The visible coat is two narrow side panels. The four overlapping planes per side have hard terminators and lit leading edges, but at 300 px they look like a pleated curtain more than heavy cloth.
- **Hands.** Each finger now has a knuckle cop, a joint hinge and a fingertip lip, but both fists are still stacks of eight rounded rectangles and only the upper hand has a thumb.
- **Silhouette still stocky.** Head plus hat is about 230 wide against 340 of pauldron. The face is no longer a TV (no ears, smaller aperture, three slots, chamfered chin), but the kettle hat plus square faceplate is still the squarest, most robotic profile in the roster.
- **Boots are dark.** The toe caps, ridge and stepped sole read at full size, but the soles sink into the near-black floor. There is a contact shadow, but no floor light under the feet.
- **Eyes:** the 7x4 cells are small in the 108-wide window, and the `#b9ffd8` glow cells are close to white. The expression still comes from the engine sets more than from the base pattern.
- **Beam haze.** The shaft is a soft blurred polygon (two layers). It is visible, but it is the one place in the portrait that is not painted with hard planes.

## Fix log (round 1, answering /home/claude/reviews/builder.md)
Evidence PNGs are in this folder: `fix-before-after.png`, `portrait-vs-zealot.png`, `detail-portrait-legs.png`, `detail-portrait-chest.png`, `detail-portrait-head.png`, `detail-helm.png`, `rail-test.png`, `engine-states.png`.

Blocking
1. **Portrait anatomy and value structure: PARTLY FIXED.**
   - FIXED, greaves: they now swell at the calf (about 71 wide) and narrow to the ankle (about 51). Each has a curved calf lame and an ankle lame (`detail-portrait-legs.png`).
   - FIXED, knee cops: proper faceted poleyns with a centre ridge, a lit plane and a shaded plane, a side wing and a teal strap, sitting below the hem.
   - FIXED, sabatons: each has an ankle lame, an instep lame, a domed toe cap with a ridge and a short point, and a stepped sole (thick heel slab, thin welt). They are turned out 8 degrees (the left rotates +8, the right -8). The heel block I first drew was removed because the two touched at the centre.
   - FIXED, dark fold between the greaves: a near-black under-tunic hangs in the gap with a centre crease.
   - FIXED, coat folds: four overlapping planes per side, each with a hard ridge, a shade plane, a lit leading plane and a crossing fold. Left ridges take the key light and right ridges take the cool rim. See "Coat folds read as pleats" above.
   - FIXED, focal accent: a pale shaft from the crown gap falls diagonally onto the right pauldron and halo. The blade has a cool-white pass and the plate has a top light. The first shaft covered the crest in haze, so it now starts at y 92.
   - FIXED, lift: dome lit side +12 percent white (portrait only), pauldron tops +24 percent on the left and a cool pass on the right.
   - PARTLY: the figure is still mid-grey overall (`portrait-vs-zealot.png`, and a greyscale check that I made in the work folder). The accents are small compared with Zealot's tabard.
2. **TV face: FIXED** (`detail-helm.png`, `fix-before-after.png`).
   - The two temple discs are gone, replaced by flush riveted gunmetal cheek plates (13 wide, rectangular with chamfered outer corners, two rivets each, rim light on the right).
   - The grille is one row of three narrow slots.
   - The aperture is 108 x 26 with radius 4, still one absolute path of M/L/C/Z only.
   - The eyes are re-centred at y 228-244 (xmin 252, xmax 348).
   - The chin is chamfered, with a lit facet, a shaded facet and creases.
   - The bezel is a thin 6-radius frame with four rivets.
   - Rebuilt with `build.sh` (pass) and the states proof re-run on dark and light.
3. **Leather: FIXED.**
   - The palette is now `#464440 #3b3834 #2c2a28 #1e1d1c` (saturation 8 to 11 percent). Stitches are teal-grey. The strap, belt, bib and lower apron use the same family. I also neutralised the trowel handle and the pencil tip.
   - A colour scan of both SVGs finds warm hues only in the seal, the brass ferrule, the sigil gold and the rope knots. The seal is the only warm element of any size (`fix-before-after.png` shows the brown bib before and after).
4. **Portrait crown clutter: FIXED.**
   - The hanging block and pulley moved to x 436 over the right pier side (the review suggested x 440-470). The block is now a squared dressed stone, because a keystone shape there read as a bucket.
   - A dark mortar-bed ring (r 160 around 300,186 in bust coordinates, `#0d1214`, opacity .55) sits under the halo, so the voussoirs separate from the bricks.
   - The crest is the only bright accent over the head. The grey index brick is part of the halo and stays.

Non-blocking
- Halo and Forgemaster at 48 px grey: PARTLY. The brim top highlight is raised about 15 percent (gradient top stop `#9eabb7` to `#b6c2cd`, glint opacity .45 to .6, lip glint .55 to .68). I did not render the Forgemaster, which is another agent's bot.
- Halo luminance in greyscale: FIXED in the art. The outer-face light strip minimum went from .12 to .30 and its gain from .55 to .60, so the dimmed bricks keep a lit outer edge. `rail-test.png` shows the grey ring.
- Green dilution: FIXED. The verdigris hue shifted from about 178 to about 186 with `hue_shift` in `gen.py`. The phosphor, the eye fills and the seal are untouched.
- Hands: PARTLY (see above).
- Elbow couter fins: FIXED. The fan wing is now a rounded side plate (`detail-portrait-chest.png`).
- Motto: FIXED. It is `#76838a` at opacity .95 (was `#a7b2b7` at .7 over a dark shadow copy). It is still partly hidden behind the boots, so only the outer words show.
- Mortar tub: FIXED. It now has staves, two iron hoops, a rolled rim, a wet mortar surface, a lit left face and a shaded right face.
- Scaffold over voussoirs: FIXED. The label code shifts each label along its stone until it clears every post by 14 units, so `c04` is readable at the left of the post (`detail-portrait-head.png`).
- Seal size and brightness: FIXED. The portrait seal is scaled .88, and the highlight dot is opacity .3 (was .45) in both files.
- Rail crop breathing room: FIXED. `data-crop-rail` is now `136 26 328 332`.
- Quip 8: replaced with "Square. Plumb. Next." Quip 6 stays.

Checks after the fix
- Strict XML parse: pass for both files. Sizes: bust 87,546 bytes, portrait 156,963 bytes, json 115,412 bytes.
- No style, script, image, foreignObject, `on*` or href. All non-contract ids start `bld-`, none are duplicated.
- Paint order: L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-1..4, L-front, L-token-1.
- `L-eyes`: 44 rects of 4x4 on multiples of 4, fills only `#ffffff` and `#b9ffd8`, right eye mirrors the left about x 300 (checked cell by cell). `L-visor-shape` uses only M/L/C/Z.
- States dark and light, all 8 (`engine-states.png`): no artefacts, the helm is complete in every state, and the alarm glow lands on the seal.

Contract/engine notes: unchanged from the list above. The fix round needed no new engine or contract change.
