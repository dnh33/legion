/**
 * Which `node` starts the core. LEGION_NODE wins (the user's own choice); then Legion's own runtime that setup downloaded into
 * <app root>/runtime/node (only when its ownership marker is there and node.exe exists); then plain `node` from PATH.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUNTIME_MARKER = '.legion-owned';

export function resolveNodeBin(root: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (env.LEGION_NODE) return env.LEGION_NODE;
  const dir = join(root, 'runtime', 'node');
  const exe = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  if (exists(join(dir, RUNTIME_MARKER)) && exists(exe)) return exe;
  return 'node';
}

export const PACKAGE_ELECTRON = ['runtime', 'electron', 'electron.exe'] as const;
export interface CoreLaunch { cmd: string; /** Added to the child's environment ONLY (never to this process). */ env: Record<string, string>; mode: 'env' | 'runtime' | 'package' | 'path' }

/** True for a prebuilt package install: build-info.json says package for win32-x64 AND the bundled electron.exe is there. */
export function isPackageInstall(root: string, exists: (p: string) => boolean = existsSync, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): boolean {
  if (!exists(join(root, ...PACKAGE_ELECTRON))) return false;
  try {
    const j = JSON.parse(read(join(root, 'build-info.json'))) as { kind?: unknown; platform?: unknown };
    return j.kind === 'package' && j.platform === 'win32-x64';
  } catch { return false; }
}

/**
 * How the core is started. Order: LEGION_NODE (the user's own choice) -> Legion's own downloaded runtime/node -> a prebuilt package's own Electron
 * in node mode (ELECTRON_RUN_AS_NODE=1, set for the child only) -> `node` from PATH. A source install behaves exactly as before.
 */
export function resolveCoreLaunch(root: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, read?: (p: string) => string): CoreLaunch {
  if (env.LEGION_NODE) return { cmd: env.LEGION_NODE, env: {}, mode: 'env' };
  const own = resolveNodeBin(root, {}, exists);
  if (own !== 'node') return { cmd: own, env: {}, mode: 'runtime' };
  if (isPackageInstall(root, exists, read)) return { cmd: join(root, ...PACKAGE_ELECTRON), env: { ELECTRON_RUN_AS_NODE: '1' }, mode: 'package' };
  return { cmd: 'node', env: {}, mode: 'path' };
}

/** What to tell the person when the core could not be started with this launch. */
export function coreStartHint(mode: CoreLaunch['mode'], code?: string): string {
  if (mode === 'package') {
    return `Legion's own runtime (${PACKAGE_ELECTRON.join('\\')}) could not start${code ? ` (${code})` : ''}. Windows or your antivirus may have blocked or removed it: open Windows Security > Virus & threat protection > Protection history, restore or allow the file, then run setup again. Legion does not retry by itself.`;
  }
  return 'Node.js 20.10+ not found. Run setup.cmd again (it can install Node for Legion), or: winget install OpenJS.NodeJS.LTS (or set LEGION_NODE).';
}

/** The environment for a process that starts the core from inside Electron's node mode (the stdio proxy): the child must stay in node mode too. */
export function coreChildEnv(env: NodeJS.ProcessEnv, versions: NodeJS.ProcessVersions = process.versions): NodeJS.ProcessEnv {
  return versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : { ...env };
}
