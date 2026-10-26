/**
 * Hermes detection and the Doctor rows (src/core/acp/detect.ts, src/core/acp/doctor-rows.ts, the Doctor and the catalog).
 * A fake `hermes` (test/acp-fake-hermes.ts) is the only program on PATH, so the owner's real Hermes is never found, let alone run. Its
 * log holds every argument list, so a test can say exactly what Legion ran.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import { forgetLegionSecrets, registerLegionSecrets } from '../src/core/acp/process.js';
import { BUILTIN_HERMES, type AcpEntry } from '../src/shared/acp-view.js';
import { usesAgentHost } from '../src/shared/runtime.js';
import { ENV_KEEP_LABEL } from '../src/shared/gates-registry.js';
import {
  CHECK_TIMEOUT_MS, DETECT_TTL_MS, TESTED_HERMES, agentWaits, detectAgent, forgetDetections, hostWaitSeams, noteAgentVersion, noteAuthFailure, peekDetection, warmHermes,
} from '../src/core/acp/detect.js';
import { agentDoctorRows } from '../src/core/acp/doctor-rows.js';
import { MAX_CARD_WAIT_MS, permissionWaitOf, toolWaitOf } from '../src/core/acp/run-helpers.js';
import { runDoctor } from '../src/core/doctor.js';
import { getCatalog } from '../src/core/catalog.js';
import { defaultConfig } from '../src/shared/config.js';
import type { QueryFn } from '../src/core/engine.js';

const WIN = process.platform === 'win32';
const FAKE = fileURLToPath(new URL('./acp-fake-hermes.js', import.meta.url));
const LEGION_TOKEN = 'legion-token-0123456789abcdef';
const LEAK = 'zz9-leaky-value-0123456789abcdef';

const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined) => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};
let binDir = '';
let emptyDir = '';
let state = '';
let dataDir = '';
let log = '';
let seen = '';
let clock = 1_000_000;
const now = () => clock;

before(() => {
  binDir = tempDir('acp-doctor-bin-');
  emptyDir = tempDir('acp-doctor-empty-');
  // a private copy: a rebuild of dist/ while a batch runs must not change the program the tests start
  const fake = join(binDir, 'acp-fake-hermes.mjs');
  copyFileSync(FAKE, fake);
  if (WIN) writeFileSync(join(binDir, 'hermes.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else { writeFileSync(join(binDir, 'hermes'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); chmodSync(join(binDir, 'hermes'), 0o755); }
  // the fake is the only program on PATH: the owner's own Hermes can never be found
  setEnv('PATH', binDir);
  registerLegionSecrets([LEGION_TOKEN]);
});
after(() => {
  forgetLegionSecrets();
  forgetDetections();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => {
  forgetDetections();
  state = tempDir('acp-doctor-state-');
  dataDir = tempDir('acp-doctor-data-');
  log = join(state, 'calls.log');
  seen = join(state, 'seen.log');
  writeFileSync(log, '');
  writeFileSync(seen, '');
  clock = 1_000_000;
  setEnv('PATH', binDir);
  setEnv('FAKE_HERMES_STATE', state);
  setEnv('FAKE_HERMES_LOG', log);
  setEnv('FAKE_HERMES_SEEN', seen);
  setEnv('FAKE_HERMES_HANDSHAKE', '1');
  for (const n of ['FAKE_HERMES_CHECK_FAIL', 'FAKE_HERMES_VERSION', 'FAKE_HERMES_GARBAGE', 'FAKE_HERMES_NOISE']) setEnv(n, undefined);
});

const calls = (): string[][] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
const homes = (): string[] => readFileSync(seen, 'utf8').split('\n').filter(Boolean);
/** The owner's own Hermes home in the fake: flat config keys, as JSON values. */
const ownConfig = (cfg: Record<string, unknown>) => {
  mkdirSync(join(state, 'profiles', '__home__'), { recursive: true });
  writeFileSync(join(state, 'profiles', '__home__', 'config.json'), JSON.stringify(cfg));
};
const profileConfig = (cfg: Record<string, unknown>) => {
  mkdirSync(join(state, 'profiles', 'legion'), { recursive: true });
  writeFileSync(join(state, 'profiles', 'legion', 'config.json'), JSON.stringify(cfg));
};
const custom = (over: Partial<AcpEntry> = {}): AcpEntry => ({ id: 'other', label: 'Other', command: 'hermes', args: ['acp'], tested: false, enabled: true, ...over });
const deps = () => ({ now, dataDir });
const rowsOf = (entries: AcpEntry[] = [BUILTIN_HERMES]) => agentDoctorRows(entries, { dataDir, now });
const row = async (id: string, entries?: AcpEntry[]) => (await rowsOf(entries)).find((r) => r.id === id);

const INSTALL = 'Hermes is not installed. Install it from hermes-agent.nousresearch.com, then check again.';
const GET = (key: string): string[] => ['config', 'get', key, '--json'];

// ------------------------------------------------------------------ detection

test('Hermes not on PATH: found is false, nothing is started, the row names the install page', async () => {
  setEnv('PATH', emptyDir);
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.found, false);
  assert.equal(d.checkOk, false);
  assert.deepEqual(calls(), []);
  const r = (await row('acp-hermes'))!;
  assert.equal(r.detail, INSTALL);
  assert.equal(r.ok, true, 'not installed is not a fault for someone who does not use Hermes');
  assert.equal(r.level, 'neutral');
  assert.equal((await rowsOf()).length, 1, 'nothing else to say about a program that is not there');
});

test('Hermes found: the path is kept and `acp --check` is the first command', async () => {
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.found, true);
  assert.match(d.path ?? '', /hermes(\.cmd)?$/i);
  assert.equal(d.checkOk, true);
  assert.deepEqual(calls()[0], ['acp', '--check']);
  const r = (await row('acp-hermes'))!;
  assert.equal(r.label, 'Hermes: found');
  assert.equal(r.ok, true);
});

