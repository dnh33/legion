/**
 * LocalRunner with a fake blender: `node fake-blender.mjs <real argument list>` (works the same on Windows and POSIX). The ProcessPort is the real
 * one from system.ts (real spawn, real tree kill) with the test seam pointing at the fake; the runner script itself is tested in
 * blender-local-runner.test.ts with real python and a stub bpy.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { defaultBlenderConfig } from '../src/shared/blender.js';
import type { BlenderConfig } from '../src/shared/blender.js';
import { safeSegment } from '../src/core/blender/exports.js';
import { LOCAL_RUNNER_PY, LocalRunner, buildArgs, buildEnv } from '../src/core/blender/local.js';
import type { LocalDeps } from '../src/core/blender/local.js';
import type { ProcessPort, SpawnRequest, SpawnedProcess } from '../src/core/blender/ports.js';
import { scriptHash } from '../src/core/blender/static-check.js';
import { createProcessPort } from '../src/core/blender/system.js';
import { agent, tmp } from './blender-helpers.js';
import { linkOrSkip, tryLink } from './fs-links.js';

type Plan = Record<string, unknown> & { mode: 'ok' | 'env' | 'sleep' | 'spam' | 'foreign' | 'badhash' | 'noresult' | 'slow' | 'inspect' | 'preview' | 'bytes' };

const FAKE = (plan: Plan): string => `
import { readFileSync, writeFileSync, renameSync, mkdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const PLAN = ${JSON.stringify(plan)};
const args = process.argv.slice(2);
const i = args.indexOf('--');
const [task, run, hash] = args.slice(i + 1);
const raw = readFileSync(join(task, 'script-' + run + '.py'));
const done = (o) => { const f = join(task, 'result-' + run + '.json'); writeFileSync(f + '.t', JSON.stringify({ ok: true, output: '', run, hash, violations: [], ...o })); renameSync(f + '.t', f); };
const putExports = () => {
  for (const [n, c] of Object.entries(PLAN.exports || {})) writeFileSync(join(task, 'exports', n), c);
  if (PLAN.bigFile) writeFileSync(join(task, 'exports', PLAN.bigFile), Buffer.alloc(16 * 1024 * 1024 + 1));
  if (PLAN.linkTo) { try { symlinkSync(PLAN.linkTo, join(task, 'exports', 'planted'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { writeFileSync(join(task, 'nolink.txt'), 'x'); } }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (PLAN.tmpJunk) writeFileSync(join(task, 'tmp', 'junk.bin'), 'junk');
if (PLAN.saveScene !== false) writeFileSync(join(task, 'scene.blend'), PLAN.sceneText || 'BLEND');
switch (PLAN.mode) {
  case 'ok': putExports(); done({ output: 'fake ran' }); break;
  case 'bytes': done({ output: 'sha=' + createHash('sha256').update(raw).digest('hex') + ' len=' + raw.length + ' bom=' + (raw[0] === 0xef) }); break;
  case 'env': done({ output: JSON.stringify({ env: process.env, cwd: process.cwd(), args }) }); break;
  case 'foreign': done({ run: 'zzzzzzzzzzzzzzzz', output: 'FOREIGN' }); break;
  case 'badhash': done({ hash: 'f'.repeat(64), output: 'WRONG-SCRIPT' }); break;
  case 'noresult': console.error('boom: no result written'); process.exit(3); break;
  case 'slow': await sleep(PLAN.ms || 300); putExports(); done({ output: 'slow done' }); break;
  case 'spam': { const chunk = 'x'.repeat(8192); writeFileSync(join(PLAN.pidDir, 'self.pid'), String(process.pid)); for (;;) { process.stdout.write(chunk); await sleep(5); } }
  case 'sleep': {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(join(PLAN.pidDir, 'child.pid'), String(child.pid));
    writeFileSync(join(PLAN.pidDir, 'self.pid'), String(process.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case 'inspect': done({ output: JSON.stringify({ objects: [{ name: 'Cube' }, { name: 'Sphere' }], object_count: 2 }) }); break;
  case 'preview': { const m = /preview-[0-9a-f]+\\.png/.exec(raw.toString('utf8')); writeFileSync(join(task, m[0]), Buffer.from([0x89, 0x50, 0x4e, 0x47])); done({ output: 'preview rendered' }); break; }
}
`;

class TestPort implements ProcessPort {
  private readonly inner = createProcessPort(() => undefined);
  spawns: Array<SpawnRequest & { file?: string; prefixArgs?: string[] }> = [];
  inFlight = 0;
  maxInFlight = 0;
  noKill = false;
  pids: number[] = [];
  killCalls: number[] = [];
  killDelayMs = 0;
  /** What runner.py held at the moment of each spawn. */
  runnerSeen: string[] = [];
  file = process.execPath;
  constructor(readonly fake: string) {}
  spawn(req: SpawnRequest): SpawnedProcess {
    this.spawns.push(req);
    try { this.runnerSeen.push(readFileSync(req.args[req.args.indexOf('--python') + 1]!, 'utf8')); } catch { this.runnerSeen.push('<unreadable>'); }
    const p = this.inner.spawn({ ...req, file: this.file, prefixArgs: this.file === process.execPath ? [this.fake] : [] });
    if (p.pid) this.pids.push(p.pid);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    void p.exited.then(() => { this.inFlight--; });
    return p;
  }
  async kill(pid: number): Promise<boolean> {
    this.killCalls.push(pid);
    if (this.killDelayMs) await sleep(this.killDelayMs);
    return this.noKill ? false : this.inner.kill(pid);
  }
  realKill(pid: number): Promise<boolean> { return this.inner.kill(pid); }
}

