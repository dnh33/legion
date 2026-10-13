/**
 * The shell the agent shell tool runs its commands in, named to the agent and to the safety floor.
 *
 * On Windows that is Git Bash when Git for Windows is installed: agents write POSIX shell, the floor reads it as sh (as
 * it does Claude Code's own Bash tool), and Git Bash is what Claude Code itself uses there. Without Git it is cmd.exe,
 * named as such, and a multi-line command is refused: cmd runs only the first line and exits 0, while the floor reads
 * every line. Elsewhere it is /bin/sh, as Node runs it.
 *
 * Found once per process, in this order: LEGION_GIT_BASH (a bash.exe path, or "off" for cmd.exe), then
 * CLAUDE_CODE_GIT_BASH_PATH (the owner's Claude Code setting), then the Git whose git.exe is on PATH, then the standard
 * install folders. System32's bash.exe is the WSL launcher, not Git Bash, and is never used.
 *
 * Measured on Git for Windows 2.55 (2026-10-13), and the reasons for how a command is started:
 *  - The command text goes to bash in an environment variable, read by `eval`, not as a `-c` argument: on the Windows
 *    command line MSYS turns `\\` into `\` (`\\server\share` arrives as `\server\share`), so bash would run other text
 *    than the floor read. The variable is unset before the command runs, so nothing the command starts sees it.
 *  - usr\bin\bash.exe is started directly, with what Git's bin\bash.exe wrapper adds (MINGW64 and its PATH), so the
 *    process Node knows is bash itself. A background job (`sleep 60 &`) leaves the Windows process tree, so taskkill /T
 *    misses it and it holds the output open; bash's own process group still holds it, and is killed by that.
 *  - MSYS_NO_PATHCONV and MSYS2_ARG_CONV_EXCL stop MSYS rewriting arguments that look like paths (`cmd /c`, `tasklist
 *    /FO`); Windows programs then take C:/ paths, which the tool description says.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { ShellKind } from './shell-floor.js';

export type AgentShell =
  | { kind: 'git-bash'; root: string; bash: string }
  | { kind: 'cmd' }
  | { kind: 'sh' };

/** The environment variable the command text travels in (see the header); unset before the command runs. */
const COMMAND_VAR = '__LEGION_SHELL_COMMAND';

interface Probe { env: Record<string, string | undefined>; isFile: (p: string) => boolean }

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/** The env value under any spelling of its name (Windows names ignore case). */
const envGet = (env: Record<string, string | undefined>, name: string): string | undefined => {
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === name && v) return v;
  return undefined;
};

/**
 * The Git for Windows root a bash.exe path belongs to, when it is a real Git Bash: `<root>\bin\bash.exe` (the wrapper) or
 * `<root>\usr\bin\bash.exe`, with the MSYS tools the shell tool needs beside it. Never one under the Windows folder
 * (System32\bash.exe starts WSL) or WindowsApps.
 */
function gitRootOf(bashPath: string, probe: Probe): string | undefined {
  const p = win32.normalize(bashPath.trim().replace(/^"(.*)"$/, '$1'));
  if (win32.basename(p).toLowerCase() !== 'bash.exe') return undefined;
  if (/\\(windows|winnt)\\|\\windowsapps\\/i.test(`${p}\\`)) return undefined;
  const dir = win32.dirname(p);
  const root = /\\usr\\bin$/i.test(dir) ? win32.dirname(win32.dirname(dir)) : /\\bin$/i.test(dir) ? win32.dirname(dir) : undefined;
  if (!root) return undefined;
  const usr = win32.join(root, 'usr', 'bin');
  return ['bash.exe', 'ps.exe', 'kill.exe'].every((f) => probe.isFile(win32.join(usr, f))) ? root : undefined;
}

/** Git Bash's root on this Windows machine, or undefined (none found, or turned off with LEGION_GIT_BASH=off). */
export function findGitBash(probe: Probe = { env: process.env, isFile }): string | undefined {
  const own = envGet(probe.env, 'LEGION_GIT_BASH');
  if (own && /^(off|cmd|none|false|0)$/i.test(own.trim())) return undefined;
  const named = [own, envGet(probe.env, 'CLAUDE_CODE_GIT_BASH_PATH')].filter((s): s is string => !!s);
  // the git the owner actually runs: <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe
  const onPath = (envGet(probe.env, 'PATH') ?? '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    .filter((d) => probe.isFile(win32.join(d, 'git.exe')))
    .map((d) => win32.join(/\\mingw64\\bin\\?$/i.test(d) ? win32.dirname(win32.dirname(d.replace(/\\$/, ''))) : win32.dirname(d.replace(/\\$/, '')), 'bin', 'bash.exe'));
  const installed = ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)'].map((v) => envGet(probe.env, v.toUpperCase()))
    .concat([envGet(probe.env, 'LOCALAPPDATA') && win32.join(envGet(probe.env, 'LOCALAPPDATA')!, 'Programs')])
    .filter((s): s is string => !!s).map((d) => win32.join(d, 'Git', 'bin', 'bash.exe'));
  for (const c of [...named, ...onPath, ...installed]) { const root = gitRootOf(c, probe); if (root) return root; }
  return undefined;
}

