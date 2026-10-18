// test/data-folder-guard.test.ts: a shell command that names Legion's own data folder (gates, key, projects, config, armory, away)
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataFolderHit, dataFolderRead } from '../src/core/exec/data-folder-guard.js';
import { classifySafe } from '../src/shared/consequence.js';

const DATA = 'C:/Users/Fakeuser/AppData/Roaming/legion';
const env = { APPDATA: 'C:\\Users\\Fakeuser\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Fakeuser\\AppData\\Local', USERPROFILE: 'C:\\Users\\Fakeuser', HOME: '/c/Users/Fakeuser' };
const hit = (command: string, kind: 'sh' | 'pwsh' = 'sh', folder = DATA) => dataFolderHit(command, kind, [folder], { cwd: 'C:/work/projA', env });

test('a command that names the data folder is found, in every spelling', () => {
  for (const c of [
    'mv C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json C:/work/projB/x',
    'cp C:/work/projB/old.json C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json',
    'rm C:\\Users\\Fakeuser\\AppData\\Roaming\\legion\\gates\\app.json',
    'rm c:/users/fakeuser/appdata/roaming/LEGION/gates/APP.JSON',
    'echo {} > "C:\\Users\\Fakeuser\\AppData\\Roaming\\legion\\projects.json"',
    'mv "$APPDATA/legion/gates/app.json" x',
    'mv ${APPDATA}/legion/gates/app.json x',
    'mv %APPDATA%\\legion\\gates\\app.json x',
    'mv ~/AppData/Roaming/legion/gates-key.bin x',
    'mv $HOME/AppData/Roaming/legion/gates-key.bin x',
    'mv /c/Users/Fakeuser/AppData/Roaming/legion/gates/app.json x',
    'mv /mnt/c/Users/Fakeuser/AppData/Roaming/legion/gates/app.json x',
    'mv C:/Users/Fakeuser/AppData/Roaming/legion/../legion/gates/app.json x',
    'mv C:/Users/Fakeuser/AppData/Roaming/./legion//gates/app.json x',
    'cd C:/Users/Fakeuser/AppData/Roaming/legion && mv gates/app.json x',
    'mv C:/Users/Fakeuser/AppData/Roaming/leg*/gates/app.json x',
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
  // the substitution's own text names a folder above the data folder: a card either way
  assert.notEqual(hit('mv "$(echo C:/Users/Fakeuser/AppData/Roaming)/legion/gates/app.json" x'), 'none');
  for (const c of ['mv $D/gates/app.json x', 'mv `pwd`/app.json x', 'cp x %SOMETHING%\\app.json', 'mv ${DIR}app.json x']) assert.equal(hit(c), 'hidden', c);
  assert.equal(hit('Move-Item $dir\\app.json x', 'pwsh'), 'hidden');
  assert.equal(hit('mv C:/Users/FAKEUS~1/AppData/Roaming/legion/gates/app.json x'), 'hidden', 'a short (8.3) name cannot be told');
});

test('commands that do not name the folder are none', () => {
  for (const c of ['ls', 'npm test 2>&1 | tail -5', 'git commit -m "costs $5"', 'mv a.txt b.txt', 'rm -rf node_modules', 'cat C:/Users/Fakeuser/AppData/Roaming/legion2/x', 'echo $HOME', 'cp C:/work/legion/a C:/work/legion/b', 'git status']) assert.equal(hit(c), 'none', c);
  assert.equal(hit('Get-ChildItem | ForEach-Object { $_.Name }', 'pwsh'), 'none');
});

test('the data folder given with ~ or in another spelling still matches', () => {
  assert.equal(dataFolderHit('rm ~/.legion/gates/app.json', 'sh', ['C:\\Users\\Fakeuser\\.legion'], { env }), 'names');
  assert.equal(dataFolderHit('rm $HOME/.legion/gates-key.bin', 'sh', ['C:\\Users\\Fakeuser\\.legion\\'], { env }), 'names');
  assert.equal(dataFolderHit('rm ~/.legion-other/x', 'sh', ['C:\\Users\\Fakeuser\\.legion'], { env }), 'none');
});

test('the level decides: the mv and cp probes write outside the project, so they are level 3 and Smart asks on level too (the guard cards them as well)', () => {
  const lvl = (command: string) => classifySafe({ kind: 'approval', toolName: 'Bash', input: { command }, projectFolders: ['C:/work/projB'] }).level;
  assert.equal(lvl('mv C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json C:/work/projB/x'), 3);
  assert.equal(lvl('cp C:/work/projB/old.json C:/Users/Fakeuser/AppData/Roaming/legion/gates/app.json'), 3);
  assert.ok(lvl('cat C:/Users/Fakeuser/AppData/Roaming/legion/projects.json') <= 2);
});

test('N30: a cd then ordinary work is free; the cd does not hide a path that names the data folder', () => {
  for (const kind of ['sh', 'pwsh'] as const) {
    assert.equal(hit('cd x; npm run build', kind), 'none', `${kind}: cd x; npm run build`);
    assert.equal(hit('cd x; rm -rf build', kind), 'none', `${kind}: cd x; rm -rf build`);
    assert.equal(hit('cd x || exit 1; rm build/a.o', kind), 'none', `${kind}: cd x || ...`);
  }
  // a cd that fails leaves the old folder, one that works gives the new one: both are tried
  assert.equal(hit('cd x; rm ../../../Users/Fakeuser/AppData/Roaming/legion/gates/app.json'), 'names');
  assert.equal(hit('cd /nonexistent; rm ../../Users/Fakeuser/AppData/Roaming/legion/gates/app.json'), 'names');
  // a target the guard cannot read leaves no known folder: still hidden
  assert.equal(hit('cd $WHERE; rm build/a.o'), 'hidden');
});

test('N30: TMPDIR is a known folder variable', () => {
  const run = (c: string) => dataFolderHit(c, 'sh', [DATA], { cwd: 'C:/work/projA', env: { ...env, TMPDIR: 'C:\Users\Fakeuser\AppData\Local\Temp' } });
  assert.equal(run('rm -rf $TMPDIR/x'), 'none');
  assert.equal(run('rm -rf ${TMPDIR}/x'), 'none');
});

test('N29: moved is set by a cd the guard cannot prove stays outside; cwdUnknown makes relative write words hidden', () => {
  const read = (c: string, o: { cwdUnknown?: boolean } = {}) => dataFolderRead(c, 'sh', [DATA], { cwd: 'C:/work/projA', env, ...o });
  assert.equal(read('cd sub; ls').moved, false, 'a project subfolder is provably outside');
  assert.equal(read('npm test').moved, false);
  assert.equal(read('cd C:/Users/Fakeuser/AppData/Roaming/legion').moved, true);
  assert.equal(read('cd C:/Users/Fakeuser').moved, true, 'a folder above the data folder');
  assert.equal(read('cd $WHERE').moved, true);
  assert.equal(read('rm gates/app.json').hit, 'none');
  assert.equal(read('rm gates/app.json', { cwdUnknown: true }).hit, 'hidden');
  assert.equal(read('cat gates/app.json', { cwdUnknown: true }).hit, 'none', 'reading stays free');
});
