// test/shell-guard-default-deny.test.ts: the shell guard is default-deny. Any token that is a protected file, inside one, or a folder
// above one (the data folder, the home folder, the drive root) gets a card, unless every part of the command only reads. Hidden
// commands ($(...), backticks, heredocs, iex, Start-Process, cmd /c) are read too, and so are escapes, line-local variables and cd
// that fails or does not last. Fake folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { dataFolderHit, type ShellKindName } from '../src/core/exec/data-folder-guard.js';
import { dataFolderTargets, isProtected } from '../src/core/exec/canonical-path.js';

const win = process.platform === 'win32';
const opts = { skip: !win };
const root = tempDir('legion-defdeny-');
const home = join(root, 'home');
const data = join(home, '.legion');
const ws = join(data, 'workspaces', 'builder');
const proj = join(root, 'proj');
for (const d of ['gates', 'armory', 'away', 'connectors', join('workspaces', 'builder', 'old')]) mkdirSync(join(data, d), { recursive: true });
mkdirSync(join(proj, 'src'), { recursive: true });
writeFileSync(join(data, 'gates', 'app.json'), 'APP');
for (const f of ['gates-key.bin', 'config.json', 'state.json', 'projects.json']) writeFileSync(join(data, f), f);
const set = [...dataFolderTargets(data), join(data, 'armory'), join(data, 'away')];
const env = { USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: join(root, 'tmp'), TMP: join(root, 'tmp') };
const fwd = (p: string): string => p.replace(/\\/g, '/');
const D = fwd(data), B = data, W = fwd(ws), H = fwd(home);
const hit = (command: string, kind: ShellKindName = 'sh', cwd = ws) => dataFolderHit(command, kind, set, { cwd, env });
const cards = (rows: Array<[ShellKindName, string, string?]>): void => {
  for (const [k, c, cwd] of rows) assert.notEqual(hit(c, k, cwd ?? ws), 'none', `${k}: ${c}`);
};

test('N23: a literal protected path under any verb not on the read list is a card', opts, () => {
  cards([
    ['sh', `perl -pi -e 's/a/b/' ${D}/config.json`], ['sh', `sed --in-place=.bak 's/a/b/' ${D}/config.json`], ['sh', `awk -i inplace '{print}' ${D}/config.json`],
    ['sh', `curl -o${D}/gates/app.json http://x`], ['sh', `find ${D}/gates -name app.json -delete`], ['sh', `find ${D}/gates -exec rm {} +`],
    ['cmd', `certutil -decode x.b64 ${B}\\gates\\app.json`], ['cmd', `bitsadmin /transfer j http://x ${B}\\gates\\app.json`], ['cmd', `esentutl /y old.json /d ${B}\\gates\\app.json`],
    ['cmd', `replace old.json ${B}\\gates`], ['cmd', `fsutil file setZeroData offset=0 length=99 ${B}\\config.json`],
    ['pwsh', `Start-Process cmd -ArgumentList "/c del ${B}\\gates\\app.json"`], ['pwsh', `Start-Process -FilePath cmd.exe -ArgumentList '/c','del','${B}\\gates\\app.json'`],
    ['pwsh', `Invoke-Expression 'Remove-Item ${B}\\gates\\app.json'`], ['pwsh', `iex 'ri ${B}\\gates\\app.json'`], ['pwsh', `[IO.File]::Delete('${B}\\gates\\app.json')`],
    ['pwsh', `[System.IO.File]::WriteAllText('${B}\\config.json', 'x')`], ['pwsh', `clc ${B}\\config.json`], ['pwsh', `Set-Item -Path ${B}\\config.json -Value x`],
    ['pwsh', `Start-BitsTransfer -Source http://x -Destination ${B}\\gates\\app.json`], ['sh', `scp host:x ${D}/gates/app.json`], ['sh', `patch ${D}/config.json < x.diff`],
    ['sh', `echo $(rm ${D}/gates/app.json)`], ['sh', `x=$(rm ${D}/gates/app.json)`], ['sh', `echo \`rm ${D}/gates/app.json\``], ['pwsh', `echo $(Remove-Item ${B}\\gates\\app.json)`],
    ['sh', `node <<EOF\nrequire("fs").rmSync("${D}/gates/app.json")\nEOF`], ['sh', `python3 - <<'EOF'\nimport os; os.remove(r'${B}\\gates\\app.json')\nEOF`],
    ['sh', `echo "require('fs').rmSync('${D}/gates/app.json')" | node`], ['sh', `xargs rm <<< ${D}/gates/app.json`],
    ['pwsh', 'powershell -EncodedCommand ZABlAGwA'], ['pwsh', 'pwsh -enc ZABlAGwA'], ['sh', `cat ${D}/state.json | sh`],
  ]);
});

