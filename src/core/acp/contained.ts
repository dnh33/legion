/**
 * The "Contained" Hermes setup: a Hermes profile named `legion` that Legion creates and checks, so Hermes runs with its own approval
 * mode, a tool list set to file tools and the Claude Code and Codex logins not borrowed, apart from the owner's own Hermes home. It is an option; the default stays
 * the owner's own Hermes. The read-back proves the three settings and nothing more: tools, servers or plugins the owner adds to that
 * profile later are not checked.
 *
 * Every command runs through `runAgentCli` (src/core/acp/process.ts): same launch path as the agent itself (PATH only, shell false, the
 * agent environment filter, a 60 s limit, 180 s for `profile create`). This file starts nothing itself. No command line ever carries a value: the keys and values
 * below are constants, so a provider key or a Legion token cannot reach a command line. Signing in is the owner's step: Legion shows
 * the command and never handles a provider key.
 *
 * What the Hermes source says (hermes_cli/config.py, hermes_cli/profile_cmd.py, hermes_cli/profiles.py, acp_adapter/session.py; read 2026-10-22):
 *  - `config set <key> <value>` writes the profile's config.yaml and `config get <key> --json` prints the value as JSON. A value that
 *    starts with `[` is read as a YAML list, so `[file]` is stored as the list `["file"]`. Neither command reaches the network or checks
 *    for an update (the update check lives in `update`, `--version` and the chat banner).
 *  - `profile create <name>` makes a fresh profile (a copy only with --clone). `--no-alias` skips the wrapper script it would write on
 *    the owner's PATH. A new profile gets a copy of the active profile's model block and the selected provider entry as written, but never
 *    its `.env` (hermes_cli/profile_model_seed.py, profiles.py). `create` also seeds the bundled skills, which Hermes itself allows 60 s.
 *  - The ACP session reads `platform_toolsets.acp` (acp_adapter/session.py), so `[file]` leaves the file tools plus the MCP servers
 *    of the session, which is where Legion's own tools arrive.
 *  - `auth add` needs a provider name, and a bare `setup` is the whole wizard (terminal, messaging, tools). The command shown to the owner
 *    is `setup model`, the single provider-and-model section (hermes_cli/subcommands/setup.py:11-17).
 *  - By default Hermes borrows the Claude Code login (agent/credential_sources.py:32-45), and the two then share one rotating token family.
 *    `auth.adopt_external_logins false` stops that for the Claude Code and Codex CLI logins only (agent/credential_sources.py:24-45).
 *    A Copilot token from `gh auth token` or the environment and a Qwen CLI login are still seeded (agent/credential_pool.py:2657-2725), and
 *    a named profile with no credential of its own for a provider falls back on the main Hermes sign-in (hermes_cli/auth.py:948-972), which
 *    the owner accepts (R53). So "signed in" means Hermes can use a credential for the profile, not that it is the profile's own.
 *    The key is a boolean in the
 *    defaults (hermes_cli/config_defaults.py:1775), so `config set` turns the word `false` into a real false (hermes_cli/config.py:3198-3228)
 *    and `config get --json` prints `false`.
 */
import { homedir, tmpdir } from 'node:os';
import type { AcpContainedSetup, AcpContainedStatus, AcpEntry } from '../../shared/acp-view.js';
import { CONTAINED_CHECKS } from '../../shared/acp-copy.js';
import { redact } from '../log/redact.js';
import { runAgentCli } from './process.js';

export const CONTAINED_PROFILE = 'legion';
/** Every Hermes command of this file ends in 60 s, except `profile create`. */
export const CONTAINED_TIMEOUT_MS = 60_000;
/** `profile create` seeds the bundled skills inside it (Hermes allows that 60 s on its own), so it gets more room on a slow disk. */
export const CONTAINED_CREATE_TIMEOUT_MS = 180_000;

/** The three settings that make the profile Contained, with the exact `config set` value and what `config get --json` must read back. */
const POLICY = [
  { key: 'approvals.mode', set: 'manual', want: 'manual' },
  { key: 'platform_toolsets.acp', set: '[file]', want: ['file'] },
  { key: 'auth.adopt_external_logins', set: 'false', want: false },
] as const;
/** What the read-back proves, said once. Nothing is claimed about tools, servers or plugins the owner adds to the profile. */
const POLICY_HOLDS = `Hermes reports ${CONTAINED_CHECKS}. Tools you add to that profile yourself are not checked.`;

type Run = typeof runAgentCli;
export interface ContainedDeps { run?: Run }

