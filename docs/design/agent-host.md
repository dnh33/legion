# Agent host: running Hermes in Legion

An agent host is a program that runs an agent for Legion over the Agent Client Protocol (ACP). Hermes is the one Legion ships a setup for. It is optional: Claude agents work without it, and nothing in Legion starts it unless you ask.

This note says what runs where, what Legion can and cannot see, which settings change that, and where the limits are. The code is in `src/core/acp/` and, for the run itself, in `runAcp` in `src/core/engine.ts`. The window parts are in `ui/src/settings/AgentHostsSection.tsx`, `ui/src/components/AcpCard.tsx` and `ui/src/components/AcpFirstUse.tsx`. The words the window uses are in `src/shared/acp-copy.ts`.

## In short

- Hermes keeps its own tools, its own model, its own sign-in and its own approvals. By default Legion passes Hermes's questions to you as cards, with Hermes's own buttons, and passes your answer back unchanged.
- Legion cannot stop a Hermes read, a web fetch or a command that Hermes does not ask about. Hermes's own approvals setting decides what it asks.
- Four switches, all off, let Legion do more. Turning one to the looser side asks you to confirm first.
- "Contained" runs Hermes in a Hermes profile named `legion` that Legion sets up and checks. It is not a sandbox.
- Legion's own tools reach Hermes through a key made for that one run. It works only on your computer and ends with the run.

## What runs where

- Legion starts `hermes acp` for each run. It finds `hermes` on your PATH only, never in a project folder, and talks to it over stdin and stdout. When the run ends, Legion closes stdin and stops that one process.
- `hermes acp` is the front end to Hermes's own background service for the profile in use. Legion does not start or stop that service. It can still be running after a Legion run ends, and Legion leaves it alone on purpose.
- At the next start of Legion's core, a leftover `hermes acp` process from a core that crashed is ended. Legion lists the processes it starts in `acp-pids.json` in the data folder, and it ends one only when its start time, its program, its command line and a missing parent all match.
- Hermes does the work with its own tools, in the agent's folder, with your rights. Legion tells Hermes it offers no file or terminal access of its own (the `initialize` message lists no such capability), so Hermes uses its own.
- A Hermes agent has the model value `acp:hermes`. It uses the model you set in Hermes.
- Follow-ups continue the same Hermes conversation. If Hermes no longer has it, Legion starts a new one and says so in the thread.
- Next to Claude and the providers, Hermes is a third kind of run. A Hermes run never falls back to Claude or to a provider. If Hermes cannot start, the task ends with a plain error.

### When Legion starts Hermes

Legion does not start Hermes just because it is installed.

- The model list only looks for `hermes` on your PATH. That is a file lookup, not a process.
- At startup Legion checks Hermes only when one of your agents uses it.
- A Hermes run starts Hermes. When an agent uses Hermes, the run start runs the full check (kept for 10 minutes); otherwise Legion reads only Hermes's two waiting settings alongside it.
- Opening the Doctor, pressing Re-run checks in it, or opening Settings, Agent hosts, runs the full check (a few short Hermes commands and one handshake).
- Set up and Check for the Contained profile run Hermes commands too.

A check that has run is kept for 10 minutes.

## What Legion can and cannot see

Legion sees:

- the answer text, the plan and the token counts Hermes reports;
- the tool calls Hermes reports, which it shows as rows in the thread;
- every permission request Hermes sends. A request for a command carries the command, and Legion shows it on the card.

Legion cannot:

- stop a read, a web fetch or a command that Hermes does not ask about;
- see what Hermes does inside its own background service;
- change what Hermes asks. Hermes's own `approvals.mode` setting decides that. Hermes ships with `smart`, where Hermes lets its own AI approve some commands before you see them. With `off` it asks about nothing. The Doctor shows the setting: amber for `smart`, red for `off`, with the command that sets it to `manual`. Until an agent uses Hermes (or Contained is on), the Doctor shows its rows as plain information, not amber or red, and they are not counted in the Doctor footer or the title bar.

This is the main limit for a solo builder. A Hermes agent acts on your computer with its own tools. Legion shows the questions Hermes asks and the calls it reports, and nothing more.

Every Hermes run is marked as touched by outside content ("tainted") from its first moment, because Hermes reads the web and runs commands where Legion cannot see. A tainted run's shared notes wait in the Inbox, and a BSV spend needs one more confirmation (see `SECURITY.md`).

