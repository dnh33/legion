# Working on Legion with more than one agent

## When this applies

- Any time another agent or session may be working in the same repository.
- Before `git stash pop`, `git checkout --`, `git restore`, `git clean`, or deleting anything untracked.
- Choosing where to work.

## Never touch a path you did not create

**Never restore, stash, clean, check out or delete a path you did not create.** "Not mine" means *leave it*, not
*delete it*. The cost is asymmetric: a stray file costs one `git status` line; deleting one costs another session's day.

**Untracked files do not survive a mistake; tracked ones do.** A tracked file lives on in a stash or another branch.
An untracked file has no git object and no reflog — it is gone.

## Never claim a path you did not create

The five verbs above are destructive. `git add` is not, and that is why it is the one that gets missed: committing a
peer's untracked file destroys nothing, so it feels safe, and the only thing it costs is **truth**.

**Never `git add -A`, `git add .` or `git commit -a` in a shared tree.** Stage by path, from what you wrote. Learned
the hard way on 2026-10-04: a ladder-rewrite commit message shipped alongside a peer's V8 heap limiter, five files I
never wrote, because `add -A` swept them in. The code was fine and the tests passed — which is exactly why nothing
caught it. A commit message that does not describe its contents is a permanent, published lie, and the owner reads it.

**Before every commit, read what you are about to stage:** `git diff --cached --stat`. If a path is not one you edited
this session, do not stage it. If it is genuinely wanted, it gets its own commit with its own message — never someone
else's work under yours.

**Untracked is not orphaned.** An untracked file belongs to whoever is mid-task in it. Leaving it alone is correct;
committing it is not a favour.

## Know which directory is which

Verify with `git rev-parse --git-common-dir`, never a name or a memory:

| Path | What it is |
|---|---|
| `D:/bots/legion` | WORKTREE on `main`. Canonical: what ships, what releases are cut from. |
| `D:/bots/legion-dev` | STANDALONE CLONE, another branch. NOT canonical. Never build, test or edit in it. |
| `D:/bots/legion-<topic>` | Topic worktree: `git worktree add D:/bots/legion-<topic> <branch>` |

`git worktree list` lists all of them with their branch. **Work in a worktree while peers are active:** read-only use of
a non-canonical clone is fine; building, testing or editing in it during that time is not.

**Verify the branch before reading code for review or audit.** An audit that reads a topic worktree and reports `main`
line numbers is wrong the moment the branch differs.

## Before declaring anything lost

**Run `git log --all --oneline -- <path>`.** Worktrees and stashes are not the only places a file lives; concluding
"unrecoverable" after checking only those deletes an already-committed file.

**Recover untracked files via session-history search** on the other session's id, then read its `write_file` payload
back verbatim. Agent transcripts retain full tool-call arguments, so a file another agent wrote is recoverable
byte-identically.

**Do not report a peer's state from one observation.** A mid-rebuild `dist/` showed three failures that did not exist;
the same suite was green a minute later. Re-read before asserting.

There is no cross-session messaging tool. Separation must be *structural* — distinct worktrees. Put agreements
somewhere durable and visible (the owner's vault), never in the public repo.

## The node_modules junction trap

Worktrees share one real `node_modules` via a junction. `rm -rf` on a path containing it deletes *inside the shared
tree* and makes `npm test` die with a bare `'tsc' is not recognized` — a deleted link, not a broken repo.

**Remove worktrees with `git worktree remove --force <path>`.** Never `rm -rf` a directory containing a `node_modules`
junction.

**Before deleting a worktree, prove it holds nothing unrecoverable.** A merged branch does not mean a clean tree —
check `git status --porcelain` per worktree, not branch ancestry. Merged-and-clean is the only safe condition for
removal; unmerged branches keep their worktree until they land.

## Provenance stays out of the repo

Legion is public on GitHub. The context engine whose behaviour `docs/COMPACTION.md` implements is named **nowhere** in
the repository — not its name, licence, path, comments, docs, commits or tests. A grep for its name must return
nothing. The detail lives outside; a session needing it asks the owner.