interface Rig { runner: LocalRunner; port: TestPort; data: string; ws: string; base: string; cfg: BlenderConfig; a: ReturnType<typeof agent>; root: string; task: (id: string) => string }

function rig(plan: Plan, o: { dataName?: string; deps?: Partial<LocalDeps>; cfg?: (c: BlenderConfig) => void; version?: string } = {}): Rig {
  const base = tmp('legion-bl-loc-');
  const data = join(base, o.dataName ?? 'data');
  const ws = join(base, 'ws');
  mkdirSync(data, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const fake = join(base, 'fake-blender.mjs');
  writeFileSync(fake, FAKE({ pidDir: base, ...plan }));
  const cfg = defaultBlenderConfig();
  o.cfg?.(cfg);
  const port = new TestPort(fake);
  const runner = new LocalRunner({
    proc: port, config: () => cfg, dataDir: data, workspaceOf: () => ws,
    install: () => ({ path: join(base, 'Blender 5.1', 'blender.exe'), version: o.version ?? '5.1.0' }), ...o.deps,
  });
  const root = join(data, 'blender', 'local');
  return { runner, port, data, ws, base, cfg, a: agent(), root, task: (id) => join(root, safeSegment(id)) };
}
const req = (r: Rig, script = 'print(1)\n', taskId = 't1', timeoutMs = 20_000) => ({ agent: r.a, taskId, script, hash: scriptHash(script), timeoutMs });
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** True when the process is gone (a zombie that nobody reaped counts as gone). */
async function isGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    try {
      process.kill(pid, 0);
      try { if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return true; } catch { /* not Linux */ }
    } catch { return true; }
    await sleep(100);
  }
  return false;
}
const readPid = (r: Rig, name: string): number => Number(readFileSync(join(r.base, name), 'utf8'));

test('readiness: no Blender, too old, and ready', () => {
  const none = new LocalRunner({ proc: new TestPort('x'), config: () => defaultBlenderConfig(), dataDir: tmp(), workspaceOf: () => tmp(), install: () => undefined });
  assert.equal(none.readiness(agent()).ready, false);
  assert.match(none.readiness(agent()).note, /not found on this computer/);
  assert.equal(rig({ mode: 'ok' }, { version: '2.93.0' }).runner.readiness(agent()).ready, false);
  // B4: the local minimum is 4.2 (3.0 to 4.1 still work for the live community backend, not for local runs)
  for (const v of ['3.6.5', '4.1.1', '4.0.0']) assert.equal(rig({ mode: 'ok' }, { version: v }).runner.readiness(agent()).ready, false, v);
  assert.match(rig({ mode: 'ok' }, { version: '4.1.1' }).runner.readiness(agent()).note, /need 4\.2\.0 or newer/);
  for (const v of ['4.2.0', '4.5.14', '5.2.2']) assert.equal(rig({ mode: 'ok' }, { version: v }).runner.readiness(agent()).ready, true, v);
  const ok = rig({ mode: 'ok' }).runner.readiness(agent());
  assert.equal(ok.ready, true);
  assert.match(ok.note, /5\.1\.0/);
  assert.doesNotMatch(ok.note, /sandbox/i);
});

test('run: exact argument list, cwd is the task folder, the runner file is Legion\'s, output and exports come back', async () => {
  const r = rig({ mode: 'ok', exports: { 'cube.glb': 'glTF-bytes' } });
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, true, res.text);
  assert.match(res.text, /fake ran/);
  assert.equal(r.port.spawns.length, 1);
  const s = r.port.spawns[0]!;
  const task = r.task('t1');
  const runnerPy = join(r.root, 'runner.py');
  const run = s.args[s.args.indexOf('--') + 2]!;
  assert.match(run, /^[0-9a-f]{16}$/);
  assert.deepEqual(s.args, ['-b', '--factory-startup', '--offline-mode', '--disable-autoexec', '--python-exit-code', '3', '--python', runnerPy, '--', task, run, scriptHash('print(1)\n')]);
  assert.equal(s.cwd, task);
  assert.equal(readFileSync(runnerPy, 'utf8'), LOCAL_RUNNER_PY);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0]!.path, join(r.ws, 'blender-exports', safeSegment('t1'), 'cube.glb'));
  assert.equal(readFileSync(res.files[0]!.path, 'utf8'), 'glTF-bytes');
  assert.match(res.text, /exports in your workspace/);
  assert.equal(readFileSync(join(task, 'scene.blend'), 'utf8'), 'BLEND', 'the scene is kept per task');
  // C16: the task folder is not in the agent's workspace
  assert.equal(existsSync(join(r.ws, 't1')), false);
  // leftovers: the script and result files are removed, the exports folder is emptied
  assert.deepEqual(readdirSync(task).filter((n) => /^(script|result)-/.test(n)), []);
  assert.deepEqual(readdirSync(join(task, 'exports')), []);
});

