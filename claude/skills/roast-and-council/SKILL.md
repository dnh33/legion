---
name: "roast-and-council"
description: "Use when the owner asks to roast, run a council on, or sanity-check whether a page, design or change is actually better (e.g. \"is this really better?\")."
---

# Roast and council review

1. **Capture the evidence first.** Take screenshots of the current and previous versions at desktop (1440×900) and mobile (390×844), above the fold and full page. Also save their visible text. For the previous version, check out the older commit in a git worktree and build it. Put everything in the scratchpad.
2. **Launch the agents in parallel** in one message, so they stay visible in the UI. They are read-only and must not edit files.
   - **Roast:** a savage but fair top indie marketer. It ranks the 8–12 worst problems, gives an old vs new verdict, and writes a concrete rewrite spec with exact copy and a word budget.
   - **Conversion strategist:** counts the text layers above the fold, names the one primary action, and sets a hero word budget and a page word target.
   - **Target player:** a cozy-game fan arriving from Reddit or TikTok on a phone. Gives a 5-second gut reaction, the lines that feel "sold to" and the lines that make them go "aww", and the point where they stop scrolling.
   - **Visual/UX designer:** audits the hierarchy element by element, measures how much of the first screen shows the product, and proposes a layout that names the component and i18n keys involved.
   - **Give every agent the truth constraints:** no invented numbers, no competitor names, no promised price or date beyond what's confirmed.
3. **Synthesize.** Send a short verdict with `SendUserMessage`: where the reviewers agree, where they split, and a proposed fix. If the owner's complaint is right, say so plainly.
4. **Ask** with `AskUserQuestion` about scope (for example hero only, hero plus page trim, or revert) and any copy choice where the reviewers split. Put the recommended option first.
5. **Apply the answer in full.** Update all locales, build, look at the screenshots again, publish, back up, and record the decision in the tracker.