test('`acp --check` failing: checkOk is false, the stderr tail is shown with secrets redacted, and nothing else is asked', async () => {
  setEnv('FAKE_HERMES_CHECK_FAIL', `ModuleNotFoundError: no module named acp (PROVIDER_ONE_API_KEY=${LEAK})`);
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.found, true);
  assert.equal(d.checkOk, false);
  assert.match(d.detail, /no module named acp/);
  assert.doesNotMatch(d.detail, new RegExp(LEAK));
  assert.ok(d.detail.length < 400, 'short');
  assert.deepEqual(calls(), [['acp', '--check']], 'a Hermes that does not start is not asked for its settings');
  const r = (await row('acp-hermes-starts'))!;
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.detail, new RegExp(LEAK));
  assert.match(r.fix ?? '', /hermes acp --check/);
});

test('Hermes starts: its row is green', async () => {
  const r = (await row('acp-hermes-starts'))!;
  assert.equal(r.label, 'Hermes starts');
  assert.equal(r.ok, true);
});

test('`--version` is never sent, through a whole Doctor pass of every row', async () => {
  ownConfig({ 'approvals.mode': 'manual' });
  await rowsOf([BUILTIN_HERMES, custom()]);
  await rowsOf([{ ...BUILTIN_HERMES, contained: true }]);
  const all = calls();
  assert.ok(all.length >= 4, 'something was run');
  assert.ok(all.every((c) => !c.includes('--version')), JSON.stringify(all));
});

test('approvals come from `config get approvals.mode --json`; Hermes reads a bare `off` as false', async () => {
  for (const [stored, mode] of [['manual', 'manual'], ['smart', 'smart'], ['off', 'off'], [false, 'off'], [true, 'manual'], ['MANUAL', 'manual']] as const) {
    forgetDetections();
    ownConfig({ 'approvals.mode': stored });
    const d = await detectAgent(BUILTIN_HERMES, deps());
    assert.equal(d.approvalsMode, mode, `stored ${JSON.stringify(stored)}`);
  }
  assert.ok(calls().some((c) => JSON.stringify(c) === JSON.stringify(GET('approvals.mode'))));
});

test('approvals that cannot be read are unknown: a string Hermes would not accept, garbage, a missing key', async () => {
  ownConfig({ 'approvals.mode': 'auto' });
  assert.equal((await detectAgent(BUILTIN_HERMES, deps())).approvalsMode, 'unknown');
  forgetDetections();
  ownConfig({ 'approvals.mode': 'manual' });
  setEnv('FAKE_HERMES_GARBAGE', 'this is not json');
  assert.equal((await detectAgent(BUILTIN_HERMES, deps())).approvalsMode, 'unknown');
  forgetDetections();
  setEnv('FAKE_HERMES_GARBAGE', undefined);
  ownConfig({});
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.approvalsMode, 'unknown');
  const r = (await row('acp-hermes-approvals'))!;
  assert.equal(r.label, 'Hermes approvals: unknown');
  assert.equal(r.ok, true);
  assert.equal(r.level, undefined, 'no colour for what Legion could not read');
});

test('approvals rows: manual is plain, smart is amber, off is red, with the fixed words', async () => {
  ownConfig({ 'approvals.mode': 'manual' });
  let r = (await row('acp-hermes-approvals'))!;
  assert.equal(r.label, 'Hermes approvals: manual');
  assert.equal(r.ok, true);
  assert.equal(r.level, undefined);
  forgetDetections();
  ownConfig({ 'approvals.mode': 'smart' });
  r = (await row('acp-hermes-approvals'))!;
  assert.equal(r.label, 'Hermes approvals: smart');
  assert.equal(r.ok, true);
  assert.equal(r.level, 'warn');
  assert.match(r.detail, /^Hermes lets its own AI approve some commands before you see them\./);
  forgetDetections();
  ownConfig({ 'approvals.mode': false });
  r = (await row('acp-hermes-approvals'))!;
  assert.equal(r.label, 'Hermes approvals: off');
  assert.equal(r.ok, false);
  assert.match(r.detail, /^Hermes runs everything without asking you\./);
});

// ------------------------------------------------------------------ version

test('the version comes from the `initialize` answer, not from `--version`', async () => {
  setEnv('FAKE_HERMES_VERSION', '0.22.3');
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.version, '0.22.3');
  assert.ok(calls().some((c) => c[0] === 'acp' && c.length === 1), 'the handshake started `acp` once, without --check');
});

test('TESTED_HERMES: the minimum is the first release with the gateway server, and nothing newer than the tested one is silent', () => {
  assert.equal(TESTED_HERMES.min, '0.22.3');
  assert.match(TESTED_HERMES.testedWith, /^\d+\.\d+\.\d+$/);
});

test('version rows: equal to the tested one is plain, newer is amber, older than the minimum is red, unreadable has no colour', async () => {
  const cases: Array<[string, { ok: boolean; level?: string; label: string }]> = [
    [TESTED_HERMES.testedWith, { ok: true, label: `Hermes version ${TESTED_HERMES.testedWith}` }],
    ['v0.22.3+canary.20261020T065957Z', { ok: true, label: 'Hermes version 0.22.3' }],
    ['0.22.6', { ok: true, level: 'warn', label: 'Hermes version 0.22.6' }],
    ['1.0.0', { ok: true, level: 'warn', label: 'Hermes version 1.0.0' }],
    ['0.22.2', { ok: false, label: 'Hermes version 0.22.2' }],
    ['0.0.0', { ok: true, level: 'neutral', label: 'Hermes version' }],
    ['', { ok: true, level: 'neutral', label: 'Hermes version' }],
    ['banana', { ok: true, level: 'neutral', label: 'Hermes version' }],
  ];
  for (const [v, want] of cases) {
    forgetDetections();
    setEnv('FAKE_HERMES_VERSION', v);
    const r = (await row('acp-hermes-version'))!;
    assert.equal(r.label, want.label, `version ${JSON.stringify(v)}`);
    assert.equal(r.ok, want.ok, `version ${JSON.stringify(v)}`);
    assert.equal(r.level, want.level, `version ${JSON.stringify(v)}`);
    if (v === '0.22.6') assert.match(r.detail, /^Newer than the version Legion was tested with\. It should work; tell us if it does not\./);
    if (v === '0.22.2') assert.match(r.detail, /0\.22\.3/);
  }
});

