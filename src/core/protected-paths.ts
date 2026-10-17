// Protected paths: a write to Git internals and hooks, editor and agent settings, shell startup files or package manager
// settings always asks in Ask, Accept edits and Smart (never in Bypass). A change there can run code the next time Git or a
// shell starts, or change what an agent may do. The list follows the permission-modes documentation of Claude Code:
// https://code.claude.com/docs/en/permission-modes#protected-paths

/** File tools that put a run's content on disk, and the input field that names the file. */
export const WRITE_FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
/** Legion's own file tool: protected paths cover it too (it is kept apart from WRITE_FILE_TOOLS, which other checks share). */
const OWN_WRITE_FILE_TOOLS: Record<string, string> = { mcp__host__write_file: 'path' };

/** Folder names: a path with one of these as a whole segment is protected. */
export const PROTECTED_DIRS: readonly string[] = [
  '.git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.claude', '.codex', '.agents', '.aws', '.config/git',
];
/** File names (the last segment): protected wherever the file sits. */
export const PROTECTED_FILES: readonly string[] = [
  '.gitconfig', '.gitmodules',
  '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.profile', '.envrc',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml',
  '.bazelrc', '.bazelversion', '.bazeliskrc',
  '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml',
  'gradle-wrapper.properties', 'maven-wrapper.properties', '.devcontainer.json', '.ripgreprc', 'pyrightconfig.json', '.mcp.json', '.claude.json',
];

const SHELL = new Set(['Bash', 'PowerShell', 'Monitor', 'mcp__host__shell']);
const HOOK_CFG = /\bcore\.(hookspath|fsmonitor)\b/i;
const DIR_SET: ReadonlySet<string> = new Set(PROTECTED_DIRS.filter((d) => !d.includes('/')));
const FILE_SET: ReadonlySet<string> = new Set(PROTECTED_FILES);

/** The protected name a path hits (whole segments, either slash, any case), or undefined. */
export function protectedHit(p: string): string | undefined {
  const segs = p.replace(/\\/g, '/').toLowerCase().split('/').filter((s) => s !== '');
  const last = segs.length - 1;
  for (let i = 0; i <= last; i++) {
    const s = segs[i]!;
    if (s === '.claude') {
      // Exceptions: the worktrees folder, and notes (.md) in the agent-memory folder
      if (segs[i + 1] === 'worktrees') continue;
      if (segs[i + 1] === 'agent-memory' && segs[last]!.endsWith('.md')) continue;
    }
    if (DIR_SET.has(s)) return s;
    if (s === '.config' && segs[i + 1] === 'git') return '.config/git';
  }
  return segs.length > 0 && FILE_SET.has(segs[last]!) ? segs[last] : undefined;
}

/**
 * The protected name a tool call would change, or undefined. A file-write tool: its target (`resolveTarget` turns it into the
 * path to test; the engine makes it relative to the agent's folder). A shell tool: (a) `git` naming core.hooksPath or core.fsmonitor
 * hits `.git` at any level, (b) else at `shellLevel` 2 or more any word that is a protected path hits. Gaps: a path built by a variable
 * or a glob, and a program that writes a file the command does not name.
 */
export function protectedWriteHit(toolName: string, input: Record<string, unknown>, shellLevel: number, resolveTarget?: (target: string) => string): string | undefined {
  const field = WRITE_FILE_TOOLS[toolName] ?? OWN_WRITE_FILE_TOOLS[toolName];
  if (field) { const t = input[field]; return typeof t === 'string' ? protectedHit(resolveTarget ? resolveTarget(t) : t) : undefined; }
  if (!SHELL.has(toolName)) return undefined;
  const c = typeof input.command === 'string' ? input.command : '';
  if (/\bgit\b/i.test(c) && HOOK_CFG.test(c)) return '.git';
  if (shellLevel < 2) return undefined;
  for (const tok of c.split(/[\s"'`;|&<>()=]+/)) { const h = tok ? protectedHit(tok) : undefined; if (h) return h; }
  return undefined;
}