test('blender.baseDir: the local scene/tmp folder and the copied-back exports both move under the configured base', async () => {
  const bd = tmp('legion-bl-base-');
  const r = rig({ mode: 'ok', exports: { 'cube.glb': 'glTF-bytes' } }, { cfg: (c) => { c.baseDir = bd; } });
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, true, res.text);
  const seg = safeSegment('t1');
  const movedRoot = join(bd, 'local');
  assert.equal(readFileSync(join(movedRoot, 'runner.py'), 'utf8'), LOCAL_RUNNER_PY, 'the local work folder moved to the base');
  assert.equal(readFileSync(join(movedRoot, seg, 'scene.blend'), 'utf8'), 'BLEND', 'the per-task scene lives under the base');
  assert.equal(existsSync(join(r.data, 'blender', 'local')), false, 'nothing is written under the data folder when a base is set');
  assert.equal(res.files[0]!.path, join(bd, 'exports', seg, 'cube.glb'), 'exports land under the base, not the workspace');
});

test('the script reaches Blender as exactly the approved bytes (UTF-8, no BOM, CRLF kept)', async () => {
  const r = rig({ mode: 'bytes' });
  const script = 'import bpy\r\nprint("café 😀")\r\n';
  const res = await r.runner.run(req(r, script));
  const want = createHash('sha256').update(script, 'utf8').digest('hex');
  assert.match(res.text, new RegExp(`sha=${want} len=${Buffer.byteLength(script)} bom=false`), res.text);
});

