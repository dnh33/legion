# Skills

Task-specific knowledge for coding agents working on Legion. Each file is a **skill**: a trigger, the rules that
actually apply, and the failure modes that have bitten here. Read the one that matches what you are doing before you
start, not after.

`AGENTS.md` is the map and the architecture rules. This folder is the operational detail: what to do, and what goes
wrong. Both are needed. If you only read `AGENTS.md`, you know the codebase but not the traps.

| Skill | Read it when |
|---|---|
| [`shipping-a-release.md`](shipping-a-release.md) | Cutting, publishing or rolling back a release; the updater will not update; anyone asks "can users install this from inside Legion?" |
| [`verifying-changes.md`](verifying-changes.md) | Before you claim a change works, is safe to merge, or is ready to ship |

## Why these exist

Both were written after shipping something wrong.

A release went out that users could download but not install, because the update panel hid its install button as soon
as the download finished. Nothing was broken — a control was *absent* — and 100% of the suite was green. That is the
class of failure this folder exists to prevent: **gaps that no test fails on, because there is nothing there to fail.**

The second one came from a review bot proving that a passing test proved nothing: a test asserting "the run finished"
passed against the code that had the bug, because the bug did not stop the run finishing.

## Adding a skill

One file, named for the task, not the subsystem. Structure:

1. **When this applies** — the trigger, in the words a person would actually use.
2. **The rules** — imperative, each with a *why*, so a rule can be re-derived rather than memorised.
3. **Failure modes seen here** — the specific thing that went wrong, dated. Generalise the lesson, keep the incident.

Do not duplicate `AGENTS.md` or `docs/`. Link to them. If a rule exists in both, the one here is the operational
detail and `AGENTS.md` holds the architecture.