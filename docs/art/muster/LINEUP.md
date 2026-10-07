# Muster lineup test (13 bots, 2026-10-01)

> **2026-10-07: a 14th bot, the Quartermaster (`quartermaster`, glyph `⊞`), joined the roster without a painted bust.** It is not in this lineup, which was measured with 13. Until it has art it shows its glyph on the rail. Its bust needs the full contract (constitution, `docs/art/muster/quartermaster/`, `ui/src/mascot/data/quartermaster.json` from `scripts/build-mascot.py`, `ui/src/mascot/personas/quartermaster.json`, a `busts.ts` loader, and `test/mascot.test.ts` `BOTS`), then a new lineup run with 14 bots.

Gates from `legion-art-constitution.md`: rail test with a negative control, all bots side by side at 56 px with pips in idle and thinking, portrait contact sheet beside Zealot, colour-neighbour warnings. Everything below was rendered from the repo as it stands: the real engine (`ui/src/mascot/engine.js` in rail mode, `mascot.css`, `data/*.json`, `personas/*.json`), Chromium via Playwright, tile ground `#1d222a` (the app's `--surface-3`). Zealot uses `data/relic.json` with the rail crop from `personas/zealot.json`. Nothing outside `docs/demo/muster-lab/**` and this file was written; all proofs are in `/mnt/user-data/outputs/lineup/`.

| image | what it is |
|---|---|
| `lineup-48.png` | 13 bots + 1 outsider, 48 px rail crop, colour and greyscale, 1x and 3x nearest-neighbour. Roster order (store.ts defaults, then roster.ts). Outsider at position 12 of 14. |
| `lineup-48-blind.png` | same sheet, numbered 1 to 14, no labels. Key: the outsider is no. 12. Use it for a real blind test. |
| `lineup-48-hardcontrol.png` | same, but the outsider is a "family mimic" (dark armour, two green eyes, pale halo). |
| `lineup-56-pips.png`, `lineup-56-pips-light.png` | 13 at 56 px, idle and thinking, four pip variants (dark and light theme). |
| `lineup-56-attention.png` | awaiting and error at 56 px (used for copper vs amber). |
| `portraits-contact.png` | 13 portraits at equal height, Zealot first. |
| `lineup-metrics.json` | every number below (78 real pairs, both controls). |
| `lab-*.png` | proof screenshots of `docs/demo/muster-lab/index.html` (rail and stage, dark and light, portraits, states). |

## 1. Negative control at 48 px

I know where the outsider is, so my own look is not blind; `lineup-48-blind.png` exists for that reason. I cannot time a reviewer, so "faster" below is my eye plus numbers.

**Outsider A** (generic grey helm and shoulders, drawn from plain shapes: no halo, no light slot, no hang strips). By eye it is found at a glance, in colour and in greyscale, before any real pair is told apart. What gives it away is the missing family grammar (halo ring, bright green eye cells), not its colour. That makes it an easy control, so it proves little.

**Outsider B** (dark armour, two big green eye cells, a thick pale dashed halo). This is the fair test. It still stands out at 3x, because it has none of the painted detail (no rim light, no cloth, no hang strips) and its halo is a flat ring. At 1x it takes a second look, and it does not look like it was painted by a different studio, only by a lazier one. Read: the shared grammar (halo + two eyes + dark ground) is what makes the family read as a family at 48 px. Painterly detail adds little at that size. In effect "bots" means "a halo and two green eyes", and that is a genre signal.

**Numbers** (48 px tiles on the tile ground, downscaled to 24x24; `rgb` = mean per-pixel RGB distance 0-441, `grey` = mean luminance difference, `sil` = 1 minus soft IoU of the alpha silhouette, `edge` = mean Sobel difference, `comb` = the four metrics each divided by its median over all 78 real pairs, then averaged; median `comb` = 1.0). Smaller = more alike.

| | rgb | grey | sil | edge | comb |
|---|---|---|---|---|---|
| median real pair | 59.9 | 32.6 | 0.36 | 14.0 | 1.00 |
| closest real pair | archivist/sentinel 34.6 | archivist/sentinel 17.5 | builder/sculptor 0.17 | builder/inquisitor 9.9 | archivist/sentinel 0.65 |
| outsider A to nearest real | 47.0 (Archivist) | 24.7 (Archivist) | 0.28 (Archivist) | 10.9 (Archivist) | 0.77 (Archivist) |
| real pairs closer than A's nearest | 7 | 5 | 6 | 5 | 2 |
| outsider B to nearest real | 41.8 (Inquisitor) | 23.5 (Inquisitor) | 0.29 (Sculptor) | 13.5 (Inquisitor) | 0.86 (Inquisitor) |
| real pairs closer than B's nearest | 4 | 5 | 7 | 33 | 10 |

Closest real pairs by `comb` (top 8): archivist/sentinel 0.65, builder/sentinel 0.77, inquisitor/sentinel 0.78, inquisitor/forgemaster 0.79, builder/forgemaster 0.80, builder/sculptor 0.82, forgemaster/exorcist 0.84, builder/inquisitor 0.85. Then inquisitor/scribe 0.86 (9th of 78) and builder/archivist 0.86.

**Pairs flagged** (real pair closer than the outsider's distance to its nearest real bot, counted over the five metrics). Against outsider A: builder/sentinel 4 of 5, archivist/sentinel 4, inquisitor/sentinel 3, inquisitor/forgemaster 2, builder/forgemaster 2. Against the harder outsider B: archivist/sentinel 5 of 5, builder/sentinel 4, inquisitor/sentinel 4, inquisitor/forgemaster 4, builder/forgemaster 3, builder/sculptor 3, then a tail of 2s (zealot/archivist, builder/herald, forgemaster/sculptor, builder/inquisitor, builder/archivist, inquisitor/scribe, forgemaster/exorcist). Sentinel appears in every top pair.

**Caveat on the numbers.** A 24x24 pixel distance mostly measures "dark figure on a dark tile". It ranks archivist/sentinel as the most alike pair, yet at 3x they are easy to tell apart (walnut box head against blue-grey spiked helm). The metric is honest about one thing only: the dark bodies (Sentinel, Forgemaster, Inquisitor, Exorcist, Builder) sit nearer to each other than the pale or saturated ones do, and the plain outsider is not much farther from them than they are from each other. My eye agrees with the metric on the grouping, not on the ranking.

**Pairs I could not tell apart quickly by eye** (greyscale 1x, then colour 1x):
1. Builder / Forgemaster / Sentinel: three closed, toothed circular halos (battlement, gear, spikes) round a dark helm with two green cells. At 1x grey, Forgemaster's halo is dark iron on a dark tile and nearly vanishes, which leaves Forgemaster as a black body with eyes.
2. Inquisitor / Exorcist: a dark cone or hood with a thin ring. They separate by the Exorcist's broken ring and bone hem, and by Inquisitor's violet in colour. In grey 1x they are close.
3. Exorcist / Preceptor: dark top, ring arc. Easy in colour (Preceptor's white), close in the helm silhouette.

**Verdict.** Members with a genre risk. Colour and one strong mass tell Zealot, Herald, Archivist, Scout, Scribe, Preceptor, Sculptor, Assayer and Builder apart. The dark blue-grey cluster (Sentinel, Forgemaster, Inquisitor, Exorcist) reads as one genre at 48 px in greyscale. Faces cannot help: every bot has the same two bright green cells at the same height, by contract. Identity at rail size is carried by the halo and the helm outline alone.

## 2. Status pips at 56 px (`lineup-56-pips.png`)

Pip colours are the app's: `.pip` grey `--faint` (no VM), `.pip-on` green `--accent` with soft ring (VM live), amber `--warn` for the mood pip of thinking and awaiting (`relic.css` `.ml-thinking`, `.ml-awaiting`), `--danger` red, and the `.avatar.busy` ring (green).

Findings:
- **"Green means thinking" is not carried by colour in a still frame.** The visor and eye cells are phosphor green in idle, listening, thinking, hacking and victory. Measured idle vs thinking, eye cells: mean colour within 1 to 25 per channel, vertical centroid shift 0.3 to 1.9 px at 56 px (the `--sy` lift), plus a 4-step brightness breathe and the halo stepping. Thinking is told by motion, not hue. Only awaiting (amber) and error (red) change the light's hue.
- **The Relic mood label uses an amber pip for thinking** (same amber as awaiting), next to a green visor. Both next to each other is a contradiction in one frame: row "thinking / mood pip" in the sheet. Either make that pip green for thinking or keep the green ring (`avatar.busy`) as the thinking cue and leave amber to awaiting only.
- With the busy ring on, all 13 read as "working" at once at a glance; ring and visor agree.
- On the **light tile** (`lineup-56-pips-light.png`, eyeballed, not measured) pale halos lose most of their contrast: Zealot's green halo, Scribe's bone fan, Sculptor's marble ring and Assayer's silver chain. Dark halos (Builder, Forgemaster, Exorcist, Preceptor) gain. The family was tuned on a near-black ground (constitution lock 1), so this is expected; just do not promise light-theme identity.

## 3. Portrait contact sheet (`portraits-contact.png`)

Zealot first. The rest share centred frontal pose, one rim light and a floor line, with different architecture behind each (compromise from the constitution). They read as one studio, not as a saints trading-card set, because the backdrops differ. Closest pair: Scout and Sentinel, both a blue-grey cloak with an olive tunic. Zealot remains the only crimson mass and the only warm saturated large shape; Herald (mauve) and Preceptor (linen white) are the next loudest.

Defect found: `docs/art/muster/zealot/zealot.svg` (identical to `pilots/ref/zealot.svg`) is not well-formed XML. It has 25 raw `<` and 3 raw `&` characters inside glyph `<text>`/`<tspan>` runs, so a browser refuses it as an `<img>` or standalone file (xmllint: "StartTag: invalid element name"). It only renders through an HTML parser (inline). I did not touch the file; the lab embeds a copy with those characters escaped (build.mjs). Fix at the source (`&lt;`, `&amp;`) when Zealot is next unlocked for non-art edits.

## 4. Colour neighbours

Hues are HSV degrees; ΔE is CIE76 in Lab (about 2.3 = just noticeable, under 10 = same family at small size, over 20 = clearly different).

**Violet vs indigo (Inquisitor / Scribe): a real neighbour.** Palette: Inquisitor muted violet `#7a64a8` hue 259, Scribe muted indigo `#5865a3` hue 230: 29 degrees apart, ΔE 12.1; stole `#3d3160` against robe `#28306a` ΔE 9.2. Measured on the 48 px rail renders, saturation-weighted body hue: Inquisitor 251, Scribe 219, ΔE between mean chromatic colours 9.0. Their rail-distance rank is 9th closest of 78 (`comb` 0.86). What separates them is value and shape, not hue: Scribe has a pale bone fan halo and a bright blue body, Inquisitor a dark violet hood and a silver ring. Verdict: marginal, passes only on shape.
Herald is a third violet-side bot: mauve `#94789a` hue 289 (measured 304), 30 degrees from Inquisitor and ΔE 21.5, but much lighter and pinker. It does not collide.
Many more of the set sit in the cool 180 to 220 band: Scribe 219, Assayer 212, Sentinel 200, Forgemaster 201, Builder 191, Exorcist 183 (measured). That crowd is the real "genre" signal in colour.

**Copper vs amber (Forgemaster ember / UI amber): no collision, but the copper is invisible.** Copper `#a0583a` hue 18, `#b0603c` hue 19, rim `#985a3d`; UI amber `#FFCC66` hue 40 (light theme `#8f5d0c`, hue 37); the awaiting visor in the render is `rgb(254,201,98)`. ΔE copper to amber: 47 to 52 in dark theme (38 to 61 across the copper ramp), but only 21 to 23 against the light-theme text amber `#8f5d0c`, which is close. The engine's awaiting visor and "!" badge do not change with theme, so light-theme amber only touches text and pips, and the visor stays distinct. At rail size the copper is 62 opaque pixels of 14,688 on the 3x render (0.4%), mean `rgb(92,60,45)`, value 0.36 against 1.0 for the visor: it is a dark brown speck, not an identity colour, and it will never read as amber. Verdict: keep hue; the risk is the opposite, that copper does not show at all.

**Pewter (Archivist / Preceptor): a palette echo, not a rail collision.** Same-lightness steps of the two ramps: `#d9dbd6`/`#c9ccd0` ΔE 7.0, `#b0b4b2`/`#a4a8ae` 6.1, `#777c7f`/`#6c7077` 5.2, `#4a4e53`/`#50545a` 2.6, `#2f3236`/`#383b40` 4.2. They are the same metal. But the bust-level distance is large: rank 58th of 78 (`comb` 1.06), because the dominant masses differ (walnut against linen-and-lacquer) and so do the halos (card ring against protractor arc). Verdict: no collision at 48 px; a collision in a palette chart. The Archivist's own notes record the same decision (no change).

## 5. Recommendation: which bot, if any, shifts hue

One shift, if any: **Inquisitor, violet toward plum.** Move the secondary from `#7a64a8` (hue 259) to about `#8a5fb0` (hue 272). Computed: ΔE to Scribe's indigo `#5865a3` goes from 12.1 to 21.7, and ΔE to Herald's mauve `#94789a` goes from 21.5 to 28.4, so both neighbours open up; value stays dark so the "violet-black" brief holds. Scribe stays where it is, because moving it toward cobalt would run into Assayer's steel-blue (hue 212).

Not hue shifts, but the surgical fixes that matter more at 48 px:
1. **Forgemaster** has the weakest rail identity: nearest real neighbours are Inquisitor and Exorcist and its halo disappears on the dark tile. Lift the gear-ring value by roughly a quarter (edge-lit teeth, still dimmer than the visor) and make the copper inlay at least 3 px wide at 48 px (about 17 to 20 units in the 272-unit crop), hue unchanged, value under 0.6. That gives the family one warm accent and breaks up the blue-grey cluster.
2. **Sentinel**: the constitution calls for a "fan of beam rays"; the built halo is a closed spiky ring, which puts three closed toothed rings in the set (Builder, Forgemaster, Sentinel). Make the rays an open fan (about 240 degrees, a gap at the bottom) with long and short rays alternating, and the trio breaks.
3. **Inquisitor / Exorcist**: keep their rings different in kind. The Inquisitor ring is a full lens ring, the Exorcist ring is broken: widen the Exorcist gap (top-right) a little, or add a bone hem highlight visible at 48 px, so the pair does not depend on colour.
4. **Thinking cue**: since the visor hue is green in every calm state, give thinking one extra colour-independent cue that survives greyscale at 56 px (a larger eye lift of 3 px or a halo-step flash), and align the Relic mood pip (green or neutral, not amber).
5. Archivist, Preceptor, Herald, Zealot, Builder, Scout, Sculptor, Assayer: leave alone.

## Reproduce

`node docs/demo/muster-lab/build.mjs` regenerates the lab. The sheets and metrics came from scratch scripts (rail renders with the real engine, `sheet48.py`, `metrics.py`, `colour.py`) kept outside the repo; the numbers are in `lineup-metrics.json`.
