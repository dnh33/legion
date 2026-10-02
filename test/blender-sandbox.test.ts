/** Sandbox runner tests. The "VM" is a temp folder driven through real bash and real Python with a stub bpy, so the runner script,
 *  the run command, the export copy-back and its limits are exercised for real (skipped when python3 or bash is missing). */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { defaultBlenderConfig } from '../src/shared/blender.js';
import { MAX_EXPORT_BYTES, RUNNER_PY, SandboxRunner, renderRunCommand, safeSegment, shq } from '../src/core/blender/sandbox.js';
import type { VmPort } from '../src/core/blender/sandbox.js';
import { scriptHash } from '../src/core/blender/static-check.js';
import { agent, tmp } from './blender-helpers.js';
import { fileLinkOrSkip, linkOrSkip } from './fs-links.js';

const have = (c: string, a: string[]): boolean => { try { execFileSync(c, a, { stdio: 'ignore' }); return true; } catch { return false; } };
// The product runs this in a Linux VM (POSIX paths, pkill, a sh blender); the local stand-in is real bash and python3 over a temp folder, so it
// needs a POSIX host. On Windows these are skipped with this reason (the host-side copy-back guards they exercise are covered by blender-fs-safe,
// which runs on Windows with junctions and hard links).
const can = have('python3', ['--version']) && have('bash', ['--version']) && process.platform !== 'win32';
const why = process.platform === 'win32' ? 'the stand-in VM is a POSIX bash + python3 host (the real runner is a Linux VM); not run on Windows' : 'python3 or bash is not installed';

const STUB_BPY = `
import os
class _wm:
    @staticmethod
    def open_mainfile(filepath): print("open", filepath)
    @staticmethod
    def read_factory_settings(use_empty=False): pass
    @staticmethod
    def save_as_mainfile(filepath):
        open(filepath, "w").write("BLEND")
class ops:
    wm = _wm
class app:
    version_string = "5.1.0"
`;

class LocalVm implements VmPort {
  calls: string[] = [];
  started = 0;
  constructor(readonly root: string, readonly bin: string) {}
  status() { return { agentId: 'sculptor', sandboxId: 'sb', state: 'running' as const, size: 'default' as const, lastUsedAt: null, createdAt: null }; }
  async ensureRunning() { this.started++; return this.status(); }
  async exec(_id: string, command: string, opts?: { timeoutSeconds?: number }) {
    this.calls.push(command);
    const r = spawnSync('bash', ['-c', command], {
      cwd: this.root, encoding: 'utf8', timeout: (opts?.timeoutSeconds ?? 60) * 1000,
      env: { PATH: process.env.PATH ?? '', HOME: this.root, PYTHONPATH: join(this.root, 'stub') },
    });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  async readFile(_id: string, path: string, enc: 'utf8' | 'base64' = 'utf8') { return readFileSync(path).toString(enc); }
  async writeFile(_id: string, path: string, content: string, enc: 'utf8' | 'base64' = 'utf8') {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.from(content, enc));
  }
}

function setup() {
  const root = tmp('legion-bl-vm-');
  mkdirSync(join(root, 'stub'), { recursive: true });
  writeFileSync(join(root, 'stub', 'bpy.py'), STUB_BPY);
  // a fake `blender`: honours `--python <file> -- args`, like the real command line
  const bin = join(root, 'fakeblender');
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Blender 5.1.0"; exit 0; fi\nwhile [ "$1" != "--python" ]; do shift; done\nshift\nrunner="$1"; shift\nexec python3 "$runner" "$@"\n');
  chmodSync(bin, 0o755);
  const vm = new LocalVm(root, bin);
  const ws = tmp('legion-bl-ws-');
  const cfg = defaultBlenderConfig();
  cfg.advanced.vm.blenderBin = bin;
  const sb = new SandboxRunner({ vms: vm, config: () => cfg, boatConfigured: () => true, workspaceOf: () => ws });
  return { root, vm, ws, sb, cfg, a: agent() };
}

test('pure helpers: shell quoting, task folder names, run command template', () => {
  assert.equal(shq("a'b"), `'a'\\''b'`);
  assert.match(safeSegment('../../etc/passwd'), /^______etc_passwd-[0-9a-f]{8}$/);
  assert.match(safeSegment(''), /^task-[0-9a-f]{8}$/);
  assert.equal(renderRunCommand('{blender} -b --python {runner} -- {workdir}', { blender: '/b l/blender', runner: '/r.py', workdir: "/w'x" }), `'/b l/blender' -b --python '/r.py' -- '/w'\\''x'`);
});

