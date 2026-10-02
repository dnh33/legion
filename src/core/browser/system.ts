/**
 * The real side effects of the browser tool, in one file so tests can replace them: file system reads for detection, the process port (the
 * Blender one: shell:false, scrubbed environment given whole, PID-tree kill by PID), the CDP connect and the guarded removal of a run folder.
 * No network access here: nothing is downloaded by this tool.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';
import { killTree, spawnManaged } from '../blender/system.js';
import type { ProcessPort } from '../blender/ports.js';
import { connectCdp } from './cdp.js';
import type { ChromiumIo } from './chromium.js';
import type { LaunchPorts } from './launcher.js';

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

export const chromiumIo = (): ChromiumIo => ({
  exists: (p) => { try { return existsSync(p); } catch { return false; } },
  readDir: (p) => { try { return readdirSync(p); } catch { return []; } },
});

/** The process port: it starts only the file it is given (the detected or chosen browser). */
export function createProcessPort(): ProcessPort {
  return {
    spawn(req) {
      if (!req.file) return { pid: undefined, exited: Promise.resolve({ code: null, signal: null, error: 'The browser program was not found' }), stdout: () => '', stderr: () => '' };
      return spawnManaged(req.file, { args: [...(req.prefixArgs ?? []), ...req.args], cwd: req.cwd, env: req.env, maxOutputBytes: req.maxOutputBytes });
    },
    kill: killTree,
  };
}

export function createLaunchPorts(proc: ProcessPort = createProcessPort()): LaunchPorts {
  return {
    proc,
    connect: (u) => connectCdp(u, { connectTimeoutMs: 800 }),
    mkTemp: () => mkdtempSync(join(tmpdir(), RUN_DIR_PREFIX)),
    removeDir: (p) => { removeRunDir(p); },
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
    join,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    platform: process.platform,
    hostEnv: process.env,
  };
}
