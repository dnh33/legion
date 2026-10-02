/** The local runner script (LOCAL_RUNNER_PY) run for real with python and a stub bpy: hash check, result file, write/network guard, log mode, UTF-8. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LOCAL_RUNNER_PY } from '../src/core/blender/local.js';
import { PYTHON_UTF8_ENV } from '../src/core/blender/backend.js';
import { scriptHash } from '../src/core/blender/static-check.js';
import { tmp } from './blender-helpers.js';
import { linkOrSkip } from './fs-links.js';

const python = ['python3', 'python'].find((c) => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
const skip = !python && 'python is not installed';

const STUB_BPY = `
import os
class _wm:
    @staticmethod
    def open_mainfile(filepath): pass
    @staticmethod
    def read_factory_settings(use_empty=False): pass
    @staticmethod
    def save_as_mainfile(filepath):
        open(filepath, "w").write("BLEND")
        open(os.environ["STUB_SAVES"], "a").write("save\\n")
class ops:
    wm = _wm
class app:
    version_string = "5.1.0"
    tempdir = os.environ["STUB_TEMP"]
`;

interface Rig { work: string; outside: string; stubTemp: string; saves: string; runner: string; stub: string }
function rig(): Rig {
  const base = tmp('legion-bl-lr-');
  const stub = join(base, 'stub');
  const work = join(base, 'task');
  const outside = join(base, 'outside');
  const stubTemp = join(base, 'bltemp');
  for (const d of [stub, work, outside, stubTemp, join(work, 'exports')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(stub, 'bpy.py'), STUB_BPY);
  const runner = join(base, 'runner.py');
  writeFileSync(runner, LOCAL_RUNNER_PY);
  return { work, outside, stubTemp, saves: join(base, 'saves.log'), runner, stub };
}

interface Out { status: number | null; stderr: string; result: { ok: boolean; output: string; run: string; hash: string; violations: string[] } | null }
function runScript(r: Rig, script: string, o: { hash?: string; flags?: string[]; env?: Record<string, string>; runId?: string; tamper?: string; bare?: boolean } = {}): Out {
  const runId = o.runId ?? 'abc123';
  writeFileSync(join(r.work, `script-${runId}.py`), o.tamper ?? script);
  const env = { ...process.env, PYTHONPATH: r.stub, STUB_TEMP: r.stubTemp, STUB_SAVES: r.saves, ...(o.bare ? {} : PYTHON_UTF8_ENV), ...o.env };
  const p = spawnSync(python!, [r.runner, '--', r.work, runId, o.hash ?? scriptHash(script), ...(o.flags ?? [])], { env, encoding: 'utf8', cwd: r.work, timeout: 60_000 });
  const rf = join(r.work, `result-${runId}.json`);
  return { status: p.status, stderr: p.stderr, result: existsSync(rf) ? JSON.parse(readFileSync(rf, 'utf8')) : null };
}
const saveCount = (r: Rig): number => (existsSync(r.saves) ? readFileSync(r.saves, 'utf8').split('\n').filter(Boolean).length : 0);
const py = (s: string): string => JSON.stringify(s);

test('the runner script is valid Python', { skip }, () => {
  const r = rig();
  const c = spawnSync(python!, ['-m', 'py_compile', r.runner], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
});

test('C5: a script file whose bytes are not the approved ones is refused and never executed', { skip }, () => {
  const r = rig();
  const marker = join(r.outside, 'ran.txt');
  const approved = 'print("approved")\n';
  const o = runScript(r, approved, { tamper: `open(${py(marker)}, "w").write("x")\nprint("TAMPERED")\n` });
  assert.ok(o.result, o.stderr);
  assert.equal(o.result!.ok, false);
  assert.match(o.result!.output, /does not match the approved script/);
  assert.doesNotMatch(o.result!.output, /TAMPERED/);
  assert.equal(existsSync(marker), false, 'the tampered script did not run');
  // and the approved script runs
  const good = runScript(r, approved, { runId: 'def456' });
  assert.equal(good.result!.ok, true, good.result!.output);
  assert.match(good.result!.output, /approved/);
});

test('C6: the result carries the run id and the script hash, runs as __main__ and defines LEGION_EXPORT_DIR', { skip }, () => {
  const r = rig();
  const script = 'print(__name__, LEGION_EXPORT_DIR)\n';
  const o = runScript(r, script, { runId: 'r1r1r1' });
  assert.equal(o.status, 0, o.stderr);
  assert.equal(o.result!.run, 'r1r1r1');
  assert.equal(o.result!.hash, scriptHash(script));
  assert.equal(o.result!.ok, true);
  assert.match(o.result!.output, /__main__ .*exports/);
  assert.equal(existsSync(join(r.work, 'scene.blend')), true);
});

test('a script error is reported with its traceback; the scene is still saved', { skip }, () => {
  const r = rig();
  const o = runScript(r, 'print("before")\nraise ValueError("kaboom")\n');
  assert.equal(o.result!.ok, false);
  assert.match(o.result!.output, /before/);
  assert.match(o.result!.output, /ValueError: kaboom/);
  assert.match(o.result!.output, /<legion-script>/);
  assert.ok(saveCount(r) >= 2, 'created and saved after the script');
});

test('readonly runs do not save the scene; normal runs do', { skip }, () => {
  const r = rig();
  runScript(r, 'x = 1\n', { runId: 'aaaaaa' });
  const afterNormal = saveCount(r); // creation + save
  assert.equal(afterNormal, 2);
  runScript(r, 'x = 2\n', { runId: 'bbbbbb', flags: ['readonly'] });
  assert.equal(saveCount(r), afterNormal, 'readonly did not save');
  runScript(r, 'x = 3\n', { runId: 'cccccc' });
  assert.equal(saveCount(r), afterNormal + 1);
});

test('C12: Python-level writes outside the task folder are refused, inside it (exports, Blender temp) they work', { skip }, () => {
  const r = rig();
  const victim = join(r.outside, 'victim.txt');
  writeFileSync(victim, 'original');
  const newFile = join(r.outside, 'new.txt');
  const copyTo = join(r.outside, 'copy.txt');
  const newDir = join(r.outside, 'newdir');
  const script = [
    'import os, shutil',
    'def attempt(name, fn):',
    '    try:',
    '        fn()',
    '        print("DONE", name)',
    '    except PermissionError as e:',
    '        print("REFUSED", name)',
    `attempt("write", lambda: open(${py(newFile)}, "w").write("x"))`,
    `attempt("overwrite", lambda: open(${py(victim)}, "w").write("changed"))`,
    `attempt("append", lambda: open(${py(victim)}, "a").write("changed"))`,
    `attempt("osopen", lambda: os.close(os.open(${py(newFile)}, os.O_WRONLY | os.O_CREAT)))`,
    `attempt("remove", lambda: os.remove(${py(victim)}))`,
    `attempt("rename", lambda: os.rename(${py(victim)}, ${py(newFile)}))`,
    `attempt("copy", lambda: shutil.copyfile(${py(victim)}, ${py(copyTo)}))`,
    `attempt("mkdir", lambda: os.mkdir(${py(newDir)}))`,
    `attempt("rmtree", lambda: shutil.rmtree(${py(r.outside)}))`,
    // allowed
    'open(os.path.join(LEGION_EXPORT_DIR, "ok.glb"), "wb").write(b"glb")',
    `open(os.path.join(${py(r.stubTemp)}, "t.bin"), "wb").write(b"t")`,
    'open("relative.txt", "w").write("rel")',
    'print("INSIDE-OK")',
    '',
  ].join('\n');
  const o = runScript(r, script);
  const out = o.result!.output;
  for (const n of ['write', 'overwrite', 'append', 'osopen', 'remove', 'rename', 'copy', 'mkdir', 'rmtree']) assert.match(out, new RegExp(`REFUSED ${n}\\b`), `${n}: ${out}`);
  assert.doesNotMatch(out, /DONE /);
  assert.match(out, /INSIDE-OK/);
  assert.equal(readFileSync(victim, 'utf8'), 'original');
  for (const f of [newFile, copyTo, newDir]) assert.equal(existsSync(f), false, f);
  assert.equal(readFileSync(join(r.work, 'exports', 'ok.glb'), 'utf8'), 'glb');
  assert.equal(existsSync(join(r.stubTemp, 't.bin')), true);
  assert.equal(readFileSync(join(r.work, 'relative.txt'), 'utf8'), 'rel');
});

test('C12: an uncaught refusal makes the run fail (ok false) and names the file', { skip }, () => {
  const r = rig();
  const target = join(r.outside, 'x.txt');
  const o = runScript(r, `open(${py(target)}, "w").write("x")\n`);
  assert.equal(o.result!.ok, false);
  assert.match(o.result!.output, /PermissionError: \[legion\] blocked: writing/);
  assert.equal(existsSync(target), false);
});

test('C12: a link inside the task folder that points outside does not let a write through', { skip }, (t) => {
  const r = rig();
  if (!linkOrSkip(t, r.outside, join(r.work, 'exports', 'out'), 'dir')) return;
  const o = runScript(r, `import os\ntry:\n    open(os.path.join(LEGION_EXPORT_DIR, "out", "leak.txt"), "w").write("x")\n    print("DONE")\nexcept PermissionError:\n    print("REFUSED")\n`);
  assert.match(o.result!.output, /REFUSED/);
  assert.equal(existsSync(join(r.outside, 'leak.txt')), false);
});

test('C12: extra write folders from the settings are allowed', { skip }, () => {
  const r = rig();
  const target = join(r.outside, 'allowed.txt');
  const o = runScript(r, `open(${py(target)}, "w").write("x")\nprint("OK")\n`, { flags: [`allow:${r.outside}`] });
  assert.equal(o.result!.ok, true, o.result!.output);
  assert.equal(existsSync(target), true);
});

test('C12: log mode records what would have been refused and lets it through', { skip }, () => {
  const r = rig();
  const target = join(r.outside, 'logged.txt');
  const o = runScript(r, `open(${py(target)}, "w").write("x")\nprint("WROTE")\n`, { flags: ['log'] });
  assert.equal(o.result!.ok, true, o.result!.output);
  assert.equal(existsSync(target), true, 'log mode does not block');
  assert.ok(o.result!.violations.some((v) => /would be blocked \(log only\)/.test(v) && v.includes('logged.txt')), JSON.stringify(o.result!.violations));
});

test('C13: network, programs and native libraries are refused while the script runs; a loopback listener sees nothing', { skip }, async () => {
  const r = rig();
  let connections = 0;
  const server = createServer((s) => { connections++; s.destroy(); });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as { port: number }).port;
  const marker = join(r.outside, 'spawned.txt');
  const touch = join(r.outside, 'touch.py');
  writeFileSync(touch, `open(${JSON.stringify(marker)}, 'w').write('x')\n`);
  const script = [
    'import socket, os, subprocess, ctypes, urllib.request',
    'def attempt(name, fn):',
    '    try:',
    '        fn()',
    '        print("DONE", name)',
    '    except PermissionError:',
    '        print("REFUSED", name)',
    `attempt("connect", lambda: socket.create_connection(("127.0.0.1", ${port}), 2))`,
    'attempt("dns", lambda: socket.getaddrinfo("example.invalid", 80))',
    'attempt("bind", lambda: socket.socket().bind(("127.0.0.1", 0)))',
    `attempt("url", lambda: urllib.request.urlopen("http://127.0.0.1:${port}/", timeout=2))`,
    `attempt("popen", lambda: subprocess.Popen([${py(python!)}, ${py(touch)}]))`,
    `attempt("system", lambda: os.system(${py(`"${python}" "${touch}"`)}))`,
    `attempt("dlopen", lambda: ctypes.CDLL(${process.platform === 'win32' ? "'kernel32'" : 'None'}))`,
    '',
  ].join('\n');
  const o = runScript(r, script);
  await new Promise((res) => setTimeout(res, 300));
  server.close();
  const out = o.result!.output;
  for (const n of ['connect', 'dns', 'bind', 'url', 'popen', 'system', 'dlopen']) assert.match(out, new RegExp(`REFUSED ${n}\\b`), `${n}: ${out}`);
  assert.doesNotMatch(out, /DONE /);
  assert.equal(connections, 0, 'the listener saw no connection');
  assert.equal(existsSync(marker), false, 'no program was started');
});

test('the guard is off again after the script: the runner itself can write the result and the scene', { skip }, () => {
  const r = rig();
  const o = runScript(r, 'x = 1\n');
  assert.ok(o.result);
  assert.equal(statSync(join(r.work, 'scene.blend')).isFile(), true);
});

test('UTF-8: a script and output with U+2028, an emoji and CJK work under a simulated cp1252 locale, with or without the UTF-8 variables', { skip }, () => {
  const text = 'café   😀 中';
  for (const bare of [false, true]) {
    const r = rig();
    const o = runScript(r, `print(${JSON.stringify(text)})\n`, { bare, env: { PYTHONIOENCODING: bare ? 'cp1252' : 'utf-8', PYTHONUTF8: bare ? '0' : '1' } });
    assert.ok(o.result, `bare=${bare}: ${o.stderr}`);
    assert.equal(o.result!.ok, true, o.result!.output);
    assert.ok(o.result!.output.includes(text), JSON.stringify(o.result!.output));
  }
});

test('POSIX: a file bigger than the export cap cannot be written by the script (RLIMIT_FSIZE, best effort)', { skip: process.platform === 'win32' ? 'RLIMIT_FSIZE is POSIX only' : skip }, () => {
  const r = rig();
  const o = runScript(r, 'import os\nopen(os.path.join(LEGION_EXPORT_DIR, "big.bin"), "wb").write(b"0" * (16 * 1024 * 1024))\n');
  assert.equal(o.result!.ok, false);
  assert.match(o.result!.output, /OSError|File too large/);
  // the scene (written by Blender after the script) is not limited
  assert.equal(existsSync(join(r.work, 'scene.blend')), true);
});
