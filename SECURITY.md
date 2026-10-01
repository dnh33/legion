# Security policy

## Supported versions

Legion is young. Only the latest release on the default branch receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the impact you expect. You can expect an acknowledgement within a few days.

## Threat model

Legion is a personal, local tool. It is not designed to be exposed to a network or shared between users.

- **Local-only binding.** Legion Core listens on `127.0.0.1` only. Do not proxy it to other machines.
- **Bearer token.** Every API and MCP request except `GET /health` needs `Authorization: Bearer <authToken>`. The token is generated on first run and stored in `config.json` in your data directory (`~/.legion`). Treat it like a password; anyone with it can run agents as you. The SSE endpoint also accepts `?token=` because browsers cannot set headers on `EventSource`.
- **Credentials.** Legion never reads or stores your Claude account credentials. In the default mode it relies on the account Claude Code is signed in to. If you choose `api-key` mode, the key is stored in `config.json`; boat.dev API keys are too. Keep that file private.
- **Agents run code.** Approval modes (`ask`, `auto-edits`, `full`) control what an agent may do on your machine without asking. `full` disables prompts for that agent. Use VMs for untrusted work.
- **Renderer.** The Electron window is sandboxed with context isolation and no Node integration.

Reports about these boundaries (for example an authentication bypass, a way to reach the API from a web page, or a secret leaking into logs or API responses) are in scope.
