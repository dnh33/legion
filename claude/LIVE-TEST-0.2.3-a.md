# Live test — house context layer (0.2.3-a)

You are verifying a just-installed release on the owner's PC. This is a **live test against the real installed app**,
not the harness. The harness cannot prove the MCP surface end to end; only you, in a running Legion, can.

**Version under test:** `0.2.3-a`. Confirm with Settings before you start. If Settings shows a different version, stop
and say so — do not test a different build.

## What shipped

A new module, `src/core/house/`, copies a curated set of the project's own documentation into the data directory and
serves it to every agent through an in-process MCP server named `legion_house`, with three tools:

- `house_list` — every file in the layer, with sizes, and which expected files are missing
- `house_recall` — lexical search; returns file, heading and a short snippet
- `house_read` — one file in full

It exists because agents run in their own workspace and could not reach the repository's files at all. The house
rules, the ADRs, the glossary and the session log were written but unreadable to the bots that needed them.

## The part that matters most — trust

The layer is served as Legion's own words. That claim is only true while the bytes are the ones the app shipped.

The sync writes a sha256 manifest (`.shipped.json`) at copy time. A read compares it. **Anything edited or added since
install is served wrapped and labelled `[UNTRUSTED SOURCE]`** — which is exactly what should happen, because agents can
edit this repository, and without the check an agent's edit to `AGENTS.md` would come back as the owner's rules.

It **fails closed**: an unshipped file, or an unreadable manifest, grants no trust.

## Run this, in order

1. **Confirm the version** is `0.2.3-a` in Settings. Stop if it is not.
2. **Ask a Claude-provider agent** (not a provider-model agent — those have no file tools at all) to call `house_list`.
   Report the file count and anything listed as missing.
3. **`house_recall`** for something specific, e.g. `house_recall "dependency hash"` or `"trust"`. Report the hits,
   their paths and whether each is labelled trusted or untrusted.
4. **`house_read`** on `AGENTS.md` and on `docs/adr/0009-house-context-module.md`. Confirm both are readable and that
   neither carries an `[UNTRUSTED SOURCE]` wrapper.
5. **The trust test — do not skip this.** Ask the agent to write a new line into the repo's `AGENTS.md` (append a
   harmless comment). Then call `house_read` on `AGENTS.md` again.
   **Expected:** the file now comes back wrapped and labelled `[UNTRUSTED SOURCE]`, and the tool header says it is not
   what Legion shipped. **If it still reads as trusted, that is a serious defect — stop and report it immediately.**
   Revert your edit afterwards.
6. **The owner's own edits are also untrusted, by design.** Put a note in `%USERPROFILE%\.legion\context\` and confirm
   it is readable, survives a Legion restart, and is labelled untrusted. Say plainly in your report that this is
   expected, so the owner is not surprised by it.
7. **Restart Legion** and confirm the layer is still there and `house_list` is unchanged.

## Report back

- The version you actually tested
- Each step: what you ran, what came back, pass or fail
- Anything labelled `[UNTRUSTED SOURCE]` that should not have been
- Anything missing that `house_list` expected
- **Your honest read on whether this is ready to ship further, and anything you would change.** If you cannot verify a
  step, say "unverified" — do not imply you checked something you did not.

## What this does not cover

Provider-model agents have no file tools (`src/core/providers/runtime.ts`), so they cannot use these tools at all. That
is a property of that runtime, not a fault in this module, but confirm it: if a provider-model agent reports the tools
missing entirely, that is expected.