---
name: "receiving-review"
description: Use whenever review findings come back, from the owner, a reviewer or roaster agent, a council, a scanner or a PR comment, on code, art, copy or numbers. Verify each finding before acting; no performative agreement, no blind fixes.
---

# Receiving Review

Adapted from Superpowers' `receiving-code-review` by Jesse Vincent (MIT, see LICENSE), widened from code to any reviewed work, including findings from reviewer subagents.

## The core rule

A review finding is a claim, not an instruction. Check it against the real thing before changing anything. Technical correctness beats social comfort in both directions: don't wave a finding away to protect the work, and don't accept it to keep the peace.

## The loop

1. **Read all of it** before reacting.
2. **Restate** each item in your own words. If any item is unclear, ask about it *before implementing any of them*; items are often linked and half-understanding produces half-wrong fixes.
3. **Verify** against the actual code, render, page or numbers. Reproduce the problem the reviewer describes. Reviewer agents hallucinate line numbers, misread renders and report already-fixed issues as often as humans do.
4. **Judge** for this project: does the fix break something, contradict an earlier decision by the owner, or solve a problem nobody has (YAGNI: if the reviewer asks for a "proper" feature, check whether anything uses it)?
5. **Act** one item at a time, blocking problems first, then simple fixes, then larger changes, checking each one before the next.

## Sources

- **The owner:** trusted. Implement once you understand it; still ask if scope is unclear.
- **Reviewer or roaster agents, councils, external reviewers:** sceptical but careful. Verify each finding. A finding you can't verify gets labelled unverified, not silently applied or silently dropped.
- **Scanners and linters:** the rule fired; whether it matters is your judgement. Read the flagged source before accepting or dismissing.
- **Conflict with an earlier owner decision:** stop and raise it rather than quietly overriding either.

## Pushing back

Push back when a suggestion breaks working behaviour, lacks context, adds unused scope, is wrong for this stack, or conflicts with an established decision. Do it with evidence: "Checked X, it does Y, so Z would break W. Keep it, or drop W?" If you pushed back and were wrong, say so in one line and fix it.

## Wording

- No "You're absolutely right!", "Great catch!" or thank-yous in place of work. State what changed and where: "Fixed: guard against empty list in `loadFishes()`."
- For a finding you rejected, give the one-line reason so the next reviewer doesn't raise it again.
- For a batch from reviewer agents, report a short ledger: applied, rejected with reason, could not verify.

## On GitHub

Reply to inline comments in their own thread, not as a top-level PR comment.
