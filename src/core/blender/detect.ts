/**
 * Finds Blender on this computer and decides which MCP backend to use. Pure logic: the file system, the registry and process
 * execution come in through DetectEnv, so the tests run on Linux with fakes and never touch a real machine.
 */
import { OFFICIAL_MIN_VERSION } from '../../shared/blender.js';
import type { BlenderBackendChoice, BlenderBackendKind, BlenderInstall } from '../../shared/blender.js';

export interface RunResult { code: number; stdout: string; stderr: string }

export interface DetectEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** True when a file or folder exists. */
  exists(path: string): boolean;
  /** Names inside a folder; [] when it cannot be read. */
  readDir(path: string): string[];
  /** Text of a file; undefined when it cannot be read. */
  readText?(path: string): string | undefined;
  /** Runs `reg query ... /s` style lookups on Windows and returns the raw output; undefined elsewhere or on failure. */
  registryQuery?(key: string): Promise<string | undefined>;
  /** Runs a program with a short timeout; null when it could not be started. */
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult | null>;
  /** The user's home folder. */
  home: string;
}

/** Where Blender keeps its install folder on Windows (the MSI and the installer write InstallDir under these). */
export const WINDOWS_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\BlenderFoundation',
  'HKLM\\SOFTWARE\\WOW6432Node\\BlenderFoundation',
  'HKCU\\SOFTWARE\\BlenderFoundation',
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------------------------------------

/** "5.1.0", "4.2.3" or "5.1" (padded to three parts) from any text, or null. */
export function normalizeVersion(text: string): string | null {
  const m = /(\d{1,2})\.(\d{1,2})(?:\.(\d{1,3}))?/.exec(text);
  if (!m) return null;
  return `${Number(m[1])}.${Number(m[2])}.${m[3] === undefined ? 0 : Number(m[3])}`;
}

/** Reads `blender --version` output: "Blender 5.1.0\n\tbuild date: ...". */
export function parseVersionOutput(out: string): string | null {
  const m = /^\s*Blender\s+(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)/im.exec(out);
  return m ? normalizeVersion(m[1]!) : null;
}

/** Version from a folder or file name: "Blender 5.1", "blender-4.2.3-linux-x64", "Blender5.1". */
export function versionFromName(name: string): string | null {
  const m = /blender[\s_-]*v?(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)/i.exec(name);
  return m ? normalizeVersion(m[1]!) : null;
}

/** <0, 0, >0 like a comparator; unparsable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = (normalizeVersion(a) ?? '0.0.0').split('.').map(Number);
  const pb = (normalizeVersion(b) ?? '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

export const versionAtLeast = (v: string, min: string): boolean => compareVersions(v, min) >= 0;

// ---------------------------------------------------------------------------------------------------------------------------------
// Candidate locations
// ---------------------------------------------------------------------------------------------------------------------------------

const join = (platform: NodeJS.Platform, ...parts: string[]): string => {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts.filter((p) => p !== '').map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
};
const exeName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'blender.exe' : 'blender');

interface Candidate { path: string; source: BlenderInstall['source']; folderName?: string }

/** "InstallDir    REG_SZ    C:\Program Files\Blender Foundation\Blender 4.2\" lines from `reg query /s`. */
export function parseRegistryInstallDirs(out: string): string[] {
  const dirs: string[] = [];
  for (const m of out.matchAll(/^\s*InstallDir\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/gim)) dirs.push(m[1]!.replace(/[\\/]+$/, ''));
  return [...new Set(dirs)];
}

/** Steam library roots from libraryfolders.vdf ("path"   "D:\\SteamLibrary"). */
export function parseSteamLibraries(vdf: string): string[] {
  const out: string[] = [];
  for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) out.push(m[1]!.replace(/\\\\/g, '\\'));
  return out;
}

