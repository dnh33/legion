# Archivist (Legion muster): painter's notes

Files (all in `/mnt/user-data/outputs/muster/archivist/`):
- `archivist.layered.svg`: the bust, 79,095 B.
- `archivist.portrait.svg`: 600x800, 190,810 B.
- `archivist.json`: the build output, 103,556 B.
- Proofs: `rail-test.png`, `portrait-vs-zealot.png`, `engine-states.png` (dark and light), `detail-head.png`, `detail-drawer.png`, `detail-portrait-lower.png`, plus the fix-round proofs `halo-rotation.png`, `fix-halo-before-after.png`, `fix-lower-before-after.png`.

Generator: `/home/claude/pilots/archivist/gen.py` is the only art generator. It was updated in the fix round and emits exactly the delivered SVGs (byte-identical; checked with `cmp`). `railsheet.py` and `pvz.py` only build proof sheets.

Build: `build.sh archivist ...` passes with the unchanged script. It writes 14 layers: aura, halo-back, body, plume, helm, face, hang-1..6, front, token-1.

Checks that pass:
- Strict XML.
- No style, script, image, foreignObject or on* attributes.
- Every id is `arc-` or exact `L-*`, with no duplicates. The portrait has no `L-*` ids.
- Eyes: 42 cells, all 4x4 on the 4 px grid, mirrored, fills only `#ffffff` and `#b9ffd8`.
- `L-visor-shape` uses only M, L and Z (absolute).

## Palette
| role | hex |
|---|---|
| Walnut (dominant) | `#875a3a` `#6e4630` `#4a2f1e` `#2e1d12` `#20140c`; lit face `#966443`; top face `#9a7151`; head box lifted in the fix round to `#9c6c49` `#82583b` `#5f3f2a` `#3c2618`; outline `#170e09` |
| Pewter | `#d9dbd6` `#b0b4b2` `#777c7f` `#4a4e53` `#2f3236`; top `#e8eae5` `#c6c9c6` `#9a9fa1` (raised); cap and visor frame `#e6e8e3` `#c2c6c3` `#8f9497` `#60656a` (raised); outline `#191b1e` |
| Secondary hue: cool slate label grey (the only one) | `#8797a8` `#66778a` `#46556a` `#2c3644`; card ink `#2c3644`; mantle cloth `#7a8ba0` to `#10141a`; portrait hem band (fix round) `#6a7c92` to `#394658`, stitch `#8797a8`, hem text `#c9d4e0` |
| Index-card paper | `#dcd6c5` `#c6c0ae` `#959080`; halo cards dimmed a second time in the fix round: `#726f60` `#646154` `#4a483d` (about 20 percent below the old `#8e8a7b` family); outline `#4d483d` |
| Brass, tiny label frames only (head label, drawer label) | `#e3d08f` `#b5954c` `#6b5422` |
| Crimson, wax seal only | `#ff6a78` `#b3202f` `#5e0d18`; sigil `#f3dc94` |
| Phosphor (slot, eyes, code scroll only) | `#7CFFB2` `#b9ffd8` `#ffffff`; slot interior `#0b4029` to `#169457` to `#4fe39a` |
| Cool rim light (right only) | `#a9c2dc` |

No amber or red identity colour anywhere. The brass is kept to two small label frames and does not read as the amber state colour at any size.

## Identity
- **Silhouette:** a tall rectangular tower. It has a square box head with a pewter cornice cap, visor frame and chamfered riveted lower rim. Shoulders are stacked drawer fronts, three a side, drooping 9 degrees outward and bound by a pewter strap. There is a winding key on the right side of the head (clockwork). The torso is a catalogue cabinet with a pewter centre strap.
- **Halo (rebuilt in the fix round):** a rotation-invariant ring: 24 shingled index cards (39 x 20) laid tangentially on a radius-78 circle, on a flat pewter rail ring, with four pewter binder clips (at 25, 155, 205, 335 degrees, clear of the winding key). Six cards carry slate tabs pointing outward, which gives the ring a rolodex edge. Cards are dimmed (see palette) and carry a slate header rule plus key/value dash rows. There is NO text on the halo any more (it used to hold four frontmatter fragments), so nothing can turn upside down, and no dark blurred backing, so it reads on light backgrounds. Its farthest point is 96 px from the pivot: swept 0 to 90 degrees it spans x 204 to 395 and y 70 to 262, well inside `data-crop` (x 186 to 414, y 40 to 500). The earlier 184 x 216 rectangular frame is gone.
- **Plume:** five slate pressboard guide cards fanned in a pewter rod clamp, with celluloid tab windows lettered A F M S Z.
- **Visor / light slot:** one open drawer slot, a wide shallow rectangle (88 x 24). Inside:
  - near-black drawer side walls in perspective (it reads as a cavity, not a screen);
  - a lid shadow and scanlines;
  - the pulled drawer's lip below it: a pewter top surface catching green light and a walnut front edge.

  The brass label holder (`ARCHIVE`) sits directly above the slot.
