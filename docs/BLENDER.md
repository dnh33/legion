# Blender Bridge

The Sculptor can build 3D scenes in Blender. This page says what the bridge is, how to set it up, what protects you, what does not, and which parts have not been tried on real machines yet. Off by default.

## What it is

- **One guarded tool server for agents, not the only way into Blender.** Agents never see a Blender backend's own "run Python" tool. The Sculptor gets one in-process MCP server, `legion_blender`, with five tools: `blender_exec` (run a script), `blender_inspect` (read the scene), `blender_screenshot` (look at the result), `blender_docs` (API docs search, official backend only) and `blender_status`. Every other agent has none of these, and Legion forbids the raw servers by name (see [Safety model](#safety-model)). That is a rule about what AGENTS can reach. It is not a lock on Blender itself: while the add-on's server is running, the add-on's port accepts connections from any program on this computer (see [The add-on socket](#the-add-on-socket-has-no-password-a-known-limit)).
- **Two places a script can run.**
  - **Sandbox (default).** Headless Blender in the Sculptor's boat.dev VM. The script never touches this computer. Only exported files (GLB, FBX, PNG and similar) come back, into `<workspace>/blender-exports/<task>/`.
  - **Live.** Your open Blender, reached through a local add-on socket (`127.0.0.1` only). Every live script gets a **LIVE** approval card.
- **Two backends for live Blender.** The official Blender Lab MCP server (Blender 5.1 and newer, started by Legion over stdio) and the community Blender MCP add-on (Blender 3.0 and newer, reached over its JSON socket). `Auto` picks the official one for 5.1+ and the community one for older Blender. **Prefer the official one**: the community add-on's socket has no password (see below), and Legion only uses it when your Blender is older than 5.1 or you pick it.

## Set up

