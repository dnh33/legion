/**
 * Local headless mode: `blender -b` on THIS computer, wrapped by Legion's own runner script (plan: claude/plan-blender-local-first.md 2.4-2.8).
 *
 * What this is: the card, the backup, the audit and the controls below. What it is not: a sandbox. The script runs with the Windows user's rights.
 * The Python-level guard in LOCAL_RUNNER_PY only sees Python events (open, os.remove, socket.connect ...); Blender's C code (save_as_mainfile,
 * image saves, many operators) writes without them. Legion's own check of the script text stays a filter.
 *
 * This file starts no process itself: it takes a ProcessPort (system.ts holds the real spawn and the tree kill), so tests run a fake blender.
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BlenderConfig } from '../../shared/blender.js';
import { LOCAL_MIN_VERSION } from '../../shared/blender.js';
import type { AgentProfile } from '../../shared/types.js';
import type { BackendResult } from './backend.js';
import { PYTHON_UTF8_ENV, capText, fail, ok } from './backend.js';
import { versionAtLeast } from './detect.js';
import { MAX_EXPORT_BYTES, collectExports, safeSegment } from './exports.js';
import { findLink, isInside, resolveFolder, safeWriteFile } from './fs-safe.js';
import type { LocalPort, LocalRunResult, ProcessPort } from './ports.js';
import { INSPECT_PY, previewPy } from './sandbox.js';
import { scriptHash } from './static-check.js';

export { LOCAL_MIN_VERSION };
const MAX_PATH_CHARS = 200;
const KEEP_BACKUPS = 5;
const STOP_WAIT_MS = 5000;
const MAX_RESULT_BYTES = 1024 * 1024;

/**
 * The Python that runs one script in headless Blender on this computer. Written by Legion, never by an agent.
 * Arguments after `--`: <taskdir> <run id> <sha256 of the approved script> [readonly] [log] [allow:<dir> ...].
 *  - C5: the script file's bytes must hash to the approved value, else nothing runs.
 *  - C12/C13: while the agent script runs, an audit hook refuses Python-level writes outside the task folder (and Blender's temp folder and
 *    the extra folders), network calls, and starting programs or loading native libraries. `log` records instead of refusing.
 *  - C6: the result file carries the run id and the hash of the script that ran.
 * Limits: audit hooks see Python events only; a script that reaches this function's variables or native code is what Legion's check forbids.
 */