test('C11: the child gets an allowlisted environment; secrets, proxies and PYTHONPATH of the parent never reach it', async () => {
  const set = { ANTHROPIC_API_KEY: 'sk-ant-secret', HTTPS_PROXY: 'http://proxy.invalid:1', HTTP_PROXY: 'http://proxy.invalid:1', PYTHONPATH: '/evil', LEGION_ADMIN: 'tok', GITHUB_TOKEN: 'ghp_x', APPDATA: '/appdata', LOCALAPPDATA: '/local', BLENDER_USER_SCRIPTS: '/parents-scripts', PYTHONSTARTUP: '/evil.py' };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const r = rig({ mode: 'env' });
    const res = await r.runner.run(req(r));
    assert.equal(res.ok, true, res.text);
    const seen = JSON.parse(res.text.split('\n')[0]!) as { env: Record<string, string>; cwd: string };
    const task = r.task('t1');
    const keys = Object.keys(seen.env).map((k) => k.toLowerCase());
    for (const k of Object.keys(set)) {
      if (k === 'BLENDER_USER_SCRIPTS') { assert.notEqual(seen.env[k], '/parents-scripts'); continue; }
      assert.ok(!keys.includes(k.toLowerCase()), `${k} leaked into the child environment`);
    }
    assert.ok(!JSON.stringify(seen.env).includes('sk-ant-secret'));
    const allowed = new Set(['systemroot', 'systemdrive', 'windir', 'comspec', 'pathext', 'path', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'lang', 'pythonutf8', 'pythonioencoding',
      'blender_user_config', 'blender_user_scripts', 'blender_user_datafiles', 'blender_user_extensions']);
    // Windows adds a few standard variables of its own to every process, whatever the parent passes (user name, home drive, ...): measured with a bare
    // Node child; the product's allowlist cannot remove them. The leak checks above (keys, proxies, PYTHONPATH, tokens) are what C11 proves.
    if (process.platform === 'win32') for (const k of ['homedrive', 'homepath', 'logonserver', 'userdomain', 'username', 'windir', 'systemdrive', 'systemroot', 'path']) allowed.add(k);
    for (const k of keys) assert.ok(allowed.has(k), `unexpected variable ${k}`);
    assert.ok(keys.includes('pythonutf8') && keys.includes('pythonioencoding'));
    assert.equal(seen.env.PYTHONUTF8, '1');
    const tempKey = Object.keys(seen.env).find((k) => k.toLowerCase() === 'temp')!;
    assert.equal(seen.env[tempKey], join(task, 'tmp'));
    assert.ok(seen.env.BLENDER_USER_CONFIG!.startsWith(join(r.root, 'home.d')));
    assert.ok(seen.env.BLENDER_USER_SCRIPTS!.startsWith(join(r.root, 'home.d')));
    assert.equal(seen.cwd.toLowerCase(), task.toLowerCase());
    // what the port was handed is the same object the child saw: no merge with process.env happens anywhere
    assert.deepEqual(Object.keys(r.port.spawns[0]!.env).sort(), Object.keys(buildEnv({ platform: process.platform, host: process.env, blenderDir: join(r.base, 'Blender 5.1'), taskDir: task, homeDir: join(r.root, 'home.d') })).sort());
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('C11: buildEnv for Windows and POSIX hosts (pure)', () => {
  const host = { SystemRoot: 'C:\\Windows', SystemDrive: 'C:', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE', Path: 'C:\\evil', ANTHROPIC_API_KEY: 'k', USERNAME: 'Dan' };
  const w = buildEnv({ platform: 'win32', host, blenderDir: 'C:\\Program Files\\Blender Foundation\\Blender 5.1', taskDir: 'C:\\d\\t', homeDir: 'C:\\d\\home.d' });
  assert.equal(w.Path, 'C:\\Program Files\\Blender Foundation\\Blender 5.1;C:\\Windows\\System32');
  assert.equal(w.SystemRoot, 'C:\\Windows');
  assert.equal(w.USERPROFILE, 'C:\\d\\home.d');
  assert.ok(!('ANTHROPIC_API_KEY' in w) && !('USERNAME' in w) && !('APPDATA' in w) && !('LOCALAPPDATA' in w));
  const p = buildEnv({ platform: 'linux', host, blenderDir: '/opt/blender', taskDir: '/d/t', homeDir: '/d/home.d' });
  assert.equal(p.PATH, '/opt/blender:/usr/bin:/bin');
  assert.equal(p.HOME, '/d/home.d');
  assert.equal(p.LANG, 'C.UTF-8');
  assert.ok(!('DISPLAY' in p) && !('ANTHROPIC_API_KEY' in p));
});

test('buildArgs: the fixed hardening flags are always there; user args cannot remove them and go before --python; guard and extra folders are passed on', () => {
  const base = { runner: '/r.py', taskDir: '/t', runId: 'abc', hash: 'h', readonly: false, guard: 'block' as const, extraWriteDirs: [], userArgs: [] };
  assert.deepEqual(buildArgs(base).slice(0, 6), ['-b', '--factory-startup', '--offline-mode', '--disable-autoexec', '--python-exit-code', '3']);
  const a = buildArgs({ ...base, readonly: true, guard: 'log', extraWriteDirs: ['/x y'], userArgs: ['--debug-python'] });
  assert.deepEqual(a.slice(6), ['--debug-python', '--python', '/r.py', '--', '/t', 'abc', 'h', 'readonly', 'log', 'allow:/x y']);
  assert.equal(a.filter((x) => x === '--offline-mode').length, 1);
});

test('config: guard log, extra write folders and extra args reach the command line', async () => {
  const r = rig({ mode: 'ok' }, { cfg: (c) => { c.advanced.local.guard = 'log'; c.advanced.local.extraWriteDirs = [join(tmp(), 'more')]; c.advanced.local.args = ['--debug-python']; } });
  await r.runner.run(req(r));
  const a = r.port.spawns[0]!.args;
  assert.ok(a.includes('log') && a.some((x) => x.startsWith('allow:')) && a.indexOf('--debug-python') < a.indexOf('--python'));
});

test('C14: a timeout stops the process AND its child by PID, and says so; the previous scene copy is named', async () => {
  const r2 = rig({ mode: 'sleep', sceneText: 'S1' }, { deps: { stopWaitMs: 4000 } });
  mkdirSync(r2.task('t1'), { recursive: true });
  writeFileSync(join(r2.task('t1'), 'scene.blend'), 'OLD');
  let pids: number[] = [];
  try {
    const res = await r2.runner.run(req(r2, 'x=1\n', 't1', 1500));
    pids = [readPid(r2, 'self.pid'), readPid(r2, 'child.pid')];
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.match(res.text, /Timed out after 2 s and was stopped|Timed out after 1 s and was stopped/);
    assert.match(res.text, /scene was not saved/);
    assert.ok(res.backup && existsSync(res.backup), 'the backup made before the run is named');
    for (const pid of pids) assert.equal(await isGone(pid), true, `process ${pid} is still running`);
  } finally { for (const pid of pids) await r2.port.realKill(pid).catch(() => false); }
});

test('C14: when the kill does not work, the runner says Blender may still be running and refuses new runs until it is gone', async () => {
  let alive = true;
  const r = rig({ mode: 'sleep' }, { deps: { stopWaitMs: 300, isAlive: () => alive } });
  r.port.noKill = true;
  let pids: number[] = [];
  try {
    const res = await r.runner.run(req(r, 'x=1\n', 't1', 1000));
    pids = [readPid(r, 'self.pid'), readPid(r, 'child.pid')];
    assert.equal(res.ok, false);
    assert.match(res.text, /may still be running/);
    const spawnsBefore = r.port.spawns.length;
    const again = await r.runner.run(req(r));
    assert.equal(again.ok, false);
    assert.match(again.text, /could not be stopped/);
    assert.equal(r.port.spawns.length, spawnsBefore, 'nothing new was started');
    alive = false;
    r.port.noKill = false;
    const next = await r.runner.run(req(r, 'x=1\n', 't1', 1000));
    assert.doesNotMatch(next.text, /could not be stopped/);
    assert.equal(r.port.spawns.length, spawnsBefore + 1, 'once the old process is gone a new run starts');
    pids.push(readPid(r, 'self.pid'), readPid(r, 'child.pid'));
  } finally { for (const pid of pids) await r.port.realKill(pid).catch(() => false); }
});

test('output cap: a process that prints without end is stopped and the run reports it', async () => {
  const r = rig({ mode: 'spam' }, { cfg: (c) => { c.advanced.local.maxOutputBytes = 64 * 1024; } });
  let pid = 0;
  try {
    const res = await r.runner.run(req(r, 'x=1\n', 't1', 20_000));
    pid = readPid(r, 'self.pid');
    assert.equal(res.ok, false);
    assert.match(res.text, /printed more than 64 KB and was stopped/);
    assert.equal(await isGone(pid), true);
  } finally { if (pid) await r.port.realKill(pid).catch(() => false); }
});

test('C15: only one Blender process runs at a time, whatever the tasks; each result is its own', async () => {
  const r = rig({ mode: 'slow', ms: 400 });
  const [a, b, c] = await Promise.all([r.runner.run(req(r, 'a=1\n', 'ta')), r.runner.run(req(r, 'b=1\n', 'tb')), r.runner.inspect({ agent: r.a, taskId: 'tc' })]);
  assert.equal(a.ok, true, a.text);
  assert.equal(b.ok, true, b.text);
  assert.ok(c);
  assert.equal(r.port.spawns.length, 3);
  assert.equal(r.port.maxInFlight, 1);
});

test('C7: scene.blend is copied into backups/ before each run, the newest 5 are kept, and the path is returned', async () => {
  const r = rig({ mode: 'ok' });
  const first = await r.runner.run(req(r));
  assert.equal(first.backup, undefined, 'nothing to back up before the first scene exists');
  const second = await r.runner.run(req(r));
  assert.ok(second.backup && existsSync(second.backup));
  assert.equal(readFileSync(second.backup!, 'utf8'), 'BLEND');
  assert.ok(second.backup!.startsWith(join(r.task('t1'), 'backups')));
  for (let i = 0; i < 8; i++) await r.runner.run(req(r));
  assert.equal(readdirSync(join(r.task('t1'), 'backups')).length, 5);
});

test('C7: when the backup cannot be made the script is NOT run and the text says backup_failed', async () => {
  const r = rig({ mode: 'ok' });
  await r.runner.run(req(r));
  const n = r.port.spawns.length;
  writeFileSync(join(r.task('t1'), 'backups'), 'a file where the folder should be');
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, false);
  assert.match(res.text, /backup_failed/);
  assert.equal(r.port.spawns.length, n, 'nothing was spawned');
  assert.deepEqual(readdirSync(r.task('t1')).filter((x) => /^script-/.test(x)), []);
});

test('C7: read-only calls (inspect, preview) make no backup', async () => {
  const r = rig({ mode: 'inspect' });
  await r.runner.run(req(r));
  await r.runner.inspect({ agent: r.a, taskId: 't1' });
  assert.equal(existsSync(join(r.task('t1'), 'backups')), false);
});

test('C6: a result for another run, or an ok result for another script, is discarded', async () => {
  const f = rig({ mode: 'foreign' });
  const a = await f.runner.run(req(f));
  assert.equal(a.ok, false);
  assert.match(a.text, /does not belong to this run/);
  assert.doesNotMatch(a.text, /FOREIGN/);
  const h = rig({ mode: 'badhash' });
  const b = await h.runner.run(req(h));
  assert.equal(b.ok, false);
  assert.match(b.text, /does not belong to this run/);
  assert.doesNotMatch(b.text, /WRONG-SCRIPT/);
  const n = rig({ mode: 'noresult' });
  const c = await n.runner.run(req(n));
  assert.equal(c.ok, false);
  assert.match(c.text, /did not produce a result \(exit 3\)/);
  assert.match(c.text, /boom: no result written/);
});

test('C6: a result file planted before the run (same name pattern, other id) is never read', async () => {
  const r = rig({ mode: 'noresult' });
  mkdirSync(r.task('t1'), { recursive: true });
  writeFileSync(join(r.task('t1'), 'result-0000000000000000.json'), JSON.stringify({ ok: true, output: 'PLANTED', run: '0000000000000000', hash: scriptHash('print(1)\n') }));
  const res = await r.runner.run(req(r));
  assert.doesNotMatch(res.text, /PLANTED/);
  assert.equal(res.ok, false);
});

test('C16: a link inside the task folder refuses the run before anything starts', async (t) => {
  const r = rig({ mode: 'ok' });
  mkdirSync(join(r.task('t1'), 'exports'), { recursive: true });
  const outside = tmp('legion-bl-out-');
  if (!linkOrSkip(t, outside, join(r.task('t1'), 'exports', 'planted'), 'dir')) return;
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, false);
  assert.match(res.text, /link|not usable/);
  assert.equal(r.port.spawns.length, 0);
});

test('C16: an exports folder that IS a link is refused; so is a Legion data folder that is a link', async (t) => {
  const r = rig({ mode: 'ok' });
  mkdirSync(r.task('t1'), { recursive: true });
  const outside = tmp('legion-bl-out-');
  if (!linkOrSkip(t, outside, join(r.task('t1'), 'exports'), 'dir')) return;
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, false);
  assert.equal(r.port.spawns.length, 0);
  const r2 = rig({ mode: 'ok' });
  mkdirSync(join(r2.data, 'blender'), { recursive: true });
  if (!linkOrSkip(t, tmp('legion-bl-out-'), join(r2.data, 'blender', 'local'), 'dir')) return;
  const res2 = await r2.runner.run(req(r2));
  assert.equal(res2.ok, false);
  assert.equal(r2.port.spawns.length, 0);
});