1. Settings, **Blender**: turn the bridge on. Nothing is detected, downloaded or handed to agents before this.
2. Legion finds Blender (Program Files, Steam, the registry `InstallDir`, `PATH`, and the usual macOS and Linux places) and reads its version with `blender --version`. With several versions it uses the newest; set a folder under **Advanced** to override.
3. **Set up** downloads the backend from its official source, installs the add-on into Blender headlessly (`blender -b --python-expr ...`), saves how to start the server, and, for the sandbox, installs headless Blender in the Sculptor's VM if it is missing. It runs only when you press it, and every step is listed with what it did.
4. **Test connection** checks the add-on socket, connects, and reads the scene. **Launch Blender** starts Blender for you (the community add-on's server starts by itself; for the official add-on you start the server from its sidebar panel).
5. The Ops panel shows a Blender light: Off, Not found, Needs setup, Not listening, Connected, Sandbox ready, or Problem.

Downloads are https only, from public hosts only, with a size cap.

**What is pinned, and what is not.**
- The official server's default address is the **v1.0.3 tag** archive and its sha256 is pinned in the defaults (`blender.advanced.official.sha256`). A different file is refused. The pin was taken from a real download of that archive; it proves the file is the one that was looked at, not that the code is safe.
- The community add-on's default address is the upstream `main` branch (`addon.py`), which moves. No tag or commit could be looked up when this was written, so it is **not pinned**. Pin one yourself: set `blender.advanced.community.addonUrl` to a commit URL and `sha256` to its hash.
- **Trust on first use, with a re-trust step.** With no pin, the first download from an address is trusted and its hash recorded in `<data dir>/blender/setup.json`. A later Set up that downloads a DIFFERENT file from the same address is refused: nothing is installed, the recorded hash is not overwritten, the Settings page says the download CHANGED and shows a **Trust the new download** button. Only that button (the `retrust` flag of `POST /api/blender/setup`) accepts it. A different address counts as a new source. A pinned `sha256` is never overridden by the button.
- **Python dependencies of the official server.** The server is started with `uv run`. The archive ships no `uv.lock`, so Set up creates one (`uv lock`, one download from the package index, hashes recorded) and every later start uses `uv run --frozen`, which installs exactly that locked set. This pins what was resolved on the day you pressed Set up; it does not prove those packages are the ones the authors tested. If `uv lock` fails, or the launcher is not `uv`, the step says **NOT PINNED** and the first start resolves dependencies unpinned.

## Licence note

The official Blender Lab MCP server is **GPL-3.0-or-later**. Legion is MIT. Legion never bundles or copies it: it is downloaded from its official source only when you press Set up, lives in `<data dir>/blender/official/`, and stays a separate program that Legion talks to over stdio and a socket. The community add-on is MIT and is handled the same way (downloaded on request, not shipped). Get a proper licence check before you redistribute a build that includes any downloaded component.

## Safety model

What happens to every `blender_exec` call, in this order:

1. **Static check.** The script is read as Python tokens (a tokenizer written for this, including f-string expressions; it runs in linear time, a 56 KB script takes tens of milliseconds) and refused when it cannot be shown harmless. Refused:
   - imports outside a short allowlist (`bpy`, `bmesh`, `mathutils`, `idprop`, and plain computation modules such as `math` and `random`). `typing` (its `get_type_hints` and `ForwardRef` evaluate strings), `bpy_extras`, `numpy`, `gpu` and `blf` are not on it;
   - `os`, `sys`, `subprocess`, `socket`, `importlib`, `ctypes`, `base64`, `io` and similar, also as bare names or attributes; `eval`, `exec`, `compile`, `open`, `__import__`; `as_module`, `use_module`, `get_type_hints`, `ForwardRef`; any `use_scripts=`; dunder and private attribute access;
   - `getattr` and `setattr` with a path-like name (`filepath`, `directory`, ...), or with a name that is not a plain safe literal;
   - file paths: any attribute or keyword whose name says path, dir, directory, file, folder or output (also `cache_directory`, the file-output slot `.path`, `base_path`) must be a plain literal inside the export folder, or `LEGION_EXPORT_DIR + "/name"`. This is checked in EVERY assignment form: plain, chained, annotated, augmented, tuple, `for` and `with ... as` targets. In the sandbox `//` (next to the VM's .blend) is also allowed; in LIVE mode `//` is refused, because it would resolve against whatever file is open;
   - **operators by namespace allowlist.** Only modelling, material, scene-data, image, render-to-file and import/export namespaces (`object`, `mesh`, `curve`, `material`, `node`, `uv`, `transform`, `collection`, `anim`, `armature`, `export_scene`, `import_scene`, ...) are allowed, and `wm`, `image`, `render` and `outliner` only for the few operators listed in the code. Everything else is refused, including any add-on's operators (`bpy.ops.blendermcp.*`), `script`, `text`, `console`, `preferences`, `extensions`, `file` (so `bpy.ops.file.unpack_*`), `render.play_rendered_anim` and `wm.read_factory_settings`. Operator names are not exempt from the banned-word list;
   - in LIVE mode `wm.open_mainfile`, `wm.append`, `wm.link`, `wm.read_homefile` and `wm.revert_mainfile` (a `.blend` can carry runnable code), and `wm.save_as_mainfile` unless it says `copy=True`;
   - driver expressions, handlers, timers, message buses, add-on and preference access; `**` unpacking in calls;
   - bidirectional text controls anywhere in the script (they can make the card show something other than what Python reads). Other invisible characters are allowed but flagged on the card.
   Findings are returned to the agent with the line and rule. Lone `\r` counts as a line break in the check and on the card, so the numbers agree.
2. **Approval card with the full script**, awaited inside the tool (a bot running in bypass mode still stops here). The card shows the script with line numbers (long lines wrap; nothing hides behind a scroll bar), whether it runs in the sandbox or LIVE, which agent asked, a purpose line labelled **"The bot's text, not checked"** (it is written by the agent, control and hidden characters are removed, one line, 200 characters), notes from the check, the export folder and the backup status and the script's hash. Hidden characters inside the script are shown as visible U+XXXX markers and the card says how many there are. A Blender script is allowed by clicking, not by a key. No answer in 10 minutes means denied.
3. **Audit, first line.** The `approved` record is written BEFORE anything runs. If it cannot be written (disk full, folder not writable) the script does NOT run and the agent is told so: a live run that cannot be recorded does not start.
4. **Backup.** Before the first live script of a task the open scene is saved as a `.blend` copy in `<data dir>/blender/backups/`. If the backup fails the script does not run.
5. **Run.** Live scripts run one at a time inside a Legion-written wrapper (the script is embedded, line numbers are kept, `LEGION_EXPORT_DIR` is defined as the REAL path of the export folder). Sandbox scripts run in the VM against a `scene.blend` kept per task, with their own script file and result file for every run, a per-task queue, and a sha256 check inside the VM: the runner refuses a script whose bytes are not the approved ones, and Legion discards a result that carries another run's id or hash. If a live script hits the time limit, the agent is told it **may still be running** (Legion cannot cancel it); Blender is marked busy and the next live script is not started until Blender answers a probe again.
6. **Audit, second line.** `<data dir>/blender/audit.jsonl` (mode 0600, append only): one line per decision and one per read-only tool call (inspect, screenshot, docs, status): script hash and size, mode, agent, task, decision (blocked, denied, timeout, approved, completed, backup_failed, unavailable, refused, read), result summary, whether it timed out, and any quarantined files. The script text is not stored; secrets are scrubbed.
   - **What the chain is.** Each line carries a hash of the previous line (`chain`). It is **unkeyed**: it catches an edit or deletion in the middle of the file and accidental damage. It does not catch a cut-off tail by itself, and anyone who can write the file can recompute the whole chain.
   - **Head anchor.** The newest chain value and the line count are also kept in `audit.jsonl.head` (rewritten atomically after each line, like the BSV audit's head). The status view compares the two: a cut-off tail or a replaced shorter log shows as a mismatch, a missing anchor is flagged. A same-user program that rewrites BOTH files consistently is not detected; nothing keyless on the same disk can.
   - Failed writes are counted and shown in the status view.

Everything Blender prints is outside text: it is wrapped, capped, scrubbed of live secrets, and the run is marked **tainted** (so shared notes it writes wait in the Inbox). The Sculptor is the only agent with the server; other agents cannot reach it, and Legion adds `mcp__blender`, `mcp__blender-mcp`, `mcp__blender_mcp`, `mcp__claude_ai_Blender` and any server you configured whose name or command mentions Blender to every agent's disallowed tools while the bridge is on, so the raw execute tool of a Blender MCP you installed yourself cannot bypass the card. Only those names (and config-defined servers that look like Blender) are covered; a connector with an unrelated name is not.

### Limits, stated plainly

- **The check is a filter, not a sandbox.** It cannot stop a script that wrecks the open scene, loops forever or uses all memory, and it cannot know every Blender API that evaluates a string. The card, the backup and the sandbox exist because of that. Read a LIVE script before you allow it.
- **Live Blender runs with your user's rights.** An approved script that got past the check runs as you. Prefer the sandbox for anything you are unsure about.
- **Exported `.blend` files can carry runnable code** (text blocks that run on load, drivers, handlers). Sandbox exports that are `.blend` are therefore NOT put in the export folder: they are quarantined as `<workspace>/blender-quarantine/<task>/<name>.blend.untrusted`, a folder the live path check never allows, and live scripts cannot open, append or link a `.blend` at all. If you open one yourself in Blender, Blender may offer to run its scripts; do not allow that for a file you did not make. Other export types (GLB, FBX, OBJ, PNG, ...) are data.
- **Links.** The export folder (live) and the folders sandbox exports are copied into must be real folders inside the agent's workspace. A symbolic link at the folder, inside it, or at a file name is refused or replaced, never followed (realpath, `lstat`, a temp file plus rename). A check followed by a write is not atomic: a program running as you that swaps a folder for a link in between can still win. This stops planted links, not a live attacker.
- **The audit log is not tamper-proof.** The chain is unkeyed and the head anchor sits on the same disk (see step 6). A same-user attacker can edit Legion's files and the audit log; the chain and anchor make clumsy edits visible, they do not prevent one.
- Text that came from a backend (a child process or a socket peer), including its error messages, is outside text: wrapped, scrubbed, capped and tainting, like script output.

### The add-on socket has no password (a known limit)

The community add-on listens on `127.0.0.1:9876` and accepts any JSON command from any program on this computer, with no token and no handshake. **Legion cannot add authentication to someone else's add-on**, and the official server's add-on socket is the same kind of local listener. While Blender's server is running, a program running as any user on the machine (a script, another app, a bot's Bash tool) can send Python to Blender without Legion's approval card, the static check, the backup or the audit line. This is the same class of limit as the BSV wallet on `127.0.0.1:3321`: no Legion code sits in front of it. Only OS isolation (a VM, or a separate OS account for Bash-capable bots) stops it.

What Legion does about it, and what that does and does not give you:
- **Prefers the official stdio backend** for Blender 5.1 and newer (the community socket is used only for older Blender or when you choose it).
- **Connects only while a call is running.** The community backend opens its connection for one call and closes it again; Legion never holds an idle connection to the port.
- **Checks who answers.** Before it sends a script or asks for a screenshot it asks for the scene summary and requires the reply to look like the add-on's (an object count and an object list). A different program on that port is refused and nothing is sent to it. This is an identity check on the answer, not authentication: an impostor that copies the reply passes, and it does nothing about OTHER programs talking to the real add-on.
- **Shows a notice** in the Blender card and Settings whenever a live backend is possible: "any program on this computer can send code to its port".
- A per-launch token was not possible: the add-on has no place to check one, and Legion does not patch downloaded code.
- Advice: stop the add-on's server (or close Blender) when the bridge is not in use, and do not give a Bash tool to an agent that reads untrusted content.
- `vm_claude` hands a task to Claude Code inside the VM, which can run Blender there with no Legion card. That is inside the VM, the same trust as any other VM work; it never reaches your computer.
- The Sculptor is identified by its id (`sculptor`). Agents you create yourself do not get the tools.

## Settings and config

`config.json` key `blender`: `enabled` (false), `backend` (`auto`, `official`, `community`), `host` (loopback only; anything else is replaced by 127.0.0.1), `port` (default 9876), `installPath`, `sandbox` (`auto` = sandbox unless asked to go live; `vm` = sandbox only; `off` = live only), `entry` (written by Set up) and `advanced` (everything below). The settings page only changes enabled, backend, sandbox, port and install path; `advanced` and `entry` are edited by hand.

`advanced.official`: `sourceUrl` (default: the v1.0.3 tag), `sha256` (default: its pinned hash; an explicitly empty string means "no pin: trust on first use, re-trust on change"), `command`, `args` (with `{serverDir}`, `{host}`, `{port}`; default `run --project {serverDir}/mcp blender-mcp`), `env` (default `BLENDER_MCP_HOST` and `BLENDER_MCP_PORT`), `addonPath` (inside the archive; default `addon/blender_mcp_addon`), `tools` (names of the server's exec, inspect, object-info, screenshot and docs tools and the argument that carries the code; defaults are the v1.0.3 names `execute_blender_code`, `get_objects_summary`, `get_object_detail_summary`, `get_screenshot_of_window_as_image`, `search_api_docs`). The no-approval tools (inspect, object info, screenshot, docs) are matched by EXACT configured name, or by the server's own `readOnlyHint`; the exec tool is excluded from them, and an inspect call is never given an argument that looks like code (`code`, `script`). `advanced.community`: `addonUrl`, `sha256`, `commands` (names in the socket protocol), `startExpr`. `advanced.vm`: `blenderUrl` (where headless Blender is downloaded inside the VM), `blenderBin`, `timeoutSeconds`, `runCommand` (with `{blender}`, `{runner}`, `{workdir}`).

HTTP (admin only): `GET /api/blender` (`?refresh=1` to detect again), `POST /api/blender/config`, `/setup` (`{target: live|sandbox|both, retrust?: boolean}`), `/test`, `/launch`. Status changes are pushed as `blender.status` events to admin clients only.

## Not verified yet

This was built and tested without Blender, a real boat.dev key or a network. What the tests do cover: the static check (bypass attempts), the approval, backup, audit and taint rules, both backends against in-process fake servers, setup against fake file systems and a stubbed `fetch`, the sandbox runner against real `bash` and real Python with a stub `bpy`, the HTTP routes and the real UI in a browser. What they do not cover, and what to check:

**Official backend.**
- The defaults (v1.0.3 archive, its sha256, the tool names, `uv run --project {serverDir}/mcp blender-mcp`, the environment variables) were taken from the real archive and its source, but the server was never started against a real Blender 5.1 here.
- **The official add-on is an extension** (it has a `blender_manifest.toml`, not a legacy `bl_info`). Legion's headless installer copies it into the user's add-ons folder and enables it as a legacy add-on, which may not work for an extension. The Set up step reports what Blender said; if it fails, install the add-on from the archive through Blender's own extension installer (Edit, Preferences, Get Extensions, Install from Disk). Not verified.
- Whether `uv lock` and the first start's dependency download work behind your network.
- At connect time Legion matches tools by exact configured name or `readOnlyHint` and by pattern, and refuses to connect if it finds no execute tool. The patterns skip command-line (`_for_cli`) variants on purpose.

**Community backend.**
- The JSON socket protocol (`{"type": ..., "params": ...}`, `{"status": ..., "result": ...}`) and the command names, taken from the public add-on; the upstream project may have been renamed or changed.
- `startExpr` (`bpy.ops.blendermcp.start_server()`) to open the socket without a click. Note that the static check refuses `bpy.ops.blendermcp.*` for agents; `startExpr` is Legion's own fixed expression, run when YOU press Launch.
- The community add-on's download address is a moving branch and is not pinned (see above).

**Sandbox, on a real boat.dev VM** (run these once, with a key):
1. Settings, Blender, Set up: does Blender 5.1 for Linux download, unpack and start in the VM image (`blender --version`)? Headless Blender needs shared libraries (libGL, libXi, libXxf86vm, libXfixes, libXrender); the step says what failed.
2. Ask the Sculptor for a cube and a GLB export: does the file come back to `<workspace>/blender-exports/<task>/`? Does boat's file API return the binary file correctly as base64?
3. `blender_screenshot` in the sandbox: does a Cycles CPU preview (8 samples) render within the timeout, and how long does it take?
4. Is the 600 second command limit enough, and what happens at the timeout?
5. Do two tasks keep separate `scene.blend` files, and does a second script in a task see the first one's result?

**Windows.** Detection of the Program Files, Steam and registry paths, `reg query`, `tar -xf` on a `.zip`, starting Blender detached, and the add-on install into the user's Blender folder have not been run on Windows. The detection logic is tested with injected file systems.

**Not fixable from Legion's side.** The add-on socket has no password (see the limit above); the audit chain is unkeyed; a link swapped between a check and a write can win a race.

**Other.** The size of a script the card can show comfortably; DNS rebinding on a download host (the address is checked, the resolved IP is not); Blender 4.2+ extension-style add-ons (the installer copies a legacy add-on and enables it).

## Files

`src/core/blender/`: `static-check.ts` (the filter), `guard.ts` (the tool server and the steps above), `audit.ts` (chain plus head anchor), `fs-safe.ts` (no-follow file helpers), `backend.ts` plus `backends/community.ts` and `backends/official.ts`, `sandbox.ts` (VM runner), `detect.ts` (pure detection), `setup.ts` and `system.ts` (setup logic and the only real side effects), `state.ts` (config and setup record), `index.ts` (the module, routes and status). Shared contract: `src/shared/blender.ts`. UI: `ui/src/blender/` and the Blender section of Settings. Tests: `test/blender-*.test.ts`.