test('a version a run reported is used when the handshake could not read one', async () => {
  setEnv('FAKE_HERMES_VERSION', '');
  noteAgentVersion('hermes', '0.22.3');
  assert.equal((await detectAgent(BUILTIN_HERMES, deps())).version, '0.22.3');
});

// ------------------------------------------------------------------ the probe rule, the cache, the environment

test('probe rule: a disabled custom entry is not run at all and says "not checked"; an enabled one is checked; the built-in is checked only when it is on (R75)', async () => {
  const off = custom({ enabled: false });
  const d = await detectAgent(off, deps());
  assert.equal(d.checked, false);
  assert.deepEqual(calls(), []);
  assert.deepEqual(await rowsOf([off]), [], 'a switched-off entry has no Doctor rows at all (R75)');
  assert.deepEqual(calls(), [], 'building the rows did not run it either');
  await detectAgent(custom(), deps());
  assert.ok(calls().length > 0, 'enabled custom entry is checked');
  forgetDetections();
  writeFileSync(log, '');
  assert.equal((await detectAgent({ ...BUILTIN_HERMES, enabled: false }, deps())).checked, false);
  assert.deepEqual(calls(), [], 'a switched-off Hermes is not started either');
});

test('the answer is kept for 10 minutes; a forced check and an expired one run again', async () => {
  await detectAgent(BUILTIN_HERMES, deps());
  const n = calls().length;
  await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(calls().length, n, 'cached');
  clock += DETECT_TTL_MS - 1;
  await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(calls().length, n, 'still cached just before the end');
  clock += 2;
  await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(calls().length, 2 * n, 'expired');
  await detectAgent(BUILTIN_HERMES, { ...deps(), force: true });
  assert.equal(calls().length, 3 * n, 'forced');
});

test('Doctor rows always look again (the words say "check again" after an install)', async () => {
  await rowsOf();
  const n = calls().length;
  await rowsOf();
  assert.equal(calls().length, 2 * n);
});

test('the probes see the same Hermes home as a run: the entry env reaches the check, the settings and the handshake', async () => {
  await detectAgent({ ...BUILTIN_HERMES, env: { HERMES_HOME: 'owner-home' } }, deps());
  assert.ok(homes().length >= 3);
  assert.ok(homes().every((h) => h === 'owner-home'), JSON.stringify(homes()));
});

test('a contained entry is checked (the program) and read through its profile: -p legion in front of every command that reads settings', async () => {
  profileConfig({ 'approvals.mode': 'manual', 'approvals.timeout': 90 });
  const d = await detectAgent({ ...BUILTIN_HERMES, contained: true }, deps());
  assert.equal(d.approvalsMode, 'manual');
  assert.deepEqual(calls()[0], ['acp', '--check'], 'the start check is about the program: it needs no profile');
  const gets = calls().filter((c) => c.includes('config'));
  assert.ok(gets.length >= 2);
  assert.ok(gets.every((c) => c[0] === '-p' && c[1] === 'legion'), JSON.stringify(gets));
  assert.equal(d.permissionWaitMs, 90_000);
});

test('Legion only reads Hermes settings, never writes one', async () => {
  ownConfig({ 'approvals.mode': 'off', 'auth.adopt_external_logins': true });
  await rowsOf();
  assert.ok(calls().every((c) => !c.includes('set') && !c.includes('unset')), JSON.stringify(calls()));
});

// ------------------------------------------------------------------ R38: Hermes's own waits reach the run seams

test('R38: approvals.timeout and the MCP tool-call timeout are read and cached; unset means Hermes defaults (300 s)', async () => {
  ownConfig({ 'approvals.mode': 'manual', 'approvals.timeout': 60, 'timeouts.mcp.tool_call': 100 });
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.permissionWaitMs, 60_000);
  assert.equal(d.toolWaitMs, 70_000, 'a margin below Hermes\'s own cut-off');
  assert.deepEqual(agentWaits(BUILTIN_HERMES), { permissionWaitMs: 60_000, toolWaitMs: 70_000 });
  assert.ok(calls().some((c) => JSON.stringify(c) === JSON.stringify(GET('approvals.timeout'))));
  assert.ok(calls().some((c) => JSON.stringify(c) === JSON.stringify(GET('timeouts.mcp.tool_call'))));
  forgetDetections();
  ownConfig({ 'approvals.mode': 'manual' });
  const e = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(e.permissionWaitMs, 300_000);
  assert.equal(e.toolWaitMs, 270_000);
});

test('R38: Hermes reads a quoted number as a number, so Legion does too', async () => {
  ownConfig({ 'approvals.timeout': '600', 'timeouts.mcp.tool_call': '100.5' });
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.permissionWaitMs, 600_000);
  assert.equal(d.toolWaitMs, 70_500);
});

test('R38: a value that is not a positive number is ignored', async () => {
  ownConfig({ 'approvals.timeout': 'soon', 'timeouts.mcp.tool_call': -5 });
  const d = await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(d.permissionWaitMs, 300_000);
  assert.equal(d.toolWaitMs, 270_000);
});

