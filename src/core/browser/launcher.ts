/**
 * Starts one `lightpanda serve` for one run and returns the CDP connection. Pure orchestration over injected ports (the spawn is system.ts
 * through the Blender process port, the connect is cdp.ts); tests use a fake lightpanda script and a fake CDP server.
 * The argument list, environment and working folder are built here: argument array, no shell, complete scrubbed environment, an empty temp folder
 * that is deleted afterwards, bind 127.0.0.1 on a random port, fail closed when the build rejects a safety option.
 */
import { join } from 'node:path';
import { BROWSER_LIMITS } from '../../shared/browser.js';
import type { ProcessPort, SpawnedProcess } from '../blender/ports.js';
import type { CdpPort } from './cdp.js';

export interface BinaryRef { file: string; prefixArgs: string[]; /** true when the file is wsl.exe (Windows): the Linux child gets a hard wall-time wrapper. */ wsl: boolean }

export interface LaunchPorts {
  proc: ProcessPort;
  connect(wsUrl: string): Promise<CdpPort>;
  mkTemp(): string;
  removeDir(p: string): void;
  randomPort(): number;
  sleep(ms: number): Promise<void>;
  now(): number;
  platform: NodeJS.Platform;
  hostEnv: NodeJS.ProcessEnv;
}

export interface RunningBrowser {
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

/** The child's COMPLETE environment: an allowlist, never a copy of process.env (so no API key or token reaches it). */
export function buildBrowserEnv(platform: NodeJS.Platform, host: NodeJS.ProcessEnv, dir: string): Record<string, string> {
  const e: Record<string, string> = { LIGHTPANDA_DISABLE_TELEMETRY: 'true', LIGHTPANDA_DISABLE_CORE_DUMP: '1', HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir };
  if (platform === 'win32') {
    for (const n of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT']) { const v = pick(host, n); if (v) e[n] = v; }
    e.Path = `${pick(host, 'SystemRoot') ?? 'C:\\Windows'}\\System32`;
    e.USERPROFILE = dir;
  } else { e.PATH = '/usr/bin:/bin'; e.LANG = 'C.UTF-8'; }
  return e;
}

/** The fixed hardening options (plan section 1). `allowLocal` only removes the private-network block; the metadata range stays blocked. */
export function buildBrowserArgs(port: number, allowLocal: boolean): string[] {
  return [
    'serve', '--host', '127.0.0.1', '--port', String(port),
    '--cdp-max-connections', '2', '--cdp-max-message-size', String(BROWSER_LIMITS.cdpMessageBytes),
    '--http-max-response-size', String(BROWSER_LIMITS.responseBytes), '--http-timeout', '15000', '--http-connect-timeout', '8000',
    '--v8-max-heap-mb', String(BROWSER_LIMITS.v8HeapMb), '--watchdog-ms', String(BROWSER_LIMITS.watchdogMs), '--disable-metrics',
    ...(allowLocal ? [] : ['--block-private-networks']), '--block-cidrs', '169.254.0.0/16',
  ];
}

export class LaunchError extends Error {}

export async function launchBrowser(p: LaunchPorts, bin: BinaryRef, o: { allowLocal: boolean; wallMs?: number; startMs?: number }): Promise<RunningBrowser> {
  const dir = p.mkTemp();
  const cleanup = () => { try { p.removeDir(dir); } catch { /* best effort */ } };
  let lastNote = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = p.randomPort();
    const args = buildBrowserArgs(port, o.allowLocal);
    const wall = Math.ceil((o.wallMs ?? BROWSER_LIMITS.wallMs) / 1000);
    // a Linux child inside WSL is not reached by taskkill on wsl.exe for sure, so it gets its own hard wall time
    const lead = bin.wsl ? ['timeout', '-s', 'KILL', `${wall}s`] : [];
    const proc: SpawnedProcess = p.proc.spawn({ args: [...lead, ...args], cwd: dir, env: buildBrowserEnv(p.platform, p.hostEnv, dir), maxOutputBytes: BROWSER_LIMITS.outputBytes, file: bin.file, prefixArgs: bin.prefixArgs });
    let ended = false;
    void proc.exited.then(() => { ended = true; });
    const stopProc = async () => { if (proc.pid && !ended) await p.proc.kill(proc.pid).catch(() => false); };
    const startMs = o.startMs ?? BROWSER_LIMITS.startTimeoutMs;
    const deadline = p.now() + startMs;
    let cdp: CdpPort | null = null;
    while (p.now() < deadline && !ended && !cdp) {
      try { cdp = await p.connect(`ws://127.0.0.1:${port}`); } catch { await p.sleep(60); }
    }
    if (cdp) {
      const exited = proc.exited;
      return {
        cdp, pid: proc.pid, port, args, exited,
        async stop() { try { cdp!.close(); } catch { /* closing */ } await stopProc(); cleanup(); },
      };
    }
    const res = ended ? await proc.exited : null;
    await stopProc();
    const err = (proc.stderr() || proc.stdout()).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (res?.error && /not found|ENOENT|EACCES|not installed/i.test(res.error)) { cleanup(); throw new LaunchError(`The browser program could not be started: ${res.error}`); }
    if (ended && (res?.code ?? 1) !== 0 && p.now() < deadline && /unknown|invalid|unrecognized|usage|option|argument/i.test(err)) {
      cleanup();
      throw new LaunchError(`This Lightpanda build rejected a required safety option and was not started without it. ${err}`.trim());
    }
    lastNote = ended ? `it stopped (exit ${res?.code ?? '?'}) ${err}` : 'it did not start listening in time';
  }
  cleanup();
  throw new LaunchError(`The browser did not start: ${lastNote}`.trim());
}