## Questions from Hermes: the cards

By default Legion passes Hermes's own permission options through unchanged. The card shows the exact command, path or change, then one button per option, named as Hermes named it. Legion does not change Hermes's mode and does not remember an answer.

A card also carries a line such as "This touches Legion's own settings" when a request names Legion's data folder or one of its settings files, or a line about Hermes's own settings when it names Hermes's folder. This is a note on the card. The question is still yours to answer.

### The four switches

All four are in Settings, Agent hosts, under "In between". All are off until you turn them on.

| Switch | What it does when on |
|---|---|
| Stop disaster commands | Legion refuses a command that could wipe a drive or your home folder, or that works on Legion's own settings folder, before you are asked. It sends Hermes its own "reject" option and writes a line in the thread. It reads only commands Hermes asks about. |
| Match Legion's mode | Legion sets Hermes's mode when it opens the session, from the mode of the Legion agent: Full and Bypass give `dont_ask`, Accept edits gives `accept_edits`, and Ask, Smart and the other modes give `default`. With the switch off, Hermes decides what to ask you and the Legion mode does not apply to a Hermes agent. The agent editor then shows a fixed line instead of a mode picker. |
| Ignore Hermes's skip-approval settings | Legion starts Hermes without five environment variables that make it skip checks: `HERMES_YOLO_MODE`, `HERMES_IGNORE_RULES`, `HERMES_SAFE_MODE`, `HERMES_IGNORE_USER_CONFIG` and `HERMES_ACCEPT_HOOKS`. It does not change Hermes's own settings file. |
| Answer each request once | Legion hides Hermes's "allow for the session" and "always" options, so every request needs its own answer. |

A change that lets Hermes ask less needs the confirmation dialog of the Legion app: turning on Match Legion's mode, or turning one of the other three back off. A change to the stricter side saves at once. Without the app window (a plain browser tab), a loosening is refused by the core itself.

### Block rules

Your Block rules (Settings, Gates) apply to Hermes in every mode and whatever the four switches say. A Hermes request that a Block rule matches, as a command or as a path of an edit (every file of a multi-file patch counts), is answered with Hermes's reject option and no card, and the thread says so. Ask and Allow rules never answer for Hermes. If a rule cannot be checked, the request is refused.

### If Legion restarts during a run

Legion stops only its own `hermes acp` process. Hermes may keep working on the last turn in its own background service, and Legion cannot stop it. A task that was running when Legion restarted says so, and Continue explains plainly if Hermes is still busy.

### Bypass with Match Legion's mode on

When Match Legion's mode is on, and the agent is in Bypass (Full mode, no outside limit, and the tool-cards check in the gates turned off), Legion answers "allow once" for a Hermes request without a card. Some requests still get a card:

- a request that names Legion's protected files or folders, or Hermes's own folder;
- a request whose files Legion cannot read safely;
- a command Legion cannot judge, when "Stop disaster commands" is also on.

The path checks fold the Windows spellings of a path (trailing dots and spaces, long-path and device forms) before they compare it with the protected folders. `~` and a relative path are read the way Hermes reads them, and a home folder set by `HERMES_HOME` is expanded the way Hermes expands it (`~`, `$VAR`, `%VAR%`).

An agent entry that is not tested with Legion never runs Full or Bypass.

### How long a card stays

Hermes denies a request nobody answers. The wait is Hermes's own `approvals.timeout`, 5 minutes unless you changed it. Legion reads that setting when it checks Hermes and when a Hermes run starts. Until it has the value, it uses 5 minutes.

The card shows the time left. When the time ends, the card stays in the thread, closed, with "The agent stopped waiting". An answer after that is not sent, and the card says nothing was run. When you cancel a run, open requests are answered with "cancelled", which Hermes does not count as a no.

## Contained

Contained is an option in Settings, Agent hosts. When it is on, Legion starts Hermes as `hermes -p legion acp`: a Hermes profile named `legion`, apart from your own Hermes home.

Set up creates the profile when it is missing. It makes a fresh profile (never a copy of yours, no `--clone`) and sets three things:

- `approvals.mode` to `manual`, so Hermes asks before commands it marks as dangerous (it runs the others without asking);
- `platform_toolsets.acp` to the file tools, so the tool list for Legion runs is the file tools plus Legion's own tools (Hermes adds the tools a session brings);
- `auth.adopt_external_logins` to `false`, so Hermes does not borrow your Claude Code login or one other coding tool's login.