test('R38: the seams the engine reads give the cached values, and Hermes defaults before anything is known', async () => {
  const seams = hostWaitSeams();
  assert.equal(permissionWaitOf(seams.permissionWaitMs, BUILTIN_HERMES), 300_000, 'nothing known yet');
  assert.equal(toolWaitOf(seams.toolWaitMs, BUILTIN_HERMES), 270_000);
  ownConfig({ 'approvals.timeout': 45, 'timeouts.mcp.tool_call': 20 });
  await detectAgent(BUILTIN_HERMES, deps());
  assert.equal(permissionWaitOf(seams.permissionWaitMs, BUILTIN_HERMES), 45_000);
  assert.equal(toolWaitOf(seams.toolWaitMs, BUILTIN_HERMES), 10_000);
});

test('the waits read from Hermes apply to the Hermes entry only, never to another agent host', async () => {
  const seams = hostWaitSeams();
  ownConfig({ 'approvals.timeout': 45, 'timeouts.mcp.tool_call': 20 });
  await detectAgent(BUILTIN_HERMES, deps());
  const other = { ...BUILTIN_HERMES, id: 'acp-other', label: 'Other', command: 'other-agent' };
  assert.equal(permissionWaitOf(seams.permissionWaitMs, BUILTIN_HERMES), 45_000);
  assert.equal(permissionWaitOf(seams.permissionWaitMs, other), 300_000, 'another agent keeps the default card wait');
  assert.equal(toolWaitOf(seams.toolWaitMs, other), 270_000);
});

test('the tool-call card wait is cut to the timer limit and a bad value falls back to 270 s', () => {
  assert.equal(toolWaitOf(1e300), MAX_CARD_WAIT_MS);
  assert.equal(toolWaitOf(3e9), MAX_CARD_WAIT_MS);
  assert.equal(toolWaitOf(Number.NaN), 270_000);
  assert.equal(toolWaitOf(-5), 270_000);
  assert.equal(toolWaitOf(() => { throw new Error('seam failed'); }), 270_000);
  assert.equal(toolWaitOf(45_000), 45_000);
});

// ------------------------------------------------------------------ Doctor rows: the rulings

test('R50: the owner\'s own Hermes borrows the Claude Code login unless the setting is false; the row names the setting and Legion never sets it', async () => {
  for (const cfg of [{ 'auth.adopt_external_logins': true }, {}]) {
    forgetDetections();
    ownConfig(cfg);
    const r = (await row('acp-hermes-logins'))!;
    assert.ok(r, JSON.stringify(cfg));
    assert.equal(r.ok, true);
    assert.equal(r.level, 'warn');
    assert.match(r.detail, /borrow your Claude Code login/);
    assert.match(r.detail, /log each other out/);
    assert.equal(r.fix, 'hermes config set auth.adopt_external_logins false');
  }
  forgetDetections();
  ownConfig({ 'auth.adopt_external_logins': false });
  assert.equal(await row('acp-hermes-logins'), undefined);
  forgetDetections();
  ownConfig({ 'auth.adopt_external_logins': true });
  assert.equal(await row('acp-hermes-logins', [{ ...BUILTIN_HERMES, contained: true }]), undefined, 'the Contained profile has its own check');
  assert.ok(calls().every((c) => !c.includes('set')), 'Legion never changes the setting');
});

test('R27: a Hermes that starts but could not sign in under Legion points at the keep list, by its name in Settings', async () => {
  assert.equal(await row('acp-hermes-signin'), undefined, 'no failure seen, no row');
  noteAuthFailure('hermes');
  const r = (await row('acp-hermes-signin'))!;
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes(ENV_KEEP_LABEL), r.detail);
  assert.match(r.detail, /environment variable/);
  assert.match(r.detail, /name/);
  assert.match(r.detail, /PYTHONPATH/);
  noteAgentVersion('hermes', '0.22.3'); // a run that opened a session: signed in after all
  assert.equal(await row('acp-hermes-signin'), undefined);
});

test('R27: when `acp --check` fails the start problem is the one that is shown, not the key hint', async () => {
  noteAuthFailure('hermes');
  setEnv('FAKE_HERMES_CHECK_FAIL', 'broken');
  assert.equal(await row('acp-hermes-signin'), undefined);
  assert.equal((await row('acp-hermes-starts'))!.ok, false);
});

test('Contained profile: the row uses containedStatus and says the state in its label', async () => {
  const entry = { ...BUILTIN_HERMES, contained: true };
  let r = (await row('acp-hermes-contained', [entry]))!;
  assert.equal(r.label, 'Contained profile: not set up');
  assert.equal(r.ok, false);
  assert.ok(calls().some((c) => c[0] === 'profile' && c[1] === 'show'), 'containedStatus ran');
  assert.equal(await row('acp-hermes-contained'), undefined, 'not shown for the owner\'s own Hermes');
  profileConfig({ 'approvals.mode': 'manual', 'platform_toolsets.acp': ['file'], 'auth.adopt_external_logins': false });
  r = (await row('acp-hermes-contained', [entry]))!;
  assert.equal(r.label, 'Contained profile: not signed in');
  assert.equal(r.ok, true);
  assert.equal(r.level, 'warn');
  writeFileSync(join(state, 'profiles', 'legion', 'signed-in'), '1');
  r = (await row('acp-hermes-contained', [entry]))!;
  assert.equal(r.label, 'Contained profile: ready');
  assert.equal(r.ok, true);
  assert.equal(r.level, undefined);
  profileConfig({ 'approvals.mode': 'smart', 'platform_toolsets.acp': ['file'], 'auth.adopt_external_logins': false });
  r = (await row('acp-hermes-contained', [entry]))!;
  assert.equal(r.label, 'Contained profile: settings differ');
  assert.equal(r.ok, false);
});

