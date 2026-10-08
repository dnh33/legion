---
name: blender-bridge-recipes
description: Use when you script Blender through Legion's Blender bridge (blender_exec) in the cloud VM or locally. The safety-check rules that refuse scripts, the scene facts, and a render setup for honest flat colour.
---

# Blender bridge recipes

A refused script never reaches Blender, and you must not resend it unchanged. These rules save the round trips.

Proven in: Spike 003-A in the cloud VM. Refuse list checked against `src/core/blender/static-check.ts` on 2026-10-08 (bare module names incl. `nt`, line 68-73; `ops-alias`, line 664; inline export paths, line 498). Tool names checked against their registration in `src/core/blender/guard.ts` (`blender_exec` line 661, `blender_inspect` line 671). If either file changes, re-check.

## The safety check refuses
- **The variable name `nt`.** It is the Windows name of the `os` module, and the check refuses blocked module names even as bare names. Use `tree` for a node tree.
- **Any `bmesh.ops.*` call.** It is flagged as an ops alias. Build geometry with `bm.verts.new` and `bm.faces.new`. A small `tube(rings)` helper covers spheres, cones and swept horns.
- **Computed export paths.** Write every path inline at the call: `scene.render.filepath = LEGION_EXPORT_DIR + "/name.png"`. A path passed through a variable or a helper function is refused. Unroll render loops into one explicit line per file.

## Scene facts
- **Smoke test first:** print `bpy.app.version_string`, write one tiny PNG, then call `blender_inspect` to confirm the scene persists between calls. In the VM it does, within one task.
- **Call `bpy.context.view_layer.update()`** before you read `matrix_world` on new objects. Without it, world positions are the identity, and any rule based on position silently uses local space.
- **Cycles on the CPU works headless in the VM.** The engine list may show only EEVEE, but `scene.render.engine = 'CYCLES'` succeeds.
- **A `.blend` that comes back from the VM is quarantined** as `.blend.untrusted`, outside the export folder. Copy it with the suffix and say so. Do not rename it yourself.
- **Stop the VM** with `vm_stop` when you are done.

## Honest flat colour (for legibility tests and palettes)
- Use emission shaders, and set the view transform to **Standard**. The default AgX or Filmic tone map washes out the colours you are testing.
- Turn film transparency on.
- For an outline, use an inverted hull: a Solidify modifier with flipped normals and Material Offset = 1, so the shell faces use the last material slot, and a shader that mixes dark emission with transparent on `Geometry > Backfacing`. Cycles ignores backface culling, so the mix does the work.
- Use an orthographic camera fitted to the bounding box of all meshes (horns and outline included). Then measure the result from the alpha channel.

## When not to use Blender
If a renderer already draws the thing, propose changes through that renderer instead (see `mockup-through-the-real-renderer`). A Blender image of a rule does not carry over to Canvas 2D.
