// test/shell-guard-paths.test.ts: the shell guard reads real paths (cwd, cd, git -C, links), guards only commands that can write,
// and uses the same protected set as the file tools (the data folder's own files, not agents' workspaces)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { dataFolderHit, type ShellKindName } from '../src/core/exec/data-folder-guard.js';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';

const win = process.platform === 'win32';
const opts = { skip: !win };
const root = tempDir('legion-shellguard-');
const home = join(root, 'home');
const data = join(home, '.legion');
const ws = join(data, 'workspaces', 'builder');
mkdirSync(join(data, 'gates'), { recursive: true });
mkdirSync(ws, { recursive: true });
writeFileSync(join(data, 'state.json'), '{}');
const set = dataFolderTargets(data);
const env = { USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
const fwd = (p: string): string => p.replace(/\\/g, '/');
const hit = (command: string, kind: ShellKindName = 'sh', cwd = ws) => dataFolderHit(command, kind, set, { cwd, env });
const drive = data.slice(0, 1);
const share = fwd(data.slice(2)); // /Users/.../.legion

test('N18: an agent working in its own workspace inside the data folder gets no card', opts, () => {
  assert.equal(hit(`cd ${fwd(ws)} && npm install`), 'none');
  assert.equal(hit(`mkdir -p ${fwd(ws)}/notes && echo hi > ${fwd(ws)}/notes/a.md`), 'none');
  assert.equal(hit('rm -rf node_modules && cp a.txt b.txt'), 'none');
  assert.equal(hit('rm -rf *'), 'none');
});

test('N17: relative paths, cd, pushd, Set-Location and git -C are followed in order', opts, () => {
  for (const c of [
    'rm ../../gates/app.json',
    'mv ../../state.json x',
    `cd ~ && mv .legion/gates/app.json x`,
    'cd ../.. && rm state.json',
    'cd ../.. ; rm -f config.json',
    'pushd ../.. && del state.json',
    'chdir ../.. && erase projects.json',
    'cd ../../gates && rm app.json',
    'cd .. && cd .. && rm state.json',
    'git -C ../.. rm state.json',
    'git -C ../../gates reset --hard',
  ]) assert.equal(hit(c), 'names', c);
  for (const c of ['Set-Location ../.. ; Remove-Item state.json', 'sl ../..; ri gates', 'Move-Item ../../state.json x', 'Copy-Item ../../config.json x', 'cd ../..; Copy-Item x projects.json']) assert.equal(hit(c, 'pwsh'), 'names', c);
  assert.equal(hit('cd /d ..\\.. && move state.json x', 'cmd'), 'names');
  assert.equal(hit('cd ../.. && cd workspaces && rm -rf builder/x'), 'none', 'cd back out into the free part');
});

test('N17: admin share, volume path and trailing dot spellings', opts, () => {
  assert.equal(hit(`mv //localhost/${drive}$${share}/state.json x`), 'names');
  assert.equal(hit(`Move-Item \\\\localhost\\${drive}$${share.replace(/\//g, '\\')}\\state.json x`, 'pwsh'), 'names');
  assert.equal(hit('mv \\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\Users\\x\\state.json y'), 'names');
  assert.equal(hit(`move ${data}\\state.json. x`, 'cmd'), 'names');
  assert.equal(hit(`move ${data}\\gates. x`, 'cmd'), 'names');
});

test('N17: a junction or symlink that points into the protected set is a card', opts, () => {
  for (const c of [
    `ln -s ${fwd(data)}/gates lnk`,
    'ln -s ../../gates lnk',
    'ln -s ../../../gates sub/lnk', // relative to the link, not to the folder the command runs in
    `mklink /J lnk ${data}\\gates`,
  ]) assert.equal(hit(c), 'names', c);
  assert.equal(hit(`mklink /J lnk ${data}\\gates`, 'cmd'), 'names');
  assert.equal(hit(`New-Item -ItemType Junction -Path lnk -Target ${data}\\gates`, 'pwsh'), 'names');
  assert.equal(hit('New-Item -ItemType SymbolicLink -Path lnk -Value ..\\..\\gates', 'pwsh'), 'names');
  assert.equal(hit('ln -s ../other lnk'), 'none');
  // a link that already exists is followed through the real path
  try { symlinkSync(join(data, 'gates'), join(ws, 'jlnk'), 'junction'); } catch { return; }
  assert.equal(hit('rm jlnk/app.json'), 'names');
});

test('N17: a path the guard cannot resolve, in a command that writes, is unknown', opts, () => {
  for (const c of ['rm $X/foo', 'cd $D && rm x', 'mv ~bob/x y', 'rm $(pwd)/x', 'cp a `pwd`/b', 'echo hi > $T/a', 'rm ../{a,b}.json', 'cd - && rm state.json']) assert.equal(hit(c), 'hidden', c);
  assert.equal(hit('Remove-Item $dir\\x', 'pwsh'), 'hidden');
  assert.equal(hit('del %SOMETHING%\\x', 'cmd'), 'hidden');
});

test('N22: plain reads get no card, even when they name the protected files or use variables', opts, () => {
  for (const c of [
    `cat ${fwd(data)}/state.json`, `ls ${fwd(data)}/gates`, `rg -n x ${fwd(data)}`, 'cat ../../state.json', 'cd ../.. && cat state.json',
    'git log', 'git status', 'git diff HEAD~1 -- src/x', `git -C ${fwd(data)} log`, 'echo $FOO', 'ls $dir', 'cat $f', 'git log HEAD~1', 'git commit -m "costs $5"',
    'cat $(pwd)/x', 'cat state.json > out.txt', 'ls 2>&1', 'node build.js 2>/dev/null',
  ]) assert.equal(hit(c), 'none', c);
  for (const c of [`Get-Content ${data}\\state.json`, 'gc ..\\..\\state.json', 'type ..\\..\\state.json', 'Get-ChildItem ..\\..\\gates', 'dir ..\\..', 'Get-Content $HOME\\.legion\\state.json', 'Get-Content $f']) assert.equal(hit(c, 'pwsh'), 'none', c);
});

test('N22: the writing verbs are guarded', opts, () => {
  for (const c of [
    'rm ../../state.json', 'cp x ../../config.json', 'mv x ../../state.json', 'tee ../../state.json', 'echo x | tee ../../state.json', 'dd if=x of=../../state.json', 'truncate -s 0 ../../state.json',
    'echo {} > ../../state.json', 'echo {} >> ../../state.json', 'echo {} 2> ../../state.json', 'git -C ../.. checkout -- state.json', 'tar -xf a.tar -C ../../gates', 'unzip a.zip -d ../../gates',
    'sed -i s/a/b/ ../../state.json', 'touch ../../state.json',
  ]) assert.equal(hit(c), 'names', c);
  for (const c of [
    'Remove-Item ../../state.json', 'ri ../../state.json', 'Set-Content ../../state.json x', 'sc ../../state.json x', 'Add-Content ../../state.json x', 'ac ../../state.json x', 'Out-File ../../state.json',
    'Clear-Content ../../state.json', 'ni ../../state.json', 'Rename-Item ../../state.json y', 'rni ../../state.json y', 'Expand-Archive a.zip -DestinationPath ../../gates', 'mi ../../state.json x', 'cpi x ../../config.json',
    "'x' > ../../state.json",
  ]) assert.equal(hit(c, 'pwsh'), 'names', c);
  for (const c of ['del ..\\..\\state.json', 'erase ..\\..\\state.json', 'rd /s /q ..\\..\\gates', 'rmdir ..\\..\\gates', 'ren ..\\..\\state.json y', 'rename ..\\..\\state.json y', 'copy x ..\\..\\config.json', 'xcopy x ..\\..\\gates /s', 'robocopy x ..\\..\\gates', 'echo {}> ..\\..\\state.json']) assert.equal(hit(c, 'cmd'), 'names', c);
});

test('N22: one-liners that can write are read for the paths they name', opts, () => {
  assert.equal(hit(`node -e "require('fs').writeFileSync('${fwd(data)}/state.json','x')"`), 'names');
  assert.equal(hit(`python -c "open(r'${data}\\state.json','w')"`), 'names');
  assert.equal(hit(`powershell -Command "Remove-Item ${data}\\state.json"`, 'cmd'), 'names');
  assert.equal(hit(`bash -c 'rm ../../state.json'`), 'names');
  assert.equal(hit('cmd /c del ..\\..\\state.json', 'pwsh'), 'names');
  assert.equal(hit('node -e "console.log(1)"'), 'none');
});

test('a wildcard that could stand for a protected name is a card', opts, () => {
  assert.equal(hit('rm -rf ../../gat*'), 'names');
  assert.equal(hit('rm ../../state.js?n'), 'names');
  assert.equal(hit('rm -rf *', 'sh', data), 'names');
  assert.equal(hit('rm -rf workspaces/*', 'sh', data), 'none');
});

test('every spelling of the protected set is found by the canonical compare', opts, () => {
  for (const c of [`rm ${fwd(data).toUpperCase()}/GATES/APP.JSON`, `rm "${data}\\gates\\app.json"`, `rm ${fwd(data)}/./gates/../gates/app.json`, 'rm ~/.legion/gates/app.json', 'rm $HOME/.legion/state.json', 'rm ${HOME}/.legion/state.json'])
    assert.equal(hit(c), 'names', c);
  assert.equal(hit('Remove-Item $env:USERPROFILE\\.legion\\state.json', 'pwsh'), 'names');
  assert.equal(hit('del %USERPROFILE%\\.legion\\state.json', 'cmd'), 'names');
  assert.equal(hit(`rm ${fwd(data)}2/x`), 'none');
});