Then it reads all three back, and reads `command_allowlist` (the commands Hermes runs without asking), which must be empty or unset. Legion never clears that list; the text names the Hermes command that does. Check reads them back without changing anything, and the Doctor has a row for the profile. If the profile already exists, Set up keeps it and only sets these three values. Every Contained run reads the four again when it starts (one read a minute at most, shared with Check), and a run does not start if they differ.

What Contained does not do:

- It does not stop Hermes from reading any file your account can read, Legion's data folder included. Legion cannot see those reads and there is no card for them.

- It is not a sandbox. Hermes still runs commands you approve, with your rights.
- It may use your main Hermes sign-in. Hermes lets a named profile fall back on it. Contained isolates Hermes's settings, tools and approvals, not the provider account.
- Some other sign-ins can still be picked up by Hermes. The setting covers the Claude Code login and one other coding tool's login, not every source.
- Tools, servers or plugins you add to the `legion` profile yourself are not checked.
- A new profile gets a copy of the model setting of the profile that was active when it was made. If your own Hermes model settings hold an API key written straight into the config file, that key can travel into the new profile. A key kept in an environment variable or an `.env` file does not.

You sign the profile in once, in a terminal. Legion shows the command, `hermes -p legion setup model`, and never handles a provider key. Legion checks the profile with Set up, Check and the Doctor. Press Check after you change the profile yourself.

### Your own Hermes and the Claude Code login

Hermes borrows your Claude Code login by default (`auth.adopt_external_logins` is true). The two programs then share one rotating token, and whichever refreshes first can log the other out. For your own Hermes (not Contained), the Doctor shows an amber row with the command that turns it off: `hermes config set auth.adopt_external_logins false`. Legion never changes your Hermes settings itself.

## Legion's tools for a Hermes agent

When Legion starts a Hermes run, it hands Hermes a small helper program (`src/bin/legion-acp-tools-stdio.ts`) as a tool server for that session. The helper reaches the core through a run key.

