# Public-repo audit (history + licences)

Run 2026-10-02 on branch `claude/release-packaging` (from `rel2`), before the repo goes public.
Scope: all 77 commits reachable from every ref (`git log --all -p`, about 17 MB of patch text), every blob in the object store, and the HEAD tree. No secret value is printed here; where one had to be named it is cut to a prefix.

## Verdict

**No real secret, token, personal data or `.legion` data was found in history. No history rewrite is needed.** The findings below are all low or informational. Two licence items (NOTICE gaps) are fixed in this branch; one needs an owner decision.

## 1. History scan

Method: regex scans of the full patch text for `sk-`, `gh[pousr]_`, `github_pat_`, JWT shape (`eyJ…`), `AKIA…`, Slack tokens, PEM private-key headers, `api_key|secret|token|password|bearer|authorization = <20+ chars>`, `bk_`/`boat_` key prefixes, 40-64 char hex strings, quoted 32+ char strings, BSV addresses and txids, 12-word seed-like runs, e-mail addresses, Windows/Unix home paths, IPs; file-name scan for binaries, keys, databases, `.env`, `state.json`, `config.json`, `core.log`, `messages/`; blob-size scan; author and commit-message scan.

| # | Severity | Where (file, commit range) | What | Action |
|---|---|---|---|---|
| H1 | Info | `test/*.test.ts` (many commits, e.g. the boat.dev VM fix rounds) | Fake keys used as test fixtures: `bk_live_…` (5 distinct, all words like `SECRET`, `ROUND`, `SHOT`, `TOPS`, `HTTP`, 21-29 chars), `boat_sk_live_0123456789abcdef`, `sk-live-abc…`, `ghp_` + `'a'.repeat(30)`, `Bearer supersecret-token-1234`, `'abcd…'` (a truncated token). They exist so redaction tests can prove the value is scrubbed. None is a real credential (all obviously placeholder, wrong length or pattern for the real services). | None. Optionally ask the boat.dev account owner to confirm no real key starts with `bk_live_`. |
| H2 | Info | `src/core/kg/seeds/bsv.json` (about 30 versions), hashes `sha512-…` in `package-lock.json` | Matches for "long random-looking strings" are node ids (`e-bsv-…`) and npm integrity hashes. | None. |
| H3 | Info | `test/bsv-*.test.ts`, `src/core/kg/seeds/bsv.json` | The 12-word phrase `abandon ability able about above absent absorb abstract absurd abuse access accident` appears in tests. It is a run of the first words of the public English BIP-39 list used to test the seed-phrase refusal; it is not a wallet. Three key-shaped strings are also in the tests and in history, all well-known **published test vectors, not wallet material**: a WIF starting `5Hue` (`test/bsv-audit.test.ts`, `test/bsv-review-pack.test.ts`), a WIF starting `L1aW` (`test/library-review-secrets.test.ts`) and a BIP-32 master key starting `xprv9s21` (`test/library-review-secrets.test.ts`, `test/library-graph.test.ts`), plus the `tprv8Zgx` testnet vector next to it. They are used to test that Legion refuses keys. Because they have the shape of real keys they **may trip GitHub secret scanning or other scanners**; the current tests build them from two pieces (`'xprv' + '9s21...'`) so the literal no longer matches, but the full strings remain in earlier history. No real BSV address or txid; nothing for wallet port 3321 beyond documentation and test tripwires (the repo bans the number in `src/`). | Keep as is; if a scanner flags the history, dismiss it as a published test vector. The documented wallet prohibition holds in history. |
| H4 | Low | commit `8bb5d1f` message ("delivered to D:/bots/legion-v5"); `docs/BSV-WALLET-DESIGN.md` ("Written for Daniel (the owner)") | Mentions a local folder on the owner's PC and the owner's first name. Not sensitive; but it is in the permanent record. | Accept, or fix wording going forward. A rewrite is not worth it for this. |
| H5 | Low | commit authors | Three identities: `m <a@b>` (64 commits), `Rune <rune@localhost>` (12), and `dnh33 <3074491+dnh33@users.noreply.github.com>` (1, a GitHub noreply address). No real personal e-mail. `rune@localhost` and `a@b` are placeholders. | Accept. The only e-mail in the tree besides placeholders is `noreply@anthropic.com` in `Co-Authored-By` trailers. |
| H6 | Info | `test/blender-*.test.ts`, `ui/dev/mock-server.mjs` | Windows paths with a user name: `C:\Users\Dan\…`, `C:\Users\you\…`, `D:\SteamLibrary`, `D:\Apps\Blender 5.1`, `D:\mine\Blender 4.2`. Test fixtures and mock data; `Dan` is a generic name. | None. |
| H7 | Info | tree and history | Private-network and test IPs (`127.0.0.1`, `10.0.0.x`, `192.168.1.x`, `203.0.113.x`, `169.254.169.254`) appear only in SSRF/loopback tests. | None. |
| H8 | Info | history | No `.legion` directory, `config.json`, `state.json`, `messages/`, `core.log`, `.env`, key, database, archive, installer or executable was ever committed. `.gitignore` covers `.env*`, `*.log`, `dist`, `node_modules`, shots. The task history / agent data of the owner is not present. | None. |
| H9 | Info | blobs | Largest blobs: `docs/demo/muster-lab/index.html` 4.3 MB (generated art lab, tracked), `docs/images/*.png` about 0.6 MB each, `src/core/kg/seeds/bsv.json` up to 0.48 MB per version, `assets/icon.png` 0.39 MB. Pack size 13 MB, working tree about 24 MB. Nothing binary that is unexpected. Deleted-but-in-history files are `test-perf/chat-ui/shots/*.png` (mock UI shots, now ignored). Screenshot `docs/images/app-dark.png` was viewed: mock agents and tasks (Zealot/Builder/Scout), no personal data. Other screenshots were not individually viewed (out of scope; do not touch). | None. |
| H10 | Low | `src/core/kg/seeds/bsv.json`, `test/fixtures/bsv-v1-nodes.json` | Seed `sources` cite `legion-specs/legion-bsv-kit.md` and `legion-specs/bsv-wallets.md`, private notes that are not in this repo. The reference is dangling. | Optional: reword on the next pack bump (pack version change required, so not done here). |

