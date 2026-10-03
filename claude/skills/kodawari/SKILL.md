---
name: "kodawari"
description: "Kodawari (Japanese craftsman's attention to detail) and anti-slop audits for art, UI, copy, store claims, code and numbers: look at everything as shipped, verify adversarially, prove each fix."
---

# Kodawari: a craftsman's attention to detail, and no slop

*Kodawari* (こだわり) is a refusal to ship anything you haven't looked at yourself, at the size and in the conditions the person will meet it.

*Slop* is anything plausible but unexamined:

- generic wording;
- art judged from code;
- a number nobody computed;
- a fix nobody re-rendered;
- a feature tested only where it was easy to test.

Use this skill when polishing or auditing anything a paying user will see or rely on.

## Principles

1. **Evidence over assertion.**
   - Render it, run it or count it. Read every screenshot you take, at full resolution; crop large sheets, because a downscaled view hides the flaw.
   - Never quote a figure you haven't computed from the real code path.
2. **Real conditions:**
   - the smallest size it ships at;
   - edge variants: night or dark mode, extreme colours, empty states, long names, big numbers, 0.75× and 1.5× UI scale, offline, a slow PC;
   - the real host: the packaged app, not just the dev browser.
3. **Every detail deliberate.** If you can't say why a pixel, word or number is the way it is, it isn't done.
4. **A second eye that tries to refute.** Every maker is followed by a reviewer who doesn't trust the maker's report and defaults to "not fixed" when unsure.
5. **Before and after, like for like.** Same query, same seed, same frame, ideally side by side in one image.
6. **Surgical fixes, no regressions.** After touching shared code, re-render the whole sheet or suite, not just the case you fixed.
7. **Honest restraint.**
   - Rank by what a paying user would notice.
   - Skip nitpicks nobody will see.
   - Name what is still imperfect instead of hiding it.

## The loop

1. **Map the surface.** List every screen, asset, string or claim, and the variants each must survive: sizes, themes, states, data extremes.
2. **Render or run all of it, and look.** Save evidence paths.
3. **Write findings.** Each needs:
   - where it is (file or function);
   - what you saw, with the evidence;
   - why it matters to the user;
   - a concrete fix.

   Rank them, and separate bugs from polish.
4. **Verify adversarially.** Read the real code or text and try to refute each finding. Keep it only if it survives. Improve the proposed fix if needed.
5. **Fix surgically.** Re-render the same views, compare before and after, and iterate until a careful studio would ship it.
6. **Close.** Run the type checks, tests and smoke runs. Record what changed and what remains imperfect.

## Checklists

### Visual art (sprites, procedural or painted)

- **Silhouette:** recognisable at the smallest shipped size (Tankbar: 55 px on the taskbar), not just in the big portrait.
- **One art direction:**
  - one light direction;
  - outlines a darker shade of the same hue (never pure black);
  - consistent line weights and palette harmony.
- **Variants:** night, pale or albino (no black where there's no pigment), dark or melanistic (marks must still read), size extremes, every pattern on every body.
- **Artefacts:** square line ends near features, seams, gaps, z-order, clipping, parts on the wrong side, glitches across every animation phase and pose.
- **Truth:** real subjects look like themselves, with their signature features. Real-world facts in flavour text are verified.
- **Scaling:** marks scale with the body and have floors, so nothing shrinks to a speck on slim or small variants.
- **Symbols:** nothing reads as someone else's symbol or an unintended object. A three-triangle stack reads as a famous game logo; a bead standing proud of a ring reads as a pendant hook.
- **Determinism:** seeded layouts stay stable across size and traits, with no unseeded randomness.

### UI

- **Every panel and state:** empty, loading, error, full, long text, max numbers, all UI scales.
- **Tooltips and overlays:** clamped to the screen, never covering what they describe.
- **No orphans:** no lone icon or word wrapped onto its own line. Nothing shifts layout on hover or update.
- **Feedback:** every action gets a response. No dead ends. Disabled states say why.
- **No noise:** repeated identical toasts are merged. Four identical "incubators are busy" toasts are slop.
- **Failures:** a failure shows a human message and a way forward, never nothing. Check it really appears: a silently swallowed error is the worst kind of slop.
- **Consistency:** feature names, capitalisation and spelling are the same everywhere.

### Copy

- **AI-isms and filler:** delve, tapestry, embark, whimsical, "a testament to", "in the realm of", elevate, hype, rule-of-three padding, sentences that say nothing, strings of exclamation marks, em-dashes as a crutch.
- **Repetition** across a random pool: same openings, same joke shape, one word overused ("little", "cozy").
- **Tone:** it matches the brand voice guide. No condescension. No guilt or pressure language.
- **Accuracy:** grammar and the chosen spelling convention; true facts; text that matches current mechanics (stale text is slop); no placeholders or brackets left in.
- **Replacements** must be specific, charming and varied, and keep every `{placeholder}`.

### Claims (store page, press kit, docs)

- **Numbers:** count programmatically (species, patterns, tracks, odds), never by eye. Every number a buyer, journalist or platform reviewer could check must match the build.
- **Assets:** every referenced file exists.
- **External facts** (competitors, events, prices, platform rules) are verified on the web, or neutralised with a note for a human.
- **Legal risk:**
  - comparative claims naming competitors;
  - unverifiable superlatives;
  - privacy text that doesn't match what the app actually sends;
  - forbidden vocabulary for the channel (for example, no crypto words in a Steam listing).

### Code, before a release

- **Leftovers:** dead code; debug hooks and test-only parameters reachable in production builds.
- **Security settings** of the real host: Electron context isolation, sandbox, CSP, preload surface, external-link checks.
- **Test the packaged path end to end.** A strict CSP can silently break a third-party SDK that compiles code at runtime.
- **Save robustness:** atomic writes, backups, migrations, truncated files, NaN or Infinity, clock changes, long absences.
- **Leaks and performance:** listeners, timers, unbounded arrays, per-frame allocations in hot loops.
- **Duplicated constants** that should come from one balance table.

### Numbers, odds and balance

- **Exhaustive where feasible.** Many seed spaces can be walked in full: 2^32 seeds took 11 s in C. Otherwise simulate through the real code path, not a re-implementation.
- **Compare with the promises** the texts make. Check that rolls meant to be independent are. State the sampling noise.

### Performance

- **Measure relatively.** Baseline vs feature, same scene, same quality setting (turn off auto-quality), same machine state.
- **Never measure while other heavy work is running.** Results can swing 2×.

## Running it with agents

- **One shared context block for every agent:**
  - product, audience and price;
  - art direction and voice guide;
  - tools and harnesses;
  - what earlier passes already fixed ("don't re-report unless still broken").
- **File ownership:**
  - each agent owns its files;
  - shared files belong to the lead;
  - agents return the shared-file changes they need, as code, in their report;
  - agents never commit.
- **Maker, then adversarial reviewer.** The reviewer gets the maker's report with the instruction "do not trust it; render everything yourself", and defaults to keep=false.
- **Verification batches:** verify findings in batches of 30–40 per reviewer, with structured output (id, keep or real, reason, better fix).
- **Report format:** a ranked list of at most 25 findings (bugs apart from polish), with evidence paths; per item after fixing, "ok" or what changed, and what is still imperfect.

## What done means

- Every variant was looked at, at the size it ships.
- Before-and-after evidence exists.
- An independent reviewer found nothing left worth fixing.
- Type checks, tests and smoke runs pass.
- Remaining imperfections are written down honestly.