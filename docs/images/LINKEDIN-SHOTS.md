# LinkedIn screenshots

Regenerate with the rig, never by hand:

```
node scripts/harness/legion-harness.mjs start --no-copy     # prints handleFile
node seed.mjs <handleFile>                                   # project, board, Lattice, room, threads
node approval.mjs <handleFile>                                # a task stopped on an approval card
node serve.mjs <handleFile> 5173                              # built UI + admin proxy on :5173
CHROMIUM_PATH=<chromium.exe> node shoot.mjs <handleFile> shots
```

Playwright is not a dependency. `npm i --no-save playwright-core` and point `CHROMIUM_PATH` at a real
Chromium or Edge binary.

## What these are, honestly

Every pixel is the real UI (`dist-ui/`, built by `npm run build:ui`) driven against the real compiled
core (`scripts/harness/core-entry.mjs`) over its real HTTP API. The data is seeded through the product's
own routes, so the board, the Lattice and the rooms are the real stores.

What is faked, and only this:
- the model is the harness's scripted stand-in, not Claude;
- boat.dev, the BSV wallet and Blender are the harness fakes;
- the rig rewrites two things on the way out so a screenshot never leaks the rig: the model label
  ("Sonnet (harness)" becomes "Sonnet") and the stack's temp `LEGION_HOME` (becomes `D:\Legion`).

The VM live-view route answers 409 in the rig, because the fake boat cannot capture a desktop. The UI
then draws its own "Waiting for first frame" fallback. No desktop image is invented.

The project data, agent names, board items and Lattice notes are written for these screenshots. They are
not a record of real work. Version strings, agent names and the mascot are real.