Not checked: the GitHub-side state (issues, PRs, Actions logs, forks, other repos), because this session has no GitHub API for history beyond the clone. `mcp__github__run_secret_scanning` was not run. Run GitHub's secret scanning / push protection once the repo is public, or beforehand with a private scan. Only one branch (`rel2`) exists on the remote; this audit therefore covers one history.

## 2. Licence compliance

### Own licence
`LICENSE` is MIT, "Copyright (c) 2026 Legion contributors". `package.json` says `MIT`. Consistent.

### Third-party npm dependencies (from `package-lock.json`)
Production: `@anthropic-ai/claude-agent-sdk` (+ 8 optional per-platform packages), `@modelcontextprotocol/sdk`, `zod` and their transitives. Dev: `electron`, `react`, `react-dom`, `typescript`, `vite`, `@vitejs/plugin-react`, `@types/*`.

| Licence in lockfile | Count | Remark |
|---|---|---|
| MIT | 207 | fine |
| ISC | 14 | fine |
| BSD-2-Clause / BSD-3-Clause | 2 / 3 | fine (`json-schema-typed`, `fast-uri`, `qs` are production) |
| Apache-2.0 | 3 | `typescript`, `sumchecker`, `baseline-browser-mapping`, all dev only |
| Unlicense | 1 | `fast-sha256`, production |
| CC-BY-4.0 | 1 | `caniuse-lite`, dev only (data) |
| `SEE LICENSE IN README.md` / `LICENSE.md` | 9 | `@anthropic-ai/claude-agent-sdk` and its platform binaries: Anthropic's own terms, not an OSS licence |

**No copyleft (GPL/LGPL/AGPL/MPL/EPL/SSPL) in the npm tree.** No package without a licence field.