async function windowsCandidates(env: DetectEnv): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const p = 'win32' as const;
  const roots = [env.env.ProgramFiles, env.env['ProgramFiles(x86)'], env.env.ProgramW6432, env.env.LOCALAPPDATA && join(p, env.env.LOCALAPPDATA, 'Programs')]
    .filter((r): r is string => !!r);
  if (!roots.length) roots.push('C:\\Program Files', 'C:\\Program Files (x86)');
  for (const root of new Set(roots)) {
    const base = join(p, root, 'Blender Foundation');
    for (const d of env.readDir(base)) if (/^Blender/i.test(d)) out.push({ path: join(p, base, d, exeName(p)), source: 'program-files', folderName: d });
    // newer installers use "Blender 5.1" directly under Program Files
    for (const d of env.readDir(root)) if (/^Blender\s*\d/i.test(d)) out.push({ path: join(p, root, d, exeName(p)), source: 'program-files', folderName: d });
  }
  // Steam: default folders plus any library listed in libraryfolders.vdf
  const steamRoots = new Set<string>();
  for (const r of [env.env['ProgramFiles(x86)'], env.env.ProgramFiles, 'C:\\Program Files (x86)']) if (r) steamRoots.add(join(p, r, 'Steam'));
  const libs = new Set<string>();
  for (const s of steamRoots) {
    libs.add(s);
    const vdf = env.readText?.(join(p, s, 'steamapps', 'libraryfolders.vdf'));
    if (vdf) for (const l of parseSteamLibraries(vdf)) libs.add(l);
  }
  for (const lib of libs) out.push({ path: join(p, lib, 'steamapps', 'common', 'Blender', exeName(p)), source: 'steam', folderName: 'Blender' });
  // registry
  if (env.registryQuery) {
    for (const key of WINDOWS_REGISTRY_KEYS) {
      let text: string | undefined;
      try { text = await env.registryQuery(key); } catch { text = undefined; }
      if (text) for (const dir of parseRegistryInstallDirs(text)) out.push({ path: join(p, dir, exeName(p)), source: 'registry', folderName: dir.split(/[\\/]/).pop() });
    }
  }
  return out;
}

function posixCandidates(env: DetectEnv): Candidate[] {
  const out: Candidate[] = [];
  if (env.platform === 'darwin') {
    out.push({ path: '/Applications/Blender.app/Contents/MacOS/Blender', source: 'applications', folderName: 'Blender' });
    for (const d of env.readDir('/Applications')) if (/^Blender.*\.app$/i.test(d) && d !== 'Blender.app') out.push({ path: `/Applications/${d}/Contents/MacOS/Blender`, source: 'applications', folderName: d });
  }
  for (const p of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender', `${env.home}/.local/bin/blender`]) {
    out.push({ path: p, source: 'linux' });
  }
  for (const root of ['/opt', env.home, `${env.home}/Applications`, `${env.home}/Downloads`]) {
    for (const d of env.readDir(root)) if (/^blender/i.test(d)) out.push({ path: `${root}/${d}/blender`, source: 'linux', folderName: d });
  }
  for (const dir of (env.env.PATH ?? '').split(':').filter(Boolean)) out.push({ path: `${dir}/blender`, source: 'path' });
  return out;
}

function windowsPathCandidates(env: DetectEnv): Candidate[] {
  const out: Candidate[] = [];
  for (const dir of (env.env.PATH ?? env.env.Path ?? '').split(';').filter(Boolean)) out.push({ path: join('win32', dir, 'blender.exe'), source: 'path' });
  return out;
}