test('C16: a task folder over the size cap refuses the run', async () => {
  const r = rig({ mode: 'ok' }, { cfg: (c) => { c.advanced.local.maxTaskBytes = 1000; } });
  mkdirSync(r.task('t1'), { recursive: true });
  writeFileSync(join(r.task('t1'), 'big.bin'), Buffer.alloc(5000));
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, false);
  assert.match(res.text, /larger than/);
  assert.equal(r.port.spawns.length, 0);
});

test('C16: a task id cannot climb out of the local folder', async () => {
  const r = rig({ mode: 'ok' });
  const res = await r.runner.run(req(r, 'print(1)\n', '../../escape'));
  assert.equal(res.ok, true, res.text);
  assert.ok(existsSync(join(r.root, safeSegment('../../escape'), 'scene.blend')));
  assert.equal(existsSync(join(r.data, 'escape')), false);
  assert.equal(existsSync(join(r.base, 'escape')), false);
});

test('a task whose id is "home" or "runner" cannot touch the shared home folder or the runner file', async () => {
  const r = rig({ mode: 'ok' });
  await r.runner.run(req(r, 'print(1)\n', 'home'));
  await r.runner.run(req(r, 'print(1)\n', 'runner'));
  assert.equal(readFileSync(join(r.root, 'runner.py'), 'utf8'), LOCAL_RUNNER_PY);
  assert.ok(existsSync(join(r.root, safeSegment('home'))) && existsSync(join(r.root, 'home.d')), 'the task folders carry a hash suffix, so they are never the shared names');
});

