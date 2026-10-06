---
name: requesting-code-review
description: Use after you finish a task or a major feature, and before the work is merged. Get a separate reviewer to check it against the requirements, then act on what they find.
license: MIT
metadata: { source: "https://github.com/obra/superpowers", commit: 5bf4e78011075bcfc0dc295f0724994cd123ee71, edited: "for Legion, 2026-10-06" }
---

# Requesting a code review

Adapted from obra/superpowers (MIT, Jesse Vincent). Edited for Legion.

Ask a separate reviewer to check your work before problems spread. The reviewer gets a short, prepared brief. It does not get your whole session history.

**Rule:** review early and review often.

## When to ask

Always:
- after you finish a major feature,
- before work is merged.

Often useful:
- when you are stuck and want a fresh view,
- before a refactor, to set a baseline,
- after you fix a hard bug.

## How to ask

**1. Pin the range to review.** Find the commit where the work started and the commit where it ends. For example, `git merge-base origin/main HEAD` and `git rev-parse HEAD`. You only read history here. Do not change it.

**2. Give a separate reviewer a brief.** Use another agent in the room if you have one, or a fresh sub-task if your tools allow it. If you cannot start a separate reviewer, ask the owner to review. Fill in the brief below.

**3. Act on what comes back.**
- Fix critical problems now.
- Fix important problems before you go on.
- Note minor problems for later.
- If the reviewer is wrong, say so with a reason and show code or a test that proves it.

## The brief

```
You are a senior code reviewer. Review the finished work against its requirements
and find problems before they spread.

## What was built
{DESCRIPTION}

## Requirements or plan
{PLAN_OR_REQUIREMENTS}

## Range to review
Base: {BASE_SHA}
Head: {HEAD_SHA}
Inspect it with read-only commands: git diff --stat BASE..HEAD, git diff BASE..HEAD.

## The spec is a vision, not a full list
For behaviour the spec does not mention, judge by what a reasonable user would expect.
A reasonable expectation is a requirement. Silence in the spec is not permission.
Rate such findings by their effect on that user.

## Things you set aside
Before your verdict, list every behaviour you considered and set aside as outside the
plan, one line each, with the reason. The author rules on each line. An empty list
means you set nothing aside.

## Rules for you
- Read only. Do not change files, the index, HEAD or branches.
- Do the whole review yourself. Do not start more reviewers.
- If the diff is large, review it in passes and say so.

## What to check
- Plan: does the work match the requirements? Is every planned part there? Are any
  differences justified?
- Code: clear structure, error handling, types, edge cases, no needless repetition.
- Design: sound decisions, security, fit with the surrounding code.
- Tests: do they check real behaviour? Do they cover edge cases? Do they pass?
- Ready to ship: migrations, backward compatibility, docs, obvious bugs.

## How to report
Rate each issue by its real severity. Not everything is critical.
Name what was done well first.

### Strengths
### Issues
#### Critical (must fix): bugs, security problems, data loss, broken features
#### Important (should fix): design problems, missing features, weak error handling, test gaps
#### Minor (nice to have): style, small optimisations, doc polish
For each issue give file and line, what is wrong, why it matters, and how to fix it.
### Recommendations
### Assessment
Ready to merge? Yes, No, or With fixes. One or two sentences of reasoning.
Do not say "looks good" without checking. Do not mark nitpicks as critical.
Do not comment on code you did not read. Give a clear verdict.
```

## Red flags

Never:
- skip review because the change is "simple",
- ignore critical issues,
- go on with unfixed important issues,
- argue with feedback that is correct.

If the reviewer is wrong, push back with technical reasons and proof.
