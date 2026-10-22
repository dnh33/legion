/**
 * The "Contained" Hermes setup: a Hermes profile named `legion` that Legion creates and checks, so Hermes runs with its own approval
 * mode and only file tools, apart from the owner's own Hermes home. It is an option; the default stays the owner's own Hermes.
 *
 * Every command runs through `runAgentCli` (src/core/acp/process.ts): same launch path as the agent itself (PATH only, shell false, the
 * agent environment filter, a 60 s limit). This file starts nothing itself. No command line ever carries a value: the keys and values
 * below are constants, so a provider key or a Legion token cannot reach a command line. Signing in is the owner's step: Legion shows
 * the command and never handles a provider key.
 *
 * What the Hermes source says (hermes_cli/config.py, hermes_cli/profile_cmd.py, hermes_cli/profiles.py, acp_adapter/session.py; read 2026-10-22):
 *  - `config set <key> <value>` writes the profile's config.yaml and `config get <key> --json` prints the value as JSON. A value that
 *    starts with `[` is read as a YAML list, so `[file]` is stored as the list `["file"]`. Neither command reaches the network or checks
 *    for an update (the update check lives in `update`, `--version` and the chat banner).
 *  - `profile create <name>` makes a fresh profile (a copy only with --clone). `--no-alias` skips the wrapper script it would write on
 *    the owner's PATH. A new profile gets a copy of the model name and provider of the active profile, never a key.
 *  - The ACP session reads `platform_toolsets.acp` (acp_adapter/session.py), so `[file]` leaves the file tools plus the MCP servers
 *    of the session, which is where Legion's own tools arrive.
 *  - `auth add` needs a provider name, so the command shown to the owner is `setup`, which asks for the provider, the key and the model.
 */
import { homedir, tmpdir } from 'node:os';
import type { AcpContainedSetup, AcpContainedStatus, AcpEntry } from '../../shared/acp-view.js';
import { redact } from '../log/redact.js';
import { runAgentCli } from './process.js';

export const CONTAINED_PROFILE = 'legion';
/** Every Hermes command of this file ends in 60 s. */
export const CONTAINED_TIMEOUT_MS = 60_000;

/** The two settings that make the profile Contained, with the exact `config set` value and what `config get --json` must read back. */
const POLICY = [
  { key: 'approvals.mode', set: 'manual', want: 'manual' },
  { key: 'platform_toolsets.acp', set: '[file]', want: ['file'] },
] as const;

type Run = typeof runAgentCli;
export interface ContainedDeps { run?: Run }

interface Out { code: number | null; stdout: string; stderr: string; timedOut: boolean }

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const clean = (s: string) => s.replace(ANSI, '');
/** The one line that says what went wrong, from Hermes's own words, redacted and short. */
function why(r: Out): string {
  if (r.timedOut) return 'Hermes did not answer within 60 seconds';
  const lines = clean(`${r.stderr}\n${r.stdout}`).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error|✗|not set|does not exist|refus|cannot|could not|no such/i.test(l)) ?? lines[lines.length - 1] ?? `Hermes stopped with code ${r.code ?? 'unknown'}`;
  return redact(line).slice(0, 200);
}
/** No exit code: Hermes did not start, or it was stopped at the limit. Either way nothing more is run. */
const notStarted = (r: Out) => r.code === null;
const startFailure = (r: Out) => r.timedOut
  ? 'Hermes did not answer within 60 seconds. Try again.'
  : `Legion could not start Hermes: ${why(r)}. Check that Hermes is installed on your computer.`;

/** The command the owner runs once to sign the profile in. */
export function signInCommand(entry: Pick<AcpEntry, 'command'>): string {
  const program = /\s/.test(entry.command) ? `"${entry.command}"` : entry.command;
  return `${program} -p ${CONTAINED_PROFILE} setup`;
}

function runner(deps: ContainedDeps | undefined) {
  const run = deps?.run ?? runAgentCli;
  // a neutral working folder: nothing of the owner's project or of Legion's own folder
  return (entry: AcpEntry, args: string[]) => run(entry.command, args, { timeoutMs: CONTAINED_TIMEOUT_MS, cwd: tmpdir() || homedir() });
}

const asJson = (out: string): { ok: true; value: unknown } | { ok: false } => {
  const first = clean(out).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (first === undefined) return { ok: false };
  try { return { ok: true, value: JSON.parse(first) as unknown }; } catch { return { ok: false }; }
};

