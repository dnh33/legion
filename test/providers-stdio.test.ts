import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import { run, setup, until } from './providers-harness.js';
import { repoRoot } from './ps-helpers.js';
import { resolveLaunch, scrubbedEnv, stdioMcpEnvAllow } from '../src/core/providers/proc.js';
import { stdioCommandLine, stdioFingerprint } from '../src/core/providers/stdio-allow.js';
import { ScrubbedStdioTransport } from '../src/core/providers/stdio-transport.js';
import { connectExternal } from '../src/core/providers/external-mcp.js';

const TREE = join(repoRoot, 'test/fixtures/fake-mcp-tree.mjs');
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidsOf = (file: string): Record<string, number> => Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map((l) => { const [k, v] = l.split(' '); return [k!, Number(v)]; }));
const waitGone = async (...pids: number[]) => { await until(() => pids.every((p) => !alive(p)), 8000); };

function treeSetup(f: Awaited<ReturnType<typeof startFake>>, pidFile: string, allow: boolean) {
  const h = setup(f, { agent: { approval: 'full', mcpServers: ['tree'] } });
  h.config.mcpServers = { tree: { command: process.execPath, args: [TREE], env: { PID_FILE: pidFile } } } as any;
  if (allow) h.config.providers.stdioMcpAllow.tree = stdioFingerprint(h.config.mcpServers.tree as any);
  return h;
}

test('A1 default OFF: a stdio server from Settings is not started and not offered in a provider run, and the thread says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-tree-')); const pidFile = join(dir, 'pids');
  const f = await startFake((_r, res) => replyText(res, 'fine'));
  try {
    const h = treeSetup(f, pidFile, false);
    const t = await run(h);
    assert.equal(t.status, 'done');
    assert.equal(existsSync(pidFile), false, 'no process was started');
    assert.equal((f.requests[0]!.body.tools ?? []).some((x: any) => x.function.name.startsWith('mcp__tree__')), false);
    assert.ok(h.store.listMessages(t.id).some((m) => m.role === 'system' && /not allowed for provider runs/.test(m.text)));
  } finally { await f.close(); }
});

test('A1 allowed: it starts with a scrubbed environment, and the whole process tree (server and its grandchild) is gone when the run ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-tree-')); const pidFile = join(dir, 'pids');
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'e1', name: 'mcp__tree__echo', args: { text: 'x' } }]); else replyText(res, 'ok'); });
  try {
    const h = treeSetup(f, pidFile, true);
    const t = await run(h);
    assert.equal(t.status, 'done');
    const p = pidsOf(pidFile);
    await waitGone(p.server!, p.grandchild!);
    assert.equal(alive(p.server!), false); assert.equal(alive(p.grandchild!), false);
  } finally { await f.close(); }
});

test('A1 cancel while a tool call hangs: the server and its grandchild are killed by PID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-tree-')); const pidFile = join(dir, 'pids');
  const f = await startFake((_r, res) => replyTools(res, [{ id: 'h1', name: 'mcp__tree__hang', args: {} }]));
  try {
    const h = treeSetup(f, pidFile, true);
    const t = h.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' } as any);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').includes('grandchild'), 15000);
    await new Promise((r) => setTimeout(r, 400));
    const p = pidsOf(pidFile);
    assert.equal(alive(p.server!), true); assert.equal(alive(p.grandchild!), true);
    h.engine.cancel(t.id);
    await waitGone(p.server!, p.grandchild!);
    assert.equal(alive(p.server!), false); assert.equal(alive(p.grandchild!), false);
  } finally { await f.close(); }
});