/** The override from config: a blender executable, or the folder that holds it. */
function overrideCandidates(env: DetectEnv, installPath: string): Candidate[] {
  const p = env.platform;
  const trimmed = installPath.trim().replace(/^"|"$/g, '');
  const folder = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const asFile = /blender(-launcher)?(\.exe)?$/i.test(trimmed) || /\.app\/Contents\/MacOS\/Blender$/i.test(trimmed);
  const list: Candidate[] = [];
  if (asFile) list.push({ path: trimmed, source: 'config', folderName: trimmed.replace(/[\\/][^\\/]+$/, '').split(/[\\/]/).pop() });
  else {
    list.push({ path: join(p, trimmed, exeName(p)), source: 'config', folderName: folder });
    if (p === 'darwin' || /\.app$/i.test(trimmed)) list.push({ path: `${trimmed.replace(/\/$/, '')}/Contents/MacOS/Blender`, source: 'config', folderName: folder });
  }
  return list;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------------------------------------

const keyOf = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

/**
 * Every Blender found, newest first. The version comes from `blender --version`; when that cannot run it comes from the folder name
 * and the entry is marked versionGuessed. The config override, when set and valid, is listed first regardless of version.
 */
export async function detectInstalls(env: DetectEnv, installPath?: string, managedPath?: string): Promise<BlenderInstall[]> {
  const cands: Candidate[] = [];
  if (installPath && installPath.trim()) cands.push(...overrideCandidates(env, installPath));
  // the copy Legion fetched itself (get-blender.ts); the caller has already checked that it sits inside Legion's own folder
  if (managedPath) cands.push({ path: managedPath, source: 'managed', folderName: 'Blender' });
  if (env.platform === 'win32') { cands.push(...await windowsCandidates(env)); cands.push(...windowsPathCandidates(env)); }
  else cands.push(...posixCandidates(env));

  const seen = new Set<string>();
  const found: BlenderInstall[] = [];
  for (const c of cands) {
    const k = keyOf(c.path);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!env.exists(c.path)) continue;
    // blender-launcher.exe starts Blender detached: no stdout, no exit code, so a headless run could never be read. Only the real executable counts.
    if (/blender-launcher(\.exe)?$/i.test(c.path.trim())) continue;
    let version: string | null = null;
    let guessed = false;
    const r = await env.run(c.path, ['--version'], 15_000).catch(() => null);
    // a build that exits 0 but prints nothing for --version is a launcher or a wrapper, not something whose output Legion can read
    if (r && r.code === 0 && !`${r.stdout}${r.stderr}`.trim()) continue;
    if (r && r.code === 0) version = parseVersionOutput(r.stdout);
    if (!version) { version = (c.folderName ? versionFromName(c.folderName) : null) ?? versionFromName(c.path); guessed = version !== null; }
    found.push({ path: c.path, version: version ?? '0.0.0', source: c.source, ...(guessed || !version ? { versionGuessed: true } : {}) });
  }
  // same version through two routes (registry and Program Files) collapses to the first
  const byVersionPath = new Map<string, BlenderInstall>();
  for (const f of found) if (!byVersionPath.has(keyOf(f.path))) byVersionPath.set(keyOf(f.path), f);
  const list = [...byVersionPath.values()];
  const override = installPath ? list.find((i) => i.source === 'config') : undefined;
  const managed = list.find((i) => i.source === 'managed' && i !== override);
  const rest = list.filter((i) => i !== override && i !== managed).sort((a, b) => compareVersions(b.version, a.version));
  return [...(override ? [override] : []), ...(managed ? [managed] : []), ...rest];
}

/** The install to use: the config override when it exists, else the copy Legion fetched itself, else the newest. */
export function pickInstall(installs: BlenderInstall[]): BlenderInstall | undefined {
  return installs.find((i) => i.source === 'config') ?? installs.find((i) => i.source === 'managed') ?? installs[0];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Backend choice
// ---------------------------------------------------------------------------------------------------------------------------------

export const COMMUNITY_MIN_VERSION = '3.0.0';

export interface BackendChoice { kind: BlenderBackendKind | null; reason: string }

export function chooseBackend(choice: BlenderBackendChoice, install: BlenderInstall | undefined): BackendChoice {
  if (!install) return { kind: null, reason: 'Blender was not found on this computer.' };
  const v = install.version;
  const guess = install.versionGuessed ? ' (from the folder name)' : '';
  if (choice === 'official') {
    return versionAtLeast(v, OFFICIAL_MIN_VERSION)
      ? { kind: 'official', reason: `You chose the official Blender Lab MCP, and Blender ${v}${guess} supports it.` }
      : { kind: null, reason: `The official Blender Lab MCP needs Blender ${OFFICIAL_MIN_VERSION} or newer; found ${v}${guess}. Pick the community backend or update Blender.` };
  }
  if (choice === 'community') {
    return versionAtLeast(v, COMMUNITY_MIN_VERSION)
      ? { kind: 'community', reason: `You chose the community Blender MCP (works with Blender ${COMMUNITY_MIN_VERSION}+; found ${v}${guess}).` }
      : { kind: null, reason: `The community Blender MCP needs Blender ${COMMUNITY_MIN_VERSION} or newer; found ${v}${guess}.` };
  }
  if (versionAtLeast(v, OFFICIAL_MIN_VERSION)) return { kind: 'official', reason: `Blender ${v}${guess} is ${OFFICIAL_MIN_VERSION}+, so the official Blender Lab MCP is used.` };
  if (versionAtLeast(v, COMMUNITY_MIN_VERSION)) return { kind: 'community', reason: `Blender ${v}${guess} is older than ${OFFICIAL_MIN_VERSION}, so the community MCP is used (it also covers asset downloads).` };
  return { kind: null, reason: `Blender ${v}${guess} is too old for either backend (need ${COMMUNITY_MIN_VERSION}+).` };
}
