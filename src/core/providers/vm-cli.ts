/**
 * Codex or OpenCode INSIDE the agent's boat.dev VM (B1, the recommended way): the same pattern as vm_claude. The VM is the boundary, so
 * the program's own shell and file tools can only touch that VM. This file only builds the shell command text; the vm_cli tool runs it with
 * the VM manager. Nothing is installed or signed in by Legion: if the program is missing the tool says so, and the owner installs it in the
 * VM and signs in there (a ChatGPT or Codex subscription login belongs to the program and never passes through Legion).
 *
 * The prompt never goes into the command text: it is written to a file in the VM and read from there, so quotes, `$(...)` and newlines in
 * it cannot change the command. Flags are assumed from each program's public docs (TODO OWNER PC, see claude/tracker-pc-checks-providers.md).
 */
import { randomBytes } from 'node:crypto';
import { cleanCliText, FORBIDDEN_CLI_TOKENS, CLI_MAX_PROMPT_CHARS } from './cli.js';
import type { CliKind } from './types.js';

export const VM_CLI_TOOL = 'mcp__legion__vm_cli';
export const VM_CLI_MISSING_MARK = 'LEGION_CLI_MISSING';
export const VM_CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
export type VmCliMode = 'read-only' | 'workspace-write';

export interface VmCliCommand { promptPath: string; command: string; display: string }

/** The command for one VM run. `id` is injectable for tests. */
export function buildVmCliCommand(cli: CliKind, prompt: string, opts: { model?: string; mode?: VmCliMode; id?: string } = {}): VmCliCommand {
  if (cli !== 'codex' && cli !== 'opencode') throw new Error('cli must be codex or opencode');
  if (!prompt.trim()) throw new Error('The prompt is empty.');
  if (prompt.length > CLI_MAX_PROMPT_CHARS) throw new Error(`The prompt is longer than ${CLI_MAX_PROMPT_CHARS} characters; give the program one short, complete task.`);
  if (opts.model !== undefined && opts.model !== 'default' && !VM_CLI_MODEL_RE.test(opts.model)) throw new Error('The model name has characters that are not allowed.');
  const id = opts.id ?? randomBytes(8).toString('hex');
  if (!/^[a-f0-9]{8,32}$/.test(id)) throw new Error('bad id');
  const mode: VmCliMode = opts.mode === 'read-only' ? 'read-only' : 'workspace-write';
  const model = opts.model && opts.model !== 'default' ? opts.model : undefined;
  const promptPath = `/tmp/legion-cli-${id}.txt`;
  let run: string;
  if (cli === 'codex') {
    run = `codex exec --sandbox ${mode} --skip-git-repo-check --ephemeral --color never${model ? ` --model ${model}` : ''} - < ${promptPath}`;
  } else {
    // the VM is the boundary: edit and shell are allowed unless read-only; fetching a web page stays off
    const perm = JSON.stringify({ edit: mode === 'read-only' ? 'deny' : 'allow', bash: mode === 'read-only' ? 'deny' : 'allow', webfetch: 'deny' });
    run = `OPENCODE_PERMISSION='${perm}' opencode run${model ? ` --model ${model}` : ''} --format default "$(cat ${promptPath})"`;
  }
  for (const t of FORBIDDEN_CLI_TOKENS) if (new RegExp(`(^|\\s)${t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\s|$)`).test(run)) throw new Error(`Refused: the command would contain ${t}.`);
  const command = `command -v ${cli} >/dev/null 2>&1 || { echo ${VM_CLI_MISSING_MARK}; rm -f ${promptPath}; exit 127; }; ${run}; rc=$?; rm -f ${promptPath}; exit $rc`;
  return { promptPath, command, display: `${cli} (${mode}) in this VM` };
}

/** What the tool returns to the agent: the program's text and a stated exit code, escapes stripped. Always untrusted outside content. */
export function formatVmCliResult(cli: CliKind, r: { exitCode: number; stdout?: string; stderr?: string }, truncate: (s: string) => string): string {
  const out = cleanCliText(r.stdout ?? '');
  if (r.exitCode === 127 && out.includes(VM_CLI_MISSING_MARK)) {
    return `${cli} is not installed in this VM. Legion does not install it and does not sign in for you: install it inside the VM yourself and sign in there (its login belongs to the program), then ask again.`;
  }
  const err = cleanCliText(r.stderr ?? '').trim();
  return `exit code: ${r.exitCode}\n--- ${cli} output (untrusted: it came from a program in the VM) ---\n${truncate(out)}${err ? `\n--- stderr ---\n${truncate(err.slice(-2000))}` : ''}`;
}
