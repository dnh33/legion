// test/install-root-protected.test.ts: security fix 1 (C-H1 part 2). Legion's own program folder, its launcher and the places that start a
// program at login are protected from agents in Accept edits and Smart. Fake install markers in temp folders; no real install path is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { tempDir } from './tmp-cleanup.js';
import { installFolderTargets } from '../src/core/exec/canonical-path.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { isPackageInstall } from '../src/electron/resolve-node.js';
import { protectedHit } from '../src/core/protected-paths.js';

const fwd = (p: string): string => p.replace(/\\/g, '/');

test('installFolderTargets: an installed Legion is protected, a dev or test checkout is not', () => {
  const root = tempDir('legion-inst-');
  assert.deepEqual(installFolderTargets(root, false), [], 'a checkout with no marker and no package build');
  assert.deepEqual(installFolderTargets(root, true), [root], 'a prebuilt package');
  const unix = tempDir('legion-inst-unix-');
  writeFileSync(join(unix, '.legion-install.json'), '{}');
  assert.deepEqual(installFolderTargets(unix, false), [unix], 'the Mac and Linux installer marker');
});

test('installFolderTargets follows isPackageInstall: build-info says package for win32-x64 and the bundled runtime is there', () => {
  const root = tempDir('legion-inst-pkg-');
  const read = (p: string): string => (p.endsWith('build-info.json') ? JSON.stringify({ kind: 'package', platform: 'win32-x64' }) : '');
  const yes = (p: string): boolean => p.endsWith('electron.exe');
  assert.deepEqual(installFolderTargets(root, isPackageInstall(root, yes, read)), [root]);
  assert.deepEqual(installFolderTargets(root, isPackageInstall(root, () => false, read)), [], 'no bundled runtime: not a package install');
  assert.deepEqual(installFolderTargets(root, isPackageInstall(root, yes, () => JSON.stringify({ kind: 'source' }))), [], 'a source build');
});

type Make = () => Promise<GatesRig>;
const RIGS: Array<[string, Make]> = [
  ['accept-edits', () => gatesRig({ own: 'auto-edits' })],
  ['smart', () => gatesRig({ preset: 'smart', follow: true })],
];

test('Accept edits and Smart: the file tools cannot write Legion\'s program, updater state or install marker (the PreToolUse hook denies)', async () => {
  for (const [mode, make] of RIGS) {
    const r = await make();
    try {
      const root = tempDir('legion-inst-hook-');
      writeFileSync(join(root, '.legion-install.json'), '{}');
      r.engine.setModules([{ id: 'install-root', protectedPaths: () => installFolderTargets(root, false) } as never]);
      for (const f of ['dist/src/electron/main.js', '.update/run/apply.mjs', '.update/journal.json', '.legion-install.json', 'node_modules/electron/index.js', 'package.json']) {
        for (const tool of ['Write', 'Edit']) {
          const h = await r.hook(tool, { file_path: join(root, ...f.split('/')), content: 'x', old_string: 'a', new_string: 'b' });
          assert.equal(h.decision, 'deny', `${mode}: ${tool} ${f}`);
        }
      }
      // a file next to the folder is free
      const other = await r.hook('Write', { file_path: join(tempDir('legion-inst-other-'), 'a.txt'), content: 'x' });
      assert.notEqual(other.decision, 'deny', `${mode}: a neighbour folder stays writable`);
    } finally { r.stop(); }
  }
});

test('a dev or test checkout (no marker, no package build) is not protected: agents can edit Legion\'s own source', async () => {
  const r = await gatesRig({ own: 'auto-edits' });
  try {
    const root = tempDir('legion-dev-checkout-');
    r.engine.setModules([{ id: 'install-root', protectedPaths: () => installFolderTargets(root, false) } as never]);
    for (const f of ['src/electron/main.ts', 'dist/src/electron/main.js', 'package.json']) {
      const h = await r.hook('Write', { file_path: join(root, ...f.split('/')), content: 'x' });
      assert.notEqual(h.decision, 'deny', f);
    }
  } finally { r.stop(); }
});

