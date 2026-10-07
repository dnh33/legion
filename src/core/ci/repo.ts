/**
 * Which GitHub repository and branch the CI panel shows. Read with Node's fs from the project folder's .git (never a child process: the
 * tripwire lists the only files that may spawn one). Handles a normal clone and a linked worktree (a `.git` file pointing at the real one).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface RepoRef { owner: string; name: string }

const PART = /^[A-Za-z0-9._-]{1,100}$/;
export function validRepoPart(s: unknown): s is string {
  return typeof s === 'string' && PART.test(s) && s !== '.' && s !== '..';
}
export function validRepo(r: unknown): r is RepoRef {
  return !!r && typeof r === 'object' && validRepoPart((r as RepoRef).owner) && validRepoPart((r as RepoRef).name);
}
/** "owner/name" as the port takes it: each part [A-Za-z0-9._-]+, and neither part is "." or "..". */
export function validRepoString(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)) return false;
  const [a, b] = s.split('/');
  return validRepoPart(a) && validRepoPart(b);
}
export const repoKey = (r: RepoRef): string => `${r.owner}/${r.name}`;
/** "owner/name" typed by the owner. */
export function parseRepoText(text: unknown): RepoRef | null {
  if (typeof text !== 'string') return null;
  const m = /^\s*([^/\s]+)\/([^/\s]+)\s*$/.exec(text);
  if (!m) return null;
  const r = { owner: m[1]!, name: m[2]!.replace(/\.git$/i, '') };
  return validRepo(r) ? r : null;
}
/** A branch name as git allows it, restricted to what is safe in a query string and a log line. */
export const validBranch = (b: unknown): b is string => typeof b === 'string' && /^[A-Za-z0-9._\/-]{1,200}$/.test(b) && !b.includes('..');

/** github.com remotes only: https, ssh (`git@github.com:o/r.git`) and `ssh://` forms. Credentials in the URL are ignored, never kept. */
export function parseRemoteUrl(url: string): RepoRef | null {
  const u = url.trim();
  let m = /^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) m = /^(?:ssh:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const r = { owner: m[1]!, name: m[2]! };
  return validRepo(r) ? r : null;
}

const readText = (p: string, max = 262_144): string | null => {
  try { const s = statSync(p); if (!s.isFile() || s.size > max) return null; return readFileSync(p, 'utf8'); } catch { return null; }
};

/** Finds the git directory for a folder (looking up to 8 parents). `commonDir` holds config and refs; for a worktree it differs from `gitDir`. */
export function findGit(folder: string): { gitDir: string; commonDir: string } | null {
  let dir = isAbsolute(folder) ? folder : resolve(folder);
  for (let i = 0; i < 9; i++) {
    const dot = join(dir, '.git');
    if (existsSync(dot)) {
      let gitDir: string | null = null;
      try {
        const st = statSync(dot);
        if (st.isDirectory()) gitDir = dot;
        else if (st.isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readText(dot, 4096) ?? '');
          if (m) gitDir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(dir, m[1]!.trim());
        }
      } catch { /* fall through */ }
      if (!gitDir) return null;
      const cd = readText(join(gitDir, 'commondir'), 1024)?.trim();
      return { gitDir, commonDir: cd ? (isAbsolute(cd) ? cd : resolve(gitDir, cd)) : gitDir };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** `url` of one remote from a git config file's text. */
export function remoteUrlFromConfig(config: string, remote: string): string | null {
  let inside = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { inside = sec[1]!.replace(/\s+/g, ' ').toLowerCase() === `remote "${remote}"`; continue; }
    if (inside) { const kv = /^url\s*=\s*(.+)$/i.exec(line); if (kv) return kv[1]!.trim(); }
  }
  return null;
}

export interface RepoInfo { repo: RepoRef | null; branch: string | null }

/** The repo from `origin` (then `cloud`) and the checked-out branch (null when detached). */
export function readRepoInfo(folder: string): RepoInfo {
  const g = findGit(folder);
  if (!g) return { repo: null, branch: null };
  let repo: RepoRef | null = null;
  const cfg = readText(join(g.commonDir, 'config'));
  if (cfg) for (const remote of ['origin', 'cloud']) {
    const url = remoteUrlFromConfig(cfg, remote);
    const r = url ? parseRemoteUrl(url) : null;
    if (r) { repo = r; break; }
  }
  const head = readText(join(g.gitDir, 'HEAD'), 4096)?.trim() ?? '';
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return { repo, branch: m && validBranch(m[1]) ? m[1]! : null };
}
