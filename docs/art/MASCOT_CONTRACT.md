# Mascot layer contract (Legion)

Any mascot the engine animates is ONE hand-painted SVG with these top-level groups (ids exact).
The build script (`scripts/build-mascot.py`) splits them into stacked, GPU-composited layers,
so painted detail is never redrawn or simplified.

Paint order = the order listed. Coordinates are document coordinates of the source SVG.
`data-pivot="x y"` = the rotation/sway origin in document coordinates.

| id | required | moves how | pivot |
|---|---|---|---|
| `L-aura` | yes | static soft glow behind everything | – |
| `L-halo-back` | yes | rotates (slow idle, fast thinking, flare on victory); a ring may also step one notch at a time (persona verb) | halo centre |
| `L-body` | optional | static torso / mantle / robe, painted after `L-halo-back` and before `L-plume` | – |
| `L-plume` | yes | sways (crest / plume / finial; may be a flame, quill fan, antenna, lantern or smoke wisp) | where it attaches to the helm |
| `L-helm` | yes | the head group: leans/nods/bonks as one rig with plume+face; complete (dome, frame, full lower rim), never cropped | neck point under the helm |
| `L-face` | yes | recoloured by state (green, amber, red, dim) | same as helm |
| `L-hang-1..N` | 3–8 | each sways independently (cables, cloth strips, ribbons) | its attachment point |
| `L-front` | optional | static, moves with the body (collar, clasp, mantle). Body or mantle that hangs and tags attach to goes here (or in `L-body`), so nothing drifts off it when the head leans | – |
| `L-token-1..N` | 0–3 | flutter/flip (seals, pendants, badges). Text or a directional sigil must not mirror: add `data-flip="none"` and it only rocks | attachment point |
| `L-halo-front` | optional | rotates with the back halo | halo centre |

Inside `L-face`:

- `L-visor-shape`: a `<path>` with the exact light opening (the single light slot; it need not be a visor: a cross, twin arches, a lens), used as a clip for the "code scroll". **Absolute `M/L/C/Q/Z` commands only**: the build script reads the path numbers as x,y pairs for the scroll bounds. A rotated or translated wrapper around the whole of `L-helm/L-face/L-plume` is fine (the scroll is inserted in the same frame), but `data-pivot` stays in document coordinates.
- Visor light layers (glows, gradient fill, scanlines) are free-form.
- Inside `L-face` use only light (greens, the glow) and near-black tracery (bars, brow lips, frames): the state recolouring is a CSS filter on the whole layer, so any mid-tone there tints with it.
- `L-eyes`: two pixel eyes made ONLY of `<rect width="4" height="4">` cells on a 4px grid. It may sit inside ONE `clip-path` wrapper (shallow slots, slanted slits); the build appends the expression sets inside the same wrapper. A slanted slot must be at least 16 + the rise across the eye span + 4 units tall. The base pair may be asymmetric; expression sets are always mirrored.
  - Each eye is 7 columns × 4 rows. The right eye mirrors the left.
  - Fill: `#ffffff` for core cells, `#b9ffd8` for glow cells. The group gets the glow filter.
  - The engine derives the expression sets from these positions: narrow, happy, wince, shut, angry.
  - Base pattern:

    ```
    .++++..
    ++####.
    ++####+
    .+++++.
    ```

Put nothing else that must move inside `L-helm`. The helm must be complete: dome, visor frame and the full lower rim. Do not crop it.

The root `<svg>` needs `data-crop="x y w h"`, a tight box around the character. There is no background scene: the page supplies the background.

## Root attributes

| attribute | required | meaning |
|---|---|---|
| `data-crop="x y w h"` | yes | tight box around the whole character (stage use) |
| `data-crop-rail="x y w h"` | yes for the agent rail | head and shoulders. It must contain the whole halo at ANY rotation (the circle around the halo pivot through the halo's farthest point), the plume, the collar and the seal, plus about 3 % headroom for the victory lift. Built into the json as `cropRail`. |
| `data-badge="x y"` | optional | centre of the awaiting "!" badge (default: halo pivot + 0.78 R, - 1.05 R). Use it when a wide crest or beam sits there. In the rail the engine also clamps the badge inside the crop. Built as `badge`. |
| `data-vm="x y"` | optional | centre of the VM cloud (default: beside the helm). Built as `vm`. |

## Layer attributes

| attribute | on | meaning |
|---|---|---|
| `data-pivot="x y"` | every moving layer | rotation origin, document coordinates |
| `data-alarm="x y"` | `L-token-N` | centre of the red alarm glow in the awaiting state (default: token pivot + 6 below). Built as `alarm`. Use it when the token swings about a strap ring above the seal. |
| `data-flip="none"` | `L-token-N` | the token never mirrors in the victory flip (text, `>_` sigil); it rocks instead. Built as `flip`. |

All extras are carried into the json only when declared, so art that declares none builds to exactly the same bytes as before (the Relic's `relic.json` is a golden file, checked by `test/mascot.test.ts`).

## Allowed inside a layer

`<mask>`, `<clipPath>`, gradients and filters may be defined inside any layer or in `<defs>`; the build prefixes every id per bot (the full bot name, so busts never collide when several are on one page; the Relic alone keeps its historical `rx-` prefix). Directional lighting must not be baked into the rotating halos: use radial profiles so the highlight does not swing round as the ring turns.

## Persona (not part of the art)

Per-bust behaviour lives in `ui/src/mascot/personas/<name>.json`, never in the SVG: 12 quips, the annoyed line, a tempo multiplier, optional `haloFlare` (victory flare strength, default 2.2 = the Relic; pale halos want about 1.1 to 1.3), `haloMotion: "swing"` (an instrument halo that swings instead of turning), `plumeSway` (< 1 for rigid crests), `plumeLight` (a lit crest goes dark in sleep), `sleepPlume` (degrees), `cropRail` (art with no `data-crop-rail`), and weighted, cooldown-gated idle `verbs` made of the six primitives `lean`, `nod`, `scan`, `flutter`, `flare`, `wave`. See `ui/src/mascot/verbs.js`.

