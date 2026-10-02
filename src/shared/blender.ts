/**
 * Legion: Blender Bridge contract (config shape, status view, constants).
 * Shared by the core module (src/core/blender), the HTTP routes and the UI. See docs/BLENDER.md.
 */

export type BlenderBackendChoice = 'auto' | 'official' | 'community';
export type BlenderBackendKind = 'official' | 'community';
/** off = scripts only run in your live Blender; vm = only in the Sculptor's boat.dev VM; auto = VM unless a script was approved live before. */
export type BlenderSandboxMode = 'off' | 'vm' | 'auto';

/** Blender 5.1 is the first version the official Blender Lab MCP supports. */
export const OFFICIAL_MIN_VERSION = '5.1.0';

/** The id of the one bot that gets the Blender tools. */
export const SCULPTOR_ID = 'sculptor';
/** In-process MCP server name (tools appear as mcp__legion_blender__<tool>). */
export const BLENDER_SERVER_NAME = 'legion_blender';
/** The tool name of the guarded exec, as the approval card and the engine see it. */
export const BLENDER_EXEC_TOOL = `mcp__${BLENDER_SERVER_NAME}__blender_exec`;

/**
 * Names the OFFICIAL server's tools are looked up by. UNVERIFIED: these are best guesses from the public description; at connect time
 * the backend also matches against the server's real tool list by pattern (see backends/official.ts) and falls back to these.
 */
export interface BlenderToolMap {
  /** The raw code-execution tool. Only the guard calls it; agents never see it. */
  exec: string;
  /** Argument name that carries the Python source. */
  execArg: string;
  inspect: string;
  screenshot: string;
  docs: string;
}

/** Everything under blender.advanced is for people who edit config.json: assumptions kept as data, not code. */
export interface BlenderAdvanced {
  official: {
    /** Where the official server is downloaded from, only when you press Set up. UNVERIFIED default. */
    sourceUrl: string;
    /** Optional sha256 (hex) the downloaded archive must match; empty = trust on first use, the hash is recorded and shown. */
    sha256: string;
    /** How Legion starts the server (stdio MCP). {serverDir} {host} {port} are replaced. UNVERIFIED default. */
    command: string;
    args: string[];
    env: Record<string, string>;
    /** Path of the add-on inside the downloaded archive (a folder, a .py or a .zip). UNVERIFIED default. */
    addonPath: string;
    tools: BlenderToolMap;
  };
  community: {
    /** Raw add-on file. Default: the upstream addon.py on the main branch. */
    addonUrl: string;
    sha256: string;
    /** Command names of the add-on's JSON socket protocol ({"type": <name>, "params": {...}}). UNVERIFIED defaults taken from the public add-on. */
    commands: { exec: string; inspect: string; objectInfo: string; screenshot: string };
    /** Python run inside a Blender that Legion starts, to open the add-on's socket without a click. UNVERIFIED default. */
    startExpr: string;
  };
  vm: {
    /** Where headless Blender is downloaded from INSIDE the VM when you press Set up for the sandbox. UNVERIFIED default. */
    blenderUrl: string;
    /** Executable name or path inside the VM. */
    blenderBin: string;
    /** Longest a script may run in the VM (seconds). */
    timeoutSeconds: number;
    /** Shell command that runs one script in headless Blender. {blender} {runner} {workdir} are replaced. */
    runCommand: string;
  };
}

/** What Setup resolved for the official server: how Legion starts it. Kept apart from config.mcpServers on purpose (agents must never get its raw tools). */
export interface BlenderEntry { command: string; args: string[]; env: Record<string, string>; serverDir: string; at: string }

export interface BlenderConfig {
  /** Off by default: nothing is detected, downloaded or offered to agents until you turn it on. */
  enabled: boolean;
  backend: BlenderBackendChoice;
  /** Loopback only; anything else in a config file is replaced by 127.0.0.1. */
  host: string;
  /** TCP port of the add-on socket (the community add-on's default is 9876). */
  port: number;
  /** Optional: path of blender(.exe) or the folder that holds it. Overrides detection. */
  installPath?: string;
  sandbox: BlenderSandboxMode;
  /** Written by Setup. NOT an entry of config.mcpServers: those are handed to agents, and this server has a raw execute tool. */
  entry?: BlenderEntry;
  advanced: BlenderAdvanced;
}

