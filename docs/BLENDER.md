# Blender Bridge

The Sculptor can build 3D scenes in Blender. This page says what the bridge is, how to set it up, what protects you, what does not, and which parts have not been tried on real machines yet. Off by default.

## What it is

- **One door.** Agents never see a Blender backend's own "run Python" tool. The Sculptor gets one in-process MCP server, `legion_blender`, with five tools: `blender_exec` (run a script), `blender_inspect` (read the scene), `blender_screenshot` (look at the result), `blender_docs` (API docs search, official backend only) and `blender_status`. Every other agent has none of these, and Legion forbids the raw servers by name (see [Safety model](#safety-model)).
- **Two places a script can run.**
  - **Sandbox (default).** Headless Blender in the Sculptor's boat.dev VM. The script never touches this computer. Only exported files (GLB, FBX, PNG and similar) come back, into `<workspace>/blender-exports/<task>/`.
  - **Live.** Your open Blender, reached through a local add-on socket (`127.0.0.1` only). Every live script gets a **LIVE** approval card.
- **Two backends for live Blender.** The official Blender Lab MCP server (Blender 5.1 and newer, started by Legion over stdio) and the community Blender MCP add-on (Blender 3.0 and newer, reached over its JSON socket). `Auto` picks the official one for 5.1+ and the community one for older Blender.

## Set up

