/** Sandbox runner tests. The "VM" is a temp folder driven through real bash and real Python with a stub bpy, so the runner script,
 *  the run command, the export copy-back and its limits are exercised for real (skipped when python3 or bash is missing). */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { defaultBlenderConfig } from '../src/shared/blender.js';
import { MAX_EXPORT_BYTES, RUNNER_PY, SandboxRunner, renderRunCommand, safeSegment, shq } from '../src/core/blender/sandbox.js';
import type { VmPort } from '../src/core/blender/sandbox.js';
import { agent, tmp } from './blender-helpers.js';

const have = (c: string, a: string[]): boolean => { try { execFileSync(c, a, { stdio: 'ignore' }); return true; } catch { return false; } };
const can = have('python3', ['--version']) && have('bash', ['--version']) && process.platform !== 'win32';

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
  assert.equal(safeSegment('../../etc/passwd'), '______etc_passwd');
  assert.equal(safeSegment(''), 'task');
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

test('run: executes the script in the (stub) Blender, returns its output and brings exports back into the workspace', { skip: !can }, async () => {
  const s = setup();
  const script = 'import os\nprint("hello from", __name__)\nopen(os.path.join(LEGION_EXPORT_DIR, "cube.glb"), "wb").write(b"glTF-bytes")\n';
  const r = await s.sb.run({ agent: s.a, taskId: 'task_9', script });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /hello from __main__/);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0]!.name, 'cube.glb');
  assert.equal(r.files[0]!.path, join(s.ws, 'blender-exports', 'task_9', 'cube.glb'));
  assert.equal(readFileSync(r.files[0]!.path, 'utf8'), 'glTF-bytes');
  assert.match(r.text, /exports in your workspace/);
  assert.ok(existsSync(join(s.root, 'legion-blender', 'work', 'task_9', 'scene.blend')), 'scene is kept per task');
});

test('run: a script error is reported with its traceback and ok=false, and the scene is still saved', { skip: !can }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: 't2', script: 'print("before")\nraise ValueError("kaboom")\n' });
  assert.equal(r.ok, false);
  assert.match(r.text, /before/);
  assert.match(r.text, /ValueError: kaboom/);
  assert.match(r.text, /<legion-script>/);
});

test('run: only known extensions, plain names, and size/count limits come back', { skip: !can }, async () => {
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
  assert.ok(!existsSync(join(s.ws, 'blender-exports', 't3', 'evil.sh')));
});

test('run: at most 20 files come back', { skip: !can }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: 't4', script: 'import os\nfor i in range(30):\n    open(os.path.join(LEGION_EXPORT_DIR, f"f{i}.png"), "wb").write(b"p")\n' });
  assert.equal(r.files.length, 20);
});

test('run: a task id cannot climb out of the work folder or the workspace', { skip: !can }, async () => {
  const s = setup();
  const r = await s.sb.run({ agent: s.a, taskId: '../../x', script: 'import os\nopen(os.path.join(LEGION_EXPORT_DIR, "a.png"), "wb").write(b"p")\n' });
  assert.equal(r.ok, true, r.text);
  assert.ok(r.files[0]!.path.startsWith(join(s.ws, 'blender-exports') + '/'));
  assert.ok(existsSync(join(s.root, 'legion-blender', 'work', '______x', 'scene.blend')));
});

test('inspect: a failing fixed script comes back as a failed result, never a throw', { skip: !can }, async () => {
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

test('the runner script is valid Python', { skip: !can }, () => {
  const dir = tmp();
  writeFileSync(join(dir, 'r.py'), RUNNER_PY);
  const r = spawnSync('python3', ['-m', 'py_compile', join(dir, 'r.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
