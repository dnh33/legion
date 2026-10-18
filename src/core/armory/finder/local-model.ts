/**
 * The skill finder's local embedder: an Embedder backed by a helper process (embed-worker.js) that holds the downloaded model.
 *
 * The model needs about 1 GB, so it never runs in Legion's own process. The helper starts on the first request, stops after
 * `idleMs` without one, and starts again on the next request. Legion kills only the child it started, through its own handle:
 * when it is idle, on dispose and when you remove the model. Any error, exit or timeout rejects the request, and the finder then
 * ranks that turn by keywords alone.
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODEL_IDLE_MS, MODEL_LOAD_BACKOFF_MS } from './defaults.js';
import type { EmbedKind, Embedder } from './embed.js';

export interface LocalModelOpts {
  /** The folder with the pinned files. */
  modelDir: string;
  /** Names the model for the vector cache. */
  id: string;
  /** The helper script. Default: embed-worker.js next to this file. Tests pass a fake. */
  workerPath?: string;
  /** Stop the helper after this long without a request, in ms. Default MODEL_IDLE_MS. */
  idleMs?: number;
  /** A request that gets no answer in this time fails, in ms. Default 60 s. */
  timeoutMs?: number;
  /**
   * The pinned files (name, size, sha256). They go to the helper in argv, and it refuses to load unless every file in the folder
   * matches. Without them the helper cannot start.
   */
  files?: { name: string; bytes: number; sha256: string }[];
  /** Called once when the helper found a file that does not match its pin. */
  onIntegrity?: (why: string) => void;
  /** After the helper fails to load (not an integrity failure), no new helper starts for this long, in ms. Default MODEL_LOAD_BACKOFF_MS. */
  backoffMs?: number;
  /** The clock for the back-off. Tests pass a fake. */
  now?: () => number;
  /** One line when the back-off starts. */
  log?: (m: string) => void;
}

export interface LocalEmbedder extends Embedder {
  /** Whether the helper process is running now. */
  running(): boolean;
  /** The helper's process id while it runs. */
  pid(): number | undefined;
  /** Stops the helper (if any). The next request starts a new one. */
  stop(): void;
  /** Stops the helper and refuses every later request. */
  dispose(): void;
}

const DEFAULT_WORKER = fileURLToPath(new URL('./embed-worker.js', import.meta.url));
const STDERR_KEEP = 2000;
/** The only variables the helper gets: it loads downloaded code, so it sees none of your keys or settings. */
const CHILD_ENV_KEYS = ['PATH', 'SystemRoot', 'TEMP', 'TMP'];
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_KEYS) {
    // Windows names are not case sensitive (Path, PATH).
    const hit = Object.keys(process.env).find((n) => n.toLowerCase() === k.toLowerCase());
    if (hit && process.env[hit] !== undefined) env[hit] = process.env[hit];
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

interface Pending { resolve(v: Float32Array[]): void; reject(e: Error): void; timer: NodeJS.Timeout; off?: () => void }

export function createLocalModel(o: LocalModelOpts): LocalEmbedder {
  const idleMs = o.idleMs ?? MODEL_IDLE_MS;
  const timeoutMs = o.timeoutMs ?? 60_000;
  let child: ChildProcess | undefined;
  let idle: NodeJS.Timeout | undefined;
  let disposed = false;
  let backoffUntil = 0;
  const now = o.now ?? Date.now;
  let nextId = 1;
  let stderr = '';
  const pending = new Map<number, Pending>();

  const failAll = (why: string): void => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.off?.(); p.reject(new Error(why)); pending.delete(id); }
  };
  const armIdle = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { if (pending.size === 0) stop(); else armIdle(); }, idleMs);
    idle.unref();
  };
  function stop(): void {
    if (idle) { clearTimeout(idle); idle = undefined; }
    const c = child;
    child = undefined;
    failAll('The local model stopped.');
    if (c && c.exitCode === null && !c.killed) { try { c.kill(); } catch { /* already gone */ } }
  }

  const start = (): ChildProcess => {
    stderr = '';
    const c = fork(o.workerPath ?? DEFAULT_WORKER, [o.modelDir, JSON.stringify(o.files ?? [])], {
      execPath: process.execPath,
      execArgv: [],
      env: childEnv(),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    c.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-STDERR_KEEP); });
    c.on('message', (m: unknown) => {
      const r = m as { id?: unknown; vectors?: unknown; error?: unknown; fatal?: unknown; integrity?: unknown };
      if (typeof r?.fatal === 'string') {
        if (child === c) {
          child = undefined;
          failAll(`The local model could not start: ${r.fatal}`);
          if (r.integrity === true) { disposed = true; o.onIntegrity?.(r.fatal); } else {
            // A load that failed once will fail again: do not fork a helper (and load about 1 GB) on every call.
            backoffUntil = now() + (o.backoffMs ?? MODEL_LOAD_BACKOFF_MS);
            try { o.log?.('finder: the local model could not load; it will not be tried again for a while'); } catch { /* a log failure is not a load failure */ }
          }
        }
        return;
      }
      if (typeof r?.id !== 'number') return;
      const p = pending.get(r.id);
      if (!p) return; // answered after the caller gave up
      pending.delete(r.id);
      clearTimeout(p.timer);
      p.off?.();
      if (child === c) armIdle();
      if (typeof r.error === 'string') { p.reject(new Error(r.error)); return; }
      if (!Array.isArray(r.vectors)) { p.reject(new Error('The local model sent a bad answer.')); return; }
      p.resolve((r.vectors as number[][]).map((v) => Float32Array.from(v)));
    });
    const gone = (why: string) => () => {
      if (child !== c) return;
      child = undefined;
      if (idle) { clearTimeout(idle); idle = undefined; }
      failAll(`${why}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`);
    };
    c.on('exit', gone('The local model stopped'));
    c.on('error', gone('The local model could not start'));
    return c;
  };

  return {
    id: o.id,
    running: () => !!child && child.exitCode === null && !child.killed,
    pid: () => child?.pid,
    stop,
    dispose() { disposed = true; stop(); },
    embed(texts, signal, kind: EmbedKind = 'passage') {
      if (disposed) return Promise.reject(new Error('The local model is switched off.'));
      if (signal.aborted) return Promise.reject(new Error('Cancelled.'));
      if (texts.length === 0) return Promise.resolve([]);
      if (!(child && child.exitCode === null && !child.killed) && now() < backoffUntil) return Promise.reject(new Error('The local model failed to load a moment ago; it is not tried again yet.'));
      return new Promise<Float32Array[]>((resolve, reject) => {
        let c: ChildProcess;
        try { c = child && child.exitCode === null && !child.killed ? child : (child = start()); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return; }
        const id = nextId++;
        const settle = (why: string): void => {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          clearTimeout(p.timer);
          p.off?.();
          p.reject(new Error(why));
        };
        // A helper that has not answered in this time is stuck: it is stopped, and the next request starts a fresh one.
        const timer = setTimeout(() => { settle('The local model took too long to answer.'); if (child === c) stop(); }, timeoutMs);
        timer.unref();
        const onAbort = (): void => settle('Cancelled.');
        signal.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve, reject, timer, off: () => signal.removeEventListener('abort', onAbort) });
        armIdle();
        try { c.send({ id, kind, texts }); } catch (e) {
          pending.delete(id); clearTimeout(timer); signal.removeEventListener('abort', onAbort);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
  };
}