export const LOCAL_RUNNER_PY = `# Legion local runner: one agent script in headless Blender against scene.blend
import sys, os, json, traceback, io, contextlib, hashlib

FSIZE_CAP = ${MAX_EXPORT_BYTES}

def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    work = os.path.realpath(args[0])
    run_id = args[1]
    want = args[2].lower()
    flags = args[3:]
    readonly = "readonly" in flags
    log_only = "log" in flags
    extra = [f[6:] for f in flags if f.startswith("allow:")]
    scene = os.path.join(work, "scene.blend")
    export_dir = os.path.join(work, "exports")
    script_path = os.path.join(work, "script-" + run_id + ".py")
    result_path = os.path.join(work, "result-" + run_id + ".json")
    violations = []

    def finish(ok, output, got=""):
        tmp = result_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"ok": ok, "output": output[-20000:], "run": run_id, "hash": got, "violations": violations[:50]}, f, ensure_ascii=True)
        os.replace(tmp, result_path)

    try:
        import bpy
        raw = open(script_path, "rb").read()
        got = hashlib.sha256(raw).hexdigest()
        if got != want:
            finish(False, "[legion] the script file does not match the approved script (sha256 " + got[:12] + " instead of " + want[:12] + "); it was not run", got)
            return
        os.makedirs(export_dir, exist_ok=True)
        if os.path.exists(scene):
            bpy.ops.wm.open_mainfile(filepath=scene)
        else:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.wm.save_as_mainfile(filepath=scene)

        state = {"armed": False}
        roots = []
        def add_root(p):
            if not p:
                return
            r = os.path.normcase(os.path.realpath(p))
            roots.append(r if r.endswith(os.sep) else r + os.sep)
        add_root(work)
        add_root(getattr(bpy.app, "tempdir", ""))
        for e in extra:
            add_root(e)
        def inside(p):
            try:
                s = os.fsdecode(p)
                if s.lower() in ("nul", os.devnull.lower()):
                    return True
                n = os.path.normcase(os.path.realpath(s)) + os.sep
            except Exception:
                return False
            return any(n.startswith(r) for r in roots)
        def deny(what):
            msg = "[legion] blocked: " + what
            if log_only:
                if len(violations) < 50:
                    violations.append(msg.replace("blocked", "would be blocked (log only)"))
                return
            raise PermissionError(msg)
        NET = {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex", "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg", "urllib.Request", "http.client.connect", "http.client.send"}
        EXEC = {"subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.startfile", "os.fork", "os.forkpty", "ctypes.dlopen"}
        WRITE = {"os.remove": (0,), "os.rmdir": (0,), "os.mkdir": (0,), "os.rename": (0, 1), "os.symlink": (1,), "os.link": (0, 1), "os.truncate": (0,), "os.chmod": (0,), "os.chown": (0,),
                 "shutil.copyfile": (1,), "shutil.copymode": (1,), "shutil.copystat": (1,), "shutil.copytree": (1,), "shutil.move": (0, 1), "shutil.rmtree": (0,),
                 "shutil.unpack_archive": (2,), "shutil.make_archive": (0,)}
        def hook(event, a):
            if not state["armed"]:
                return
            if event == "open":
                path, mode, flags_ = a[0], a[1], a[2]
                if path is None or isinstance(path, int):
                    return
                writes = False
                if isinstance(mode, str) and any(c in mode for c in "wax+"):
                    writes = True
                if isinstance(flags_, int) and flags_ & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC):
                    writes = True
                if writes and not inside(path):
                    deny("writing " + os.fsdecode(path) + " (outside the task folder)")
                return
            if event in NET:
                deny("network access (" + event + ")")
                return
            if event in EXEC:
                deny("starting a program or loading a native library (" + event + ")")
                return
            idx = WRITE.get(event)
            if idx is not None:
                for i in idx:
                    if i < len(a) and a[i] is not None and not isinstance(a[i], int) and not inside(a[i]):
                        deny(event + " on " + os.fsdecode(a[i]) + " (outside the task folder)")
        try:
            import ctypes  # imported before arming: a library that imports it later (numpy does) must not be refused; loading a library still is
        except Exception:
            pass
        sys.addaudithook(hook)

        src = raw.decode("utf-8-sig")
        out = io.StringIO()
        ok = True
        ns = {"__name__": "__main__", "LEGION_EXPORT_DIR": os.path.realpath(export_dir)}
        saved = None
        try:
            import resource, signal
            if hasattr(signal, "SIGXFSZ"):
                signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
            cap = FSIZE_CAP if hard == resource.RLIM_INFINITY or hard > FSIZE_CAP else hard
            resource.setrlimit(resource.RLIMIT_FSIZE, (cap, hard))
            saved = (soft, hard)
        except Exception:
            saved = None
        state["armed"] = True
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                exec(compile(src, "<legion-script>", "exec"), ns)
        except BaseException:
            ok = False
            out.write(traceback.format_exc())
        finally:
            state["armed"] = False
        if saved is not None:
            try:
                resource.setrlimit(resource.RLIMIT_FSIZE, saved)
            except Exception:
                pass
        if not readonly:
            try:
                bpy.ops.wm.save_as_mainfile(filepath=scene)
            except Exception:
                out.write("\\n[legion] could not save the scene: " + traceback.format_exc())
        finish(ok, out.getvalue(), got)
    except BaseException:
        try:
            finish(False, "[legion] runner error: " + traceback.format_exc())
        except BaseException:
            pass

main()
`;

const dirSize = (dir: string, limit: number): number => {
  let total = 0;
  let seen = 0;
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (total > limit || ++seen > 20000) return;
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p); else total += st.size;
    }
  };
  walk(dir);
  return total;
};

