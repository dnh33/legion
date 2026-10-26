# Security policy

## Report a problem

Please do not open a public issue for a security problem. Use GitHub's private reporting instead:

1. Open the **Security** tab of [dnh33/legion](https://github.com/dnh33/legion/security/advisories/new).
2. Choose **Report a vulnerability**.
3. Say what you found, how to reproduce it and what it could do.

Never put real keys or tokens in a report. Replies are best effort. We aim to acknowledge a report within a few days.

In scope: a way past the local access checks, a way to reach Legion from a web page, a secret in a log or an API answer, and a way past an approval card.

## Supported versions

Only the latest release gets security fixes. Update to the latest release before you report.

## What Legion protects

These claims are about Legion's own code.

- **Local only.** The core listens on `127.0.0.1` only. Do not proxy it to other machines. Legion is a personal tool, not a shared service.
- **Two secrets.** The MCP token in `config.json` lets Claude Code and Cowork start, read and cancel tasks. It cannot approve a card, change settings or loosen BSV limits. The admin secret is made fresh at each launch and lives in memory only. Only the Legion window sends it. Every route outside a short list needs it.
- **Approval cards.** A bot cannot answer its own card. Only the Legion window can.
- **Task limits.** A task started over MCP runs under the `ask` ceiling. A task that one bot starts for another is never looser than the first bot.
- **Bot-made rooms.** A bot needs a card you answer to create a room or change its members.
- **Outside content.** Web pages, GitHub text, outside tools and imported notes are marked as untrusted. A run that read such content is marked ("tainted" in the code). Its shared notes wait in the Inbox, it cannot assign or delete board items or write working memory, and a BSV spend needs one more confirmation. What marks a run: the web, outside tools, GitHub text, a shell command that reaches the network or that Legion cannot read with certainty, code run from a command line (`node -e`), a file outside the project or in third-party code (`node_modules`, `vendor`) or in a cloned repository, and a test or build run while a marked run left files in the project. Local commands in your project (`git status`, a search, `git commit`, a test run) do not mark a run. Settings, Gates, Outside text switches this to Strict (every shell command marks the run, as in 0.3.8) or turns off the file rule. Limits: Legion judges the command you typed, not what a project script does inside, so a script that fetches a web page does not mark the run (use Strict in a repository you do not trust); a file that a marked run wrote with a shell command is not tracked; the mark is per run and passes to helpers and room peers.
- **Doctrine.** Settings, Doctrine shows the rules and skills your agents follow. Every file has a switch. The core tenets are locked on. The six optional skills are off by default. Legion ships skills as text and does not run scripts from them.
- **Armory skills.** Settings, Armory lists every skill your agents could load, including skills inherited from your Claude Code setup. All of them are off by default. Each run gets an explicit list of allowed skills, and Legion's own code refuses a skill outside that list, also for subagents. Skills from outside Legion (Claude Code, imports) mark the run as tainted when they load.
- **Skill shell commands.** A skill can contain shell lines that run when it loads. Legion asks Claude Code to disable them by default. Turning them on is a setting you confirm.
- **Updates.** Legion's own update code accepts a release only if the Ed25519 signature on its manifest matches a key built into the app. It then checks the package size and SHA-256. It downloads from GitHub hosts over HTTPS only, and only after you click Update, unless you turn on automatic updates.
- **Installers.** The one-line Windows installer downloads the release zip from GitHub over HTTPS. It checks the SHA-256 before it unpacks anything. On macOS and Linux the installer builds from source.
- **MCP isolation.** By default, MCP servers and connectors from your own Claude Code setup are not loaded into agents (`claude.inheritMcp` is off). This is a request Legion's own code makes of Claude Code. It is not a sandbox.
- **Provider agents.** An agent on an OpenAI-compatible provider has no Claude Code tools. It gets only Legion's own tools, and approvals still apply. Provider keys are stored apart from `config.json`.
- **Claude agents and Claude's own checks.** By default (Settings, Gates, on unless you turn it off) a Claude agent follows Claude Code's own permission checks in every preset: Claude decides about its own tools, and whatever it is unsure about comes to you as a Legion card. Legion's own code still applies your Block rules, a stop for commands that could wipe a drive or your home folder (also for long or padded commands), protection of Legion's own files, folder trust, and the cards of Legion's own tools. A Legion Allow rule does not answer Claude's questions. If Legion cannot trust its settings file, the switch stays off.
- **Hermes agents (optional).** Hermes runs its own tools on your computer, so this list is short and the limits below are long.
  - Legion finds `hermes` on your PATH only, never in a project folder. It cleans Hermes's environment the way it cleans a Claude agent's: names and values that look like keys, tokens or passwords are held back, and so are Legion's own secrets. Names on your keep list pass.
  - A Hermes agent does not work in or above Legion's data folder, in or above Hermes's own folder, or in or above the folders Legion protects.
  - Legion's own tools reach Hermes through a run key. It is random, made for one run, bound to one task and agent, and good only for one route on `127.0.0.1`. It serves a short list of Legion tools (agents, ask, tell, task results, questions to you and the room tools) and not a shell, files or the web. It ends when the run ends.
  - A Hermes run is marked tainted from its start. A run that a Hermes agent starts through ask or tell is held at the `ask` level. When a capped or tainted caller asks a Hermes agent to work, a card asks you first, in every mode.
  - By default Legion passes Hermes's own questions to you as cards, with Hermes's own buttons, and changes none of Hermes's settings. Four switches (stop disaster commands, match Legion's mode, ignore Hermes's skip-approval settings, answer each request once) are off by default. A change that lets Hermes ask less needs Legion's confirm card.
- **Window.** The Electron window is sandboxed, with context isolation and no Node integration.
- **Confirm card.** A question that changes a setting or moves money (provider keys, gates, folder trust, agent modes, project folders, the browser tool, GitHub connect, BSV) is asked by Legion's confirm card, shown inside Legion: a view of its own that Legion's main process lays over the whole Legion window, with the app dimmed behind it. It is not a separate window. The Legion page cannot fake one or answer one: the card is isolated from the page (its own session, no preload, no network), the words come from main, and main takes an answer only from the card's own contents and only with a one-time id made for that question. While it is open, the app behind it gets no mouse and no keys. If the card cannot be shown, the same question goes to the system dialog. It never answers yes by itself.

## BSV mode (testing preview)

- Legion's own code holds no key and signs nothing itself. It has one spend tool that asks a wallet on this computer to pay.
- Each spend needs your confirmation in Legion's confirm card (or the system dialog if it cannot open). Default caps are small, and the recipient list is empty.
- Spending on mainnet is off by default. Only you turn mainnet on, in the app, after a warning. Each mainnet spend needs its own arm.
- The wallet's own prompt is not always the last gate. Whether your wallet asks too depends on the wallet.
- The spend tool has been tested against fake wallets only. It is not verified against a real wallet or with real funds.
- An agent's ordinary tools, such as a shell or a web fetch, are outside these controls.

Details: [BSV mode](docs/BSV-MODE.md) and [wallet design](docs/BSV-WALLET-DESIGN.md).

## What Legion does not protect against

- **Programs that run as your OS user.** Such a program can read Legion's memory and take the admin secret. It can click Allow, edit Legion's files, read `config.json` and your Claude credentials, and call your BSV wallet directly. Only a VM or a separate OS account stops this.
- **Pressing the confirm buttons.** Any program that runs as you, including an agent command in Full or Bypass, can press buttons in any window through the operating system's accessibility interface (UI Automation on Windows). That was true of the system dialogs before, and it is true of the confirm card. The confirm card keeps the Legion page and its scripts from answering; it does not keep another program on your computer from clicking.
- **An agent with `full` approval.** `full` removes nearly every prompt for that agent: a Claude agent still gets a card for deleting the project folder, for a command too long to check and for Legion's own settings folder, and Legion's stop for disastrous commands holds. An agent with a shell or file tools can then act as you. Use `ask` or a VM for untrusted work. Do not give a shell to an agent that reads untrusted web content.
- **Keys in `config.json`.** The boat.dev key and the Claude API key (in `api-key` mode) are stored there as plain text. An agent's Read tool can read them without a card. Keep the file private.
- **The MCP token.** Treat it as a password. A holder can run your agents under the `ask` ceiling and read room text through tasks. A holder can also run a shell command in an agent's cloud VM without a Legion card.
- **Another program on the port.** A local program can take the port before Legion starts. It cannot get the admin secret. It can stop Legion from running, and it sees the MCP token.
- **Unsigned installers.** The installers and setup scripts are not code-signed. The SHA-256 check shows the file matches the release. It does not show who made it. A first install trusts the GitHub repository. Read the scripts in `scripts/install/` before you run them.
- **Updates.** A compromised signing key, a malicious build that is signed, and withheld updates are not covered. There is no remote key revocation. Details: [Updates](docs/UPDATES.md).
- **Blender.** In local mode a script runs in Blender on this computer with your Windows user's rights. Legion's check is a filter, not a sandbox. You see the full script on a card, and Legion saves a backup first. The cloud VM mode keeps scripts away from this computer. In live mode the add-on's socket has no password. Any local program can send Python to it while the add-on's server runs. Details: [Blender](docs/BLENDER.md).
- **Logs.** The logs in `<data folder>/logs` are plain text, not encrypted, and every line is redacted before it is written. A native crash (a V8 fatal error or out-of-memory) writes below Legion's wrappers and is not masked. A secret that begins after the wrappers had already written part of a single line longer than 8 KiB with no line break is masked only in part. A program running as your user can read or edit the files. Legion's own code never sends them anywhere.
- **Audit logs.** They are tamper-evident, not tamper-proof. A program running as your user can rewrite a log together with its hashes.
- **The Library.** Seed-phrase detection knows only the English BIP-39 word list. Taint follows file tools only. Details: [Library](docs/LIBRARY.md).
- **Skills are not a sandbox.** The skill list and the skill gate decide what agents are told and allowed to load. They do not limit what an agent's other tools can do. A skill you turn on can still steer the agent.
- **Servers you add.** An MCP server you add runs with your user's rights.
- **Folders you trust.** Trusting a folder lets its Claude Code hooks, settings and skills run commands with your rights. Legion holds the folder back again when those commands change, but it does not follow a CLAUDE.md import of a file inside the folder, and it does not see a hard link that points outside the folder.
- **Claude's checker.** In Smart, a Claude agent is judged by Claude's own checker. It can miss things, it does not always give the same answer for the same call, and it is not a security boundary. Legion's stop for disastrous commands, your Block rules and the guards on Legion's own files do not depend on it.
- **Smart and Bypass for other providers.** (A Claude agent gets the same Legion checks when you turn Claude's own checks off.) Smart judges each command by what it can read of it. The tests and builds an agent runs, and the code they load, can reach the web and read your files without a card, and a little data can leave in the address of a site Smart allows. Bypass asks only for protected files. Use Ask for work with web pages or repositories you do not trust.
- **Providers.** An agent on a provider sends its prompts to the server you chose.
- **Hermes agents.** A Hermes agent reads files, fetches web pages and runs commands with its own tools and your rights.
  - Legion sees the questions Hermes asks you and the tool calls it reports. It cannot stop a read, a web fetch or a command that Hermes does not ask about.
  - Hermes's own approvals setting decides what it asks. Hermes ships with `smart`, where Hermes lets its own AI approve some commands before you see them; with `off` it asks about nothing. The Doctor shows the setting: amber for `smart`, red for `off` with the command that sets it to `manual`.
  - With "Match Legion's mode" on and an agent in Bypass, Legion allows Hermes requests without a card. A request that names Legion's protected files or Hermes's own folder, or whose files Legion cannot read, still gets a card. A command Legion cannot judge gets one only while "Stop disaster commands" is on.
  - By default Hermes may borrow your Claude Code login, and the two programs can then log each other out. The Hermes setting `auth.adopt_external_logins` set to `false` stops that. The Doctor shows the command. Legion never changes your own Hermes settings.
  - Hermes can read any file your account can, Legion's data folder included, without a card, because Legion cannot see those reads. Contained does not change this.
  - Your Block rules apply to Hermes in every mode. A Hermes request that a Block rule matches (a command, or a path of an edit) is answered with Hermes's reject option and no card.
  - If Legion restarts while a Hermes task runs, the Hermes turn may keep working and Legion cannot stop it. The task says so, and Continue reports plainly if Hermes is still busy.
  - Contained (the Contained profile, a Hermes profile named `legion`) is not a sandbox. Legion's Set up, Check and the Doctor read back four of its settings: that it asks before commands it marks as dangerous (Hermes runs the others without asking), that no command is on its always-allow list, that its tool list for Legion runs is the file tools, and that it does not borrow the Claude Code login or one other coding tool's login. Every Contained run reads them again when it starts, at most once a minute, and does not start if they differ. It needs a Hermes sign-in of its own, and Check says when it has none. Tools you add to that profile yourself are not checked. If your own Hermes model settings hold an API key written into the config file, creating the profile can copy it.
  - Hermes's own background service keeps running after a run. Legion stops only its own `hermes acp` process.
  - Hermes does not report cost. Legion's spend record counts a Hermes task only when you enter its prices.

## Read more

- [Architecture](docs/ARCHITECTURE.md): the access checks, approvals and tools.
- [Updates](docs/UPDATES.md), [BSV mode](docs/BSV-MODE.md), [Blender](docs/BLENDER.md), [Library](docs/LIBRARY.md), [Rooms and comms](docs/COMMS-BRIDGE.md).
- [Doctrine and skills](docs/adr/0012-house-switches-and-shipped-skills.md).
