# House context layer — what shipped in this branch, and how it was verified

**Branch:** `fix/house-layer-packaging` · **Base:** `main` @ `0f89b2b` · **Worktree:** `D:\bots\legion-house`
**No push.** Nothing leaves this machine without the owner's approval.

## The question that started it

Is the layer's `[UNTRUSTED SOURCE]` marking going to make ordinary users approve things constantly?

**No.** The check only fires on *Legion's own* documentation (`AGENTS.md`, `docs/adr/*`, `SESSION-LOG`), which an
ordinary user never edits. Notes a bot writes go to the knowledge graph, which has a **separate** `untrusted` rule
and its own inbox. Two subsystems, one shared word — the release note used KG vocabulary for a house-layer mechanism.

The real user-facing gap was the inverse, and it turned out to be four defects that shipped together.

## Four defects, all reproduced against the released artifact

`v0.2.3-a-app.zip` downloaded from the published release. sha256 `26dcf4aa…ffdb`, matching the release digest and
`SHA256SUMS.txt` exactly. 397 entries, top level `CHANGELOG.md LICENSE NOTICE README.md SECURITY.md assets
build-info.json dist dist-ui licenses package-lock.json package.json scripts setup*.cmd start-legion.cmd`.

| # | Defect | Evidence before |
|---|---|---|
| 1 | Packaged install shipped no layer. `CODE_SET` packs `dist`, never the repo root. | sync wrote **0** files, **11 of 11** missing, layer = `.shipped.json` only |
| 2 | `.shipped.json` counted as a layer file, defeating the empty-layer guard. | `files.length === 1`, guard passed, 3 tools on an empty layer |
| 3 | `mcp__legion_house__` missing from `LEGION_TOOL_PREFIXES`. | `needsApproval('ask') === true` for all 3 tools |
| 4 | Manifest rebuilt each sync, so trust was a one-way ratchet. | revert to identical bytes → `isShipped` still `false` |

Plus: **the owner could never make their own file a rule.** Failing closed left the only trusted text as text Legion
shipped, so the layer was read-only in practice to the person who owns the machine.

## The fixes

1. **Stage the layer into `dist/context-layer`** (`scripts/copy-static.mjs`). `dist` is already in `CODE_SET`.
   Adding `docs` to `CODE_SET` would have shipped **85 MB** (66 MB demo video) for the **110 KB** of markdown the
   layer actually needs — 785× more.
2. **Trust manifests are not content** — excluded from `listContext`, so an empty layer reads as empty.
3. **`mcp__legion_house__` added to `LEGION_TOOL_PREFIXES`** — no more card to read a markdown file.
4. **Manifest carried forward.** An entry is the hash of what the app *shipped*, so it survives drift; `isShipped`
   compares current bytes, so drift reads untrusted and a revert matches again and trust returns on its own.
5. **Adoption** (ADR 0010): `shipped` / `adopted` / `untrusted`, decided by *who*. Content-addressed — approve a file
   and it is trusted; edit it and it is untrusted automatically. One door: an admin-gated route. **No MCP tool adopts.**
6. **`claude/skills` removed** from the layer — it was never shipped anyway, and `export-public.mjs` already excludes it.
7. **Settings → House context**, so adoption is reachable by a person at all. The button states that it approves
   *these words* and that an edit undoes it, because a quiet "trust this file" would misrepresent the mechanism.

## After, on a package-shaped install root

| | 0.2.3-a | this branch |
|---|---|---|
| expected-but-missing | 11 of 11 | **0 of 11** |
| layer files | 1 | **12** |
| `house_read AGENTS.md` | fails | **ok · trusted · kind=shipped** |
| `house_recall` | 0 hits | **8 hits** |
| edit → revert | stays untrusted | **reverts to shipped** |
| owner's file → approve | impossible | **adopted, unwrapped** |

## Verification

- **Full suite, clean `dist`, one run at a time: 2469 tests, 2422 pass, 2 fail, 45 skipped.**

  An earlier run reported 2 failures while a second suite was still running against the same `dist/`, which
  `AGENTS.md` forbids. A later clean run showed 4. A third clean run showed 2 again, and the 2 extra
  (`blender dispose`, `R7 boat admin`) pass on this branch in isolation, 45/45. They are load-sensitive, and
  the race is what provoked them.

- **Both remaining failures reproduce on pristine `main`** (extracted with `git archive`, no `.git`, no worktree,
  no other agent touched). `main` full suite: 2475 tests, 2427 pass, 3 fail — the third being an artifact of
  `git archive` leaving the packaging test without a repo to inspect.
  - `export-scrub` — a pre-existing PII leak: `claude/SESSION-QUEUE.md` line 29 holds
    `D:/Aetherkeep/06-projects/legion/`. **This is a real defect and it is not mine**: `export-public.mjs` is
    supposed to scrub the vault name and does not cover this file, so it would leak into a public snapshot.
  - `perf-l-store` F1 — a KG graph-store re-read count (3 vs 2), timing-sensitive; also fails on `main`.

- **House + routes + approvals suites: 71/71.**
- **Negatives: 8/8 mutations correctly red.** Each fix was reverted in source and the tests were seen failing:
  manifest rebuilt · merge launder · root-only sync · prefix dropped · manifests listed · adoption hash unchecked ·
  `claude/skills` restored · adopted content wrapped. Tree verified clean after all eight reverts.
- **Typecheck clean** (`tsc --noEmit`, core and ui). **`build:ui` clean.**
- **Test count differs from `main` by 6 in the other direction** (2469 vs 2475): `main` carries 6 tests from the
  compaction work merged after this branch was cut. This branch adds 30 house tests.

## Not verified here

- **No real package was built.** Verified against a package-shaped tree (CODE_SET names only) and the released
  artifact, not a freshly built `legion-*-win-x64.zip`. One build should confirm the staged layer ships.
- **No live run.** The MCP surface was not exercised in a running Legion — `claude/LIVE-TEST-0.2.3-a.md` steps 5–7
  need a real app and a real owner.
- **The pre-existing `export-scrub` failure is not fixed here.** It is a separate defect and should not ride along
  with this branch.