export interface LocalEnvInput {
  platform: NodeJS.Platform;
  /** The parent's environment; only the named system variables are READ from it, the child never receives a copy. */
  host: NodeJS.ProcessEnv;
  blenderDir: string;
  taskDir: string;
  homeDir: string;
}

const pick = (host: NodeJS.ProcessEnv, name: string): string | undefined => {
  const k = Object.keys(host).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : host[k];
};

/** C11: the child's complete environment, built from an allowlist (never a copy of process.env). */
export function buildEnv(i: LocalEnvInput): Record<string, string> {
  const e: Record<string, string> = { ...PYTHON_UTF8_ENV };
  const tmp = join(i.taskDir, 'tmp');
  const blender = join(i.homeDir, 'blender');
  if (i.platform === 'win32') {
    for (const n of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT']) { const v = pick(i.host, n); if (v) e[n] = v; }
    const sysRoot = pick(i.host, 'SystemRoot') ?? 'C:\\Windows';
    e.Path = `${i.blenderDir};${sysRoot}\\System32`;
    e.USERPROFILE = i.homeDir;
  } else {
    e.PATH = `${i.blenderDir}:/usr/bin:/bin`;
    e.LANG = 'C.UTF-8';
    e.TMPDIR = tmp;
  }
  e.HOME = i.homeDir;
  e.TEMP = tmp;
  e.TMP = tmp;
  e.BLENDER_USER_CONFIG = join(blender, 'config');
  e.BLENDER_USER_SCRIPTS = join(blender, 'scripts');
  e.BLENDER_USER_DATAFILES = join(blender, 'datafiles');
  e.BLENDER_USER_EXTENSIONS = join(blender, 'extensions');
  return e;
}

/** C5/C11/C13: the argument list. The fixed hardening flags are added here, never from config. */
export function buildArgs(i: { runner: string; taskDir: string; runId: string; hash: string; readonly: boolean; guard: 'block' | 'log'; extraWriteDirs: string[]; userArgs: string[] }): string[] {
  return [
    '-b', '--factory-startup', '--offline-mode', '--disable-autoexec', '--python-exit-code', '3',
    ...i.userArgs,
    '--python', i.runner,
    '--', i.taskDir, i.runId, i.hash,
    ...(i.readonly ? ['readonly'] : []),
    ...(i.guard === 'log' ? ['log'] : []),
    ...i.extraWriteDirs.map((d) => `allow:${d}`),
  ];
}

export interface LocalDeps {
  proc: ProcessPort;
  config: () => BlenderConfig;
  /** The Blender found on this computer (detect.ts), or undefined. */
  install: () => { path: string; version: string } | undefined;
  /** Legion's data folder; everything local lives under <dataDir>/blender/local. */
  dataDir: string;
  /** The agent's workspace folder; exports land in <it>/blender-exports/<task>/. */
  workspaceOf: (agent: AgentProfile) => string;
  /** Test seams. */
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isAlive?: (pid: number) => boolean;
  stopWaitMs?: number;
  writeLocal?: (path: string, data: Buffer) => void;
}

interface Prepared { task: string; exportsDir: string; home: string; blender: string }

export class LocalRunner implements LocalPort {
  private chain: Promise<unknown> = Promise.resolve();
  /** The child in flight. Kept until its exit is confirmed (also through a timeout or output-cap kill), so dispose() can still stop it. */
  private current: { pid: number; exited: Promise<unknown> } | undefined;
  private disposed = false;
  private stuck: number | undefined;
  constructor(private readonly d: LocalDeps) {}

  private get root(): string { const b = this.d.config().baseDir; return b ? join(b, 'local') : join(this.d.dataDir, 'blender', 'local'); }
  private alive(pid: number): boolean {
    if (this.d.isAlive) return this.d.isAlive(pid);
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  }

  /** C15: one local Blender at a time, whatever the task. */
  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  readiness(_agent: AgentProfile): { ready: boolean; note: string } {
    const inst = this.d.install();
    if (!inst) return { ready: false, note: 'Blender was not found on this computer. Install it or set its location in Settings.' };
    if (!versionAtLeast(inst.version, LOCAL_MIN_VERSION)) return { ready: false, note: `Blender ${inst.version} is too old for local runs (need ${LOCAL_MIN_VERSION} or newer).` };
    return { ready: true, note: `Scripts run in Blender ${inst.version} in the background on this computer (not yet tried with a real Blender on Windows).` };
  }

  /** Core exit: refuse new runs, kill the running child's tree by PID and wait (bounded) for it to exit. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.stuck !== undefined) await this.d.proc.kill(this.stuck).catch(() => false);
    const c = this.current;
    if (!c) return;
    await this.d.proc.kill(c.pid).catch(() => false);
    await Promise.race([c.exited.catch(() => undefined), new Promise((r) => { const t = setTimeout(r, this.d.stopWaitMs ?? STOP_WAIT_MS); t.unref?.(); })]);
  }

  /** C16: the task folder, resolved to real paths, no links anywhere in it, under the size cap. */
  private prepare(taskId: string): { ok: true; p: Prepared } | { ok: false; error: string } {
    const cfg = this.d.config().advanced.local;
    try {
      mkdirSync(this.root, { recursive: true });
      const rr = resolveFolder(this.root);
      if (!rr.ok) return { ok: false, error: `The local Blender folder is not usable: ${rr.error}` };
      const task = join(rr.dir, safeSegment(taskId));
      if (task.length > MAX_PATH_CHARS) return { ok: false, error: `The task folder path is ${task.length} characters long (limit ${MAX_PATH_CHARS}); move Legion's data folder to a shorter path.` };
      const home = join(rr.dir, 'home.d');
      const blender = join(home, 'blender');
      for (const dir of [join(task, 'exports'), join(task, 'tmp'), ...['config', 'scripts', 'datafiles', 'extensions'].map((n) => join(blender, n))]) {
        mkdirSync(dir, { recursive: true });
        const r = resolveFolder(dir);
        if (!r.ok) return { ok: false, error: `The local task folder is not usable: ${r.error}` };
        if (!isInside(r.dir, rr.dir)) return { ok: false, error: `The local task folder resolves outside Legion's data folder (${r.dir}).` };
      }
      const link = findLink(task);
      if (link) return { ok: false, error: `The local task folder holds a link (${link}); remove it first. Nothing was run.` };
      if (dirSize(task, cfg.maxTaskBytes) > cfg.maxTaskBytes) return { ok: false, error: `The task folder ${task} is larger than ${Math.round(cfg.maxTaskBytes / 1e6)} MB (scene, backups and files). Delete its backups folder or the files you no longer need, then try again. Nothing was run.` };
      return { ok: true, p: { task, exportsDir: join(task, 'exports'), home, blender } };
    } catch (e) { return { ok: false, error: `The local task folder could not be prepared: ${e instanceof Error ? e.message : String(e)}` }; }
  }

  /** C7: copy scene.blend into backups/ (newest 5 kept). Throws when it cannot, and the run is then refused. */
  private backup(task: string, runId: string, maxTaskBytes: number): string | undefined {
    const scene = join(task, 'scene.blend');
    if (!existsSync(scene)) return undefined;
    const dir = join(task, 'backups');
    mkdirSync(dir, { recursive: true });
    const r = resolveFolder(dir);
    if (!r.ok) throw new Error(r.error);
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const dest = join(r.dir, `scene-${stamp}-${runId.slice(0, 6)}.blend`);
    copyFileSync(scene, dest);
    try {
      const names = readdirSync(r.dir).filter((n) => /^scene-.*\.blend$/.test(n)).sort().reverse();
      for (const n of names.slice(KEEP_BACKUPS)) rmSync(join(r.dir, n), { force: true });
      // the size cap counts backups too: drop the oldest (never the newest) until the folder is back under it, so a big scene cannot lock its own task out
      const kept = names.slice(0, KEEP_BACKUPS);
      while (kept.length > 1 && dirSize(task, maxTaskBytes) > maxTaskBytes) rmSync(join(r.dir, kept.pop()!), { force: true });
    } catch { /* pruning is best effort */ }
    return dest;
  }

  /** M2: the runner is checked before EVERY spawn (a plain file whose sha256 is the constant's) and rewritten when it differs or is a link. */
  private runnerFile(): string {
    const p = join(this.root, 'runner.py');
    const want = createHash('sha256').update(LOCAL_RUNNER_PY, 'utf8').digest('hex');
    let have = '';
    try { const st = lstatSync(p); if (st.isFile() && !st.isSymbolicLink()) have = createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { have = ''; }
    if (have !== want) safeWriteFile(this.root, 'runner.py', Buffer.from(LOCAL_RUNNER_PY, 'utf8'));
    return p;
  }

  /** Waits (bounded) until the PID is gone; true when it is. */
  private async gone(pid: number | undefined): Promise<boolean> {
    if (pid === undefined) return true;
    const end = Date.now() + (this.d.stopWaitMs ?? STOP_WAIT_MS);
    while (this.alive(pid)) { if (Date.now() >= end) return false; await new Promise((r) => setTimeout(r, 50)); }
    return true;
  }

  private async execute(req: { agent: AgentProfile; taskId: string; script: string; hash: string; timeoutMs?: number }, o: { readonly: boolean; withBackup: boolean }): Promise<
    { kind: 'refused'; text: string } | { kind: 'ran'; p: Prepared; runId: string; ok: boolean; output: string; timedOut: boolean; backup?: string; violations: string[] }
  > {
    if (this.disposed) return { kind: 'refused', text: 'Legion is shutting down; no new local run starts.' };
    const rd = this.readiness(req.agent);
    if (!rd.ready) return { kind: 'refused', text: rd.note };
    const inst = this.d.install()!;
    if (this.stuck !== undefined) {
      if (this.alive(this.stuck)) return { kind: 'refused', text: `A previous Blender run (process ${this.stuck}) could not be stopped and may still be running; no new local run starts until it is gone.` };
      this.stuck = undefined;
    }
    const cfg = this.d.config().advanced.local;
    const prep = this.prepare(req.taskId);
    if (!prep.ok) return { kind: 'refused', text: prep.error };
    const p = prep.p;
    const runId = randomBytes(8).toString('hex');
    let backup: string | undefined;
    if (o.withBackup) {
      try { backup = this.backup(p.task, runId, cfg.maxTaskBytes); } catch (e) {
        return { kind: 'refused', text: `backup_failed: the scene could not be backed up (${e instanceof Error ? e.message : String(e)}), so the script was not run.` };
      }
    }
    const scriptFile = join(p.task, `script-${runId}.py`);
    const resultFile = join(p.task, `result-${runId}.json`);
    const timeoutMs = Math.min(900_000, Math.max(1000, req.timeoutMs ?? cfg.timeoutSeconds * 1000));
    try {
      const runner = this.runnerFile();
      writeFileSync(scriptFile, Buffer.from(req.script, 'utf8'));
      const args = buildArgs({ runner, taskDir: p.task, runId, hash: req.hash, readonly: o.readonly, guard: cfg.guard, extraWriteDirs: cfg.extraWriteDirs, userArgs: cfg.args });
      const env = buildEnv({ platform: this.d.platform ?? process.platform, host: this.d.hostEnv ?? process.env, blenderDir: dirname(inst.path), taskDir: p.task, homeDir: p.home });
      const proc = this.d.proc.spawn({ args, cwd: p.task, env, maxOutputBytes: cfg.maxOutputBytes });
      if (proc.pid !== undefined) this.current = { pid: proc.pid, exited: proc.exited };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), timeoutMs); });
      const first = await Promise.race([proc.exited, timeout]);
      clearTimeout(timer);
      if (first === 'timeout') {
        // C14: stop the whole process tree by PID, then wait a short while to see it gone
        if (proc.pid) await this.d.proc.kill(proc.pid).catch(() => false);
        const settled = proc.pid ? await Promise.race([proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), this.d.stopWaitMs ?? STOP_WAIT_MS))]) : true;
        if (!settled || (proc.pid !== undefined && this.alive(proc.pid))) {
          this.stuck = proc.pid;
          return { kind: 'ran', p, runId, ok: false, timedOut: true, backup, violations: [], output: `Timed out after ${Math.round(timeoutMs / 1000)} s; Blender may still be running (process ${proc.pid}). New local runs wait until it is gone.` };
        }
        const bk = backup ? ` The scene was not saved; the copy from before this run is ${backup}.` : ' The scene was not saved.';
        return { kind: 'ran', p, runId, ok: false, timedOut: true, backup, violations: [], output: `Timed out after ${Math.round(timeoutMs / 1000)} s and was stopped.${bk}` };
      }
      const exit = first;
      if (exit.error === 'output limit') {
        // L6: system.ts killed the tree; if the PID is still there afterwards it is marked stuck exactly like a timeout
        if (!(await this.gone(proc.pid))) {
          this.stuck = proc.pid;
          return { kind: 'ran', p, runId, ok: false, timedOut: false, backup, violations: [], output: `Blender printed more than ${Math.round(cfg.maxOutputBytes / 1024)} KB; it could not be stopped and may still be running (process ${proc.pid}). New local runs wait until it is gone.` };
        }
        return { kind: 'ran', p, runId, ok: false, timedOut: false, backup, violations: [], output: `Blender printed more than ${Math.round(cfg.maxOutputBytes / 1024)} KB and was stopped. The scene was not saved.` };
      }
      if (exit.error && proc.pid === undefined) return { kind: 'ran', p, runId, ok: false, timedOut: false, backup, violations: [], output: `Blender could not be started: ${exit.error}` };
      type Parsed = { ok?: boolean; output?: string; run?: string; hash?: string; violations?: unknown };
      let parsed: Parsed | null = null;
      try {
        const st = lstatSync(resultFile);
        if (st.isFile() && st.size <= MAX_RESULT_BYTES) parsed = JSON.parse(readFileSync(resultFile, 'utf8')) as Parsed;
      } catch { parsed = null; }
      if (!parsed) {
        const tail = (proc.stderr() || proc.stdout()).trim().slice(-1500);
        return { kind: 'ran', p, runId, ok: false, timedOut: false, backup, violations: [], output: `Blender did not produce a result (exit ${exit.code ?? exit.signal ?? '?'}).\n${tail}` };
      }
      // C6: a result that names another run, or an ok result for another script, is not this run's
      if (parsed.run !== runId || (parsed.ok === true && parsed.hash !== req.hash)) {
        return { kind: 'ran', p, runId, ok: false, timedOut: false, backup, violations: [], output: 'The result file does not belong to this run (run id or script hash differs); it was discarded.' };
      }
      const violations = Array.isArray(parsed.violations) ? parsed.violations.filter((v): v is string => typeof v === 'string') : [];
      return { kind: 'ran', p, runId, ok: parsed.ok === true && exit.code === 0, timedOut: false, backup, violations, output: String(parsed.output ?? '') };
    } catch (e) {
      return { kind: 'refused', text: `The local run failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      this.current = undefined;
      try { for (const n of readdirSync(join(p.task, 'tmp'))) rmSync(join(p.task, 'tmp', n), { recursive: true, force: true }); } catch { /* best effort */ }
      for (const f of [scriptFile, resultFile, `${resultFile}.tmp`]) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
    }
  }

  async run(req: { agent: AgentProfile; taskId: string; script: string; hash: string; timeoutMs: number }): Promise<LocalRunResult> {
    return this.queued(async () => {
      const r = await this.execute(req, { readonly: false, withBackup: true });
      if (r.kind === 'refused') return { ok: false, text: r.text, files: [] };
      let files: LocalRunResult['files'] = [];
      let notes = '';
      if (!this.stuck) {
        const got = await this.collect(req.agent, req.taskId, r.p);
        files = got.files;
        const plain = got.files.filter((f) => !f.quarantined);
        const q = got.files.filter((f) => f.quarantined);
        notes = (plain.length ? `\nexports in your workspace: ${plain.map((f) => f.path).join(', ')}` : '') +
          (q.length ? `\nQUARANTINED (a .blend can carry runnable code; it is NOT in the export folder and live Blender may not open it): ${q.map((f) => f.path).join(', ')}` : '') +
          (got.problems.length ? `\n${got.problems.join('\n')}` : '');
      }
      const vio = r.violations.length ? `\n${r.violations.join('\n')}` : '';
      return { ok: r.ok, text: capText(r.output.trim() || '(no output)') + vio + notes, files, ...(r.timedOut ? { timedOut: true } : {}), ...(r.backup ? { backup: r.backup } : {}) };
    });
  }

  /** C10: the shared copy-back rules, reading from <task>/exports on local disk, then emptying that folder. */
  private async collect(agent: AgentProfile, taskId: string, p: Prepared): Promise<{ files: LocalRunResult['files']; problems: string[] }> {
    const link = findLink(p.exportsDir);
    const res = await collectExports({
      workspace: this.d.workspaceOf(agent), taskId, write: this.d.writeLocal, exportsBaseDir: this.d.config().baseDir,
      list: () => {
        if (link) throw new Error('exports folder holds a link');
        const out: Array<{ name: string; bytes: number }> = [];
        for (const name of readdirSync(p.exportsDir)) {
          const st = lstatSync(join(p.exportsDir, name));
          if (st.isFile() && !st.isSymbolicLink()) out.push({ name, bytes: st.size });
        }
        return out;
      },
      read: (name) => {
        const f = join(p.exportsDir, name);
        const st = lstatSync(f);
        if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_EXPORT_BYTES) throw new Error('not a plain file');
        return readFileSync(f);
      },
    });
    if (link) res.problems.push(`Exports were not copied: ${link} is a symbolic link.`);
    try { for (const n of readdirSync(p.exportsDir)) rmSync(join(p.exportsDir, n), { recursive: true, force: true }); } catch { /* best effort */ }
    return res;
  }

  async inspect(req: { agent: AgentProfile; taskId: string; object?: string }): Promise<BackendResult> {
    return this.queued(async () => {
      const r = await this.execute({ ...req, script: INSPECT_PY, hash: scriptHash(INSPECT_PY) }, { readonly: true, withBackup: false });
      if (r.kind === 'refused') return fail(r.text);
      return r.ok ? ok(capText(filterObject(r.output, req.object))) : fail(capText(r.output));
    });
  }

  async preview(req: { agent: AgentProfile; taskId: string; maxSize?: number }): Promise<BackendResult> {
    return this.queued(async () => {
      const size = Math.min(1280, Math.max(160, Math.round(req.maxSize ?? 480)));
      const name = `preview-${randomBytes(6).toString('hex')}.png`;
      const py = previewPy(size, name);
      const r = await this.execute({ ...req, script: py, hash: scriptHash(py) }, { readonly: true, withBackup: false });
      if (r.kind === 'refused') return fail(r.text);
      const file = join(r.p.task, basename(name));
      try {
        if (!r.ok) return fail(capText(r.output));
        const st = lstatSync(file);
        if (!st.isFile() || st.size > MAX_EXPORT_BYTES) return fail('The local run rendered no usable preview');
        return ok('local preview (Cycles, CPU, 8 samples, auto camera)', [{ mime: 'image/png', data: readFileSync(file).toString('base64') }]);
      } catch { return fail('The local run rendered no preview'); } finally { try { rmSync(file, { force: true }); } catch { /* ignore */ } }
    });
  }
}

/** For blender_inspect with an object name: keep the summary and the one object. */
function filterObject(output: string, object: string | undefined): string {
  if (!object) return output;
  try {
    const d = JSON.parse(output) as { objects?: Array<{ name: string }> } & Record<string, unknown>;
    return JSON.stringify({ ...d, objects: (d.objects ?? []).filter((o) => o.name === object) }, null, 1);
  } catch { return output; }
}
