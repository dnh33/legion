/**
 * Legion: Blender Bridge contract (config shape, status view, constants).
 * Shared by the core module (src/core/blender), the HTTP routes and the UI. See docs/BLENDER.md.
 */

export type BlenderBackendChoice = 'auto' | 'official' | 'community';
export type BlenderBackendKind = 'official' | 'community';
/** Where scripts run. auto = this computer when Blender is found, else the cloud VM; local = headless Blender on this computer; vm = the Sculptor's boat.dev VM; live = your open Blender. */
export type BlenderMode = 'auto' | 'local' | 'vm' | 'live';
export const BLENDER_MODES: readonly BlenderMode[] = ['auto', 'local', 'vm', 'live'];
/** LEGACY key (kept for reading and mirroring so a downgrade still opens). `off` is only the old alias of mode `live`. off = scripts only run in your live Blender; vm = only in the Sculptor's boat.dev VM; auto = VM unless a script was approved live before. */
export type BlenderSandboxMode = 'off' | 'vm' | 'auto';

/** Blender 5.1 is the first version the official Blender Lab MCP supports. */
export const OFFICIAL_MIN_VERSION = '5.1.0';
/** Oldest Blender a LOCAL (headless) run accepts. Raised from 3.0 to 4.2 (the oldest LTS the owner supports); the community live backend still accepts 3.0+. */
export const LOCAL_MIN_VERSION = '4.2.0';

/**
 * The ONE headless Blender build Legion itself may fetch (Settings, "Get Blender for Legion"), after the user clicks and approves a card.
 * Fixed in code on purpose: the address and the hash are not read from config, so editing config.json cannot point the download elsewhere.
 * Provenance (looked up 2026-10-02): version, channel, size and date from blender.org/download and blender.org/download/lts (5.2 LTS, last updated to
 * 5.2.2 on 2026-09-15; "Windows Portable (.zip) 386 MB"). The file name follows Blender's release naming and is NOT confirmed by a request.
 * sha256: given by the owner in the build session on 2026-10-02 as the value from Blender's official checksum file (checksumUrl) for blender-5.2.2-windows-x64.zip (x64, not the ARM64 zip).
 * The cloud session could not reach download.blender.org to read it itself, so it is NOT independently reproduced.
 * TODO OWNER PC: compare it with `checksumUrl` (or Get-FileHash on the downloaded zip) before release. If a hash is ever empty the download is
 * REFUSED (Legion never installs an archive it has no hash for); config blender.advanced.managed.sha256 is only a fallback for that case.
 */
export const MANAGED_BLENDER = {
  version: '5.2.2',
  channel: '5.2 LTS',
  platform: 'win32' as string,
  url: 'https://download.blender.org/release/Blender5.2/blender-5.2.2-windows-x64.zip',
  checksumUrl: 'https://download.blender.org/release/Blender5.2/blender-5.2.2.sha256',
  sha256: '3849d17a682cba006075aaa3f3597ecb5c9c30ec31035b2e092c53e40679b535',
  /** Shown to the user; the real limits are the two caps below. */
  approxBytes: 386 * 1024 * 1024,
  maxArchiveBytes: 700 * 1024 * 1024,
  maxUnpackedBytes: 3 * 1024 * 1024 * 1024,
  maxEntries: 40_000,
  /** The folder inside the zip and the executable Legion looks for after unpacking. */
  topDir: 'blender-5.2.2-windows-x64',
  exe: 'blender.exe',
  license: 'GPL-3.0-or-later',
  sourceUrl: 'https://projects.blender.org/blender/blender',
} as const;
/** The official download page, for people who want the full Blender (opened in the browser; Legion downloads nothing from it). */
export const BLENDER_DOWNLOAD_PAGE = 'https://www.blender.org/download/';
/**
 * "Use both backends at once" (plan section 15). The official Blender Lab MCP is the MAIN backend, the community add-on the SECOND. Each add-on listens on its
 * own port: the official one on `port`, the community one on advanced.both.communityPort. Legion never relies on SO_REUSEADDR: both ports are probed before
 * anything is started and each answer is identified before it is used.
 */
