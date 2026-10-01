# Inquisitor: pilot notes

Source: `/home/claude/pilots/inquisitor/portrait.py` (the single entry point; it imports the shared parts from `gen.py` and writes both SVGs). Build check: `python3 scripts/build-mascot.py docs/art/inquisitor.layered.svg inquisitor` passes (97 KB JSON, 12 layers). Sizes: bust 75 KB, portrait 167 KB.

## Palette
- Iron (violet-black): `#6f6782` `#3e364b` `#251f30` `#15111b` `#0a080d`
- Cloth (cowl, mantle, robe): `#3d3150` `#2a2138` `#1c1626` `#120e19` `#09070c`
- Secondary hue, muted violet (one only): `#7a64a8`, light `#a08ccc`, dark `#463a63`. Used for the stole `#3d3160`, the cowl lining, the stamp ink `#9a86c8`, cord on the file stacks and the halo's index notch.
- Cold silver: `#f2f5f9` `#c3cad5` `#8a93a1` `#4f5664` `#262a33`
- Phosphor (slit, eyes and code only): `#7CFFB2` `#eafff3` `#b9ffd8`
- Family seal: wax `#ff6a78` `#b3202f` `#5e0d18`, with the sigil in `#f3dc94`. This pale gold is the only gold on the bot.
- Outlines: iron `#08070b`, cloth `#060508`, silver `#20242c`. No pure black.

