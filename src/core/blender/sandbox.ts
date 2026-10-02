/**
 * Sandbox mode: the Sculptor's boat.dev VM runs Blender headless. The agent's script never touches this computer: Legion writes it into
 * the VM, runs `blender -b` there against a scene.blend kept per task, reads the output and brings back only exports (GLB, FBX, PNG ...)
 * as files in the task workspace.
 *
 * UNVERIFIED against a real boat.dev VM (no key was available when this was built). What is assumed, each of it checked by the list
 * at the end of docs/BLENDER.md: the VM image is Linux with bash, curl and tar; Blender 5.1+ for Linux x64 downloads and starts there
 * (needs its shared libraries; a headless Cycles CPU render is what the preview uses); boat's file API handles base64 for binary files;
 * the command timeout of 600 s is enough. The official `_for_cli` MCP tools are NOT used: their names are unverified, so this uses the
 * documented Blender command line (`blender -b --python`), whose run command is config (advanced.vm.runCommand).
 */
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { BlenderConfig, BlenderSetupStep } from '../../shared/blender.js';
import type { AgentProfile, VmRecord } from '../../shared/types.js';
import type { BackendResult } from './backend.js';
import { capText, fail, ok } from './backend.js';
import { findLink, isInside, resolveFolder, safeWriteFile } from './fs-safe.js';
import { scriptHash } from './static-check.js';

/** The part of VmManager the sandbox uses. */
export interface VmPort {
  status(agentId: string): VmRecord;
  ensureRunning(agentId: string): Promise<VmRecord>;
  exec(agentId: string, command: string, opts?: { cwd?: string; timeoutSeconds?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(agentId: string, path: string, encoding?: 'utf8' | 'base64'): Promise<string>;
  writeFile(agentId: string, path: string, content: string, encoding?: 'utf8' | 'base64'): Promise<void>;
}

export interface SandboxRunResult {
  ok: boolean;
  text: string;
  /** Exports that came back, as files in the task workspace. A .blend can carry runnable code, so it is set aside (`quarantined`) outside the live export folder. */
  files: Array<{ name: string; path: string; bytes: number; quarantined?: boolean }>;
}

/** What the guard needs from a sandbox (so tests can fake it). */
export interface SandboxPort {
  readiness(agent: AgentProfile): { ready: boolean; note: string };
  /** `hash` is the sha256 the user approved; the VM-side runner refuses to run a script whose bytes differ from it. */
  run(req: { agent: AgentProfile; taskId: string; script: string; hash?: string; timeoutMs?: number }): Promise<SandboxRunResult>;
  inspect(req: { agent: AgentProfile; taskId: string; object?: string }): Promise<BackendResult>;
  preview(req: { agent: AgentProfile; taskId: string; maxSize?: number }): Promise<BackendResult>;
  setup(agent: AgentProfile): Promise<BlenderSetupStep[]>;
}

export const SANDBOX_EXPORT_EXT = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'png', 'jpg', 'jpeg', 'exr', 'blend', 'usd', 'usdc', 'usda', 'usdz', 'abc', 'dae', 'svg', 'mp4', 'webp']);
/** Exports in these formats are set aside, never put in the live export folder: a .blend carries text blocks, drivers and handlers that run when it is opened. */
export const QUARANTINE_EXT = new Set(['blend']);
export const QUARANTINE_SUFFIX = '.untrusted';
export const MAX_EXPORT_BYTES = 15 * 1024 * 1024;
export const MAX_EXPORT_FILES = 20;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$/;

/** Single-quotes a string for bash. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The Python that runs one script in headless Blender. Written by Legion, never by an agent.
 * Arguments after `--`: <workdir> <run id> <sha256 of the approved script> [readonly]. Every run has its OWN script-<id>.py and result-<id>.json,
 * and the runner refuses a script whose bytes do not hash to the approved value, so a result can only belong to the script that was approved.
 */