export const DEFAULT_COMMUNITY_PORT = 9877;
/** Asset sources Legion can fetch itself (it downloads, hashes and files the result; the add-on's own downloads happen inside Blender, where Legion cannot). */
export const ASSET_SOURCES = ['polyhaven'] as const;
export type AssetSource = typeof ASSET_SOURCES[number];
/** Sources the community add-on offers that Legion does NOT use, and why (shown in Settings and docs). */
export const ASSET_SOURCES_UNSUPPORTED: Readonly<Record<string, string>> = {
  sketchfab: 'needs your account token inside the add-on, and the add-on downloads and imports inside Blender, where Legion cannot place, hash or limit the file',
  hyper3d: 'a paid generator that needs your key inside the add-on and imports inside Blender, where Legion cannot place, hash or limit the file',
  polypizza: 'the add-on downloads and imports inside Blender, where Legion cannot place, hash or limit the file',
  hunyuan3d: 'a generator that needs your key inside the add-on and imports inside Blender, where Legion cannot place, hash or limit the file',
  tripo: 'a paid premium generator inside the add-on, and the add-on imports inside Blender, where Legion cannot place, hash or limit the file',
};
/** Hosts (and their subdomains) a Poly Haven fetch may talk to. api.polyhaven.com is the API base the pinned add-on uses; file hosts come from the API's answers and must end in one of these. TODO OWNER PC: confirm the file host on a real download. */
export const POLYHAVEN_HOSTS: readonly string[] = ['polyhaven.com', 'polyhaven.org'];
export const POLYHAVEN_API = 'https://api.polyhaven.com';
/** Tool name of the approval card for an asset download. */
export const BLENDER_ASSET_TOOL = 'mcp__legion_blender__blender_asset_get';

/** Tool name of the approval card for the managed download (not an agent tool: only the Settings route asks). */
export const GET_BLENDER_TOOL = 'legion_get_blender';

/** The id of the one bot that gets the Blender tools. */
export const SCULPTOR_ID = 'sculptor';
/** In-process MCP server name (tools appear as mcp__legion_blender__<tool>). */
export const BLENDER_SERVER_NAME = 'legion_blender';
/** The tool name of the guarded exec, as the approval card and the engine see it. */
export const BLENDER_EXEC_TOOL = `mcp__${BLENDER_SERVER_NAME}__blender_exec`;

/**
 * Names the OFFICIAL server's tools are looked up by. The defaults are the tool names in the blender_mcp v1.0.3 source (mcp/blmcp/tools/*.py,
 * read when this default was set); see backends/official.ts for how a name is matched.
 */
export interface BlenderToolMap {
  /** The raw code-execution tool. Only the guard calls it; agents never see it. */
  exec: string;
  /** Argument name that carries the Python source. */
  execArg: string;
  /** The no-approval tools (inspect, objectInfo, screenshot, docs) are used only under exactly these names, or, when the server does not have them,
   *  a pattern match the server itself marks readOnlyHint; never the exec tool and never a tool that takes code. */
  inspect: string;
  /** Detail of one object (takes the object's name). */
  objectInfo: string;
  screenshot: string;
  docs: string;
}

/** Everything under blender.advanced is for people who edit config.json: assumptions kept as data, not code. */
/** Guard for the local runner's Python-level write/network seatbelt: block = refuse, log = record only (documented fallback). */
export type BlenderLocalGuard = 'block' | 'log';

