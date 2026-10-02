/**
 * The Chromium-family engine (Microsoft Edge, Google Chrome, Brave, Chromium): where to find one, how to start it, how to read the port it chose.
 * This is the one engine Legion ships (see engine.ts for the interface a later engine would implement).
 * Pure: the file system is an injected interface, so it is tested with Windows-style paths on any system. Legion never runs a browser just to
 * probe it: the version comes from the install folder names, and a browser Legion cannot date is accepted with a note.
 *
 * Documented (see claude/plan-browser.md section on facts): with --remote-debugging-port=0 the browser listens on 127.0.0.1, prints
 * "DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<guid>" and writes "<port>\n/devtools/browser/<guid>" to DevToolsActivePort in
 * the user data directory (chromium/content/browser/devtools/devtools_http_handler.cc, chrome/browser/devtools/remote_debugging_server.cc).
 */
import { posix, win32 } from 'node:path';
import { CHROMIUM_MIN_MAJOR } from '../../shared/browser.js';
import type { ChromiumFound } from '../../shared/browser.js';
import type { BrowserEngineDef } from './engine.js';
import { launchBrowser } from './launcher.js';

export interface ChromiumIo {
  exists(path: string): boolean;
  /** File and folder names inside a folder; [] when it cannot be read. */
  readDir(path: string): string[];
}

const CRLF_OR_LF = /\r?\n/;

const pick = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  const v = k === undefined ? undefined : env[k];
  return v && v.trim() ? v : undefined;
};

export interface Candidate { name: string; path: string }

/** The usual install places, in the order Legion tries them: Edge first on Windows (every Windows 10/11 has it), then Chrome, then Brave. */
export function chromiumCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Candidate[] {
  const out: Candidate[] = [];
  const add = (name: string, path: string) => { if (!out.some((c) => (platform === 'win32' ? c.path.toLowerCase() === path.toLowerCase() : c.path === path))) out.push({ name, path }); };
  if (platform === 'win32') {
    const j = win32.join;
    const roots = [pick(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)', pick(env, 'ProgramFiles') ?? 'C:\\Program Files', pick(env, 'ProgramW6432')].filter((x): x is string => !!x);
    const local = pick(env, 'LOCALAPPDATA');
    for (const r of roots) add('Microsoft Edge', j(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const r of roots) add('Google Chrome', j(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (local) add('Google Chrome', j(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const r of roots) add('Brave', j(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    if (local) add('Brave', j(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
  } else if (platform === 'darwin') {
    add('Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    add('Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const [name, p] of [['Microsoft Edge', '/usr/bin/microsoft-edge'], ['Microsoft Edge', '/usr/bin/microsoft-edge-stable'], ['Google Chrome', '/usr/bin/google-chrome'], ['Google Chrome', '/usr/bin/google-chrome-stable'], ['Chromium', '/usr/bin/chromium'], ['Chromium', '/usr/bin/chromium-browser'], ['Brave', '/usr/bin/brave-browser']] as const) add(name, p);
  }
  return out;
}

const VERSION_DIR = /^\d{1,4}\.\d{1,4}\.\d{1,5}\.\d{1,5}$/;

/** The newest version folder next to the executable (Windows installs keep `Application\<version>\`), or undefined. Compares numbers, not text. */
export function versionNextTo(io: ChromiumIo, exePath: string, platform: NodeJS.Platform): string | undefined {
  const dir = (platform === 'win32' ? win32 : posix).dirname(exePath);
  const versions = io.readDir(dir).filter((n) => VERSION_DIR.test(n));
  if (!versions.length) return undefined;
  return versions.sort((a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; })[0];
}

export const majorOf = (v: string | undefined): number | undefined => (v ? Number(v.split('.')[0]) : undefined);

export function describe(name: string, path: string, io: ChromiumIo, platform: NodeJS.Platform): ChromiumFound {
  const version = versionNextTo(io, path, platform);
  const major = majorOf(version);
  return { name, path, ...(version ? { version } : {}), ...(major !== undefined && major < CHROMIUM_MIN_MAJOR ? { tooOld: true } : {}) };
}

/** The Chromium-family browser to use: the owner's path if set and present, else the first usual place that exists. `tried` lists what was looked at. */
export function detectChromium(io: ChromiumIo, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, userPath?: string): { found: ChromiumFound | null; tried: string[] } {
  const tried: string[] = [];
  if (userPath) {
    tried.push(userPath);
    if (io.exists(userPath)) {
      const base = (platform === 'win32' ? win32 : posix).basename(userPath).toLowerCase();
      const name = /edge/.test(base) ? 'Microsoft Edge' : /brave/.test(base) ? 'Brave' : /chrome(?!ium)/.test(base) ? 'Google Chrome' : /chromium/.test(base) ? 'Chromium' : 'Chromium-family browser';
      return { found: describe(name, userPath, io, platform), tried };
    }
    return { found: null, tried };
  }
  for (const c of chromiumCandidates(platform, env)) {
    tried.push(c.path);
    if (io.exists(c.path)) return { found: describe(c.name, c.path, io, platform), tried };
  }
  return { found: null, tried };
}

/**
 * The fixed arguments. Port 0: the browser picks a free one and reports it. No --no-sandbox, ever. Extensions, sync, background network, update checks,
 * new windows and permission prompts are off; WebRTC may not use non-proxied UDP; the user data directory is the fresh one Legion made.
 * The debugging switch below is the one place in src/ allowed to name it (test/net-guard-source.test.ts allows this file and only this exact switch).
 */
export function chromiumArgs(userDataDir: string): string[] {
  return [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-breakpad', '--mute-audio',
    '--block-new-web-contents', '--deny-permission-prompts', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    'about:blank',
  ];
}

/** "<port>\n/devtools/browser/<guid>" (CRLF tolerated, as a Windows file may carry). The path is checked so nothing else can steer the connection. */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | null {
  const lines = text.split(CRLF_OR_LF).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  if (!/^\d{1,5}$/.test(lines[0]!)) return null;
  const port = Number(lines[0]);
  if (port < 1 || port > 65535) return null;
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]{8,64}$/.test(lines[1]!)) return null;
  return { port, path: lines[1]! };
}

/** The engine definition the module registers: detect (never runs the browser) and launch. */
export function chromiumEngine(o: { io: ChromiumIo; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; userPath: () => string | undefined }): BrowserEngineDef {
  return {
    id: 'chromium',
    label: 'Microsoft Edge, Google Chrome or Brave (already on this computer)',
    detect: () => detectChromium(o.io, o.platform, o.env, o.userPath()),
    launch: (ports, found, opts) => launchBrowser(ports, found, opts),
  };
}