export const RUNNER_PY = `# Legion runner: one agent script in headless Blender against scene.blend (UNVERIFIED on a real VM)
import sys, os, json, traceback, io, contextlib, hashlib
import bpy
args = sys.argv[sys.argv.index("--") + 1:]
work = args[0]
run_id = args[1]
want = args[2]
readonly = "readonly" in args[3:]
scene = os.path.join(work, "scene.blend")
export_dir = os.path.join(work, "exports")
script_path = os.path.join(work, "script-" + run_id + ".py")
result_path = os.path.join(work, "result-" + run_id + ".json")
def finish(ok, output, got=""):
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump({"ok": ok, "output": output[-20000:], "run": run_id, "hash": got}, f)
raw = open(script_path, "rb").read()
got = hashlib.sha256(raw).hexdigest()
if got != want:
    finish(False, "[legion] the script in the VM does not match the approved script (sha256 " + got[:12] + " instead of " + want[:12] + "); it was not run", got)
    sys.exit(0)
os.makedirs(export_dir, exist_ok=True)
if os.path.exists(scene):
    bpy.ops.wm.open_mainfile(filepath=scene)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.save_as_mainfile(filepath=scene)
src = raw.decode("utf-8")
out = io.StringIO()
ok = True
ns = {"__name__": "__main__", "LEGION_EXPORT_DIR": export_dir}
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        exec(compile(src, "<legion-script>", "exec"), ns)
except BaseException:
    ok = False
    out.write(traceback.format_exc())
if not readonly:
    try:
        bpy.ops.wm.save_as_mainfile(filepath=scene)
    except Exception:
        out.write("\\n[legion] could not save the scene: " + traceback.format_exc())
finish(ok, out.getvalue(), got)
`;

export const INSPECT_PY = `import bpy, json
def r(v): return [round(x, 4) for x in v]
objs = []
for o in bpy.data.objects:
    objs.append({"name": o.name, "type": o.type, "location": r(o.location), "dimensions": r(o.dimensions),
                 "collections": [c.name for c in o.users_collection], "modifiers": [m.type for m in getattr(o, "modifiers", [])],
                 "materials": [s.material.name for s in o.material_slots if s.material], "parent": o.parent.name if o.parent else None})
data = {"file": bpy.data.filepath, "blender": bpy.app.version_string, "unit_system": bpy.context.scene.unit_settings.system,
        "unit_scale": bpy.context.scene.unit_settings.scale_length, "collections": [c.name for c in bpy.data.collections],
        "objects": objs[:200], "object_count": len(bpy.data.objects), "materials": len(bpy.data.materials),
        "meshes": len(bpy.data.meshes), "vertices": sum(len(m.vertices) for m in bpy.data.meshes), "frame": [bpy.context.scene.frame_start, bpy.context.scene.frame_end]}
print(json.dumps(data, indent=1))
`;

export const previewPy = (size: number, fileName = 'preview.png'): string => `import bpy, os, math
from mathutils import Vector
scene = bpy.context.scene
meshes = [o for o in bpy.data.objects if o.type in {"MESH", "CURVE", "SURFACE", "FONT", "META"}]
if not meshes:
    raise SystemExit("nothing to render: the scene has no geometry yet")
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
center = (lo + hi) / 2
radius = max((hi - lo).length / 2, 0.1)
cam_data = bpy.data.cameras.new("legion_preview_cam")
cam = bpy.data.objects.new("legion_preview_cam", cam_data)
scene.collection.objects.link(cam)
cam.location = center + Vector((1, -1.2, 0.8)).normalized() * radius * 3.2
direction = center - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
sun_data = bpy.data.lights.new("legion_preview_sun", "SUN")
sun = bpy.data.objects.new("legion_preview_sun", sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.render.resolution_x = ${size}
scene.render.resolution_y = max(2, int(${size} * 9 / 16))
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(os.path.dirname(bpy.data.filepath), ${JSON.stringify(fileName)})
bpy.ops.render.render(write_still=True)
print("preview rendered")
`;