## Identity
- **Silhouette:** a needle spire, a pointed cowl, a narrow shoulder shelf with iron spaulders, and a mantle tapering to a point. The result is a vertical spike about 2.3:1. The bust crop is 302 x 690.
- **Halo:** one thick cold-silver lens ring (R 130, 20 thick), offset up and to the right of the head. It has a bevelled bezel, 120 graduations, four screws, a muted-violet enamel index notch (so its rotation is visible), and an engraved motto: ASSUME HOSTILE INPUT · REPRODUCE · VERIFY · NOT FIXED UNTIL PROVEN. There is faint glass inside the ring.
- **Visor aperture:** a wide, low horizontal slit (88 x 18) under an overhanging brow band, with a dark green interior so the full 7x4 eyes, glow rows included, read against it. The severity comes from the slit's proportions and the brow shadow, not from clipping the eyes.
- **Signature prop:** a large reading lens on a chain, hung from the wax-seal clasp on the collar. In the portrait he holds it in both gauntlets. The glass genuinely magnifies the code on the stole behind it (2x), and one line, `sig.vrfy`, is underlined in green: the flaw he found.
- **Hang material:** short silver chains carrying chamfered iron case-file tags. Each tag has a punched ring hole, a `CASE #0211`-style serial, three or four engraved code lines (one green on two of the tags) and a stamped verdict in violet ink at 3.3 to 4.4 px: VALID, DOUBTFUL, NOT FIXED, NOISE, UNPROVEN. (QUESTIONABLE did not fit at 4 px; DOUBTFUL means the same thing.) The code lines and serials are 2.4 to 2.6 px, kept as texture on purpose.
- **Code-as-liturgy:** the verdict stamps; a column of audit litany on the stole (`verify()`, `repro()`, `fail cl`, `deny dfl` ... `again`, `again`, `amen`); `assume(input).hostile` engraved on the brow band; `CLAIM != PROOF` and `SHOW THE REPRO` on the collar either side of the seal; the halo motto. The portrait adds a hem band and the floor inscription NIHIL FIXUM NISI PROBATUM.
- **Family mark:** a crimson wax seal with the Legion `>_` sigil (the same geometry as the Relic's sigil) at the collar clasp.
- **Portrait backdrop:** a narrow iron tribunal alcove. It has a stepped lintel, riveted piers, a backlit diamond lattice screen above a panelled iron bench front, cold shafts from the upper left (behind the figure and, faintly, in front of it), and stacked iron-cornered case files on the floor line. There are no candles, window or arch.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | soft violet glow | – |
| L-halo-back | lens ring | 326 196 (ring centre) |
| L-plume | iron needle spire and ferrule | 300 122 (cowl peak) |
| L-helm | cowl over a complete iron helm (dome under cloth, brow, slit frame, full riveted lower rim) | 300 320 |
| L-face | slit glow, green spill on the lips, scanlines, `L-visor-shape`, eyes inside a slit clip | 300 320 |
| L-hang-1..5 | chain + case-file tag | each attachment point on the mantle edge |
| L-front | mantle with a shoulder shelf and two-lame iron spaulders, violet stole, standing iron collar, and the lens on its chain (static; it hides the neck when the head leans or sinks) | – |
| L-token-1 | wax seal (the only token) | 300 336, so the engine's alarm glow (pivot + 6) lands on the seal's centre at 300 342 |

`data-crop="160 22 302 690"`, `data-crop-rail="176 28 292 330"` (full ring, helm rim, collar, seal and shoulder shelf).

I checked it in the real engine (engine.js + mascot.css, all 8 states) in `engine-states.png`. Recolouring stays on the slit, the hacking code scroll is clipped to the slit, the alarm glow lands on the seal, victory shows ^ ^ eyes, and in the sleep state the helm sinks behind the collar.

## Five idle behaviours (built from shared primitives)
1. **inspect:** token-1 swings up about 14 degrees toward the viewer (the lens raised), the eyes switch to `narrow` for 1.2 s, then the lens drops back. (swing + eye set)
2. **click-the-dial:** the halo advances exactly one graduation step (3 degrees) or one screw (90 degrees) in a single eased tick, then holds. Clockwork, not a spin. (spin with steps)
3. **case review:** the tags flutter one after another, left to right, as if being leafed through. (flutter per index)
4. **the stare:** blink is suppressed for about 4 s and the eyes lock on the cursor. Then one slow blink. (scan + blink hold)
5. **slow verdict:** a single 1.5% nod while the face dims to 70% and returns. A gavel without a gavel. (nod + pulse)

## Quips (terse, dry, forensic)
1. Not fixed. Show me the repro.
2. Works on your machine. Noted. Irrelevant.
3. Every input is hostile until proven boring.
4. I read the diff. All of it.
5. Passing tests prove the tests pass.
6. Your regex has opinions. Bad ones.
7. Claim received. Evidence pending.
8. Line 212 knows what you did.
9. Verdict: questionable. Appeal denied.
10. Three out of three. Reproduced. Congratulations.
11. I don't trust the caller. I barely trust the compiler.
12. That's not a fix. That's a different bug.
- Annoyed (five pokes): "Poking is not a valid test case."

## Contract and script problems, with proposed fixes
1. **`data-crop-rail` is ignored.** Neither build-mascot.py nor engine.js reads it. Fix in the build script after `crop = ...`: `rail = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in rail.split()] if rail else crop`. Then `createMascot(host, data, {rail: true})` should use `data.cropRail` for the viewBox and pivot percentages.
2. **The visor bounds parser** (`nums[0::2]` in build-mascot.py) assumes absolute x,y pairs. H/V, relative or arc commands silently give wrong code-scroll bounds. Contract wording: "`L-visor-shape` uses absolute M/L/C/Z only." (Mine does.)
3. **Eye clipping is not in the contract.** A narrow slit needs it, because pointer tracking moves the eyes up to about ±13 px horizontally and 8 px vertically. I wrapped `L-eyes` in `<g clip-path="url(#inq-cSlit)">` inside `L-face`. The script finds `L-eyes` by id and appends the alternate eye sets inside the same clip, so it works unchanged. Proposal: allow this explicitly ("L-eyes may sit inside one clip-path wrapper").
4. **(Resolved in the art, round 3.)** Token flip mirrors the lens. In victory, `.mx-token` runs `mx-flip` (scaleX -1, twice), which briefly mirrors the magnified code in the glass. Proposal: a per-layer opt-out, `data-motion="swing"` (rotate only), from the constitution's planned enum. Round 3 moved the lens into static `L-front` instead; the option is still worth adding so it can sway again.
5. **The contract does not say where the body goes.** The Relic puts its body in `L-helm`. Because hangs hang from the mantle, I put the mantle in static `L-front`, so the tags never detach when the rig leans. Proposal: "the body/mantle belongs in `L-front`; hangs attach to its edges; `L-helm` is the head only."
6. **(Resolved in the art, round 3.)** The two tokens shared a pivot (the seal), so the two `fx-alarm` circles stack into one glow. Round 3 left the seal as the only token, with its pivot 6 above its centre. Engine note: alarm glows go on every token pivot, so a later bot with a non-seal token will want a per-token opt-out.

No edits were made to the build script, engine or references.

## Fix round 1 (independent review: NOT YET), what changed
Before/after sheets of the same views are in `before-after/`.

Bugs:
1. **Rail crop.** It is now `176 28 292 330`, which shows the full ring, lower rim, collar and seal. I re-ran the rail test.
2. **Lens text.** The magnified glass text is shifted right and clipped 2 px inside the inner glass circle, so no letters are lost under the bezel. Fixed in both the bust and the portrait.
3. **Mantle edges.** The bright silver hairline on both edges is gone. In its place: a dark local-hue trim, a fine stitched line whose gradient fades out to the right, a soft wide key-light sheen on the left (not a line), and one cool rim light on the right.

Polish:
4. **Portrait robe.** It now has crisp fold planes: a lit left ridge with a cool edge, two deep creases, a lit ridge beside the stole and a shadowed right panel. The rim light on the right is a crisp line broken into steps where the folds cross the edge, over a soft glow. The cowl has a broad violet key highlight. The high-frequency speckle is replaced by broad, low-frequency mottling, and the full-frame grime is reduced from .18 to .07.
5. **Arms and feet.** Gauntlets, cuffs and fingers are lighter steel (`inq-steel`) and read clearly against the robe. Sleeves are wider (about 20 to 32 units). The boots are pointed steel sabatons with three lames, a sole line and a highlight, and the robe hem is raised so they show.
6. **Hem litany.** It now sits on a curved textPath fully inside the hem band, fitted with `textLength`: "deny by default · verify(sig) · repro 3/3 · trust none".
7. **Rail legibility.** At 48 px greyscale the cowl edges now measure about 47% luminance on the left and 38% on the right, against 9% for the background. The spire is wider (10.4 units at the base) with brighter collars, but it is still only about 1.7 px at 48 px; see the list below.
8. **Shoulders.** The bust has a shoulder shelf at collar level in `L-front`, with two iron spaulder lames on each side. It no longer reads as a pod.
9. **Eyes.** The slit is 18 tall (was 14) with a darker interior. The eyes keep all their glow rows and read as eyes, not white blocks. The slit is still the brightest, most saturated element.
10. **Fonts.** The stack is now `ui-monospace, 'Cascadia Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace`. The key lines are at least 4 px: halo motto 5.2, collar 4.3, brow 4.2, stamps 3.3 to 4.4, lens about 6.7 effective, hem 4.6, floor 8. Tag code and the stole column are texture on purpose.
11. **Ring vs lattice.** A dark, soft band behind the ring separates it from the backlit lattice.

Also: the remaining crisp `#000` interior lines (tag bevels, file-stack shading, a ring bevel) now use dark local hues; only blurred cast shadows still use black. The portrait lattice rivets were merged into one styled group, which brings the file from 201 KB down to 168 KB.

Still passing: strict XML, contract ids and order, 44 eye cells on the grid and mirrored, build success, all 8 engine states (`engine-states.png`), distinct from the Relic at 48 px, no amber or red identity colours.

## Fix round 2 (re-review: NOT YET, mostly the portrait), what changed
Before/after sheets are in `before-after-r3/`. The awaiting and victory proof at 200 px on dark and light backgrounds is `awaiting-victory-200px-dark-light.png`.

1. **Alarm blob (bug).** The lens left the tokens. The wax seal is now the only token (`L-token-1`), with its pivot at 300 336, so the engine's alarm circle (pivot + 6) sits on the seal itself, at 300 342. Nothing stacks and nothing lands on the chain. No engine change is needed.
2. **Lens text cut (bug).** The magnified litany is generated as lens-local text. A row is drawn only if its whole box (advance 0.602 em, ascent and descent included) fits inside the inner glass circle minus 1.5. The glass base is now nearly opaque, so the small stole text no longer ghosts through. Four lines now fit fully in both the bust and the portrait: `hash ok`, `sig.vrfy` (flagged in green), `retry 3`, `timeout`.
3. **Portrait richness.**
   - **Second colour mass:** a muted-violet inner robe (`inq-under`, `#7a66a8` to `#2b2346`), an A-shape seen through the split of the outer robe.
   - **Folds:** two crisp folds on it, each with a lit plane, a hard terminator and a shadow plane tapering to a point; a lit plane and terminator on the left flank of the outer robe; a crisp fold on the right flank.
   - **Edges:** a lighter cool edge only on light-facing edges (the right flap's edge and the left flank). The left flap casts a shadow onto the inner robe.
   - **Hem:** wavy hems replace the symmetric hem bars. The silver hem embroidery and the litany follow the inner robe's hem.
   - **Texture:** speckle removed (no cloth texture on the portrait robe or mantle, no full-frame grime).
   - **Boots:** dark shafts with silver strap and buckle, steel toe caps, a sole line and a highlight. The inner robe's hem is raised so the boots show.
   - **Rim light:** still one cool rim light, on the right only.
4. **Lattice behind the halo.** A deep dark band (64 wide, opacity .9) plus a dimmed disc behind the ring, so the silver ring stands clear of the backlit lattice.
5. **Victory flip.** The lens now lives in static `L-front`, so the flip only turns the seal (as on the Relic) and the lens text never mirrors. Cost: the lens no longer swings. If a later engine adds a per-layer motion option (`data-motion="swing"`, rotate only, no flip), the lens can go back to being a token that sways.

Accepted as-is (per coordinator): the spire width at 48 px, and the tiny tag and stole text, which is texture on purpose.

Still passing: strict XML, contract ids and order (0 to 3 tokens: now 1), 44 eye cells on the grid and mirrored, build success, all 8 engine states, the 48 px rail lineup, no amber or red identity colours, no crisp black outlines.

## Still imperfect (honest list)
- **The portrait is still weaker than Zealot.** It now has two colour masses (violet-black and muted violet) plus the green slit and the silver ring, but no warm colour by design. It reads severe and quieter, not heroic. The violet inner robe is fairly flat between its two folds.
- **The cloth is drawn planes, not fully painted.** It lacks the shade-to-shade richness of Zealot's cape. The cowl is still a fairly even violet-black.
- **The arms are short.** The forearms come from under the mantle sides with no visible elbow.
- **The lens no longer swings in the bust** (it is static in `L-front`). That is the trade-off for no mirrored text and no stacked alarm glow, until a rotate-only per-layer option exists.
- **At 48 px, identity is carried by the ring, slit and cowl point.** The spire is about 1.7 px (accepted).
