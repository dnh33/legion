# Skills shipped with Legion

These are short how-to guides for agents (debugging, verifying work, code review, fixing CI). They come from open-source projects and are edited for Legion. `SOURCES.md` lists each source, commit and licence.

Every skill is OFF by default. The owner or user switches each one on in Settings -> Doctrine (the Drills group). Only enabled skills are listed to agents.

Legion never runs a skill's scripts. A skill is text that an agent reads. These skills ship no scripts.

To propose a new skill: open an issue or pull request with a `skills/<group>/<name>/SKILL.md`, the upstream licence text (saved as `LICENSE.md`), and an entry in `SOURCES.md` (repo, path, pinned commit, licence, edits). Only permissive licences that allow modification are accepted. Skills that push, merge, download and run code, or read secrets are not accepted.

Layout: `skills/<group>/<name>/SKILL.md`, an optional `references/` folder of short notes, and the licence text as `LICENSE.md` (a second one as `LICENSE-<name>.md`). Licence files must be `.md` so they ship with the skill.