test('A1 the approval is bound to the exact command line: changing the command, an argument or an env value turns it off again', () => {
  const base = { command: '/usr/bin/tool', args: ['--a'], env: { K: 'v' } };
  const fp = stdioFingerprint(base);
  assert.notEqual(stdioFingerprint({ ...base, command: '/usr/bin/other' }), fp);
  assert.notEqual(stdioFingerprint({ ...base, args: ['--a', '--b'] }), fp);
  assert.notEqual(stdioFingerprint({ ...base, env: { K: 'w' } }), fp);
  assert.notEqual(stdioFingerprint({ ...base, env: { K: 'v', L: '1' } }), fp);
  assert.equal(stdioFingerprint({ ...base, env: { K: 'v' } }), fp);
  assert.doesNotMatch(stdioCommandLine({ ...base, env: { K: 'secret-value' } }), /secret-value/, 'env values are never shown');
  assert.match(stdioCommandLine({ command: 'C:\\Program Files\\x\\y.exe', args: ['a b'] }), /"C:\\\\Program Files/);
});

test('A1 Windows semantics (pure): .cmd launchers go through cmd.exe with checked, quoted arguments; unsafe characters are refused, not escaped', () => {
  const w = (c: string, a: string[]) => resolveLaunch(c, a, { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.deepEqual(w('C:\\tools\\srv.exe', ['a b']), { file: 'C:\\tools\\srv.exe', args: ['a b'] }, 'an .exe is started directly');
  const c = w('C:\\Program Files\\n\\npx.cmd', ['-y', 'some pkg', '']);
  assert.equal(c.file, 'C:\\Windows\\System32\\cmd.exe'); assert.equal(c.windowsVerbatimArguments, true);
  assert.deepEqual(c.args, ['/d', '/s', '/c', '""C:\\Program Files\\n\\npx.cmd" -y "some pkg" """']);
  assert.equal(resolveLaunch('x.bat', [], { platform: 'win32' }).file, 'cmd.exe', 'a missing COMSPEC falls back to cmd.exe');
  assert.equal(resolveLaunch('x.cmd', [], { platform: 'win32', comspec: 'C:\\evil\\powershell.exe' }).file, 'cmd.exe');
  for (const bad of ['a&calc', 'a|b', 'a>b', 'a<b', 'a^b', 'a"b', '%PATH%', 'a!b', '(x)', 'a\nb', 'a`b']) assert.throws(() => w('t.cmd', [bad]), /cannot take arguments/, bad);
  assert.throws(() => w('C:\\a&b\\t.cmd', []), /cannot take arguments/, 'the command path too');
  assert.throws(() => w('t.cmd', ['dir with space\\']), /backslash/);
  assert.throws(() => w('t.ps1', []), /only .exe/);
  assert.throws(() => w('', []), /not valid/);
  // POSIX: nothing is rewritten, a file called x.cmd is just a program
  assert.deepEqual(resolveLaunch('/opt/x.cmd', ['a&b'], { platform: 'linux' }), { file: '/opt/x.cmd', args: ['a&b'] });
});

test('A1 Windows semantics (pure): Path and PATH are one variable, an owner entry replaces it whatever its case, only allowed names pass, and a shell function export is dropped', () => {
  const src = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'k-should-not-pass', LEGION_TEST_SECRET: 'x', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD', FUNC: '() { x; }' };
  const e = scrubbedEnv(src, stdioMcpEnvAllow('win32'), { PATH: 'C:\\owner' }, 'win32');
  assert.deepEqual(Object.keys(e).sort(), ['ComSpec', 'PATH', 'PATHEXT', 'SystemRoot']);
  assert.equal(e.PATH, 'C:\\owner'); assert.equal('Path' in e, false, 'one Path, not two');
  const p = scrubbedEnv({ PATH: '/bin', HOME: '/h', path: '/lower', OPENAI_API_KEY: 'k' }, stdioMcpEnvAllow('linux'), {}, 'linux');
  assert.deepEqual(Object.keys(p).sort(), ['HOME', 'PATH'], 'on POSIX case matters and only allowed names pass');
});

test('A1 a program that cannot start gives a plain error, and a start that ends at once is not left hanging', async () => {
  await assert.rejects(() => connectExternal('x', { command: join(tmpdir(), 'no-such-program-legion') }), /ENOENT|not valid|ended/i);
  const t = new ScrubbedStdioTransport({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
  await assert.rejects(() => t.start().then(() => new Promise((_, rej) => { t.onclose = () => rej(new Error('closed')); })));
});

