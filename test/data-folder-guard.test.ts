// test/data-folder-guard.test.ts: a shell command that names Legion's own data folder (gates, key, projects, config, armory, away)
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataFolderHit } from '../src/core/exec/data-folder-guard.js';
import { classifySafe } from '../src/shared/consequence.js';

const DATA = 'C:/Users/Danie/AppData/Roaming/legion';
const env = { APPDATA: 'C:\\Users\\Danie\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Danie\\AppData\\Local', USERPROFILE: 'C:\\Users\\Danie', HOME: '/c/Users/Danie' };
const hit = (command: string, kind: 'sh' | 'pwsh' = 'sh', folder = DATA) => dataFolderHit(command, kind, [folder], env);

test('a command that names the data folder is found, in every spelling', () => {
  for (const c of [
    'mv C:/Users/Danie/AppData/Roaming/legion/gates/app.json C:/work/projB/x',
    'cp C:/work/projB/old.json C:/Users/Danie/AppData/Roaming/legion/gates/app.json',
    'rm C:\\Users\\Danie\\AppData\\Roaming\\legion\\gates\\app.json',
    'rm c:/users/danie/appdata/roaming/LEGION/gates/APP.JSON',
    'echo {} > "C:\\Users\\Danie\\AppData\\Roaming\\legion\\projects.json"',
    'mv "$APPDATA/legion/gates/app.json" x',
    'mv ${APPDATA}/legion/gates/app.json x',
    'mv %APPDATA%\\legion\\gates\\app.json x',
    'mv ~/AppData/Roaming/legion/gates-key.bin x',
    'mv $HOME/AppData/Roaming/legion/gates-key.bin x',
    'mv /c/Users/Danie/AppData/Roaming/legion/gates/app.json x',
    'mv /mnt/c/Users/Danie/AppData/Roaming/legion/gates/app.json x',
    'mv C:/Users/Danie/AppData/Roaming/legion/../legion/gates/app.json x',
    'mv C:/Users/Danie/AppData/Roaming/./legion//gates/app.json x',
    'cd C:/Users/Danie/AppData/Roaming/legion && mv gates/app.json x',
    'mv C:/Users/Danie/AppData/Roaming/leg*/gates/app.json x',
  ]) assert.equal(hit(c), 'names', c);
  for (const c of [
    'Remove-Item $env:APPDATA\\legion\\gates\\app.json',
    'Remove-Item "$env:APPDATA/legion/gates/app.json"',
    'Move-Item $env:USERPROFILE\\AppData\\Roaming\\legion\\gates\\app.json x',
    'Copy-Item x $env:APPDATA\\legion\\projects.json',
    'ri $env:LOCALAPPDATA\\..\\Roaming\\legion\\gates\\app.json',
  ]) assert.equal(hit(c, 'pwsh'), 'names', c);
});

test('a path hidden behind a variable or a substitution could point there: hidden', () => {
  for (const c of ['mv $D/gates/app.json x', 'mv "$(echo C:/Users/Danie/AppData/Roaming)/legion/gates/app.json" x', 'mv `pwd`/app.json x', 'cp x %SOMETHING%\\app.json', 'mv ${DIR}app.json x']) assert.equal(hit(c), 'hidden', c);
  assert.equal(hit('Move-Item $dir\\app.json x', 'pwsh'), 'hidden');
  assert.equal(hit('mv C:/Users/DANIE~1/AppData/Roaming/legion/gates/app.json x'), 'hidden', 'a short (8.3) name cannot be told');
});

test('commands that do not name the folder are none', () => {
  for (const c of ['ls', 'npm test 2>&1 | tail -5', 'git commit -m "costs $5"', 'mv a.txt b.txt', 'rm -rf node_modules', 'cat C:/Users/Danie/AppData/Roaming/legion2/x', 'echo $HOME', 'cp C:/work/legion/a C:/work/legion/b', 'git status']) assert.equal(hit(c), 'none', c);
  assert.equal(hit('Get-ChildItem | ForEach-Object { $_.Name }', 'pwsh'), 'none');
});

test('the data folder given with ~ or in another spelling still matches', () => {
  assert.equal(dataFolderHit('rm ~/.legion/gates/app.json', 'sh', ['C:\\Users\\Danie\\.legion'], env), 'names');
  assert.equal(dataFolderHit('rm $HOME/.legion/gates-key.bin', 'sh', ['C:\\Users\\Danie\\.legion\\'], env), 'names');
  assert.equal(dataFolderHit('rm ~/.legion-other/x', 'sh', ['C:\\Users\\Danie\\.legion'], env), 'none');
});

test('the level decides: the mv and cp probes are level 2, so Smart would not ask on level alone; the guard cards them anyway', () => {
  const lvl = (command: string) => classifySafe({ kind: 'approval', toolName: 'Bash', input: { command }, projectFolders: ['C:/work/projB'] }).level;
  assert.equal(lvl('mv C:/Users/Danie/AppData/Roaming/legion/gates/app.json C:/work/projB/x'), 2);
  assert.equal(lvl('cp C:/work/projB/old.json C:/Users/Danie/AppData/Roaming/legion/gates/app.json'), 2);
  assert.ok(lvl('cat C:/Users/Danie/AppData/Roaming/legion/projects.json') <= 2);
});