/** Replaces {blender} {runner} {workdir} (each shell-quoted) in the run command template. */
export function renderRunCommand(template: string, v: { blender: string; runner: string; workdir: string }): string {
  return template.replace(/\{blender\}/g, shq(v.blender)).replace(/\{runner\}/g, shq(v.runner)).replace(/\{workdir\}/g, shq(v.workdir));
}

/** Folder segment for a task id: letters, digits, dash, underscore only. */
export const safeSegment = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'task';

export interface SandboxDeps {
  vms: VmPort;
  config: () => BlenderConfig;
  boatConfigured: () => boolean;
  /** The agent's workspace folder; exports land in <it>/blender-exports/<task>/. */
  workspaceOf: (agent: AgentProfile) => string;
  /** Writes a binary file locally; tests pass a fake. The default writes without following links (temp file, rename). */
  writeLocal?: (path: string, data: Buffer) => void;
}

interface Layout { home: string; root: string; runner: string; work: string; bin?: string }

export class SandboxRunner implements SandboxPort {
  private readonly homes = new Map<string, string>();
  private readonly bins = new Map<string, string>();
  private readonly runnerVersion = new Map<string, boolean>();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly d: SandboxDeps) {}

  /** One run at a time per task: exec, inspect and preview share scene.blend, so they queue. */
  private withLock<T>(agent: AgentProfile, taskId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${agent.id}:${safeSegment(taskId)}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  readiness(agent: AgentProfile): { ready: boolean; note: string } {
    if (!this.d.boatConfigured()) return { ready: false, note: 'The sandbox needs a boat.dev API key (Settings, boat.dev).' };
    if (!agent.vm?.enabled) return { ready: false, note: `${agent.name}'s VM is switched off. Turn it on in the agent's settings to use the sandbox.` };
    return { ready: true, note: `Scripts run in ${agent.name}'s boat.dev VM (UNVERIFIED: not yet tried on a real VM).` };
  }

  private async sh(agent: AgentProfile, command: string, timeoutSeconds = 60): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.d.vms.exec(agent.id, command, { timeoutSeconds });
  }

  private async home(agent: AgentProfile): Promise<string> {
    const known = this.homes.get(agent.id);
    if (known) return known;
    await this.d.vms.ensureRunning(agent.id);
    const r = await this.sh(agent, 'printf %s "$HOME"');
    const home = r.stdout.trim();
    if (r.exitCode !== 0 || !home.startsWith('/')) throw new Error(`Could not find the VM's home folder (exit ${r.exitCode}): ${capText(r.stderr || r.stdout, 300)}`);
    this.homes.set(agent.id, home);
    return home;
  }

  /** Finds a working blender in the VM: the configured binary, or the copy Legion installed. */
  private async findBin(agent: AgentProfile, home: string): Promise<string | null> {
    const cached = this.bins.get(agent.id);
    if (cached) return cached;
    const cfg = this.d.config().advanced.vm;
    const installed = `${home}/legion-blender/blender/blender`;
    const r = await this.sh(agent, `for b in ${shq(cfg.blenderBin)} ${shq(installed)}; do if command -v "$b" >/dev/null 2>&1 && "$b" --version >/dev/null 2>&1; then command -v "$b"; exit 0; fi; done; exit 1`, 60);
    const bin = r.exitCode === 0 ? r.stdout.trim().split('\n')[0] ?? '' : '';
    if (!bin) return null;
    this.bins.set(agent.id, bin);
    return bin;
  }

  /** Installs headless Blender in the VM when it is not there. Steps are returned for the Setup panel. */
  async setup(agent: AgentProfile): Promise<BlenderSetupStep[]> {
    const steps: BlenderSetupStep[] = [];
    const rd = this.readiness(agent);
    if (!rd.ready) return [{ step: 'sandbox', ok: false, detail: rd.note }];
    try {
      const home = await this.home(agent);
      steps.push({ step: 'vm', ok: true, detail: `VM running, home ${home}` });
      const have = await this.findBin(agent, home);
      if (have) { steps.push({ step: 'blender-in-vm', ok: true, detail: `Blender found in the VM at ${have}` }); return steps; }
      const url = this.d.config().advanced.vm.blenderUrl;
      const dir = `${home}/legion-blender`;
      const cmd = `set -e; mkdir -p ${shq(dir)}/blender; cd ${shq(dir)}; ` +
        `curl -fsSL --retry 2 -o blender.tar.xz ${shq(url)}; tar -xf blender.tar.xz -C blender --strip-components=1; rm -f blender.tar.xz; ` +
        `./blender/blender -b --version | head -n 1`;
      const r = await this.sh(agent, cmd, 600);
      if (r.exitCode !== 0) {
        steps.push({ step: 'blender-in-vm', ok: false, detail: `Installing Blender in the VM failed (exit ${r.exitCode}): ${capText((r.stderr || r.stdout).trim(), 400)}. Headless Blender needs shared libraries (libGL, libXi, libXxf86vm, libXfixes, libXrender); install them with apt or point advanced.vm.blenderBin at a working Blender.` });
        return steps;
      }
      this.bins.delete(agent.id);
      steps.push({ step: 'blender-in-vm', ok: true, detail: `Installed in the VM: ${r.stdout.trim().split('\n').pop() ?? ''}` });
    } catch (e) { steps.push({ step: 'sandbox', ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    return steps;
  }

  private async layout(agent: AgentProfile, taskId: string): Promise<Layout> {
    const home = await this.home(agent);
    const root = `${home}/legion-blender`;
    return { home, root, runner: `${root}/runner.py`, work: `${root}/work/${safeSegment(taskId)}` };
  }

  /** A fresh id per run: its script and result files cannot be mixed up with any other run's. */
  private newRunId(): string { return randomBytes(8).toString('hex'); }

  private async prepare(agent: AgentProfile, taskId: string, script: string, runId: string): Promise<Layout & { bin: string; runId: string }> {
    const l = await this.layout(agent, taskId);
    let bin = await this.findBin(agent, l.home);
    if (!bin) {
      const steps = await this.setup(agent);
      if (!steps.every((s) => s.ok)) throw new Error(steps.find((s) => !s.ok)?.detail ?? 'Blender is not available in the VM');
      bin = await this.findBin(agent, l.home);
      if (!bin) throw new Error('Blender was installed in the VM but could not be started');
    }
    const mk = await this.sh(agent, `mkdir -p ${shq(l.work + '/exports')}`);
    if (mk.exitCode !== 0) throw new Error(`Could not prepare the VM work folder: ${capText(mk.stderr || mk.stdout, 300)}`);
    // the runner is rewritten once per Legion start, so an old copy in the VM never meets a newer argument list
    if (!this.runnerVersion.get(agent.id)) { await this.d.vms.writeFile(agent.id, l.runner, RUNNER_PY); this.runnerVersion.set(agent.id, true); }
    await this.d.vms.writeFile(agent.id, `${l.work}/script-${runId}.py`, script);
    return { ...l, bin, runId };
  }

  private async cleanup(agent: AgentProfile, l: Layout & { runId: string }, extra: string[] = []): Promise<void> {
    const files = [`${l.work}/script-${l.runId}.py`, `${l.work}/result-${l.runId}.json`, ...extra].map(shq).join(' ');
    await this.sh(agent, `rm -f ${files}`, 20).catch(() => undefined);
  }

  private async execute(agent: AgentProfile, l: Layout & { bin: string; runId: string }, hash: string, readonly: boolean, timeoutMs?: number): Promise<{ ok: boolean; output: string }> {
    const cfg = this.d.config().advanced.vm;
    const secs = Math.min(600, Math.max(10, Math.round((timeoutMs ?? cfg.timeoutSeconds * 1000) / 1000)));
    const cmd = `${renderRunCommand(cfg.runCommand, { blender: l.bin, runner: l.runner, workdir: l.work })} ${shq(l.runId)} ${shq(hash)}${readonly ? ' readonly' : ''}`;
    let r: { exitCode: number; stdout: string; stderr: string };
    try { r = await this.sh(agent, cmd, secs); } catch (e) {
      // a command that timed out or lost its connection may still be running: stop it by its run id (it is on its command line) before the next run starts
      await this.sh(agent, `pkill -f -- ${shq(l.runId)} || true`, 20).catch(() => undefined);
      throw e;
    }
    type Parsed = { ok?: boolean; output?: string; run?: string; hash?: string };
    let parsed: Parsed | null = null;
    try { parsed = JSON.parse(await this.d.vms.readFile(agent.id, `${l.work}/result-${l.runId}.json`)) as Parsed; } catch { parsed = null; }
    if (!parsed) {
      await this.sh(agent, `pkill -f -- ${shq(l.runId)} || true`, 20).catch(() => undefined);
      return { ok: false, output: `Blender in the VM did not produce a result (exit ${r.exitCode}).\n${capText((r.stderr || r.stdout).trim(), 1500)}` };
    }
    if (parsed.run !== l.runId || (parsed.ok === true && parsed.hash !== hash)) {
      return { ok: false, output: 'The result file in the VM does not belong to this run (run id or script hash differs); it was discarded.' };
    }
    return { ok: parsed.ok === true && r.exitCode === 0, output: String(parsed.output ?? '') };
  }

  async run(req: { agent: AgentProfile; taskId: string; script: string; hash?: string; timeoutMs?: number }): Promise<SandboxRunResult> {
    const { agent, taskId } = req;
    return this.withLock(agent, taskId, async () => {
      let l: (Layout & { bin: string; runId: string }) | undefined;
      try {
        const hash = req.hash ?? scriptHash(req.script);
        l = await this.prepare(agent, taskId, req.script, this.newRunId());
        const res = await this.execute(agent, l, hash, false, req.timeoutMs);
        const got = await this.fetchExports(agent, taskId, l);
        const plain = got.files.filter((f) => !f.quarantined);
        const q = got.files.filter((f) => f.quarantined);
        const note = plain.length ? `\nexports in your workspace: ${plain.map((f) => f.path).join(', ')}` : '';
        const qNote = q.length ? `\nQUARANTINED (a .blend can carry runnable code; it is NOT in the export folder and live Blender may not open it): ${q.map((f) => f.path).join(', ')}` : '';
        const problems = got.problems.length ? `\n${got.problems.join('\n')}` : '';
        return { ok: res.ok, text: capText(res.output.trim() || '(no output)') + note + qNote + problems, files: got.files };
      } catch (e) {
        return { ok: false, text: `The sandbox run failed: ${e instanceof Error ? e.message : String(e)}`, files: [] };
      } finally { if (l) await this.cleanup(agent, l); }
    });
  }

  /**
   * Copies new files from <work>/exports to the task workspace. Only known extensions, plain names, size and count limits. The host folder is
   * checked first (a link planted in the workspace is refused) and every file is written without following links. A .blend goes to
   * <workspace>/blender-quarantine/<task>/<name>.blend.untrusted, a folder the live path check never allows.
   */
  private async fetchExports(agent: AgentProfile, taskId: string, l: Layout): Promise<{ files: SandboxRunResult['files']; problems: string[] }> {
    const out: SandboxRunResult['files'] = [];
    const problems: string[] = [];
    const ls = await this.sh(agent, `cd ${shq(l.work + '/exports')} 2>/dev/null && find . -maxdepth 1 -type f -printf '%f\\t%s\\n'`);
    if (ls.exitCode !== 0) return { files: out, problems };
    const workspace = this.d.workspaceOf(agent);
    const seg = safeSegment(taskId);
    const dest = join(workspace, 'blender-exports', seg);
    const qdest = join(workspace, 'blender-quarantine', seg);
    const write = this.d.writeLocal ?? ((p: string, data: Buffer) => { safeWriteFile(dirname(p), basename(p), data); });
    // host folders must be real folders inside the workspace, with no links planted in them
    const okDest = (dir: string): boolean => {
      const r = resolveFolder(dir);
      const w = resolveFolder(workspace);
      if (!r.ok || !w.ok) { problems.push(`Exports were not copied: ${r.ok ? (w.ok ? '' : w.error) : r.error}`); return false; }
      if (!isInside(r.dir, w.dir)) { problems.push(`Exports were not copied: ${dir} resolves outside the workspace (${r.dir}).`); return false; }
      const link = findLink(r.dir);
      if (link) { problems.push(`Exports were not copied: ${link} is a symbolic link.`); return false; }
      return true;
    };
    const okDirs = new Map<string, boolean>();
    for (const line of ls.stdout.split('\n').filter(Boolean).slice(0, MAX_EXPORT_FILES)) {
      const [name = '', sizeText = '0'] = line.split('\t');
      const ext = (name.split('.').pop() ?? '').toLowerCase();
      if (!SAFE_NAME.test(name) || name !== basename(name) || !SANDBOX_EXPORT_EXT.has(ext)) continue;
      const bytes = Number(sizeText);
      if (!Number.isFinite(bytes) || bytes > MAX_EXPORT_BYTES) continue;
      const quarantine = QUARANTINE_EXT.has(ext);
      const dir = quarantine ? qdest : dest;
      if (!okDirs.has(dir)) okDirs.set(dir, okDest(dir));
      if (!okDirs.get(dir)) continue;
      try {
        const b64 = await this.d.vms.readFile(agent.id, `${l.work}/exports/${name}`, 'base64');
        const data = Buffer.from(b64, 'base64');
        if (data.length > MAX_EXPORT_BYTES) continue;
        const path = join(dir, quarantine ? name + QUARANTINE_SUFFIX : name);
        write(path, data);
        out.push({ name, path, bytes: data.length, ...(quarantine ? { quarantined: true } : {}) });
      } catch (e) { problems.push(`${name} could not be copied: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return { files: out, problems };
  }

  async inspect(req: { agent: AgentProfile; taskId: string; object?: string }): Promise<BackendResult> {
    return this.withLock(req.agent, req.taskId, async () => {
      let l: (Layout & { bin: string; runId: string }) | undefined;
      try {
        l = await this.prepare(req.agent, req.taskId, INSPECT_PY, this.newRunId());
        const res = await this.execute(req.agent, l, scriptHash(INSPECT_PY), true);
        return res.ok ? ok(capText(filterObject(res.output, req.object))) : fail(capText(res.output));
      } catch (e) { return fail(`The sandbox inspect failed: ${e instanceof Error ? e.message : String(e)}`); } finally { if (l) await this.cleanup(req.agent, l); }
    });
  }

  async preview(req: { agent: AgentProfile; taskId: string; maxSize?: number }): Promise<BackendResult> {
    return this.withLock(req.agent, req.taskId, async () => {
      let l: (Layout & { bin: string; runId: string }) | undefined;
      let png = '';
      try {
        const size = Math.min(1280, Math.max(160, Math.round(req.maxSize ?? 480)));
        const runId = this.newRunId();
        const py = previewPy(size, `preview-${runId}.png`);
        l = await this.prepare(req.agent, req.taskId, py, runId);
        png = `${l.work}/preview-${runId}.png`;
        const res = await this.execute(req.agent, l, scriptHash(py), true);
        if (!res.ok) return fail(capText(res.output));
        const b64 = await this.d.vms.readFile(req.agent.id, png, 'base64');
        if (!b64) return fail('The sandbox rendered no preview');
        return ok('sandbox preview (Cycles, CPU, 8 samples, auto camera)', [{ mime: 'image/png', data: b64 }]);
      } catch (e) { return fail(`The sandbox preview failed: ${e instanceof Error ? e.message : String(e)}`); } finally { if (l) await this.cleanup(req.agent, l, png ? [png] : []); }
    });
  }
}

/** For blender_inspect with an object name in the sandbox: keep the summary and the one object. */
function filterObject(output: string, object: string | undefined): string {
  if (!object) return output;
  try {
    const d = JSON.parse(output) as { objects?: Array<{ name: string }> } & Record<string, unknown>;
    const one = (d.objects ?? []).filter((o) => o.name === object);
    return JSON.stringify({ ...d, objects: one }, null, 1);
  } catch { return output; }
}
