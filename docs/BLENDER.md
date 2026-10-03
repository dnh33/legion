# Blender Bridge

The Sculptor can build 3D scenes in Blender. This page says what the bridge is, how to set it up, what protects you, what does not, and which parts have not been tried on real machines yet. Off by default.

## What it is

- **One guarded tool server for agents, not the only way into Blender.** Agents never see a Blender backend's own "run Python" tool. The Sculptor gets one in-process MCP server, `legion_blender`, with five tools: `blender_exec` (run a script), `blender_inspect` (read the scene), `blender_screenshot` (look at the result), `blender_docs` (API docs search, official backend only) and `blender_status`. Every other agent has none of these, and Legion forbids the raw servers by name (see [Safety model](#safety-model)). That is a rule about what AGENTS can reach. It is not a lock on Blender itself: while the add-on's server is running, the add-on's port accepts connections from any program on this computer (see [The add-on socket](#the-add-on-socket-has-no-password-a-known-limit)).
- **Three places a script can run, four settings.** The setting **Where scripts run** (`mode`) is `auto`, `local`, `vm` or `live`.
  - **This computer, in the background (`local`; the default through `auto` when Blender is found).** Legion starts `blender.exe` without a window and runs the script in a scene kept per task. The script runs with your Windows user's rights. The approval card shows **On this PC**. Details in [Local mode](#local-mode). Not yet tried with a real Blender on Windows.
  - **Cloud VM (`vm`; internally still called the sandbox).** Headless Blender in the Sculptor's boat.dev VM. The script does not run on this computer. Only exported files (GLB, FBX, PNG and similar) come back, into `<workspace>/blender-exports/<task>/`. Not yet tried on a real VM.
  - **My open Blender (`live`).** Your open Blender, reached through a local add-on socket (`127.0.0.1` only). Every live script gets a **LIVE** approval card.
  - **Automatic (`auto`, recommended).** Local when Blender is found on this computer, otherwise the cloud VM; your open Blender only when the Sculptor asks for it and you approve a LIVE card. A newer Legion upgrades an existing `auto` install to this local-first behaviour and shows a notice until you save a mode.
- **Two backends for live Blender.** The official Blender Lab MCP server (Blender 5.1 and newer, started by Legion over stdio) and the community Blender MCP add-on (Blender 3.0 and newer, reached over its JSON socket). `Auto` picks the official one for 5.1+ and the community one for older Blender. **Prefer the official one**: the community add-on's socket has no password (see below), and Legion only uses it when your Blender is older than 5.1 or you pick it.

## Set up

1. Settings, **Blender**: turn the bridge on. Nothing is detected, downloaded or handed to agents before this.
2. Legion finds Blender (Program Files, Steam, the registry `InstallDir`, `PATH`, and the usual macOS and Linux places) and reads its version with `blender --version`. With several versions it uses the newest; set a folder under **Advanced** to override.
3. **Set up** downloads the backend from its official source, installs the add-on into Blender headlessly, saves how to start the server, and, for the cloud VM, installs headless Blender in the Sculptor's VM if it is missing. It runs only when you press it, and every step is listed with what it did. Local mode needs no Set up: it only needs Blender found on this computer.
   - **Official add-on (Blender 5.1+): installed as an extension.** The add-on has a `blender_manifest.toml`, so Legion uses Blender's extension commands, each as `blender --factory-startup --command extension ...` without a shell: `ext-build` (`build --source-dir <add-on> --output-filepath <data dir>/blender/official/mcp-<version>.zip`), `ext-repo` (`repo-list`, using a local repository from its output, or `repo-add --name Legion --directory <data dir>/blender/official/extensions legion_local`), `ext-install` (`install-file -r <repo> --enable <zip>`) and `verify` (`extension list` must show `mcp` and the version). The first failed step stops the rest, and the failure text names the by-hand route: Blender, Edit, Preferences, Get Extensions, Install from Disk. The module name you will see is `bl_ext.<repo>.mcp`; start the add-on's server from its sidebar panel. The extension path is implemented and tested against a scripted fake only; it has not been run on a real Blender 5.1 or later.
   - **Community add-on: legacy add-on folder (unchanged).** It is copied into Blender's user add-ons folder and enabled with `blender -b --python-expr ...`.
