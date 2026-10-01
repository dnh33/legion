# Mascot layer contract (Legion)

Any mascot the engine animates is ONE hand-painted SVG with these top-level groups (ids exact).
The build script (`scripts/build-mascot.py`) splits them into stacked, GPU-composited layers,
so painted detail is never redrawn or simplified.

Paint order = the order listed. Coordinates are document coordinates of the source SVG.
`data-pivot="x y"` = the rotation/sway origin in document coordinates.

| id | required | moves how | pivot |
|---|---|---|---|
| `L-aura` | yes | static soft glow behind everything | – |
| `L-halo-back` | yes | rotates (slow idle, fast thinking, flare on victory) | halo centre |
| `L-plume` | yes | sways (crest / plume / finial) | where it attaches to the helm |
| `L-helm` | yes | leans/nods/bonks as one rig with plume+face | neck point under the helm |
| `L-face` | yes | recoloured by state (green, amber, red, dim) | same as helm |
| `L-hang-1..N` | 3–8 | each sways independently (cables, cloth strips, ribbons) | its attachment point |
| `L-front` | optional | static, moves with the body (collar, clasp) | – |
| `L-token-1..N` | 0–3 | flutter/flip (seals, pendants, badges) | attachment point |
| `L-halo-front` | optional | rotates with the back halo | halo centre |

Inside `L-face`:

- `L-visor-shape`: a `<path>` with the exact visor opening, used as a clip for the "code scroll".
- Visor light layers (glows, gradient fill, scanlines) are free-form.
- `L-eyes`: two pixel eyes made ONLY of `<rect width="4" height="4">` cells on a 4px grid.
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