/** The shell for a platform and probe (for tests); `agentShell()` is this machine's. */
export function pickAgentShell(platform: NodeJS.Platform, probe?: Probe): AgentShell {
  if (platform !== 'win32') return { kind: 'sh' };
  const root = findGitBash(probe);
  return root ? { kind: 'git-bash', root, bash: win32.join(root, 'usr', 'bin', 'bash.exe') } : { kind: 'cmd' };
}

let mine: AgentShell | undefined;
/** This machine's agent shell, found once. */
export function agentShell(): AgentShell { return (mine ??= pickAgentShell(process.platform)); }

/** How the safety floor reads a command for this shell: Git Bash is sh, as Claude Code's Bash tool is. */
export const floorShell = (s: AgentShell): ShellKind => (s.kind === 'cmd' ? 'cmd' : 'sh');

/** The shell tool's description: which shell, its syntax, and what does not carry over between calls. */
export function shellToolDescription(s: AgentShell): string {
  const tail = 'Each call starts a fresh shell: cd and variables do not carry over (use the cwd argument). A short timeout is enforced; the command is killed with everything it started if it overruns.';
  if (s.kind === 'git-bash') return `Run a command in Git Bash (bash on Windows; not cmd.exe or PowerShell) and return its exit code and output. Use bash syntax. Windows programs take paths as C:/Users/name (forward slashes); bash itself also reads /c/Users/name. ${tail}`;
  if (s.kind === 'cmd') return `Run a command in cmd.exe (Windows Command Prompt; Git for Windows is not installed, so there is no bash) and return its exit code and output. Use cmd syntax: & or && to chain, %NAME% for variables. One line only: cmd runs just the first line of a multi-line command, so a command with a line break is refused; chain with & or write a script file and run it. ${tail}`;
  return `Run a command in /bin/sh (POSIX shell) and return its exit code and output. ${tail}`;
}

/** Why a command cannot run in this shell as written, or undefined. cmd.exe runs only the first line of several. */
export function shellRefusal(s: AgentShell, command: string): string | undefined {
  if (s.kind === 'cmd' && /[\r\n]/.test(command.trim())) return 'Not run: this agent\'s shell is cmd.exe (Git for Windows is not installed), which runs only the first line of a multi-line command. Join the lines with & (or && to stop at the first failure), or write the lines to a .cmd file with write_file and run that file. Installing Git for Windows gives agents bash.';
  return undefined;
}

/** How to start a command in this shell: the program, its arguments, and the environment to add. */
export function shellLaunch(s: AgentShell, command: string, env: Record<string, string | undefined>): { file: string; args: string[]; shell: boolean; env: Record<string, string | undefined> } {
  if (s.kind !== 'git-bash') return { file: command, args: [], shell: true, env };
  const out: Record<string, string | undefined> = {};
  let pathKey = 'PATH';
  for (const [k, v] of Object.entries(env)) { if (k.toUpperCase() === 'PATH') { pathKey = k; continue; } out[k] = v; }
  // what Git's bin\bash.exe wrapper adds, so bash finds its own tools (ls, grep, git) first
  out[pathKey] = [win32.join(s.root, 'mingw64', 'bin'), win32.join(s.root, 'usr', 'bin'), envGet(env, 'PATH')].filter(Boolean).join(';');
  out.MSYSTEM ??= 'MINGW64';
  out.MSYS_NO_PATHCONV = '1';
  out.MSYS2_ARG_CONV_EXCL = '*';
  out[COMMAND_VAR] = command;
  return { file: s.bash, args: ['-c', `__c=$${COMMAND_VAR}; unset ${COMMAND_VAR}; eval "$__c"`], shell: false, env: out };
}

/**
 * Kill bash's own process group, which holds what a command left running in the background (out of reach of taskkill
 * /T). Only when the process Node started leads its group, so no other group is ever hit. Windows Git Bash only.
 */
export function killShellGroup(s: AgentShell, winPid: number): void {
  if (s.kind !== 'git-bash') return;
  const bin = win32.join(s.root, 'usr', 'bin');
  const ps = spawnSync(win32.join(bin, 'ps.exe'), ['-W'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const r = line.trim().split(/\s+/);
    if (/^[A-Z]$/.test(r[0] ?? '')) r.shift(); // a status letter before the PID
    // PID PPID PGID WINPID ...
    if (r[3] !== String(winPid) || !/^\d+$/.test(r[0] ?? '') || r[0] !== r[2]) continue;
    spawnSync(win32.join(bin, 'kill.exe'), ['-9', '--', `-${r[2]}`], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    return;
  }
}

/** For tests: the variable the command travels in. */
export const SHELL_COMMAND_VAR = COMMAND_VAR;
