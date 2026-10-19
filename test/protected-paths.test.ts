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

// ---- L1 (security review): Windows ignores trailing dots and spaces and an NTFS stream suffix, so `.vscode.\tasks.json` is `.vscode\tasks.json`.
// The set of editor and Git settings that can run code on the next editor or Git action (.vscode tasks.json, settings.json, launch.json; .husky; .git; .claude) is carded in
// every spelling, in a shell command and for a file tool, in Smart as in Ask.
test('L1: trailing-dot, trailing-space and stream spellings of a protected folder or file are protected too', () => {
  for (const p of ['D:/p/.vscode./tasks.json', 'D:/p/.vscode../settings.json', 'D:/p/.vscode /launch.json', 'D:/p/.VSCODE./tasks.json', 'D:/p/.husky./pre-commit', 'D:/p/.git./hooks/pre-commit', 'D:/p/.claude./settings.json', 'D:/p/.npmrc::$DATA', 'D:/p/.vscode::$INDEX_ALLOCATION/tasks.json', 'D:\\p\\.vscode.\\tasks.json']) {
    assert.ok(protectedHit(p), p);
  }
  assert.equal(protectedHit('D:/p/.vscode./tasks.json'), '.vscode');
  assert.equal(protectedHit('D:/p/.husky./pre-commit'), '.husky');
  assert.equal(protectedHit('D:/p/.npmrc::$DATA'), '.npmrc');
});

test('L1: the same spellings in a shell command are caught at level 2', () => {
  for (const c of ['Set-Content .vscode.\\tasks.json x', 'cp a .husky./pre-commit', 'Set-Content .git.\\hooks\\pre-commit x', 'Set-Content .claude.\\settings.json x', 'Set-Content .npmrc::$DATA x', 'Set-Content .vscode..\\settings.json x']) {
    assert.ok(protectedWriteHit('PowerShell', { command: c }, 2), c);
  }
});

test('L1: ordinary names that only look similar are not protected', () => {
  for (const p of ['D:/p/src/main.ts', 'D:/p/a.b./c', 'D:/p/..', 'D:/p/../x', 'D:/p/vscode/tasks.json', 'D:/p/.vscodeish/x', 'D:/p/notes...']) assert.equal(protectedHit(p), undefined, p);
});

// ---- security fix 1: Legion's launcher and the places that start a program at login or when a shell opens
test('login-start places and PowerShell profiles are protected, in any case and either slash', () => {
  const hits: Array<[string, string]> = [
    ['/h/.local/bin/legion', '.local/bin/legion'], ['C:\\Users\\a\\.LOCAL\\BIN\\Legion', '.local/bin/legion'],
    ['C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd', 'start menu/programs/startup'],
    ['C:/ProgramData/Microsoft/Windows/Start Menu/Programs/StartUp', 'start menu/programs/startup'],
    ['C:/Users/a/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1', 'microsoft.powershell_profile.ps1'],
    ['C:/Users/a/Documents/PowerShell/Microsoft.VSCode_profile.ps1', 'microsoft.vscode_profile.ps1'],
    ['C:/Users/a/Documents/PowerShell/profile.ps1', 'profile.ps1'], ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Profile.ps1', 'profile.ps1'],
    ['/h/Library/LaunchAgents/x.plist', 'library/launchagents'], ['/h/.config/autostart/x.desktop', '.config/autostart'], ['/h/.config/systemd/user/x.service', '.config/systemd/user'],
    ['C:/Users/a/Documents/WindowsPowerShell./Microsoft.PowerShell_profile.ps1.', 'microsoft.powershell_profile.ps1'],
  ];
  for (const [p, name] of hits) assert.equal(protectedHit(p), name, p);
});
test('login-start names: look-alikes and ordinary project files are not protected', () => {
  for (const p of ['/p/profile.ps1', '/p/src/profile.ps1', '/p/.local/bin/other', '/p/.local/legion', '/h/.config/other/a', '/h/.config/systemd/system/x.service', '/p/Library/Caches/a', '/p/start menu/programs/a.txt', '/p/Startup/x.cmd', '/p/autostart/x', '/p/legion', '/p/src/Microsoft.PowerShell_profile.txt']) {
    assert.equal(protectedHit(p), undefined, p);
  }
});
test('login-start names: file tools and write-level shell commands hit; a read does not', () => {
  assert.equal(protectedWriteHit('Write', { file_path: '/h/.local/bin/legion' }, 1), '.local/bin/legion');
  assert.equal(protectedWriteHit('Edit', { file_path: 'C:/Users/a/Documents/WindowsPowerShell/profile.ps1' }, 1), 'profile.ps1');
  assert.equal(protectedWriteHit('Bash', { command: 'echo x >> ~/.local/bin/legion' }, 2), '.local/bin/legion');
  assert.equal(protectedWriteHit('Bash', { command: 'cp a.service ~/.config/systemd/user/a.service' }, 2), '.config/systemd/user');
  assert.equal(protectedWriteHit('PowerShell', { command: 'Set-Content "C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd" "calc"' }, 2), 'start menu/programs/startup');
  assert.equal(protectedWriteHit('PowerShell', { command: 'Copy-Item a.ps1 $HOME\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1' }, 2), 'microsoft.powershell_profile.ps1');
  assert.equal(protectedWriteHit('Bash', { command: 'cat ~/.local/bin/legion' }, 1), undefined);
  assert.equal(protectedWriteHit('PowerShell', { command: 'Get-Content "C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd"' }, 1), undefined);
});
