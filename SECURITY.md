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
- **Outside content.** Web pages, tool output and imported notes are marked as untrusted. A run that read such content is "tainted". Its shared notes wait in the Inbox, and a BSV spend needs one more confirmation.
- **Doctrine.** Settings, Doctrine shows the rules and skills your agents follow. Every file has a switch. The core tenets are locked on. The six optional skills are off by default. Legion ships skills as text and does not run scripts from them.
- **Armory skills.** Settings, Armory lists every skill your agents could load, including skills inherited from your Claude Code setup. All of them are off by default. Each run gets an explicit list of allowed skills, and Legion's own code refuses a skill outside that list, also for subagents. Skills from outside Legion (Claude Code, imports) mark the run as tainted when they load.
- **Skill shell commands.** A skill can contain shell lines that run when it loads. Legion asks Claude Code to disable them by default. Turning them on is a setting you confirm.
- **Updates.** Legion's own update code accepts a release only if the Ed25519 signature on its manifest matches a key built into the app. It then checks the package size and SHA-256. It downloads from GitHub hosts over HTTPS only, and only after you click Update, unless you turn on automatic updates.
- **Installers.** The one-line Windows installer downloads the release zip from GitHub over HTTPS. It checks the SHA-256 before it unpacks anything. On macOS and Linux the installer builds from source.
- **MCP isolation.** By default, MCP servers and connectors from your own Claude Code setup are not loaded into agents (`claude.inheritMcp` is off). This is a request Legion's own code makes of Claude Code. It is not a sandbox.
- **Provider agents.** An agent on an OpenAI-compatible provider has no Claude Code tools. It gets only Legion's own tools, and approvals still apply. Provider keys are stored apart from `config.json`.
- **Window.** The Electron window is sandboxed, with context isolation and no Node integration.

## BSV mode (testing preview)

- Legion's own code holds no key and signs nothing itself. It has one spend tool that asks a wallet on this computer to pay.
- Each spend needs your confirmation in native dialogs. Default caps are small, and the recipient list is empty.
- Spending on mainnet is off by default. Only you turn mainnet on, in the app, after a warning. Each mainnet spend needs its own arm.
- The wallet's own prompt is not always the last gate. Whether your wallet asks too depends on the wallet.
- The spend tool has been tested against fake wallets only. It is not verified against a real wallet or with real funds.
- An agent's ordinary tools, such as a shell or a web fetch, are outside these controls.

Details: [BSV mode](docs/BSV-MODE.md) and [wallet design](docs/BSV-WALLET-DESIGN.md).

## What Legion does not protect against

- **Programs that run as your OS user.** Such a program can read Legion's memory and take the admin secret. It can click Allow, edit Legion's files, read `config.json` and your Claude credentials, and call your BSV wallet directly. Only a VM or a separate OS account stops this.
- **An agent with `full` approval.** `full` removes every prompt for that agent. An agent with a shell or file tools can then act as you. Use `ask` or a VM for untrusted work. Do not give a shell to an agent that reads untrusted web content.
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
- **Providers.** An agent on a provider sends its prompts to the server you chose.

## Read more

- [Architecture](docs/ARCHITECTURE.md): the access checks, approvals and tools.
- [Updates](docs/UPDATES.md), [BSV mode](docs/BSV-MODE.md), [Blender](docs/BLENDER.md), [Library](docs/LIBRARY.md), [Rooms and comms](docs/COMMS-BRIDGE.md).
- [Doctrine and skills](docs/adr/0012-house-switches-and-shipped-skills.md).
