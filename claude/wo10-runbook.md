# WO-10 runbook (release path) — updated 2026-10-03

Concrete commands for the release, ready to fire in order. Gated on WO-4 (trailer merge, needs owner watch/listen) + a green Windows gate + disk space.

## 0. Prerequisites (confirm before starting)
- `integration/v1` green: Windows gate ~2384/0/45 (the `9ccbfb9` revert head — bsv tripwires 91/91 isolated ✓). Re-run full gate once disk is free.
- WO-4 done: owner watched the re-rendered trailer (chips stripped) → targeted merge `docs/video-v2/**` from `claude/trailer-v2-build` into `integration/v1` (branch is 24 behind; take ONLY the video dir + its timeline/check/render/score files).
- No `/code-review ultra` (owner 2026-10-03, $2k off the table) → I run the pre-tag review myself (code-review-excellence + kodawari + systematic-debugging + grill-with-docs + fresh deepseek subagents).
- **Updater arming (HARD gate, before tag):** `scripts/release-keygen.mjs` → paste the PUBLIC key into `src/core/updater/trust.ts` `UPDATE_KEYS` → rebuild → ship 0.2.0 *with the key embedded*. Empty `UPDATE_KEYS` fails closed ("this build has no update key, so updates are off"), so 0.2.0 users can only apply 0.2.1 in-app if the key ships in 0.2.0. Never the private key in the repo.

## 1. PR `integration/v1 -> main`
```
cd D:/bots/legion
git tag pre-merge-release && git push cloud pre-merge-release    # restore point
gh pr create --base main --head integration/v1 --title "Legion v0.2.0" --body "..."
```
- `main` is a fast-forward target (348 commits behind, no extra commits). CI (`ci.yml`) runs the **Linux gate** — first Linux run of the merged tree. Watch it; triage any Linux-only failures (no Windows flakes excuse).
- Report PR number to owner.

## 2. Deliver to NEW folder `D:\bots\legion-v6-7`
```
git archive --format=tar cloud/integration/v1 | tar -x -C "D:/bots/legion-v6-7"
# md5 manifest of every file, written to legion-v6-7-md5.txt (matches prior v6-6 checkpoint format)
```
- Never overwrite `legion-v6-6` or older.

## 3. Prebuilt package (plan `claude/plan-prebuilt.md`)
```
cd D:/bots/legion && node scripts/build-package.mjs    # ~270 MB zip, ~690 MB unpacked
```
- Preflight: Windows x64, Node >= 20.10, clean tree. Produces `legion-0.2.0-win-x64.zip` (full) + `legion-0.2.0-app.zip` (update) + `SHA256SUMS.txt` + manifest (unsigned — key is owner's).
- Test: unzip into a clean folder, clean data dir (`LEGION_HOME`), run `setup.cmd`, smoke-test `electron.exe` node-mode + `claude.exe --version`.

## 4. Register Legion MCP (user scope) — **owner's go, plan first, backup `~/.claude.json` first**

## 5. Real-PC plan (`claude/real-pc-test-plan.md`, 128 checks) — **with owner**
PC ids: PB1-PB10 (board), B17 (chip), BR15-BR24 (browser), V1-V12 (BSV testnet, by hand, tiny amounts, per-action go), R0-R11, ND1-ND12.

## 6. Tag `v0.2.0` — **owner's go only**
```
cd D:/bots/legion && git checkout main && git tag v0.2.0 && git push cloud v0.2.0
```

## 7. Cleanup
Stale local branches (`gate-*`, `fix/*`, `merge/*`), worktrees `legion-wt-win`, `legion-wt-winfix`, `legion-gate` (rmdir `node_modules` junction first).

## Standing rules (never relax)
- Wallet port never written literally in code or tests (tests build it as `Number('33'+'21')`); the repo never contacts the wallet; signing/spending needs the owner's go per action (amount + address).
- No "safe/secure/verified/cannot be bypassed" claims — scope everything ("Legion's own code …").
- bsV pinned files: no edits without the reviewer-signed pin recompute (`scripts/bsv-spend-pin.mjs`).
- One gate at a time in `D:/bots/legion-gate`; never two concurrent (clobbers `dist/`).