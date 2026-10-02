# Working on Legion (instructions for coding agents)

Legion is a local, Claude-only multi-agent desktop app: Electron shell, Node/TypeScript core on `127.0.0.1:4747`, React UI. Read `docs/ARCHITECTURE.md` first, then the doc for the area you touch (`docs/BLENDER.md`, `docs/BSV-MODE.md`, `docs/BSV-WALLET-DESIGN.md`, `docs/CHAT.md`, `docs/LIBRARY.md`, `docs/VM-NOTES.md`, `SECURITY.md`). Plans for work in flight are in `claude/plan-*.md`; the living tracker is `claude/legion-release-tracker.md`; checks that need the owner's Windows PC are in `claude/tracker-pc-checks.md`.

## If you run in a cloud session

- The owner's private knowledge vault (Aetherkeep) is NOT available in cloud sessions. If your instructions tell you to use it, skip that step: this file, the plans and the tracker are your context. Do not stop or complain about it.
- Your working copy disappears when the session ends. **Push your branch before you finish** (branch names `claude/...`). Never force-push, never delete branches, never rewrite history.
- Your base is the branch named in your task (usually `integration/v1`), not necessarily the default branch.
- No long `sleep` chains: wait with a monitor/until-loop on a condition.
- You cannot run Windows. Say what you could not verify; do not imply it passed.

## Gates (run before you say done)

`npm ci && npm run build:ts && npm test && npm run typecheck && npm run build:ui`. Report exact counts. A builder's own report is never the proof: an independent reviewer re-runs everything and tries to refute it (default "not fixed"). Every new test needs a negative: show by a temporary scratch mutation of the code, then revert, that it fails.

## Hard rules (do not weaken to make something pass)

- Admin gate (default-deny HTTP; the MCP bearer token reaches only the short client list), the per-launch native secret for BSV policy changes, taint wrapping of external content, and the tripwire and hedge tests (`test/bsv-scan.ts`, `test/bsv-tripwire*.test.ts`, `test/bsv-hedge.test.ts`) stay as they are. Child processes may be spawned only in files the tripwire lists.
- Never contact the owner's own BSV wallet port (the number is forbidden in source by test) from tests, scripts or agents. Keys never live in Legion; every spend is a manual, native confirmation. The owner's own funded wallet is only ever used by the owner by hand, with the owner present, for the real-funds check.
- No keys, tokens or `.legion` data in the repo, logs or reports. Redact any secret-shaped value to a short prefix.
- The mascot art (Zealot and the other painted busts) is untouchable: effects and logic only, never repaint.
- Do not create accounts, passwords or CAPTCHAs. Downloads and anything that spends money need the owner's explicit go-ahead.
- Wording: claims are scoped ("Legion's own code ...") and never absolute ("cannot be bypassed", "fully safe"). Review BSV and Blender safety code with a defensive framing (find gaps in controls, no exploit payloads).

## Decisions already made (do not re-ask)

Claude-only in v1 (Codex/ChatGPT listed under "Later"). Version 0.2.0. Public repo after the history audit. MCP isolation: `claude.inheritMcp` default off, strict MCP config. Bot-created rooms: member cap 6, no default spend limit. Key probe runs lazily. Builder VM size resets to `default` once on upgrade. BSV: spend tool with BOTH testnet and mainnet capability in v0.2.0 (mainnet hard-off by default, enabled only by a native-confirmed policy change plus Arm, and not called verified until the owner's real-funds check is recorded), native dialog for every spend, empty recipient allowlist, caps 1,000 sat/tx, 5,000/session, 10,000/24 h, unknown outcome blocks all spends until resolved, only runs started by the owner in the app may request a spend. Blender: local-first (headless Blender on the PC by default when found), VM and live as options. Details and the assumed-not-confirmed items are in the tracker and the plans.

## Lessons from earlier work on this codebase

- Windows is where tests break: use `fileURLToPath`, never `new URL(...).pathname`; Windows PowerShell 5.1 does not unroll a JSON array from `ConvertFrom-Json` (pipe through `ForEach-Object { $_ }`); file symlinks need privilege (use junctions or hard links in tests); `Path` vs `PATH` env case; never kill processes by name pattern on the owner's PC, kill by PID.
- ESM caches modules: a running server keeps stale code until restarted.
- Config and state migrations must be versioned, run once, and never override a later manual choice.
- Search ranking multiplies by a recency factor from the clock: pin the clock when comparing two Libraries.
- The knowledge-graph seed loader rejects licence strings over 200 chars and edges without id/createdBy/createdAt; run the full suite after merging seed changes.
- Verify the latest tree before building on it (stale folders have caused rework).
- Keep answers and reports short and plain; separate bugs from polish; say what is still imperfect.
