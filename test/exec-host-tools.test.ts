import test from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval, isLegionTool } from '../src/core/approvals.js';
import { taintsRun } from '../src/core/engine.js';
import { buildHostToolsServer, resolveWithin, windowOrSpill, refuseCatastrophic } from '../src/core/exec/host-tools.js';
import { DirectHostBackend } from '../src/core/exec/direct-host.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAMES = ['mcp__host__shell', 'mcp__host__read_file', 'mcp__host__write_file'];

test('the host tools are NOT Legion tools, so they do not skip the approval card', () => {
  for (const n of NAMES) assert.equal(isLegionTool(n), false, n);
});

test('in ask mode every host tool raises an approval card', () => {
  for (const n of NAMES) assert.equal(needsApproval('ask', n), true, n);
});

test('in auto-edits mode a host shell/write still raises a card (conservative for host access)', () => {
  assert.equal(needsApproval('auto-edits', 'mcp__host__shell'), true);
  assert.equal(needsApproval('auto-edits', 'mcp__host__write_file'), true);
});

test('a full-access agent is honoured: no card in full mode', () => {
  for (const n of NAMES) assert.equal(needsApproval('full', n), false, n);
});

test('every host tool taints the run (it can bring outside content in)', () => {
  for (const n of NAMES) assert.equal(taintsRun(n), true, n);
});

test('read_file/write_file/shell paths stay inside the scope root', () => {
  const root = resolveWithin('/tmp/work', '.');
  assert.ok(root.endsWith('work'));
  // inside is fine
  assert.doesNotThrow(() => resolveWithin('/tmp/work', 'src/a.ts'));
  assert.doesNotThrow(() => resolveWithin('/tmp/work', './src/a.ts'));
  // escaping the root is refused
  assert.throws(() => resolveWithin('/tmp/work', '../outside.txt'), /outside the allowed root/);
  assert.throws(() => resolveWithin('/tmp/work', '/etc/passwd'), /outside the allowed root/);
});

test('the host server builds with the three host tools', () => {
  const srv = buildHostToolsServer({ agentId: 'a', taskId: 't', rootDir: '/tmp/work', backend: new DirectHostBackend() });
  assert.ok(srv, 'server is created');
});

test('long output is spilled to a file with a pointer — every character is kept, nothing lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-spill-'));
  const big = 'A'.repeat(50_000) + 'END';
  const out = await windowOrSpill(big, dir, 'task1', 1000);
  assert.ok(out.includes('the full output is in'), 'the window carries a pointer to the full text');
  assert.ok(out.length < 2500, 'the returned window is bounded');
  // the spill file holds every character of the original
  const m = /the full output is in (.+?)\]/.exec(out);
  assert.ok(m, 'the pointer names a file');
  const spilled = readFileSync(m[1]!.trim(), 'utf8');
  assert.equal(spilled, big, 'the full output is preserved byte-for-byte');
});

test('short output is returned whole with no spill file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-spill-'));
  const out = await windowOrSpill('small', dir, 'task2', 1000);
  assert.equal(out, 'small', 'under the window: returned as-is');
});

test('the safety guard refuses catastrophic commands (the Wipe Lesson floor)', () => {
  for (const cmd of ['rm -rf /', 'rm -rf ~', 'rm -fr /boot', 'mkfs /dev/sda1', 'mkfs.ext4 /dev/sdb', 'dd if=/dev/zero of=/dev/sda', 'format C:', 'diskpart', ':(){ :|:& };:', 'echo x > /dev/sda']) {
    assert.ok(refuseCatastrophic(cmd), `refused: ${cmd}`);
  }
});

test('the safety guard refuses the Windows shapes too: the shell tool runs cmd.exe on Windows', () => {
  for (const cmd of [
    'rd /s /q C:\\', 'rmdir /s /q C:\\', 'RD /S /Q D:\\', 'rd /s /q "C:\\"', 'r^d /s /q C:\\',
    'del /f /s /q C:\\*', 'del /s /q C:\\*.*', 'erase /s /q D:\\',
    'rd /s /q %USERPROFILE%', 'rd /s /q %SystemRoot%', 'rd /s /q C:\\Windows', 'rd /s /q "C:\\Program Files"', 'rd /s /q C:\\Users\\Danie',
    'powershell -c "Remove-Item -Recurse -Force C:\\"', 'pwsh -Command Remove-Item -Recurse -Force $env:USERPROFILE',
    'powershell -c "Get-ChildItem C:\\ | Remove-Item -Recurse -Force"', 'powershell "gci D:\\ -Recurse | ri -Force"',
    'cmd /c rd /s /q C:\\', 'C:\\Windows\\System32\\cmd.exe /c rd /s /q C:\\',
    'vssadmin delete shadows /all /quiet', 'wmic shadowcopy delete', 'wbadmin delete catalog -quiet',
    'bcdedit /delete {current}', 'reg delete HKLM\\SYSTEM /f', 'reg delete HKEY_LOCAL_MACHINE\\SOFTWARE /f',
    'cipher /w:C:\\', 'powershell Format-Volume -DriveLetter C', 'powershell Clear-Disk -Number 0 -RemoveData',
  ]) assert.ok(refuseCatastrophic(cmd), `refused: ${cmd}`);
});

