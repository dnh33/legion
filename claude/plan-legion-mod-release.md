# Plan: releasing Legion Mod for Claude Code

Status: PLAN. Written 2026-10-05. It covers how the mod ships, not what it does. The product is in `claude/plan-legion-mod.md`.
Nothing here is built, submitted or verified on a real PC. All web facts were read on 2026-10-05.

## 0. Summary and recommendation

**Recommendation:**
- Build the mod in the Legion repo under `mod/`.
- Publish each release to a small mirror repo, `dnh33/legion-mod`, with the plugin at its root.
- Users install with two commands:

  ```
  claude plugin marketplace add dnh33/legion-mod
  claude plugin install legion-mod@legion
  ```

- Once a few releases have held up, submit the mirror to Anthropic's directory. That submission is also the only way into Anthropic's community marketplace.

**Why the mirror:**
- The vendored-parity test lives in one repo, so a desktop change and its re-vendor land in one commit.
- Users clone a few MB, not the 290 MB desktop history.
- Mod releases never touch the GitHub Releases that the desktop updater polls.
- The directory sees a plugin at a repository root, which avoids the subfolder rules.

**Five rules this plan adds:**
1. In `dnh33/legion` the mod gets **tags only, never a GitHub Release**. A mod Release there would become `releases/latest`, which every desktop install polls for its update manifest.
2. The Claude Code CLI is **never** added to the root `package.json`. A lockfile change makes the next desktop release `requiresFullInstall` (`docs/VERSIONING.md`). CI installs the CLI globally, at a pinned version.
3. `version` is set in `mod/.claude-plugin/plugin.json` and bumped on every release. Without it, every commit to the source repo would count as a mod update.
4. The plugin name is permanent. Pick it before the first public push: `legion-mod` (§7, D2).
5. The privacy line is scoped. Legion Mod's own code calls neither `$.process` nor `$.http`, as `claude plugin validate` lists. The agents it starts are Claude Code subagents. They talk to Anthropic and use your tools under your own permission rules. Never write "no network" without "its own code".