1. Settings, **Blender**: turn the bridge on. Nothing is detected, downloaded or handed to agents before this.
2. Legion finds Blender (Program Files, Steam, the registry `InstallDir`, `PATH`, and the usual macOS and Linux places) and reads its version with `blender --version`. With several versions it uses the newest; set a folder under **Advanced** to override.
3. **Set up** downloads the backend from its official source, installs the add-on into Blender headlessly (`blender -b --python-expr ...`), saves how to start the server, and, for the sandbox, installs headless Blender in the Sculptor's VM if it is missing. It runs only when you press it, and every step is listed with what it did.
4. **Test connection** checks the add-on socket, connects, and reads the scene. **Launch Blender** starts Blender for you (the community add-on's server starts by itself; for the official add-on you start the server from its sidebar panel).
5. The Ops panel shows a Blender light: Off, Not found, Needs setup, Not listening, Connected, Sandbox ready, or Problem.

Downloads are https only, from public hosts only, with a size cap. If you pin a sha256 in `blender.advanced.official.sha256` or `blender.advanced.community.sha256` a different file is refused; with no pin the hash is recorded and shown (trust on first use).

## Licence note

The official Blender Lab MCP server is **GPL-3.0-or-later**. Legion is MIT. Legion never bundles or copies it: it is downloaded from its official source only when you press Set up, lives in `<data dir>/blender/official/`, and stays a separate program that Legion talks to over stdio and a socket. The community add-on is MIT and is handled the same way (downloaded on request, not shipped). Get a proper licence check before you redistribute a build that includes any downloaded component.

## Safety model

What happens to every `blender_exec` call, in this order:

1. **Static check.** The script is read as Python tokens (a tokenizer written for this, including f-string expressions) and refused when it cannot be shown harmless. Refused: imports outside a short allowlist (`bpy`, `bmesh`, `mathutils`, plain computation modules such as `math` and `random`); `os`, `sys`, `subprocess`, `socket`, `importlib`, `ctypes`, `base64`, `io` and similar, also as bare names or attributes; `eval`, `exec`, `compile`, `open`, `__import__`; dunder and private attribute access; `getattr` and friends unless the name is a plain safe literal; file paths that are not a plain literal inside the export folder (or `//` next to the .blend) or `LEGION_EXPORT_DIR + "/name"`; `bpy.ops.script`, `text`, `console`, `preferences`, `extensions`, `file` and most `bpy.ops.wm` operators; driver expressions, handlers, timers, add-on and preference access; `**` unpacking in calls. Findings are returned to the agent with the line and rule.
2. **Approval card with the full script**, awaited inside the tool (a bot running in bypass mode still stops here). The card shows the script with line numbers, whether it runs in the sandbox or LIVE, which agent asked, a purpose line, notes from the check, the backup status and the script's hash. A Blender script is allowed by clicking, not by a key. No answer in 10 minutes means denied.
3. **Backup.** Before the first live script of a task the open scene is saved as a `.blend` copy in `<data dir>/blender/backups/`. If the backup fails the script does not run.
4. **Run.** Live scripts run one at a time inside a Legion-written wrapper (the script is embedded, line numbers are kept, `LEGION_EXPORT_DIR` is defined). Sandbox scripts run in the VM against a `scene.blend` kept per task.
5. **Audit.** One line per decision in `<data dir>/blender/audit.jsonl` (mode 0600, append only, hash-chained so an edit is detectable): script hash and size, mode, agent, task, decision (blocked, denied, timeout, approved, backup_failed, unavailable), result summary. The script text is not stored; secrets are scrubbed.

Everything Blender prints is outside text: it is wrapped, capped, scrubbed of live secrets, and the run is marked **tainted** (so shared notes it writes wait in the Inbox). The Sculptor is the only agent with the server; other agents cannot reach it, and Legion adds `mcp__blender`, `mcp__blender-mcp`, `mcp__blender_mcp`, `mcp__claude_ai_Blender` and any server you configured whose name or command mentions Blender to every agent's disallowed tools while the bridge is on, so the raw execute tool of a Blender MCP you installed yourself cannot bypass the card. Only those names (and config-defined servers that look like Blender) are covered; a connector with an unrelated name is not.

### Limits, stated plainly

- **The check is a filter, not a sandbox.** It cannot stop a script that wrecks the open scene, loops forever or uses all memory, and it cannot know every Blender API that evaluates a string. The card, the backup and the sandbox exist because of that. Read a LIVE script before you allow it.
- **Live Blender runs with your user's rights.** An approved script that got past the check runs as you. Prefer the sandbox for anything you are unsure about.
- A same-user attacker can edit Legion's files or the audit log; the hash chain makes an edit detectable, it does not prevent one.
- `vm_claude` hands a task to Claude Code inside the VM, which can run Blender there with no Legion card. That is inside the VM, the same trust as any other VM work; it never reaches your computer.
- The Sculptor is identified by its id (`sculptor`). Agents you create yourself do not get the tools.

## Settings and config

`config.json` key `blender`: `enabled` (false), `backend` (`auto`, `official`, `community`), `host` (loopback only; anything else is replaced by 127.0.0.1), `port` (default 9876), `installPath`, `sandbox` (`auto` = sandbox unless asked to go live; `vm` = sandbox only; `off` = live only), `entry` (written by Set up) and `advanced` (everything below). The settings page only changes enabled, backend, sandbox, port and install path; `advanced` and `entry` are edited by hand.

`advanced.official`: `sourceUrl`, `sha256`, `command`, `args` (with `{serverDir}`, `{host}`, `{port}`), `env`, `addonPath` (inside the archive), `tools` (names of the server's exec, inspect, screenshot and docs tools and the argument that carries the code). `advanced.community`: `addonUrl`, `sha256`, `commands` (names in the socket protocol), `startExpr`. `advanced.vm`: `blenderUrl` (where headless Blender is downloaded inside the VM), `blenderBin`, `timeoutSeconds`, `runCommand` (with `{blender}`, `{runner}`, `{workdir}`).

HTTP (admin only): `GET /api/blender` (`?refresh=1` to detect again), `POST /api/blender/config`, `/setup` (`{target: live|sandbox|both}`), `/test`, `/launch`. Status changes are pushed as `blender.status` events to admin clients only.

## Not verified yet

This was built and tested without Blender, a real boat.dev key or a network. What the tests do cover: the static check (bypass attempts), the approval, backup, audit and taint rules, both backends against in-process fake servers, setup against fake file systems and a stubbed `fetch`, the sandbox runner against real `bash` and real Python with a stub `bpy`, the HTTP routes and the real UI in a browser. What they do not cover, and what to check:

**Official backend (assumptions kept as config).**
- The archive address, the layout inside it (`addonPath`), how the server is launched (`uv run --project ...`), and whether the add-on honours a configured port. The tool names are guesses from the public description; at connect time Legion also matches tools by pattern and refuses to connect if it finds no execute tool.
- Whether `uv` is the right launcher and whether the first start's second download (Python dependencies) works behind your network.
- The tool-name patterns skip command-line (`_for_cli`) variants on purpose.

**Community backend.**
- The JSON socket protocol (`{"type": ..., "params": ...}`, `{"status": ..., "result": ...}`) and the command names, taken from the public add-on; the upstream project may have been renamed or changed.
- `startExpr` (`bpy.ops.blendermcp.start_server()`) to open the socket without a click.

**Sandbox, on a real boat.dev VM** (run these once, with a key):
1. Settings, Blender, Set up: does Blender 5.1 for Linux download, unpack and start in the VM image (`blender --version`)? Headless Blender needs shared libraries (libGL, libXi, libXxf86vm, libXfixes, libXrender); the step says what failed.
2. Ask the Sculptor for a cube and a GLB export: does the file come back to `<workspace>/blender-exports/<task>/`? Does boat's file API return the binary file correctly as base64?
3. `blender_screenshot` in the sandbox: does a Cycles CPU preview (8 samples) render within the timeout, and how long does it take?
4. Is the 600 second command limit enough, and what happens at the timeout?
5. Do two tasks keep separate `scene.blend` files, and does a second script in a task see the first one's result?

**Windows.** Detection of the Program Files, Steam and registry paths, `reg query`, `tar -xf` on a `.zip`, starting Blender detached, and the add-on install into the user's Blender folder have not been run on Windows. The detection logic is tested with injected file systems.

**Other.** The size of a script the card can show comfortably; DNS rebinding on a download host (the address is checked, the resolved IP is not); Blender 4.2+ extension-style add-ons (the installer copies a legacy add-on and enables it).

## Files

`src/core/blender/`: `static-check.ts` (the filter), `guard.ts` (the tool server and the steps above), `audit.ts`, `backend.ts` plus `backends/community.ts` and `backends/official.ts`, `sandbox.ts` (VM runner), `detect.ts` (pure detection), `setup.ts` and `system.ts` (setup logic and the only real side effects), `state.ts` (config and setup record), `index.ts` (the module, routes and status). Shared contract: `src/shared/blender.ts`. UI: `ui/src/blender/` and the Blender section of Settings. Tests: `test/blender-*.test.ts`.
