/**
 * The real side effects of the browser tool, in one file so tests can replace all of them: an https download with a size cap and a streaming
 * sha256, file operations, a hash of an installed file, the process port (the Blender one: shell:false, scrubbed environment given whole,
 * PID-tree kill by PID) and the CDP connect. Nothing here runs until the owner pressed a button or a run used a browser tool.
 * Download rules: https only, public host only, every redirect hop re-checked, size capped; the address always comes from the pin or an owner-set value.
 */
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomInt } from 'node:crypto';
import { killTree, isPublicHttpsUrl, spawnManaged } from '../blender/system.js';
import type { ProcessPort } from '../blender/ports.js';
import { connectCdp } from './cdp.js';
import type { GetPorts } from './get-lightpanda.js';
import type { ChromiumIo } from './chromium.js';
import type { LaunchPorts } from './launcher.js';

const MAX_REDIRECTS = 4;

export async function download(url: string, dest: string, opts: { maxBytes: number }): Promise<{ sha256: string; bytes: number }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!isPublicHttpsUrl(current)) throw new Error('Refusing to download: the address must be https and public.');
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000), headers: { 'user-agent': 'Legion-Browser-Setup' } });
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
    try { await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(dest)); }
    catch (e) { try { rmSync(dest, { force: true }); } catch { /* ignore */ } throw e; }
    return { sha256: hash.digest('hex'), bytes };
  }
}

export const hashFile = (p: string): Promise<string> => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(p).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

export const chromiumIo = (): ChromiumIo => ({ exists: (p) => { try { return existsSync(p); } catch { return false; } }, readDir: (p) => { try { return readdirSync(p); } catch { return []; } } });

export const platformKey = (): string => `${process.platform}-${process.arch}`;

export function createGetPorts(): GetPorts {
  return {
    platformKey: platformKey(), download, hashFile,
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
    exists: (p) => { try { return existsSync(p); } catch { return false; } },
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
    writeText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t, 'utf8'); },
    rename: (a, b) => { renameSync(a, b); },
    removeFile: (p) => { rmSync(p, { force: true }); },
    removeDir: (p) => { rmSync(p, { recursive: true, force: true }); },
    makeExecutable: (p) => { chmodSync(p, 0o755); },
    now: () => new Date(),
  };
}

/** The process port: production starts only the file the module resolved (a managed binary or the owner's own); `file` and `prefixArgs` are how the module passes it. */
export function createProcessPort(): ProcessPort {
  return {
    spawn(req) {
      if (!req.file) return { pid: undefined, exited: Promise.resolve({ code: null, signal: null, error: 'The browser program was not found' }), stdout: () => '', stderr: () => '' };
      return spawnManaged(req.file, { args: [...(req.prefixArgs ?? []), ...req.args], cwd: req.cwd, env: req.env, maxOutputBytes: req.maxOutputBytes });
    },
    kill: killTree,
  };
}

/** The prefix of every folder Legion makes for a run. */
export const RUN_DIR_PREFIX = 'legion-browser-';

/**
 * Deletes a run folder ONLY if it is directly inside `root` (Legion's own temp root), carries Legion's prefix and is a real folder, not a link
 * (a link there could point anywhere). Returns whether it was removed. A refusal leaves the folder alone.
 */
export function removeRunDir(dir: string, root: string = tmpdir()): boolean {
  try {
    const abs = resolvePath(dir);
    const base = resolvePath(root);
    if (!abs.startsWith(base + sep) || abs.slice(base.length + 1).includes(sep) || !abs.slice(base.length + 1).startsWith(RUN_DIR_PREFIX)) return false;
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    // the real location must still be that same folder inside the real temp root (a link higher up, or a swapped folder, is refused)
    const real = realpathSync(abs); const realBase = realpathSync(base);
    if (real !== join(realBase, abs.slice(base.length + 1))) return false;
    rmSync(abs, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

export function createLaunchPorts(proc: ProcessPort = createProcessPort()): LaunchPorts {
  return {
    proc,
    connect: (u) => connectCdp(u, { connectTimeoutMs: 800 }),
    mkTemp: () => mkdtempSync(join(tmpdir(), RUN_DIR_PREFIX)),
    removeDir: (p) => { removeRunDir(p); },
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
    join,
    randomPort: () => randomInt(20000, 60000),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    platform: process.platform,
    hostEnv: process.env,
  };
}
