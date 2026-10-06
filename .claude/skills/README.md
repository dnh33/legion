# Skills

Task-specific operational knowledge for coding agents working on Legion. Read the one that matches your task
**before** you start. A skill is a lookup, not a chronicle: it answers in seconds.

`AGENTS.md` is the map and the architecture rules. This folder is the operational detail: what to do and what goes
wrong. Both are needed.

| Skill | Read it when |
|---|---|
| [`shipping-a-release`](shipping-a-release/SKILL.md) | Cutting, publishing or rolling back a release; the updater will not update; anyone asks "can users install this from inside Legion?" |
| [`verifying-changes`](verifying-changes/SKILL.md) | Before claiming a change works, is safe to merge, or is ready to ship |
| [`public-facing-copy`](public-facing-copy/SKILL.md) | Writing a changelog entry, release notes, README or any UI copy a reader outside the project will see. **Read this before writing `CHANGELOG.md`** — it is scrubbed into the public snapshot |
| [`multi-agent-safety`](multi-agent-safety/SKILL.md) | Another agent or session may be working in the same repository; before any destructive git command |
| [`test-temp-dirs`](test-temp-dirs/SKILL.md) | A suite fills the disk by leaking temp dirs; you add or change a test that makes one |

## Why these exist

The bug class here is a **gap that no test fails on, because there is nothing there to fail**: an absent control, an
absent invariant, a test that passes against the broken code because it asserts the wrong property. Green means
nothing until the test has been shown able to fail.

## Adding a skill

One folder per skill, named for the task, not the subsystem, holding a `SKILL.md` that starts with `name` and `description` frontmatter (Claude Code loads skills only in that shape).

1. **When this applies** — the trigger, in the words a person would actually use.
2. **The rules** — imperative, each with a short *why* so a rule can be re-derived rather than memorised.
3. **Failure modes** — the trap the rule prevents, generalised into the rule.

Link to `AGENTS.md` or `docs/` rather than duplicating them. Keep it lean.
