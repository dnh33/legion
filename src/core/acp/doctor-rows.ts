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
import { containedStatus } from './contained.js';
import { TESTED_HERMES, authFailureNoted, compareVersions, detectAgent, type AgentDetection, type AgentHostDeps } from './detect.js';
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

function approvalsRow(entry: AcpEntry, base: string, d: AgentDetection): DoctorCheck {
  // Legion reads Hermes's settings only from Hermes: another agent host is never sent Hermes's commands
  if (entry.id !== BUILTIN_HERMES.id) return { id: `${base}-approvals`, label: `${entry.label} approvals`, ok: true, level: 'neutral', detail: 'Not checked. Legion does not read this setting from other agent hosts.' };
  const mode = d.approvalsMode ?? 'unknown';
  const id = `${base}-approvals`;
  const label = `${entry.label} approvals: ${mode}`;
  if (mode === 'unknown') return { id, label, ok: true, detail: 'Legion could not read this setting from Hermes.' };
  if (mode === 'off') return { id, label, ok: false, detail: named(APPROVALS_OFF, entry.label), fix: `${quoted(entry.command)} config set approvals.mode manual` };
  if (mode === 'smart') return { id, label, ok: true, level: 'warn', detail: named(APPROVALS_SMART, entry.label) };
  return { id, label, ok: true, detail: named('Hermes asks you before it runs a command.', entry.label) };
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

/** The rows for one entry. */
async function rowsFor(entry: AcpEntry, deps: AgentHostDeps): Promise<DoctorCheck[]> {
  const base = `acp-${entry.id}`;
  const builtin = entry.id === BUILTIN_HERMES.id;
  const d = await detectAgent(entry, { ...deps, force: true });
  if (!d.checked) return [{ id: base, label: entry.label, ok: true, level: 'neutral', detail: `Not checked. ${entry.label} is switched off. Switch it on in Settings, Agent hosts, and Legion checks it.` }];
  if (!d.found) return [{ id: base, label: entry.label, ok: builtin, ...(builtin ? { level: 'neutral' as const } : {}), detail: d.detail }];
  const rows: DoctorCheck[] = [{ id: base, label: `${entry.label}: found`, ok: true, detail: d.path ?? entry.command }];
  if (!d.checkOk) {
    rows.push({ id: `${base}-starts`, label: `${entry.label} starts`, ok: false, detail: d.detail, ...(builtin ? { fix: `${quoted(entry.command)} ${[...entry.args, '--check'].join(' ')}` } : {}) });
    return rows;
  }
  rows.push({ id: `${base}-starts`, label: `${entry.label} starts`, ok: true, detail: 'Its start check passed.' });
  rows.push(versionRow(entry, base, d));
  // a Contained entry: the profile is looked at first. Before it is set up there is nothing to read approvals from, and the profile row says so.
  const contained = entry.contained ? await containedRow(entry, base, deps) : undefined;
  if (!contained || contained.exists) rows.push(approvalsRow(entry, base, d));
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
  return rows;
}

/** One entry's rows, or a failed row when looking at it threw. */
export async function agentDoctorRows(entries: AcpEntry[], deps: AgentHostDeps): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const entry of entries) {
    try {
      out.push(...await rowsFor(entry, deps));
    } catch (e) {
      out.push({ id: `acp-${entry.id}`, label: entry.label, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
