/**
 * CLI agents (Codex, OpenCode) on this computer: the owner-enabled, per-agent, off-by-default way to run one of those programs.
 * This file builds the command and decides whether a run may start; it starts no process itself (proc.ts does, through a port).
 *
 * What Legion can and cannot promise here, in plain words (also shown to the owner): the program runs its OWN shell and file tools
 * inside its own process. Legion sees only the start, the text it prints and the end, so it cannot see or stop an individual action. The
 * sandbox or permission flag below is that program's promise, not a Legion control. Legion's per-tool approval cards and taint tracking do
 * not apply inside it; Legion marks the whole run tainted and treats its output as outside content. A ChatGPT or Codex subscription login
 * belongs to the program: the owner signs in outside Legion, and Legion never reads, copies, logs or passes on that login.
 *
 * Every flag below is ASSUMED from each program's public documentation and could not be run here: TODO OWNER PC (see
 * claude/tracker-pc-checks-providers.md). Flags that widen what the program may do are never built; test/providers-cli.test.ts holds that.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ProcessPort, Platform } from './proc.js';
import { scrubbedEnv } from './proc.js';
import type { CliKind, CliSandbox, ProviderEntry, ProviderHost, ProviderRunResult } from './types.js';

export const CLI_MAX_PROMPT_CHARS = 20_000;
export const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;
export const CLI_MAX_TEXT_CHARS = 60_000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** Flags and words that would widen the program's reach. A built command line holding one is refused (second layer behind the builder). */
export const FORBIDDEN_CLI_TOKENS = [
  '--dangerously-bypass-approvals-and-sandbox', '--dangerously_bypass_approvals_and_sandbox', '--full-auto', '--yolo', '--auto',
  '--add-dir', '--search', '--bypass_hook_trust', '--bypass-hook-trust', 'danger-full-access', '--config', '-c', '--profile', '--attach', '--share', '--password',
  '--ask-for-approval', '-a',
];

export interface CliPlan {
  /** Arguments after the program. */
  args: string[];
  /** Text written to stdin (Codex reads the prompt there), or undefined. */
  stdin?: string;
  /** Environment names Legion adds on top of the allowed list (never read from the owner's environment). */
  envExtra: Record<string, string>;
  /** The command as the start card shows it: the prompt is replaced by a placeholder. */
  display: string;
  sandboxFlags: string[];
}

export function cliModel(model: string): string | undefined {
  const m = model.trim();
  if (!m || m === 'default') return undefined;
  if (!MODEL_RE.test(m)) throw new Error('The model name for this CLI has characters that are not allowed.');
  return m;
}

