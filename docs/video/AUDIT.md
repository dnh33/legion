# Trailer audit (Kodawari pass, 2026-10-01)

Two passes on `legion-demo.mp4`: the maker's own frame and sound review, then an independent reviewer who extracted every 0.5 s plus every frame around each cut, read them at full size and at phone size, and defaulted to "not fixed". After the fixes, the same reviewer re-checked against a fresh render.

`node docs/video/check.mjs` now enforces the reading-time and beat-grid rules on every change, and `render.mjs` refuses to render if a placeholder (`OWNER`, `TODO`, `lorem`) is on screen.

## Fixed

| # | Finding | Fix |
|---|---|---|
| B1 | End card showed a dead link, `github.com/OWNER/legion` | Replaced with "Coming soon."; the render now fails on placeholders |
| B4 | `poster.png` was a text-less victory frame | Poster is now taken from the finished end card |
| B5 | Eight captions were on screen for less time than the reading rule | Copy shortened, the field scene got 1.25 bars more, and every caption passes `check.mjs` |
| B6 | Victory "flash" was a slow, muddy olive wash | 2–3 frame mint punch with screen blend, exactly on the audio hit |
| B7 | Model-picker text overprinted the BitcoinSV title during a dissolve | Now a hard cut on the downbeat |
| B8 | Roster grid sat top-left with a lone plaque on a fourth row | 3 founders + 5 + 5, centred, caption under the grid |
| B9 | Zoomed screenshot had words cut hard at the frame edge | Feathered inner edge on the app frame |
| B10 | Video was untagged for colour (greens could shift on X) | Encoded and tagged BT.709 |
| B11 | GIF opened on black and faded out at the end | Starts on a lit frame, ends on the lit end card |
| P1 | Terminal and plaque labels unreadable on a phone | Terminal 27→31 px, sublabels larger |
| P2 | Fine print sat at the very bottom and was nearly invisible | Raised, larger, brighter |
| P3/P8 | Zealot plaque and the command title looked dim | Vignette eased at the edges and top; title moved out of the dark band |
| P4 | Blackletter mangled "MCP" and "VM" | Acronyms set in IBM Plex |
| P6 | Text sigil read as a broken cross | Redrawn as an upright cross with `>` `<` arms |
| P7 | Terminal output was invented | Now shows what `legion_run` really returns: the answer, model, cost and taskId |

## Left for the owner (deliberately not changed)

- **B2: the opening line.** "In the grim darkness of your backlog… there is only work." is a parody of the Warhammer 40k tagline. It sets the tone, but it is the one place the trailer leans on Games Workshop's words. Alternative if wanted: "Your backlog never sleeps. Neither does your order."
- **B3: unbuilt features on screen.** The roster of thirteen, the BitcoinSV kit (Assayer) and the Blender bridge (Sculptor) are specced but not built yet. "→ 13 agents" in the terminal depends on the muster shipping. Build them before posting, or cut those beats.
- **No link on the end card.** There is no public repo yet. Put the real URL in `trailer.html` (`#url`) when it exists.

## Still imperfect

- The grey decay right after the flash is short but not pure.
- The Blender wireframe is intentionally lumpy (a "sculpt" bulge); some viewers may read it as a glitch.
- The music was checked by measurement only (loudness, section arc, band energy, pre-hit gap), not by ear.