test('Accept edits and Smart: a shell command that writes into the install folder cards with no Remember', async () => {
  for (const [mode, make] of RIGS) {
    const r = await make();
    try {
      const root = tempDir('legion-inst-sh-');
      writeFileSync(join(root, '.legion-install.json'), '{}');
      r.engine.setModules([{ id: 'install-root', protectedPaths: () => installFolderTargets(root, false) } as never]);
      for (const command of [`echo x >> ${fwd(join(root, 'dist/src/electron/main.js'))}`, `cp a.js ${fwd(join(root, 'dist/src/electron/main.js'))}`, `printf x | tee -a ${fwd(join(root, '.update/journal.json'))}`, `echo x > ${fwd(join(root, '.legion-install.json'))}`]) {
        const o = await r.run('Bash', { command });
        assert.equal(o.card, true, `${mode}: ${command}`);
        assert.equal(o.noRemember, true, `${mode}: no Remember: ${command}`);
      }
    } finally { r.stop(); }
  }
});

test('protected by name: the launcher, the Startup folder, PowerShell profiles and the login-start folders', () => {
  const home = fwd(homedir());
  const hits: Array<[string, string]> = [
    [`${home}/.local/bin/legion`, '.local/bin/legion'],
    ['C:/Users/a/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.cmd', 'start menu/programs/startup'],
    ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\x.lnk', 'start menu/programs/startup'],
    ['C:/Users/a/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1', 'microsoft.powershell_profile.ps1'],
    ['C:/Users/a/Documents/PowerShell/Microsoft.VSCode_profile.ps1', 'microsoft.vscode_profile.ps1'],
    ['C:/Windows/System32/WindowsPowerShell/v1.0/profile.ps1', 'profile.ps1'],
    [`${home}/Library/LaunchAgents/com.x.plist`, 'library/launchagents'],
    [`${home}/.config/autostart/x.desktop`, '.config/autostart'],
    [`${home}/.config/systemd/user/x.service`, '.config/systemd/user'],
  ];
  for (const [p, name] of hits) assert.equal(protectedHit(p), name, p);
});

test('Accept edits and Smart: the Write tool to the launcher, the Startup .cmd and a PowerShell profile cards with no Remember', async () => {
  const home = tempDir('legion-fakehome-');
  const targets = [
    join(home, '.local', 'bin', 'legion'),
    join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.cmd'),
    join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    join(home, 'Library', 'LaunchAgents', 'x.plist'),
    join(home, '.config', 'autostart', 'x.desktop'),
    join(home, '.config', 'systemd', 'user', 'x.service'),
  ];
  for (const [mode, make] of RIGS) {
    const r = await make();
    try {
      for (const file_path of targets) {
        const o = await r.run('Write', { file_path, content: 'x' });
        assert.equal(o.card, true, `${mode}: ${file_path}`);
        assert.equal(o.noRemember, true, `${mode}: no Remember: ${file_path}`);
        assert.match(o.summary ?? '', /^Legion wants to change .+\. A change there can run code when you log in or open a shell, or change what an agent may do\.$/, `${mode}: ${file_path}`);
      }
    } finally { r.stop(); }
  }
});

test('Smart: the review\'s shell writes outside the project card through the real engine; a write inside does not', async () => {
  const r = await gatesRig({ preset: 'smart', follow: true });
  try {
    mkdirSync(join(r.projectDir(), 'src'), { recursive: true });
    const outside = tempDir('legion-outside-');
    const cmds = [
      `echo x >> ${fwd(join(outside, 'dist/src/electron/main.js'))}`, `echo 'node evil.js' >> ~/.local/bin/legion`, `echo x >> ~/Documents/notes.txt`,
      `printf x | tee -a ${fwd(join(outside, 'a.txt'))}`, `cp a.js ${fwd(join(outside, 'main.js'))}`, `echo x > ${fwd(join(outside, 'x.cmd'))}`,
    ];
    for (const command of cmds) {
      const o = await r.run('Bash', { command });
      assert.equal(o.card, true, command);
    }
    const inside = await r.run('Bash', { command: 'echo x > notes.txt' });
    assert.equal(inside.card, false, 'a redirect inside the project does not card in Smart');
  } finally { r.stop(); }
});

test('the gates module lists the install folder next to the data folder targets, and only when it is given', () => {
  const data = join(tempDir('legion-inst-gm-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const core = createGatesCore({ dataDir: data, projects });
  const root = join(tempDir('legion-inst-gm-root-'), 'Legion');
  const withIt = createGatesModule({} as never, { projects, core, dataDir: data, installTargets: [root] });
  assert.ok(withIt.protectedPaths!().includes(root));
  assert.ok(withIt.protectedPaths!().includes(join(data, 'gates-key.bin')), 'the data folder targets stay');
  const without = createGatesModule({} as never, { projects, core, dataDir: data });
  assert.ok(!without.protectedPaths!().includes(root));
});