test('the safety guard sees through flag spellings and wrappers on POSIX too', () => {
  for (const cmd of [
    'rm --recursive --force /', 'r\\m -rf /', 'rm -rf -- /', 'rm -r -f /', '/bin/rm -rf /', 'sudo rm -rf /*', 'command rm -rf ~',
    'rm -rf /home/daniel', 'rm -rf "$HOME/"', 'rm -rf ${HOME}', 'rm -rf /etc/', 'bash -c "rm -rf /"', 'ls; rm -rf /',
    'find / -delete', 'find ~ -type f -exec rm {} +',
  ]) assert.ok(refuseCatastrophic(cmd), `refused: ${cmd}`);
});

test('the safety guard does NOT block ordinary Windows or POSIX clean-up', () => {
  for (const cmd of [
    'rd /s /q build', 'rmdir /s /q dist', 'rd /s /q C:\\proj\\build', 'del /q *.log', 'del /s /q .\\tmp\\*', 'erase old.txt',
    'powershell -c "Remove-Item -Recurse -Force node_modules"', 'powershell "Get-ChildItem . -Filter *.tmp | Remove-Item"',
    'reg query HKLM\\SOFTWARE\\Microsoft', 'vssadmin list shadows', 'bcdedit /enum', 'cipher /e secret.txt',
    'rm --recursive --force build', 'rm -rf ./node_modules', 'rm -rf ~/proj/build', 'rm -rf $HOME/.cache/legion',
    'find . -name "*.tmp" -delete', 'git clean -fdx', 'format-check src',
    // a delete word as DATA (a search term, a filter) is not a delete: only a word in command position runs
    'grep -rn "rm" /etc', 'rg -n del ~', 'ls ~ | grep rm', 'ls / | grep -v rd', 'dir C:\\ | findstr del',
    'powershell "Get-ChildItem C:\\ -Recurse | Select-String del"', 'git commit -m "docs: never run rd /s /q C:\\ on a server"',
  ]) assert.equal(refuseCatastrophic(cmd), undefined, `allowed: ${cmd}`);
});

test('the safety guard does NOT block ordinary work', () => {
  for (const cmd of ['echo hi', 'git push', 'npm test', 'rm -rf node_modules', 'rm old.txt', 'rm -rf build/', 'cat package.json', 'ls -la', 'tsc -p tsconfig.json']) {
    assert.equal(refuseCatastrophic(cmd), undefined, `allowed: ${cmd}`);
  }
});

test('the host shell never gets Legion\'s own credentials: API keys, the boat key, the bearer token, or any variable holding one', async () => {
  const { buildHostShellEnv } = await import('../src/core/engine.js');
  const { defaultConfig } = await import('../src/shared/config.js');
  const cfg = defaultConfig();
  cfg.claude.apiKey = 'sk-' + 'ant-legion-own-key-0123456789';
  cfg.boat.apiKey = 'boat-legion-own-key-0123456789';
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BOAT_API_KEY', 'LEGION_LEAK_A', 'LEGION_LEAK_B', 'LEGION_LEAK_C', 'GITHUB_TOKEN', 'LEGION_PLAIN'];
  const prev = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-' + 'ant-from-the-environment';
    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-from-the-environment';
    process.env.BOAT_API_KEY = 'boat-from-the-environment';
    process.env.LEGION_LEAK_A = `x${cfg.authToken}y`;
    process.env.LEGION_LEAK_B = `Bearer ${cfg.claude.apiKey}`;
    process.env.LEGION_LEAK_C = cfg.boat.apiKey.toUpperCase();
    process.env.GITHUB_TOKEN = 'ghp' + '_the_owners_own_token';
    process.env.LEGION_PLAIN = 'ordinary';
    const env = buildHostShellEnv(cfg);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BOAT_API_KEY', 'LEGION_LEAK_A', 'LEGION_LEAK_B', 'LEGION_LEAK_C']) assert.equal(k in env, false, k);
    // the owner's own tools still work: PATH, and credentials the owner put there for the agent's work (git push)
    assert.ok(env.PATH ?? env.Path, 'PATH is kept');
    assert.equal(env.GITHUB_TOKEN, 'ghp' + '_the_owners_own_token');
    assert.equal(env.LEGION_PLAIN, 'ordinary');
  } finally { for (const k of names) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
});