- **Eyes** (flat-lidded deadpan: level, appraising, unimpressed):
  ```
  .++++++
  ++####+
  .+####.
  ..+++..
  ```
- **Signature prop:** a catalogue drawer pulled out and held open at the chest in both pewter hands (three articulated fingers over the front edge, a thumb on the rim). Inside:
  - cards standing with staggered slate tabs;
  - one card raised for review, tab `214`, reading `last touched: 214d`;
  - the front card shows YAML frontmatter at 4.7 px: `---`, `title: auth-notes`, `updated: 2026-03-02`, `status: stale`, `---`.

  The drawer front has a brass `A-D` label, a pewter cup pull and a hasp.
- **Family mark:** a crimson wax seal with the Legion `>_` sigil. It hangs from the drawer hasp and is the only `L-token-1`. (Two very short slate tails are drawn under it, but the seal and the pewter strap cover almost all of them; they are not a visible feature and there are no readable ribbon tails. An earlier version of this note overstated them.)
- **Hang material (6):**
  - four manila index tags on string, each with a slate-reinforced eyelet: `stale 214d`, `orphan no refs`, `dup x2`, `keep v3`;
  - two slate silk ribbons tucked under the collar.

  Tag text is 4.4 px.
- **Code-as-liturgy:**
  - the frontmatter card;
  - the raised `last touched` card;
  - the halo's key/value dash rows (frontmatter-shaped, no glyphs; the earlier readable fragments were removed because halo text can turn upside down);
  - the tag verdicts;
  - the portrait's hem stitching `keep · or · archive`;
  - the crate plaque `KEEP OR ARCHIVE`.
- **Portrait backdrop:** a reading-room aisle between two walls of catalogue cabinets in true one-point perspective. It has:
  - cabinet cornices every six rows, pilasters and a plinth (the floor line);
  - a hazed far wall of drawers;
  - a rolling library ladder hooked on a pewter rail along the right wall;
  - perspective floorboards;
  - a cool backlight pool on the far wall and a faint light shaft from the upper left;
  - low floor haze;
  - catalogue trays (2019, 2021, 2023) and spilled cards on the left, and an archive crate on the right.

  There is no arch, window or candle.
- **Portrait colour masses:**
  - walnut figure (body, head, legs with gear knees and boots built from a walnut upper, a pewter instep plate with strap and buckle, a separate pewter toe cap, a heel block and a dark sole slab);
  - a slate dust-sheet mantle behind, painted as tube folds. Each fold has a lit plane, a hard terminator and a reflected side, and the hem is scalloped with a mid-slate stitched hem band (readable against the floor). One extra overlapping fold per side cuts across the tubes at its own angle, with a cast shadow beneath its edge.

  There is one cool rim light, on the right only.