test('N24: a folder above the protected files is a card for anything that is not a read', opts, () => {
  cards([
    ['sh', `cp -r ${W}/old/. ${D}`], ['sh', `rm -rf ${D}`], ['sh', `tar -xf old.tar -C ${D}`], ['cmd', `robocopy C:\\old ${B} /E`], ['sh', `rsync -a old/ ${D}/`],
    ['sh', `git -C ${D} init && git -C ${D} add -A && git -C ${D} commit -m s`], ['sh', `git -C ${D} checkout -- .`], ['sh', `git -C ${D} stash`],
    ['cmd', `icacls ${B} /deny %USERNAME%:(WD)`], ['sh', `mv ${D} ${H}/L2`], ['sh', 'rm -rf ../..'], ['sh', `rm -rf ${H}`], ['sh', 'cp -r x /'],
  ]);
});

test('N25: bash escapes, ANSI-C quoting and line-local variables are read the way the shell reads them', opts, () => {
  cards([
    ['sh', 'mv ~/.leg\\ion/gates/app.json x'], ['sh', 'mv ../../gat\\es/app.json x'], ['sh', "mv ~/$'\\x2elegion'/gates/app.json x"], ['sh', "rm $'../../gates/app\\056json'"],
    ['sh', `HOME=${D}; rm ~/gates/app.json`], ['sh', `export HOME=${D} && rm $HOME/gates/app.json`], ['sh', `TEMP=${D}; rm $TEMP/gates/app.json`],
    ['pwsh', `$env:TEMP='${B}'; Remove-Item $env:TEMP\\gates\\app.json`], ['sh', 'cd() { :; }; cd /; rm ../../gates/app.json'], ['sh', 'alias cd=true; cd /; rm ../../gates/app.json'],
    ['pwsh', 'Remove-Item ..\\..\\ga`tes\\app.json'], ['cmd', 'del ..\\..\\ga^tes\\app.json'],
  ]);
  // the known variables still expand: a temp path is free, the data folder through $HOME is not
  assert.equal(hit('rm -rf $TEMP/build'), 'none');
  assert.equal(hit('rm $HOME/.legion/gates/app.json'), 'names');
});

test('N26: a cd that can fail or does not last leaves the folder unknown; Push-Location is followed', opts, () => {
  cards([
    ['sh', 'cd /nonexistent; rm ../../gates/app.json'], ['sh', 'cd /nonexistent || rm ../../gates/app.json'], ['sh', '(cd /tmp && true); rm ../../gates/app.json'],
    ['sh', 'cd ../.. & rm gates/app.json'], ['pwsh', 'Push-Location ../..; Remove-Item gates/app.json'], ['pwsh', 'Set-Location C:\\nonexistent; Remove-Item ..\\..\\gates\\app.json'],
    ['cmd', 'cd /d C:\\nonexistent & del ..\\..\\gates\\app.json'], ['pwsh', 'cd ../..; Pop-Location; ri gates/app.json'], ['sh', `CDPATH=${D} cd gates && rm app.json`],
    ['sh', 'cd $WHERE; cp a b'], ['pwsh', 'Push-Location ../.. && Remove-Item gates/app.json'],
  ]);
  // a subshell's cd does not leak: back in the workspace, gates/app.json is the workspace's own file
  assert.equal(hit('(cd ../..); rm gates/app.json'), 'none');
  // both folders were tried and neither names a protected path: a cd that may fail is no reason to ask
  assert.equal(hit('cd /nonexistent; cp a b'), 'none');
  assert.equal(hit('(cd ../..) && Pop-Location && rm gates/app.json', 'pwsh'), 'names', 'pwsh parentheses do not restore the folder');
});

test('N16b: an admin share through any address of this computer is local', opts, () => {
  const rest = data.slice(2);
  const addrs = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal);
  const hosts = addrs.map((a) => (a!.family === 'IPv6' ? `${a!.address.replace(/:/g, '-').replace(/%/g, 's')}.ipv6-literal.net` : a!.address));
  hosts.push('127.0.0.2', '127.1', '0x7f.1', 'LOCALHOST.');
  for (const h of hosts) {
    const p = `\\\\${h}\\${data.slice(0, 1)}$${rest}\\state.json`;
    assert.equal(isProtected(p, set), true, h);
    assert.equal(hit(`mv ${fwd(p)} x`), 'names', h);
  }
  // an unknown remote host is not this computer and is never read over the network
  const t0 = Date.now();
  assert.equal(hit('cp a.txt //10.255.255.1/share/x/y.txt'), 'none');
  assert.equal(isProtected('\\\\10.255.255.1\\c$\\x\\state.json', set), false);
  assert.ok(Date.now() - t0 < 2000, 'no network wait');
});

