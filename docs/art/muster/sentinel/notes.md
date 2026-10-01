# Sentinel (Legion muster), painter's notes

Files: `sentinel.layered.svg` (bust, 52 KB), `sentinel.portrait.svg` (600x800, 84 KB), `sentinel.json` (built, 78 KB), `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png` (all 8 states, real engine, dark then light background), `detail-helm.png`, `detail-board.png`, `detail-portrait-figure.png`.

Generator: `/home/claude/pilots/sentinel/gen_sentinel.py` is the only generator and was updated in the fix round (it emits exactly the delivered SVGs); it writes both SVGs. Helpers in the same folder: `rail.mjs` (rail lineup), `sheet.py` (side-by-side sheet), `check.py` (contract checks).

Build: `build.sh sentinel sentinel.layered.svg` passes with the build script unchanged. Layers: aura, halo-back, body, plume, helm, face, hang-1..5, front, token-1. Strict XML passes for both SVGs. There are no forbidden elements. Every id is `snt-` or an exact `L-*` id, and every reference resolves.

## Palette
| role | hex |
|---|---|
| Storm slate, cloth (dominant) | `#5a6e7b` `#435663` `#2f3e49` `#202b33` `#141c22` `#0b1015`, outline `#070b0e` |
| Storm steel (helm, plates) | `#aab6bf` `#8796a2` `#5b6a76` `#36434e` `#1c252d` `#10161c`, outline `#080c10` |
| Pale beam-white (halo, pennants, board lettering) | `#eef3f6` `#d3dce2` `#aebbc5` `#7d8c97` `#4c5862`; halo rays are dimmed further to `#c4ced6` → `#55626c` |
| Secondary hue: oilskin olive (moderate, the only one) | `#9a9d66` `#7a7d4c` `#5e6139` `#424428` `#2b2d1a`, outline `#18190e` |
| Lantern light (cool, dimmer than the visor, never amber) | `#aec4de` `#7d9cc4` `#6f90c0`, glass edge `#2a3b52` |
| Phosphor (visor, eyes, the board's `ok` glyphs only) | `#7CFFB2` `#b9ffd8` `#ffffff` `#eafff3` |
| Crimson (wax seal only) | `#ff6a78` `#b3202f` `#5e0d18`, sigil in pale gold `#f3dc94`, the only gold on the bot |
| Hemp rope, leather, wood (small neutrals) | `#b9b5a5` `#8a8676` `#4e4b41`; `#2b2a24`; `#6d6a62` `#47443e` |
| Portrait only: cool rim light `#b9c9e4`; signal-fire flame `#c9d8ea` `#a1b8d8` `#6f8fbf`; storm stone `#2c3742` → `#11161b` |

## Identity
- **Silhouette:** a round storm cap with a lantern spike on top. Behind it is a thick fan of beam rays, and the capelet flares wide at the shoulders (wider than the Inquisitor), over a long A-line storm cloak. A tall signal staff stands on the right. At 48 px it reads as a starburst with a spike and a wide shoulder shelf. No other bot in the roster has a radial ray halo or a lantern.
- **Signature prop:** the lantern-crown. It is a vented iron hood with a carry ring, a barrel glass cage with a cool white-blue mantle, a base plate and a socket. It is the `L-plume`, pivoting at the crown socket (300 184). Its light is dimmer than the visor and lives only in the plume, plus a faint spill on the dome top in `L-helm`. Nothing from the lantern is in `L-face`.
- **Halo:** a fan of 18 tapered beam rays. Long and short rays alternate, and two "sweep" rays (top and bottom) are longer and paler. Each ray is a bevelled blade with a darker half away from the key light. The rays sit on a narrow slate collar ring with 24 hour graduations and one pale index notch, so the rotation shows. A dark backing keeps the fan readable on a light page. Hue is pale slate-white, dimmer than the visor.
- **Visor aperture:** a wide band (112 x 20 to 22) under a heavy, slightly arched brow ridge. Both edges arch, so it is neither a slit nor a T, and it has no lancets. `L-visor-shape` uses absolute M/Q/L/Z only. The eyes sit in a clip of the slot interior.
- **Eyes (40 cells, mirrored, #ffffff and #b9ffd8 only):** a heavy, level lid that runs outward, with the core set low and inward. The look is patient and half-lidded: watching, not alarmed.
  ```
  ++++++.
  .+####+
  .+###+.
  ..+++..
  ```
- **Hang material (5 hangs):** two wind-torn storm-flap cloak tails off the capelet hem, a hemp signal rope with four small pennants (beam-white and olive) slung from the clasp to the left shoulder, the watch-log board on a cord from a riveted belt frog, and a swallow-tailed signal pennant on the staff yard.
- **Code-as-liturgy:** the hanging watch-log board: `WATCH`, `01:00 ok` … `04:00 ok` (the `ok` in phosphor, as code glyphs), and tally marks cut in fives. `while(1) watch();` is engraved along the brow ridge. The portrait adds the coping inscription (`00:00 ok · 01:00 ok ·` … `03:00 ok`) and the watchmen's tallies scratched into a merlon. Readable lines are 4.6 to 7 px.
- **Family mark:** the crimson wax seal with the Legion `>_` sigil (Relic geometry) on the cloak clasp. It is the only token, with its pivot at 300 358, so the engine's alarm glow (pivot + 6) lands on the seal's centre at 300 364.
- **Portrait backdrop:** the top of a watchtower at night in a storm. A crenellated parapet (the far side of the tower) has wet coping highlights. A stone turret with an arrow slit rises out of frame on the right. On the left, an iron beacon cresset on a post burns a cold white-blue signal fire, which is also the motivated key light from the left. The floor is wet flagstones in perspective, with the fire's broken reflection and a faint mirrored reflection of the figure. Wind-driven rain slants, low storm clouds sit overhead with a lightning-lit rim far to the upper right, and a mist band lies at the wall base. There is no window, niche, arch or candle.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | soft cool slate glow | – |
| L-halo-back | ray fan, collar ring, hour marks, index notch | 300 238 |
| L-body | long storm cloak with fold bands, olive oilskin coat, belt and frog, capelet with storm flaps, the funnel collar behind the helm (tips now rounded) and a dark neck gorget (y 286-348) so a lifted helm never shows the page | static |
| L-plume | lantern-crown | 300 184 |
| L-helm | neck flap, dome with comb ridge and rain streaks, lantern spill, face plate, visor frame, cheek vents, full riveted lower rim, heavy brow with engraving | 300 318 |
| L-face | visor glow, slot, scanlines, brow shadow (near-black), `L-visor-shape`, eyes in a slot clip | 300 318 |
| L-hang-1, 2 | storm-flap tails | 184 420; 396 432 |
| L-hang-3 | signal rope with pennants | 290 362 (clasp) |
| L-hang-4 | watch-log board | 258 512 (frog ring) |
| L-hang-5 | staff pennant | 424 172 (yard) |
| L-front | low front collar flaps and clasp bar, signal staff, right forearm and fist | static |
| L-token-1 | wax seal | 300 358 |

`data-crop="130 70 340 664"`. `data-crop-rail="136 52 328 358"` holds the whole halo at any rotation (outer radius 163 around 300 238, top at y 75), the lantern ring (top y 90), the collar, the seal (y 364) and the shoulder flare; the bottom edge is unchanged (y 410). The 23 units of headroom also cover the victory lift (-3.5 % of the 664 crop height).

## Five idle behaviours (verbs for persona.json)
1. **sweep:** the halo turns exactly one ray step (20 degrees) over about 2 s and holds, like a lighthouse beam passing. (spin, stepped)
2. **trim the wick:** the plume's lantern dims to about 70 % for 1.5 s and comes back. The face does not change. (pulse on L-plume)
3. **scan the horizon:** one slow eye pan from left to right over about 4 s, with blinks suppressed, then a single slow blink. (scan + blink hold)
4. **log the hour:** the eyes drop toward the board, the board hang gives one small swing, and the eyes come back up. (look down + flutter on hang-4)
5. **stand the gust:** the tails and both pennants lean the same way together for about 1 s while the helm stays perfectly still. (wave across hang layers, rig locked)

## Quips (patient, minimal)
1. All quiet. Still watching.
2. 03:00. Nothing moved.
3. Nothing to report. That is the report.
4. Cron fired on time. As it should.
5. I will wake you if it breaks.
6. One alert. Real. Look now.
7. The disk is filling. Slowly. I am counting.
8. Changed: one line. Everything else holds.
9. Still up. Still here.
10. The build is green. I am still looking.
11. Same as an hour ago. Good.
12. You asked me to watch. I am.
- Annoyed (five pokes): "Poking me does not make the night shorter."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is ignored** (same as the pilots). In `build-mascot.py` `main()`, after `crop = ...`, add: `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`. In `engine.js`, a `{rail: true}` option should use `data.cropRail` for `vb` and `pct()`.
2. **`L-body` is used** (static cloak, capelet and back collar, painted before `L-plume`). Add it to the contract: `L-body | optional | static | –`, with paint order `L-aura, L-halo-back, L-body, L-plume, L-helm, L-face, L-hang-N, L-front, L-token-N, L-halo-front`. No script change is needed (verified in the build and in all 8 states).
3. **Plume lights are not state-aware.** The engine dims only `L-face` in sleeping (`brightness(.45)`), so the lantern stays lit while the Sentinel sleeps. For a bot whose idle verb is "trim the wick", that is wrong. Fix: in `mascot.css`, add `.mx.mxs-sleeping .mx-plume { filter: brightness(.55) saturate(.6); }` (generic and safe for every plume). Better still, a persona value `"plumeLight": true` that also lets the engine play the trim-the-wick pulse.
4. **Victory flare whitens a pale halo.** `mx-flare` peaks at `brightness(2.2)`, so the slate-white rays go fully white for about a second (visible in `engine-states.png`). Make it a persona value, e.g. `"haloFlare": 1.15` for Sentinel and Scribe.
5. **Text on hangs.** The board's text lives on `L-hang-4`. Hangs only rotate a degree or two (`mx-sway`) and never run `mx-flip`, so the text never mirrors. Contract line: "Text may sit on static layers or hangs, never on tokens."
6. **Code glyphs outside `L-face` keep their colour.** The board's `ok` stays green in the amber and red states. It is small and reads as "the log says ok", but if the owner wants no green anywhere during an alarm, set those four glyphs to beam-white `#d3dce2` (a one-line change in `watch_board()`).
7. **Alarm glow.** No change is needed: the seal is the only token and its pivot is 6 above its centre.

## Still weaker than Zealot (honest)
- **Portrait drama.** It is a cool monochrome night: slate, steel and olive, with the green visor as the only saturated accent, and no warm mass by design (amber is reserved). Zealot's bone tabard against crimson has a value punch this lacks. The cold signal fire on the left now lights the wall, floor, rain and the figure's left side; it is dimmer than the visor but still competes for attention at thumbnail size.
- **Cloth.** The long cloak's folds are planes with hard terminators and a light edge on the lit side, but they are long and regular. The bust cloak uses one fold-banded gradient, which reads as stripes when seen up close. There are no overlapping or broken folds like Zealot's cape.
- **Arms and hands.** Both arms now have an elbow cop and a bracer plate, but the sleeves are still short smooth cloth tubes between them, and the fists are small at portrait scale and mechanical.
- **Rim light on the helm.** It is now a clipped sliver of the silhouette, but on the dome it still sits against the paler halo ring, so it is the least crisp part of the rim.
- **Ornament density.** The bust is deliberately quiet (it fits a bot that speaks rarely), but it has less engraved and riveted detail per square inch than the Relic or Zealot. The lower cloak is the plainest area.
- **48 px.** The identity is the starburst plus the lantern spike, both strong in greyscale. The 4 px eyes are about 0.6 device px at 48 px (the same limitation as every bot); the expressions resolve from 64 px at 2x.


## Fix log (round 1, against /home/claude/reviews/sentinel.md)
Rebuilt with `build.sh sentinel` (clean), strict XML ok for both SVGs, bust 52 KB, portrait 99 KB, ids all `snt-`/`L-*`, no forbidden elements, eyes/visor/pivots/layer order unchanged. Proofs regenerated: `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png` (dark above, light below), `detail-portrait-figure.png`, `detail-portrait-lower.png`, `detail-helm.png`, `detail-victory-max-lift-light.png`.

Blocking
1. Portrait floating rim hairline: **FIXED.** All strokes (dashed arcs, capelet arc, flap line, boot line) are gone. The rim is now a filled sliver: union of helm, collar, capelets and cloak minus the same union shifted 2.6 px left (mask in `edge_light()`), with the staff and fist masked out, so it exists only on the true right silhouette edge. The staff has a 1.1 px lit edge placed on the wood. See `detail-portrait-figure.png`.
2. Portrait lower body and arms: **FIXED (arms PARTLY).** Dark cloth lining plane with a centre terminator behind the legs (no black void); coat hem raised and scalloped; two plated greaves 32 px wide with a light left edge, shadow plane, two straps, a knee cop with fan lames; hem of the cloak broken into six overlapping lips with hard terminators; contact shadows under both boots and the staff foot. Both arms have an elbow cop with spike and a bracer plate; the left hand is 7 px lower with the cord looped over the knuckles. The sleeves between elbow and bracer are still plain cloth, so arms are PARTLY. See `detail-portrait-lower.png`.
3. Portrait value separation and light: **PARTLY.** Added a cold glow from the cresset on the wall, floor puddle, a lit rain layer around the flame, a bloom behind a brighter flame, a left lit edge (3 px, hard) on helm, capelet and cloak, a fire-light wash over the left of the figure, and a darker step of sky and wall behind the figure's left edge. Cloud blur replaced by hard-edged cloud banks with one lightning-lit rim. Better, but at 300 px (`portrait-vs-zealot.png`) it still lacks Zealot's bone-and-crimson punch.
4. Bust victory neck void: **FIXED.** A dark gorget with three lames (y 286-348) sits in `L-body` behind the helm. Verified at the maximum victory lift (translateY -3.5 %, rotate -2 deg, forced) on a light page in `detail-victory-max-lift-light.png`, and in sleeping: no page background shows.
5. Rail crop clips the spike: **FIXED.** `data-crop-rail="136 52 328 358"` (the review proposed 62; 52 also covers the victory lift). Lower edge unchanged at y 410. `rail-test.png` shows the spike, halo and seal whole.

Non-blocking
- Funnel collar ears: **FIXED** (tips lowered 18 px and rounded, rim and highlight redrawn).
- Olive coat saturation: **FIXED** (all olive values at 82 % saturation, a khaki step).
- Outline colour: **FIXED** (cloth `#0e1720`, steel `#121c26`).
- Portrait inscriptions: **FIXED** (moved off the pole onto the merlon faces, 6.4 px at about .4 opacity: `00:00 ok` left, `03:00 ok` right).
- Cloak bands on the bust: **NOT FIXED** (still one fold-banded gradient).
- Lantern in sleeping, victory flare on light: **NOT FIXED** (engine issues, proposed fixes 3 and 4 above).
- Forgemaster neighbour, staff in rail, eyes at 48 px: **NOT FIXED** (unchanged; no action requested).