test('paths with a space and a non-ASCII letter work (data folder, Blender folder)', async () => {
  const r = rig({ mode: 'ok', exports: { 'a.png': 'p' } }, { dataName: 'Dän Jørgensen data' });
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, true, res.text);
  assert.equal(res.files.length, 1);
  assert.ok(r.port.spawns[0]!.cwd.includes('Dän Jørgensen data'));
});

test('a task folder path over 200 characters is refused with a plain message', async () => {
  const r = rig({ mode: 'ok' }, { dataName: 'd'.repeat(190) });
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, false);
  assert.match(res.text, /characters long/);
  assert.equal(r.port.spawns.length, 0);
});

test('C10: exports go through the shared rules: .blend is quarantined, bad names and types are skipped, the exports folder is emptied', async () => {
  const exp: Record<string, string> = { 'ok.glb': 'g', 'scene2.blend': 'BLEND-with-code', 'evil.sh': 'rm', '.hidden.glb': 'x', 'noext': 'x' };
  const r = rig({ mode: 'ok', exports: exp });
  const res = await r.runner.run(req(r, 'print(1)\n', 'tq'));
  assert.equal(res.ok, true, res.text);
  assert.deepEqual(res.files.map((f) => f.name).sort(), ['ok.glb', 'scene2.blend']);
  const blend = res.files.find((f) => f.name === 'scene2.blend')!;
  assert.equal(blend.quarantined, true);
  assert.equal(blend.path, join(r.ws, 'blender-quarantine', safeSegment('tq'), 'scene2.blend.untrusted'));
  assert.equal(existsSync(join(r.ws, 'blender-exports', safeSegment('tq'), 'scene2.blend')), false);
  assert.equal(existsSync(join(r.ws, 'blender-exports', safeSegment('tq'), 'scene2.blend.untrusted')), false);
  assert.match(res.text, /QUARANTINED/);
  assert.equal(existsSync(join(r.ws, 'blender-exports', safeSegment('tq'), 'evil.sh')), false);
  // the same file is not copied again by the next run
  const again = await r.runner.run(req(r, 'print(2)\n', 'tq'));
  assert.equal(again.files.length, 2, 'the fake wrote them again, so they come back once each');
  assert.deepEqual(readdirSync(join(r.task('tq'), 'exports')), []);
});

