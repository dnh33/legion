/**
 * The Contained Hermes profile (src/core/acp/contained.ts): set up, check, the route behind them and the launch form.
 * A fake `hermes` (test/acp-fake-hermes.ts) sits on PATH and records every argument list, so each test can say exactly what Legion ran.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import { makeFakes, start, TOKEN, TEST_ADMIN } from './helpers-c.js';
import { forgetLegionSecrets, registerLegionSecrets, startAgentProcess } from '../src/core/acp/process.js';
import { CONTAINED_TIMEOUT_MS, containedStatus, setUpContained, signInCommand } from '../src/core/acp/contained.js';
import { BUILTIN_HERMES } from '../src/shared/acp-view.js';

const WIN = process.platform === 'win32';
const FAKE = fileURLToPath(new URL('./acp-fake-hermes.js', import.meta.url));
const LEGION_TOKEN = 'legion-token-0123456789abcdef';
const KEY_A = 'one-PROVIDERKEY0123456789';
const KEY_B = 'two-OTHERPROVIDERKEY0123456789';

const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined) => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};
let binDir = '';
let state = '';
let log = '';

before(() => {
  binDir = tempDir('acp-fake-hermes-bin-');
  if (WIN) writeFileSync(join(binDir, 'hermes.cmd'), `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
  else { writeFileSync(join(binDir, 'hermes'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`); chmodSync(join(binDir, 'hermes'), 0o755); }
  setEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`);
  registerLegionSecrets([LEGION_TOKEN]);
});
after(() => {
  forgetLegionSecrets();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => {
  state = tempDir('acp-fake-hermes-state-');
  log = join(state, 'calls.log');
  writeFileSync(log, '');
  setEnv('FAKE_HERMES_STATE', state);
  setEnv('FAKE_HERMES_LOG', log);
  setEnv('FAKE_HERMES_BREAK', undefined);
  setEnv('PROVIDER_ONE_API_KEY', undefined);
  setEnv('PROVIDER_TWO_API_KEY', undefined);
  for (const n of ['FAKE_HERMES_SHOW_ERROR', 'FAKE_HERMES_NOISE', 'FAKE_HERMES_LEAK']) setEnv(n, undefined);
});

const calls = (): string[][] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
const makeProfile = () => { mkdirSync(join(state, 'profiles', 'legion'), { recursive: true }); writeFileSync(join(state, 'profiles', 'legion', 'config.json'), '{}'); };
const SHOW = ['profile', 'show', 'legion'];
const CREATE = ['profile', 'create', 'legion', '--no-alias'];
const SET_MODE = ['-p', 'legion', 'config', 'set', 'approvals.mode', 'manual'];
const SET_TOOLS = ['-p', 'legion', 'config', 'set', 'platform_toolsets.acp', '[file]'];
const SET_ADOPT = ['-p', 'legion', 'config', 'set', 'auth.adopt_external_logins', 'false'];
const GET_ADOPT = ['-p', 'legion', 'config', 'get', 'auth.adopt_external_logins', '--json'];
const GET_MODE = ['-p', 'legion', 'config', 'get', 'approvals.mode', '--json'];
const GET_TOOLS = ['-p', 'legion', 'config', 'get', 'platform_toolsets.acp', '--json'];

test('set up from nothing runs exactly these commands, in this order, and never a clone', async () => {
  const r = await setUpContained(BUILTIN_HERMES);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(calls(), [SHOW, CREATE, SET_MODE, SET_TOOLS, SET_ADOPT, GET_MODE, GET_TOOLS, GET_ADOPT]);
  assert.ok(calls().every((c) => !c.some((a) => a.startsWith('--clone'))), 'no clone flag anywhere');
  assert.ok(existsSync(join(state, 'profiles', 'legion')), 'the profile now exists');
  assert.equal(r.signInCommand, 'hermes -p legion setup model', 'the sign-in step is shown, not run');
  assert.ok(!calls().some((c) => c.includes('auth') || c.includes('setup')), 'Legion never runs the sign-in');
});

test('an existing legion profile is not created again, but still gets the three settings', async () => {
  makeProfile();
  const r = await setUpContained(BUILTIN_HERMES);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(calls(), [SHOW, SET_MODE, SET_TOOLS, SET_ADOPT, GET_MODE, GET_TOOLS, GET_ADOPT]);
  assert.match(r.detail, /already existed/);
});

test('a read-back that differs gives policyOk false and names the key', async () => {
  setEnv('FAKE_HERMES_BREAK', 'approvals.mode=smart');
  const up = await setUpContained(BUILTIN_HERMES);
  assert.equal(up.ok, false);
  assert.match(up.detail, /approvals\.mode/);
  assert.doesNotMatch(up.detail, /platform_toolsets/);
  const st = await containedStatus(BUILTIN_HERMES);
  assert.equal(st.exists, true);
  assert.equal(st.policyOk, false);
  assert.match(st.detail, /approvals\.mode/);

  setEnv('FAKE_HERMES_BREAK', 'platform_toolsets.acp=terminal');
  const up2 = await setUpContained(BUILTIN_HERMES); // the profile now exists; both settings are written again
  assert.equal(up2.ok, false);
  assert.match(up2.detail, /platform_toolsets\.acp/);
  assert.doesNotMatch(up2.detail, /approvals/);
  const st2 = await containedStatus(BUILTIN_HERMES);
  assert.equal(st2.policyOk, false);
  assert.match(st2.detail, /platform_toolsets\.acp/);
});

test('a setting Hermes does not report at all is a mismatch too', async () => {
  makeProfile(); // a profile with no settings: `config get` answers "Config key not set"
  const st = await containedStatus(BUILTIN_HERMES);
  assert.equal(st.exists, true);
  assert.equal(st.policyOk, false);
  assert.match(st.detail, /approvals\.mode/);
  assert.match(st.detail, /platform_toolsets\.acp/);
});

test('status reads only: no profile, set up but not signed in, then signed in', async () => {
  const none = await containedStatus(BUILTIN_HERMES);
  assert.deepEqual({ exists: none.exists, signedIn: none.signedIn, policyOk: none.policyOk }, { exists: false, signedIn: false, policyOk: false });
  assert.deepEqual(calls(), [SHOW], 'a missing profile costs one read');

  await setUpContained(BUILTIN_HERMES);
  writeFileSync(log, '');
  const ready = await containedStatus(BUILTIN_HERMES);
  assert.deepEqual({ exists: ready.exists, signedIn: ready.signedIn, policyOk: ready.policyOk }, { exists: true, signedIn: false, policyOk: true });
  assert.match(ready.detail, /hermes -p legion setup model/);
  assert.ok(calls().every((c) => !c.includes('set') && !c.includes('create')), 'a check changes nothing');

  writeFileSync(join(state, 'profiles', 'legion', 'signed-in'), '');
  const signed = await containedStatus(BUILTIN_HERMES);
  assert.equal(signed.signedIn, true);
  assert.equal(signed.policyOk, true);
});

test('no command line carries a provider key or a Legion token, and every argument is one of the fixed ones', async () => {
  setEnv('PROVIDER_ONE_API_KEY', KEY_A);
  setEnv('PROVIDER_TWO_API_KEY', KEY_B);
  setEnv('LEGION_AUTH_TOKEN', LEGION_TOKEN);
  const up = await setUpContained(BUILTIN_HERMES);
  const st = await containedStatus(BUILTIN_HERMES);
  const text = JSON.stringify([calls(), up, st]);
  for (const secret of [KEY_A, KEY_B, LEGION_TOKEN]) assert.ok(!text.includes(secret), 'a secret reached a command line or an answer');
  const fixed = new Set([SHOW, CREATE, SET_MODE, SET_TOOLS, SET_ADOPT, GET_MODE, GET_TOOLS, GET_ADOPT, ['-p', 'legion', 'auth', 'list']].map((c) => JSON.stringify(c)));
  for (const c of calls()) assert.ok(fixed.has(JSON.stringify(c)), `unexpected command ${JSON.stringify(c)}`);
});

test('every command goes through the agent launch path with the 60 second limit and a neutral folder', async () => {
  const seen: Array<{ command: string; args: string[]; timeoutMs: number; cwd?: string }> = [];
  const run = async (command: string, args: string[], opts: { timeoutMs: number; cwd?: string }) => {
    seen.push({ command, args, timeoutMs: opts.timeoutMs, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    return { code: 0, stdout: args.includes('--json') ? (args.includes('approvals.mode') ? '"manual"' : args.includes('auth.adopt_external_logins') ? 'false' : '["file"]') : '', stderr: '', timedOut: false };
  };
  const r = await setUpContained(BUILTIN_HERMES, { run });
  assert.equal(r.ok, true, r.detail);
  assert.equal(CONTAINED_TIMEOUT_MS, 60_000);
  assert.ok(seen.length === 7 && seen.every((s) => s.command === 'hermes' && s.timeoutMs === 60_000 && typeof s.cwd === 'string'));
});

test('a command that times out ends the set up with a plain sentence and no further command', async () => {
  const seen: string[][] = [];
  const run = async (_c: string, args: string[]) => { seen.push(args); return { code: null, stdout: '', stderr: '', timedOut: true }; };
  const r = await setUpContained(BUILTIN_HERMES, { run });
  assert.equal(r.ok, false);
  assert.match(r.detail, /60 seconds/);
  assert.equal(seen.length, 1, 'it stopped after the first command');
});

test('Hermes missing from the computer is said plainly, for set up and for check', async () => {
  const empty = tempDir('acp-no-hermes-');
  setEnv('PATH', empty);
  try {
    const up = await setUpContained(BUILTIN_HERMES);
    assert.equal(up.ok, false);
    assert.match(up.detail, /could not start Hermes/i);
    assert.match(up.detail, /your computer/);
    const st = await containedStatus(BUILTIN_HERMES);
    assert.deepEqual({ exists: st.exists, signedIn: st.signedIn, policyOk: st.policyOk }, { exists: false, signedIn: false, policyOk: false });
    assert.match(st.detail, /could not start Hermes/i);
  } finally { setEnv('PATH', `${binDir}${delimiter}${saved.PATH ?? ''}`); }
});

test('two set ups at once run the commands once', async () => {
  const [a, b] = await Promise.all([setUpContained(BUILTIN_HERMES), setUpContained(BUILTIN_HERMES)]);
  assert.equal(a.ok, true, a.detail);
  assert.deepEqual(a, b);
  assert.equal(calls().filter((c) => c[0] === 'profile' && c[1] === 'create').length, 1);
});

test('the sign-in command follows the entry command and quotes a path with spaces', () => {
  assert.equal(signInCommand({ command: 'hermes' }), 'hermes -p legion setup model');
  assert.equal(signInCommand({ command: 'C:\\Program Files\\Hermes\\hermes.exe' }), '"C:\\Program Files\\Hermes\\hermes.exe" -p legion setup model');
});

test('the text Legion shows has no em or en dash', async () => {
  const up = await setUpContained(BUILTIN_HERMES);
  const st = await containedStatus(BUILTIN_HERMES);
  const text = `${up.detail} ${st.detail} ${up.signInCommand}`;
  assert.ok(!/[\u2013\u2014]/.test(text), text);
  assert.ok(!/this computer/i.test(text));
});

test('a contained entry starts hermes as -p legion acp', async () => {
  const p = startAgentProcess({ ...BUILTIN_HERMES, contained: true }, { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir: tempDir('acp-data-') });
  await p.exited;
  assert.deepEqual(calls(), [['-p', 'legion', 'acp']]);
  writeFileSync(log, '');
  const own = startAgentProcess(BUILTIN_HERMES, { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir: tempDir('acp-data-') });
  await own.exited;
  assert.deepEqual(calls(), [['acp']], "the default entry runs the owner's own Hermes: no profile flag");
});

// ---------------------------------------------------------------- fix round 1

test('the profile does not borrow the login of another program: the setting is written, read back, and a borrowed login is not "signed in"', async () => {
  setEnv('FAKE_HERMES_BREAK', 'auth.adopt_external_logins=true');
  const bad = await setUpContained(BUILTIN_HERMES);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /auth.adopt_external_logins/);
  assert.doesNotMatch(bad.detail, /approvals|platform_toolsets/);
  setEnv('FAKE_HERMES_BREAK', undefined);
  const good = await setUpContained(BUILTIN_HERMES);
  assert.equal(good.ok, true, good.detail);
  writeFileSync(join(state, 'profiles', 'legion', 'borrowed'), ''); // a Claude Code login Hermes would borrow without the setting
  const st = await containedStatus(BUILTIN_HERMES);
  assert.equal(st.policyOk, true);
  assert.equal(st.signedIn, false, 'a borrowed login does not count as its own sign-in');
});

test('the detail text claims only what the read-back proves, in these exact words', async () => {
  const CLAIM = "Hermes reports that the Legion profile asks before it runs a command, that its tool list for Legion runs is set to file tools, and that it does not borrow your Claude Code login or another coding tool's login. Tools you add to that profile yourself are not checked.";
  const up = await setUpContained(BUILTIN_HERMES);
  const st = await containedStatus(BUILTIN_HERMES);
  for (const t of [up.detail, st.detail]) {
    assert.ok(t.includes(CLAIM), t);
    assert.doesNotMatch(t, /only file tools|has only|other programs/i, t);
  }
});

test('a missing credential is said as what Hermes lists, not as a flat "not signed in"', async () => {
  await setUpContained(BUILTIN_HERMES);
  const st = await containedStatus(BUILTIN_HERMES);
  assert.equal(st.signedIn, false);
  assert.match(st.detail, /lists no credential/i);
  assert.doesNotMatch(st.detail, /not signed in/i);
  assert.match(st.detail, /main Hermes sign-in/, 'it says a main Hermes sign-in would count too');
  writeFileSync(join(state, 'profiles', 'legion', 'signed-in'), '');
  const signed = await containedStatus(BUILTIN_HERMES);
  assert.equal(signed.signedIn, true);
  assert.match(signed.detail, /Hermes can use a credential for it/);
  assert.match(signed.detail, /may be your main Hermes sign-in/, 'the profile may be using the main Hermes sign-in');
});

test('a profile show that fails for another reason is reported as a Hermes failure, not as "not set up"', async () => {
  setEnv('FAKE_HERMES_SHOW_ERROR', '1');
  const st = await containedStatus(BUILTIN_HERMES);
  assert.equal(st.exists, false);
  assert.doesNotMatch(st.detail, /not been set up/);
  assert.match(st.detail, /no longer exists/);
  const up = await setUpContained(BUILTIN_HERMES);
  assert.equal(up.ok, false);
  assert.match(up.detail, /no longer exists/);
  assert.ok(!calls().some((c) => c[0] === 'profile' && c[1] === 'create'), 'no create after a failed show');
});

test('a notice line before the JSON does not hide a correct setting', async () => {
  await setUpContained(BUILTIN_HERMES);
  setEnv('FAKE_HERMES_NOISE', '1');
  const st = await containedStatus(BUILTIN_HERMES);
  assert.equal(st.policyOk, true, st.detail);
});

test('two checks at once run the commands once, and a check during a set up waits for it', async () => {
  const [a, b] = await Promise.all([containedStatus(BUILTIN_HERMES), containedStatus(BUILTIN_HERMES)]);
  assert.deepEqual(a, b);
  assert.equal(calls().filter((c) => c[0] === 'profile' && c[1] === 'show').length, 1);
  writeFileSync(log, '');
  const [up, during] = await Promise.all([setUpContained(BUILTIN_HERMES), containedStatus(BUILTIN_HERMES)]);
  assert.equal(up.ok, true, up.detail);
  assert.deepEqual({ exists: during.exists, policyOk: during.policyOk }, { exists: true, policyOk: true }, during.detail);
});

test('profile create gets a longer limit than the 60 second reads and writes, and the others keep 60', async () => {
  const seen: Array<{ args: string[]; timeoutMs: number }> = [];
  const run = async (_c: string, args: string[], opts: { timeoutMs: number }) => {
    seen.push({ args, timeoutMs: opts.timeoutMs });
    if (args[0] === 'profile' && args[1] === 'show') return { code: 1, stdout: '', stderr: "Error: Profile 'legion' does not exist.", timedOut: false };
    const json = args.includes('approvals.mode') ? '"manual"' : args.includes('auth.adopt_external_logins') ? 'false' : '["file"]';
    return { code: 0, stdout: args.includes('--json') ? json : '', stderr: '', timedOut: false };
  };
  const r = await setUpContained(BUILTIN_HERMES, { run });
  assert.equal(r.ok, true, r.detail);
  const create = seen.find((s) => s.args[1] === 'create');
  assert.ok(create && create.timeoutMs > 60_000, 'create is allowed longer, Hermes seeds its bundled skills inside it');
  assert.ok(seen.filter((s) => s.args[1] !== 'create').every((s) => s.timeoutMs === 60_000));
});

test('a key-shaped value in the Hermes message is redacted and cut before Legion shows it', async () => {
  setEnv('FAKE_HERMES_LEAK', 'zz9-leaky-value-0123456789abcdef');
  const up = await setUpContained(BUILTIN_HERMES);
  assert.equal(up.ok, false);
  assert.doesNotMatch(up.detail, /zz9-leaky-value/);
  assert.ok(up.detail.length < 400, 'one short line');
});

test('a long value Hermes reports back is cut before it is shown', async () => {
  setEnv('FAKE_HERMES_BREAK', `approvals.mode=${'x'.repeat(500)}`);
  const up = await setUpContained(BUILTIN_HERMES);
  assert.equal(up.ok, false);
  assert.ok(up.detail.length < 300, `${up.detail.length} characters`);
});

// ---------------------------------------------------------------- fix round 2

test('a profile create that hits its own limit says that limit, not 60 seconds', async () => {
  const run = async (_c: string, args: string[]) => {
    if (args[1] === 'show') return { code: 1, stdout: '', stderr: "Error: Profile 'legion' does not exist.", timedOut: false };
    return { code: null, stdout: '', stderr: '', timedOut: true };
  };
  const r = await setUpContained(BUILTIN_HERMES, { run });
  assert.equal(r.ok, false);
  assert.match(r.detail, /within 180 seconds/);
  assert.doesNotMatch(r.detail, /60 seconds/);
});

test('a set up that starts while a check is running waits for the check', async () => {
  const seen: string[][] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const run = async (_c: string, args: string[]) => {
    seen.push(args);
    if (seen.length === 1) await gate; // the check's first command is slow
    const json = args.includes('approvals.mode') ? '"manual"' : args.includes('auth.adopt_external_logins') ? 'false' : '["file"]';
    return { code: 0, stdout: args.includes('--json') ? json : '', stderr: '', timedOut: false };
  };
  const check = containedStatus(BUILTIN_HERMES, { run });
  const up = setUpContained(BUILTIN_HERMES, { run });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const startedEarly = seen.length;
  open(); // always let the check finish, so a failing assertion cannot leave the test waiting
  assert.equal(startedEarly, 1, 'the set up has not started a command while the check is still running');
  const [st, done] = await Promise.all([check, up]);
  assert.equal(st.policyOk, true, st.detail);
  assert.equal(done.ok, true, done.detail);
  const firstSet = seen.findIndex((c) => c.includes('set'));
  const lastCheck = seen.findIndex((c) => c.includes('auth') && c.includes('list'));
  assert.ok(lastCheck >= 0 && firstSet > lastCheck, 'every command of the check ran before the first write');
});

// ---------------------------------------------------------------- the route

async function call(base: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/acp/contained`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('POST /api/acp/contained: check and setup answer for the app window only', async () => {
  const f = makeFakes();
  const s = await start(f.ctx);
  const admin = { Authorization: `Bearer ${TOKEN}`, 'X-Legion-Admin': TEST_ADMIN };
  try {
    const before = await call(s.base, { action: 'check' }, admin);
    assert.equal(before.status, 200);
    assert.equal(before.json.exists, false);
    const up = await call(s.base, { action: 'setup' }, admin);
    assert.equal(up.status, 200);
    assert.equal(up.json.ok, true, String(up.json.detail));
    assert.equal(up.json.signInCommand, 'hermes -p legion setup model');
    const after = await call(s.base, { action: 'check' }, admin);
    assert.equal(after.json.exists, true);
    assert.equal(after.json.policyOk, true);

    assert.equal((await call(s.base, { action: 'setup' }, { Authorization: `Bearer ${TOKEN}` })).status, 403, 'a token-only client may not run it');
    assert.equal((await call(s.base, { action: 'check' }, {})).status, 401);
    assert.equal((await call(s.base, { action: 'nope' }, admin)).status, 400);
    assert.equal((await call(s.base, {}, admin)).status, 400);
  } finally { await s.close(); }
});