test('readiness: needs a boat key and a VM that is switched on', () => {
  const s = setup();
  const noKey = new SandboxRunner({ vms: s.vm, config: () => s.cfg, boatConfigured: () => false, workspaceOf: () => s.ws });
  assert.equal(noKey.readiness(s.a).ready, false);
  assert.match(noKey.readiness(s.a).note, /boat\.dev/);
  assert.equal(s.sb.readiness(agent('sculptor', { vm: { enabled: false, size: 'default', idleStopMinutes: 15 } })).ready, false);
  assert.equal(s.sb.readiness(s.a).ready, true);
  assert.match(s.sb.readiness(s.a).note, /UNVERIFIED/);
});

test('run: executes the script in the (stub) Blender, returns its output and brings exports back into the workspace', { skip: !can && why }, async () => {
  const s = setup();
  const script = 'import os\nprint("hello from", __name__)\nopen(os.path.join(LEGION_EXPORT_DIR, "cube.glb"), "wb").write(b"glTF-bytes")\n';
  const r = await s.sb.run({ agent: s.a, taskId: 'task_9', script });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /hello from __main__/);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0]!.name, 'cube.glb');
  assert.equal(r.files[0]!.path, join(s.ws, 'blender-exports', safeSegment('task_9'), 'cube.glb'));
  assert.equal(readFileSync(r.files[0]!.path, 'utf8'), 'glTF-bytes');
  assert.match(r.text, /exports in your workspace/);
  assert.ok(existsSync(join(s.root, 'legion-blender', 'work', safeSegment('task_9'), 'scene.blend')), 'scene is kept per task');
});

test('run: a script error is reported with its traceback and ok=false, and the scene is still saved', { skip: !can && why }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: 't2', script: 'print("before")\nraise ValueError("kaboom")\n' });
  assert.equal(r.ok, false);
  assert.match(r.text, /before/);
  assert.match(r.text, /ValueError: kaboom/);
  assert.match(r.text, /<legion-script>/);
});

test('run: only known extensions, plain names, and size/count limits come back', { skip: !can && why }, async () => {
  const s = setup();
  const script = [
    'import os',
    'd = LEGION_EXPORT_DIR',
    'open(os.path.join(d, "ok.png"), "wb").write(b"png")',
    'open(os.path.join(d, "evil.sh"), "w").write("rm -rf /")',
    'open(os.path.join(d, "noext"), "w").write("x")',
    'open(os.path.join(d, "-rf.glb"), "w").write("x")',
    `open(os.path.join(d, "huge.glb"), "wb").write(b"0" * ${MAX_EXPORT_BYTES + 1})`,
    'open(os.path.join(d, ".hidden.glb"), "w").write("x")',
    '',
  ].join('\n');
  const r = await s.sb.run({ agent: s.a, taskId: 't3', script });
  assert.deepEqual(r.files.map((f) => f.name), ['ok.png']);
  assert.ok(!existsSync(join(s.ws, 'blender-exports', safeSegment('t3'), 'evil.sh')));
});

test('run: at most 20 files come back', { skip: !can && why }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: 't4', script: 'import os\nfor i in range(30):\n    open(os.path.join(LEGION_EXPORT_DIR, f"f{i}.png"), "wb").write(b"p")\n' });
  assert.equal(r.files.length, 20);
});

test('run: a task id cannot climb out of the work folder or the workspace', { skip: !can && why }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: '../../x', script: 'import os\nopen(os.path.join(LEGION_EXPORT_DIR, "a.png"), "wb").write(b"p")\n' });
  assert.equal(r.ok, true, r.text);
  assert.ok(r.files[0]!.path.startsWith(join(s.ws, 'blender-exports') + '/'));
  assert.ok(existsSync(join(s.root, 'legion-blender', 'work', safeSegment('../../x'), 'scene.blend')));
});

test('inspect: a failing fixed script comes back as a failed result, never a throw', { skip: !can && why }, async () => {
  const s = setup();
  const i = await s.sb.inspect({ agent: s.a, taskId: 't5' });
  // the stub has no bpy.data, so the fixed inspect script fails: the error must come back as a failed result, not a throw
  assert.equal(i.ok, false);
  assert.match(i.text, /Error|bpy/);
});

