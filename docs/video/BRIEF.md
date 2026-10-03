# Legion demo video: brief

## Deliverables
A ~57-second cinematic trailer for the project page, README and X. It is **grimdark-gothic and Warhammer-40k inspired, but fully original**:
- no double-headed eagle, no cog-skull, no skull-and-wings;
- no "Emperor", "Imperium", "Adeptus", "Space Marine" or other 40k names;
- our emblem is the Sigil, a cross made of `> _ | <`.

| File | Spec |
|---|---|
| `legion-demo.mp4` | 1920×1080, 30 fps, H.264 yuv420p, faststart, AAC score at -14 LUFS. Release asset, not in git. |
| `legion-demo.gif` | 960×540, 12 fps, ~16 s highlight, ≤ 8 MB |
| `poster.png` | the end card |

Source: `timeline.mjs` (every time), `trailer.html` (picture), `score.py` (music), `render.mjs` (one command rebuilds all), `edit_judge.py` (optional Jev pass).

## Look and sound
- **Palette:** the app's own: near-black `#0b0d10`, steel, phosphor `#7CFFB2`, gold `#caa64a`, crimson `#b3202f`, parchment `#e9dfc4`.
- **Type:** Grenze Gotisch (titles), IBM Plex Sans (small caps), JetBrains Mono (terminal).
- **Mascot:** the real animated Relic via `ui/src/mascot/engine.js`, states driven from the timeline.
- **UI:** only real screenshots from `docs/images/`.
- **Music:** gothic half (pipe organ, choir, church bell, war drums) and hacker half (phosphor synth arpeggio, data ticks, glitch hits on hard cuts, key clicks on typed lines). D minor, Picardy D major at the end.

## Editing rules
1. Everything sits on a 96 BPM grid (beat 0.625 s, bar 2.5 s). Scene changes land on bar lines, reveals on beats, and the music is written on the same grid.
2. No dead air. Scenes overlap (dissolve) or cut hard on a downbeat. Black only at the start and the end.
3. The Relic is the anchor. It has three homes (centre, right, centre-high) and travels between them on screen. It leaves only for the UI cutaway and comes back to the same spot.
4. One idea per shot. Text stays up at least 0.3 s per word + 0.8 s.
5. Show the detail being talked about: the app shot pushes in on the approval card, then pans to the computer panel.
6. Pace tightens toward the climax: one beat of silence before the hit, then the end card breathes.
7. The title is revealed once, at the end.

## Storyboard (bars of 2.5 s)
| Bars | Time | Scene |
|---|---|---|
| 0–2 | 0–5 | Cold open: candle, "In the grim darkness of your backlog…" / "…there is only work." |
| 2–4 | 5–10 | Awakening: the arch fades up, the Relic wakes on the bell, "An order of Claude agents. Yours to command." |
| 4–6 | 10–15 | Muster: Zealot, Builder, Scout banners rise on the beat. "Sonnet for the line. Opus for the war council." |
| 6–8 | 15–20 | Roll call: thirteen named plaques (claude/legion-muster-spec.md), "Thirteen offices. One order." |
| 8–11.5 | 20–28.75 | In the field: app push-in ("Nothing ships unsealed", "A forge-machine for every agent"), hard cuts to slash menu and model picker |
| 11.5–14.5 | 28.75–36.25 | Native forges: The Assayer (BitcoinSV, testnet chain, seal on approval), The Sculptor (Blender wireframe) |
| 14.5–18 | 36.25–45 | Command: "Command the whole order from Claude Code or Cowork." Real MCP tools typed (`legion_list_agents`, `legion_vm`, `legion_run`), ends on "sealed." |
| 18–19 | 45–47.5 | Victory: flash, the Relic to centre, "The work is done." |
| 19–23 | 47.5–57.5 | End card: LEGION forges, "Local. Claude-native. Open source.", URL, sigil, fine print, fade |

## Honesty notes
- The roster of thirteen, the Assayer (BSV) and the Sculptor (Blender) are specced (claude/legion-muster-spec.md, legion-bsv-kit.md, legion-blender-bridge.md) but not all built yet. Ship them before the trailer goes public, or cut those beats.
- The MCP tool names shown are the real ones in `src/core/mcp-tools.ts`. Approvals still happen in the app.

## Quality process
- Render key frames (`node render.mjs --t=…`) and look at them at full size before any full render.
- After the render: a contact sheet at 2 fps, 8 frames from the MP4, 3 from the GIF.
- Sound: ebur128 (≈ -14 LUFS, TP < -1), per-section RMS showing the arc, band energy (low end under control), the pre-hit gap at least 15 dB under the hit.