4. **Test connection** checks the add-on socket, connects, and reads the scene. **Launch Blender** starts Blender for you (the community add-on's server starts by itself; for the official add-on you start the server from its sidebar panel).
5. The Ops panel shows a Blender light: Off, Not found, Needs setup, Not listening, Connected, VM ready, Local ready, Running a script, or Problem. "Connected" means a live backend answered and is shown only when the mode is live (or automatic with a live backend reachable). The card's last row reads `Local: ready | not found`, `Cloud VM: ready | not ready`, `Live: connected | not connected`.

Downloads are https only, from public hosts only, with a size cap.

**What is pinned, and what is not.**
- The official server's default address is the **v1.0.3 tag** archive and its sha256 is pinned in the defaults (`blender.advanced.official.sha256`). A different file is refused. The pin was taken from a real download of that archive; it proves the file is the one that was looked at, not that the code is safe.
- **The community add-on is pinned to a commit.** The project moved: `ahujasid/blender-mcp` now redirects to `ahujasid/mcp-for-blender` (MIT). It has **no tags and no releases**, so the default address is a commit: `https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py`, with `sha256` `eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5` (270,889 bytes). A different file is refused. The pin proves the file is the one that was looked at on 2026-10-02, not that it is safe.
  - **TODO OWNER PC: reproduce the sha256 on your own machine before release.** The value was fetched in a session without access to your PC. In PowerShell: `curl.exe -sSL https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py -o addon.py; (Get-FileHash addon.py -Algorithm SHA256).Hash.ToLower()` must print `eb0facf6...97fa5`. If it differs, take the PC's value and re-check `git log -1 -- addon.py` on a clone before using it. Until this is recorded in `claude/tracker-pc-checks.md`, treat the pin as not yet reproduced.
  - **Renewing the pin later.** Pick a new commit, download `addon.py`, compute its sha256, run `git diff 91cd735..<new> -- addon.py`, read the diff for new imports and network calls, then update the address and the hash in one commit.
  - **The add-on makes its own outbound connections when its GUI server runs.** The file imports `requests` and has network features (Poly Haven, Poly Pizza, a telemetry-consent preference). That is the add-on's behaviour inside your open Blender and outside Legion's control. Local mode never loads it (see [Local mode](#local-mode)).
- **Trust on first use, with a re-trust step.** With no pin, the first download from an address is trusted and its hash recorded in `<data dir>/blender/setup.json`. A later Set up that downloads a DIFFERENT file from the same address is refused: nothing is installed, the recorded hash is not overwritten, the Settings page says the download CHANGED and shows a **Trust the new download** button. Only that button (the `retrust` flag of `POST /api/blender/setup`) accepts it. A different address counts as a new source. A pinned `sha256` is never overridden by the button.
- **Python dependencies of the official server.** The server is started with `uv run`. The archive ships no `uv.lock`, so Set up creates one (`uv lock`, one download from the package index, hashes recorded) and every later start uses `uv run --frozen`, which installs exactly that locked set. This pins what was resolved on the day you pressed Set up; it does not prove those packages are the ones the authors tested. If `uv lock` fails, or the launcher is not `uv`, the step says **NOT PINNED** and the first start resolves dependencies unpinned.

## Licence note

The official Blender Lab MCP server is **GPL-3.0-or-later**. Legion is MIT. Legion never bundles or copies it: it is downloaded from its official source only when you press Set up, lives in `<data dir>/blender/official/`, and stays a separate program that Legion talks to over stdio and a socket. The community add-on is MIT and is handled the same way (downloaded on request, not shipped). Get a proper licence check before you redistribute a build that includes any downloaded component.

## The title-bar chip

A single quiet pill, "Blender" with a cube icon and a status dot, sits in the title bar after the BSV chip and before Doctor (`ui/src/blender/BlenderChip.tsx`). It uses the Doctor button's size and the app's own colours. Clicking it opens a small popover with the status sentence from the same status as Settings (Off, Blender not found, Ready: this computer, Ready: cloud VM, Live Blender connected, Needs setup, Blender is running a script, and so on), one labelled switch, "Turn on the Blender bridge", and a button that opens Settings, Blender ("Get Blender" when none is found; it never starts the download, which keeps its own approval card). The switch is the same `blender.enabled` setting as the Settings switch. Turning it ON, from the chip or from Settings, first opens one dialog, "Turn on Blender?" (Cancel is the default; Escape cancels), which says that scripts run on this computer with your Windows user's rights, that Legion's check is a filter and not a sandbox, that every script still needs your OK, and that a cloud VM is the isolated option. Only after Turn on Blender does it call `saveBlenderConfig({ enabled: true })` (`requestEnableBlender` in `ui/src/blender/blenderStore.ts`, one function for both). Turning it OFF asks nothing. If the status is unknown or the last request failed, the chip says "Blender: unknown", locks the switch and shows no old state; an older core without the Blender module shows no chip. Below 1280 px wide the word goes first; the cube and the dot stay. The wording is built by `ui/src/blender/chipModel.ts` and tested in `test/blender-chip.test.ts`. Not yet looked at in the real app on Windows (see claude/tracker-pc-checks.md, B17).

## Local mode

Local mode runs `blender -b` on this computer against a per-task `scene.blend`, wrapped by Legion's own runner. **A local script runs with your Windows user's rights. Legion's check is a filter, not a sandbox.** The controls that matter are your OK on the full script, the scene backup and the audit log.

**Flow, per run** (after the static check, the card and the `approved` audit line):
1. One local Blender process at a time; a second run waits in a queue.
2. Task folder `<data dir>/blender/local/<task>/` with `scene.blend`, `backups/`, `exports/` and `tmp/`. It is outside the agent's workspace, links inside it are refused, and a folder over `maxTaskBytes` refuses the run.
3. Backup of `scene.blend` (see step 4 above), then the approved script is written byte for byte as `script-<run>.py`.
4. Spawn without a shell: `blender.exe -b --factory-startup --offline-mode --disable-autoexec --python-exit-code 3 --python <runner.py> -- <task folder> <run id> <sha256>`, working directory the task folder. `blender.exe` is used, never `blender-launcher.exe`, which detaches and loses its output.
5. The runner (Legion's code) refuses a script whose sha256 is not the approved one, opens or creates `scene.blend`, runs the script with output captured, saves the scene and writes `result-<run>.json`. Legion discards a result that names another run or hash.
6. Exports are copied from the task's `exports/` into `<workspace>/blender-exports/<task>/` under the same rules as the VM (extension allowlist, `.blend` quarantined as `.blend.untrusted`, 20 files, 15 MB, links refused).
7. Timeout (default 120 s) or output cap: the process tree is killed by PID.

**Hardening, and what each part does not prove.**

| Control | What it does | What it does not prove |
|---|---|---|
| Scrubbed environment, own home and temp folders, `--factory-startup` | Legion's own spawn passes an allowlist of variables (no `ANTHROPIC_*`, proxies, `PYTHONPATH`, `LEGION_*`) and no user add-ons or preferences load | The script cannot read your files; it runs as your user and the environment is only what Legion passes |
| Python write guard in Legion's own runner | Raises when the script's Python code opens, removes, renames or copies a file outside the task folder and Blender's temp folder | Python-level events only. Blender's C code (scene saves, many exporters) writes without a Python `open`; those stay governed by the static check's path rules. A script that defeats the runner could still write elsewhere, which the check forbids but only as a filter |
| Network guard in Legion's own runner, `--offline-mode` | Raises when the script's Python code connects a socket or starts a process | Python-level only; `--offline-mode` covers Blender's own online access, not every C-level socket; no firewall rule is created |
| Timeout, output cap, one process at a time | Bounds how long and how much one run costs; the process tree is killed by PID | No CPU, memory or GPU limit (a known gap) |
| Task folder confinement, size cap | Real-path checks, no links, a per-task folder | A same-user program that swaps a folder for a link between check and use can still win the race |

If the Python guard blocks a legitimate exporter on your PC, `advanced.local.guard` can be set to `log` (it then records instead of blocking). That fallback is documented, not applied by default.

**Which place the next script goes to** (`resolveMode`; the Settings hint and `blender_status` show the answer):

| Setting | Agent asks for | Result |
|---|---|---|
| auto | nothing | Local if Blender is found; else the cloud VM if it is ready (the tool result says so); else an error that names both fixes |
| auto | `local` | Local if found, else an error. Never a silent fall back to the VM |
| auto | `vm` | The VM if ready, else an error with the reason |
| auto | `live` | Live (a LIVE card; reachability is checked at run time) |
| local | nothing or `local` | Local if found, else an error |
| local | `vm` or `live` | Error: Settings restrict scripts to this computer |
| vm | nothing or `vm` | The VM if ready, else an error |
| vm | `local` or `live` | Error: Settings restrict scripts to the cloud VM |
| live (or the old `off`) | nothing or `live` | Live |
| live | `local` or `vm` | Error: Settings restrict scripts to your open Blender |

Legion never moves a script from a stricter place to a looser one on its own (vm to local, local to live).

## Getting Blender (Settings, Blender)

Local mode needs a Blender on this computer. Two buttons in Settings, Blender cover that; Legion bundles no Blender.

- **Get full Blender** is a link to the official download page (`https://www.blender.org/download/`). It opens in your browser. Legion downloads and installs nothing from it. Use it when you want Blender for your own work; Legion finds a normal install by itself.
- **Get Blender for Legion** fetches ONE pinned official portable build for Legion's own background runs. It runs only when you press the button (Windows only in this version), and it needs a second yes: the core raises an approval card that names the address, size, sha256, target folder and licence, and nothing is fetched or created before you press Allow. The card is shown in Settings, Blender and, as any card, in the Sculptor's chat. No agent can start it: the route (`POST /api/blender/get`) is admin-only by default-deny, and no agent tool calls it.

What Legion's own code does after Allow, in this order, stopping at the first failure: download to a temp file (https only, public hosts only, size cap); compare the sha256 with the pin **before anything is unpacked** (a mismatch deletes the file and installs nothing); unpack into a fresh staging folder with Legion's own zip reader (`zip.ts`, no `tar` or `unzip` process); check that `blender.exe` is there; move the folder into place (`<data dir>/blender/app/<version>/`) and write `<data dir>/blender/managed.json`. A failed run removes the staging folder and the archive and leaves an earlier install and its record as they were. The folder gets a `LEGION-README.txt` (version, source, hash); Blender's own licence files are inside the zip's top folder. Deleting the folder removes it; a Blender you installed yourself is never touched.

The zip reader refuses, before writing a byte: absolute paths, drive letters, colons (alternate data streams), `..` segments, names ending in a dot or space, Windows device names, anything outside the one expected top folder, symbolic links, encrypted entries, methods other than stored or deflate, repeated paths (case-insensitive), a path that is both a file and a folder, zip64, more than 40,000 entries or 3 GB unpacked. While unpacking, an entry that inflates past its declared size or fails its CRC-32 stops the run. What this does not cover: it cannot judge whether the program inside is good (the sha256 pin is what ties the archive to the official file), and it does not restore file permissions or timestamps.

**Detection prefers the managed copy** over a normal install; a path you set in Settings (Blender location) still wins over both. Both stay listed.

### What is pinned, and where each value came from

| Value | Pin | Source |
|---|---|---|
| Build | Blender **5.2.2 LTS**, Windows x64 portable zip (`blender-5.2.2-windows-x64.zip`, about 386 MB) | version, channel, size and date from blender.org (download page and LTS page, looked up 2026-10-02: 5.2 LTS, updated to 5.2.2 on 2026-09-15). Chosen because the official add-on needs 5.1 or newer and the docs Legion links are the 5.2 LTS manual |
| Address | `https://download.blender.org/release/Blender5.2/blender-5.2.2-windows-x64.zip` | Blender's release naming. **Not confirmed by a request** (the build session could not reach download.blender.org); the sha256 check is what makes a wrong or swapped file fail |
| sha256 | `3849d17a682cba006075aaa3f3597ecb5c9c30ec31035b2e092c53e40679b535` | **given by the owner in the build session (2026-10-02) as the value in Blender's checksum file** `https://download.blender.org/release/Blender5.2/blender-5.2.2.sha256`. **TODO OWNER PC:** not independently reproduced; compare it with that file or with `Get-FileHash <zip> -Algorithm SHA256` on the downloaded zip before release. The ARM64 zip has a different hash and is not pinned |

The address and hash are constants in `src/shared/blender.ts` (`MANAGED_BLENDER`), not config, so editing `config.json` cannot point the download elsewhere. If the constant hash were ever empty the download is refused; `blender.advanced.managed.sha256` (64 hex) is only a fallback for that case. To renew the pin later: pick the new patch release, copy its zip line from the official checksum file, update `version`, `url`, `topDir` and `sha256` in one commit, and re-run the PC checks.

### Minimum Blender for local mode is now 4.2

Local runs need Blender **4.2.0 or newer** (changed from 3.0). Older builds are listed but refused for local runs with a plain note; 3.0 and newer still work for the live community backend. Reason: 4.2 is the oldest long-term-support release this project supports, and exporter and preview operator names differ in older ones.

## Choosing where scripts run (first use) and what the Sculptor is told

The first time a Blender approval card appears and you have not yet chosen, the card carries a one-time chooser: **This computer**, **Cloud VM**, **My open Blender**, or **Decide each time (Automatic)**. This computer is highlighted when Blender was found, otherwise the cloud VM when it is ready. The click goes through the normal settings route (admin only; a token-only caller gets 403), is saved as `blender.mode` together with a `modeAsked` flag, and ends the question and the upgrade notice. It never replaces Allow or Deny on the card. Turning the bridge on alone does not answer it. Agents never change settings: a `mode` argument on a Blender tool picks the place for that one call, is checked against the setting, and is never saved.

The Sculptor's instructions say when each place fits: **local** for quick edits, your own scenes and files, previews and exports you want on this PC (it runs with your Windows user's rights, and Legion's check is a filter, not a sandbox); **cloud VM** for scripts or `.blend` files from the web or an unknown source, long or heavy jobs, when you want Blender kept away from your files, or when no Blender is installed here; **live** only when you asked it to work in your open Blender. It says which place it chose and why in one line, asks you in chat when the setting is Automatic and the choice matters, and cannot change Settings.

## Community add-on and official add-on together (research, 2026-10-02)

Question: can the Sculptor use both, for the largest tool surface? Findings:

- **Blender itself does not make them exclusive.** The official one is an extension (`id = "mcp"`, module `bl_ext.<repo>.mcp`); the community one is a legacy add-on file (`addon.py`, operators `blendermcp.*`). Different modules, different names, so both can be installed and enabled in one Blender.
- **The collision is the TCP port.** Each add-on opens its own listening socket inside the same Blender process. The community add-on keeps its port in a per-scene property (`blendermcp_port`, default 9876) and binds with `SO_REUSEADDR`; its auto-start skips when something already answers on that port, but a manual start does not check. On Windows `SO_REUSEADDR` can let a second program bind a port that is already in use, so two servers on the same port would not fail loudly. The official add-on's port setting could not be read here (projects.blender.org was unreachable); Legion passes the port to the official server through `BLENDER_MCP_PORT`, and its default is expected to be the same 9876. Unverified.
- **Legion today uses exactly one live backend at a time** (`chooseBackend` returns one kind; one `host:port` in config; the backend object is rebuilt when settings change). Every script from either backend still passes the same check, card and audit.

Decision (the safe option): **keep one live backend at a time**, which is what ships. Do not run both on one port. Using both is a documented follow-up, not wired, because it cannot be tested without a real Blender: it needs two ports in config (one per backend), two backend connections, a merged tool surface with the community-only asset tools (Poly Haven and similar, which make outbound connections from Blender) kept behind their own approval, a rule for which backend runs `execute` (one, never both), and a PC test with both add-ons enabled and a netstat check that two different ports listen.

## Use both backends at once (off by default)

Settings, Blender, "Use both backends at once" (`blender.both`). With it off, exactly one live backend is used, as before. With it on, the **official Blender Lab MCP is the main backend** and the **community add-on is a second source of read-only extras**; the Sculptor sees one merged tool list. Not yet tried with a real Blender (PC check B17).

**Ports.** The official add-on uses the Blender port setting (default 9876); the community add-on uses `blender.advanced.both.communityPort` (default 9877). They must differ. Legion never relies on `SO_REUSEADDR` (on Windows it can let two servers share one port without an error). Press Launch in both mode and Legion probes that both ports are free, starts Blender with `BLENDER_MCP_PORT` for the official add-on and a fixed expression that sets the community add-on's port and starts its server (whether the official add-on reads that variable is unverified: if not, set its port in its sidebar panel). Before any use Legion identifies each port: the community add-on must answer its `get_addon_info` handshake; the community add-on answering on the official port, or anything else on the community port, stops the connection with a plain message. The official port is only checked for not being the community add-on: nothing identifies the official add-on itself. A community add-on that is just not running only disables its extras.

**What is NOT protected.** Both add-on sockets have no password: any program on this computer can send code to either port without Legion's card. The identity check tells the two add-ons apart; it does not authenticate a caller. A program that takes a port between the check and the connection still wins that race. The official server's own read-only labels are trusted, and the filters that keep code- and path-taking tools out of the merged list look at argument names (a code or path argument under an unusual name would pass).

**Tool-by-tool routing.** One code-execution path only (the main backend's); the second backend's `execute_code` is never offered.

| Tool | Backend | Note |
|---|---|---|
| `blender_exec` | official | the community add-on's execute_code is NOT offered; same static check, card, audit and busy rules |
| `blender_inspect` | official | the scene summary and one-object detail |
| `blender_screenshot` | official | the viewport image |
| `blender_docs` | official | API docs search; the community add-on has none |
| `blender_status` | legion | where scripts go, which add-on answers on which port, which extras are available |
| `blender_tools` | legion | the merged list of extra read-only tools (source:name) |
| `blender_tool official:<name>` | official | only tools the official server marks read-only that take no code, path, file or address |
| `blender_tool community:node_type` | community | describe_node_type; hidden when the official server has an equivalent |
| `blender_tool community:api_lookup` | community | bpy_api_lookup; hidden when the official server has an equivalent |
| `blender_tool community:scene_snapshot` | community | get_world_state_snapshot; hidden when the official server has an equivalent |
| `blender_tool community:scene_items` | community | list_scene_items; hidden when the official server has an equivalent |
| `blender_asset_search / blender_asset_get` | legion | Legion fetches Poly Haven itself (card, hash, quarantine, taint); the add-on's own download, generator, export, telemetry and premium commands are never offered |

**Asset downloads (outside content).** Every source is off until you switch it on in Settings. Only Poly Haven is offered. The community add-on downloads and imports inside Blender, where Legion cannot place the file, record a hash or limit its size (it also appends `.blend` models, which can carry code), so Legion does the fetching itself: a read-only listing, then a card naming what, where from and how big; nothing is fetched before Allow; the run counts as tainted from then on; files go only to `<data dir>/blender/assets/<task>/<asset>/` (outside your workspace), as plain names with a glTF, `.bin`, image or HDRI extension (never `.blend`, scripts or archives), at most 25 MB per file, 100 MB and 40 files in total, checked against the API's md5 with the sha256 and size written to `manifest.json`, and imported by Legion's own fixed script. No downloaded script is run. What this does not prove: that Poly Haven's files are benign (the md5 comes from the same API), and a malformed glTF or image can still trouble Blender's importers. Sketchfab, Hyper3D, Poly Pizza, Hunyuan3D and Tripo are not available (they need your keys inside the add-on and import inside Blender). Poly Haven's terms ask for a unique User-Agent (Legion sends `Legion-Blender-Assets`) and a visible credit where its API content is shown: Settings says "Powered by Poly Haven" next to the switch (assets are CC0; source: github.com/Poly-Haven/Public-API, ToS.md). The Poly Haven file host comes from the API's answers and must end in `polyhaven.com` or `polyhaven.org`: **TODO OWNER PC** confirm it on a real download.

**A third backend, blenderwright (read-only review, not integrated).** Verdict: needs work. Its add-on socket has no authentication and allows several clients, its code-execution tool is a blocklist filter (not a sandbox), its file handlers do no path validation of their own, and its eight "sculpting" tools set up sculpt mode and brushes but cannot make a stroke. Details and sources are in `claude/plan-blender-local-first.md` section 15.

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
4. **Backup.** Before the first live script of a task the open scene is saved as a `.blend` copy in `<data dir>/blender/backups/`. Before every local run the task's `scene.blend` is copied to its `backups/` folder (the newest 5 are kept). If a backup fails the script does not run. A backup covers the scene file only, not anything else the script touched.
5. **Run.** Local scripts run through Legion's own runner in a background Blender, one at a time (see [Local mode](#local-mode)). Live scripts run one at a time inside a Legion-written wrapper (the script is embedded, line numbers are kept, `LEGION_EXPORT_DIR` is defined as the REAL path of the export folder). Sandbox scripts run in the VM against a `scene.blend` kept per task, with their own script file and result file for every run, a per-task queue, and a sha256 check inside the VM: the runner refuses a script whose bytes are not the approved ones, and Legion discards a result that carries another run's id or hash. A running live or local script marks Blender **busy** (light "Running a script"): a live inspect or screenshot during that time is answered with "busy" instead of waiting behind the script. If a live script hits the time limit, the agent is told it **may still be running** (Legion cannot cancel it); the next live script is not started until Blender answers a probe again. A local run that hits its time limit is stopped by killing the process tree by PID.
6. **Audit, second line.** `<data dir>/blender/audit.jsonl` (mode 0600, append only): one line per decision and one per read-only tool call (inspect, screenshot, docs, status): script hash and size, mode, agent, task, decision (blocked, denied, timeout, approved, completed, backup_failed, unavailable, refused, read), result summary, whether it timed out, and any quarantined files. The script text is not stored; secrets are scrubbed.
   - **What the chain is.** Each line carries a hash of the previous line (`chain`). It is **unkeyed**: it catches an edit or deletion in the middle of the file and accidental damage. It does not catch a cut-off tail by itself, and anyone who can write the file can recompute the whole chain.
   - **Head anchor.** The newest chain value and the line count are also kept in `audit.jsonl.head` (rewritten atomically after each line, like the BSV audit's head). The status view compares the two: a cut-off tail or a replaced shorter log shows as a mismatch, a missing anchor is flagged. A same-user program that rewrites BOTH files consistently is not detected; nothing keyless on the same disk can.
   - Failed writes are counted and shown in the status view.

Everything Blender prints is outside text: it is wrapped, capped, scrubbed of live secrets, and the run is marked **tainted** (so shared notes it writes wait in the Inbox). The Sculptor is the only agent with the server; other agents cannot reach it, and Legion adds `mcp__blender`, `mcp__blender-mcp`, `mcp__blender_mcp`, `mcp__claude_ai_Blender` and any server you configured whose name or command mentions Blender to every agent's disallowed tools while the bridge is on, so the raw execute tool of a Blender MCP you installed yourself cannot bypass the card. Only those names (and config-defined servers that look like Blender) are covered; a connector with an unrelated name is not.

### Limits, stated plainly

- **The check is a filter, not a sandbox.** It cannot stop a script that wrecks the open scene, loops forever or uses all memory, and it cannot know every Blender API that evaluates a string. The card, the backup and the sandbox exist because of that. Read a LIVE script before you allow it.
- **Live Blender runs with your user's rights.** An approved script that got past the check runs as you. Prefer the cloud VM for anything you are unsure about.
- **A local script also runs as you.** The write and network guards in Legion's own runner narrow what the script's Python code can do by accident; they are Python-level only, they are not a sandbox, and there is no CPU or memory cap. Task folders are kept until you delete them (`<data dir>/blender/local/`), and an orphaned `blender.exe` after a crash of Legion is possible: end it by its PID in Task Manager.
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

`config.json` key `blender`: `enabled` (false), `backend` (`auto`, `official`, `community`), `host` (loopback only; anything else is replaced by 127.0.0.1), `port` (default 9876), `installPath`, `mode` (`auto`, `local`, `vm`, `live`; absent until you save a choice), `sandbox` (the old key: read when `mode` is absent, and written alongside `mode` so an older Legion still opens the file: `auto` and `local` become `auto`, `vm` stays, `live` becomes `off`, which is only the old name of live), `entry` (written by Set up) and `advanced` (everything below). The settings page only changes enabled, backend, mode, port and install path; `advanced` and `entry` are edited by hand.

`advanced.official`: `sourceUrl` (default: the v1.0.3 tag), `sha256` (default: its pinned hash; an explicitly empty string means "no pin: trust on first use, re-trust on change"), `command`, `args` (with `{serverDir}`, `{host}`, `{port}`; default `run --project {serverDir}/mcp blender-mcp`), `env` (default `BLENDER_MCP_HOST` and `BLENDER_MCP_PORT`), `addonPath` (inside the archive; default `addon/blender_mcp_addon`), `tools` (names of the server's exec, inspect, object-info, screenshot and docs tools and the argument that carries the code; defaults are the v1.0.3 names `execute_blender_code`, `get_objects_summary`, `get_object_detail_summary`, `get_screenshot_of_window_as_image`, `search_api_docs`). The no-approval tools (inspect, object info, screenshot, docs) are matched by EXACT configured name, or by the server's own `readOnlyHint`; the exec tool is excluded from them, and an inspect call is never given an argument that looks like code (`code`, `script`). `advanced.community`: `addonUrl`, `sha256`, `commands` (names in the socket protocol), `startExpr`. `advanced.local`: `timeoutSeconds` (120, 10 to 900), `maxTaskBytes` (500 MB), `maxOutputBytes` (4 MB), `extraWriteDirs` (none), `guard` (`block` or `log`), `args`. `advanced.vm`: `blenderUrl` (where headless Blender is downloaded inside the VM), `blenderBin`, `timeoutSeconds`, `runCommand` (with `{blender}`, `{runner}`, `{workdir}`).

HTTP (admin only): `GET /api/blender` (`?refresh=1` to detect again), `POST /api/blender/config`, `/setup` (`{target: live|sandbox|both, retrust?: boolean}`), `/test`, `/launch`. Status changes are pushed as `blender.status` events to admin clients only.

## Not verified yet

This was built and tested without Blender, a real boat.dev key or a network. What the tests do cover: the static check (bypass attempts), the approval, backup, audit and taint rules, both backends against in-process fake servers, setup against fake file systems and a stubbed `fetch`, the sandbox runner against real `bash` and real Python with a stub `bpy`, the HTTP routes and the real UI in a browser. What they do not cover, and what to check:

**Official backend.**
- The defaults (v1.0.3 archive, its sha256, the tool names, `uv run --project {serverDir}/mcp blender-mcp`, the environment variables) were taken from the real archive and its source, but the server was never started against a real Blender 5.1 here.
- **The extension install path is implemented, not yet run on a real Blender.** The official add-on is an extension (`blender_manifest.toml`), so Set up runs `extension build`, `repo-list` or `repo-add`, `install-file --enable` and `extension list`. Not yet tried: the local repository id (expected `user_default`, read from the output), that `--enable` persists for a later GUI start, that `install-file` accepts the zip from `build` on 5.1, that `--factory-startup` before `--command` is accepted, and the output format of `repo-list` and `list`. Needs Blender 5.1+ and `uv` on the owner's PC; if a step fails, use Blender, Edit, Preferences, Get Extensions, Install from Disk.
- Whether `uv lock` and the first start's dependency download work behind your network.
- At connect time Legion matches tools by exact configured name or `readOnlyHint` and by pattern, and refuses to connect if it finds no execute tool. The patterns skip command-line (`_for_cli`) variants on purpose.

**Community backend.**
- The JSON socket protocol (`{"type": ..., "params": ...}`, `{"status": ..., "result": ...}`) and the command names, taken from the public add-on; the upstream project may have been renamed or changed.
- `startExpr` (`bpy.ops.blendermcp.start_server()`) to open the socket without a click. Note that the static check refuses `bpy.ops.blendermcp.*` for agents; `startExpr` is Legion's own fixed expression, run when YOU press Launch.
- The pinned commit and sha256 (see above) are **not yet reproduced on the owner's PC** (TODO OWNER PC). The new add-on file is much larger than the one this backend was written against (270,889 bytes, protocol 13); its command names were looked up in the source but never run against a real Blender.

**Sandbox, on a real boat.dev VM** (run these once, with a key):
1. Settings, Blender, Set up: does Blender 5.1 for Linux download, unpack and start in the VM image (`blender --version`)? Headless Blender needs shared libraries (libGL, libXi, libXxf86vm, libXfixes, libXrender); the step says what failed.
2. Ask the Sculptor for a cube and a GLB export: does the file come back to `<workspace>/blender-exports/<task>/`? Does boat's file API return the binary file correctly as base64?
3. `blender_screenshot` in the sandbox: does a Cycles CPU preview (8 samples) render within the timeout, and how long does it take?
4. Is the 600 second command limit enough, and what happens at the timeout?
5. Do two tasks keep separate `scene.blend` files, and does a second script in a task see the first one's result?

**Local mode, on a real Blender on Windows (not yet tried).** Nothing in local mode has run against a real `blender.exe`: the tests use a stub `bpy` and a fake Blender program. To check on the PC (see `claude/tracker-pc-checks.md`): detection and the "Next script runs" hint; a cube exported as GLB, FBX and a PNG preview (this is also the check that the Python write guard does not break the exporters); a write outside the task folder is blocked; an infinite loop is stopped at the time limit and no `blender.exe` is left in Task Manager; the environment holds no Legion or API variables; no user add-on opens a socket on 9876 during a local run; paths with a space or a OneDrive-redirected Documents folder; switching the mode to VM and Live gives the errors in the table above; an old config file with `"sandbox":"off"` loads as live. Antivirus or SmartScreen prompts on the first start of the runner are noted, not handled.

**Managed Blender download, on a real PC.** The download, the sha256 comparison, the unpack of the real 386 MB zip with Legion's zip reader (time, memory, antivirus on the unpacked files), `blender.exe --version` from the managed folder, a local run through it, and the approval card appearing in Settings and in the Sculptor's chat have not run against the real file. The tests use a fake download of a small zip built in the test. See `claude/tracker-pc-checks.md` (B12 to B16). The address is also unconfirmed by a request (see the pin table).

**Windows.** Detection of the Program Files, Steam and registry paths, `reg query`, `tar -xf` on a `.zip`, starting Blender detached, and the add-on install into the user's Blender folder have not been run on Windows. The detection logic is tested with injected file systems.

**Not fixable from Legion's side.** The add-on socket has no password (see the limit above); the audit chain is unkeyed; a link swapped between a check and a write can win a race.

**Other.** The size of a script the card can show comfortably; DNS rebinding on a download host (the address is checked, the resolved IP is not).

## Files

`src/core/blender/`: `static-check.ts` (the filter), `guard.ts` (the tool server and the steps above), `audit.ts` (chain plus head anchor), `fs-safe.ts` (no-follow file helpers), `backend.ts` plus `backends/community.ts` and `backends/official.ts`, `sandbox.ts` (VM runner), `local.ts` (the local runner), `exports.ts` (export copy-back rules shared by both runners), `ports.ts` (the runner and process interfaces), `detect.ts` (pure detection, prefers the managed copy), `both.ts` (both-backends mode: ports, identity, merged list), `assets.ts` (Poly Haven fetch, plan and import script), `get-blender.ts` (the managed download, pure over ports), `zip.ts` (the strict zip reader), `setup.ts` and `system.ts` (setup logic and the only real side effects), `state.ts` (config and setup record), `index.ts` (the module, routes and status). Shared contract: `src/shared/blender.ts`. UI: `ui/src/blender/` and the Blender section of Settings. Tests: `test/blender-*.test.ts`.
