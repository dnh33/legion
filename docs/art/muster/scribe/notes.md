# Scribe (Legion pilot), painter's notes (fix round 2, final)

Files: `scribe.layered.svg` (bust, 102 KB, `data-crop-rail` 140 6 320 320), `scribe.portrait.svg` (600x800, 166 KB), `rail-test.png` (Scribe vs Inquisitor vs Relic), `portrait-vs-zealot.png`, `detail-helm.png`, `detail-codex.png`, `detail-pauldron.png`, `detail-portrait-hem.png`, and `engine-states.png` (the built JSON run through the real `engine.js` and `mascot.css`).

Before/after sheets: see the fix round 2 section below.

Generators: `/home/claude/pilots/scribe/gen_scribe.py` (bust and shared parts) and `portrait_scribe.py` (scene and lower robe). They are the only generators and they are final.

Build: `python3 scripts/build-mascot.py docs/art/scribe.layered.svg scribe` passes, with the script unchanged. It writes `scribe.json` (134 KB) with layers aura, halo-back, body, plume, helm, face, hang-1..5, front, token-1.

## What changed in fix round 2 (the latest)
1. **Rail crop bug fixed.** `data-crop-rail` is now `140 6 320 320`, which holds the whole halo, rolls included, at any rotation (radius about 145 around 300 178), plus the plume tips. The rail test was re-run at 48 and 64 px, colour and greyscale (`rail-test.png`, `ba-rail48.png`). Note: `build-mascot.py` still ignores `data-crop-rail`; it needs a `cropRail` field (fix in note 2 below).
2. **Robe folds repainted as planes.** Each fold now has a flat lit plane, a crisp light edge on the light side, a hard dark terminator line, and a flat shadow plane that only softens at its far side. This applies to the robe, the underrobe, the torso and the sleeves.
3. **Left gauntlet redrawn.** It now has a tapered cuff coming out of the sleeve mouth (two lame lines), a rounded hand behind the cover edge with a raised knuckle ridge, and three articulated, tapered fingers wrapping the fore-edge.
4. **Right sleeve decluttered.**
   - One quill now, through a small stitched leather loop.
   - The belt band, the buckle and the second quill are gone.
   - The seal strap has no brass clasp. It hangs from the hasp riveted to the codex cover and runs straight into the silk cord and the seal.