/** Reads both settings back. Returns the plain sentences for every one that is missing or different (empty when the policy holds). */
async function policyProblems(go: ReturnType<typeof runner>, entry: AcpEntry): Promise<{ problems: string[]; startFailed?: Out }> {
  const problems: string[] = [];
  for (const p of POLICY) {
    const r = await go(entry, ['-p', CONTAINED_PROFILE, 'config', 'get', p.key, '--json']);
    if (notStarted(r)) return { problems, startFailed: r };
    const j = r.code === 0 ? asJson(r.stdout) : { ok: false as const };
    if (!j.ok) { problems.push(`Hermes did not report ${p.key} for the Legion profile (${why(r)}).`); continue; }
    if (JSON.stringify(j.value) !== JSON.stringify(p.want)) problems.push(`${p.key} is ${JSON.stringify(j.value)}, not ${JSON.stringify(p.want)}.`);
  }
  return { problems };
}

/** Does the profile exist? `profile show` answers by exit code and changes nothing. */
async function profileExists(go: ReturnType<typeof runner>, entry: AcpEntry): Promise<{ exists: boolean; startFailed?: Out }> {
  const r = await go(entry, ['profile', 'show', CONTAINED_PROFILE]);
  if (notStarted(r)) return { exists: false, startFailed: r };
  return { exists: r.code === 0 };
}

/** Read only: does the profile exist, is it signed in, and does it keep the Contained settings. */
export async function containedStatus(entry: AcpEntry, deps?: ContainedDeps): Promise<AcpContainedStatus> {
  const go = runner(deps);
  const found = await profileExists(go, entry);
  if (found.startFailed) return { exists: false, signedIn: false, policyOk: false, detail: startFailure(found.startFailed) };
  if (!found.exists) return { exists: false, signedIn: false, policyOk: false, detail: 'The Legion profile has not been set up yet.' };
  const policy = await policyProblems(go, entry);
  if (policy.startFailed) return { exists: true, signedIn: false, policyOk: false, detail: startFailure(policy.startFailed) };
  // Signed in = Hermes lists at least one credential for the profile (its own sign-in or a key in its environment). Legion never sees the key.
  const auth = await go(entry, ['-p', CONTAINED_PROFILE, 'auth', 'list']);
  const signedIn = auth.code === 0 && /\(\d+ credentials?\)/.test(clean(auth.stdout));
  const policyOk = policy.problems.length === 0;
  const parts = [
    policyOk ? 'The Legion profile asks before it runs a command and has only file tools.' : policy.problems.join(' '),
    signedIn ? 'It is signed in.' : `It is not signed in yet. Run ${signInCommand(entry)} in a terminal.`,
  ];
  return { exists: true, signedIn, policyOk, detail: parts.join(' ') };
}

let inflight: Promise<AcpContainedSetup> | undefined;

/**
 * Creates the profile when it is missing (never a copy of the owner's own), sets the two Contained settings and reads them back.
 * A profile that already exists is kept and only gets the settings. A second call while one runs shares its answer.
 */
export function setUpContained(entry: AcpEntry, deps?: ContainedDeps): Promise<AcpContainedSetup> {
  if (inflight) return inflight;
  const p = doSetUp(entry, deps).finally(() => { if (inflight === p) inflight = undefined; });
  inflight = p;
  return p;
}

async function doSetUp(entry: AcpEntry, deps: ContainedDeps | undefined): Promise<AcpContainedSetup> {
  const go = runner(deps);
  const signIn = signInCommand(entry);
  const fail = (detail: string): AcpContainedSetup => ({ ok: false, detail, signInCommand: signIn });
  const found = await profileExists(go, entry);
  if (found.startFailed) return fail(startFailure(found.startFailed));
  if (!found.exists) {
    const made = await go(entry, ['profile', 'create', CONTAINED_PROFILE, '--no-alias']);
    if (made.code !== 0) return fail(notStarted(made) ? startFailure(made) : `Hermes could not create the Legion profile: ${why(made)}.`);
  }
  for (const p of POLICY) {
    const set = await go(entry, ['-p', CONTAINED_PROFILE, 'config', 'set', p.key, p.set]);
    if (set.code !== 0) return fail(notStarted(set) ? startFailure(set) : `Hermes did not accept ${p.key}: ${why(set)}.`);
  }
  const policy = await policyProblems(go, entry);
  if (policy.startFailed) return fail(startFailure(policy.startFailed));
  if (policy.problems.length) return fail(`The Legion profile is not safe to use yet. ${policy.problems.join(' ')}`);
  const kept = found.exists ? 'The Legion profile already existed, so Legion kept it and set its approval mode and tools. ' : 'The Legion profile is ready. ';
  return { ok: true, detail: `${kept}It asks before it runs a command and has only file tools. Sign in once: run ${signIn} in a terminal.`, signInCommand: signIn };
}
