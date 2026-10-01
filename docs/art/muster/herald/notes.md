# Herald (Legion muster): painter's notes

The Herald is the Legion's voice to the outside world. He drafts emails, chat messages and announcements, and never sends anything without approval. Formal, brisk and ceremonial, a little proud of a well-turned announcement.

## Files
- `herald.layered.svg`: the animated bust (62 KB). `data-crop="112 0 376 560"`, `data-crop-rail="136 0 356 346"`.
- `herald.portrait.svg`: the 600x800 portrait (121 KB).
- `herald.json`: the output of the real `build-mascot.py`, run via `tools/build.sh`. Build **passes** with the script unchanged; 85 KB; 15 layers in order: aura, halo-back, body, plume, helm, face, hang-1..7, front, token-1.
- Proofs:
  - `rail-test.png`: 48 and 64 px, colour and grey, 1x and 2x DPR, against the Inquisitor, the Scribe and the Relic, plus a 3x nearest-neighbour inspection.
  - `portrait-vs-zealot.png`: 300 px each.
  - `engine-states.png`: all 8 states through `engine.js` and `mascot.css` at CW 200, on dark and light backgrounds.
  - `detail-helm.png`, `detail-portrait-banner-hands.png`.
- Generators (the only ones, both final): `/home/claude/pilots/herald/gen_herald.py` (bust and shared parts) and `portrait_herald.py` (imports the shared parts). Helpers: `railsheet.mjs`, `cmp.py`.

## Decisions taken while the owner was asleep
- **Humanoid tabard-and-banner bearer, as the council ruled.** No bird, no wings, no satchel. I went with a true herald's tabard: a front panel plus two broad, square-cut cloth sleeves over the shoulders. This is the historical herald's garment, and it makes heather-mauve the dominant colour shape at 48 px. My first blocking used large steel pauldrons; the rail test showed grey steel dominating, so I replaced them.
- **Charge (the device on the tabard): a gold chevron reversed (V), which reads as an envelope flap.** It is a heraldic pun on sealed dispatches. It appears on the chest and on both sleeves; the banner carries the same charge.
- **Embattled (crenellated) gold hems** on the sleeves and the portrait tabard. This is a heraldic line, and it ties the figure to the gatehouse behind him.
- **Pole in the figure's left hand (viewer's right), in both the bust and the portrait.** The pennon on the helm flies left to balance it.

## Palette
| role | hex |
|---|---|
| Heather mauve (the one secondary identity hue; dominant mass) | `#d6bdd3` `#b89cb9` `#94789a` `#785d7e` `#584260` `#3c2c44` `#251a2c`, outline `#170f1c` |
| Portrait cape (darker values of the same hue) | `#4a3752` `#3a2b42` `#2a1f31` `#1a1220` |
| Steel (neutral, a hair cool) | `#c4cbd6` `#949dab` `#646d7c` `#434a57` `#2a3038` `#161a20`, outline `#0c0e12` |
| Helm steel (darker, so mauve dominates) | `#a7b0bd` `#76808e` `#4d5562` `#313741` `#1b1f26` |
| Heraldic gold (trim only, pale and desaturated, not the amber state colour) | `#f3e4ad` `#d6bd73` `#a88d48` `#6b5527`, outline `#33280f` |
| Crimson (wax seal only) | `#ff6a78` `#b3202f` `#5e0d18` `#3a060d`, sigil `#f3dc94` |
| Phosphor (visor slot and eyes only) | `#7CFFB2` `#b9ffd8` `#ffffff`, slot interior `#2a8f5c` to `#04140c` |
| Lacquered pole and leather | `#6e5566` `#3e2b3a` `#1e141d` |
| Horn | `#8a6c72` `#4d363f` `#24171e` |
| Dispatch ink | `#2b1a31` |
| Cool rim light (right side only) | `#bccbff` |
| Portrait moonlight (gate) | `#93a3c6` `#56637f` `#262d3f` |

There is no green outside `L-face`. The banner text is in plum ink, so in the amber and red states nothing else stays green.

