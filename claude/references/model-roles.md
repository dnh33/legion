# Model roles (Legion 0.2.0)

The owner's model map for Legion's provider runs, decided 2026-10-03. Legion has no separate
"role" schema: a role is realised by the value of an agent's `model` field (`ModelChoice` is a
free string), so an agent runs a role when its model names the provider and the model id,
`openrouter:<model id>`. These are the two picks that ship in the OpenRouter preset.

| Role | Model (OpenRouter id) | Owner's short name | Use |
|---|---|---|---|
| Non-GUI reasoning | `deepseek/deepseek-v4.1-flash` | deepseek-v4.1-flash | text, planning and analysis; it does not drive a screen |
| GUI / computer-use | `google/gemini-3.8-flash` | gemini-3.8-flash | drives the computer-use / screen test loop |

Correction (owner, same night): deepseek-v4.1-flash FAILED as a computer-use/GUI seat. It stays
for non-GUI reasoning only; gemini-3.8-flash drives the computer-use/GUI loop.

How it is wired in Legion:

- `src/core/providers/presets.ts`: the `openrouter` preset ships `enabled: true` with both model
  ids in `models`. `ProviderRuntime.view()` returns them, and the UI's `providerModelGroups()`
  offers them to the model pickers as `openrouter:<model id>`.
- The run mechanism is the existing provider seam, unchanged: `agent.model` set to a
  `openrouter:<model id>` value reaches the engine, which resolves it through
  `ProviderRuntime.resolve()` and runs the OpenAI-compatible endpoint. See
  `claude/plan-providers.md` and `test/providers-presets.test.ts`.
- The preset model ids carry an OpenRouter vendor prefix (`deepseek/`, `google/`) because
  OpenRouter ids are `vendor/model`. They are suggestions the owner can replace with
  "Refresh models"; the owner's short names are kept in the table above.
- The provider key is typed by the owner at runtime (Settings, Providers). It never lives in the
  repository.

The computer-use skill's own copy of this map (`references/model-roles.md` in the
`hermes-computer-use` package) carries the driving rules (step list, never-click list, call
budget). This file records only the provider model map that ships with Legion.