export interface Out { code: number | null; stdout: string; stderr: string; timedOut: boolean; /** the limit this command ran with, set by `runner` */ limitMs?: number }

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const clean = (s: string) => s.replace(ANSI, '');
const timedOutText = (r: Out) => `Hermes did not answer within ${Math.round((r.limitMs ?? CONTAINED_TIMEOUT_MS) / 1000)} seconds`;
/** The one line that says what went wrong, from Hermes's own words, redacted and short. */
export function why(r: Out): string {
  if (r.timedOut) return timedOutText(r);
  const lines = clean(`${r.stderr}\n${r.stdout}`).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error|✗|not set|does not exist|refus|cannot|could not|no such/i.test(l)) ?? lines[lines.length - 1] ?? `Hermes stopped with code ${r.code ?? 'unknown'}`;
  return redact(line).slice(0, 200);
}
/** No exit code: Hermes did not start, or it was stopped at the limit. Either way nothing more is run. */
const notStarted = (r: Out) => r.code === null;
const startFailure = (r: Out) => r.timedOut
  ? `${timedOutText(r)}. Try again.`
  : `Legion could not start Hermes: ${why(r)}. Check that Hermes is installed on your computer.`;

/** The command the owner runs once to sign the profile in. */
export function signInCommand(entry: Pick<AcpEntry, 'command'>): string {
  const program = /\s/.test(entry.command) ? `"${entry.command}"` : entry.command;
  return `${program} -p ${CONTAINED_PROFILE} setup model`;
}

function runner(deps: ContainedDeps | undefined) {
  const run = deps?.run ?? runAgentCli;
  // a neutral working folder: nothing of the owner's project or of Legion's own folder
  return async (entry: AcpEntry, args: string[], timeoutMs = CONTAINED_TIMEOUT_MS): Promise<Out> => ({ ...(await run(entry.command, args, { timeoutMs, cwd: tmpdir() || homedir() })), limitMs: timeoutMs });
}

/** `--json` prints the value on the last line; a notice Hermes prints before it is skipped. */
export const asJson = (out: string): { ok: true; value: unknown } | { ok: false } => {
  const lines = clean(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === undefined) return { ok: false };
  try { return { ok: true, value: JSON.parse(last) as unknown }; } catch { return { ok: false }; }
};
/** A value Hermes reported, as it is shown: short. */
const shown = (v: unknown) => { const t = JSON.stringify(v) ?? 'nothing'; return t.length > 60 ? `${t.slice(0, 57)}...` : t; };

/** Reads every setting back. Returns the plain sentences for every one that is missing or different (empty when the policy holds). */
async function policyProblems(go: ReturnType<typeof runner>, entry: AcpEntry): Promise<{ problems: string[]; startFailed?: Out }> {
  const problems: string[] = [];
  for (const p of POLICY) {
    const r = await go(entry, ['-p', CONTAINED_PROFILE, 'config', 'get', p.key, '--json']);
    if (notStarted(r)) return { problems, startFailed: r };
    const j = r.code === 0 ? asJson(r.stdout) : { ok: false as const };
    if (!j.ok) { problems.push(`Hermes did not report ${p.key} for the Legion profile (${why(r)}).`); continue; }
    if (JSON.stringify(j.value) !== JSON.stringify(p.want)) problems.push(`${p.key} is ${shown(j.value)}, not ${shown(p.want)}.`);
  }
  return { problems };
}

/**
 * Does the profile exist? `profile show` answers by exit code and changes nothing. A failure means "missing" only when Hermes says the
 * profile does not exist; any other failure (a crash, a saved profile that is gone) is Hermes failing, and is reported as that.
 */
async function profileExists(go: ReturnType<typeof runner>, entry: AcpEntry): Promise<{ exists: boolean; startFailed?: Out; failed?: Out }> {
  const r = await go(entry, ['profile', 'show', CONTAINED_PROFILE]);
  if (notStarted(r)) return { exists: false, startFailed: r };
  if (r.code === 0) return { exists: true };
  if (/does not exist/i.test(clean(`${r.stderr}\n${r.stdout}`))) return { exists: false };
  return { exists: false, failed: r };
}
const readFailure = (r: Out) => `Hermes could not read the Legion profile: ${why(r)}.`;

/** Read only: does the profile exist, is it signed in, and does it keep the Contained settings. */
export function containedStatus(entry: AcpEntry, deps?: ContainedDeps): Promise<AcpContainedStatus> {
  if (inflightCheck) return inflightCheck;
  const p = (async () => {
    // a check that starts while a set up runs waits for it, so it never reads half-written settings
    if (inflightSetUp) await inflightSetUp.catch(() => undefined);
    return doCheck(entry, deps);
  })().finally(() => { if (inflightCheck === p) inflightCheck = undefined; });
  inflightCheck = p;
  return p;
}