test('R34: no Doctor row claims the in-process Hermes path works', async () => {
  ownConfig({ 'approvals.mode': 'smart', 'auth.adopt_external_logins': true });
  noteAuthFailure('hermes');
  const all = await rowsOf([BUILTIN_HERMES, { ...BUILTIN_HERMES, id: 'hermes2', contained: true }]);
  assert.ok(all.length > 5);
  for (const r of all) assert.doesNotMatch(`${r.label} ${r.detail} ${r.fix ?? ''}`, /in-process|in process|shared server|bare server/i);
});

test('a custom entry keeps its own name in the rows, and gets no Hermes version colour', async () => {
  setEnv('FAKE_HERMES_VERSION', '9.9.9');
  const all = await rowsOf([custom({ label: 'My Agent' })]);
  assert.ok(all.some((r) => r.id === 'acp-other' && r.label === 'My Agent: found'));
  const v = all.find((r) => r.id === 'acp-other-version')!;
  assert.equal(v.level, undefined, 'the tested version is the built-in entry\'s');
  assert.ok(all.every((r) => !/Hermes/.test(`${r.label} ${r.detail}`)), 'no other program is called Hermes');
  setEnv('PATH', emptyDir);
  forgetDetections();
  const gone = (await rowsOf([custom({ label: 'My Agent' })]))[0]!;
  assert.match(gone.detail, /My Agent was not found on your computer/);
  assert.doesNotMatch(gone.detail, /nousresearch/);
});

test('every row id is its own, for each entry', async () => {
  ownConfig({ 'approvals.mode': 'smart', 'auth.adopt_external_logins': true });
  noteAuthFailure('hermes');
  const all = await rowsOf([BUILTIN_HERMES, custom()]);
  const ids = all.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(','));
});

test('no row text has an em dash or an en dash, or says "this computer"', async () => {
  ownConfig({ 'approvals.mode': 'off', 'auth.adopt_external_logins': true });
  noteAuthFailure('hermes');
  const all = [...await rowsOf([BUILTIN_HERMES, { ...BUILTIN_HERMES, id: 'c', contained: true }]), ...(await (async () => { setEnv('PATH', emptyDir); forgetDetections(); return rowsOf(); })())];
  for (const r of all) assert.doesNotMatch(`${r.label} ${r.detail} ${r.fix ?? ''}`, new RegExp('['+String.fromCharCode(0x2013, 0x2014)+']|this computer', 'i'));
});

// ------------------------------------------------------------------ fix round 1

test('Contained entry with no `legion` profile yet: the row says "not set up" and the start row is not red', async () => {
  const entry = { ...BUILTIN_HERMES, contained: true };
  const all = await rowsOf([entry]);
  const starts = all.find((r) => r.id === 'acp-hermes-starts')!;
  assert.equal(starts.ok, true, `the program starts; ${starts.detail}`);
  assert.equal(starts.fix, undefined);
  const c = all.find((r) => r.id === 'acp-hermes-contained')!;
  assert.equal(c.label, 'Contained profile: not set up');
  assert.equal(c.ok, false);
  assert.ok(c.detail.length > 0, 'the set-up hint');
  assert.deepEqual(all.filter((r) => !r.ok).map((r) => r.id), ['acp-hermes-contained'], 'the one red row is the profile');
  assert.ok(calls().every((x) => !(x[0] === '-p' && x.includes('--check'))), 'no start check goes through a profile that may not exist');
  assert.ok(!all.some((r) => r.id === 'acp-hermes-approvals'), 'there is no profile to read approvals from yet');
});

test('the fake runs from a private copy, so a rebuild of dist/ while the batch runs cannot change what the tests start', () => {
  const shim = readFileSync(join(binDir, WIN ? 'hermes.cmd' : 'hermes'), 'utf8');
  assert.ok(!shim.includes(FAKE), 'the shim must not point into dist/test');
  assert.ok(shim.includes(binDir), 'the shim runs the copy that sits beside it');
});

test('the fake behaves like Hermes: -p with a missing profile fails `acp --check` (so the test above cannot pass by accident)', async () => {
  const d = await detectAgent({ ...BUILTIN_HERMES, args: ['-p', 'legion', 'acp'] }, deps());
  assert.equal(d.checkOk, false);
  assert.match(d.detail, /does not exist/);
});

test('catalog: Legion starts no Hermes to build the model list (found by PATH only), also when forced', async () => {
  const c = await catalogOf([BUILTIN_HERMES]);
  assert.deepEqual(c.hosts, [{ value: 'acp:hermes', label: 'Hermes', entryId: 'hermes' }]);
  await getCatalog({ config: doctorConfig(), queryFn: fakeQueryWithLists(), hosts: hosts([BUILTIN_HERMES, custom()]) }, { force: true });
  assert.deepEqual(calls(), [], 'zero Hermes invocations during catalog load');
});

test('catalog: a cached check that failed hides the row; a cached pass keeps it; the catalog still starts nothing', async () => {
  setEnv('FAKE_HERMES_CHECK_FAIL', 'broken');
  await detectAgent(BUILTIN_HERMES, deps()); // a Doctor pass or a run did this
  const n = calls().length;
  let c = await catalogOf([BUILTIN_HERMES]);
  assert.deepEqual(c.hosts ?? [], [], 'known not to start: not offered');
  forgetDetections();
  setEnv('FAKE_HERMES_CHECK_FAIL', undefined);
  await detectAgent(BUILTIN_HERMES, deps());
  const m = calls().length;
  c = await catalogOf([BUILTIN_HERMES]);
  assert.equal(c.hosts?.length, 1);
  assert.ok(n > 0 && calls().length === m, 'the catalog added no invocation');
});

