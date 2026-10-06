# ADR 0012 — House rules you can switch, and skills Legion ships

**Status:** accepted · **Date:** 2026-10-06 · **Amends:** ADR 0009 (the house context layer), ADR 0011 (derive trust from the source)

## Context

The house layer (ADR 0009) was all or nothing. Every agent got every file. The owner could not turn one rule off.

Skills were the second gap. The owner parked skills on 2026-10-04 (item D5 in the tracker). The research then said a
skill needs a global, project and personal hierarchy, and that Claude's native skill option cannot serve a provider
agent. On 2026-10-06 the owner un-parked it, with a narrower first step:

- skills reach agents through the house tools, so the trust check and the taint stay;
- every shipped skill is OFF by default, and each user turns on what they want;
- the switches are global now; per-agent overrides come later;
- the core rules stay on.

Facts from the code and the SDK that shaped the design:

- An agent runs as the same OS user and can write any file under `~/.legion` (ADR 0011 says so).
- The SDK's `skills` option only works for the Claude runtime. A provider agent has no file tools, so it would get nothing.
- The SDK's skill list is a context filter, not a wall: the files stay readable with `Read` or `Bash`.
- Skills in the wild may ship scripts, and some read secrets or push code.

## Decision

**1. Every house rule gets a switch, except the core rules.**
`AGENTS.md` and `CONTEXT.md` are locked on. Every agent reads them first, and a house without them is broken. The route
refuses to switch them off and the screen shows a lock.

A switched-off file is not listed, not readable and not returned by recall. It answers exactly like a file that does not
exist, so an agent is not told a rule is being withheld.

**2. Legion ships skills as plain files.**
They live at `skills/<group>/<name>/SKILL.md`, with an optional `references/` folder and the upstream licence. They are
vendored and pinned: `skills/SOURCES.md` lists the upstream repo, the path, the commit, the licence and every edit. All
of them are edited for Legion's tools and wording. Nothing is fetched at runtime.

**3. Every skill is OFF by default.**
Skills from Legion are opinionated. A fresh install lists no skill and says nothing about skills in the preamble.

**4. Skills are served only through `house_skills` and `house_skill`.**
They never come through `house_list`, `house_read` or `house_recall`, so a skill that is off cannot be read by guessing
its path. The trust model is unchanged: shipped and adopted bytes are trusted, anything else is wrapped as untrusted.
A load taints the run, like every house read. A skill's description in the list comes from its own frontmatter only while
the bytes are Legion's; for an edited file the list withholds it, so an edited file does not write the first thing an
agent reads about it.

**5. The switch state is `<dataDir>/.house-switches.json`.**
It sits one level above the layer, in the same place as `.adopted.json` and for the same reason as ADR 0011. It is
changed only by admin routes (`POST /api/house/switch`, `POST /api/house/switch/reset`). No tool changes a switch. If a
run could, "the owner turned it on" would mean nothing.

**6. A switch is a serving filter, not a deletion.**
`syncContext` still copies every shipped file. Upgrades, re-enabling and a later sync are safe, because nothing was ever
removed.

**7. Legion never runs a skill's scripts, and nothing downloads at runtime.**
The packaging copies only `.md` files from `skills/` (`scripts/stage-layer.mjs`, the same filter as the sync). The
shipped skills carry no scripts. The licence texts are named `LICENSE.md` (and `LICENSE-<name>.md`) precisely so they pass
that filter and travel with the skill: MIT and Apache-2.0 require the notice to ship with the text. A test asserts every
shipped skill folder carries one, in the repo and in the staged layer. The screen shows it as the skill's Licence link.

**8. Rejected for now: the SDK's native skills.**
They would work for Claude agents only. Skill text would reach the model without the taint and the trust wrapper, and an
agent with `Bash` could read an unlisted skill anyway. They may come back as a second path for Claude agents later; they
would need their own switch state and their own taint.

**9. On the screen, this layer is called Doctrine.**
The owner's screen is **Settings → Doctrine** ("The rules and skills your agents follow"). Internally it stays the house
context layer: the `house_*` tools, `/api/house` routes, file names and code identifiers do not change. Groups carry a
themed name and a plain hint that is always visible: Core tenets (always on), Drills (skills agents can use),
Foundations (how Legion is built), Decrees (decisions on record), Chronicle (release history), Lore (facts and data),
Your orders (files you added). Skill sub-groups keep plain names. A skill is still called a skill in sentences.

**10. Deferred: per-agent and per-project overrides.**
Switches are global in this release. The owner asked for a hierarchy; this is the first layer of it.

## The limit, stated plainly

The switch file is not a wall. A process running as the same OS user can write `.house-switches.json`, as it can write the
adoption file (ADR 0011). That is accepted for the same reason: what a forged switch can turn on is still served through
the trust model and still taints the run. A forged switch cannot make a skill's text trusted if the bytes are not the
shipped bytes, and it cannot grant a tool or an approval. What it can do is put more opinionated text in front of an agent
than the owner chose. The owner sees the real state in Settings, which reads the same file.

## Consequences

- Every skill the owner turns on costs prompt space for every agent that loads it. Skill bodies run to thousands of
  characters. There is no per-agent budget yet.
- The owner's choice is global. A skill that suits Builder but not Scout cannot be limited to Builder until per-agent
  overrides exist.
- A skill folder can only be updated by shipping a new Legion build with a new pin. That is slow on purpose.
- A skill's own references to other tools (`ci_status`, `ci_wait`) point at tools that arrive in Release B. Until then
  the CI skills tell the agent to ask the owner. Anyone adding a skill must check its wording against the tools Legion has.
- Wording in a shipped skill is still text an agent follows. Review each one for steps that push, merge, download or read
  secrets before it enters `skills/`. The edits recorded in `SOURCES.md` are that review.
- File matching uses the real name on disk, lower-cased, because Windows and macOS are case-insensitive. A path spelled
  another way (different case, an 8.3 short name) must resolve to the same real file before the switch is checked. The
  8.3 and NTFS stream spellings can only be proven on Windows, so they are real-PC checks
  (see `claude/tracker-pc-checks.md`), not claims.
- Not done here: a count of each skill's token cost in the screen, a search over skill text, and a path for the
  owner's own skills. Only the shipped `skills/` folder is a skill group.
