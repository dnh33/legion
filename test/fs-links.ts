/**
 * Link creation for the security tests that plant a link and check the product refuses to follow it.
 * Windows only lets an unprivileged process create junctions (directory links); file symlinks need Developer Mode or an elevated shell
 * (EPERM otherwise). So a directory link is a junction there, and a failed creation is reported instead of thrown: the caller skips
 * only that step, with a reason, and still runs every assertion that does not need the link.
 */
import { linkSync, symlinkSync } from 'node:fs';

export interface LinkResult { ok: boolean; reason?: string }

export function tryLink(target: string, path: string, kind: 'file' | 'dir'): LinkResult {
  try {
    if (process.platform === 'win32') symlinkSync(target, path, kind === 'dir' ? 'junction' : 'file');
    else symlinkSync(target, path);
    return { ok: true };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, reason: `cannot create a ${kind} link here (${err.code ?? err.message}): needs symlink privilege (Windows Developer Mode or an elevated shell)` };
  }
}

/**
 * A file "link" for a write-through test. Falls back to a HARD link where file symlinks are not allowed (Windows without privilege):
 * a product that writes into the existing file in place would change the victim through either kind, one that replaces the file
 * (temp + rename) leaves it alone. Returns null when neither can be made.
 */
export function tryFileLinkOrHard(target: string, path: string): { kind: 'symlink' | 'hardlink' } | null {
  if (tryLink(target, path, 'file').ok) return { kind: 'symlink' };
  try { linkSync(target, path); return { kind: 'hardlink' }; } catch { return null; }
}