test('Hermes-only commands go to the built-in entry only: a custom entry gets one initialize handshake and nothing else', async () => {
  const all = await rowsOf([custom()]);
  assert.ok(calls().length >= 1);
  assert.ok(calls().every((c) => c.length === 1 && c[0] === 'acp'), JSON.stringify(calls()));
  const ids = all.map((r) => r.id);
  assert.ok(ids.includes('acp-other-starts') && ids.includes('acp-other-version'));
  assert.equal(all.find((r) => r.id === 'acp-other-starts')!.ok, true);
  const ap = all.find((r) => r.id === 'acp-other-approvals')!;
  assert.match(ap.detail, /not checked/i);
  assert.equal(ap.ok, true);
  assert.equal(ap.level, 'neutral');
  assert.ok(!ids.includes('acp-other-logins'));
});

test('a custom entry that does not answer initialize is red on "starts" and is not asked anything else', async () => {
  setEnv('FAKE_HERMES_HANDSHAKE', undefined); // the fake then exits at once with "unknown command"
  const all = await rowsOf([custom()]);
  const s = all.find((r) => r.id === 'acp-other-starts')!;
  assert.equal(s.ok, false);
  assert.ok(calls().every((c) => c.length === 1 && c[0] === 'acp'), JSON.stringify(calls()));
});

test('a handshake that never gets an answer ends at the limit: the program is stopped and no process is left behind', async () => {
  const pidFile = join(state, 'hang.pid');
  setEnv('FAKE_HERMES_HANDSHAKE', 'hang');
  setEnv('FAKE_HERMES_PIDFILE', pidFile);
  const d = await detectAgent(custom(), { ...deps(), handshakeTimeoutMs: 600 });
  assert.equal(d.checkOk, false);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
  }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  assert.equal(alive, false, 'the hanging program was ended');
});

// ------------------------------------------------------------------ Doctor and catalog wiring

const fakeQuery = (): QueryFn => ((_: unknown) => ({ accountInfo: async () => ({ email: 'a@b.c' }), interrupt: async () => undefined, close: () => undefined })) as unknown as QueryFn;
// Hermes is off in a fresh config (R75, test/hermes-off.test.ts); these tests are about the rows of a Hermes the owner turned on
const doctorConfig = () => { const c = defaultConfig(); c.acp.entries = [{ ...BUILTIN_HERMES }]; c.workspaceDir = join(tempDir('acp-doctor-ws-'), 'ws'); return c; };

test('the Doctor starts no Hermes unless the core gives it the agent host', async () => {
  await runDoctor({ config: doctorConfig(), getBoat: () => null, queryFn: fakeQuery() });
  assert.deepEqual(calls(), []);
});

test('the Doctor adds the Hermes rows after the Claude ones when it has the agent host, and never fails on them', async () => {
  const config = doctorConfig();
  ownConfig({ 'approvals.mode': 'manual', 'auth.adopt_external_logins': false });
  const checks = await runDoctor({ config, getBoat: () => null, queryFn: fakeQuery(), agentHost: { dataDir }, probeAgents: true });
  const ids = checks.map((c) => c.id);
  assert.ok(ids.includes('acp-hermes') && ids.includes('acp-hermes-starts') && ids.includes('acp-hermes-version') && ids.includes('acp-hermes-approvals'), ids.join(','));
  assert.ok(ids.indexOf('claude') < ids.indexOf('acp-hermes'));
  assert.equal(checks.find((c) => c.id === 'workspace')!.ok, true);
});

test('a Hermes check that throws becomes a failed row, never an exception', async () => {
  const checks = await runDoctor({ config: doctorConfig(), getBoat: () => null, queryFn: fakeQuery(), agentHost: { dataDir, entries: () => { throw new Error('boom'); } } });
  const bad = checks.find((c) => c.id === 'acp-hermes')!;
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /boom/);
  assert.equal(checks.find((c) => c.id === 'workspace')!.ok, true);
});

const hosts = (entries: AcpEntry[]) => ({ entries: () => entries, dataDir, now });
const catalogOf = (entries: AcpEntry[]) => getCatalog({ config: doctorConfig(), queryFn: fakeQueryWithLists(), hosts: hosts(entries) }, { force: true });
const fakeQueryWithLists = (): QueryFn => ((_: unknown) => ({ supportedCommands: async () => [], supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }], interrupt: async () => undefined, close: () => undefined })) as unknown as QueryFn;

test('catalog: acp:hermes is listed only when Hermes is found and enabled, and apart from the Claude models', async () => {
  let c = await catalogOf([BUILTIN_HERMES]);
  assert.deepEqual(c.hosts, [{ value: 'acp:hermes', label: 'Hermes', entryId: 'hermes' }]);
  assert.deepEqual(c.models.map((m) => m.value), ['sonnet'], 'the Claude models are untouched');
  assert.equal(c.error, undefined);
  forgetDetections();
  setEnv('PATH', emptyDir);
  c = await catalogOf([BUILTIN_HERMES]);
  assert.deepEqual(c.hosts ?? [], [], 'not found');
  assert.equal(c.error, undefined, 'a missing Hermes is never "could not load models from Claude Code"');
  setEnv('PATH', binDir);
  forgetDetections();
  writeFileSync(log, '');
  c = await catalogOf([{ ...BUILTIN_HERMES, enabled: false }]);
  assert.deepEqual(c.hosts ?? [], [], 'disabled');
  assert.deepEqual(calls(), [], 'a disabled entry is not even asked');
});

test('catalog: a Claude probe failure and Hermes do not hide each other', async () => {
  const failing = (() => { throw new Error('spawn failed'); }) as unknown as QueryFn;
  const c = await getCatalog({ config: doctorConfig(), queryFn: failing, hosts: hosts([BUILTIN_HERMES]) }, { force: true });
  assert.match(c.error ?? '', /spawn failed/);
  assert.equal(c.hosts?.[0]?.value, 'acp:hermes');
});

test('catalog: the check timeout is a limit, not a hang', () => {
  assert.ok(CHECK_TIMEOUT_MS >= 10_000 && CHECK_TIMEOUT_MS <= 60_000);
});

