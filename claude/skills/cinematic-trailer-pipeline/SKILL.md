---
name: "cinematic-trailer-pipeline"
description: "Make a cinematic product trailer as code: a deterministic HTML timeline rendered frame by frame to MP4/GIF, with an original synthesized score synced to a cue sheet."
---

# Cinematic trailer pipeline

The reference implementation is Legion's `docs/video/`:
- `timeline.mjs`: every time on a beat grid, plus the list of cuts;
- `trailer.html`: the composition, exposing `window.render(t)`;
- `render.mjs`: the renderer; one command rebuilds MP4, GIF and poster;
- `score.py`: the music, read from `cues.json`;
- `cues.json`: generated from the timeline;
- `edit_judge.py`: an optional Jev pass that picks the transition for each cut;
- `BRIEF.md`: storyboard, editing rules, honesty notes.

Copy that structure for any new trailer.

## 1. Brief before building
Write `docs/video/BRIEF.md` first. It must contain:
- a storyboard table in bars, with a time range per scene;
- the palette and fonts, taken from the product's own tokens and bundled fonts;
- the IP rules ("inspired by" never means copying names, symbols or logos);
- **honesty notes**: which features shown are specced but not built yet;
- the deliverables: MP4 1920×1080 30fps H.264 yuv420p faststart; a README GIF 960×540 that is a ~15s highlight; a poster PNG.

Use the product's REAL UI screenshots, real tool and command names (grep the source) and REAL animated mascot or engine. Never mock up a fake UI. Take rosters and feature lists from the project's spec docs, not from memory.

## 2. Edit like an editor
These rules fixed a cut the owner called badly edited:
1. **Beat grid.** Pick a tempo (96 BPM gives beat 0.625s, bar 2.5s). Define `b(bar, beat)` in `timeline.mjs` and write every time with it. Scene changes go on bar lines and reveals on beats. The score uses the same grid.
2. **No dead air.** Never fade a scene out to an empty frame and then fade the next one in. Every scene change is a `CUTS` entry with a kind:
   - `hard`: 0.06s, on a downbeat. Use it for UI montage and the climax, and add a 2-frame scanline hit.
   - `dissolve`: a 0.5s overlap centred on the cut, with both shots visible.
   - `match`: the main character stays on screen and moves to its new framing.
   Use black only at the very start and end.
3. **One anchor.** The mascot has 2–3 fixed screen homes and travels between them on screen. If it must leave (a full-screen UI cutaway), it fades out and comes back to the same spot.
4. **One idea per shot.** Text stays up at least 0.3s per word + 0.8s. Shorten the copy rather than rushing it.
5. **Show the detail.** For a UI screenshot, use a camera (zoom + pan inside the frame) that pushes in on what each callout names. Put labels in empty screen areas with a leader line, never over UI text.
6. **Pace.** Long shots early, tighter toward the climax, one beat of silence before the big hit, then let the end card breathe.
7. **No repeats.** Reveal the title once, at the end.
8. **Clear before the next element.** A line of text must be gone before the next big element draws in the same area.

## 3. Single source of truth for timing
`timeline.mjs` exports `BPM`, `b()`, `TRANSITION`, `CUTS`, the scene table `T`, the mascot keyframes and states, and `GIF_SEGMENTS`. Both `trailer.html` and `render.mjs` import it. `render.mjs` writes `cues.json`, which contains:
- `duration`, `bpm`;
- `sections`: `[{name,start,end}]`;
- `events`: `[{t,name}]`;
- `typing`: `[{start,end,chars}]`;
- `cuts`: `[{id,t,kind}]` (after any Jev overrides).

That way the picture and the score can never drift apart.

## 4. Deterministic rendering (never screen-record)
- `trailer.html` exposes `window.render(t)`. It sets every JS-driven element from `t`, and any randomness comes from a seeded PRNG.
- Seek CSS animations each frame. Keep a WeakMap of each animation's `born` time, then for every `document.getAnimations()`: pause it and set `currentTime = (t - born) * 1000`.
- Drive components with internal timers (blinks and so on) from `t`, not from `setTimeout`.
- Serve the repo over a local HTTP server, because `file://` blocks fonts and modules.
- Run Playwright with the viewport at the output size, then per frame call `page.evaluate(render, t)` and take a JPEG screenshot at quality 92. Use parallel worker pages.
- **Key-frame stills must replay incrementally:** one pass from 0 to the last requested time. Re-priming from 0 for every still is O(n²) and times out.
- Encode with ffmpeg libx264 at crf ~19.
- For the GIF, render a separate highlight path with no grain and fewer particles. Use `palettegen=stats_mode=diff` and `paletteuse=dither=sierra2_4a`, and gifsicle `--lossy` to stay under 8MB.

