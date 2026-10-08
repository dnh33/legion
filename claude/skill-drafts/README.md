# Skill drafts (not shipped)

These are drafts written by Legion agents from work that went well. They are not in `skills/`, so no agent is served them yet.

To ship one (ADR 0012):
1. Move it to `skills/<group>/<name>/SKILL.md`.
2. Add a row to `skills/SOURCES.md`. These drafts are original Legion work, not vendored text.
3. Add the licence file that the tests require.
4. Turn it on in Settings → Doctrine.

That is the owner's call.

| Draft | Author | From | Status |
|---|---|---|---|
| `art/mockup-through-the-real-renderer` | Sculptor | Steinbock visual direction, 2026-10-08 | Preceptor: SHIP (fixes applied 2026-10-08); waits on owner |
| `art/small-sprite-legibility-gate` | Sculptor | Spike 003-A and the Steinbock 24 px gate | Preceptor: SHIP (fixes applied 2026-10-08); waits on owner |
| `art/procedural-texture-anti-slop` | Sculptor | Steinbock seasons, erosion and rock bands | Preceptor: SHIP; waits on owner |
| `art/blender-bridge-recipes` | Sculptor | Spike 003-A in the cloud VM | Preceptor: SHIP once tool names verified (done 2026-10-08, guard.ts); waits on owner |

How drafts get here: when an agent finds a way of working that is clearly better and repeatable, it writes a short skill here in the same format as `skills/`, plus a one-line recipe in the Library (`kg_capture`, kind `pattern`). Preceptor reviews drafts for craft and wording.
