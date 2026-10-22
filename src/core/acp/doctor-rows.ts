/**
 * The Doctor rows for the agent hosts (Hermes first). Plain words, no dashes, "your computer". The rows read what `detectAgent` found; a
 * Doctor pass always looks again (its words tell the owner to "check again" after an install), so it never reads the 10 minute cache.
 *
 * Colours: `ok: false` is red. `level: 'warn'` is amber and `level: 'neutral'` is "nothing to act on" (not installed, not checked, not readable);
 * a row with neither is plain. An amber row may carry a `fix`, which the window shows for it too.
 *
 * R34: the in-process Hermes path (a shared bare server name) is not supported, so no row here says anything about it working.
 */
import type { DoctorCheck } from '../../shared/types.js';
import { BUILTIN_HERMES, type AcpEntry } from '../../shared/acp-view.js';
import { ENV_KEEP_LABEL } from '../../shared/gates-registry.js';
import { SWITCH_COPY } from '../../shared/acp-copy.js';
import { containedStatus } from './contained.js';
import { SKIP_FLAGS, buildAgentEnv } from './process.js';
import { TESTED_HERMES, authFailureNoted, compareVersions, detectAgent, peekDetection, type AgentDetection, type AgentHostDeps } from './detect.js';
import { named } from './texts.js';

const APPROVALS_SMART = 'Hermes lets its own AI approve some commands before you see them.';
const APPROVALS_OFF = 'Hermes runs everything without asking you.';
const NEWER = 'Newer than the version Legion was tested with. It should work; tell us if it does not.';
const ADOPT_SETTING = 'auth.adopt_external_logins';
const SIGNIN_TEXT = `Hermes starts, but it could not sign in to a model provider when Legion ran it. If your provider key is in an environment variable, Legion does not pass names that look like keys, tokens or passwords on to Hermes (names that load code, such as PYTHONPATH, are not passed either). Add the variable's name, not its value, to "${ENV_KEEP_LABEL}" in Settings, then try again.`;

const quoted = (command: string): string => (/\s/.test(command) ? `"${command}"` : command);

function versionRow(entry: AcpEntry, base: string, d: AgentDetection): DoctorCheck {
  const id = `${base}-version`;
  const v = d.version;
  if (!v) return { id, label: `${entry.label} version`, ok: true, level: 'neutral', detail: 'Legion could not read the version.' };
  const label = `${entry.label} version ${v}`;
  if (entry.id !== BUILTIN_HERMES.id) return { id, label, ok: true, detail: 'Legion was not tested with this agent host.' };
  if (compareVersions(v, TESTED_HERMES.min) < 0) {
    return { id, label, ok: false, detail: `Older than the oldest version Legion works with (${TESTED_HERMES.min}).`, fix: 'Update Hermes, then check again.' };
  }
  if (compareVersions(v, TESTED_HERMES.testedWith) > 0) return { id, label, ok: true, level: 'warn', detail: NEWER };
  return { id, label, ok: true, detail: `Legion was tested with Hermes ${TESTED_HERMES.testedWith}.` };
}

/** Hermes reads these as on for 1, true, yes and on (utils.py is_truthy_value). */
const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());

/** The skip flags that would reach Hermes: set in the environment Legion starts it from (the strip switch applied), or in the entry's own env. */
function skipFlagsReaching(entry: AcpEntry, deps: AgentHostDeps): string[] {
  const env = buildAgentEnv({ base: deps.env ?? process.env, entryEnv: entry.env, stripSkipFlags: deps.stripSkipFlags?.() === true, envKeep: deps.envKeep?.() });
  return (SKIP_FLAGS as readonly string[]).filter((name) => Object.entries(env).some(([k, v]) => k.toUpperCase() === name && truthy(v)));
}

const SKIP_FIX = `Unset it in your environment, or turn on "${SWITCH_COPY.stripSkipFlags.label}" in Settings, Agent hosts.`;

function approvalsRow(entry: AcpEntry, base: string, d: AgentDetection, deps: AgentHostDeps): DoctorCheck {
  // Legion reads Hermes's settings only from Hermes: another agent host is never sent Hermes's commands
  if (entry.id !== BUILTIN_HERMES.id) return { id: `${base}-approvals`, label: `${entry.label} approvals`, ok: true, level: 'neutral', detail: 'Not checked. Legion does not read this setting from other agent hosts.' };
  const mode = d.approvalsMode ?? 'unknown';
  const id = `${base}-approvals`;
  // R72: a skip flag in the environment Hermes gets is read by Hermes before any setting, so the setting below can say "manual" while nothing asks
  const flags = skipFlagsReaching(entry, deps);
  if (flags.includes('HERMES_YOLO_MODE')) {
    return { id, label: `${entry.label} approvals: off (HERMES_YOLO_MODE)`, ok: false, detail: named(`${APPROVALS_OFF} HERMES_YOLO_MODE is set in the environment Legion starts Hermes with, and it skips every approval whatever Hermes's own setting says.`, entry.label), fix: SKIP_FIX };
  }
  const bypassing = flags.filter((f) => f === 'HERMES_SAFE_MODE' || f === 'HERMES_IGNORE_USER_CONFIG');
  if (bypassing.length) {
    return { id, label: `${entry.label} approvals: ${mode} (ignored)`, ok: true, level: 'warn', detail: named(`${bypassing.join(' and ')} ${bypassing.length > 1 ? 'are' : 'is'} set in the environment Legion starts Hermes with, so Hermes ignores your approval setting and your profile, including the Contained settings.`, entry.label), fix: SKIP_FIX };
  }
  const label = `${entry.label} approvals: ${mode}`;
  if (mode === 'unknown') return { id, label, ok: true, detail: 'Legion could not read this setting from Hermes.' };
  if (mode === 'off') return { id, label, ok: false, detail: named(APPROVALS_OFF, entry.label), fix: `${quoted(entry.command)} config set approvals.mode manual` };
  if (mode === 'smart') return { id, label, ok: true, level: 'warn', detail: named(APPROVALS_SMART, entry.label) };
  return { id, label, ok: true, detail: named('Hermes asks you before commands it marks as dangerous.', entry.label) };
}