| # | Severity | Finding | Action |
|---|---|---|---|
| L1 | Medium (docs) | The Claude Agent SDK is under Anthropic's commercial terms (not open source). It is a dependency installed from npm, never vendored in this repo, so publishing the repo does not redistribute it. A setup that builds an installer containing `node_modules` would. NOTICE already says it is subject to Anthropic's terms. | NOTICE sharpened: says explicitly that it is not open source and must not be re-bundled in a binary release without Anthropic's permission. |
| L2 | Low | NOTICE said TypeScript is MIT. It is Apache-2.0 (dev only). | Fixed in NOTICE. |
| L3 | Low | The UI bundle (`dist-ui`) inlines React, React-DOM and other MIT code; MIT requires the notice to travel with copies. Today nothing is redistributed as a binary (setup builds on the user's machine from source), so the source tree plus `node_modules` carries the licence texts. A future prebuilt installer would need a generated third-party notices file. | Documented in NOTICE; no action for a source-only release. |
| L4 | Low | Electron (Chromium, FFmpeg, V8 etc.) is downloaded by `npm ci` into `node_modules/electron/dist` and carries its own `LICENSE` and `LICENSES.chromium.html`. Not in the repo. | NOTICE now says so. |
| L5 | **Medium, owner decision** | The BSV knowledge pack (`src/core/kg/seeds/bsv.json`, 157 nodes, shipped in the repo and loaded when BSV mode is on) is Legion-written text that summarises third-party material. Its own source tags record the licences: CC BY 4.0 (`b-open-io/1sat-university`, 12 nodes: attribution required), Open BSV License v4-6 (ts-stack, wallet-toolbox, Teranode, BRC index, 60-plus nodes: a modified MIT that limits *use of the licensed code* to BSV; for prose summaries the practical duty is to keep the notice), MIT (several), "unverified" (docs.bsvblockchain.org, ARC, 1Sat docs, bap, HandCash, DeepWiki pages, bsv-skills-center with no LICENSE file; **counted by the independent review: 133 of 157 nodes have at least one source tagged unverified or "no LICENSE file", 91 nodes have only unverified or no-licence sources, and 24 nodes cite the private `legion-specs` documents**) and news articles summarised in own words. | NOTICE now has a "BSV knowledge pack" section with attribution for the CC BY 4.0 source and the pointer to the per-node `sources` field. **The "unverified" nodes (133 of 157 have at least one; 91 have only such sources) are a residual risk; the pack says to rewrite in fresh words, which it does. Owner should decide whether that is acceptable for a public repo or whether the unverified nodes should be re-checked or removed (needs a pack version bump, so not done here).** |
| L6 | Low | A DeepWiki (third-party, AI-generated) page is cited as a source for 7 nodes. | Same decision as L5. |
| L7 | Info | Fonts: IBM Plex Sans, JetBrains Mono, Grenze Gotisch, all OFL-1.1, bundled as WOFF2 in `ui/src/fonts/`; `licenses/OFL-1.1.txt` is present and NOTICE has the copyright lines. The OFL asks for the copyright notice and licence to accompany the fonts: satisfied by NOTICE + `licenses/`. Not renamed, not sold alone. Fine. | The OFL text file is a generic text; the per-family copyright lines are in NOTICE. OK. |
| L8 | Info | Design inspiration from OpenMausBot (Apache-2.0), "no source code copied". Nothing to attribute in code; NOTICE credits the ideas. Not verified beyond that statement. | None. |
| L9 | Info | Artwork (Relic mascot, icons) is declared original and MIT. Cannot be verified from here; Zealot's art is untouchable per the rules. | Owner confirms the artwork is theirs to license. |

### Downloaded-not-bundled Blender sources (checked against `docs/BLENDER.md`, `SECURITY.md`, `src/core/blender`)
- The official Blender Lab MCP server (GPL-3.0-or-later) is downloaded only when the user presses Set up, from a pinned tag archive with a pinned sha256, into `<data dir>/blender/official/`. It stays a separate program talked to over stdio/socket. No copy exists in the repo or history (checked: no Blender, `.blend`, `.zip` or Python add-on file was ever committed).
- The community add-on (MIT) is downloaded the same way, from a moving upstream branch, trust-on-first-use. Not shipped.
- Headless Blender (GPL) is downloaded inside the user's VM on request.
- The description in `docs/BLENDER.md`/`SECURITY.md` matches the code behaviour as far as it can be read from docs; `NOTICE` did not mention Blender at all, which was a gap. Added a Blender section: what is downloaded, from where, licences, that Legion never bundles it, and that downloaded GPL code remains separate. The existing line "Get a proper licence check before you redistribute a build that includes any downloaded component" is kept.
- Python scripts in `scripts/` use only the standard library.

## 3. Recommendation
Go public after: (a) the owner decides L5 (unverified BSV pack sources), (b) GitHub secret scanning is switched on for the public repo, (c) the owner is happy with H4/H5 (first name, local folder, noreply address in history). **History rewrite: not recommended; nothing sensitive found.**

## 4. OWNER DECISION: BSV knowledge pack licence position (not decided here)
NOTICE currently says the pack "summarises public documentation, in our own words" and that for unverified sources "no text copied". The independent review could not verify "no text copied" for the 91 nodes whose only sources are unverified or have no licence file, and it cannot be proven from the repo. This file does not change the NOTICE wording. The owner picks one:
1. Ship as is (low practical risk, since the pack is prose summaries).
2. Soften the NOTICE sentence to "written in our own words from public documentation; the licence status of some sources was not established".
3. Remove or re-source the 91 nodes (needs a pack version bump).