// ------------------------------------------------------------------ fix round 2: R58 through the Doctor, the cache expiry, the first run

const doctorWith = (over: Record<string, unknown> = {}) => runDoctor({ config: doctorConfig(), getBoat: () => null, queryFn: fakeQuery(), agentHost: { dataDir, now }, ...over });

test('R58: a Doctor pass without the probe flag starts no Hermes and says it is not checked yet', async () => {
  ownConfig({ 'approvals.mode': 'manual' });
  const checks = await doctorWith();
  assert.deepEqual(calls(), [], 'zero Hermes invocations (boot, a settings save and Remember all take this path)');
  assert.equal(checks.find((c) => c.id === 'acp-hermes')!.label, 'Hermes: found');
  const starts = checks.find((c) => c.id === 'acp-hermes-starts')!;
  assert.equal(starts.ok, true);
  assert.equal(starts.level, 'neutral');
  assert.match(starts.detail, /not checked yet/i);
  assert.ok(checks.filter((c) => c.id.startsWith('acp-')).every((c) => c.ok), 'nothing red from a program Legion has not run');
});

test('R58: with the probe flag the Doctor does check Hermes', async () => {
  ownConfig({ 'approvals.mode': 'manual' });
  const checks = await doctorWith({ probeAgents: true });
  assert.deepEqual(calls()[0], ['acp', '--check']);
  assert.ok(calls().some((c) => c.length === 1 && c[0] === 'acp'), 'the handshake');
  const starts = checks.find((c) => c.id === 'acp-hermes-starts')!;
  assert.equal(starts.level, undefined);
  assert.equal(starts.detail, 'Its start check passed.');
});

test('R58: after a probe, a pass without the flag shows what it found and starts nothing; an expired answer is "not checked yet" again', async () => {
  ownConfig({ 'approvals.mode': 'smart' });
  await doctorWith({ probeAgents: true });
  const n = calls().length;
  let checks = await doctorWith();
  assert.equal(calls().length, n);
  assert.ok(checks.some((c) => c.id === 'acp-hermes-version'));
  assert.equal(checks.find((c) => c.id === 'acp-hermes-approvals')!.label, 'Hermes approvals: smart');
  clock += DETECT_TTL_MS + 1;
  checks = await doctorWith();
  assert.equal(calls().length, n);
  assert.match(checks.find((c) => c.id === 'acp-hermes-starts')!.detail, /not checked yet/i);
});

test('R58: without the flag a Hermes that is not installed still gets its install row, and a Contained entry its "not checked yet" row, with nothing started', async () => {
  setEnv('PATH', emptyDir);
  let checks = await doctorWith();
  assert.equal(checks.find((c) => c.id === 'acp-hermes')!.detail, INSTALL);
  setEnv('PATH', binDir);
  checks = await doctorWith({ agentHost: { dataDir, now, entries: () => [{ ...BUILTIN_HERMES, contained: true }] } });
  assert.match(checks.find((c) => c.id === 'acp-hermes-contained')!.label, /not checked yet/i);
  assert.deepEqual(calls(), []);
});

test('catalog: a cached failed check hides the row for 10 minutes only, so a Hermes fixed outside Legion comes back', async () => {
  setEnv('FAKE_HERMES_CHECK_FAIL', 'broken');
  await detectAgent(BUILTIN_HERMES, deps());
  assert.deepEqual((await catalogOf([BUILTIN_HERMES])).hosts ?? [], []);
  clock += DETECT_TTL_MS - 1;
  assert.deepEqual((await catalogOf([BUILTIN_HERMES])).hosts ?? [], [], 'still fresh');
  clock += 2;
  assert.equal((await catalogOf([BUILTIN_HERMES])).hosts?.length, 1, 'expired: listed again');
});

test('R58: a Hermes run start reads only Hermes\'s own waits when it has not been met yet: two settings reads, no start check, no handshake, kept 10 minutes', async () => {
  ownConfig({ 'approvals.timeout': 45, 'timeouts.mcp.tool_call': 20 });
  await warmHermes(BUILTIN_HERMES, deps(), { inUse: false, runStart: true });
  const got = calls().map((c) => JSON.stringify(c)).sort();
  assert.deepEqual(got, [JSON.stringify(GET('approvals.timeout')), JSON.stringify(GET('timeouts.mcp.tool_call'))].sort());
  assert.deepEqual(agentWaits(BUILTIN_HERMES), { permissionWaitMs: 45_000, toolWaitMs: 10_000 });
  await warmHermes(BUILTIN_HERMES, deps(), { inUse: false, runStart: true });
  assert.equal(calls().length, 2, 'kept');
  clock += DETECT_TTL_MS + 1;
  await warmHermes(BUILTIN_HERMES, deps(), { inUse: false, runStart: true });
  assert.equal(calls().length, 4, 'read again after 10 minutes');
});

test('R58/R62: who warms Hermes: core start only when an agent uses Hermes (never because a card was answered), a run start always (waits at least), never a switched-off Hermes or another entry', async () => {
  await warmHermes(BUILTIN_HERMES, deps(), { inUse: false, runStart: false });
  assert.deepEqual(calls(), [], 'core start, no agent uses Hermes: a Claude-only owner pays nothing');
  await warmHermes({ ...BUILTIN_HERMES, enabled: false }, deps(), { inUse: true, runStart: true });
  await warmHermes(custom(), deps(), { inUse: true, runStart: true });
  assert.deepEqual(calls(), [], 'switched off, and not Hermes');
  await warmHermes(BUILTIN_HERMES, deps(), { inUse: true, runStart: false });
  assert.deepEqual(calls()[0], ['acp', '--check'], 'an agent that uses Hermes gets the full check at core start');
  assert.ok(agentWaits(BUILTIN_HERMES));
});

