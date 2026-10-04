# Working on Legion with more than one agent

**The incident that wrote this (2026-10-04):** two sessions in `D:\bots\legion` at once destroyed real, uncommitted
work. The mechanism matters more than the outcome, because it is recognisable.

## When this applies

- Any time another agent or session may be working in the same repository.
- Before `git stash pop`, `git checkout --`, `git restore`, `git clean`, or deleting anything untracked.
- Choosing where to work.

## The mechanism, so you recognise it

1. Session A runs `git stash pop` to recover its own work. **The stash top is session B's.**
2. B's in-progress files land in A's working tree.
3. A sees files it did not create, on a branch it did not check out, and "tidies up".
4. **B's uncommitted work is destroyed.** Tracked files survive in a stash or another branch. **Untracked files do
   not survive at all** — no git object, no reflog, gone.

## The rules

**Never restore, stash, clean or check out a path you did not create.** "Not mine" means *leave it*, not *delete it*.
The cost is asymmetric: a stray file costs one `git status` line; deleting one costs another session's day.

**Know which directory is which before you touch anything.** This was got wrong repeatedly in this session — by the
owner, and by me. Verify with `git rev-parse --git-common-dir` rather than trusting a name or a memory:

```
D:/bots/legion-dev      a STANDALONE CLONE, sitting on branch claude/trailer-v2-build.
                        NOT canonical. Nothing ships from here. Do not build, test or edit in it.
D:/bots/legion          a WORKTREE on `main` — this is what ships and what releases are cut from.
D:/bots/legion-<topic>  topic worktrees: git worktree add D:/bots/legion-<topic> <branch>
```

`git worktree list` run from `D:/bots/legion-dev` lists all of them, each with its branch. **Verify the branch before
reading code for review or audit**: an audit that reads a topic worktree and reports line numbers for `main` produces
citations that are wrong the moment the branch differs — which is how a review of the shipped release can be conducted
against unshipped code.

**Read-only use of a non-canonical clone is fine; building, testing or editing in it is not, while peers are active.**

**Before declaring anything lost, run `git log --all --oneline -- <path>`.** Worktrees and stashes are not the only
places a file lives. Concluding "unrecoverable" after checking only those is how an already-committed file gets
deleted and then painstakingly restored from a transcript.

**Recovery that worked:** session-history search on the other session's id, then read the `write_file` payload back
verbatim. Agent transcripts retain full tool-call arguments, so an untracked file another agent wrote can be recovered
byte-identically. Try that before telling the owner something is gone.

**Do not report a peer's state from one observation.** In that incident a peer's `dist/` was mid-rebuild, so one run
showed three failures that did not exist; a minute later the same suite was 51/51. Re-read before asserting, and say
when a reading was stale.

**There is no cross-session messaging tool.** Separation must be *structural* — distinct worktrees — not a message.
Put agreements somewhere durable and visible (the owner's vault), never in the
public repo.

## The worktree and node_modules traps

**Worktrees share one real `node_modules` via a junction.** `rm -rf` on a path containing that junction deletes
*inside the shared tree* — on 2026-10-04 this removed a worktree's link and made `npm test` die with a bare
`'tsc' is not recognized`, which reads like a broken repository rather than a deleted link. Remove worktrees with
`git worktree remove --force <path>`. Never `rm -rf` a directory that contains a `node_modules` junction.

**Before deleting a worktree, prove it holds nothing unrecoverable.** A merged branch does **not** mean a clean working
tree — one worktree had its branch fully merged and still held 15 modified and 3 untracked files. Check
`git status --porcelain` per worktree, not just branch ancestry.

**Keep the count down.** Most worktrees are leftovers from finished branches. Merged-and-clean is the only safe
condition for removal; unmerged branches keep their worktree until they land.

## Provenance stays out of the repo

Legion is public on GitHub. The context engine whose behaviour `docs/COMPACTION.md` implements is named **nowhere**
in the repository — not its name, licence, path, comments, docs, commits or tests. A grep of the repo for its name
must return nothing. The detail lives outside, and a session needing it asks the owner.