export interface BlenderAdvanced {
  both: {
    /** Port of the community add-on when "Use both backends at once" is on (the official add-on uses `port`). Must differ from `port`. */
    communityPort: number;
  };
  managed: {
    /** sha256 (64 hex) for the pinned managed build, used only while MANAGED_BLENDER.sha256 is empty. Empty = the download is refused. */
    sha256: string;
  };
  local: {
    /** Longest a local script may run (seconds, clamped 10-900). */
    timeoutSeconds: number;
    /** A task folder bigger than this refuses the run. */
    maxTaskBytes: number;
    /** Stdout+stderr above this kills the process. */
    maxOutputBytes: number;
    /** Extra folders the runner's write guard allows besides the task folder. */
    extraWriteDirs: string[];
    guard: BlenderLocalGuard;
    /** Extra Blender arguments. The fixed hardening flags are added by code, never by config. */
    args: string[];
  };
  official: {
    /** Where the official server is downloaded from, only when you press Set up. The default is the v1.0.3 TAG, not a moving branch. */
    sourceUrl: string;
    /** sha256 (hex) the downloaded archive must match. The default pins the v1.0.3 archive. Empty = trusted on first use: the hash is recorded, and a later
     *  download whose hash differs is REFUSED until you press "Trust the new download" (it is never replaced silently). */
    sha256: string;
    /** How Legion starts the server (stdio MCP). {serverDir} {host} {port} are replaced (args and env). */
    command: string;
    args: string[];
    env: Record<string, string>;
    /** Path of the add-on inside the downloaded archive (a folder, a .py or a .zip). */
    addonPath: string;
    tools: BlenderToolMap;
  };
  community: {
    /** Raw add-on file. Default: the upstream addon.py at ONE commit (the project has no tags or releases), so the URL never moves; sha256 below pins its bytes. */
    addonUrl: string;
    /** As for the official server: empty = trusted on first use, a changed download is refused until re-trusted. */
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
  /** Where scripts run. ABSENT until the user saves a choice (then the legacy `sandbox` key decides, see effectiveMode). */
  mode?: BlenderMode;
  /** "Use both backends at once". OFF unless the owner turns it on; with it off exactly one live backend is used, as before. */
  both?: boolean;
  /** Per-source switch for asset downloads (the Sculptor's blender_asset_* tools). Every source is OFF until switched on here. */
  assets?: Partial<Record<AssetSource, boolean>>;
  /** True once the user chose where scripts run (the first-use chooser or the Settings radio). Enabling the bridge alone does not set it. */
  modeAsked?: boolean;
  /** Legacy mirror of `mode` (auto/local -> auto, vm -> vm, live -> off). Always written alongside `mode`. */
  sandbox: BlenderSandboxMode;
  /** Written by Setup. NOT an entry of config.mcpServers: those are handed to agents, and this server has a raw execute tool. */
  entry?: BlenderEntry;
  advanced: BlenderAdvanced;
}

export const LOCAL_MIN_TIMEOUT_S = 10;
export const LOCAL_MAX_TIMEOUT_S = 900;

/** The community add-on as pinned by this version (a 40-hex commit in the URL, and the sha256 of addon.py at that commit). */
export const COMMUNITY_PIN_URL = 'https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py';
export const COMMUNITY_PIN_SHA256 = 'eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5';
/** The old default (a moving branch, no hash). A stored config that still holds exactly this pair never chose it, so it moves to the pin; any other pair is the user's and stays. */
const OLD_COMMUNITY_URL = 'https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py';

/** Lines in a script as a person counts them: a trailing newline does not add a line (same rule as the card's splitScriptLines). `""` is 1. */
export function countLines(s: string): number {
  const n = s.split(/\r\n|\r|\n/);
  if (n.length > 1 && n[n.length - 1] === '') n.pop();
  return n.length;
}

export const DEFAULT_ADVANCED: BlenderAdvanced = {
  both: { communityPort: DEFAULT_COMMUNITY_PORT },
  managed: { sha256: '' },
  local: { timeoutSeconds: 120, maxTaskBytes: 500 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, extraWriteDirs: [], guard: 'block', args: [] },
  official: {
    sourceUrl: 'https://projects.blender.org/api/v1/repos/lab/blender_mcp/archive/v1.0.3.zip',
    sha256: 'e08a16ba01a02b80469ef9ca2dc04cee8711d0b4a32ad27c66891935cc5abebe',
    command: 'uv',
    args: ['run', '--project', '{serverDir}/mcp', 'blender-mcp'],
    env: { BLENDER_MCP_HOST: '{host}', BLENDER_MCP_PORT: '{port}' },
    addonPath: 'addon/blender_mcp_addon',
    tools: { exec: 'execute_blender_code', execArg: 'code', inspect: 'get_objects_summary', objectInfo: 'get_object_detail_summary', screenshot: 'get_screenshot_of_window_as_image', docs: 'search_api_docs' },
  },
  community: {
    // Pinned 2026-10-02 to the newest commit that touched addon.py (project moved to ahujasid/mcp-for-blender; no tags or releases exist).
    // TODO OWNER PC: the sha256 below was taken from fetched metadata in a sandboxed session and has NOT been reproduced yet. Before release run, in PowerShell:
    //   curl.exe -sSL <addonUrl> -o addon.py; (Get-FileHash addon.py -Algorithm SHA256).Hash.ToLower()
    // and compare. If it differs, take the PC's value and re-check `git log -1 -- addon.py` on a clone first. See claude/plan-blender-local-first.md section 5.2.
    addonUrl: COMMUNITY_PIN_URL,
    sha256: COMMUNITY_PIN_SHA256,
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

/** The legacy `sandbox` value that mirrors a mode, so an older Legion still opens the file. */
export const mirrorSandbox = (m: BlenderMode): BlenderSandboxMode => (m === 'vm' ? 'vm' : m === 'live' ? 'off' : 'auto');
/** Legacy `sandbox` value -> mode (`off` is only an alias of live). */
export const modeFromSandbox = (s: BlenderSandboxMode): BlenderMode => (s === 'vm' ? 'vm' : s === 'off' ? 'live' : 'auto');
/** The mode in force: the saved one, else derived from the legacy key. */
export const effectiveMode = (c: Pick<BlenderConfig, 'mode' | 'sandbox'>): BlenderMode => c.mode ?? modeFromSandbox(c.sandbox);

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
const hex = (v: unknown, dflt = ''): string => {
  if (typeof v !== 'string') return dflt;
  if (/^[0-9a-fA-F]{64}$/.test(v.trim())) return v.trim().toLowerCase();
  // an explicitly empty value means "no pin" (trust on first use, with a re-trust prompt on change); anything malformed keeps the default
  return v.trim() === '' ? '' : dflt;
};

/** The add-on source and its pin. An explicit empty sha256 means "no pin" (trust on first use); the old unpinned default is upgraded to the pin. */
function communityPin(com: Record<string, unknown>, d: BlenderAdvanced['community']): { addonUrl: string; sha256: string } {
  const addonUrl = httpsUrl(com.addonUrl, d.addonUrl);
  // the pinned hash is the default only for the pinned URL; another address with no hash of its own is trust-on-first-use, never checked against the wrong file
  const sha256 = hex(com.sha256, addonUrl === d.addonUrl ? d.sha256 : '');
  if (addonUrl === OLD_COMMUNITY_URL && sha256 === '') return { addonUrl: d.addonUrl, sha256: d.sha256 };
  return { addonUrl, sha256 };
}

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
  const loc = isObj(adv.local) ? adv.local : {};
  const man = isObj(adv.managed) ? adv.managed : {};
  const both = isObj(adv.both) ? adv.both : {};
  const dl = d.advanced.local;
  const int = (x: unknown, def: number, lo: number, hi: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : def);
  const mode = BLENDER_MODES.includes(v.mode as BlenderMode) ? (v.mode as BlenderMode) : undefined;
  const legacy: BlenderSandboxMode = v.sandbox === 'off' || v.sandbox === 'vm' || v.sandbox === 'auto' ? v.sandbox : d.sandbox;
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
    ...(mode ? { mode } : {}),
    ...(v.modeAsked === true ? { modeAsked: true } : {}),
    ...(v.both === true ? { both: true } : {}),
    ...(isObj(v.assets) && ASSET_SOURCES.some((k) => v.assets && (v.assets as Record<string, unknown>)[k] === true) ? { assets: Object.fromEntries(ASSET_SOURCES.map((k) => [k, (v.assets as Record<string, unknown>)[k] === true])) as Partial<Record<AssetSource, boolean>> } : {}),
    sandbox: mode ? mirrorSandbox(mode) : legacy,
    ...(normEntry(v.entry) ? { entry: normEntry(v.entry)! } : {}),
    advanced: {
      both: { communityPort: typeof both.communityPort === 'number' && Number.isInteger(both.communityPort) && both.communityPort >= 1024 && both.communityPort <= 65535 ? both.communityPort : DEFAULT_COMMUNITY_PORT },
      managed: { sha256: hex(man.sha256, '') },
      local: {
        timeoutSeconds: int(loc.timeoutSeconds, dl.timeoutSeconds, LOCAL_MIN_TIMEOUT_S, LOCAL_MAX_TIMEOUT_S),
        maxTaskBytes: int(loc.maxTaskBytes, dl.maxTaskBytes, 1024 * 1024, 100 * 1024 * 1024 * 1024),
        maxOutputBytes: int(loc.maxOutputBytes, dl.maxOutputBytes, 1024, 256 * 1024 * 1024),
        extraWriteDirs: strList(loc.extraWriteDirs, dl.extraWriteDirs),
        guard: loc.guard === 'log' || loc.guard === 'block' ? loc.guard : dl.guard,
        args: strList(loc.args, dl.args),
      },
      official: {
        sourceUrl: httpsUrl(off.sourceUrl, d.advanced.official.sourceUrl),
        sha256: hex(off.sha256, d.advanced.official.sha256),
        command: str(off.command, d.advanced.official.command, 500),
        args: strList(off.args, d.advanced.official.args),
        env: strMap(off.env, d.advanced.official.env),
        addonPath: str(off.addonPath, d.advanced.official.addonPath, 300),
        tools: {
          exec: toolName(tools.exec, dt.exec), execArg: toolName(tools.execArg, dt.execArg), inspect: toolName(tools.inspect, dt.inspect),
          objectInfo: toolName(tools.objectInfo, dt.objectInfo), screenshot: toolName(tools.screenshot, dt.screenshot), docs: toolName(tools.docs, dt.docs),
        },
      },
      community: {
        ...communityPin(com, d.advanced.community),
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
  source: 'config' | 'managed' | 'registry' | 'program-files' | 'steam' | 'path' | 'applications' | 'linux';
  /** True when the version came from the folder name and not from `blender --version`. */
  versionGuessed?: boolean;
}

export type BlenderLight = 'off' | 'not-found' | 'needs-setup' | 'disconnected' | 'connected' | 'sandbox' | 'local' | 'busy' | 'error';

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
  /** The effective mode (saved, else derived from the legacy key). */
  mode?: BlenderMode;
  /** A Blender >= 4.2 (LOCAL_MIN_VERSION) was found on this computer, so local runs can start. */
  localReady?: boolean;
  localNote?: string;
  /** Plain text: where the next script goes, or why it cannot run. */
  nextRun?: string;
  /** The user has not yet chosen where scripts run: the first approval card carries a one-time chooser. */
  modeAsked?: boolean;
  /** "Use both backends at once": the switch, the ports and what each side answered at the last check. */
  both?: {
    enabled: boolean;
    officialPort: number;
    communityPort: number;
    /** Plain sentence: what is verified, or why it is not. */
    note: string;
    /** Names (source:name) of the extra tools the Sculptor can call right now. */
    extras: string[];
    assets: Array<{ source: string; enabled: boolean; supported: boolean; reason?: string }>;
  };
  /** The Legion-managed headless Blender (Settings, "Get Blender for Legion"). */
  managed?: {
    installed: { version: string; path: string; sha256: string; at: string } | null;
    /** A pinned hash exists, so the download may run. False until the owner records one (see MANAGED_BLENDER). */
    pinned: boolean;
    version: string;
    channel: string;
    approxMb: number;
    supported: boolean;
    url: string;
    downloadPage: string;
    /** A download is waiting for the user's approval or running now. */
    getting?: boolean;
  };
  /** A script is running (or timed out and may still be running). */
  busy?: { since: string; hash12: string; mode: 'live' | 'local' | 'sandbox' } | null;
  host: string;
  port: number;
  /** What Setup already put on disk. */
  setup: { official: ServerSetupInfo | null; community: ServerSetupInfo | null; addonInstalledFor: BlenderBackendKind | null };
  lastError?: string;
  /** Plain warnings shown next to the light: the add-on socket has no password, an audit log that does not check out, failed audit writes. */
  notices?: string[];
  lastCheckedAt: string;
  /** Scripts this core run asked the user about, and what they said. */
  stats: { approved: number; denied: number; blocked: number; auditFailures?: number };
}

export interface ServerSetupInfo { url: string; sha256: string; at: string; license: string }

export interface BlenderSetupStep { step: string; ok: boolean; detail: string }
export interface BlenderSetupResult {
  ok: boolean;
  steps: BlenderSetupStep[];
  status: BlenderStatusView;
  /** A download differs from the one trusted before; nothing was changed. The UI offers "Trust the new download" (POST /api/blender/setup with retrust: true). */
  retrustRequired?: BlenderBackendKind;
}
export interface BlenderTestResult { ok: boolean; steps: BlenderSetupStep[]; status: BlenderStatusView }

/** True of both backends today: the add-on in Blender opens a local socket with no password (checked in the v1.0.3 official source and the community addon.py). */
export const BLENDER_SOCKET_NOTICE =
  'While the add-on\'s server is running in Blender, any program on this computer can send code to its port (127.0.0.1) without Legion\'s approval card: the add-on has no password and Legion cannot add one. Stop the server (or close Blender) when you are not using the bridge, and do not give a Bash tool to an agent that reads untrusted content.';

/** Shown while "Use both backends at once" is on: two sockets, neither with a password. */
export const BLENDER_BOTH_NOTICE =
  'Use both backends at once is on: two add-on servers are listening in Blender, one per port, and neither has a password. Any program on this computer can send code to either port without Legion\'s approval card. Legion checks which add-on answers on which port, but that identifies the server; it does not authenticate a caller. Stop the servers (or close Blender) when you are not using the bridge.';

/** Shown in Settings and the Ops card while an install that enabled the bridge before this version has never saved a mode (it disappears once any mode is saved). */
export const BLENDER_UPGRADE_NOTICE = 'Scripts now run in Blender on this computer by default when it is found. Pick Cloud VM to keep the old behaviour.';

/** Words shown next to the Set up button and in docs/BLENDER.md. Kept here so UI and docs say the same thing. */
export const BLENDER_LICENSE_NOTE =
  'The official Blender Lab MCP server is GPL-3.0-or-later; Legion is MIT. Legion never bundles or copies it: it is downloaded from its official source only when you press Set up, and stays a separate program Legion talks to over a socket or stdio.';
