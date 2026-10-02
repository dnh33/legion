/**
 * The real side effects of Blender setup, in one file so tests can replace all of them (setup.ts only sees the BlenderIo interface):
 * file system, `reg query`, running programs, an https download with a size cap, extracting an archive, starting Blender detached.
 * Nothing here runs unless the user pressed a button (Set up, Test, Launch) or the Blender settings page asked for a status.
 * This file is on the BSV tripwire allowlist for fetch and child-process; the URL that is downloaded always comes from config
 * (advanced.*), is https only, and a redirect may only go to another public https host.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlenderIo } from './setup.js';
import type { GetBlenderPorts } from './get-blender.js';
import { polyhavenUrlOk } from './assets.js';
import type { AssetNet } from './assets.js';
import type { ProcessPort, SpawnedProcess, SpawnRequest } from './ports.js';
import type { DetectEnv, RunResult } from './detect.js';
import { PYTHON_UTF8_ENV } from './backend.js';

/** https only, and not a loopback or private address: a download must never be pointed at the user's own network. */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.includes(':')) return false; // IPv6 literals are not needed for a download
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return false;
  }
  return true;
}

function run(file: string, args: string[], timeoutMs: number, opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, cwd: opts.cwd, env: { ...process.env, ...opts.env, ...PYTHON_UTF8_ENV }, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { resolve(null); return; }
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    } catch { resolve(null); }
  });
}

export function realDetectEnv(): DetectEnv {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: (p) => { try { return existsSync(p); } catch { return false; } },
    readDir: (p) => { try { return readdirSync(p); } catch { return []; } },
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
    registryQuery: process.platform === 'win32'
      ? async (key) => { const r = await run('reg', ['query', key, '/s'], 8000); return r && r.code === 0 ? r.stdout : undefined; }
      : undefined,
    run,
  };
}

const MAX_REDIRECTS = 4;

async function download(url: string, dest: string, opts: { maxBytes: number; urlOk?: (url: string) => boolean }): Promise<{ sha256: string; bytes: number }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!isPublicHttpsUrl(current) || (opts.urlOk && !opts.urlOk(current))) throw new Error('Refusing to download: the address must be https, public and on the expected host.');
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000), headers: { 'user-agent': 'Legion-Blender-Setup' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop >= MAX_REDIRECTS) throw new Error('Too many redirects while downloading.');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`The download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > opts.maxBytes) throw new Error(`The download is ${Math.round(len / 1e6)} MB, more than the ${Math.round(opts.maxBytes / 1e6)} MB limit.`);
    mkdirSync(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const hash = createHash('sha256');
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > opts.maxBytes) { cb(new Error('The download is larger than the size limit.')); return; }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(part));
    } catch (e) { try { rmSync(part, { force: true }); } catch { /* ignore */ } throw e; }
    renameSync(part, dest);
    return { sha256: hash.digest('hex'), bytes };
  }
}

async function extract(archive: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  // bsdtar (Windows 10+, macOS) reads zip and tar; GNU tar needs unzip for zip. Both refuse paths that climb out of destDir.
  const attempts: Array<[string, string[]]> = /\.zip$/i.test(archive)
    ? [['tar', ['-xf', archive, '-C', destDir]], ['unzip', ['-o', '-q', archive, '-d', destDir]]]
    : [['tar', ['-xf', archive, '-C', destDir]]];
  let last = '';
  for (const [cmd, args] of attempts) {
    const r = await run(cmd, args, 120_000);
    if (r && r.code === 0) return;
    last = r ? (r.stderr || r.stdout).trim().slice(0, 300) : `${cmd} is not installed`;
  }
  throw new Error(`Could not unpack the download: ${last}`);
}

/**
 * The real network side of asset downloads (assets.ts holds the logic): Poly Haven only, https only, a host allowlist checked on every redirect hop,
 * a 5 MB cap on the JSON listings and the same size-capped file download as Set up. Runs only when the Sculptor's asset tool was approved on a card
 * (a search is a read-only listing and needs the source switched on in Settings).
 */
export function createAssetNet(): AssetNet {
  return {
    getJson: async (url) => {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isPublicHttpsUrl(current) || !polyhavenUrlOk(current)) throw new Error('Refusing to fetch: the address must be https and on a Poly Haven host.');
        const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Legion-Blender-Assets', accept: 'application/json' } });
        if (res.status >= 300 && res.status < 400) { const loc = res.headers.get('location'); if (!loc) throw new Error('Poly Haven redirected without an address.'); current = new URL(loc, current).toString(); continue; }
        if (!res.ok) throw new Error(`Poly Haven answered HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > 5 * 1024 * 1024) throw new Error('Poly Haven sent a listing larger than the 5 MB limit.');
        return JSON.parse(text) as unknown;
      }
      throw new Error('Too many redirects.');
    },
    download: (url, dest, o) => download(url, dest, { maxBytes: o.maxBytes, urlOk: polyhavenUrlOk }),
  };
}