/** The command for one run. Throws when the prompt or model cannot be passed safely. */
export function buildCliPlan(entry: ProviderEntry, model: string, prompt: string, cwd: string): CliPlan {
  const kind = entry.cli as CliKind | undefined;
  const sandbox: CliSandbox = entry.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only';
  if (!kind) throw new Error('This provider has no CLI set.');
  if (!prompt.trim()) throw new Error('The prompt is empty.');
  if (prompt.length > CLI_MAX_PROMPT_CHARS) throw new Error(`The prompt is longer than ${CLI_MAX_PROMPT_CHARS} characters; a CLI run takes one short, complete task.`);
  const m = cliModel(model);
  let args: string[]; let stdin: string | undefined; const envExtra: Record<string, string> = {}; let sandboxFlags: string[]; let shown: string[];
  if (kind === 'codex') {
    // codex exec: the sandbox flag is the strictest one the program offers for the chosen mode; no approval, search or network flag is passed
    sandboxFlags = ['--sandbox', sandbox];
    args = ['exec', ...sandboxFlags, '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--color', 'never', ...(m ? ['--model', m] : []), '-'];
    stdin = prompt;
    shown = args;
  } else {
    // opencode run: it has no OS sandbox flag; its permission config is passed inline through OPENCODE_PERMISSION (edit and shell denied for read-only)
    const perm = { edit: sandbox === 'workspace-write' ? 'allow' : 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' };
    envExtra.OPENCODE_PERMISSION = JSON.stringify(perm);
    sandboxFlags = [`OPENCODE_PERMISSION=${envExtra.OPENCODE_PERMISSION}`];
    args = ['run', '--dir', cwd, ...(m ? ['--model', m] : []), '--format', 'default', prompt];
    shown = ['run', '--dir', cwd, ...(m ? ['--model', m] : []), '--format', 'default', `<your prompt: ${prompt.length} characters>`];
  }
  for (const a of args) if (a !== prompt && FORBIDDEN_CLI_TOKENS.includes(a)) throw new Error(`Refused: the command would contain ${a}.`);
  if (/^-/.test(prompt) && kind === 'opencode') throw new Error('A prompt for this CLI cannot start with a dash.');
  return { args, ...(stdin !== undefined ? { stdin } : {}), envExtra, display: [entry.executable ?? kind, ...shown].join(' '), sandboxFlags };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Environment: only what the program needs to find ITS OWN login and run. Never an API key, token or Legion value.
// ---------------------------------------------------------------------------------------------------------------------------------

const COMMON_POSIX = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
const COMMON_WIN = ['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PROGRAMFILES', 'PROCESSOR_ARCHITECTURE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
/** The program's own config-home variable: how it finds its login. */
const OWN_HOME: Record<CliKind, string[]> = { codex: ['CODEX_HOME'], opencode: [] };
/** Even if a name above ever matched one of these, it is dropped. */
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|BEARER/i;

export function cliEnvAllow(kind: CliKind, platform: Platform = process.platform): string[] {
  return [...(platform === 'win32' ? COMMON_WIN : COMMON_POSIX), ...OWN_HOME[kind]].filter((n) => !SECRETISH.test(n));
}
export function cliEnv(kind: CliKind, extra: Record<string, string>, source: Record<string, string | undefined> = process.env, platform: Platform = process.platform): Record<string, string> {
  return scrubbedEnv(source, cliEnvAllow(kind, platform), extra, platform);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Working folder: the agent's own workspace, never the home folder, a filesystem root, Legion's data folder or the Legion repo
// ---------------------------------------------------------------------------------------------------------------------------------

export interface FolderCtx { home: string; workspaceDir: string; dataDir?: string; appRoots?: string[] }
const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child: string, parent: string): boolean => { const c = norm(child); const p = norm(parent); return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep); };

/** The real path to run in, or the reason it is refused. */
export function checkCliFolder(cwd: string, ctx: FolderCtx): { ok: true; dir: string } | { ok: false; reason: string } {
  if (!cwd || /[\0\r\n]/.test(cwd)) return { ok: false, reason: 'the working folder is not valid' };
  let real: string;
  try { real = realpathSync(resolve(cwd)); } catch { return { ok: false, reason: 'the working folder does not exist' }; }
  try { if (!statSync(real).isDirectory()) return { ok: false, reason: 'the working folder is not a folder' }; } catch { return { ok: false, reason: 'the working folder cannot be read' }; }
  if (dirname(real) === real) return { ok: false, reason: 'the working folder is a drive or filesystem root' };
  const real_ = (p: string): string => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };
  const home = real_(ctx.home);
  if (inside(home, real)) return { ok: false, reason: 'the working folder is your home folder or a folder that contains it' };
  const ws = real_(ctx.workspaceDir);
  if (ctx.dataDir) {
    const data = real_(ctx.dataDir);
    if (inside(real, data) && !(inside(real, ws) && norm(real) !== norm(ws))) return { ok: false, reason: 'the working folder is inside Legion\'s own data folder' };
    if (inside(data, real)) return { ok: false, reason: 'the working folder contains Legion\'s own data folder' };
  }
  for (const root of ctx.appRoots ?? []) { const r = real_(root); if (inside(real, r) || inside(r, real)) return { ok: false, reason: 'the working folder is, or contains, the Legion program folder' }; }
  if (existsSync(join(real, 'src', 'core', 'engine.ts')) && existsSync(join(real, 'docs', 'ARCHITECTURE.md'))) return { ok: false, reason: 'the working folder looks like the Legion source folder' };
  return { ok: true, dir: real };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------------------

export interface CliRunDeps {
  port: ProcessPort;
  folder: FolderCtx;
  redact(s: string): string;
  /** Tests only. */
  source?: Record<string, string | undefined>;
  platform?: Platform;
}

/** Control characters and terminal escape sequences out: the text is shown as a message and handed to other agents. */
export function cleanCliText(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '').replace(/\u001b./g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').replace(/\r\n?/g, '\n');
}

const fail = (errorText: string): ProviderRunResult => ({ subtype: 'error_during_execution', isError: true, errorText, turns: 0, usageUnknown: true });

export async function runCli(host: ProviderHost, providerId: string, entry: ProviderEntry, model: string, deps: CliRunDeps): Promise<ProviderRunResult> {
  const label = entry.label;
  if (entry.kind !== 'cli' || !entry.cli || !entry.executable) return fail('This provider is not a CLI.');
  // 1. who may start it: only the owner, in the app (never a bot, a room wake, ask/tell or a token client)
  if (host.ownerStarted !== true) return fail(`"${label}" runs a program on this computer outside Legion's controls, so only you can start it, in the Legion app. A bot, a room, ask/tell or an MCP client cannot.`);
  // 2. which agents: only the ones the owner enabled for it
  if (!host.agentId || !(entry.allowedAgents ?? []).includes(host.agentId)) return fail(`"${label}" is not enabled for this agent. Enable it for the agent in Settings, Providers (it asks you to confirm).`);
  // 3. working folder
  const folder = checkCliFolder(host.cwd ?? '', deps.folder);
  if (!folder.ok) return fail(`Not started: ${folder.reason}. Give this agent its own working folder.`);
  // 4. the program itself
  try { if (!statSync(entry.executable).isFile()) throw new Error('not a file'); } catch { return fail(`Not started: the program "${entry.executable}" was not found. Check the path in Settings, Providers.`); }
  let plan: CliPlan;
  try { plan = buildCliPlan(entry, model, host.prompt, folder.dir); } catch (e) { return fail(`Not started: ${e instanceof Error ? e.message : 'the command could not be built'}`); }
  host.markTainted?.();
  // 5. the start card, every run, in every approval mode
  let approved = false;
  try { approved = host.confirmStart ? await host.confirmStart({
    title: `Start ${entry.cli === 'codex' ? 'Codex' : 'OpenCode'} on this computer`,
    command: plan.display, folder: folder.dir, sandbox: entry.sandbox ?? 'read-only', sandboxFlags: plan.sandboxFlags, timeoutSeconds: entry.timeoutSeconds ?? 900,
    prompt: host.prompt.slice(0, 600),
    warning: 'This program runs its own shell and file tools. Legion cannot see or stop its individual actions, and the sandbox is the program\'s own promise. The whole run is treated as untrusted outside content.',
  }) : false; } catch { return fail('The start card could not be shown, so nothing was started.'); }
  if (host.cancelled()) return { subtype: 'cancelled', isError: false, turns: 0, usageUnknown: true };
  if (!approved) return fail('You did not approve starting the program, so nothing was started.');
  // 6. run
  const env = cliEnv(entry.cli, plan.envExtra, deps.source ?? process.env, deps.platform);
  let r: Awaited<ReturnType<ProcessPort['run']>>;
  try {
    r = await deps.port.run(entry.executable, {
      args: plan.args, cwd: folder.dir, env, maxOutputBytes: CLI_MAX_OUTPUT_BYTES, timeoutMs: (entry.timeoutSeconds ?? 900) * 1000,
      ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}), signal: host.signal,
    });
  } catch { return fail('The program could not be run.'); }
  if (r.stoppedBy === 'cancelled' || host.cancelled()) return { subtype: 'cancelled', isError: false, turns: 1, usageUnknown: true };
  const text = deps.redact(cleanCliText(r.stdout)).trim().slice(0, CLI_MAX_TEXT_CHARS);
  if (text) host.onAssistantText(text);
  if (r.error && !r.stoppedBy) return { ...fail(`The program could not be started: ${deps.redact(r.error).slice(0, 200)}`), ...(text ? { resultText: text } : {}) };
  if (r.stoppedBy === 'timeout') return { subtype: 'error_timeout', isError: true, errorText: `Stopped: the program ran past its ${entry.timeoutSeconds ?? 900} second limit and Legion ended it and everything it had started.`, turns: 1, usageUnknown: true, ...(text ? { resultText: text } : {}) };
  if (r.stoppedBy === 'output limit') return { subtype: 'error_output_limit', isError: true, errorText: `Stopped: the program printed more than ${CLI_MAX_OUTPUT_BYTES} bytes and Legion ended it and everything it had started.`, turns: 1, usageUnknown: true, ...(text ? { resultText: text } : {}) };
  if (r.code !== 0) {
    const tail = deps.redact(cleanCliText(r.stderr)).trim().slice(-400);
    return { subtype: 'error_during_execution', isError: true, errorText: `The program ended with an error (exit ${r.code ?? r.signal ?? 'unknown'}).${tail ? ' ' + tail : ''}`, turns: 1, usageUnknown: true, ...(text ? { resultText: text } : {}) };
  }
  if (!text) return { ...fail('The program finished but printed no text.'), turns: 1 };
  void providerId;
  return { subtype: 'success', isError: false, turns: 1, usageUnknown: true, resultText: text };
}
