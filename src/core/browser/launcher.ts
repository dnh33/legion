/**
 * Starts the Chromium-family browser for one run and returns the CDP connection. Pure orchestration over injected ports (the spawn is system.ts
 * through the shared process port, the connect is cdp.ts); tests use a fake browser script and a fake CDP server.
 * The argument list, environment and working folder are built here: argument array, no shell, complete scrubbed environment, a fresh user data
 * directory inside a fresh temp folder that is deleted afterwards, port 0 on loopback, fail closed.
 */
import type { ChromiumFound } from '../../shared/browser.js';
import { BROWSER_LIMITS } from '../../shared/browser.js';
import type { ProcessPort, SpawnedProcess } from '../blender/ports.js';
import type { CdpPort } from './cdp.js';
import { chromiumArgs, parseDevToolsActivePort } from './chromium.js';

export interface LaunchPorts {
  proc: ProcessPort;
  connect(wsUrl: string): Promise<CdpPort>;
  mkTemp(): string;
  removeDir(p: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  platform: NodeJS.Platform;
  hostEnv: NodeJS.ProcessEnv;
  /** Reads a small text file (the Chromium family's DevToolsActivePort); undefined when it is not there. */
  readText(path: string): string | undefined;
  /** Joins path parts for this system (Windows: backslashes). */
  join(...parts: string[]): string;
}

export interface RunningBrowser {
  /** A short label for results and Settings ("Microsoft Edge 120.0.2210.91 (headless)"). */
  label?: string;
  cdp: CdpPort;
  pid: number | undefined;
  port: number;
  args: string[];
  stop(): Promise<void>;
  /** Resolves when the process ends on its own (crash). */
  exited: Promise<unknown>;
}

const pick = (host: NodeJS.ProcessEnv, name: string): string | undefined => {
  const k = Object.keys(host).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : host[k];
};

/**
 * The child's COMPLETE environment: an allowlist, never a copy of process.env (so no API key or token reaches it).
 *
 * `USERPROFILE` is deliberately NOT set on Windows. Redirecting it into the run folder breaks Chromium-family
 * browsers outright: Edge resolves its own profile through that variable and, with it pointing at a temp folder,
 * logs "Failed to get path from PathService for key: 112" / "Can't retrieve app data directory", starts, stays
 * alive, and then never writes DevToolsActivePort — so the launcher waits out its whole timeout and reports
 * "The browser did not start: it did not report its debugging port in time". Verified on this machine with real
 * Edge 154 (probe: with USERPROFILE redirected = no port file; unset or real = port file written).
 *
 * Nothing is lost by leaving it unset. The browser is already told exactly where to keep its data
 * (`--user-data-dir=<fresh temp>/profile`), and APPDATA/LOCALAPPDATA still point into the run folder, so it
 * still cannot touch the owner's real profile. Dropping USERPROFILE fixes the launch; the profile isolation the
 * original code was after is unchanged.
 */
export function buildBrowserEnv(platform: NodeJS.Platform, host: NodeJS.ProcessEnv, dir: string): Record<string, string> {
  const e: Record<string, string> = { HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir };
  if (platform === 'win32') {
    for (const n of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT']) { const v = pick(host, n); if (v) e[n] = v; }
    e.Path = `${pick(host, 'SystemRoot') ?? 'C:\\Windows'}\\System32`;
    // the browser would otherwise look for a profile in the real AppData
    e.APPDATA = dir;
    e.LOCALAPPDATA = dir;
  } else { e.PATH = '/usr/bin:/bin'; e.LANG = 'C.UTF-8'; }
  return e;
}

export class LaunchError extends Error {}

/**
 * Starts a Chromium-family browser (Edge, Chrome, Brave, Chromium): argument list, no shell, the complete scrubbed environment, a fresh user data
 * directory inside a fresh temp folder, port 0 on loopback, and the port read from the DevToolsActivePort file the browser writes. Nothing is
 * downloaded and nothing is run to probe it. The process tree is stopped by PID; the temp folder is removed by the guarded remover only.
 */
export async function launchBrowser(p: LaunchPorts, found: Pick<ChromiumFound, 'path'>, o: { allowLocal?: boolean; startMs?: number; label?: string } = {}): Promise<RunningBrowser> {
  const dir = p.mkTemp();
  const profile = p.join(dir, 'profile');
  const portFile = p.join(profile, 'DevToolsActivePort');
  const cleanup = () => { try { p.removeDir(dir); } catch { /* best effort */ } };
  const proc: SpawnedProcess = p.proc.spawn({ args: chromiumArgs(profile), cwd: dir, env: buildBrowserEnv(p.platform, p.hostEnv, dir), maxOutputBytes: BROWSER_LIMITS.outputBytes, file: found.path });
  let ended = false;
  void proc.exited.then(() => { ended = true; });
  const stopProc = async () => { if (proc.pid && !ended) await p.proc.kill(proc.pid).catch(() => false); };
  const deadline = p.now() + (o.startMs ?? BROWSER_LIMITS.startTimeoutMs);
  let cdp: CdpPort | null = null;
  let port = 0;
  while (p.now() < deadline && !ended && !cdp) {
    const text = p.readText(portFile);
    const parsed = text ? parseDevToolsActivePort(text) : null;
    if (parsed) {
      try { cdp = await p.connect(`ws://127.0.0.1:${parsed.port}${parsed.path}`); port = parsed.port; } catch { await p.sleep(80); }
    } else await p.sleep(80);
  }
  if (cdp) {
    return {
      label: o.label ?? 'Chromium (headless)', cdp, pid: proc.pid, port, args: chromiumArgs(profile), exited: proc.exited,
      async stop() { try { cdp!.close(); } catch { /* closing */ } await stopProc(); cleanup(); },
    };
  }
  const wasEnded = ended; // before the kill below makes it true
  const res = wasEnded ? await proc.exited : null;
  await stopProc();
  cleanup();
  if (res?.error && /not found|ENOENT|EACCES|not installed/i.test(res.error)) throw new LaunchError(`The browser program could not be started: ${res.error}`);
  const err = (proc.stderr() || proc.stdout()).replace(/\s+/g, ' ').trim().slice(0, 200);
  throw new LaunchError(`The browser did not start: ${wasEnded ? `it stopped (exit ${res?.code ?? '?'}) ${err}` : 'it did not report its debugging port in time'}`.trim());
}
