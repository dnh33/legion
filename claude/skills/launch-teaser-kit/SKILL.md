---
name: "launch-teaser-kit"
description: "Create a launch teaser for a product (X post copy in the owner's voice plus a 1600×900 graphic in the brand typeface), with an honesty check on every claim."
---

# Launch teaser kit

## Inputs
- The product's brand fonts and mascot art. Use the bundled font files, e.g. Legion's `ui/src/fonts/GrenzeGotisch.woff2` for the wordmark.
- The owner's voice. X blocks fetching profiles, so ask for 3–4 recent posts to match the tone. Until then, write short, cryptic lines with no hype words or emoji, and say that you're guessing the tone.

## Graphic (1600×900, X/OG ratio)
- Build it in HTML with `@font-face` pointing at the local woff2 files. Render it with Playwright (viewport 1600×900) to PNG.
- Composition: the mascot on the left, using a background-free layered SVG (not the full scene, which shows as a box), with a soft brand-colour bloom. On the right:
  - a small line ("You can just build things.");
  - the huge wordmark (gold gradient, with one accent letter in the brand glow colour);
  - a mono, letter-spaced "COMING SOON · OPEN SOURCE".
- Add a vignette and subtle grain.
- LOOK at the render. Check that nothing overlaps (lanterns or scene props behind the text) and that the wordmark is crisp.

## Copy
- Write 3 variants, the shortest first.
- **Honesty check before suggesting any comparative claim:**
  - Research current competitor pricing and features with dated sources.
  - Say exactly where a claim holds and where it doesn't. Example: "1/10th the cost" held against $200/month plans but not against a free or $20 tier, and "same work" overclaimed scope.
  - Offer a defensible wording instead.
- Mention that the owner can attach the trailer MP4 or GIF.

## Deliver
- Send the PNG and any video through the chat.
- Save copies into the owner's connected folder. Files over 20MB can't be committed to the device; say so.