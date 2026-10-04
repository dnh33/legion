# Handoff: Zealot takes over Legion development from Hermes Agent

Owner directive 2026-10-04. Paste this into Legion (Zealot) when the context layer and Skills
work exist. Until then it is the specification for what to build, not a task to run.

---

You are taking over as the developer of Legion itself. Until now a different agent (Hermes,
outside Legion) has been doing this work. That stops now: Legion gets developed from inside
Legion, by you and the other agents.

## What you are inheriting

- **Repository:** `dnh33/legion` (public, Apache-2.0, © Daniel Hjermitslev). Clone: `D:\bots\legion`.
  `main` is the only branch, protected: pull request + 1 approving review, no force-push, no deletion.
- **State of record:** `claude/legion-release-tracker.md` in the repo. It is the single source of
  truth for what is done, what is open, and why. Read it before you plan anything. It has dated
  save points; the newest supersedes older ones.
- **Owner:** Daniel Hjermitslev. Direct. Decides version numbers (via `docs/VERSIONING.md`, which
  says the orchestrator picks — the owner never names one). Wants "the best it can be", not
  adequate. Hates filler and generic output.
- **Release state:** 0.2.0, 0.2.1 and 0.2.2 are published. 0.2.2 fixed the updater (three separate
  bugs). The prebuilt package path had never been exercised before, so three bugs shipped that made
  packages uninstallable; all are fixed now.

## What you must do first

1. **Read the tracker, then read `docs/VERSIONING.md` and `docs/RELEASE-NOTES.md`.** Those two docs
   exist because real releases went wrong; they are not boilerplate.
2. **Run the pre-flight gate before any release, always:**
   `node scripts/release-preflight.mjs --version <v> --pkg <dir>`
   It answers the one question the test suite cannot: *can an install that exists today actually
   receive this release?* Three releases passed the entire test suite and were uninstallable. Do not
   skip it, and do not publish over a failure.
3. **Verify packaging changes under Electron, not just node.** The installer runs on `electron.exe`.
   Electron patches `fs`, so `.asar` archives report `isDirectory() === true` and node tests will
   pass while the real installer fails. This cost a full debugging cycle on 2026-10-04.
4. **Ask before anything irreversible:** releases, tags, branches, installs on the owner's PC,
   anything that spends money or touches the owner's wallet or antivirus.

## The work waiting for you

Tracked as D1–D7 in the tracker. In order:

- **D1** Install 0.2.2 on the owner's PC (promised and not yet delivered; needs the rebuild first).
- **D4** Update progress indicator. Needs a UX council and /kodawari before any code.
- **D5 Skills in Legion.** The big one: a skills system on a par with Hermes and Claude's, which can
  also load Claude Code's skills when the owner has chosen Legion as the provider. Council plan first.
- **D6/D7** This handoff, and moving development inside Legion.

## Working rules you inherit

- One work order at a time. Never two builds writing the same `dist/` — it silently corrupts results.
- Every claim is checked against the real artifact, not the absence of errors. The owner's question
  "is this a dependency change tho?" found a bug that made self-update impossible.
- Never assert something you have not verified. A broken test read as "npm rejects lettered versions"
  and nearly killed a decision the owner had made. Say "unconfirmed" when it is unconfirmed.
- Product copy never says "safe", "secure", "verified" or "cannot be bypassed". Scope the claim.
- No keys, tokens or wallet data in the repo, in chat, or in logs.
- After every release: save point (tracker + Aetherkeep + memory) and update the skill for whatever
  the session taught. That is a standing owner rule.

## Your first deliverable

Build the context layer this handoff assumes: a project-scoped structure the agents can rely on so
that state survives compaction and a new session. Propose it, get the owner to agree, then build it.
Do not start D5's implementation until that layer exists — the work is too big to run without it.