**Found while researching (they change the product plan):**
- **Data root.** `scripts/uninstall.ps1 -Purge` deletes `~/.legion` recursively, so the mod keeps its data outside it, in `~/.legion-mod/`. See §5 and D4.
- **Tool names.** The product plan writes the mod tools as `mcp__legion__ask` and so on. Mod tools are named `mcp__<plugin name>__<tool>`. With the plugin named `legion-mod` they become `mcp__legion-mod__ask`. The plan's §1 table needs this fix.
- **Minimum version.** The mods docs now say mods need Claude Code **v2.1.287 or later** and are on by default. `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is now ignored. The product plan was written against 2.1.286 early access.
- **Export script.** `scripts/export-public.mjs` is not the live publish path: the `cloud` remote is the public `dnh33/legion` and carries `CLAUDE.md` and `review/`. Nothing in the mod release should depend on that script.

## 1. Facts, assumptions, unknowns

### 1a. Documented facts

| # | Fact | Source |
|---|---|---|
| F1 | A marketplace is a repo or folder with `.claude-plugin/marketplace.json`. Required fields: `name`, `owner` (`name` required; `email` and `url` optional), `plugins`. Each entry needs `name` and `source`. | https://code.claude.com/docs/en/plugins/marketplace-reference#top-level-fields |
| F2 | Plugin source types: relative path (`"./..."`), `github` (`repo`, `ref`, `sha`), `url` (`url`, `ref`, `sha`), `git-subdir` (`url`, `path`, `ref`, `sha`, fetched by sparse/partial clone), `npm`, `archive` (`url`, `sha256`), `command`. | https://code.claude.com/docs/en/plugins/marketplace-reference#plugin-sources |
| F3 | "Use a relative path for a plugin in a subdirectory of the marketplace repository itself. Use `git-subdir` for a subdirectory of some other repository." | same page |
| F4 | For a one-plugin repo: put `marketplace.json` beside `plugin.json` in `.claude-plugin/`, with one entry whose `source` is `"./"` and the same `name` as `plugin.json`. | https://code.claude.com/docs/en/plugins/publish#add-the-marketplace-file-to-your-repository |
| F5 | `plugin.json` fields include `name` (required, kebab-case), `displayName`, `version`, `description`, `author{name,email,url}`, `homepage` (must parse as a URL), `repository` (string), `license` (SPDX), `keywords`. Directory-only fields: `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`. There is no field for a minimum Claude Code version. | https://code.claude.com/docs/en/plugins/manifest-reference#fields |
| F6 | Version resolution: `plugin.json` `version` first, then the entry's `version`, then (for `github`/`url`/`git-subdir`) the 12-character commit SHA. Users get a new copy only when the computed version **differs**. It is not checked against semver. | https://code.claude.com/docs/en/plugins/loading#how-claude-code-computes-the-version |
| F7 | Auto-update is **off by default** for your own marketplace and for the community marketplace. Users update with `claude plugin update <plugin>@<marketplace>` or `/plugin marketplace update <name>`, or turn auto-update on under `/plugin` → Marketplaces. `marketplace.json` has no field to turn it on. | https://code.claude.com/docs/en/plugins/host-marketplace#turn-on-auto-update, https://code.claude.com/docs/en/plugins/install#keep-plugins-updated |
| F8 | `claude plugin validate <path> [--strict] [--json]`. Exit codes: 0 pass, 1 fail (or a warning under `--strict`), 2 validator error. "exit with a code a CI job can act on". | https://code.claude.com/docs/en/plugins/cli-reference#plugin-validate |
| F9 | On a mod, validate prints `hooks:` and `calls:` lines. "Claude Code refuses to load a mod that uses the mods API in a way this command can't read." `$.process.run`/`spawn` and `$.http.fetch` show up on `calls:`. | https://code.claude.com/docs/en/plugins/mods/admin#review-what-a-mod-can-do |
| F10 | `claude plugin test [dir]` runs `*.test.ts` files and "needs no session, sign-in, or network". It exits 1 on a failed test, "so it works in CI". | https://code.claude.com/docs/en/plugins/cli-reference#plugin-test, https://code.claude.com/docs/en/plugins/mods/test |
| F11 | Anthropic's own CI installs `@anthropic-ai/claude-code@<version>` and runs `claude plugin validate` with **no secret**. Only its separate `scan-plugins` action uses `ANTHROPIC_API_KEY`. | https://github.com/anthropics/claude-plugins-community/blob/main/.github/actions/validate-plugins/action.yml, https://github.com/anthropics/claude-plugins-community/tree/main/.github/actions |
| F12 | `claude plugin tag [path] [--push] [--remote <name>] [--dry-run]` creates `<name>--v<version>`. It refuses a dirty tree or a missing `version`. Tags are needed only when other plugins depend on yours. | https://code.claude.com/docs/en/plugins/cli-reference#plugin-tag, https://code.claude.com/docs/en/plugins/publish#tag-a-release |
| F13 | Never rename a published plugin. If you must, use the `renames` map. `displayName` can change freely. | https://code.claude.com/docs/en/plugins/host-marketplace#rename-or-remove-a-plugin |
| F14 | Reserved marketplace names include `claude-plugins-official`, `claude-community`, `agent-skills`, and others. Names that imitate official ones are refused. `legion` is not on the list. | https://code.claude.com/docs/en/plugins/marketplace-reference#reserved-names |
| F15 | Plugin names that start with `claude-`, `anthropic-` or `cc-plugin-`, or that are `claude-mods`, are an error. `legion-mod` is fine. | https://code.claude.com/docs/en/plugins/manifest-reference#name |
| F16 | Mods need Claude Code **v2.1.287 or later** and are on by default. `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored from then on. A mod installs as a plugin from a marketplace. They run in the CLI and the Desktop Code tab. They do not draw in the VS Code chat panel, `claude -p`, or cloud sessions. | https://code.claude.com/docs/en/plugins/mods/overview |
| F17 | A mod's tool is named `mcp__` + plugin name + `__` + tool name (example: `mcp__my-mod__ticket`). | https://code.claude.com/docs/en/plugins/mods/api#add-a-tool |
| F18 | The permission rule `mcp__puppeteer` "matches any tool provided by the `puppeteer` server". | https://code.claude.com/docs/en/permissions |
| F19 | `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`. It survives updates and is **deleted on uninstall** from the last scope, unless `--keep-data` is passed. `${CLAUDE_PLUGIN_ROOT}` changes with every version. | https://code.claude.com/docs/en/plugins/manifest-reference#environment-variables |
| F20 | A `package.json` plus a lockfile at the plugin root makes Claude Code run an install (`--ignore-scripts`, 60 s). The directory holds such a plugin for a reviewer. | https://code.claude.com/docs/en/plugins/loading#node-js-package-dependencies, https://claude.com/docs/plugins/pre-submission-checklist |
| F21 | A git-hosted marketplace is cloned. The background re-clone "can time out on large repositories". Git LFS content is never fetched. | https://code.claude.com/docs/en/plugins/host-marketplace#what-background-auto-update-does-with-credentials |
| F22 | **Anthropic's directory** (https://claude.ai/directory): submit at https://claude.ai/directory/manage. Needs a paid plan (Pro, Max, Team, Enterprise) and a GitHub account connected on claude.ai with push access. The repo can be private while you submit but must be public to publish. Every version gets automated validation and a security scan, and a person reviews a new listing. Review time is not fixed. Listings follow the Software Directory Terms and Policy. | https://claude.com/docs/directory/publish, https://claude.com/docs/plugins/submit |
| F23 | Directory **blocking** rules: README of 40+ words in the plugin folder; `LICENSE` file or `license` field; no `.DS_Store` or `Thumbs.db`; Windows/macOS-safe file names. **Validation stops** on `.gitattributes` with `export-ignore`, `export-subst`, `filter` (LFS included) "or other attributes that rewrite file contents" at the root, above the plugin folder or inside it; and on a repo over 50 MiB archived, 256 MiB unpacked, or 10,000 files. **Held for a reviewer:** any non-image file over 256 KiB, more than 512 files, non-image binaries, a generic name or a brand look-alike. Security-scan advice: "Describe in the README everything the plugin runs, sends, or fetches." | https://claude.com/docs/plugins/pre-submission-checklist |
| F24 | The directory follows a tracked branch or tag. Merging to it is the release; there is no resubmission. The repo and folder **cannot be changed** after submission. "If your plugin.json sets version, raise it with every release." A plugin can sit in a subfolder ("Plugin path"). | https://claude.com/docs/plugins/submit |
| F25 | The directory lists a mod "for Claude Code". `/plugin directory` browses it in Claude Code v2.1.287+. | https://claude.com/docs/plugins/platform-support |
| F26 | **Official marketplace** `claude-plugins-official` "doesn't take submissions through the directory portal"; listing there goes through an Anthropic partner contact. | https://code.claude.com/docs/en/plugins/publish#submit-to-anthropics-directory |
| F27 | **Community marketplace** `anthropics/claude-plugins-community` (marketplace name `claude-community`) is a read-only mirror, synced nightly, of plugins "submitted via claude.ai, passed automated security scanning, and been approved". PRs are closed automatically. Its submit link (https://clau.de/plugin-directory-submission) redirects (302) to https://claude.com/docs/directory/publish. Entries are pinned by SHA and include `git-subdir` sources. On 2026-10-05, `grep -i legion` over the raw catalog finds 0 matches. | https://github.com/anthropics/claude-plugins-community, https://raw.githubusercontent.com/anthropics/claude-plugins-community/main/.claude-plugin/marketplace.json |
| F28 | **No mods-specific gallery or submission channel exists.** Anthropic's sample mods are in `anthropics/claude-code-playground/claude-code/mods`, "shared as they are, without support". | https://code.claude.com/docs/en/plugins/mods/overview#try-a-sample-mod |
| F29 | Repo facts: `dnh33/legion` is public, Apache-2.0, homepage https://getlegion.xyz/, about 291 MB (GitHub API `size` 298052 KB). HEAD has 955 tracked files and a 12.8 MiB `git archive` zip. The root `.gitattributes` sets `text=auto eol=lf` and `eol=crlf`. | https://api.github.com/repos/dnh33/legion; local `git archive` |
| F30 | The desktop updater fetches `https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json`. The desktop server's MCP tools are `legion_run`, `legion_status` and others (`src/core/mcp-tools.ts`). Its users register it as `legion`. The desktop data root is `~/.legion`, or `LEGION_HOME` if set (`src/shared/config.ts:166-168`). `uninstall.ps1 -Purge` deletes it recursively (`scripts/uninstall.ps1:27,113-115`). | `docs/UPDATES.md`, `docs/SHIPPING.md` §10, repo files cited |

### 1b. Assumptions, each with the check that proves it

| # | Assumption | Check |
|---|---|---|
| A1 | `claude plugin validate --json` carries the mod's `calls:` list, so CI can assert "no `process.*`, no `http.fetch`" by parsing JSON. | Run it on a spike mod. If JSON lacks it, grep the text output for the `calls:` line instead. |
| A2 | `claude plugin validate` and `claude plugin test` run on GitHub-hosted `ubuntu-latest` and `windows-latest` with no sign-in (F10 and F11 say so for Linux). | First CI run on both runners. |
| A3 | `text=auto eol=lf` in the root `.gitattributes` does not count as an "attribute that rewrites file contents". This only matters if we submit from `dnh33/legion` itself; the mirror avoids the question. | Portal **Validate** on the mirror (owner). |
| A4 | `scripts/export-mod.mjs` (§2) gives the same tree for the same tag, and each release adds one commit that fast-forwards the mirror's `main`. | Run it twice for one tag and diff the trees. Push to a private test repo first. |
| A5 | A mod's hooks module in TypeScript, plus the committed `vendor/` files, pass validate (spike S12 in the product plan). | Spike S12. |
| A6 | The 2D frames can be packed into a few JSON files, each under 256 KiB and 512 files in total, so the directory does not hold the plugin. | Measure after phase 5. Otherwise accept a reviewer hold. |
| A7 | Rasterising Grenze Gotisch into the wordmark is allowed under OFL 1.1. The repo `NOTICE` already lists it under OFL 1.1. | Read the OFL FAQ on rendered output. Copy the OFL text into `mod/licenses/`. |
| A8 | The mod can find the user's home folder for its data root (through `$.env.get` or a session field). That call then appears on the `calls:` or `env reads:` line. | Spike, in the product phase. |

### 1c. Unknowns only the owner can check

| # | Unknown | Owner check |
|---|---|---|
| U1 | Which Claude Code build you run, and whether it is ≥ 2.1.287 (F16). | `claude --version` |
| U2 | Whether "Legion" triggers the directory's **Name matches a known brand** hold (Lenovo Legion). That is a reviewer hold, not a block. | Portal **Validate** on the mirror. |
| U3 | Whether a directory listing also lands in `claude-community`. F27 implies it, but no page says every listing does. | Look at `claude-community` after the listing is live. |
| U4 | Review time for a first listing. F22 says it is not fixed. | Portal status page. |
| U5 | Whether `scripts/export-public.mjs` is still meant to be used. The tracker planned a scrubbed snapshot, yet `cloud` is the public repo with `CLAUDE.md` and `review/` visible. | You confirm. It does not block this plan. |
| U6 | Who owns `getlegion.xyz` hosting and the `legion-site` repo, for the mod page. | You confirm. |

## 2. Repo strategy

### Options

| Option | What users clone | Parity rule | Directory submission | Desktop impact | Verdict |
|---|---|---|---|---|---|
| **A. Monorepo, `marketplace.json` at the `dnh33/legion` root, `source: "./mod"`** | The whole 291 MB history (F21, F29) | Easy | Subfolder plus root `.gitattributes` (A3) | Risk of Releases colliding with `releases/latest` | Rejected: clone size and the re-clone timeout |
| **B. Monorepo code, small catalog repo with a `git-subdir` source pointing at `dnh33/legion` path `mod`, `ref` pinned to the mod tag** | Only `mod/`, by partial clone (F2) | Easy | Subfolder of the big repo (A3); the repo and folder are fixed forever (F24) | Tags only | Workable fallback |
| **C. Separate repo `dnh33/legion-mod` as the source of truth; vendored files synced in by script** | A small repo | Hard: cross-repo drift, two PRs per shared change | Clean, at the root | None | Rejected: parity becomes a cross-repo race |
| **D. Monorepo code in `mod/` and `mod-runner/`; on release, an export script assembles a catalog plus both plugins and commits it to the mirror `dnh33/legion-mod`** | A small repo with one commit per release | Easy: one repo, one commit | Clean: two plugin folders in a small repo; the mirror's `.gitattributes` is ours | Tags only in `dnh33/legion`; Releases live in the mirror | **Recommended** |

### Recommendation: D (two plugins, updated 2026-10-05)

**Dev layout in `dnh33/legion`** (two sibling plugin roots at the repo root):

```
mod/                                legion-mod plugin root
  .claude-plugin/plugin.json        name legion-mod, version, license Apache-2.0, dependencies → legion-mod-runner (§3.0)
  hooks/hooks.json                  modules: [ one module ]
  hooks/*.ts
  vendor/legion/                    byte-for-byte copies made by scripts/build-mod.mjs (committed)
  vendor/legion/SOURCE.json         desktop commit SHA + desktop version the copies came from
  tests/*.test.ts
  README.md  CHANGELOG.md  LICENSE  NOTICE  licenses/
  DEVELOPING.md                     not CLAUDE.md: validate warns on a CLAUDE.md at the plugin root
mod-runner/                         legion-mod-runner plugin root
  .claude-plugin/plugin.json        name legion-mod-runner, same version as mod/
  hooks/hooks.json                  modules: [ one module ]
  hooks/*.ts  tests/*.test.ts
  README.md  LICENSE  NOTICE
```

- **No `marketplace.json` in `dnh33/legion`.** A catalog at the repo root would invite users to add the 291 MB repo (option A). The catalog lives only in the mirror. Its template sits in the export script, or in `scripts/mod-catalog/marketplace.json`, which is not a `.claude-plugin/` path.
- **Local testing without a catalog:** `claude --plugin-dir mod --plugin-dir mod-runner`. The local runner satisfies the dependency; a marketplace-named entry needs v2.1.242+ (dependencies doc).
- **Parity:** `scripts/build-mod.mjs` vendors the pure desktop files into `mod/vendor/legion/`, and `test/mod-vendor.test.ts` pins them byte for byte.
  - The runner has no vendored files today.
  - If it ever needs one, `build-mod.mjs` must copy into `mod-runner/vendor/legion/` as well, and `test/mod-vendor.test.ts` must cover both copies.

**Mirror layout** (made by the export, never edited by hand):

```
.claude-plugin/marketplace.json     name legion; entries ./plugins/legion-mod, ./plugins/legion-mod-runner (§3a)
plugins/legion-mod/                 = mod/ at the release commit
plugins/legion-mod-runner/          = mod-runner/ at the release commit
README.md                           front page: what Legion Mod is, the two install lines, "developed in dnh33/legion"
.gitattributes                      * -text   (no eol, filter or export-* rules; F23)
```

**Why an export script and not `git subtree split`:**
- Subtree split takes one prefix and keeps its path.
- Here two sibling folders must land under `plugins/`, beside a catalog that `dnh33/legion` does not hold.
- The export (`scripts/export-mod.mjs`, to be written) works like this:
  - it reads `git archive <release tag> mod mod-runner` (the committed tree, not the working copy);
  - it writes the mirror layout into a mirror checkout;
  - it commits once: `legion-mod <v> (from dnh33/legion <sha>)`.
- Deterministic and easy to check. The mirror's history is one commit per release, which is all users and the directory need.
- It refuses a dirty source tree, a version mismatch between the two `plugin.json` files, and a `dependencies` range that does not cover the release version.

**Rules for both plugin roots:**
- No `bin/` folder (claude.ai refuses it).
- No `package.json` + lockfile pair (F20).
- No symlinks.
- No Git LFS.
- Every path a plugin uses stays inside its own root.

**What users see:**
- `github.com/dnh33/legion-mod`: a README, the two plugin folders, Releases, a short history.
- The mirror README says: "Developed in dnh33/legion under `mod/` and `mod-runner/`. Report issues there."

**Mirror rules:**
- The mirror is written only by the release step.
- Its `main` moves only at a release. Both directory submissions track `main`, so they only ever see releases.
- Issues are disabled on the mirror; one tracker stays at `dnh33/legion` (D7).

**Why not B:** it works, and it would be the fallback if you do not want a second repo. But the directory submission would be fixed forever to a subfolder of the 291 MB repo, under the root `.gitattributes` (A3, F24). And users would land on the desktop repo's README when they follow the source link.

## 3. Distribution channels

### 3.0 Two plugins, one install (added 2026-10-05, after the spikes)

The spikes showed the mod must ship as **two plugins**:
- `legion-mod`: the UI, approvals and stores. It observes the agents.
- `legion-mod-runner`: a small companion that spawns, resumes and stops agents.

Two reasons. The plugin whose hook starts an agent cannot see that agent's tool calls and steps. And `hooks.json` allows one module per plugin.

This replaces §2's one-plugin layout. Repo strategy D still holds. The mirror now holds one catalog and two plugin folders.

**Documented mechanism: `dependencies` in `plugin.json`.**
- `legion-mod` declares the runner in `dependencies` (https://code.claude.com/docs/en/plugins/dependencies, https://code.claude.com/docs/en/plugins/manifest-reference#dependencies).
- On `claude plugin install legion-mod@legion`, Claude Code "also installs and enables the plugin's declared dependencies at the same scope. The success message lists them" (https://code.claude.com/docs/en/plugins/install#plugins-with-dependencies).
- Re-running install, `/reload-plugins`, `claude plugin marketplace add` and marketplace auto-update also install a declared dependency that is missing.
- **Disable:** Claude Code refuses to disable the runner while `legion-mod` needs it.
- **Uninstall:** an auto-installed dependency stays until `claude plugin prune`.
- **Minimum version:** the docs give none for `dependencies` itself. The sub-features have their own: v2.1.242 for marketplace-named entries matching a `--plugin-dir` copy, and v2.1.265 for one `--plugin-dir` holding both plugins. Our floor stays D10.

**Entry form.** Use `{ "name": "legion-mod-runner", "version": "~<major>.<minor>.0" }`. The two plugins always release together at the same version, so the range is bumped with each MINOR.
- The range resolves against `legion-mod-runner--v<x>` git tags in the repo that hosts the runner. With a relative-path source, that is the mirror (the catalog repo).
- If no tag satisfies the range, a relative-path dependency falls back to the catalog's current copy and is checked at load. A copy outside the range leaves `legion-mod` disabled with "Requires … installed …".
- So both tags must be pushed to the mirror with every release (§4d).

**The bundle-plugin pattern** in the same doc ("Bundle plugins for a team": a plugin with only `name` + `dependencies`) is not needed here. `legion-mod` itself is the bundle.

**Mirror layout** (made by `scripts/export-mod.mjs`, §2):

```
.claude-plugin/marketplace.json     name legion; entries ./plugins/legion-mod and ./plugins/legion-mod-runner
plugins/legion-mod/                 .claude-plugin/plugin.json (dependencies → runner), hooks/, vendor/, README, LICENSE, NOTICE
plugins/legion-mod-runner/          .claude-plugin/plugin.json, hooks/, vendor/ (only what it needs), README, LICENSE, NOTICE
README.md                           repo front page: what Legion Mod is, the two install lines
```

- Each plugin folder carries its own `LICENSE`, `NOTICE` and 40+ word README, because the directory reads only the plugin folder (F23).
- Vendored files are copied into each plugin that imports them. No symlinks: the directory blocks loaded symlinks. The parity test covers both copies.
- `claude plugin validate` must run on **each plugin folder**. From the catalog root it does not open plugin files in other directories (cli-reference, "Plugin files in a marketplace run"). The calls check (§4c) runs on both.
- The privacy line covers both plugins. The runner's `calls:` line must also be free of `$.process` and `$.http`.

### 3a. Own marketplace (day one)

1. The mirror holds `.claude-plugin/marketplace.json`:

   ```json
   {
     "name": "legion",
     "description": "Legion Mod for Claude Code: Legion's agents, Library, rooms and board inside Claude Code.",
     "owner": { "name": "dnh33", "url": "https://getlegion.xyz/" },
     "plugins": [
       { "name": "legion-mod", "source": "./plugins/legion-mod",
         "description": "Legion's agents, Library, rooms and board. Installs legion-mod-runner with it." },
       { "name": "legion-mod-runner", "source": "./plugins/legion-mod-runner",
         "description": "Starts and stops Legion's agents for legion-mod. Install legion-mod, not this." }
     ]
   }
   ```

   - Do not set `version` on the entries; each `plugin.json` holds it (F6 and validate's mismatch warning).
   - Do not use `defaultEnabled: false` on the runner. It would have no effect: a plugin that an enabled plugin depends on "starts enabled regardless" (manifest-reference, `defaultEnabled`). Instead, the runner must do nothing until `legion-mod` asks it to.
2. Users still run **one install**, and the runner comes with it:

   ```
   claude plugin marketplace add dnh33/legion-mod
   claude plugin install legion-mod@legion
   ```

   or, in a session (v2.1.275+): `/plugin install legion-mod --marketplace dnh33/legion-mod`.

   There is no documented multi-plugin form such as `claude plugin install a@m b@m`. The CLI reference shows one `<plugin>` argument, so the plan does not rely on one.
3. Updates: `claude plugin update legion-mod@legion`, or turn on auto-update under `/plugin` → Marketplaces → legion (off by default, F7). The README says this plainly.
   - A manual update of `legion-mod` that raises the runner's range: also run `claude plugin update legion-mod-runner@legion`, or `/plugin` → Marketplaces → legion → **Update marketplace**, which updates every plugin from the catalog.
   - The dependencies doc says a newly *added* dependency is installed by `update` plus `/reload-plugins`. It does not say that `update` moves an already-installed dependency to a new range. Assumption A9 below.
4. Uninstall: `claude plugin uninstall legion-mod@legion`, then `claude plugin prune` to remove the runner.
5. To pin a release, users can append `#legion-mod--v0.1.0` to the marketplace add command (F7).

**A9 (assumption, with its check).** After a release that bumps both plugins, `claude plugin update legion-mod@legion` alone leaves the runner at a version inside the new range. If it does not, the auto-update path does (it resolves "at the highest git tag that satisfies every installed plugin's range"). Check: install 0.1.0 on a clean profile, release 0.2.0 to a private test mirror, update `legion-mod` only, then run `claude plugin list`.

### 3b. Anthropic's directory (after 0.1.x has held up; owner-only steps)

**Two plugins means two submissions.**
- "Each plugin folder is its own submission … a repository that holds several plugins needs one submission for each" (https://claude.com/docs/plugins/submit).
- The validator blocks submitting more than one at a time: "**Pick one plugin first**" (https://claude.com/docs/plugins/pre-submission-checklist).
- Both submissions point at `dnh33/legion-mod`, with plugin path `plugins/legion-mod` and `plugins/legion-mod-runner`. One submission per repository and folder is allowed.

**Unknown U7 (owner-only): does a directory install pull in the dependency?**
- A directory install reaches Claude Code as `<name>@synced`, with "no marketplace and no install record" (https://code.claude.com/docs/en/plugins/loading#synced-plugins).
- Dependencies resolve "in the same marketplace as the declaring plugin".
- No page says how a synced plugin's `dependencies` resolve.
- Mitigations:
  - List the runner too.
  - The `legion-mod` README and listing say "also add Legion Mod Runner".
  - `/legion doctor` and the band name the missing runner in plain words, with the fix.
- Check: after both listings are live, add only `legion-mod` from claude.ai and see whether the runner arrives.

**Subfolder rules now apply** (the plugin is no longer at the repo root). From the pre-submission checklist:
- Hook and MCP command paths must be written in full from `${CLAUDE_PLUGIN_ROOT}`. That blocks when the plugin is in a subfolder.
- "Scripts the validator couldn't follow" is a reviewer hold.
- A mod `modules` entry is not a hook command. Assumption A10: the subfolder rules do not hold a mod module. Check: portal **Validate** on both folders.
- The mirror's `.gitattributes` is ours: keep it free of `filter` and `export-*`.

**Owner steps, done twice, runner first:**
1. Pre-checks we can do, per plugin folder:
   - `claude plugin validate plugins/<name> --strict`;
   - README of 40+ words;
   - `LICENSE` present;
   - `author`, `description`, `version`, `homepage` set;
   - every non-image file under 256 KiB, 512 files or fewer;
   - no binaries other than PNG, JPEG, GIF or WebP;
   - the README lists everything the plugin runs, sends or fetches (F23).
2. Optional directory fields in each `plugin.json`: `supportUrl` (the `dnh33/legion` issues page), `privacyPolicyUrl` (the getlegion.xyz privacy page), `documentationUrl`.
3. **Owner:** at https://claude.ai/directory/manage choose **Submit new** → **Plugin bundle**, Repository `dnh33/legion-mod`, Plugin path `plugins/legion-mod-runner`, tracked branch `main`. Then **Validate**, fix anything blocking, and **Re-validate**. Then the same for `plugins/legion-mod`. The repo and folder cannot be changed later (F24).
4. **Owner:** answer **Data handling** for each. Truthful answers, scoped:
   - The mod stores Library, room and board data in local files on your machine.
   - Its own code sends nothing anywhere.
   - The subagents it starts use your Claude Code session and tools.
5. **Owner:** **Compliance** contact email and the four acknowledgements; then **Submit for review**. Optionally set up the GitHub push webhook (needs admin on the mirror).
6. After approval, merging to the mirror's `main` (only done at release) is the release for both listings.
   - Each listing keeps its last published version if a new one is held (F24).
   - **The two listings can therefore drift apart.** The range check makes a too-old runner visible ("Requires …") instead of breaking silently.
   - Turn on auto-publish for neither until both have passed one review together.
7. **Not available to us:** `claude-plugins-official` (partner contact only, F26) and a mods gallery (none exists, F28).

### 3c. Community directories and lists (only ones actually checked)

| Where | How to get listed | Credibility |
|---|---|---|
| `claude-community` marketplace (`anthropics/claude-plugins-community`) | Only through the directory submission in 3b. PRs are auto-closed. | Anthropic-run; 4.5k stars; synced nightly (F27) |
| **awesome-claude-code** (https://github.com/hesreallyhim/awesome-claude-code) | Web **issue form** only; no PRs, or you risk a temporary restriction. A **human** must submit. The project must be 14+ days old with active development, or have 100+ stars. One resource at a time. Best-effort review, no guarantee. | About 55k stars |
| **ClaudePluginHub** (https://www.claudepluginhub.com) | Auto-indexes public GitHub repos with `.claude-plugin/plugin.json`, or submit the URL to index now. You can claim the plugin for analytics. | Community-run, "not affiliated with Anthropic"; claims 84k plugins |
| **Claude Code Marketplaces** (https://claudemarketplaces.com) | The listing method is not stated on the page; ranking uses "install count, GitHub stars, registry metadata, and usage". Treat it as unknown; it likely crawls GitHub. | Independent (mertbuilds.com), "not affiliated with Anthropic" |
| **aitmpl.com** (`davila7/claude-code-templates`) | Listing method not stated on the page; unknown. | About 31k stars on the repo |
| **awesome-claude-plugins** (https://github.com/ComposioHQ/awesome-claude-plugins) | Found in search; submission rules not read. Check the repo's CONTRIBUTING before acting. | Unknown |

All community submissions are the owner's to make, by hand. awesome-claude-code requires a human submitter, and the 14-day rule means "after launch day plus two weeks".

## 4. Versioning, CI and the release cut

### 4a. Versioning

- **The mod's own semver, independent of the desktop.** It starts at `0.1.0`. Mod `0.x` makes no stability promise; `1.0.0` comes when the storage format is frozen.
- **The bump rule is the desktop's table** (`docs/VERSIONING.md`), minus the updater parts:
  - PATCH: fixes;
  - MINOR: features or behaviour changes;
  - MAJOR: a storage-format change without migration.
  - No lettered patches. Claude Code only checks that the version string changed (F6), so they buy nothing here.
- **Version lives only in `mod/.claude-plugin/plugin.json`.** CI runs `validate --strict`, which fails on a missing `version` (F8).
- **A published version is immutable.** A fix is always a new, higher version, the same rule as desktop rule 3. Rollback means publishing a higher version that holds the old code. `claude plugin update` installs any version that *differs*, so this works.
- **Tags:** `legion-mod--v<version>`, made by `claude plugin tag` (F12). In `dnh33/legion`: tag only, **no GitHub Release** (§0 rule 1). In the mirror: the same tag plus a GitHub Release.
- **Changelog:** `mod/CHANGELOG.md`, Keep a Changelog format, written for the person deciding whether to update.
  - Release notes follow `docs/RELEASE-NOTES.md` (effect first, no jargon, under 600 characters for a patch).
  - The desktop `CHANGELOG.md` gets one line under "For contributors" only when a desktop change re-vendors files into `mod/`.

### 4b. The vendored-parity rule and releases

- **The parity test runs in the desktop `npm test`.** A desktop PR that changes a vendored source file fails until `npm run build:mod` re-copies it. Both changes then land in the same commit.
- **Re-vendoring is not a mod release.** The changed copies ship in the next mod release.
- **`mod/vendor/legion/SOURCE.json` records the desktop commit and version the copies came from.** The mod's `/legion doctor` shows it.
- **A desktop release never waits on a mod release, and the reverse holds too.** The release step refuses to export if parity fails.
- **Adapters** for the non-vendored files (crypto) keep their own parity test, as the product plan says.

### 4c. CI (a new job in `.github/workflows/ci.yml`, built in phase 6; not done now)

```yaml
  mod:
    name: mod (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, windows-latest] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      # Global, pinned, never in package.json (a lockfile change forces requiresFullInstall on the desktop)
      - run: npm install -g @anthropic-ai/claude-code@<pinned version, >= 2.1.289>
      - run: claude plugin validate mod --strict
      - run: claude plugin test mod
      - run: node scripts/mod-calls-check.mjs   # fails if the validate report lists $.process.* or $.http.fetch (A1)
```

- **CI pin ≥ 2.1.289, not 2.1.287.** When a folder holds both `marketplace.json` and `plugin.json`, validate checks the plugin's manifest and component files only on v2.1.289 or later (https://code.claude.com/docs/en/plugins/cli-reference#validate-a-directory). On an older CLI, `validate mod` could check only the catalog and print no `calls:` line. The users' minimum (D10) is a separate number.
- **`mod-calls-check` fails closed.** It fails when the report has no `hooks:`/`calls:` entry for the hooks module at all, not only when it lists `$.process`/`$.http`. Belt and braces: also run `claude plugin validate mod/.claude-plugin/plugin.json --strict`.
- **No secrets.** Validate and test need none (F10, F11).
- **Pin the CLI version.** Bump the pin on purpose, in its own PR, after the owner's build is confirmed (U1).
- **The repo's existing gates still run** (`npm ci && npm run build:ts && npm test && npm run typecheck && npm run build:ui`), and they include the parity test.
- **Every new test gets a negative**, per `CLAUDE.md`. For `mod-calls-check` there are two: a scratch `$.http.fetch` call in a hook must turn it red; and a report with the `calls:` line removed (or an old CLI that skips the plugin) must turn it red too. Revert both.

### 4d. Cutting a mod release (orchestrator; owner pushes)

1. **Gate** on `main`, one gate at a time (`docs/SHIPPING.md` §1 and §7b):
   - the repo gates, which include `test/mod-vendor.test.ts`;
   - `node scripts/build-mod.mjs` leaves no diff (the vendored copies are current);
   - for **each** of `mod` and `mod-runner`: `claude plugin validate <dir> --strict`, `claude plugin test <dir>`, and the calls check (no `$.process`/`$.http`, fail closed on a missing `calls:` line).

   Record the exact counts per plugin.
2. **Version and notes.**
   - Bump `version` in **both** `mod/.claude-plugin/plugin.json` and `mod-runner/.claude-plugin/plugin.json` to the same value.
   - If the MINOR changes, move the `dependencies` range in `mod/` to `~<major>.<minor>.0`.
   - Add a dated section to `mod/CHANGELOG.md`, which covers both plugins, and write the release notes file.
   - Merge by PR (`main` is protected).
3. **Tag the monorepo, from a clean worktree at the release commit.** `claude plugin tag` refuses a dirty tree, and the canonical clone often holds other sessions' edits.
   - `claude plugin tag mod --dry-run` and `claude plugin tag mod-runner --dry-run`, then the same with `--push --remote cloud`.
   - Result: `legion-mod--v0.1.0` and `legion-mod-runner--v0.1.0`.
   - There is no catalog in `dnh33/legion`, so the tag command checks only `plugin.json`.
   - No `gh release` in `dnh33/legion`.
   - Once mod versions overlap desktop versions (for example both at 0.2.x), `docs/SHIPPING.md`'s rollback check `git ls-remote --tags cloud | grep <v>` also matches `legion-mod--v0.2.x`. Anchor that grep (`refs/tags/v<v>$`) when this ships.
4. **Export.** `node scripts/export-mod.mjs --tag legion-mod--v<v> --mirror <mirror checkout>` (§2).
   - It builds the mirror layout from `git archive` of the tag and commits once on the mirror's local `main`.
   - It refuses on a version mismatch between the two plugins or a range that misses the release version.
5. **Check the export, not the source.** In the mirror checkout:
   - `claude plugin validate . --strict` (the catalog);
   - for **each** of `plugins/legion-mod` and `plugins/legion-mod-runner`: `claude plugin validate <dir> --strict`, `claude plugin test <dir>`, and the calls check. From the catalog root, validate does not open plugin files in other directories, so run it per folder;
   - a secrets scan reusing `export-public.mjs`'s `DENY_FILES` and `DENY_CONTENT` patterns;
   - per plugin folder: no file over 256 KiB, at most 512 files;
   - a local install from the checkout: `claude plugin marketplace add ./` on a clean profile, then `claude plugin install legion-mod@legion` lists `legion-mod-runner` as installed with it.
6. **Mirror tags.** Dependency ranges resolve against tags in the catalog repo (§3.0), so the mirror needs both tags on the export commit.
   - Run `claude plugin tag plugins/legion-mod` and `claude plugin tag plugins/legion-mod-runner`, without `--push`. These also check that each `plugin.json` agrees with its catalog entry.
7. **Owner pushes the mirror.** `git push <mirror> main` and both tags.
   - Then `gh release create legion-mod--v<v> --repo dnh33/legion-mod --draft --notes-file <notes>`. One Release per version, named after `legion-mod`; the runner tag carries no Release.
   - Check the draft, then publish.
8. **Verify from live, not from disk.** On a clean profile (`CLAUDE_CONFIG_DIR` pointed at a temp folder):
   - `claude plugin marketplace add dnh33/legion-mod`;
   - `claude plugin install legion-mod@legion` installs both plugins;
   - `claude plugin list` shows both at the new version;
   - from the previous version, `claude plugin update legion-mod@legion` moves `legion-mod`, and the runner ends inside the new range (A9; if not, record the extra command in the README).
9. **Directory.** If listed, both listings pick up the new `main` commit themselves (F24). Watch the portal for a hold on either; the two can publish at different times.

Steps 7 and 9 touch public services and are the owner's. Everything before step 7 is local and reversible.

## 5. Coexistence with the desktop app on one PC

| Topic | What happens | Plan |
|---|---|---|
| **Data folder** | Desktop data is `~/.legion` (or `LEGION_HOME`). `uninstall.ps1 -Purge` deletes it recursively (F30), so any mod data kept inside that folder would go with it. `${CLAUDE_PLUGIN_DATA}` is deleted when the plugin is uninstalled (F19). | **Recommend a sibling root `~/.legion-mod/`** (D4). It survives both uninstalls and never sits under `LEGION_HOME`. Keeping mod data inside `~/.legion` would instead need a desktop change to the purge prompt. |
| **Tool and permission names** | Mod tools are `mcp__<plugin>__<tool>` (F17). A plugin named `legion` would share the `mcp__legion__*` namespace with the desktop server that users add as `legion`. An allow rule `mcp__legion` would then also approve the mod's tools (F18). | Plugin name `legion-mod` (D2). Tools become `mcp__legion-mod__kg_search` and so on. Fix the product plan's §1 row. Spike S13 can then be dropped or kept as a test. |
| **Command names** | Mod commands must not shadow built-ins; `$.command.register` throws for a taken name. The desktop adds no Claude Code commands. | Nothing to do. Keep `/legion …` and `/to`, and check them against built-ins in `/legion doctor`. |
| **Both installed** | They do not share files, ports or tokens. The mod needs no desktop core. A user can also connect the desktop over MCP in the same Claude Code session; then both tool sets appear, with different prefixes. | The README says both can be installed together and that they keep separate Libraries. |
| **Library import** | The mod reads the desktop's `graph.jsonl`, read-only (product plan §3). | Import is in the mod (phase 2). The mod never writes `~/.legion`. |
| **Library export (later)** | The desktop could import the mod's Library through the same op format. | Desktop work for a later desktop MINOR. Add it to the tracker under "Later". It needs a native or admin-gated path, because it writes trusted notes. |
| **Packaging** | The desktop package takes only the update code set (`dist`, `dist-ui`, `assets`, `scripts`, `licenses`, root files: `docs/UPDATES.md`). | Check that `build-package.mjs` never picks up `mod/`, and add an assert. `mod/` must not change `depsSha256` (no lockfile). |
| **Tripwire** | Child processes may be spawned only in files the tripwire lists. | The mod has no `$.process` (F9 check). The frame pipeline sits outside the scanned roots (product plan §2.7). |

**Cross-promotion:**
- **Desktop README:** a short section "Prefer the terminal? Legion Mod for Claude Code", with the two install lines and a link to the mirror.
- **Mirror README:** "Want a desktop app with VMs, Blender and BSV? Legion desktop", linking to `dnh33/legion` and getlegion.xyz.
- **getlegion.xyz:** one page for the mod: what it is, the install lines, the privacy text, the minimum Claude Code version.
- **No in-app promotion in the desktop for v1** (D9).

## 5b. Risk: mods can be switched off remotely (observed 2026-10-05)

`claude plugin test` refused to load any mod with this message: "hooks modules are turned off in this process: the rollout switch was saved off by an earlier session and is not refreshed yet. Start `claude` once with network access … if this message returns, installed mods are turned off remotely". One `claude -p` run refreshed the switch, and mods loaded again.

**What this means.** Function-hook mods sit behind a remote rollout switch while the feature is in early access. A user whose switch is off gets no Legion at all, and the plugin cannot detect it because its code never runs.

**What we do about it:**
- The README's troubleshooting section names the symptom (`/legion` unknown) and the fix (start `claude` once online; update Claude Code).
- The release notes say mods are early access in Claude Code.
- We check the switch before each release with `claude plugin test`.

## 6. Launch checklist

### Before 0.1.0

- [ ] **Two plugins wired as §3.0:**
  - `legion-mod`'s `plugin.json` declares `dependencies: [{ "name": "legion-mod-runner", "version": "~<major>.<minor>.0" }]`;
  - both plugins carry the same `version`, bumped together;
  - each release pushes both tags (`legion-mod--v<x>`, `legion-mod-runner--v<x>`) to the **mirror**, because the range resolves against the catalog repo's tags. §4d must be updated to tag both plugins;
  - CI and the release check run validate, test and the calls check on **each** plugin folder;
  - the parity test covers both `vendor/` copies.
- [ ] **One-step install proven on a clean profile:**
  - `claude plugin install legion-mod@legion` lists `legion-mod-runner` in its success message;
  - `claude plugin list` shows both, enabled;
  - disabling the runner alone is refused;
  - after an uninstall, `claude plugin prune` removes the runner;
  - the update path matches A9.
- [ ] **Missing-runner state:** `/legion doctor` and the band say, in plain words, that the runner is missing or out of range, and give the one command that fixes it (covers U7 and listing drift).
- [ ] **Repo front page `README.md`** at the mirror root: what Legion Mod is, the two install lines, and the two plugin folders.
- [ ] **`plugins/legion-mod/README.md`** (40+ words; also the directory listing text):
  - what it is, in one line;
  - the two install lines;
  - "Installs legion-mod-runner with it; if you added Legion Mod from claude.ai, also add Legion Mod Runner";
  - uninstall: `claude plugin uninstall legion-mod@legion`, then `claude plugin prune`;
  - the update line, and how to turn on auto-update;
  - the minimum Claude Code version (≥ 2.1.287, U1);
  - what works where: terminal and Desktop Code tab draw; VS Code chat panel and `claude -p` run hooks but draw nothing (F16);
  - the data folder, and how to delete it;
  - the privacy section below;
  - "Developed in dnh33/legion; report issues there";
  - the licence.
- [ ] **`plugins/legion-mod-runner/README.md`** (40+ words): what it does (starts, resumes and stops Legion's agents for legion-mod); "install legion-mod, not this"; that it does nothing on its own; the same privacy section.
- [ ] **Terminal screenshots and one short GIF**, captured from a real session in Windows Terminal at 120 columns, dark: the Chat view with one approval card; the band with a finished run; the Library Inbox. Optionally the 2D Order, only once A6 and the art check pass. PNG or GIF only (F23). Keep each image out of hook code paths.
- [ ] **Privacy and security section** (scoped, no absolutes). Draft:

  > Legion Mod's own code, in both of its plugins (legion-mod and legion-mod-runner), does not call `$.http.fetch` or `$.process`, so it makes no web requests and starts no programs itself. You can check: `claude plugin validate` lists every mods-API call the code makes, and Claude Code refuses to load a mod whose calls it cannot list. (Starting an agent or asking a model goes through Claude Code to Anthropic, the same as your own prompts.)
  > The agents Legion Mod starts are Claude Code subagents. They talk to Anthropic through your Claude Code session and use your tools (shell, edits, web) under your own permission rules. Each agent's approval mode is shown (ask, auto-edits, or full), and Legion never uses `bypassPermissions`. Your deny rules take precedence over Legion's approvals. (That last sentence is written only after spike S3 passes; until then, leave it out.)
  > Legion Mod reads and writes its own files in `~/.legion-mod/`, and reads the desktop app's Library only when you import it. It holds no keys or tokens.
  > A mod runs with your permissions and is not sandboxed. Check what this one does yourself: clone the repo and run `claude plugin validate .`.

- [ ] **Licence, in each plugin folder:**
  - `LICENSE` (Apache-2.0) and `NOTICE` (attribution for the vendored Legion files; in `legion-mod` also the busts and Grenze Gotisch under OFL 1.1);
  - `licenses/OFL.txt` in `legion-mod` (A7);
  - `license: "Apache-2.0"` in both `plugin.json` files.
- [ ] **Metadata:** both `plugin.json` files set `description`, `author`, `homepage` (the getlegion.xyz mod page) and `repository` (the mirror).
  - `legion-mod`: `displayName: "Legion Mod"`, `keywords`: `agents`, `multi-agent`, `orchestration`, `knowledge-graph`, `mod`.
  - `legion-mod-runner`: `displayName: "Legion Mod Runner"`.
- [ ] **Listing copy:**
  - `legion-mod` short description: "Legion's thirteen agents, shared Library, rooms and project board, inside Claude Code."
  - `legion-mod-runner` short description: "Starts and stops Legion's agents for Legion Mod. Install Legion Mod, not this."
  - Long descriptions: each README's first paragraph.
- [ ] **Gates and the real-PC run.** The product plan's §10 checks are recorded in `claude/tracker-pc-checks.md` and passed. Also: install from the live mirror on a clean profile; update from the previous version. Do not call anything "verified" before its check is recorded.
- [ ] **Kodawari pass** on the README, the screenshots and every claim, against the shipped build.

### Launch day (owner posts; drafts below follow the copy rules)

- **Changelog / GitHub Release (mirror):** effect-first notes, per `docs/RELEASE-NOTES.md`.
- **X / LinkedIn draft:**

  > Legion Mod for Claude Code is out. Legion's thirteen agents, its shared Library, rooms and project board now run inside Claude Code itself, in a terminal or the Desktop Code tab.
  > Install: `claude plugin marketplace add dnh33/legion-mod`, then `claude plugin install legion-mod@legion` (it brings its small companion, legion-mod-runner, with it).
  > Its own code makes no web requests of its own and starts no programs; `claude plugin validate` shows the full list of what it calls. Early release, expect rough edges.

- **Reddit / forum draft:** the same facts plus one screenshot, and "it is a mod, so it runs with your permissions; here is how to check what it does".
- **14+ days later:** submit to awesome-claude-code through its issue form (human-submitted).
- **When ready:** submit to the directory (§3b): two submissions, runner first.

## 7. Owner decisions

1. **D1 Repo strategy.** *Recommended:* develop in `dnh33/legion` under `mod/` and `mod-runner/`; release to the mirror `dnh33/legion-mod` with `scripts/export-mod.mjs` (§2, option D). Fallback: option B (no second repo, `git-subdir` catalog).
2. **D2 Plugin name (permanent, F13).** *Recommended:* `legion-mod`, `displayName` "Legion Mod". It avoids the `mcp__legion` namespace and permission-rule overlap with the desktop server (F17, F18). Decide before the first public push.
3. **D3 Marketplace name.** *Recommended:* `legion`, so the install id is `legion-mod@legion`. A later second plugin can join the same catalog.
4. **D4 Data root.** *Recommended:* `~/.legion-mod/`. Not a folder inside `~/.legion`, because the desktop's `uninstall -Purge` deletes `~/.legion` recursively (F30). It is also not `${CLAUDE_PLUGIN_DATA}`, which uninstall deletes (F19).
5. **D5 Version line.** *Recommended:* independent semver from `0.1.0`, `version` in `plugin.json` only, no lettered patches, tags `legion-mod--v<x>`.
6. **D6 Where Releases live.** *Recommended:* GitHub Releases only on the mirror; in `dnh33/legion` tags only, never a Release, so `releases/latest` stays the desktop's (F30).
7. **D7 Issue tracker.** *Recommended:* one tracker on `dnh33/legion` with a `mod` label; issues off on the mirror.
8. **D8 Directory submission.** *Recommended:* yes, from your claude.ai account, after 0.1.x has been in use for about two weeks with no data-loss bug.
   - Two submissions from `dnh33/legion-mod` (paths `plugins/legion-mod-runner`, then `plugins/legion-mod`), both tracking the mirror's `main`.
   - You do the portal steps (§3b).
   - Expect a possible "known brand" hold (U2).
   - First check U7: whether a claude.ai install of `legion-mod` pulls in the runner.
9. **D9 Cross-promotion.** *Recommended:* README sections both ways plus one getlegion.xyz page; no in-app promotion in the desktop for v1.
10. **D10 Minimum Claude Code version.** *Recommended:* 2.1.287, stated in the README and checked by `/legion doctor`. Confirm your build first (U1).
11. **D11 2D frames in the release.** *Recommended:* ship them only once they fit the directory's file rules (each non-image file under 256 KiB, 512 files or fewer, A6). Otherwise ship 0.1.0 without 2D and add it in a MINOR.
12. **D12 Community posting.** *Recommended:* you post, from the drafts in §6; no automated posting.
13. **D13 Companion plugin name (permanent, F13).** *Recommended:* `legion-mod-runner`, `displayName` "Legion Mod Runner". Its tools, if any, are `mcp__legion-mod-runner__*`. Decide before the first public push, together with D2.
14. **D14 How the two plugins are tied.** *Recommended:*
    - `legion-mod` declares the runner in `plugin.json` `dependencies` with a `~<major>.<minor>.0` range;
    - both plugins share one version, bumped and tagged together;
    - both live in one mirror catalog, so a single `claude plugin install legion-mod@legion` installs and enables both.

    Not recommended:
    - a separate bundle plugin (it adds a third name and buys nothing);
    - asking users to install two plugins by hand.