test('C10: more than 20 files, or one over 15 MB, do not all come back', async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 30; i++) many[`f${String(i).padStart(2, '0')}.png`] = 'p';
  const r = rig({ mode: 'ok', exports: many });
  assert.equal((await r.runner.run(req(r))).files.length, 20);
  const big = rig({ mode: 'ok', exports: { 'small.png': 'p' }, bigFile: 'huge.glb' });
  const res = await big.runner.run(req(big));
  assert.deepEqual(res.files.map((f) => f.name), ['small.png']);
});

test('C10: a link the script planted inside exports/ during the run stops the copy and nothing outside is read', async (t) => {
  const outside = tmp('legion-bl-out-');
  writeFileSync(join(outside, 'secret.png'), 'SECRET');
  const r = rig({ mode: 'ok', exports: { 'a.png': 'p' }, linkTo: outside });
  const res = await r.runner.run(req(r));
  if (existsSync(join(r.task('t1'), 'nolink.txt'))) { t.skip('cannot create a link here (needs symlink privilege)'); return; }
  assert.deepEqual(res.files, []);
  assert.match(res.text, /symbolic link/);
  assert.equal(existsSync(join(r.ws, 'blender-exports', safeSegment('t1'), 'secret.png')), false);
  assert.equal(readFileSync(join(outside, 'secret.png'), 'utf8'), 'SECRET', 'the folder it pointed to was not emptied');
});

test('C10: a link planted in the workspace export folder stops the copy', async (t) => {
  const r = rig({ mode: 'ok', exports: { 'a.png': 'p' } });
  mkdirSync(join(r.ws, 'blender-exports'), { recursive: true });
  const outside = tmp('legion-bl-out-');
  if (!linkOrSkip(t, outside, join(r.ws, 'blender-exports', safeSegment('ts')), 'dir')) return;
  const res = await r.runner.run(req(r, 'print(1)\n', 'ts'));
  assert.equal(res.files.length, 0);
  assert.deepEqual(readdirSync(outside), []);
  assert.match(res.text, /not copied/);
});

test('inspect and preview: fixed Legion scripts run read-only; the object filter and the PNG come back', async () => {
  const r = rig({ mode: 'inspect' });
  const all = await r.runner.inspect({ agent: r.a, taskId: 'ti' });
  assert.equal(all.ok, true, all.text);
  assert.equal(JSON.parse(all.text).objects.length, 2);
  const one = await r.runner.inspect({ agent: r.a, taskId: 'ti', object: 'Cube' });
  assert.deepEqual(JSON.parse(one.text).objects.map((o: { name: string }) => o.name), ['Cube']);
  assert.ok(r.port.spawns.every((s) => s.args.includes('readonly')));
  const p = rig({ mode: 'preview' });
  const img = await p.runner.preview({ agent: p.a, taskId: 'tp', maxSize: 320 });
  assert.equal(img.ok, true, img.text);
  assert.equal(img.images.length, 1);
  assert.equal(img.images[0]!.mime, 'image/png');
  assert.equal(Buffer.from(img.images[0]!.data, 'base64').length, 4);
  assert.deepEqual(readdirSync(p.task('tp')).filter((n) => /\.png$/.test(n)), [], 'the preview file is removed');
});

test('Blender not startable: a plain failure, never a throw', async () => {
  const r = rig({ mode: 'ok' });
  r.port.file = join(r.base, 'does-not-exist.exe');
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, false);
  assert.match(res.text, /could not be started/);
});

test('dispose stops a running Blender', async () => {
  const r = rig({ mode: 'sleep' });
  const running = r.runner.run(req(r, 'x=1\n', 't1', 60_000));
  for (let i = 0; i < 300 && !existsSync(join(r.base, 'child.pid')); i++) await sleep(50);
  const pids = [readPid(r, 'self.pid'), readPid(r, 'child.pid')];
  try {
    await r.runner.dispose();
    const res = await running;
    assert.equal(res.ok, false);
    for (const pid of pids) assert.equal(await isGone(pid), true);
  } finally { for (const pid of pids) await r.port.realKill(pid).catch(() => false); }
});

test('the local files hold no link and the data folder tree is plain after a run', async () => {
  const r = rig({ mode: 'ok' });
  await r.runner.run(req(r));
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); const st = lstatSync(p); assert.equal(st.isSymbolicLink(), false, p); if (st.isDirectory()) walk(p); } };
  walk(r.root);
  rmSync(r.base, { recursive: true, force: true });
});