## 5. Original score that matches the product's theme (no samples)
The score is synthesized in `score.py` with numpy and scipy, reading `cues.json`. Do not default to a generic trailer kit (braams + taiko). Derive the instruments from the product's look. For a gothic + hacker app that meant two halves:
- **gothic:** additive pipe organ (8'/4'/2' ranks plus mixture, wind chiff), a formant choir, a church bell (hum, prime, minor third, fifth, nominal), and war drums with a shell partial and a band-passed skin;
- **hacker:** a resonant-saw synth arpeggio whose cutoff opens toward the climax, data ticks, a bit-crushed glitch stutter on every hard cut, key clicks on typed lines, and confirm blips.

Other building blocks that work: whooshes and risers (block-wise band-pass noise sweeps), filtered-noise swells, and a hall or cathedral reverb (convolution with a decaying-noise IR plus early reflections).

**Arrange on the grid:**
- one chord per bar (for example i–VI–iv–V in D minor), ending on a Picardy major chord;
- events land on cue times: a drum per banner, a rising pluck per roster name, a bell per callout, a seal on approval;
- sidechain-duck the music under the kick;
- gate everything to near silence for one beat before the climax, then hit with tutti organ, choir, bell and drums;
- resolve, then fade to black.

**Pitfalls seen:**
- A loud sub drone flattens all dynamics. Add sub only on the hits.
- Drums whose pitch drops to 40–55 Hz, or a 16' pedal, can put over 60% of the energy under 120 Hz and bury the mids. High-pass the drum bus at about 45 Hz, keep drum pitch floors at 60–70 Hz, and move pedal notes up an octave (keep a quiet low-passed 16' underneath).
- High-passed white-noise crashes get harsh. Band-limit noise (low-pass at about 7–9k) and keep its gains low.

**Mux:**
```
ffmpeg -i video.mp4 -i score.wav -map 0:v -map 1:a -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 192k -shortest -movflags +faststart out.mp4
```
Call it from `render.mjs` so a single command rebuilds everything.

## 6. Optional Jev pass
See the building-with-typesafe-jev skill. Send one request where the state holds the app theme and the description of each cut.
- Ask one Choice per cut (hard / dissolve / match, each option an object with `what`, `for`, `not_for`), plus a palette Choice.
- Apply an answer only at confidence ≥ 0.6, and pin the model version.
- Write the result to `edit-decisions.json`; `render.mjs` and `trailer.html` pick it up.
- Keep tempo, cut times, reading times and loudness in code.
- Without `TYPESAFE_API_KEY` the pass exits and the defaults apply. Never go looking for the key.

## 7. Kodawari review (mandatory)
**Picture:**
- Render key frames (one per scene, plus every text beat) before the full render and read them at full resolution.
- Check that nothing is clipped, type is crisp, callouts point at real UI elements, labels don't cover UI text, and no element sits on top of another.
- Iterate at least three times.
- After the render, build a 2 fps contact sheet (`fps=2,scale=384:-1,tile=6x5`). Look for empty frames, double exposures, and text colliding with the next element.

**Sound** (you can't listen, so measure):
- ebur128 integrated loudness of about -14 LUFS, true peak under -1;
- per-section RMS that shows the arc: cold about -23, middle about -18, build about -16, hit about -12;
- a pre-hit gap at least 15 dB under the hit;
- band energy per bus, to find what is drowning the mix;
- a spectrogram with cue lines overlaid, where onsets sit on the event lines;
- no DC offset.

**After encoding:** extract around 8 frames from the final MP4, plus 3 from the GIF, and look at them.

**Size:** keep the MP4 out of git (release asset) and commit the GIF and the source.

**Motion:** check the mascot or animation speed against the intended periods by sampling the computed transforms at `t` steps. Solemn characters need slow motion: float about 7s, halo 100s+.

## 8. Delivering to the owner's PC through the device bridge
- Commits are capped at 20MB per file, so split large files.
- A chunk that starts with an MP4 header can arrive altered. Gzip the file first, split the .gz into ~9MB `.bin` chunks, commit them, then run `cat | gunzip` on the device.
- Verify the result with sha256 against the original.
- Deletes need permission, so move leftover chunks into `_to_delete/` and tell the owner.

## 9. Lessons from Legion's second trailer (docs/video-v2)
Read `docs/video-v2/HANDOFF.md` for the full recipe. Short version:
- Capture screenshots from the REAL built UI against a REAL core running on the product's own fakes (harness stack + same-origin proxy + a stub of the desktop preload); never mock a screen. Drop a scene you cannot capture honestly.
- Put UI left, copy right, mascot bottom-right; push the camera into the region each caption names; rings on real elements.
- Put captions, chips and cards in the timeline as data and let `check.mjs` enforce reading time, caption gaps (fades included), mandatory "not tried" chips, banned words and "no UI for planned items".
- Budget seconds before adding a scene: a 2.5 s shot cannot carry a 6-word caption plus the fade gaps.
- Page-text placeholder scans must skip painted art that carries its own text.
- Commit the small MP4 (re-encode to under 40 MB), the GIF, the poster and the source; the full render rebuilds with one command.