export const DEFAULT_ADVANCED: BlenderAdvanced = {
  official: {
    sourceUrl: 'https://projects.blender.org/lab/blender_mcp/archive/main.zip',
    sha256: '',
    command: 'uv',
    args: ['run', '--project', '{serverDir}', 'blender-mcp', '--host', '{host}', '--port', '{port}'],
    env: {},
    addonPath: 'addon',
    tools: { exec: 'execute_python', execArg: 'code', inspect: 'get_scene_info', screenshot: 'get_viewport_screenshot', docs: 'search_docs' },
  },
  community: {
    addonUrl: 'https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py',
    sha256: '',
    commands: { exec: 'execute_code', inspect: 'get_scene_info', objectInfo: 'get_object_info', screenshot: 'get_viewport_screenshot' },
    startExpr: 'import bpy; bpy.ops.blendermcp.start_server()',
  },
  vm: {
    blenderUrl: 'https://download.blender.org/release/Blender5.1/blender-5.1.0-linux-x64.tar.xz',
    blenderBin: 'blender',
    timeoutSeconds: 300,
    runCommand: '{blender} -b --factory-startup --python {runner} -- {workdir}',
  },
};

export const DEFAULT_BLENDER_PORT = 9876;

export function defaultBlenderConfig(): BlenderConfig {
  return {
    enabled: false, backend: 'auto', host: '127.0.0.1', port: DEFAULT_BLENDER_PORT, sandbox: 'auto',
    advanced: JSON.parse(JSON.stringify(DEFAULT_ADVANCED)) as BlenderAdvanced,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, d: string, max = 1000): string => (typeof v === 'string' && v.trim() && v.length <= max && !/[\0\r\n]/.test(v) ? v.trim() : d);
const strList = (v: unknown, d: string[]): string[] => (Array.isArray(v) && v.length <= 64 && v.every((x) => typeof x === 'string' && x.length <= 1000 && !/\0/.test(x)) ? (v as string[]) : d);
const strMap = (v: unknown, d: Record<string, string>): Record<string, string> => {
  if (!isObj(v)) return d;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof x === 'string' && x.length <= 1000 && !/\0/.test(x)) out[k] = x;
  return out;
};
const httpsUrl = (v: unknown, d: string): string => {
  if (typeof v !== 'string') return d;
  try { const u = new URL(v); return u.protocol === 'https:' ? u.toString() : d; } catch { return d; }
};
const hex = (v: unknown): string => (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v.trim()) ? v.trim().toLowerCase() : '');

const normEntry = (v: unknown): BlenderEntry | undefined => {
  if (!isObj(v) || typeof v.command !== 'string' || !v.command.trim() || v.command.length > 500 || /\0/.test(v.command)) return undefined;
  return {
    command: v.command.trim(), args: strList(v.args, []), env: strMap(v.env, {}),
    serverDir: typeof v.serverDir === 'string' && v.serverDir.length <= 1000 && !/\0/.test(v.serverDir) ? v.serverDir : '',
    at: typeof v.at === 'string' ? v.at.slice(0, 40) : '',
  };
};

/** True for the loopback names the bridge accepts. */
export const isLoopbackHost = (h: string): boolean => h === '127.0.0.1' || h === 'localhost' || h === '::1';

/**
 * Whatever the file held under "blender", reduced to the shapes we accept. Never throws. Downloads are https only; the host is loopback only
 * (a script must never be sent to another machine); unknown or malformed fields fall back to the defaults.
 */
