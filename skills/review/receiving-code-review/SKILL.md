---
name: receiving-code-review
description: Use when you get code review feedback and before you act on it, especially if an item is unclear or looks technically wrong. Check each point against the code. Do not agree just to be agreeable.
license: MIT
metadata: { source: "https://github.com/obra/superpowers", commit: 3fb75974186ea7fada621d8ab77b3b02169baf57, edited: "for Legion, 2026-10-06" }
---

# Receiving code review

Adapted from obra/superpowers (MIT, Jesse Vincent). Edited for Legion.

Review feedback needs technical judgement, not a show of agreement.

**Rule:** verify before you implement. Ask before you assume. Being right matters more than being agreeable.

## The steps

1. **Read** all the feedback before you react.
2. **Understand.** Restate each item in your own words, or ask.
3. **Verify** it against the real code.
4. **Evaluate.** Is it sound for this codebase?
5. **Respond** with a plain acknowledgement or a reasoned objection.
6. **Implement** one item at a time. Test each one.

## What not to say

Do not write "You are absolutely right!", "Great point!" or "Thanks for catching that". Do not say "Let me implement that now" before you have checked.

Instead: restate the requirement, ask a question, push back with a reason, or just start the work. Actions show you heard the feedback.

## If any item is unclear

Stop. Do not implement anything yet. Ask about the unclear items first. Items are often linked, and a partial understanding gives a wrong result.

Example. The reviewer says "fix 1 to 6". You understand 1, 2, 3 and 6. Say: "I understand 1, 2, 3 and 6. I need to know more about 4 and 5 before I start." Do not do 1, 2, 3 and 6 first.

## Where the feedback comes from

**From the owner.** Trust it. Still ask if the scope is unclear. Skip the praise and go to the work.

**From another reviewer (an agent or a person outside the project).** Check first:
1. Is it correct for this codebase?
2. Does it break something that works?
3. Why is the code the way it is?
4. Does it work on every platform and version we support?
5. Does the reviewer know the full context?

If it looks wrong, push back with reasons. If you cannot check it, say so: "I cannot verify this without X. Should I investigate, ask, or go ahead?" If it conflicts with an earlier decision by the owner, stop and talk to the owner first.

Be sceptical of outside feedback, but check carefully.

## Do not add features nobody uses

If a reviewer asks you to "implement it properly", search the codebase for real use. If nothing uses it, ask: "Nothing calls this. Remove it instead?" If it is used, then do it properly. The reviewer and you both serve the owner. If the owner does not need the feature, do not add it.

## Order of work for several items

1. Clear up anything unclear first.
2. Then work in this order: blocking problems (breakage, security), simple fixes (typos, imports), complex fixes (refactors, logic).
3. Test each fix on its own.
4. Check for regressions.

## When to push back

Push back when the suggestion:
- breaks existing behaviour,
- comes from a reviewer without the full context,
- adds something unused,
- is wrong for this stack,
- ignores a compatibility reason,
- conflicts with the owner's design decisions.

Use technical reasons. Ask specific questions. Point at tests or code that show the facts. Bring in the owner for design questions.

If you feel unsure about pushing back, say that plainly and tell the owner what you saw.

## When the feedback is right

Say what changed, in one line:
- "Fixed. The null check is now in `parse()`."
- "Good catch on the missing index. Fixed in `db.ts`."

Or just fix it and let the code speak. No thanks, no long apology.

## When you pushed back and were wrong

State it plainly and move on: "I checked X and it does Y. You were right. Fixing now." Do not over-explain and do not defend the first answer.

## Common mistakes

| Mistake | Fix |
|---|---|
| Agreeing without checking | Restate the requirement, or just act |
| Doing it blind | Check it against the code first |
| Doing everything, then testing | One at a time, test each |
| Assuming the reviewer is right | Check that it does not break something |
| Avoiding pushback | Being correct beats being comfortable |
| Doing half the items | Clear up all the items first |
| Cannot verify, go ahead anyway | Say what you cannot check and ask |

## Examples

Reviewer: "Remove the legacy code."
Bad: "You are absolutely right! Removing it now."
Good: "Checked. The build target is 10.15 or newer, and this API needs 13 or newer. The legacy path is still needed. The current code uses the wrong bundle ID. Fix that, or drop support for older versions?"

Reviewer: "Add proper metrics with a database, date filters and CSV export."
Good: "I searched the codebase and nothing calls this endpoint. Remove it instead? Or is there use I cannot see?"

## Replying on a hosted review thread

Reply inside the comment thread, not as a new top-level comment. If you have no tool for that, give the reply text to the owner to post.
