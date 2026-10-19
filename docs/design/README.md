# Design notes

Design plans, specs and real-PC check lists behind Legion's modules. Code comments point here for the reasoning behind a rule; the user docs are one level up, in `docs/`.

- `plan-*.md`: the design plan for one module (updater, projects, browser, Blender, BSV and so on), written before it was built. Plans record decisions at the time; the code and the user docs are the current truth.
- `spec-*.md`, `design-*.md`, `audit-*.md`: a spec, a design note or an audit for one feature.
- `tracker-pc-checks*.md` and `real-pc-test-plan.md`: checks that need a real Windows PC, a real wallet or a real Blender, and their results. Some tests read these files, so a check recorded as passed can change what the app says.

These files lived in `claude/` until 2026-10-19. An older reference to `claude/<name>.md` means `docs/design/<name>.md`.