test('Blender missing in the VM: setup installs it from the configured https URL and reports the steps', async () => {
  const cmds: string[] = [];
  const cfg = defaultBlenderConfig();
  let installed = false;
  const vm: VmPort = {
    status: () => ({ agentId: 'sculptor', sandboxId: 's', state: 'running', size: 'default', lastUsedAt: null, createdAt: null }),
    ensureRunning: async () => vm.status('sculptor'),
    exec: async (_id, c) => {
      cmds.push(c);
      if (c.includes('printf %s "$HOME"')) return { exitCode: 0, stdout: '/home/user', stderr: '' };
      if (c.includes('curl')) { installed = true; return { exitCode: 0, stdout: 'Blender 5.1.0\n', stderr: '' }; }
      if (c.includes('command -v')) return installed ? { exitCode: 0, stdout: '/home/user/legion-blender/blender/blender\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    readFile: async () => '', writeFile: async () => undefined,
  };
  const sb = new SandboxRunner({ vms: vm, config: () => cfg, boatConfigured: () => true, workspaceOf: () => '/ws' });
  const steps = await sb.setup(agent());
  assert.ok(steps.every((s) => s.ok), JSON.stringify(steps));
  assert.ok(cmds.some((c) => c.includes(shq(cfg.advanced.vm.blenderUrl))));
  assert.match(cfg.advanced.vm.blenderUrl, /^https:\/\/download\.blender\.org\//);
});

test('Blender install failing in the VM gives an actionable message and no throw', async () => {
  const cfg = defaultBlenderConfig();
  const vm: VmPort = {
    status: () => ({ agentId: 'sculptor', sandboxId: 's', state: 'running', size: 'default', lastUsedAt: null, createdAt: null }),
    ensureRunning: async () => vm.status('sculptor'),
    exec: async (_id, c) => c.includes('printf %s "$HOME"') ? { exitCode: 0, stdout: '/home/u', stderr: '' } : c.includes('curl') ? { exitCode: 22, stdout: '', stderr: 'HTTP 404' } : { exitCode: 1, stdout: '', stderr: '' },
    readFile: async () => '', writeFile: async () => undefined,
  };
  const sb = new SandboxRunner({ vms: vm, config: () => cfg, boatConfigured: () => true, workspaceOf: () => '/ws' });
  const steps = await sb.setup(agent());
  assert.equal(steps.at(-1)!.ok, false);
  assert.match(steps.at(-1)!.detail, /libGL|blenderBin/);
  const run = await sb.run({ agent: agent(), taskId: 't', script: 'x=1' });
  assert.equal(run.ok, false);
  assert.match(run.text, /sandbox run failed/);
});

test('the runner script is valid Python', { skip: !can && why }, () => {
  const dir = tmp();
  writeFileSync(join(dir, 'r.py'), RUNNER_PY);
  const r = spawnSync('python3', ['-m', 'py_compile', join(dir, 'r.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// ---- review fixes S2, S3, S8

test('S2: a .blend export is quarantined (never in the live export folder), named .untrusted, and reported as quarantined', { skip: !can && why }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: 'tq', script: 'import os\nopen(os.path.join(LEGION_EXPORT_DIR, "scene2.blend"), "wb").write(b"BLEND-with-code")\nopen(os.path.join(LEGION_EXPORT_DIR, "a.png"), "wb").write(b"p")\n' });
  assert.equal(r.ok, true, r.text);
  const blend = r.files.find((f) => f.name === 'scene2.blend')!;
  assert.equal(blend.quarantined, true);
  assert.equal(blend.path, join(s.ws, 'blender-quarantine', safeSegment('tq'), 'scene2.blend.untrusted'));
  assert.equal(readFileSync(blend.path, 'utf8'), 'BLEND-with-code');
  assert.ok(!existsSync(join(s.ws, 'blender-exports', safeSegment('tq'), 'scene2.blend')), 'not in the export folder');
  assert.ok(!existsSync(join(s.ws, 'blender-exports', safeSegment('tq'), 'scene2.blend.untrusted')));
  assert.match(r.text, /QUARANTINED/);
  assert.match(r.text, /runnable code/);
  assert.ok(!r.text.split('\n').find((l) => l.startsWith('exports in your workspace'))?.includes('.blend'), 'the plain export line does not list the .blend');
  assert.equal(r.files.find((f) => f.name === 'a.png')!.quarantined, undefined);
});

test('S3: every run has its own script and result file, and nothing is left behind', { skip: !can && why }, async () => {
  const s = setup();
  await s.sb.run({ agent: s.a, taskId: 'tu', script: 'print("one")\n' });
  await s.sb.run({ agent: s.a, taskId: 'tu', script: 'print("two")\n' });
  const runCmds = s.vm.calls.filter((c) => /runner/.test(c) && /[0-9a-f]{64}/.test(c));
  assert.equal(runCmds.length, 2);
  const ids = runCmds.map((c) => /'([0-9a-f]{16})' '[0-9a-f]{64}'/.exec(c)?.[1]);
  assert.ok(ids[0] && ids[1] && ids[0] !== ids[1], `run ids differ: ${ids.join(' ')}`);
  const work = join(s.root, 'legion-blender', 'work', safeSegment('tu'));
  const left = readdirSync(work).filter((n) => /^(script|result)-/.test(n));
  assert.deepEqual(left, [], 'no script or result file stays behind');
  assert.ok(!existsSync(join(work, 'script.py')) && !existsSync(join(work, 'result.json')), 'the old shared file names are not used');
});

test('S3: two runs of the same task at once are queued and each result is its own run output', { skip: !can && why }, async () => {
  const s = setup();
  const [a, b] = await Promise.all([
    s.sb.run({ agent: s.a, taskId: 'tl', script: 'import time\ntime.sleep(0.3)\nprint("OUTPUT-A")\n' }),
    s.sb.run({ agent: s.a, taskId: 'tl', script: 'print("OUTPUT-B")\n' }),
  ]);
  assert.match(a.text, /OUTPUT-A/); assert.doesNotMatch(a.text, /OUTPUT-B/);
  assert.match(b.text, /OUTPUT-B/); assert.doesNotMatch(b.text, /OUTPUT-A/);
});

test('S3: the VM runner refuses a script whose bytes are not the approved ones, and says so', { skip: !can && why }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: 'th', script: 'print("SHOULD-NOT-RUN")\n', hash: scriptHash('print("something else")\n') });
  assert.equal(r.ok, false);
  assert.match(r.text, /does not match the approved script/);
  assert.doesNotMatch(r.text.replace(/\[legion\][^\n]*/, ''), /SHOULD-NOT-RUN/);
  // and an approved hash that matches runs normally
  const script = 'print("RAN-OK")\n';
  const ok = await s.sb.run({ agent: s.a, taskId: 'th', script, hash: scriptHash(script) });
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /RAN-OK/);
});

test('S3: a result file that belongs to another run (or another script) is discarded, never reported', { skip: !can && why }, async () => {
  const s = setup();
  const forge = (run: string, hash: string): VmPort => {
    const vm = s.vm;
    return Object.assign(Object.create(vm) as LocalVmLike, {
      async readFile(id: string, path: string, enc: 'utf8' | 'base64' = 'utf8') {
        if (/result-[0-9a-f]+\.json$/.test(path)) return JSON.stringify({ ok: true, output: 'FORGED-OUTPUT', run, hash });
        return vm.readFile(id, path, enc);
      },
    });
  };
  type LocalVmLike = VmPort;
  const script = 'print("x")\n';
  const other = new SandboxRunner({ vms: forge('0123456789abcdef', scriptHash(script)), config: () => s.cfg, boatConfigured: () => true, workspaceOf: () => s.ws });
  const r1 = await other.run({ agent: s.a, taskId: 'tf', script });
  assert.equal(r1.ok, false);
  assert.match(r1.text, /does not belong to this run/);
  assert.doesNotMatch(r1.text, /FORGED-OUTPUT/);
});

test('S8: a link planted in place of the host export folder is refused and nothing is written through it', { skip: !can && why }, async (tc) => {
  const s = setup();
  const outside = tmp('legion-outside-');
  mkdirSync(join(s.ws, 'blender-exports'), { recursive: true });
  if (!linkOrSkip(tc, outside, join(s.ws, 'blender-exports', safeSegment('ts')), 'dir')) return;
  const r = await s.sb.run({ agent: s.a, taskId: 'ts', script: 'import os\nopen(os.path.join(LEGION_EXPORT_DIR, "cube.glb"), "wb").write(b"data")\n' });
  assert.deepEqual(readdirSync(outside), [], 'nothing was written into the folder the link points to');
  assert.equal(r.files.length, 0);
  assert.match(r.text, /symbolic link|outside the workspace/);
});

test('S8: a link planted at the FINAL file name is replaced, not written through', { skip: !can && why }, async (tc) => {
  const s = setup();
  const outside = tmp('legion-outside-');
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'original');
  const dest = join(s.ws, 'blender-exports', safeSegment('tn'));
  mkdirSync(dest, { recursive: true });
  if (!fileLinkOrSkip(tc, victim, join(dest, 'cube.glb'))) return;
  const r = await s.sb.run({ agent: s.a, taskId: 'tn', script: 'import os\nopen(os.path.join(LEGION_EXPORT_DIR, "cube.glb"), "wb").write(b"new-bytes")\n' });
  // the folder now holds a link, so the whole copy-back is refused; either way the victim is untouched
  assert.equal(readFileSync(victim, 'utf8'), 'original');
  assert.ok(r.files.length === 0 || !lstatSync(join(dest, 'cube.glb')).isSymbolicLink());
});