export function normalizeBlender(v: unknown): BlenderConfig {
  const d = defaultBlenderConfig();
  if (!isObj(v)) return d;
  const adv = isObj(v.advanced) ? v.advanced : {};
  const off = isObj(adv.official) ? adv.official : {};
  const com = isObj(adv.community) ? adv.community : {};
  const vm = isObj(adv.vm) ? adv.vm : {};
  const tools = isObj(off.tools) ? off.tools : {};
  const dt = d.advanced.official.tools;
  const port = typeof v.port === 'number' && Number.isInteger(v.port) && v.port >= 1024 && v.port <= 65535 ? v.port : d.port;
  const secs = typeof vm.timeoutSeconds === 'number' && Number.isFinite(vm.timeoutSeconds) ? Math.min(900, Math.max(10, Math.round(vm.timeoutSeconds))) : d.advanced.vm.timeoutSeconds;
  const toolName = (x: unknown, def: string) => (typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(x) ? x : def);
  return {
    enabled: v.enabled === true,
    backend: v.backend === 'official' || v.backend === 'community' || v.backend === 'auto' ? v.backend : d.backend,
    host: typeof v.host === 'string' && isLoopbackHost(v.host.trim()) ? v.host.trim() : d.host,
    port,
    ...(typeof v.installPath === 'string' && v.installPath.trim() && v.installPath.length <= 1000 && !/\0/.test(v.installPath) ? { installPath: v.installPath.trim() } : {}),
    sandbox: v.sandbox === 'off' || v.sandbox === 'vm' || v.sandbox === 'auto' ? v.sandbox : d.sandbox,
    ...(normEntry(v.entry) ? { entry: normEntry(v.entry)! } : {}),
    advanced: {
      official: {
        sourceUrl: httpsUrl(off.sourceUrl, d.advanced.official.sourceUrl),
        sha256: hex(off.sha256),
        command: str(off.command, d.advanced.official.command, 500),
        args: strList(off.args, d.advanced.official.args),
        env: strMap(off.env, d.advanced.official.env),
        addonPath: str(off.addonPath, d.advanced.official.addonPath, 300),
        tools: {
          exec: toolName(tools.exec, dt.exec), execArg: toolName(tools.execArg, dt.execArg), inspect: toolName(tools.inspect, dt.inspect),
          screenshot: toolName(tools.screenshot, dt.screenshot), docs: toolName(tools.docs, dt.docs),
        },
      },
      community: {
        addonUrl: httpsUrl(com.addonUrl, d.advanced.community.addonUrl), sha256: hex(com.sha256),
        commands: {
          exec: toolName(isObj(com.commands) ? com.commands.exec : undefined, d.advanced.community.commands.exec),
          inspect: toolName(isObj(com.commands) ? com.commands.inspect : undefined, d.advanced.community.commands.inspect),
          objectInfo: toolName(isObj(com.commands) ? com.commands.objectInfo : undefined, d.advanced.community.commands.objectInfo),
          screenshot: toolName(isObj(com.commands) ? com.commands.screenshot : undefined, d.advanced.community.commands.screenshot),
        },
        startExpr: str(com.startExpr, d.advanced.community.startExpr, 500),
      },
      vm: {
        blenderUrl: httpsUrl(vm.blenderUrl, d.advanced.vm.blenderUrl),
        blenderBin: str(vm.blenderBin, d.advanced.vm.blenderBin, 300),
        timeoutSeconds: secs,
        runCommand: str(vm.runCommand, d.advanced.vm.runCommand, 500),
      },
    },
  };
}

/** A Blender installation found on this computer. */
export interface BlenderInstall {
  /** Full path of the blender executable. */
  path: string;
  /** "5.1.0"; the folder name when the executable could not be asked ("5.1"). */
  version: string;
  source: 'config' | 'registry' | 'program-files' | 'steam' | 'path' | 'applications' | 'linux';
  /** True when the version came from the folder name and not from `blender --version`. */
  versionGuessed?: boolean;
}

export type BlenderLight = 'off' | 'not-found' | 'needs-setup' | 'disconnected' | 'connected' | 'sandbox' | 'error';

/** GET /api/blender and the blender.status event. No secrets; paths are the user's own. */
export interface BlenderStatusView {
  enabled: boolean;
  light: BlenderLight;
  /** One plain sentence for the Ops card. */
  summary: string;
  backendChoice: BlenderBackendChoice;
  chosenBackend: BlenderBackendKind | null;
  /** Why that backend (or why none). */
  backendReason: string;
  installs: BlenderInstall[];
  selected?: BlenderInstall;
  connected: boolean;
  /** The add-on socket accepted a connection (a quick TCP probe), before any inspect call. */
  socketOpen: boolean;
  sandbox: BlenderSandboxMode;
  /** The Sculptor can run VM scripts right now (boat.dev key set and the Sculptor's VM switched on). */
  sandboxReady: boolean;
  sandboxNote: string;
  host: string;
  port: number;
  /** What Setup already put on disk. */
  setup: { official: ServerSetupInfo | null; community: ServerSetupInfo | null; addonInstalledFor: BlenderBackendKind | null };
  lastError?: string;
  lastCheckedAt: string;
  /** Scripts this core run asked the user about, and what they said. */
  stats: { approved: number; denied: number; blocked: number };
}

export interface ServerSetupInfo { url: string; sha256: string; at: string; license: string }

export interface BlenderSetupStep { step: string; ok: boolean; detail: string }
export interface BlenderSetupResult { ok: boolean; steps: BlenderSetupStep[]; status: BlenderStatusView }
export interface BlenderTestResult { ok: boolean; steps: BlenderSetupStep[]; status: BlenderStatusView }

/** Words shown next to the Set up button and in docs/BLENDER.md. Kept here so UI and docs say the same thing. */
export const BLENDER_LICENSE_NOTE =
  'The official Blender Lab MCP server is GPL-3.0-or-later; Legion is MIT. Legion never bundles or copies it: it is downloaded from its official source only when you press Set up, and stays a separate program Legion talks to over a socket or stdio.';
export const BLENDER_SAFETY_NOTE =
  'Blender runs scripts without any guards. Agents never get the raw execute tool: every script is checked, shown to you in full and needs your OK, the .blend is backed up before the first script of a run, and by default scripts run in a cloud VM instead of your machine. The check is a filter, not a sandbox: read the script before you approve it.';