- The key is 32 random bytes, made for one run and bound to that task and that agent. It is not the MCP token and not the admin secret, and neither of those opens the route it opens.
- It opens one thing: `/mcp/run/legion` on `127.0.0.1`. The helper refuses any other address before it sends the key. The key travels in the helper's environment and in an `Authorization` header, never in a command line or an address.
- It serves a short allow list: `agents`, `ask`, `tell`, `task_result`, `ask_user_question`, and the room tools (`bot_list`, `bot_send`, `room_post`, `room_read`, `room_list`, `handoff`, `room_create`, `room_add_member`, `room_remove_member`). Shell, file, web, VM, BSV and browser tools are not on it. A tool added to a server later is not served until it is named.
- Every call goes through the same approval steps as a call by an agent on a model provider. A call that needs your answer, such as a room change, waits for it.
- Hermes holds the key for the run. The key ends when the run ends, is cancelled, fails to start, or the core shuts down. After that it opens nothing, and calls that are still waiting are cut.
- Only entries Legion has tested get these tools. A custom agent host entry (config file only) gets none and never runs Full.
- Hermes cuts a tool call after 5 minutes by default (its `timeouts.mcp.tool_call`; this comes from Hermes's source and has not been confirmed against a running Hermes). Legion lets an `ask` wait 270 seconds at most and describes `tell` and `task_result` for longer work. A card raised inside a tool call closes at about the same deadline.

## Runs that start other runs

- A Hermes agent that starts work through `ask` or `tell` is held at the Ask level and marked tainted, whatever mode the Hermes agent has.
- When another agent, a room or an outside app asks a Hermes agent to work, and that caller is capped below Full or tainted, a card asks you before Hermes starts. This card comes in every mode, Full included.

## Environment

Legion cleans the environment it gives Hermes exactly as it does for a Claude agent. Variables with names or values that look like keys, tokens or passwords are held back, and so are variables that make a program load other code (such as `PYTHONPATH`). Legion's own settings and secrets are always held back, also when your keep list names them. Names on your keep list ("Variables commands may keep", in Settings, Gates, Fine tuning) pass through. A project that turns off "Keep keys and passwords out of commands" turns off the key and password cleaning for Hermes runs there too. Legion's own secrets are still held back.

Hermes reads its provider keys from its own home. If you keep the key only in an environment variable, add the variable's name to the keep list. When Hermes starts but cannot sign in under Legion, the Doctor says so.

## The folder

A Hermes agent needs a folder of its own. It cannot work in or above Legion's data folder, or inside Hermes's own folder (its home). The default workspace sits inside the data folder, so a Hermes agent with no project and no folder of its own is refused with a plain message. In a project, the project's folder is used. The agent editor asks for a folder when you pick Hermes.

## The watchdog

Settings, Agent hosts, "Watchdog minutes" (1 to 120, default 10). If Hermes sends nothing for that long, Legion asks it to cancel, waits up to 10 seconds, ends the task with "Hermes stopped answering, so Legion stopped this task", and stops its Hermes process. A request that waits for your answer pauses the clock, for about 5 minutes at most. The watchdog is always on.

## Cost and limits

- Hermes reports token counts but never a cost. The thread shows the tokens and says "Hermes does not report cost."
- You can enter prices (US dollars per million input tokens and per million output tokens). Then Legion shows a cost, and counts it in its spend record. With no prices there is no cost, and nothing is counted in that record.
- You can set two optional limits: `maxSteps` (a step is one tool call Hermes makes with its own tools, 1 to 10000; calls to Legion's own tools do not count) and `maxTokensPerTask` (1000 to 100000000). A task over `maxSteps` is cancelled. The token limit is checked when a turn ends, so one turn can go past it. Either stop pauses the task with the work kept, and Continue picks it up.
- There are no Settings fields for these yet. Add these keys to your existing `hermes` entry in the `acp` block of `config.json` (do not paste over the whole block, which would reset the switches and Contained), then restart Legion:

```json
"acp": { "entries": [ { "id": "hermes", "maxSteps": 100, "maxTokensPerTask": 500000 } ] }
```

  Prices go in the same entry as `"prices": { "inputPerMTok": ..., "outputPerMTok": ... }`.

The `acp` block of `config.json` also holds the four switches, `watchdogMinutes`, whether the first-use card was met, and whether Hermes is offered at all (`enabled`) and Contained (`contained`) on the `hermes` entry. Other agent hosts can be listed there too. They are untested, get none of Legion's tools and never run Full. Settings does not edit them.

## What you see

- The first time you pick Hermes for an agent, a card says what Hermes does and offers "Use Hermes" or "Not now". Not now leaves the agent as it was.
- A Hermes thread carries a badge: "Hermes · acts on your computer".
- The Doctor lists Hermes: found, starts, its version, its approvals mode, whether it shares the Claude Code login, the Contained profile and, after a failed sign-in, a sign-in row. "Hermes is not installed" is a neutral row, not a failure.
- Legion works with Hermes 0.22.3 or newer. The Doctor shows an older Hermes in red, and a newer one than Legion was tested with as an amber note. Legion never updates Hermes and never runs `hermes --version`, which checks for updates. It reads the version from Hermes's start message.
- Windows first. macOS and Linux are experimental, like the rest of Legion.

## Status

The automated tests run Legion against a stand-in agent that speaks ACP. They have not yet been run against a real Hermes, and the version limits above come from reading Hermes's source. A check against a real Hermes comes before this is called tested.

## Where the code is

| What | Where |
|---|---|
| Settings types, defaults, limits | `src/shared/acp-view.ts`, `src/shared/config.ts` |
| Window words | `src/shared/acp-copy.ts` |
| Start, stop and clean up Hermes | `src/core/acp/process.ts` |
| Message layer and one session (watchdog, usage) | `src/core/acp/rpc.ts`, `src/core/acp/session.ts` |
| Reading Hermes's requests and tool calls | `src/core/acp/map.ts` |
| Detection and versions | `src/core/acp/detect.ts` |
| Contained profile | `src/core/acp/contained.ts` |
| Doctor rows | `src/core/acp/doctor-rows.ts` |
| The run key and Legion's tools for Hermes | `src/core/acp/run-tokens.ts`, `src/core/acp/run-tools.ts`, `src/bin/legion-acp-tools-stdio.ts` |
| The run: folder rule, cards, switches, limits | `runAcp` and the `acp*` methods in `src/core/engine.ts` |
| Card timing | `src/core/approvals.ts` (`requestAcp`) |
