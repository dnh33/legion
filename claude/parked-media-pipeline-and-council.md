# Parked: legion-media-pipeline and the expert council

**Status: parked. Do not build. Revisit after Legion ships.**

Date parked: 2026-10-05
Origin: a council ran against the idea on 2026-10-05. Four seats, all independent, all read the real repo.

## The idea as floated

Build something into Legion that builds on the new `legion-media-pipeline` repo and offers value to
any end user besides the founder. Floated as: a `/kodawari` expert council with different backgrounds.
Also parked alongside it: a `/advisor` tool in the spirit of Claude Code's, but different.

Decision already taken and **not** up for revisiting here: library first, ownership later.

## Verdict

**The council is not new capability. The audience does not exist. Both can be true at once, and that
is the problem.**

Every seat independently landed on the same two facts once they read the repo, and I verified both.

## What the council already is

Legion already ships the adversarial seat and the kodawari seat, as named agents:

- `src/core/roster.ts:26` **Inquisitor**: "the order's hostile reviewer... Your default verdict is NOT
  FIXED until evidence proves otherwise."
- `src/core/roster.ts:89` **Preceptor**: "runs the Kodawari loop on anything made: art, UI, copy, code,
  numbers... Look at it at the size it ships."

It already ships the debate substrate (rooms, with hop and cost guards), and `docs/LIBRARY.md:90`
already lists "The Council dialog (convening a review as a room from a note)" as designed-not-built.

So a council is **rooms + personas + a rubric**. The only genuinely new content is the **domain
rubric**: what "good" means for video, mascot art and 3D. That is a document, not a subsystem.

## What the audience actually is

Not "any end user". The reachable set today is **Claude Code subscribers, on Windows, who build from
source.** `package.json` is `private: true`, engines `node >=20.10`, installs via `setup.cmd`, unsigned,
Windows only, and it runs on the user's own Claude Code login.

That audience is the one least likely to buy a council, because they can spawn their own agents. The
sharpest line from the council, from the solo-dev seat: *a council is a tool for someone who already
has too many tools, and Legion's reachable buyer is the most likely to build one themselves.*

## The finding that inverts the build order

Not the personas. The **evidence substrate.**

Kodawari's own rule is evidence over assertion, render it, run it, count it. Personas produce
assertions. So a council of personas with no substrate is kodawari-shaped slop, which is the exact
thing kodawari exists to kill.

Required shape, decided now because it cannot be back-filled:

- every artifact is content-addressed: `(seed, pipelineVersion, params) -> artifactHash`
- every finding carries `{findingId, artifactHash, evidencePath, checker, verdict}`
- at least one reviewer is **deterministic**, not a persona: measures contrast ratio, counts assets,
  tests the silhouette at shipped size

Provenance is the one thing "later" means never. An artifact whose inputs were never recorded cannot
be verified later, only discarded.

## The two traps the council found

**Licence, and it is a one-way door.** `docs/BLENDER.md:36` records it: the official Blender server is
GPL-3.0-or-later, Legion is Apache-2.0, and the doc's own instruction is "Get a proper licence check
before you redistribute a build that includes any downloaded component." Media work drags in codecs,
model weights, fonts and CC-NC assets. The licence boundary must be decided **before** the first
third-party media dependency enters. Ownership follows the contract, never the other way round.

**Naming collision.** Legion already ships a user-facing feature called **the Library** (the knowledge
graph, `docs/KNOWLEDGE-GRAPH.md`, 21 `kg_*` tools). A repo called a "library" collides with shipped
vocabulary in the UI.

## What will rot first, in order

1. Orphaned evidence. A finding points at `out/sprite_03.png`, the next run renames it, the finding is
   silently unverifiable.
2. Persona-prompt drift. The shared context block is copy-pasted per seat; change the price once and
   seven prompts are stale.
3. Cost guards trip mid-council. They are tuned for one operator; six seats multiplying agent count
   and re-render loops will abort with a partial verdict set that reads as a bug.
4. Correlated findings. Same model across seats means lower variance and identical bias: six personas
   all miss the defect none of them rendered.
5. Blender is one heavyweight desktop process. Six seats wanting it is a serial queue nobody built.

## If it is ever revived, the only defensible smallest thing

Not a council. An **asset-consistency checker**: a folder of sprites or clips in, a ranked list of
art-direction breaks out, with before and after crops. A checker, so the churning generator is never
owned. Small. Does the boring job by hand that indies do by eye.

Parked as a guess, not a plan. It is unvalidated and the council said so.

## What would have to change to un-park

1. Legion ships: signed, public repo, one real Windows user who is not the founder.
2. A licence boundary is written down for the media dependency set.
3. Provenance is captured from the first artifact, or it is accepted that old ones are unverifiable.
4. Someone who is not the founder asks for the checker. Not predicts. Asks.

## Council record

Four seats, dispatched 2026-10-05, each independent and none shown the others' answers:
indie product marketer (commercial), systems architect (complexity), solo dev who has sold small
desktop tools (would I pay), adversarial reviewer (refute, defaults to not fixed). All four read the
real repo. The adversarial seat's factual claims were verified by hand against `src/core/roster.ts`,
`package.json`, `docs/LIBRARY.md`, `docs/BLENDER.md`, `AGENTS.md` and the release tracker.

Full memo from the solo-dev seat: `council-buyer-critique.md` (scratch workspace, not in the repo).