5. **Eyes re-patterned.** Seven cells moved from core to glow. The 3-cell core row narrows to a 2-cell pupil row, weighted to the inner side, so both eyes converge on the book. This is not a bar, and not a T (Zealot's mark). Still 7x4 per eye, mirrored, 44 cells on the 4 px grid, `#ffffff` and `#b9ffd8` only:
   ```
   .+++++.
   +++###+
   .+++##+
   ..++++.
   ```
6. **Codex lifted, rim light contained.**
   - The pages were lifted a step (`#cbc0a3` to `#ddd4bc`) with a lighter shade overlay; the visor is still the brightest element.
   - The portrait's rim light is clipped inside the right sleeve and pauldron, and is painted before the pinned quill, so it never crosses it. The helm rim now sits in the helm's own squeezed frame, clipped to the shell; before, it floated off the edge.
7. **Pauldrons.** Added an outer crescent plate riding the dome, with a rolled edge, a rivet, worn highlights and scratches. Each pauldron is now five plates: cop, crescent, dome and three lames.

Before/after sheets for this round (round 2 vs round 3): `ba-portrait.png`, `ba-lower-robe.png`, `ba-bust.png`, `ba-hands.png`, `ba-eyes.png`, `ba-rail48.png`.

## What changed in fix round 1
1. **Lower robe, hem and boots (portrait).** The robe folds are now painted planes: a lit ridge, a hard terminator edge, then a shadow plane fading right (light from the left), plus a hard-edged form shadow on the right flank. The over-robe is split at the front. Inside the split: a dark interior, steel greaves with a centre ridge, and a muted-indigo underrobe that ends at y 700 with a bone hem. The jointed sabatons (ankle lame, two foot lames, toe cap) are painted last, so they stand in front of the hem band.
2. **Hands and quill.**
   - Left gauntlet: the back of the hand sits behind the cover, and three articulated fingers (three tapered plates each, curling) wrap the fore-edge onto the page.
   - Right gauntlet: it carries the book from below, with three fingers curling up over the bottom edge.
   - The quill is held in the left fist outside the book and rises over the sleeve. No page text is covered. The left page text was re-flowed to sit above the fingers.
3. **Lintel.** The beam moved to the top edge (y -4 to 12), clear of the crown; the quill tips reach about y 18. The motto now sits on two carved boards over the rack and the shelves (`WRITE IT DOWN`, `OR IT DID NOT HAPPEN`), in light text with a dark engraved shadow.
4. **Focal hierarchy.**
   - The halo base was dimmed to `#b8b4a4`, with dimmer rolls and a lower bone glow.
   - The codex pages are now darker parchment (`#b9ae90` to `#cdc3a8`) with a top-down shade overlay. They are still readable at full size (`detail-codex.png`).
   - The visor is now the only bright saturated element.
5. **Pauldrons.** Each is now four plates: an overlapping upper cop plate with its own rolled edge and brass rivets, the dome, and three lames below. Added irregular edge wear, nicks on the rolled edge and scratches. The pen-nib charge is smaller and sits on the dome.
6. **Plume.** Five longer quill pens (90 to 112), asymmetric: a tall pair leaning left, one upright, one short and thrown wide right. Vane tips are ink-dipped (a crisp dip line at 80 % of the vane).
7. **`L-body` layer.** The torso is now in a static `L-body` group painted after `L-halo-back` and before `L-plume`. The bookmark ribbons and cords hang in front of it, and it fades only at the very bottom of the bust (y 462 to 500). `build-mascot.py` keeps it unchanged (it collects every top-level `L-*` in source order). `engine.js` places it as a static `mx-body` layer on the float, under the rig, and it renders correctly in all six states. No fallback was needed.
8. **Right sleeve and the seal strap.** The quills went into a buckled band and the seal strap onto a riveted hasp; simplified in fix round 2.
9. **48 px read.**
   - The bone arc is thicker (28 px) and visibly open at the bottom: a 144-degree gap.
   - The quill fan is longer and mostly bone.
   - In greyscale the bust is now a bright open arch with a spiky crown, against the Inquisitor's thin closed ring (`rail-test.png`, `ba-rail48.png`).
10. **Eyes.** Changed to a heavy-lidded pattern; superseded in fix round 2.
11. **Robe "stars" removed.** The dust motes are now painted behind the figure (in the light shaft only), and six ink flecks were added on the robe.
12. **Codex glyph colours.** The `+` marks are now bold muted indigo (`#3c4780`) and the `-` marks are ink. No green outside the visor, so in amber and red states nothing on the codex stays green. The portrait's floating green glyphs are gone.

## Palette
| role | hex |
|---|---|
| Ink-indigo cloth (dominant) | `#0d1029` `#171c42` `#1f2654` `#252d62` `#303a78`, robe `#1c2350` `#28306a`, outline `#090b1c` |
| Blued steel | `#171a29` `#3a405b` `#717994` `#a7aec8`, outline `#0d0f1c` |
| Cool bone (halo, dimmed) | `#56523f` edge, `#b8b4a4` base, fibre `#aaa594` |
| Quill vanes | `#d4cdb7` to `#f7f5ee`, ink-dipped tips `#2c3264` to `#10132b` |
| Warm parchment (codex, in shadow; trims) | `#8a7f60` `#b9ae90` `#cdc3a8`, trims `#d3c7a6` `#f0e8d3` |
| Secondary hue: muted indigo | `#3c4780` `#5865a3` `#7884bd` (hue about 230 degrees; violet is about 270) |
| Ink black | `#07081a` `#141836` |
| Brass, sparing | `#6f5622` `#c29f4e` `#ecd590` |
| Crimson, wax seal only | `#5e0d18` `#b3202f` `#ff6a78` |
| Phosphor (visor and eyes only) | `#7CFFB2` `#b9ffd8` `#ffffff`, window top `#2fd58a` |
| Cool rim light | `#aebcff` `#c3ceff` |

## Identity
- **Silhouette:** a wide bell. The tall bell helm sits on broad layered pauldrons, with wide bell sleeves below and a quill fan above.
- **Signature prop:** an open codex held at the chest. Left page: a changelog. Right page: a diff hunk. The quill is held in the left fist.
- **Halo:** a thick open arc of an unrolled scroll in dimmed cool bone, open at the bottom. It has a fat roll on one end and a thin roll on the other, each on a lacquered rod. Two lines of writing run along it.
- **Visor:** twin lancet windows (compound path, absolute M/L/C), each with a transom bar and an oculus ring. An engraved pilcrow sits on the mullion.
- **Hang strips (5):** three silk bookmark ribbons, plus two ink-stained cords with brass page weights.
- **Token (1):** a strap from a hasp riveted to the codex cover, ending in a silk cord and a pendant crimson seal with the `>_` sigil.
- **Code-as-liturgy:** the diff hunk on the codex. Echoes: the engraved brow band, the scroll text, and the ¶ § † hem stitching.
- **Backdrop:** a timber-framed scriptorium bay with a scroll pigeonhole rack, shelves of scrolls and codices, a slanted lectern, two motto boards, a floor line, a book stack and crumpled drafts, and one cool light shaft from the upper right.

## Five idle behaviours
1. **Proofread** (scan): short left-to-right eye sweeps, each line ending with a 2 px drop.
2. **Weigh the sentence** (lean and nod): a 2-degree lean forward, the plume still for 1.5 s, then one small nod.
3. **Advance the scroll** (stepped spin): the halo turns exactly 12 degrees and stops.
4. **Check the bookmarks** (wave): the hang layers sway in sequence from left to right.
5. **Ruffle the quills** (flutter): one low plume shiver after a long idle, answered by a single flutter of the seal.

## Quips (12)
1. Noted. Dated. Signed.
2. That was a sentence fragment. It is now a sentence.
3. Your README promises a section 4. There is no section 4.
4. I added a comma. It was lonely.
5. Changelog updated. Nothing was filed under "misc".
6. The semicolon stays; it has earned its place.
7. "Fixed stuff" is not a commit message. It is a confession.
8. If it is not written down, it did not ship.
9. Documented the bug. It is now a known issue, which is a promotion.
10. Your TODO is from March. I have dated it, gently.
11. One clean paragraph. I will allow myself a moment.
12. Approved, pending one hyphen.

## Contract and script notes, with proposed fixes
1. **`L-body` is used but not yet in the contract.** Add this row to `MASCOT_CONTRACT.md`: `L-body | optional | static (robe or torso) | – |`, and give the paint order as `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-N, L-front, L-token-N, L-halo-front`. The build script and engine need no change. If a later engine ever rejects unknown ids, the fallback is to move the `L-body` children to the start of `L-front` and restore the old torso fade (the generator keeps the `scr-torsoFade` mask for this).
2. **`data-crop-rail` is ignored by `build-mascot.py`; it needs a `cropRail` field.** In `build-mascot.py` `main()`, add `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else None`. The engine needs a rail mode that uses it.
3. **The victory flare still clips the halo to white** (brightness 2.2, settling at 1.25), even with the dimmer base: see `engine-states.png`, victory. Make it a persona value, e.g. `"haloFlare": 1.08`, or use `drop-shadow` for light halos.
4. **Visor-bounds parsing.** `build-mascot.py` reads the bounds as `nums[0::2]`, so `L-visor-shape` must use absolute M/L/C/Q/Z only. Add that as a line in the contract.
5. **`L-face` tinting.** The state filters tint every mid-tone inside `L-face`. Add a contract note: inside `L-face`, use only the light, and near-black for tracery and frames.
6. **Eye weight at the rail.** At 48 px with the whole halo in the crop, a cell is about 0.7 device px. The new pattern reads as a shaped glow, not a bar, but the individual expressions only resolve from 64 px at 2x. Proposed fix: an engine rail mode that draws the eye sets at 1.5x.

## Still weaker than Zealot (honest)
- **Drama of the portrait.** It is still quieter: a dark library, indigo on indigo, with no backlit window and no single bold value accent like Zealot's bone tabard against crimson.
- **Robe.** The folds are planes with hard terminators and light edges now, but they are still long and fairly regular. Zealot's cape has more varied, overlapping folds. The hem is a smooth band, not a weighted, broken hem.
- **Gauntlets.** The fingers are articulated and the left cuff is now tapered, but the hands are still mechanical at full size and neither shows a thumb.
- **Sabatons.** They are segmented and sit in front of the hem, but at portrait scale they are small and their toe caps are simply shaded.
- **Halo.** The open-bottom arch reads strongly at 48 px. At full size it can read as a horseshoe or a headphone band more than a curling scroll; the rolls help but are small.
- **The left motto board** sits close to the halo's lower-left roll at portrait scale.
- **The victory flare** whitens the halo (engine note 3).
- **Fonts and tiny text:** Georgia and Consolas fall back to DejaVu on Linux; the text is legible at full size and texture below that.