## Layer map
| layer | content | pivot |
|---|---|---|
| L-aura | faint slate glow | – |
| L-halo-back | ring of cards (rotation-safe) | 300 166 (ring centre = head centre) |
| L-body | torso cabinet, upper arms, gear elbows, forearms, shoulder drawer stacks; fades out at y 455 to 500 (mask) | – |
| L-plume | guide-card fan and rod clamp | 300 104 (clamp on the cap) |
| L-helm | box head: cap, forehead panel with brass label, visor frame, drawer lip, cup-pull jaw, corner brackets, lower rim, winding key | 300 244 |
| L-face | slot glow, interior, cavity walls, scanlines, lip spill, `L-visor-shape`, eyes inside a clip of the slot | 300 244 |
| L-hang-1, 3 | tags on string from the outer shoulder straps | 213.95 323.87 / 386.05 323.87 (as in the file; the earlier notes quoted stale values) |
| L-hang-2, 4 | slate ribbons from under the collar | 262 258 / 338 258 |
| L-hang-5, 6 | tags on string from under the drawer | 270 416 / 331 416 |
| L-front | collar (pewter band and walnut gorget), the drawer prop, both hands | – |
| L-token-1 | wax seal on ribbon tails | 300 422 (the seal centre is 300 428, so the engine's alarm glow at pivot + 6 lands on it exactly) |

Crops:
- `data-crop="186 40 228 460"`.
- `data-crop-rail="184 24 232 288"` (tightened in the fix round, because the halo is smaller): head, plume, collar and shoulders, and the whole ring at any rotation. Rotation sweep, 0 to 90 degrees in 5 degree steps: the halo never leaves x 204 to 395, y 70 to 262, so it fits both `data-crop` and the rail crop. `halo-rotation.png` shows 0, 22, 45, 68 and 90 degrees against the `data-crop` edge.

Engine (`engine-states.png`): all 8 states render correctly on dark and light backgrounds.
- Recolouring stays on the slot.
- The hacking code scroll is clipped to the slot.
- The alarm glow lands on the seal.
- Victory shows ^ ^ eyes.
- Sleeping sinks the helm behind the collar, and the helm stays complete.
- No artefacts.

## Five idle behaviours (from shared primitives)
1. **Thumb through:** the six hangs flutter once, left to right, while the eyes scan down one row (flutter per index + scan).
2. **Re-file:** the halo turns one card-width (about 15 degrees) in one eased step, then holds (stepped spin). The halo is a ring now, so the stock continuous spin is also fine; this is only a nicer idle.
3. **Check the date:** the eyes switch to `narrow` for 1.2 s and the rig leans 2 degrees toward the drawer, as if reading the raised card (eye set + lean).
4. **Flick the guide cards:** a single short shiver of the plume, then stillness (flutter on plume).
5. **Wind down:** one slow 1.5 percent nod while the face dims to 70 percent and returns. Later, an `L-part` spin on the winding key could turn it a quarter turn at the same moment (nod + pulse).

## Quips (precise, dry)
1. Last touched 214 days ago. Archive it or love it.
2. Two files, one idea. One of them is leaving.
3. Nothing links here. Nothing has for some time.
4. This note says "temporary". It is from 2024.
5. Filed under A, for "already exists".
6. Your TODO has a TODO.
7. I don't delete. I archive, with a date.
8. Undated means unknown. Unknown means stale.
9. Three drafts called final. I kept the one that is.
10. No frontmatter. No title, no date, no excuse.
11. Moved, not lost. There is a forwarding card.
12. Indexed. Cross-referenced. Quietly judged.
- Annoyed (five pokes): "Hands off the drawers. They are in order."

## Contract and engine problems, with exact fixes
1. **`data-crop-rail` is still ignored by `build-mascot.py`.** This is the same as both pilots. In `main()`, after `crop = ...`, add `cr = svg.get('data-crop-rail'); out['cropRail'] = [float(v) for v in cr.split()] if cr else crop`, and give `createMascot` a `{rail: true}` option that uses `data.cropRail` for the viewBox and the pivot percentages.
2. **Resolved by the art:** the halo is now a ring, so the circumscribed-circle rule and the step90 persona value are no longer needed for this bot. (The general wording is still worth adding to the contract: `data-crop-rail` must contain the circle around the halo pivot that passes through the halo's farthest point.)
3. **Resolved by the art:** the continuous 70 s spin is harmless for a ring. No `haloMotion` persona value is required for the Archivist.
4. **The victory flare (brightness 2.2) on a paper-card halo** still washes cards briefly. The cards are about 20 percent darker now and read as a mid-grey ring, so the flare no longer goes near white (see `engine-states.png`, victory), but a persona `"haloFlare": 1.1` would still be cleaner.
5. **Eyes need a clip in a shallow slot.** The slot is 24 tall, while tracking, look and state offsets move the eyes up to about ±16 px horizontally and ±11 px vertically. `L-eyes` therefore sits inside `<g clip-path="url(#arc-cSlot)">` within `L-face`. The build script finds `L-eyes` by id and adds the expression sets inside the same clip, so it works unchanged. Contract wording: "`L-eyes` may sit inside one clip-path wrapper."
6. **`L-body` is used here** (static, after `L-halo-back`, before `L-plume`), with a mask fade at the bottom of the bust. Add the contract row `L-body | optional | static | –` (the same request as the Scribe's).
7. **Hang text:** hangs never flip, so the tag text is safe. The only token (the seal) carries no text beyond the shared sigil.

No edits were made to the build script, engine or references.

## Still weaker than Zealot (honest)
- **Drama and colour:** the portrait is walnut, pewter and slate with one green slot. It reads austere and quiet, not heroic. There is no saturated mass like Zealot's crimson and no bold value accent apart from the chest cards and the visor.
- **Rigid figure:** the box-on-box build is the character, but the mid-section (belt, tassets, thighs) reads as stacked boxes. The upper arms are mostly hidden under the shoulder stacks, so the arms read as elbows and hands.
- **Mantle:** the folds are still graphic tube planes with hard terminators, not painted cloth, and the scalloped hem is regular. The fix round added one overlapping fold per side, but the right one is on the shadow side and reads faintly. Zealot's cape has more varied, overlapping folds.
- **Boots:** now real forms (instep, strap, toe cap, heel, sole), but still pewter-blocky; the heel is only a small step at the outer ankle in a frontal view. The floor contact is visible but modest (a dark wedge under each sole and the cape, on a faint cool floor sheen), not a strong cast shadow like Zealot's candle pools.
- **Hands:** mechanical pewter capsules with knuckle rivets. They read as hands, but they are plainer than Zealot's gauntlets.
- **Halo at full size** is a dim ring of beige cards: safe under spin, but a quiet identity carrier. In the portrait its lower third hides behind the shoulders and mantle. In greyscale at 48 px the ring (value about 75 to 80) is close to the walnut head (about 87); it separates by outline and shape, not value.
- **Figure-ground:** the walls of drawers echo the figure's drawers. Darkening the walls and the backlight pool separate them, but the figure pops less than Zealot does against his window.
- **Small text:** YAML is 4.7 px and tags 4.4 px. The halo carries no text any more. Hem text is 5 px.

## Fix round (review: /home/claude/reviews/archivist.md)

Edited only `gen.py` (updated, still the single generator) and re-emitted both SVGs, the json and the proofs. Nothing outside the named elements was restyled, with two small notes: the portrait backdrop wall paths were rounded to one decimal to stay under the size limit (the geometry moves by under 0.1 px), and the whole portrait figure group is scaled by 0.955 about the floor for headroom.

### Decisions
- **Halo:** rebuilt as a ring (see Identity), not a square, so it is rotation-invariant by construction and needs no engine change.
- **Pewter collision with the Preceptor: the Archivist palette is NOT changed.** The review does not confirm a collision that belongs to the Archivist: it says that the constitution's starting palette gives pewter to the Archivist, that the Preceptor is the one that should shift its metal to graphite or neutral steel, and that at 48 px the two do not collide (walnut mass against linen and black). So walnut stays the dominant mass, pewter stays the metal, slate stays the one accent hue, and no sage-grey or other new hue was introduced (it would have made a fourth hue group on a bot the review already counts as walnut, pewter and slate plus paper and brass). Action for the Preceptor owner (not done here, I do not touch other bots): move the Preceptor's metal to blackened graphite or neutral steel and give its accent a hue that is not violet, teal or blue-grey. To help the slate plume and the pewter cap read as separate things, the cap and visor frame were lifted in value instead (cap about 122 to 155 in 64 px greyscale).

### Fix log (second reviewer: please verify; I default to being strict)
| review item | verdict | evidence |
|---|---|---|
| B1 halo is a 184x216 rectangle that tumbles and leaves data-crop | FIXED | `fix-halo-before-after.png` (old frame at 45 deg is a diamond across the plume; new ring identical at every angle); `halo-rotation.png`; rotation sweep 0-90 deg spans x 204-395, y 70-262, inside `data-crop` x 186-414, y 40-500 |
| B1 dim the cards about 20 percent (the frame was as bright as the cap) | FIXED | cards `#726f60 #646154 #4a483d` (was `#8e8a7b` family); greyscale 64 px: ring about 75-80 against cap about 155-196 |
| B1 halo text can turn upside down; dark backing smudge on light backgrounds | FIXED | no text on the halo; blurred dark stroke removed; `engine-states.png` light half (all 8 states) |
| B1 `!` bubble overlapped the halo in awaiting | FIXED | `engine-states.png` awaiting cell: bubble sits outside the ring |
| B2 stilt legs: widen stance and boots about 20 percent | FIXED | thigh centres now 38 px off the axis (was 29), thigh 60 wide (was 50), shin 52 (was 44), toe cap 78 wide (was 62), sole 86; `fix-lower-before-after.png` |
| B2 boot toe cap and heel as separate forms | PARTLY | toe cap, instep plate with strap and buckle, heel block with pewter heel plate, sole slab are separate shapes; the heel reads only as a small step at the outer ankle (frontal view). `detail-portrait-lower.png` |
| B2 light-side terminator, cool rim on the right only, snapped to the edge | FIXED | left boot and leg: pale lit edge; right: darker terminator band plus rim clipped to the silhouette (`detail-portrait-lower.png`) |
| B2 near-black hem; raise two steps, stitch `#8797a8` | FIXED | band `#6a7c92`-`#394658` (was `#1c2430`), stitch `#8797a8`, hem text 5 px bold `#c9d4e0`; `fix-lower-before-after.png`. The text is a short run at the left of the hem and is readable at 1000 px; at 300 px it is texture |
| B2 contact shadow under each boot and the cape | PARTLY | a dark ellipse under each boot (0.75) and under the cape (0.5) on a cool floor sheen, visible as a wedge under the soles; modest at 300 px (`portrait-vs-zealot.png`) |
| B2 one extra overlapping fold each side | PARTLY | left fold is clearly visible; the right one sits on the shadow side and reads faintly (`detail-portrait-lower.png`) |
| B3 rail: halo plus box too wide, greyscale body merges with halo | FIXED | smaller, dimmer ring; rail crop tightened to `184 24 232 288`; `rail-test.png` |
| B3 lift cap and drawer-front value, raise visor-lip pewter; eyes stay brightest | FIXED | 64 px greyscale: cap front 122 to 155, walnut head 72 to 87, lip and cap top 193-196, eyes 230 (next brightest 196); `rail-test.png` greyscale cells |
| NB pewter collision with the Preceptor | DECISION: no change | see Decisions |
| NB slate plume vs pewter cap near-duplicate | PARTLY | no hue change; the lifted cap separates them in value |
| NB arms: widen forearms about 25 percent | PARTLY | forearms 19 to 24 and 16 to 20, wrist cuff 19 to 24; upper arms are still hidden under the shoulder stacks and the hands are unchanged |
| NB mid-torso value clutter | FIXED | torso drawers behind the open drawer darkened one step (`detail-drawer.png`) |
| NB rim hairlines floating off the leg edges | FIXED for legs, ankles and boots (clipped to the silhouette); the hip tasset rims are unchanged panel-edge lines |
| NB notes mismatch (seal tails, hang pivots) | FIXED | notes corrected above |
| NB portrait tight at the top | FIXED | figure scaled 0.955 about the floor: plume tip about y 75 (was 43), ring top about y 101 |
| NB backdrop shelf lines vs vanishing point | NOT FIXED | not touched |
| NB small text | unchanged | deliberate texture; halo text removed |

Checks run after the fix: strict XML parse OK for both SVGs; no style, script, image, foreignObject or on* attributes; all ids `arc-` or exact `L-*`, no duplicates, the portrait has no `L-*` ids; bust 79,095 B, portrait 190,810 B, json 103,556 B; `build.sh archivist ...` passes (14 layers, the script is unchanged); eyes 42 cells all 4x4 on the 4 px grid with only `#ffffff` and `#b9ffd8`; `L-visor-shape` is absolute M/L/Z; all 8 states checked on dark and light backgrounds with the real engine (`engine-states.png`), helm complete in every state.

New contract or engine requirements from this round: none. (Existing note 1, `data-crop-rail` ignored by `build-mascot.py`, still stands; notes 2 and 3 are now resolved by the art.)
