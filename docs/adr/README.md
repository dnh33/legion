# Architecture Decision Records

A decision that is hard to reverse, and **why** it was made — especially why the obvious alternative was
rejected. Read the relevant one before changing its area; if you are about to reverse one, that is worth
doing deliberately rather than by accident.

Format: one file, `NNNN-short-slug.md`, status at the top. They are numbered and never renumbered.

| ADR | Status | What |
| --- | --- | --- |
| [0004](0004-dependency-hash.md) | accepted | `depsSha256` hashes dependency content, not the raw lockfile |
| [0009](0009-house-context-module.md) | accepted | The house context layer |

## Writing one

```markdown
# ADR NNNN — the decision, as a statement

**Status:** proposed | accepted | superseded by NNNN · **Date:** YYYY-MM-DD

## Context        <- what forced a decision. Facts, not feelings.
## Decision       <- what we are doing, in the active voice.
## Consequences   <- what this costs. Every ADR has a cost; if you cannot name one, you have not
                    thought it through.
```

The **Consequences** section is the one people actually read later. Name the thing that just became
harder, and what someone must now remember that they did not have to before.

Supersede rather than edit history: when a decision is reversed, write a new ADR and mark the old one
`superseded by NNNN`. An ADR whose conclusion was reversed is still true about *that moment* — and
knowing what we used to believe, and why we stopped, is usually the part you need.