import test from 'node:test';
import assert from 'node:assert/strict';
import { protectedHit, protectedWriteHit, PROTECTED_DIRS, PROTECTED_FILES } from '../src/core/protected-paths.js';

test('protectedHit: protected folders, either slash, any case; look-alikes are not hits', () => {
  const hits: Array<[string, string]> = [
    ['C:/p/.git/hooks/pre-commit', '.git'], ['C:\\p\\.Git\\config', '.git'], ['/p/.claude/settings.json', '.claude'], ['/p/.codex/x', '.codex'],
    ['/p/.agents/a.md', '.agents'], ['/h/.aws/config', '.aws'], ['/p/.vscode/settings.json', '.vscode'], ['/p/.husky/pre-commit', '.husky'],
    ['/p/.idea/workspace.xml', '.idea'], ['/h/.config/git/config', '.config/git'], ['C:\\h\\.CONFIG\\Git\\ignore', '.config/git'],
    ['/p/.claude/worktrees/x/.git/hooks/post-commit', '.git'],
  ];
  for (const [p, name] of hits) assert.equal(protectedHit(p), name, p);
  for (const p of ['/p/.github/workflows/ci.yml', '/p/.gitignore', '/p/src/git.ts', '/p/.gitattributes', '/p/.vscode-test/a.js', '/p/x.npmrc.bak', '/p/README.md', '/h/.config/other/a']) {
    assert.equal(protectedHit(p), undefined, p);
  }
});
test('protectedHit: shell startup files, package manager settings and agent config files', () => {
  for (const [p, name] of [['~/.bashrc', '.bashrc'], ['C:\\p\\.NPMRC', '.npmrc'], ['/p/.mcp.json', '.mcp.json'], ['/h/.claude.json', '.claude.json'], ['/h/.zshrc', '.zshrc'], ['/p/bunfig.toml', 'bunfig.toml'], ['/p/.gitconfig', '.gitconfig'], ['/p/.pre-commit-config.yaml', '.pre-commit-config.yaml']] as const) {
    assert.equal(protectedHit(p), name, p);
  }
});
test('protectedHit: exceptions are .claude/worktrees and .md notes in .claude/agent-memory', () => {
  assert.equal(protectedHit('/p/.claude/worktrees/x/a.ts'), undefined);
  assert.equal(protectedHit('/p/.claude/agent-memory/n.md'), undefined);
  assert.equal(protectedHit('/p/.claude/agent-memory/n.json'), '.claude');
  assert.equal(protectedHit('/p/.claude/settings.json'), '.claude');
});
test('the lists are exported, lower case, with no duplicates', () => {
  for (const l of [PROTECTED_DIRS, PROTECTED_FILES]) { assert.equal(new Set(l).size, l.length); for (const n of l) assert.equal(n, n.toLowerCase()); }
  assert.ok(PROTECTED_DIRS.includes('.config/git')); assert.ok(PROTECTED_FILES.includes('.npmrc'));
});
test('file-write tools: the target decides', () => {
  assert.equal(protectedWriteHit('Write', { file_path: 'C:/p/.git/hooks/pre-commit' }, 1), '.git');
  assert.equal(protectedWriteHit('Edit', { file_path: '/p/.claude/settings.json' }, 1), '.claude');
  assert.equal(protectedWriteHit('NotebookEdit', { notebook_path: '/p/.codex/n.ipynb' }, 1), '.codex');
  assert.equal(protectedWriteHit('mcp__host__write_file', { path: '/p/.git/hooks/pre-commit' }, 1), '.git');
  assert.equal(protectedWriteHit('Write', { file_path: '/p/src/a.ts' }, 1), undefined);
  assert.equal(protectedWriteHit('Read', { file_path: '/p/.git/config' }, 1), undefined);
  assert.equal(protectedWriteHit('Write', { file_path: '/p/.git/x' }, 1, () => 'src/a.ts'), undefined, 'the resolver decides what is tested');
});
test('shell: a write-level command that names a protected path hits; a read does not', () => {
  assert.equal(protectedWriteHit('Bash', { command: 'cp x .git/hooks/pre-commit' }, 2), '.git');
  assert.equal(protectedWriteHit('PowerShell', { command: 'Set-Content .\\.git\\hooks\\pre-commit "x"' }, 2), '.git');
  assert.equal(protectedWriteHit('Bash', { command: 'echo x >> ~/.bashrc' }, 2), '.bashrc');
  assert.equal(protectedWriteHit('Bash', { command: 'cat .git/config' }, 1), undefined);
  assert.equal(protectedWriteHit('Bash', { command: 'ls .git' }, 1), undefined);
  assert.equal(protectedWriteHit('Bash', { command: 'git status' }, 1), undefined);
});
test('shell: changing the hooks path or fsmonitor hits at any level', () => {
  assert.equal(protectedWriteHit('Bash', { command: 'git config core.hooksPath .evil' }, 1), '.git');
  assert.equal(protectedWriteHit('Bash', { command: 'git -c core.fsmonitor=./x status' }, 1), '.git');
  assert.equal(protectedWriteHit('Bash', { command: 'echo core.hooksPath' }, 1), undefined);
});
