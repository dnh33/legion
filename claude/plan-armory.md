# Plan: your own drills, and the Armory (Release A2)

Status: **approved by the owner 2026-10-06** (split A2a / A2b). Further decisions, same day: inherited Claude Code skills start **off** after the update, with a one-time notice and Turn all on (announced in the changelog); Claude Code built-ins **off**, with a curated short list shown first (deep-research, verify, debug, code-review, simplify), and the ones that act on Claude Code's own config (update-config, schedule, loop, fewer-permission-prompts, doctor) kept off with a short why; **per-agent control is in A2a** (also covers drills). Builds on Release A (PR #13: Doctrine, switches, Drills). New branch off main after #13 merges.

## Owner decisions (2026-10-06, question UI)

| Question | Decision |
|---|---|
| Model | Two tiers. **Doctrine → Drills**: few, fundamental, trust-checked; users can add their own drill (needs the owner's approval, like other own files). **Armory**: the open library, with Claude Code semantics. A skill can be promoted from the Armory to a drill. |
| Name | **Armory**, plain hint always shown: "skills your agents can pick up" ("Library" is the knowledge Lattice). |
| Adding skills | Write in the app, import from disk, **and install from a URL** (GitHub, skills.sh, well-known index), with a safety review before install and pinning to a commit. |
| PR #13 | Merge it; this comes next on top. |

## The two tiers, in one line each (shown on both screens)

- **Doctrine.** How your legion must work: rules every agent follows, plus a few fundamental drills you approved.
- **Armory.** Skills agents can pick up when a task calls for one, the way Claude Code does. Many, loose, yours to add.

| | Drills (Doctrine) | Armory |
|---|---|---|
| Who curates | the owner; trust by exact bytes (approve, re-approve after edits) | anyone using this install; no approval step, a review screen on install |
| How many | a handful | dozens |
| How agents get it | house tools `house_skills` / `house_skill`, for every agent type | Claude agents: native SDK skills (agent sees name + description, loads the body when a task matches, `/name` runs it). Provider agents: equivalent `armory_skills` / `armory_skill` tools |
| Default | off | off for installed and imported skills; skills you write yourself start on |
| Taint | loading taints the run (as now) | loading taints the run (it is outside text). Today the SDK's Skill tool is in CLEAN_BUILTINS, so this needs a change (below) |

## Facts, assumptions and unknowns

| Kind | Item | Source / check |
|---|---|---|
| Fact | SDK `skills?: string[] \| 'all'`; omitted is NOT off; a context filter, not a sandbox; setting it adds Skill to allowedTools | node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2262 (SDK 0.3.285) |
| Fact | `plugins?: [{ type: 'local', path }]`; a plugin root holds `skills/<name>/SKILL.md`; `.claude-plugin/plugin.json` optional; skills are named `plugin:skill` | sdk.d.ts:2022, 5533; https://code.claude.com/docs/en/agent-sdk/plugins |
| Fact | `/name` dispatch runs a user-invocable skill even when `skills` omits it; `disable-model-invocation: true` hides the description from the model and keeps `/name`; `user-invocable: false` hides it from the `/` menu | https://code.claude.com/docs/en/agent-sdk/skills , https://code.claude.com/docs/en/skills |
| Fact | Many plugins via argv can hit Windows' 32,767-char command line; `'initialize'` load mode avoids it | sdk.d.ts:2023-2036 |
| Fact | Legion passes no `skills`/`plugins` today; `settingSources` is `['user','project','local']` only when inheriting Claude Code settings; 'Skill' is in CLEAN_BUILTINS so it never taints; canUseTool is not called in 'full' approval mode | src/core/engine.ts:102-108, 831, 834, 862-871 |
| Fact | skills.sh skill page `https://skills.sh/<owner>/<repo>/<skill>`; the CLI accepts owner/repo, GitHub/GitLab URLs, a direct SKILL.md or archive URL, and well-known discovery; repo discovery scans root, `skills/`, `.agents/skills/` up to 3 levels | https://github.com/vercel-labs/skills README |
| Fact | Well-known index: `/.well-known/agent-skills/index.json` then `/.well-known/skills/index.json`, entries {name, type, description, url, digest} | vercel-labs/skills src/providers/wellknown.ts; schema https://schemas.agentskills.io/discovery/0.2.0/schema.json |
| Fact | GitHub, no token: ref → SHA `GET api.github.com/repos/{o}/{r}/commits/{ref}` (Accept: application/vnd.github.sha); tree `GET /git/trees/{sha}?recursive=1` (check `truncated`); bytes `raw.githubusercontent.com/{o}/{r}/{sha}/{path}`; 60 API requests/hour per IP | tested live 2026-10-06 |
| Fact | Hermes has no fetchable index of its own documented; it consumes skills.sh, GitHub and the well-known format | hermes-agent docs, user-guide/features/skills |
| Unknown | Skill tool input field names; whether a Skill call reaches canUseTool in a Legion session; whether strictMcpConfig blocks plugin skills; plugin name without plugin.json | one cheap probe in the fake harness first (a scratch plugin with 2 skills, one manual-only, a logging canUseTool and stream tool_use) |
| Unknown | skills.sh `/api/search` is undocumented | used only for optional search; install never depends on it |

## What the owner gets

### Doctrine: your own drills

- **Drills → "Your drills"** sub-group, collapsed like the others, with **New drill**.
- **New drill:** an editor (name, one-line description, when to use, body in Markdown, live preview), or "Import SKILL.md".
- A new drill starts **"Not approved", off**. Approve it, and then switch it on. Any later edit drops the approval, exactly as for other own files today.
- **Promote from the Armory** copies the skill into Your drills, not approved. It never moves a third-party skill into Doctrine silently.

### Armory (new Settings section, after Doctrine)

- **Header line:** "Skills your agents can pick up when a task calls for one. They are not rules: an agent reads one only when it needs it." Next to it, a link to Doctrine.
- **Search**, plus source filters: All · Yours · Installed · Claude Code.
  - *Claude Code* means your own `~/.claude/skills`, listed read-only, and only when "Use my Claude Code settings" is on.
- **A row shows:**
  - the name, the full description and the source tag;
  - the `/command`;
  - a switch, "Agents can use";
  - a choice: "Agents decide" or "Only when I ask" (`disable-model-invocation`);
  - a ⋯ menu: Read · Edit (yours) · Update (installed) · Promote to drill · Remove (with Undo).
- **New skill** opens the same editor as New drill, writing a proper SKILL.md.
- **Add from:**
  1. **File or folder:** a SKILL.md, a folder, or a .zip.
  2. **Link:** a GitHub URL (repo, tree path or SKILL.md), a skills.sh page, `owner/repo`, or a website's well-known index.
- **Install review** (always shown before anything is written):
  - the source, the resolved commit (short SHA) and the licence (or "unknown");
  - every file, with its size;
  - flags:
    - scripts (Legion never runs them);
    - `allowed-tools`, which would pre-approve tools;
    - hidden or bidi characters;
    - network or secret patterns;
    - a size or file-count over the cap;
  - the full SKILL.md, rendered.
  - Then **Install (off)** or Cancel.
  - Installed skills land **off**, pinned to that SHA.
  - **Update** shows the diff to the new SHA and asks again.
- Empty state: "No skills yet." with three buttons: New skill, Add from file, Add from link.

## Security design (hard rules)

- **Network (updated 2026-10-06, agreed with the connectors design):** GitHub calls go through ONE tripwire-listed GitHub client owned by the GitHub connector (`src/core/connectors/github/client.ts`, optional token; anonymous for public skill installs); A2b imports it instead of adding its own GitHub fetch. Only skills.sh and owner-typed well-known hosts stay in a small `src/core/armory/fetch.ts` with its own allowlist entry. The rules below apply to both.
- **Network (original A2b wording, superseded for GitHub hosts):** one new file, `src/core/armory/fetch.ts`, gets a `fetch` entry in the tripwire allowlist with its reason.
  - Allowed hosts:
    - `api.github.com` and `raw.githubusercontent.com`;
    - `skills.sh`, only to read a page or search;
    - for a well-known index, only the exact https host the owner typed.
  - https only. Each redirect is re-checked against the allowlist.
  - Caps: 10 MB download, 25 MB unpacked, 1,000 files, 10 s per request.
  - Every ref resolves to a 40-hex SHA before any file is fetched.
  - No token; 60 requests per hour is enough, at about 3 per install.
- **Nothing executes:**
  - Legion never runs a skill's scripts.
  - `allowed-tools` in an installed skill is stripped, or a named flag requires the owner's explicit OK, so a third-party skill cannot pre-approve tools.
  - Archives are unpacked by Legion's own zip code (`blender/get` already has one, with path checks). No child process.
- **Where it lives:** `<dataDir>/armory/<id>/` as a local SDK plugin root (`skills/<name>/SKILL.md`), plus `armory.json` holding the source, the SHA, the switch, and the manual-only flag.
  - Changes go only through admin routes; no agent tool changes it.
  - Agents run as the same OS user, so they could write that folder. The same limit as ADR 0011, stated plainly.
- **Taint:**
  - Loading an Armory skill marks the run tainted, through either path.
  - For the SDK path, 'Skill' leaves CLEAN_BUILTINS and becomes "taints unless the skill is a shipped, trusted Legion drill". The probe decides how to read the skill name from the input.
  - In 'full' approval mode there is no canUseTool, so taint is set from the stream's tool_use block.
- **Agents never install:** no tool installs, enables or promotes. Install, switch, promote and remove are owner actions in Settings.

## Controlling Claude Code's skills, and per-agent access (owner request, 2026-10-06)

### What the probe measured

Probe run on 2026-10-06: Haiku, SDK 0.3.285, a scratch plugin with two skills, about $0.20 in total.

- **Allowed and asked for:** with `skills: ['probe-plugin:alpha']`, the agent loaded alpha through the `Skill` tool, input `{ "skill": "probe-plugin:alpha" }`.
- **Hook:** canUseTool was **not** called for that load, even in 'default' permission mode.
- **Manual-only:** `/probe-plugin:beta` ran beta (`disable-model-invocation`, not in the list): BETA-OK.
- **Filter is not a sandbox:** with `skills: []` the agent could not use alpha as a skill and went to Read the file instead.
- **Inheritance today:**
  - With `settingSources: ['user']` the session lists **338 skills from 22 plugins** of the owner's Claude Code (MCP plugins such as context7 and playwright among them).
  - Even with `settingSources: []`, about **20 Claude Code built-in skills** are listed (deep-research, design, slides, loop, schedule, update-config, …).
  - **Legion passes no `skills` list today, so every agent gets all of them.**

### Design

1. **Every Claude run gets an explicit `skills` list.**
   - The list is the skills enabled in Legion, for that agent.
   - It is never omitted (omitted means "everything"), and `[]` when none are on.
   - A skill not on the list is hidden from the agent and refused by the Skill tool. That is a context filter, not a sandbox; stated as such.
2. **Armory, Claude Code source.** Grouped by origin, each group with a group switch plus per-skill switches. The groups:
   - **Your Claude Code skills** (`~/.claude/skills`);
   - **each Claude Code plugin** by name (22 here);
   - **Claude Code built-ins.**
   
   The list comes from reading the folders and plugin manifests on disk, no model call. The first real run's init message confirms it, and the screen flags any mismatch.
3. **Three states per skill:**
   - **On:** the agent decides, from the description.
   - **Only when I ask:** not on the list, so `/name` still runs it.
   - **Off:** not on the list, and Legion's chat does not offer or send `/name`.
4. **Per agent.** Each agent profile gets `skills: 'inherit' | string[]`, modelled on its MCP server list.
   - **Agent editor → Skills:** "Same as the Armory" (default), or a chosen set, with search and groups.
   - **Armory row:** "Agents: All ▾" opens the same choice from the skill's side.
   - **Effective skills** per agent: "Builder will see 7 skills: 3 Armory, 2 drills, 2 Claude Code". Each agent's card links to it, so what an agent really gets is visible in one place.
5. **Taint by source**, read from the Skill input `skill` name in the stream, since canUseTool never sees it:
   - Armory installs and plugin-marketplace skills taint.
   - Your own `~/.claude/skills`, Legion drills you approved, and the Claude Code built-ins do not taint.
6. **Context cost shown:** each group shows its count, and Settings warns when an agent would get more than about 40 skill descriptions. 338 descriptions is a large slice of every prompt.

## Owner decisions after approval (2026-10-06)

- **A2b (install from a link) is parked** on the task ladder after the scope lock. A2a then Release B.
- **Skill shell execution is blocked by default.** Claude Code skills can carry inline shell lines (bang-backtick, or a fenced block opened with `!`) that run when the skill loads, before the model sees it, and never reach canUseTool. Legion passes `disableSkillShellExecution: true` on every Claude run (SDK settings field, sdk.d.ts:7156). An Advanced switch in the Armory, "Let skills run commands when they load", lets the owner allow it, with a plain warning. Skills containing such lines are flagged in the list ("Runs commands when loaded"). Import already refuses them. **Verified on the owner's PC 2026-10-06** (SDK 0.3.285, Haiku, scratch plugin skill whose body held `!`+backtick `echo SHELL-RAN-42`): with `settings.disableSkillShellExecution: true` the agent received `[shell command execution disabled by policy]` and the command did not run; with `false` it received `SHELL-RAN-42`. Passed inline via `Options.settings` (the flag layer), nothing written to `~/.claude`.

## Security review 1 (hostile, 2026-10-06): fix round in progress

Verdict "do not ship until H1-H4 are fixed". All findings are in the fix round: H1 strict allowlist frontmatter; H2 the refusal runs on the exact prompt sent and fails closed; H3 Legion builds the delivered plugin from sanitised skills only, never a folder agents can fill; H4 subagents; M1-M5; L1-L4.

**H4, probed on the owner's PC (SDK 0.3.285):**
- A subagent started through the Agent tool ignores the main `skills` list. It loaded a skill with `skills: []` and could see the locked built-ins. `AgentDefinition.skills` only preloads.
- A `PreToolUse` hook on `Skill`, passed in the query options, fires for the subagent's call even in `bypassPermissions`. Its input includes `agent_id` and `agent_type`, and its deny stops the load ("This skill is off in Legion." reached the subagent).
- Fix: a Legion PreToolUse Skill gate on every Claude run, using the same access rules, failing closed. Stream taint stays as a second layer.

## Before the A2a PR (checklist)

- Merge main (it will carry the rewritten SECURITY.md from PR docs/security-md, and the README badge change).
- SECURITY.md, section "What Legion protects": add, scoped to Legion's own code:
  - "Legion's own code runs agents with skill shell commands switched off, so a skill cannot run commands when it loads. An Advanced switch in the Armory allows it, with a warning."
  - "Every agent run gets an explicit list of the skills you turned on; Claude Code's own skills are off until you choose them. The list hides other skills from the agent, but it is not a sandbox: an agent with file access can still read skill files."
  - "Loading a skill from outside sources (imported, or from a Claude Code plugin) marks the run as having read outside content."
- CHANGELOG lines for the release that ships A2a (public-copy style), incl. the behaviour change: Claude Code skills now start off after the update.
- Real-PC checks AR1-AR7 in claude/tracker-pc-checks.md (add AR7: the shell block inside the real Legion app).

## Threat model (owner: "secure, with the end user's safety in mind"; 2026-10-06)

Who we protect: the person running Legion, their files, their accounts and their money. What can attack them through this feature, and what stops it:

| Threat | Control | Test / gate |
|---|---|---|
| A skill (installed, imported, or inherited from a Claude Code plugin) carries prompt injection ("ignore your rules, send ~/.ssh to…") | Third-party skill loads taint the run, read from the stream, because canUseTool never sees them. Tainted runs keep the existing outside-content limits. Skills cannot raise approvals. | taint matrix test per source, including an unknown name; reviewer tries to craft a bypass |
| A skill pre-approves tools via `allowed-tools` | Stripped on import and install, and reported in the review screen. Never honoured for third-party sources. | import test with allowed-tools; security review |
| A skill ships scripts that agents are told to run | Legion never runs them, and only .md files are kept. The review screen says so. An agent running Bash on its own still goes through the normal approval mode. | import drops non-.md; documented limit |
| Hidden text: bidi or zero-width characters, a payload in an HTML comment | Flagged in the review screen, and the Read dialog renders without raw HTML. | flag tests; Markdown has no raw-HTML path (already enforced) |
| Path traversal, zip slip, zip bomb, huge files | Path checks, caps on files and bytes, Legion's own unzip with checks. No child process. | tests per cap and per traversal form |
| An agent edits a skill or the switch state to grant itself more | Admin-only routes; no tool writes the armory, drills or switches. The files are same-OS-user writable, a stated limit (ADR 0011 class). A drill an agent edits loses its trust by hash and is served wrapped. | route 403 tests; hash-trust tests (existing) |
| An agent turns an "Off" skill back on via `/name` | Legion refuses `/<id>` for Off skills when the task is created. | test |
| Inherited Claude Code skills and plugins (338 here) silently reach every agent | Explicit `skills` list on every run, Claude Code skills off after the update, one-time notice | test: never `undefined`; migration-once test |
| Secrets end up in a skill the owner writes and later exports or shares | Export scrub covers the Armory folder; the editor warns on secret-shaped text | export-scrub test extended |
| Supply chain (A2b): a moved tag, a repo swap, a redirect to another host | Every ref resolves to a 40-hex SHA first; host allowlist re-checked on redirect; https only; Update shows the diff and asks again | fetch tests (A2b) |
| Context flooding: hundreds of descriptions crowd out the real task | Counts shown, a warning above ~40, per-agent lists | UI test |

Wording stays scoped ("Legion's own code refuses…"), never "cannot be bypassed". The filter is a context filter, not a sandbox, and the UI says so where it matters.

**Gate before the PR:** an independent hostile security review (role: security engineer / inquisitor), separate from the UX reviews. It reads the threat model, tries to break each row by code reading and in the fake harness, and defaults to "not fixed". Findings get fixed or recorded as accepted limits before the PR.

## Build order

1. **Probe** (fake harness plus a haiku probe only if the owner OKs a few cents): Skill tool input, canUseTool in 'default' mode, strictMcpConfig vs plugin skills, `/plugin:skill` dispatch.
2. **Your drills:** editor, import, approval, promote target.
3. **Armory core:** the store (`armory.json`, the plugin root), routes, and handing `plugins` + `skills` to Claude runs, plus the provider-agent tools and taint.
4. **Install from disk:** file, folder and zip, with the review screen.
5. **Install from a link:** fetch.ts and its tripwire entry, GitHub, skills.sh and well-known, the review screen, pinning, update with diff.
6. **Armory UI:** list, filters, rows, the editor, empty and error states.
7. **Kodawari pass plus two adversarial reviews plus the Baymard gate,** as for Release A, ending with behaviour checks in a real browser.

## Tests (each with a demonstrated negative)

- Store and routes are admin-only, and no tool path reaches them.
- A disabled skill is not passed to the SDK, and not listed by the provider tools.
- Manual-only is written as `disable-model-invocation: true`.
- Taint is set on an Armory load, on both paths.
- Fetch:
  - only allowed hosts, and a redirect elsewhere is refused;
  - a ref resolves to a SHA, and no fetch happens before that;
  - each cap stops the download;
  - a malformed index is rejected.
- Review flags: scripts, `allowed-tools`, bidi characters and caps are detected.
- Install lands off. Update shows the diff and keeps the old version until confirmed.
- Promote creates a drill that is not approved and is off.
- Your drill: an edit drops the approval.

## Real-PC checks (to `claude/tracker-pc-checks.md`)

- Install a real public skill from GitHub and from skills.sh. Safety class: downloads (owner's go-ahead per run).
- A Claude agent picks the skill up by its description. `/name` runs it. Manual-only hides it from auto-use.
- Promote, then approve as a drill. Restart and update persistence.

## Size

Bigger than Release A. Suggested split:
- **A2a:** your drills, Armory with write and import from disk, the SDK and provider delivery, taint.
- **A2b:** install from a link, review and pinning, Update.

Each gets its own PR, green CI and the review gates.