async function containedRow(entry: AcpEntry, base: string, deps: AgentHostDeps): Promise<{ row: DoctorCheck; exists: boolean }> {
  const s = await containedStatus(entry, deps.run ? { run: deps.run } : undefined);
  const id = `${base}-contained`;
  const row = (r: Omit<DoctorCheck, 'id'>): { row: DoctorCheck; exists: boolean } => ({ row: { id, ...r }, exists: s.exists });
  if (!s.exists) return row({ label: 'Contained profile: not set up', ok: false, detail: s.detail });
  if (!s.policyOk) return row({ label: 'Contained profile: settings differ', ok: false, detail: s.detail });
  if (!s.signedIn) return row({ label: 'Contained profile: not signed in', ok: true, level: 'warn', detail: s.detail });
  return row({ label: 'Contained profile: ready', ok: true, detail: s.detail });
}

const NOT_YET = 'Not checked yet. Open the Doctor and choose Re-run checks to check it.';

/**
 * The rows for one entry. `probe`: look again now (starts the program). Otherwise nothing is started (R58): the rows come from a fresh earlier
 * check, or say "not checked yet". The window asks for the first only when the Doctor is opened or re-run.
 */
async function rowsFor(entry: AcpEntry, deps: AgentHostDeps, probe: boolean): Promise<DoctorCheck[]> {
  const base = `acp-${entry.id}`;
  const builtin = entry.id === BUILTIN_HERMES.id;
  const d = probe ? await detectAgent(entry, { ...deps, force: true }) : peekDetection(entry, deps.now);
  if (d.pending) {
    const rows: DoctorCheck[] = [{ id: base, label: `${entry.label}: found`, ok: true, detail: d.path ?? entry.command }, { id: `${base}-starts`, label: `${entry.label} starts`, ok: true, level: 'neutral', detail: NOT_YET }];
    if (entry.contained) rows.push({ id: `${base}-contained`, label: 'Contained profile: not checked yet', ok: true, level: 'neutral', detail: NOT_YET });
    return rows;
  }
  if (!d.checked) return [{ id: base, label: entry.label, ok: true, level: 'neutral', detail: `Not checked. ${entry.label} is switched off. Turn on "Offer Hermes in the model list" in Settings, Agent hosts, and Legion checks it.` }];
  if (!d.found) return [{ id: base, label: entry.label, ok: builtin, ...(builtin ? { level: 'neutral' as const } : {}), detail: d.detail }];
  const rows: DoctorCheck[] = [{ id: base, label: `${entry.label}: found`, ok: true, detail: d.path ?? entry.command }];
  if (!d.checkOk) {
    rows.push({ id: `${base}-starts`, label: `${entry.label} starts`, ok: false, detail: d.detail, ...(builtin ? { fix: `${quoted(entry.command)} ${[...entry.args, '--check'].join(' ')}` } : {}) });
    return rows;
  }
  rows.push({ id: `${base}-starts`, label: `${entry.label} starts`, ok: true, detail: 'Its start check passed.' });
  rows.push(versionRow(entry, base, d));
  // a Contained entry: the profile is looked at first. Before it is set up there is nothing to read approvals from, and the profile row says so.
  const contained = entry.contained && probe ? await containedRow(entry, base, deps) : undefined;
  if (!contained || contained.exists) rows.push(approvalsRow(entry, base, d, deps));
  // R50: only the owner's own Hermes. The Contained profile turns the borrowing off and its row checks that.
  if (builtin && !entry.contained && d.adoptExternalLogins === true) {
    rows.push({
      id: `${base}-logins`, label: 'Hermes shares your Claude Code login', ok: true, level: 'warn',
      detail: `Hermes may borrow your Claude Code login, and the two can then log each other out. To stop that, run the command below in a terminal, then check again. Legion never changes your Hermes settings itself.`,
      fix: `${quoted(entry.command)} config set ${ADOPT_SETTING} false`,
    });
  }
  // R27: a run that Hermes refused for a missing sign-in, while Hermes itself starts, usually means a key that lives in a variable Legion keeps back
  if (authFailureNoted(entry.id)) rows.push({ id: `${base}-signin`, label: `${entry.label} sign-in under Legion`, ok: false, detail: named(SIGNIN_TEXT, entry.label) });
  if (contained) rows.push(contained.row);
  else if (entry.contained) rows.push({ id: `${base}-contained`, label: 'Contained profile: not checked yet', ok: true, level: 'neutral', detail: NOT_YET }); // reading the profile starts Hermes
  return rows;
}

/** One entry's rows, or a failed row when looking at it threw. Looks again by default; `probe: false` starts nothing. */
export async function agentDoctorRows(entries: AcpEntry[], deps: AgentHostDeps, opts: { probe?: boolean } = {}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const entry of entries) {
    try {
      const rows = await rowsFor(entry, deps, opts.probe !== false);
      // A Claude-only user who happens to have Hermes installed gets no warning about it: the words stay, the colour and the count go.
      const quiet = deps.inUse !== undefined && !entry.contained && !deps.inUse(entry.id);
      out.push(...(quiet ? rows.map((r): DoctorCheck => ({ ...r, ok: true, level: 'neutral' })) : rows));
    } catch (e) {
      out.push({ id: `acp-${entry.id}`, label: entry.label, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