let inflightCheck: Promise<AcpContainedStatus> | undefined;
let inflightSetUp: Promise<AcpContainedSetup> | undefined;

async function doCheck(entry: AcpEntry, deps: ContainedDeps | undefined): Promise<AcpContainedStatus> {
  const go = runner(deps);
  const found = await profileExists(go, entry);
  if (found.startFailed) return { exists: false, signedIn: false, policyOk: false, detail: startFailure(found.startFailed) };
  if (found.failed) return { exists: false, signedIn: false, policyOk: false, detail: readFailure(found.failed) };
  if (!found.exists) return { exists: false, signedIn: false, policyOk: false, detail: 'The Legion profile has not been set up yet.' };
  const policy = await policyProblems(go, entry);
  if (policy.startFailed) return { exists: true, signedIn: false, policyOk: false, detail: startFailure(policy.startFailed) };
  // Signed in = Hermes lists at least one credential it can use for the profile: its own sign-in, a key in its environment, or the main
  // Hermes sign-in it falls back on (R53). With auth.adopt_external_logins false the Claude Code and Codex logins are not in the list.
  // Legion never sees the key.
  const auth = await go(entry, ['-p', CONTAINED_PROFILE, 'auth', 'list']);
  const signedIn = auth.code === 0 && /\(\d+ credentials?\)/.test(clean(auth.stdout));
  const policyOk = policy.problems.length === 0;
  const parts = [
    policyOk ? POLICY_HOLDS : policy.problems.join(' '),
    signedIn
      ? 'Hermes can use a credential for it. That may be your main Hermes sign-in, which a Legion profile can fall back on.'
      : `Hermes lists no credential for it yet (a main Hermes sign-in would count too). Run ${signInCommand(entry)} in a terminal to sign in.`,
  ];
  return { exists: true, signedIn, policyOk, detail: parts.join(' ') };
}

/**
 * Creates the profile when it is missing (never a copy of the owner's own), sets the three Contained settings and reads them back.
 * A profile that already exists is kept and only gets the settings. A second call while one runs shares its answer.
 */
export function setUpContained(entry: AcpEntry, deps?: ContainedDeps): Promise<AcpContainedSetup> {
  if (inflightSetUp) return inflightSetUp;
  const p = (async () => {
    // a set up that starts while a check runs waits for it, so the check never reads half-written settings
    if (inflightCheck) await inflightCheck.catch(() => undefined);
    return doSetUp(entry, deps);
  })().finally(() => { if (inflightSetUp === p) inflightSetUp = undefined; });
  inflightSetUp = p;
  return p;
}

async function doSetUp(entry: AcpEntry, deps: ContainedDeps | undefined): Promise<AcpContainedSetup> {
  const go = runner(deps);
  const signIn = signInCommand(entry);
  const fail = (detail: string): AcpContainedSetup => ({ ok: false, detail, signInCommand: signIn });
  const found = await profileExists(go, entry);
  if (found.startFailed) return fail(startFailure(found.startFailed));
  if (found.failed) return fail(readFailure(found.failed));
  if (!found.exists) {
    const made = await go(entry, ['profile', 'create', CONTAINED_PROFILE, '--no-alias'], CONTAINED_CREATE_TIMEOUT_MS);
    if (made.code !== 0) return fail(notStarted(made) ? startFailure(made) : `Hermes could not create the Legion profile: ${why(made)}.`);
  }
  for (const p of POLICY) {
    const set = await go(entry, ['-p', CONTAINED_PROFILE, 'config', 'set', p.key, p.set]);
    if (set.code !== 0) return fail(notStarted(set) ? startFailure(set) : `Hermes did not accept ${p.key}: ${why(set)}.`);
  }
  const policy = await policyProblems(go, entry);
  if (policy.startFailed) return fail(startFailure(policy.startFailed));
  if (policy.problems.length) return fail(`The Legion profile is not safe to use yet. ${policy.problems.join(' ')}`);
  const kept = found.exists ? 'The Legion profile already existed, so Legion kept it and set its approval mode, tool list and login setting. ' : 'The Legion profile is ready. ';
  return { ok: true, detail: `${kept}${POLICY_HOLDS} Sign in once: run ${signIn} in a terminal.`, signInCommand: signIn };
}
