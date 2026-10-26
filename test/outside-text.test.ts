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
    assert.equal(outsidePathReason(join(r.proj, '.git', 'HEAD'), ctx(r.proj)), undefined, 'the project root is its own repository');
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
    mkdirSync(join(main, 'src'), { recursive: true });
    writeFileSync(join(main, 'src', 'a.ts'), 'x');
    const wt = join(r.base, 'wt1');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt1').replace(/\\/g, '/')}\n`);
    writeFileSync(join(wt, 'src', 'a.ts'), 'x');
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
    writeFileSync(join(nested, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt1').replace(/\\/g, '/')}\n`);
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
    assert.equal(outsidePathReason(join(spill, 'toolu_1.txt'), ctx(r.proj)), undefined);
    assert.match(outsidePathReason(join(r.base, '.claude', 'projects', 'c--work-proj', 'sess-1', 'other.txt'), ctx(r.proj)) ?? '', /outside/);
    assert.match(outsidePathReason(join(r.base, '.claude', 'settings.json'), ctx(r.proj)) ?? '', /outside/);
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
  for (const c of ['npm test', 'npx tsc --noEmit', 'node --test test/a.test.js']) {
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
  for (const c of ['gh pr create --fill', 'gh pr create --title "x" --body "y"', 'gh pr merge 5 --squash', 'gh pr ready 5', 'gh pr checks 5', 'gh run watch 123', 'gh run rerun 123']) {
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

test('F3: tools this module does not judge return undefined (the caller keeps its own rule)', () => {
  const r = rig();
  try {
    assert.equal(toolTaintReason({ toolName: 'Edit', input: { file_path: join(r.other, 'x') }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }), undefined);
    assert.equal(toolTaintReason({ toolName: 'WebFetch', input: { url: 'https://x' }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }), undefined);
  } finally { r.done(); }
});
