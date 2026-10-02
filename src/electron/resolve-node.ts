/**
 * Which `node` starts the core. LEGION_NODE wins (the user's own choice); then Legion's own runtime that setup downloaded into
 * <app root>/runtime/node (only when its ownership marker is there and node.exe exists); then plain `node` from PATH.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const RUNTIME_MARKER = '.legion-owned';

export function resolveNodeBin(root: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (env.LEGION_NODE) return env.LEGION_NODE;
  const dir = join(root, 'runtime', 'node');
  const exe = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  if (exists(join(dir, RUNTIME_MARKER)) && exists(exe)) return exe;
  return 'node';
}