test('no shell: an argument with shell metacharacters reaches the program as one literal argument and nothing else runs', async () => {
  const dir = tmp('legion-bl-sh-');
  const marker = join(dir, 'pwned.txt');
  const tail = process.platform === 'win32' ? `a&echo x>${marker}` : `a;touch ${marker}`;
  const port = createProcessPort(() => undefined);
  const p = port.spawn({ file: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', tail], cwd: dir, env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) }, maxOutputBytes: 1 << 20 });
  const exit = await p.exited;
  assert.equal(exit.code, 0, p.stderr());
  assert.deepEqual(JSON.parse(p.stdout()), [tail]);
  assert.equal(existsSync(marker), false);
});

test('M1/C7: a scene that cannot be copied (scene.blend is a folder) stops the run: backup_failed and nothing spawned', async () => {
  const r = rig({ mode: 'ok' });
  await r.runner.run(req(r));
  const n = r.port.spawns.length;
  rmSync(join(r.task('t1'), 'scene.blend'), { force: true });
  mkdirSync(join(r.task('t1'), 'scene.blend'));
  const res = await r.runner.run(req(r));
  assert.equal(res.ok, false);
  assert.match(res.text, /backup_failed/);
  assert.equal(r.port.spawns.length, n, 'nothing was spawned');
});

test('M2: runner.py is checked before every run: a changed or linked copy is rewritten before the spawn', async (t) => {
  const r = rig({ mode: 'ok' });
  await r.runner.run(req(r));
  const file = join(r.root, 'runner.py');
  writeFileSync(file, LOCAL_RUNNER_PY + '\nimport os; os.system("x")\n');
  await r.runner.run(req(r));
  assert.equal(r.port.runnerSeen[1], LOCAL_RUNNER_PY, 'the tampered file was already repaired when Blender started');
  rmSync(file, { force: true });
  const other = join(r.base, 'other.py');
  writeFileSync(other, LOCAL_RUNNER_PY);
  if (!tryLink(other, file, 'file').ok) { t.diagnostic('file symlinks need privilege here; the replace-a-link step was skipped'); return; }
  await r.runner.run(req(r));
  assert.equal(lstatSync(file).isSymbolicLink(), false, 'a link in the runner place is replaced by the real file');
  assert.equal(r.port.runnerSeen[2], LOCAL_RUNNER_PY);
});

test('M3: tmp/ is emptied after each run, and a big scene cannot lock its own task out through backups', async () => {
  const r = rig({ mode: 'ok', tmpJunk: true, sceneText: 'S'.repeat(400) }, { cfg: (c) => { c.advanced.local.maxTaskBytes = 1500; } });
  for (let i = 0; i < 8; i++) {
    const res = await r.runner.run(req(r));
    assert.equal(res.ok, true, `run ${i}: ${res.text}`);
    assert.deepEqual(readdirSync(join(r.task('t1'), 'tmp')), [], 'tmp is empty after the run');
  }
  assert.ok(readdirSync(join(r.task('t1'), 'backups')).length <= 2, 'oldest backups were dropped to stay under the cap');
});

test('M3: the "too large" refusal names the folder and what to delete', async () => {
  const r = rig({ mode: 'ok' }, { cfg: (c) => { c.advanced.local.maxTaskBytes = 1000; } });
  mkdirSync(r.task('t1'), { recursive: true });
  writeFileSync(join(r.task('t1'), 'big.bin'), Buffer.alloc(5000));
  const res = await r.runner.run(req(r));
  assert.ok(res.text.includes(r.task('t1')), res.text);
  assert.match(res.text, /Delete its backups folder/);
});

test('L5: dispose() during a timeout kill still reaches the process (it stays tracked until it is gone)', async () => {
  const r = rig({ mode: 'sleep' }, { deps: { stopWaitMs: 3000 } });
  r.port.killDelayMs = 700;
  let pids: number[] = [];
  const running = r.runner.run(req(r, 'x=1\n', 't1', 1000));
  for (let i = 0; i < 100 && !existsSync(join(r.base, 'self.pid')); i++) await sleep(20);
  try {
    for (let i = 0; i < 100 && r.port.killCalls.length < 1; i++) await sleep(20); // the timeout kill has started and is slow
    await r.runner.dispose();
    assert.ok(r.port.killCalls.length >= 2, 'dispose issued its own kill for the tracked process');
    await running;
    pids = [readPid(r, 'self.pid'), readPid(r, 'child.pid')];
    for (const pid of pids) assert.equal(await isGone(pid), true);
  } finally { for (const pid of pids) await r.port.realKill(pid).catch(() => false); }
});

test('L6: an output-cap kill that did not work marks the PID stuck and refuses new runs', async () => {
  let alive = true;
  const r = rig({ mode: 'spam' }, { cfg: (c) => { c.advanced.local.maxOutputBytes = 64 * 1024; }, deps: { stopWaitMs: 300, isAlive: () => alive } });
  let pid = 0;
  try {
    const res = await r.runner.run(req(r, 'x=1\n', 't1', 20_000));
    pid = readPid(r, 'self.pid');
    assert.equal(res.ok, false);
    assert.match(res.text, /may still be running/);
    const n = r.port.spawns.length;
    const again = await r.runner.run(req(r));
    assert.match(again.text, /could not be stopped/);
    assert.equal(r.port.spawns.length, n, 'nothing new started while the old process is there');
    alive = false;
  } finally { if (pid) await r.port.realKill(pid).catch(() => false); }
});
