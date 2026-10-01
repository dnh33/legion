# Muster art sources

One folder per built-in bot (the folder name is the agent id): the maker's `<id>.layered.svg` (the bust that the engine animates), `<id>.portrait.svg` (full figure, 600x800) and `notes.md`. `zealot/` holds the Relic's source (`relic.layered.svg`, built into `relic.json`, a golden file) and its portrait.

The layered SVGs are the makers' files with ONE kind of change: contract attributes added at integration. No path, fill or group was touched (checked by stripping the attributes and comparing with the maker's original).

| attribute | where | why |
|---|---|---|
| `data-flip="none"` | `L-token-1` of all 12 busts | the seal's `>_` sigil must not mirror in the victory flip (Builder, Herald, Scout, Sculptor asked; applied to all for consistency) |
| `data-alarm="388 380"` | scribe `L-token-1` | the seal swings from a tie point 37 units above its centre; the alarm glow belongs on the seal |
| `data-badge="430 330"` | assayer root | the default "!" spot sits on the beam's right pan |
| `data-vm="418 236"` | builder root | the default VM cloud lands on the right pauldron |

Rebuild everything with `python3 scripts/build-mascot.py --all`.