## Identity
- **Silhouette:** a round armet dome with a staff rising from the crest that flies a long swallow-tailed pennon; square tabard shoulders; a tall banner on a pole beside the head. At 48 px it reads as a mauve crown-arch with a flag on top, and a pale vertical banner on the right.
- **Signature prop (no other bot has it):** the banner pole. It is a lacquered pole with a gilt finial, a crossbar, two tassels, and a gonfalon with three tongues. A small horn hangs at the hip from the baldric; in the portrait his left gauntlet rests on it.
- **Halo (redrawn in the fix round):** a closed, 6-fold-symmetric heraldic ribbon ring, 40 units thick (radius 96-136 around 300,196, max about 137 with clasps), so the engine's 360 degree spin always looks right. Six swallow-tailed mauve ribbon lengths lie end to end on a dark reverse-side ring; each length ends in a hard-edged fold shadow and a swallow-tail notch, and a gold clasp bridges each joint. A dashed gold stitch line runs down the centre. There is NO text, no directional shadow and no dark backing smudge (it reads on light backgrounds), and a lighter outer rim keeps an edge in greyscale. The mid-value mauve stays dimmer than the visor.
- **Visor aperture:** a wide, chamfered letter slot (104 x 28) with a small steel notch hanging from the brow into its centre, like the flap of a mail slot. The notch sits between the eyes. A small gold lozenge on the brow marks the centre. The cheeks have letter-slot breathing vents.
- **Eyes:** a flat, lowered glow lid with the pupils weighted down and inward, for a composed, faintly haughty look. 7x4 per eye, mirrored, 42 cells, `#ffffff` and `#b9ffd8` only:
  ```
  ++++++.
  .+####+
  .++###+
  ...+++.
  ```
  The eyes are clipped to the slot (`L-eyes` inside one clip wrapper, as the Inquisitor's are).
- **Hang material (7 hangs):**
  - Hang 1: a mauve ribbon streamer with a forked, gold-edged end, hung from a rosette at the left sleeve's hem.
  - Hangs 2 and 3: tassels from the crossbar ends.
  - Hangs 4 to 6: the banner's three pennant tongues. Their tops sit under the fringed hem in `L-front`, so there is no seam when they sway.
  - Hang 7: the horn on its strap.
- **Code-as-liturgy:** the banner is a sealed dispatch: `TO: ALL HANDS`, `RE: build 418`, `STATUS: sent` (6 px bold in the bust; 7.2 px in the portrait, which adds `BY: herald`). The text sits on static `L-front`, so it never mirrors. The portrait's string course is carved `NIL · SINE · SIGILLO` ("nothing without a seal": he never sends without approval).
- **Family mark:** the crimson wax seal with the Legion `>_` sigil, on the banner bracket. It is the only `L-token-1`. Its pivot is `440 152`, so the engine's alarm glow (pivot + 6) lands on the seal's centre at `440 158`. Verified in the awaiting state.
- **Portrait backdrop:** a castle gatehouse.
  - The main arch has voussoirs and a keystone, a receding vault, and a far gate opening onto cool moonlight with a distant curtain wall.
  - The raised portcullis's teeth show at the top of the far opening.
  - A machicolation string course with corbels carries the motto, with crenellations above.
  - Each side has a narrow arcade arch and a shadowed hanging banner (chevron and saltire).
  - The floor is perspective flagstones over a plinth course, with a moonlight spill, a low mist and the figure's cast shadow.
  - There are no candles, no window and no niche copy.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | soft mauve glow | – |
| L-halo-back | closed 6-fold ribbon ring with gold clasps, no text | 300 196 |
| L-body | mail neck, torso plate, arms, both tabard sleeves, front panel, baldric, gorget lames (static; fades out at the bottom) | – |
| L-plume | crest staff, gilt finial, swallow-tailed pennon | 300 102 (crest socket) |
| L-helm | dome with medial ridge, brow band with gold trim and rivets, the slot frame and notch, hinge bosses, bevor with vents, full riveted lower rim | 300 290 |
| L-face | slot glow, scanlines, green spill, `L-visor-shape` (absolute M/L/Z), clipped eyes | 300 290 |
| L-hang-1..7 | streamer, 2 tassels, 3 banner tongues, horn | each attachment point |
| L-front | pole, crossbar, banner with dispatch text and fringe, bracket, folded forearm, couter, gauntlet, streamer rosette | – |
| L-token-1 | wax seal | 440 152 |

The rail crop holds the whole ring (maximum radius about 137 around 300 196, so x 163-437, y 59-333) at any rotation, plus the pennon finial, the banner and its tassels, and the collar.

## Five idle behaviours (engine verbs from shared primitives)
1. **Clear the throat:** a single 1.5% nod up (chin lifted), the face brightens to 115% for 0.6 s, then settles. (nod + pulse)
2. **Dip the standard:** the pennon plume swings 6 degrees forward and back once, slowly. A salute. (swing on `L-plume`)
3. **Unfurl the ribbon:** the halo advances exactly 60 degrees in one eased move and stops, one ribbon length to the next clasp. (stepped spin)
4. **Check the seal:** the eyes switch to `narrow` and glance down-right toward the seal (`--lx 4px, --ly 3px`), and the seal gives one small flutter. (scan + flutter on token-1)
5. **Wind in the banner:** the three tongues sway in sequence from left to right, then the two tassels. (wave across `L-hang-4..6`, then `2..3`)

## Quips (formal and brief)
1. Hear ye: the build is green.
2. Drafted. Sealed. Awaiting your word.
3. I do not send. I propose to send.
4. Announcement ready. It is, if I may, rather good.
5. To: all hands. Re: nothing broke. Status: astonishing.
6. Your email had three apologies. It now has none.
7. The changelog has been proclaimed. Twice, for the back rows.
8. Subject line trimmed to eleven words. Ten would be vulgar.
9. I have read it aloud. It scans.
10. Nothing leaves these gates without a seal.
11. Reply-all detected. I have taken the liberty of not.
12. Let it be known: tests pass.
- Annoyed (five pokes): "Decorum, please. I am mid-proclamation."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is ignored** by `build-mascot.py` (same as both pilots). In `main()`, after `crop = ...`, add `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`, and give `createMascot` a `{rail:true}` option that uses `data.cropRail` for the viewBox and pivot percentages.
2. **`L-body` is not in the contract yet.** I use it (static torso and sleeves, painted before `L-plume`). Add the row `L-body | optional | static | –`. The build script and engine already handle it.
3. **Eyes clipped inside one wrapper** (`<g clip-path><g id="L-eyes">`). The script appends the expression sets inside the same clip, so this works unchanged. Add to the contract: "`L-eyes` may sit inside one clip-path wrapper."
4. **The victory flip mirrors the seal's sigil** for about 0.5 s, the same as on the Relic. Text was kept off the token on purpose. Proposed fix: a per-token `data-flip="none"`.
5. **Halo flare on a mid-value ribbon:** brightness 2.2 at the start of victory turns the mauve ribbon pale pink briefly. It is acceptable here; a per-bot `haloFlare` value (for example 1.4) would be cleaner.
6. **Hang weight at the rail:** the tassels and tongues are about 1 px at 48 px (the banner itself reads); this is the same issue as the pilots, and an engine rail mode with a minimum strip weight would help.
7. **(Resolved by art.)** The halo is now a closed 6-fold ring, so the full 360 degree spin is correct and no `haloMotion` change is needed. A per-token `data-flip="none"` and a per-bot `haloFlare` are still wanted (items 4 and 5).

No reference, engine or contract files were modified.

## Still weaker than Zealot (honest)
- **The portrait has less drama.** The moonlit gate gives a backlight, but there is no single saturated focal glow like Zealot's green window, and no warm counter-colour (the candles). The palette is mauve, steel and pale gold only, by design.
- **The tabard reads boxy and stiff.** That is historically right for a herald, but it lacks the overlapping, sweeping folds of Zealot's cape. The pleats are planes with terminators, but still fairly regular. The cape behind is simple.
- **The arms and hands are plainer than Zealot's.** The forearms are tubes with a couter and one lame line. The left hand is a lamed mitten on the horn; the right hand's fingers are stroked bands. At full size they are readable, not rich.
- **The helm is a clean round armet,** with less ornament than Zealot's great helm (no engraving or filigree). At 48 px in greyscale the dome is a mid-grey mass; the identity comes from the ribbon crown, the pennon and the banner.
- **The bust's lower half** (the horn and lower sleeves) is cut by the fade at the crop bottom. The horn is small in the bust.
- **The portrait chest is still mostly one mauve mass** with a baldric shadow; the folds are on the skirt. The green slot spill is deliberately faint, so there is still no Zealot-scale focal glow.

## Fix log (round 1 review, /home/claude/reviews/herald.md)
Generators `gen_herald.py` and `portrait_herald.py` are the current sources; they were verified to emit exactly the previous art before editing. Light direction is unchanged: key light upper left, cool rim on the right. So lit edges and highlights sit on the LEFT of each fold and cast shadows fall RIGHT and down (the review's "left and down" wording assumed a right-hand key; I kept the art self-consistent). Evidence PNGs are in this folder and in /home/claude/pilots/herald/fix/.

Blocking
1. Halo does not survive rotation: FIXED. Redrawn as a closed 6-fold ring with no text and no shadow (Option A). engine-states.png (dark and light, 8 states) shows the ring around the head in every state, never over the banner as a loose scarf and never upside-down text; on the light background there is no smudge. It fits `data-crop-rail` (rail-test.png).
2. Portrait not Zealot-grade: PARTLY.
   - FIXED: skirt now has four overlapping curved fold wedges with hard creases and a lit edge (detail-portrait-banner-hands.png); belt and baldric cast hard shadows on the tabard; mauve outlines are `#2a1b30` and steel outlines `#1b1f26` throughout the figure (no near-black); the moon disc is a vertical gradient (pale at the head, dark at the floor), the portcullis teeth are gone (removed rather than redrawn), a brighter glow sits behind head and shoulders, and mist bands lie on the floor; faint green slot spill on chin, bevor and gorget; cape folds are higher contrast with a lit ridge; a cast shadow falls on the floor to the right.
   - NOT FIXED: the chest remains one broad mauve mass with only a baldric shadow, the overall colour drama is still far below Zealot (portrait-vs-zealot.png), and the green spill is kept faint because a stronger one turned the mauve grey.
3. Grain on helm dome and bevor: FIXED. The noise is cut to alpha .12 (about a third), masked to the lower plates only, and sits under the specular highlights; the dome is clean (detail-helm.png).
4. Translucent chest and sleeve chevrons and the pale slab: FIXED. All chevrons (bust chest and sleeves, portrait chest and sleeves) are opaque gold gradient `#f3e4ad` to `#a88d48` with `#33280f` outline. The pale vertical slab (a flat-topped lilac plane) is deleted and replaced with tapered fold wedges that start under the chevron (detail-helm.png, bottom).

Non-blocking
- Pennon covering the motto: FIXED (the motto no longer exists on the halo).
- Rail crop clip: FIXED, now `136 0 356 346`.
- Hang weight at 48 px: NOT FIXED (engine rail-mode issue, see Contract problem 6).
- Portrait hands and arms: PARTLY. The left hand is now a back plate with four separate fingers and a thumb over the horn, so the horn shows; the right stray tasset is removed. The forearms are still plain tubes.
- Horn ring and two wires: FIXED. One leather strap to a gold band on the horn (bust).
- Boots: PARTLY. Darker, wider contact shadow, instep strap with gold buckle, lit toe cap and sole line; still small.
- Bust bottom fade: unchanged (accepted by the review).
- Greyscale at 48 px: FIXED for the ring: its lighter outer rim holds an edge in the grey columns of rail-test.png.

Checks: both SVGs parse as strict XML; no style, script, image, foreignObject or on* attributes; bust 62 KB, portrait 121 KB; `build.sh herald` passes (15 layers, 85 KB) and `herald.json` here is the built output; `L-eyes` still 42 cells; all contract ids, pivots and paint order unchanged.