/** The real ports of "Get Blender for Legion" (get-blender.ts). The download is the same https-only, public-host, size-capped one as Set up. */
export function createGetBlenderPorts(): GetBlenderPorts {
  return {
    platform: process.platform,
    download,
    openZip: (file) => {
      const fd = openSync(file, 'r');
      const size = statSync(file).size;
      return {
        close: () => { try { closeSync(fd); } catch { /* ignore */ } },
        source: {
          size,
          read: async (offset, length) => { const buf = Buffer.alloc(length); const n = readSync(fd, buf, 0, length, offset); return buf.subarray(0, n); },
          stream: (start, endInclusive) => createReadStream(file, { start, end: endInclusive }),
        },
      };
    },
    sink: { mkdirp: (d) => { mkdirSync(d, { recursive: true }); }, openWrite: (f) => createWriteStream(f, { flags: 'wx' }) },
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
    exists: (p) => { try { return existsSync(p); } catch { return false; } },
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
    writeText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t, 'utf8'); },
    rename: (a, b) => { renameSync(a, b); },
    removeDir: (p) => { rmSync(p, { recursive: true, force: true }); },
    removeFile: (p) => { rmSync(p, { force: true }); },
    now: () => new Date(),
  };
}

export function createRealIo(): BlenderIo {
  return {
    detect: realDetectEnv(),
    run,
    download,
    extract,
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
    writeText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t, 'utf8'); },
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
    copyFile: (a, b) => { mkdirSync(dirname(b), { recursive: true }); copyFileSync(a, b); },
    exists: (p) => { try { return existsSync(p); } catch { return false; } },
    isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
    listDir: (p) => { try { return readdirSync(p); } catch { return []; } },
    removeDir: (p) => { rmSync(p, { recursive: true, force: true }); },
    spawnDetached: (file, args, env) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, env: { ...process.env, ...env, ...PYTHON_UTF8_ENV } });
      child.on('error', () => undefined);
      child.unref();
    },
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Local headless Blender: the only place that starts or stops the process for a local run (local.ts takes a ProcessPort)
// ---------------------------------------------------------------------------------------------------------------------------------

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/**
 * Stops a process and everything it started, by PID (never by name). Windows: `taskkill /PID <pid> /T /F` through execFile (no shell).
 * POSIX: the child was started as a group leader (detached), so the whole group gets SIGKILL. Resolves true when the PID is gone.
 */
export async function killTree(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve()); } catch { resolve(); }
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !pidAlive(pid);
}

/**
 * Starts one program: argument array, shell:false, windowsHide, the COMPLETE environment given (never merged with process.env), stdout and
 * stderr read through a counter. Above `maxOutputBytes` the process tree is killed and `exited` reports error 'output limit'.
 */
export function spawnManaged(file: string, req: SpawnRequest): SpawnedProcess {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let total = 0;
  let capped = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(file, req.args, { cwd: req.cwd, env: req.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { pid: undefined, exited: Promise.resolve({ code: null, signal: null, error: e instanceof Error ? e.message : String(e) }), stdout: () => '', stderr: () => '' };
  }
  const take = (into: Buffer[]) => (chunk: Buffer) => {
    if (capped) return;
    const room = req.maxOutputBytes - total;
    if (chunk.length > room) {
      if (room > 0) into.push(chunk.subarray(0, room));
      total = req.maxOutputBytes;
      capped = true;
      if (child.pid) void killTree(child.pid);
      return;
    }
    total += chunk.length;
    into.push(chunk);
  };
  child.stdout?.on('data', take(out));
  child.stderr?.on('data', take(err));
  const exited = new Promise<{ code: number | null; signal: string | null; error?: string }>((resolve) => {
    let settled = false;
    const done = (code: number | null, signal: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, ...(capped ? { error: 'output limit' } : error ? { error } : {}) });
    };
    child.on('error', (e) => done(null, null, e.message));
    // 'exit' fires when the process ends; a grandchild that keeps the pipes open must not hold the result back
    child.on('exit', (code, signal) => { const t = setTimeout(() => done(code, signal), 300); t.unref?.(); child.once('close', () => { clearTimeout(t); done(code, signal); }); });
  });
  return { pid: child.pid, exited, stdout: () => Buffer.concat(out).toString('utf8'), stderr: () => Buffer.concat(err).toString('utf8') };
}

/**
 * The ProcessPort for local runs. Production spawns only the detected Blender executable; `file` and `prefixArgs` in a request are a test seam
 * (a fake blender run as `node fake.mjs ...`) and no production caller sets them.
 */
export function createProcessPort(blenderExe: () => string | undefined): ProcessPort {
  return {
    spawn(req) {
      const exe = req.file ?? blenderExe();
      if (!exe) return { pid: undefined, exited: Promise.resolve({ code: null, signal: null, error: 'Blender was not found on this computer' }), stdout: () => '', stderr: () => '' };
      return spawnManaged(exe, { args: [...(req.prefixArgs ?? []), ...req.args], cwd: req.cwd, env: req.env, maxOutputBytes: req.maxOutputBytes });
    },
    kill: killTree,
  };
}
