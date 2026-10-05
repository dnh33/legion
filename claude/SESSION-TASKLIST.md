# Session tasklist — 2026-10-04

> The live `todo_list` tool would not accept my payload (7 attempts, same shape error: a stray wrapper key I could not
> drop). This file is the tasklist until it does, and it is committed, so it cannot drift from the repo the way a
> chat-side list does. The authoritative order is still the TASK LADDER in `claude/legion-release-tracker.md`.

## IN PROGRESS

- [ ] **A rolled-back update reads as a hard refusal.** OWNER HIT THIS on `0.2.3-f`:
      *"rejected: version 0.2.3-g failed its first start here and was rolled back."*
      It appears once. Then **Check now** finds the update again and permits a retry — so `failedVersions` is a soft
      lock that reads as permanent. It must either be visibly retryable, or say plainly that it is a lock *this
      session* and name the way out. Nobody should have to guess that re-checking is the unlock.
      **This is the finding the updater audit missed.** The audit read code and reasoned about states; the owner met
      the real one. Kodawari's "real conditions" rule, and I ran the wrong check.

## QUEUED — ladder order

- [ ] **2 · Model pill breaks on a long model name.** `ui/src/styles/app.css:245` — `.model-pill` has a fixed 26px
      height and no `white-space: nowrap`, `overflow: hidden`, `text-overflow: ellipsis` or `max-width`, so
      `OpenRouter · stealth/space-bunny-alpha` wraps inside it and collides with the send button. The correct pattern
      is already in this codebase: `.agent-name`, `.agent-sub`, `.tb-search span`, `.th-text b`. Two traps:
      `min-width: 0` on the label child (flex ellipsis) and a `max-width` on the pill, or it widens the row instead.
      Add `title={fullName}`. Pure CSS — no runtime cost.

## NEXT SESSION

- [ ] **3 · Logging.** Zero logging in `src/core/`. Brief is self-contained: vault `HANDOFF-logging.md`. Already
      answered, do not re-derive: redaction at the **writer** via `RedactingFormatter`; four files split by severity
      and component; one async queue; Windows rotating handlers keep `.__*.lock` files until closed, so profile
      deletion must release handlers first or `rmtree` fails with WinError 32.

## AFTER LOGGING

- [ ] **4 · `kg_sweep`.** `kg_supersede` already exists and is tested. The gap is that nothing proposes a **batch**,
      so curation is one note per tool call. Human approves the batch as one action. The `graph.ts:927` delete rules
      are correct and stay exactly as they are: a human deletes shared notes, the Archivist never deletes, working
      memory cannot be forgotten by a bot, and the house layer stays read-only.
- [ ] **5 · Tokenizer + honest updater dependency check.** `gpt-tokenizer` for real BPE. Then make `package.ts:100`
      ask *"does this release need anything not already on disk?"* instead of *"did the lock change?"* — keep the
      guard, make it accurate. Test both ways: a bundled dependency self-applies, a native module still refuses.
- [ ] **6 · Context engine 1-to-1.** Last. Vault `context-engine-1-to-1-with-hermes.md`, evidence in
      `legion-context-gaps-analysis.md`. Read the reference's stated **reason** before closing a gap.

## CARRIED FIRST — parked, needs a rebase

- [ ] **1 · The house trust record.** Branch `fix/house-shipped-record` @ `31a31a9`, worktree
      `D:/bots/legion-shipped`. Committed, **not merged**. Two owner decisions: the bytes always survive, and
      `.shipped.json` moves out of the layer into the data directory beside `.adopted.json` — because the precondition
      *"the copy still hashes to what the app shipped"* is worthless when the agent can write the manifest that makes
      it true. **Re-prove** Zealot test 2.4 in the record's new home after the rebase; do not inherit that branch's run.

## OWNER — not agent work

- [ ] **H1–H10.** The house layer has **never run in a real Legion**. First live run already found 46 stale
      `claude/skills` files in the live layer, listed as `shipped` and served trusted, because sync never deletes.
      Item 1's record move is what closes that class.
- [ ] **B9.** Reproduce the community Blender add-on's pinned hash. Still open, and `SECURITY.md` says so on purpose.

## DELIBERATELY NOT DOING

- **An effort picker.** Owner decision 2026-10-04: not needed, the slash command stays. There is no reasoning-effort
  knob anywhere in the provider model, so it would have meant the profile, the settings route, the provider request
  and the UI, shown only for models that accept it. **Do not re-propose it as a gap — the absence is a decision.**