test('N27: making a hardlink to a protected file is a card in every spelling', opts, () => {
  cards([
    ['cmd', `fsutil hardlink create h.json ${B}\\config.json`], ['cmd', `mklink /H h.json ${B}\\config.json`], ['sh', `ln ${D}/config.json h.json`], ['sh', 'ln ../../config.json h.json'],
    ['pwsh', `New-Item -ItemType HardLink -Path h.json -Target ${B}\\config.json`], ['pwsh', 'New-Item -ItemType HardLink -Path h.json -Value ..\\..\\config.json'],
  ]);
  // an existing hardlink to a protected file is the protected file
  const h = join(ws, 'h-link.json');
  try { execFileSync('cmd', ['/c', 'fsutil', 'hardlink', 'create', h, join(data, 'state.json')], { stdio: 'ignore' }); } catch { return; }
  assert.equal(hit('echo x > h-link.json'), 'names');
});

test('N31: the connectors folder is protected', opts, () => {
  assert.ok(dataFolderTargets(data).some((t) => t.endsWith('connectors')));
  assert.equal(hit(`rm ${D}/connectors/key.bin`), 'names');
});

test('the providers folder (provider API keys) is protected; reading it stays free', opts, () => {
  mkdirSync(join(data, 'providers'), { recursive: true });
  writeFileSync(join(data, 'providers', 'keys.json'), '{}');
  assert.ok(dataFolderTargets(data).some((t) => t.endsWith('providers')));
  for (const c of [`mv ${D}/providers/keys.json x`, `rm ${D}/providers/keys.json`, `cat x > ${D}/providers/keys.json`, 'rm ../../providers/keys.json']) assert.equal(hit(c), 'names', c);
  assert.equal(hit(`Remove-Item ${B}\\providers\\keys.json`, 'pwsh'), 'names');
  assert.equal(hit(`cat ${D}/providers/keys.json`), 'none');
  assert.equal(hit(`Get-Content ${B}\\providers\\keys.json`, 'pwsh'), 'none');
});

test('a line the guard cannot parse (an unclosed quote, substitution or heredoc) is a card; escaped quotes are not unclosed', opts, () => {
  for (const c of ['rm "../../gates/app.json', "mv '../../state.json x", 'echo $(rm x', 'echo `rm x', 'cat <<EOF\nno end', "rm $'../../gates"]) assert.notEqual(hit(c), 'none', c);
  assert.equal(hit('echo $(ls', 'sh', proj), 'hidden', 'even a read-only line');
  assert.equal(hit('grep -o "[^\\"]*" notes.txt', 'sh', proj), 'none');
  assert.equal(hit("echo it's done", 'cmd', proj), 'none');
});

test('ordinary work and plain reads stay free (no card)', opts, () => {
  for (const [k, c, cwd] of [
    ['sh', `cd ${W} && npm install`], ['sh', 'npm install', proj], ['sh', 'npm ci && npm run build && npm test', proj], ['sh', 'git status', proj], ['sh', 'rg -n foo src', proj],
    ['sh', 'git add -A && git commit -m "x $5" && git push', proj], ['sh', 'cp a b', proj], ['sh', 'cp src/a.ts src/b.ts', proj], ['sh', 'rm -rf dist && tsc -p . > build.log 2>&1', proj],
    ['sh', `cat ${D}/state.json`], ['sh', `cat ${D}/state.json; ls -la ${D}; rg foo ${D}`], ['pwsh', `Get-Content ${B}\\config.json`], ['pwsh', 'Get-Content $HOME\\.legion\\config.json'],
    ['sh', 'git diff HEAD~1 -- src/x.ts', proj], ['sh', 'git reset --hard HEAD~1', proj], ['sh', 'for f in *.ts; do cp "$f" "out/$f"; done', proj], ['sh', 'echo $(date) > log.txt', proj],
    ['pwsh', 'Remove-Item -Recurse -Force node_modules; npm install', proj], ['sh', 'mkdir -p ~/projects/new && cd ~/projects/new && git init'], ['sh', 'rm -rf *', proj],
    ['sh', `cat <<EOF > notes.md\nhello\nEOF`, proj],
  ] as Array<[ShellKindName, string, string?]>) assert.equal(hit(c, k, cwd ?? ws), 'none', `${k}: ${c}`);
});
