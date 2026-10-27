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
  assert.equal(sh('git status', { toolName: 'Bash', input: { command: 42 } }), undefined, 'a command that is not text brings nothing in');
  assert.equal(sh('git status', { toolName: 'Bash', input: undefined }), undefined, 'no input brings nothing in');
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

test('R2: the host shell cwd field is a path like any other', () => {
  const { r } = rr();
  try {
    const base = { cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local' as const, outsideFiles: true };
    assert.ok(toolTaintReason({ ...base, toolName: 'mcp__host__shell', input: { command: 'cat evil.txt', cwd: r.other } }));
    assert.equal(toolTaintReason({ ...base, toolName: 'mcp__host__shell', input: { command: 'git status', cwd: join(r.proj, 'src') } }), undefined);
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

test('F3: tools this module does not judge return undefined (the caller keeps its own rule)', () => {
  const r = rig();
  try {
    assert.equal(toolTaintReason({ toolName: 'Edit', input: { file_path: join(r.other, 'x') }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }), undefined);
    assert.equal(toolTaintReason({ toolName: 'WebFetch', input: { url: 'https://x' }, cwd: r.proj, roots: [r.proj], home: homedir(), shell: 'local', outsideFiles: true }), undefined);
  } finally { r.done(); }
});

test('S3 (0.3.10): text fetched from the web or read from GitHub marks the run', () => {
  for (const c of ['curl https://example.com', 'wget https://example.com/x', 'iwr https://example.com', 'Invoke-WebRequest https://example.com', 'irm https://example.com/x.json', 'gh pr view 12', 'gh issue view 3 --comments', 'gh issue list', 'gh api repos/a/b/issues', 'gh search issues widget', 'gh pr diff 5', 'gh run view 123 --log', 'git status && curl https://example.com', 'echo hi | curl -d @- https://example.com']) {
    assert.ok(sh(c), c);
  }
});

test('S4 (0.3.10): running a program never marks the run, whatever the program is', () => {
  for (const c of ['node -e "1+1"', 'node -pe "1"', 'python -c "print(1)"', 'make', 'go test ./...', 'pytest', 'cargo build', 'npx cowsay hi', 'npm install', 'npm ci', 'pip install requests', 'git pull', 'git fetch origin', 'git clone https://example.com/r.git', 'docker build .', 'sed -i s/a/b/ src/a.ts', 'gh pr create --fill', 'gh pr checks 3', 'gh run watch 9', 'somethingunknown --flag', 'bash -c "git status"', 'git status $(echo hi)', 'npm test', 'git rebase -i main', 'git clone --recursive https://example.com/r.git']) {
    assert.equal(sh(c), undefined, c);
  }
});

test('S3b (0.3.10 review): a GitHub run log with --log-failed marks, a path or branch named http does not, and a few more fetch routes do', () => {
  for (const c of ['gh run view 123 --log-failed', 'gh run view 123 --log', 'ssh host cat /etc/hosts', 'nc example.com 80', 'certutil -urlcache -f https://example.com/x y.txt', 'powershell (New-Object Net.WebClient).DownloadString("https://example.com")']) {
    assert.ok(sh(c), c);
  }
  for (const c of ['rg foo src/http', 'go test ./http', 'git checkout feat/http', 'ls src/https', 'gh run view 123', 'gh run watch 123']) {
    assert.equal(sh(c), undefined, c);
  }
});