test('the direct-host backend runs a command with the environment it was given, not the core\'s own', async () => {
  const prev = process.env.LEGION_HOST_SECRET;
  process.env.LEGION_HOST_SECRET = 'core-only';
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'LEGION_HOST_SECRET') env[k] = v;
    const b = new DirectHostBackend({ env });
    const r = await b.execute({ cmd: 'node -e "console.log(process.env.LEGION_HOST_SECRET || \'absent\')"', timeoutMs: 20_000 });
    assert.equal(r.exit_code, 0, r.output);
    assert.match(r.output, /absent/);
    // and with no env given it still behaves as before: the core's environment
    const r2 = await new DirectHostBackend().execute({ cmd: 'node -e "console.log(process.env.LEGION_HOST_SECRET || \'absent\')"', timeoutMs: 20_000 });
    assert.match(r2.output, /core-only/);
  } finally { if (prev === undefined) delete process.env.LEGION_HOST_SECRET; else process.env.LEGION_HOST_SECRET = prev; }
});

test('the guard stays fast on a command of 100 000 rm words (no rescan per word)', () => {
  const t = Date.now();
  refuseCatastrophic('rm '.repeat(100_000));
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test('a protected target is recognised however it is spelled: dot segments, macOS homes, System32', () => {
  for (const cmd of ['rm -rf /Users/dan', 'rm -rf /Users', 'rd /s /q C:\\Windows\\System32', 'rm -rf /.', 'rd /s /q C:\\.', 'rm -rf /home/x/..', 'rd /s /q C:\\Users\\Danie\\..', 'rm -rf ~/./'])
    assert.ok(refuseCatastrophic(cmd), `refused: ${cmd}`);
  for (const cmd of ['rm -rf /Users/dan/proj/build', 'rd /s /q C:\\Windows\\Temp\\legion', 'rm -rf ./a/../b', 'rm -rf ~/proj/../proj2/dist'])
    assert.equal(refuseCatastrophic(cmd), undefined, `allowed: ${cmd}`);
});

test('Git Bash drive paths are drives: /c, /c/Users, /cygdrive/c and /mnt/c are refused like C:\\ (Git\'s rm runs from cmd.exe too)', () => {
  // Git for Windows puts its Unix tools (rm.exe) on PATH, and they read /c as the C: drive, from Git Bash AND from cmd.exe
  for (const cmd of [
    'rm -rf /c', 'rm -rf /c/', 'rm -rf /c/*', 'rm -rf /d/*', 'rm -rf /C', 'rm -rf /c/Users', 'rm -rf /c/Users/Danie', 'rm -rf /c/Windows',
    'rm -rf "/c/Program Files"', 'rm -rf /c/ProgramData', 'rm -rf /c/Windows/System32', 'rm -rf /cygdrive/c', 'rm -rf /mnt/c/', 'rm -rf /c/Users/Danie/..',
    'rm -rf "$USERPROFILE"', 'rm -rf $USERPROFILE/', 'rm -rf ${USERPROFILE}', 'rm -rf $SYSTEMROOT', 'rm -rf "${PROGRAMFILES}"', 'rm -rf $WINDIR',
  ]) assert.ok(refuseCatastrophic(cmd), `refused: ${cmd}`);
  // a folder INSIDE a drive, a home or a project stays ordinary work, in the Git Bash spelling too
  for (const cmd of ['rm -rf /c/work/site/dist', 'rm -rf /d/bots/legion/node_modules', 'rm -rf /c/Users/Danie/proj/build', 'rm -rf "$USERPROFILE/proj/build"', 'rm -rf /tmp/x', 'rm -rf /mnt/c/work/out'])
    assert.equal(refuseCatastrophic(cmd), undefined, `allowed: ${cmd}`);
});

test('a command substitution is a command too: $(…) and backticks are judged', () => {
  for (const cmd of ['echo $(rm -rf /)', 'echo `rm -rf ~`', 'x=$(sudo rm -rf /etc)']) assert.ok(refuseCatastrophic(cmd), `refused: ${cmd}`);
  assert.equal(refuseCatastrophic('echo $(date) `whoami`'), undefined);
});

test('the guard stays fast on a huge command with an unclosed quote (it runs on the core\'s event loop)', () => {
  for (const q of ['"', "'"]) {
    const cmd = `echo ${q}` + 'a '.repeat(100_000);
    const t = Date.now();
    assert.equal(refuseCatastrophic(cmd), undefined);
    assert.ok(Date.now() - t < 500, `200 KB with an open ${q} took ${Date.now() - t} ms`);
  }
});

test('a link inside the root that points outside it is refused: read, write and shell cwd all check the real path', async () => {
  const { symlinkSync, writeFileSync: wf, existsSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'legion-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'legion-outside-'));
  wf(join(outside, 'secret.txt'), 'outside the scope');
  symlinkSync(outside, join(root, 'link'), 'junction');
  const srv = buildHostToolsServer({ agentId: 'a', taskId: 't', rootDir: root, backend: new DirectHostBackend() });
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await (srv as any).instance._registeredTools[name].handler(args, {});
    return { text: out.content.map((c: any) => c.text).join('\n'), isError: out.isError === true };
  };
  const read = await call('read_file', { path: 'link/secret.txt' });
  assert.equal(read.isError, true, read.text);
  assert.doesNotMatch(read.text, /outside the scope/);
  const write = await call('write_file', { path: 'link/new.txt', content: 'x' });
  assert.equal(write.isError, true, write.text);
  assert.equal(existsSync(join(outside, 'new.txt')), false, 'nothing was written outside the root');
  const sh = await call('shell', { command: 'echo hi', cwd: 'link' });
  assert.equal(sh.isError, true, sh.text);
  // a normal folder inside the root still works
  const ok = await call('write_file', { path: 'sub/dir/file.txt', content: 'in scope' });
  assert.equal(ok.isError, false, ok.text);
});

test('the guard judges quoted text as a command only when the line runs text: a commit message or a grep pattern passes', () => {
  // data, not commands: nothing here runs the quoted text
  for (const ok of [
    'git commit -m "fix the rm -rf / bug in the installer"',
    'git commit -m "rm -rf / is now refused by the guard"',
    'grep "vssadmin delete shadows" notes.txt',
    'echo "never run format C: here" > notes.txt',
    'rg -n "Remove-Item -Recurse -Force C:\\" docs',
  ]) assert.equal(refuseCatastrophic(ok), undefined, ok);
  // the same text handed to something that runs it is still refused
  for (const bad of [
    'echo "rm -rf /" | sh',
    'bash -c "rm -rf /"',
    'powershell -Command "Remove-Item -Recurse -Force C:\\"',
    'ssh host "rm -rf /"',
    'eval "rm -rf /"',
    'echo $(rm -rf /)',
    'vssadmin delete shadows /all /quiet',
    'cmd /c vssadmin delete shadows /all',
    'sudo reg delete HKLM\\SYSTEM /f',
  ]) assert.ok(refuseCatastrophic(bad), bad);
});

test('REVIEW: a whole-machine command behind any prefix is still refused (start, call, &, a group, timeout, wsl, if)', () => {
  for (const bad of [
    'start "" format c:',
    'call format c:',
    '& format c:',
    'if 1==1 format c:',
    '(mkfs.ext4 /dev/sda)',
    '{ mkfs.ext4 /dev/sda; }',
    'timeout 5 diskpart',
    'wsl mkfs.ext4 /dev/sdb',
    'start "" vssadmin delete shadows /all',
    'runas /user:admin "wbadmin delete catalog"',
  ]) assert.ok(refuseCatastrophic(bad), bad);
});

test('Windows: a path in the shell\'s own form (/d/work/x, /tmp/x, from `pwd` in Git Bash) is the same file to read_file and write_file', { skip: process.platform !== 'win32' }, async () => {
  const { writeFileSync: wf } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'legion-msys-'));
  wf(join(root, 'a.txt'), 'found it');
  const srv = buildHostToolsServer({ agentId: 'a', taskId: 't', rootDir: root, backend: new DirectHostBackend() });
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await (srv as any).instance._registeredTools[name].handler(args, {});
    return { text: out.content.map((c: any) => c.text).join('\n'), isError: out.isError === true };
  };
  const fwd = root.replace(/\\/g, '/');
  const driveForm = `/${fwd[0]!.toLowerCase()}${fwd.slice(2)}/a.txt`; // C:/Users/... -> /c/Users/...
  assert.equal((await call('read_file', { path: driveForm })).text, 'found it', driveForm);
  const tmp = tmpdir().replace(/\\/g, '/');
  if (fwd.toLowerCase().startsWith(tmp.toLowerCase())) {
    const tmpForm = `/tmp${fwd.slice(tmp.length)}/a.txt`;
    assert.equal((await call('read_file', { path: tmpForm })).text, 'found it', tmpForm);
  }
  // still scoped: a shell-form path outside the root is refused
  const outside = await call('read_file', { path: '/c/Windows/win.ini' });
  assert.equal(outside.isError, true);
});