test('R62: an agent uses Hermes only when its model is that entry; a Claude-only roster never does, whatever the first-use card says', () => {
  assert.equal(usesAgentHost([{ model: 'sonnet' }, { model: 'auto' }, { model: 'openrouter:x/y' }, {}], 'hermes'), false);
  assert.equal(usesAgentHost([{ model: 'sonnet' }, { model: 'acp:hermes' }], 'hermes'), true);
  assert.equal(usesAgentHost([{ model: 'acp:hermes/some-model' }], 'hermes'), true);
  assert.equal(usesAgentHost([{ model: 'acp:other' }], 'hermes'), false, 'another agent host is not Hermes');
  assert.equal(usesAgentHost([], 'hermes'), false);
});

// ------------------------------------------------------------------ R72: skip flags in the environment Legion would pass

test('R72: an approval-skip flag in the environment Hermes would get turns the approvals row red, even when the config says manual', async () => {
  ownConfig({ 'approvals.mode': 'manual' });
  const withEnv = async (env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}, entry: AcpEntry = BUILTIN_HERMES) => {
    forgetDetections();
    return (await agentDoctorRows([entry], { dataDir, now, env, ...extra })).find((r) => r.id === 'acp-hermes-approvals')!;
  };
  const calm = await withEnv({});
  assert.equal(calm.ok, true);
  assert.match(calm.detail, /asks you before commands it marks as dangerous/);
  for (const v of ['1', 'true', 'YES', ' on ']) {
    const r = await withEnv({ HERMES_YOLO_MODE: v });
    assert.equal(r.ok, false, v);
    assert.match(r.label, /HERMES_YOLO_MODE/);
    assert.match(r.detail, /^Hermes runs everything without asking you/);
    assert.match(r.detail, /HERMES_YOLO_MODE is set/);
    assert.match(r.fix ?? '', /Ignore Hermes's skip-approval settings/);
    assert.ok(!/[\u2013\u2014]/.test(`${r.label} ${r.detail} ${r.fix}`));
  }
  for (const v of ['0', 'false', 'no', '', 'maybe']) assert.equal((await withEnv({ HERMES_YOLO_MODE: v })).ok, true, `falsy: ${v}`);
  const own = await withEnv({}, {}, { ...BUILTIN_HERMES, env: { HERMES_YOLO_MODE: '1' } });
  assert.equal(own.ok, false, 'a flag the entry itself sets counts');
  const stripped = await withEnv({ HERMES_YOLO_MODE: '1' }, { stripSkipFlags: () => true });
  assert.equal(stripped.ok, true, 'the switch that strips the flags is on: Hermes never gets it');
  assert.match(stripped.detail, /asks you before commands it marks as dangerous/);
  const safe = await withEnv({ HERMES_SAFE_MODE: '1', HERMES_IGNORE_USER_CONFIG: 'true' });
  assert.equal(safe.level, 'warn');
  assert.match(safe.detail, /HERMES_SAFE_MODE/);
  assert.match(safe.detail, /HERMES_IGNORE_USER_CONFIG/);
  assert.match(safe.detail, /ignores/);
});

// ------------------------------------------------------------------ F7: the PATH lookup is remembered for as long as a detection lasts

test('F7: peekDetection walks PATH once per detection lifetime, found or not; a check, or the end of the lifetime, looks again', async () => {
  setEnv('PATH', emptyDir);
  assert.equal(peekDetection(BUILTIN_HERMES, now).found, false);
  setEnv('PATH', binDir); // Hermes appears on PATH
  assert.equal(peekDetection(BUILTIN_HERMES, now).found, false, 'inside the lifetime the earlier lookup stands: no new walk');
  clock += DETECT_TTL_MS + 1;
  assert.equal(peekDetection(BUILTIN_HERMES, now).found, true, 'after the lifetime it looks again');
  setEnv('PATH', emptyDir);
  assert.equal(peekDetection(BUILTIN_HERMES, now).found, true, 'and remembers that');
  await detectAgent(BUILTIN_HERMES, { ...deps(), force: true }); // a Doctor check looks for itself
  assert.equal(peekDetection(BUILTIN_HERMES, now).found, false);
});

// ------------------------------------------------------------------ R67: a Claude-only user never sees a Hermes warning

test('R67: while nobody uses Hermes every Hermes row is plain information, amber and red rows included; in use they are as before', async () => {
  ownConfig({ 'approvals.mode': 'smart', 'auth.adopt_external_logins': true });
  const notInUse = await agentDoctorRows([BUILTIN_HERMES], { dataDir, now, inUse: () => false });
  assert.ok(notInUse.length >= 4);
  for (const r of notInUse) { assert.equal(r.ok, true, r.id); assert.notEqual(r.level, 'warn', r.id); }
  assert.ok(notInUse.every((r) => r.level === 'neutral'), 'all neutral: nothing to act on until Hermes is used');
  const approvals = notInUse.find((r) => r.id === 'acp-hermes-approvals')!;
  assert.match(approvals.detail, /AI approve some commands/, 'the words stay, only the colour goes');
  forgetDetections();
  const used = await agentDoctorRows([BUILTIN_HERMES], { dataDir, now, inUse: (id) => id === 'hermes' });
  assert.equal(used.find((r) => r.id === 'acp-hermes-approvals')!.level, 'warn');
  assert.equal(used.find((r) => r.id === 'acp-hermes-logins')!.level, 'warn');
  forgetDetections();
  setEnv('FAKE_HERMES_CHECK_FAIL', 'boom');
  const broken = await agentDoctorRows([BUILTIN_HERMES], { dataDir, now, inUse: () => false });
  assert.ok(broken.every((r) => r.ok), 'a Hermes that does not start is not a fault for someone who does not use it');
  assert.ok(broken.every((r) => r.level === 'neutral'));
});
