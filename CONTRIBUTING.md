# Contributing

## Adding a mascot

Every built-in agent has a hand-painted bust. The painting is never redrawn or simplified at runtime or in the build: the pipeline only regroups the maker's paths into layers, adds overlays (eyes, code scroll, glows) and animates them.

1. **Paint** one layered SVG that follows `docs/art/MASCOT_CONTRACT.md` (layer ids and paint order, 4 px pixel eyes, `data-crop`, `data-crop-rail` that holds the whole halo at any rotation, absolute `M/L/C/Q/Z` in `L-visor-shape`). Add `data-flip="none"` to a sigil token, `data-alarm` / `data-badge` / `data-vm` only if the defaults land in the wrong place.
2. **File it** in `docs/art/muster/<id>/`: `<id>.layered.svg`, `<id>.portrait.svg` and the maker's `notes.md`. **The folder name is the agent id**: the bust is looked up by `agent.id`, so a bot called `scout` must have the id `scout`.
3. **Build** the json: `python3 scripts/build-mascot.py docs/art/muster/<id>/<id>.layered.svg <id>` (or `--all` to rebuild everything). Ids are prefixed with the bot name so busts never collide. Commit `ui/src/mascot/data/<id>.json`; it is generated, never hand-edited.
4. **Give it a persona** in `ui/src/mascot/personas/<id>.json`: 12 quips, the annoyed line, a tempo multiplier, optional flare/halo options, and 3 to 6 weighted, cooldown-gated idle verbs built from `lean`, `nod`, `scan`, `flutter`, `flare`, `wave` (see `ui/src/mascot/verbs.js`). Keep the motion solemn: nothing quicker than about half a second, small angles.
5. **Register** it in `ui/src/mascot/busts.ts` (one loader line).
6. **Check it like a maker would**: render all states at the size they ship (44 px rail, about 200 px stage) on dark and light, awaiting and error included; run `npm test` (`test/mascot.test.ts` checks the contract, id collisions and persona targets) and `npx vite build --config ui/vite.config.ts`.

Golden rules: `ui/src/mascot/data/relic.json` and the Relic stage stay byte-identical (the test pins the hash and regenerates it from `docs/art/muster/zealot/relic.layered.svg`); new CSS classes are namespaced `mxs-*` / `bust-*` with no global selectors.
