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
const KEY_A = 'sk-ant-api03-PROVIDERKEY0123456789';
const KEY_B = 'sk-or-v1-OTHERPROVIDERKEY0123456789';

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
  setEnv('ANTHROPIC_API_KEY', undefined);
  setEnv('OPENROUTER_API_KEY', undefined);
});

const calls = (): string[][] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
const makeProfile = () => { mkdirSync(join(state, 'profiles', 'legion'), { recursive: true }); writeFileSync(join(state, 'profiles', 'legion', 'config.json'), '{}'); };
const SHOW = ['profile', 'show', 'legion'];
const CREATE = ['profile', 'create', 'legion', '--no-alias'];
const SET_MODE = ['-p', 'legion', 'config', 'set', 'approvals.mode', 'manual'];
const SET_TOOLS = ['-p', 'legion', 'config', 'set', 'platform_toolsets.acp', '[file]'];
const GET_MODE = ['-p', 'legion', 'config', 'get', 'approvals.mode', '--json'];
const GET_TOOLS = ['-p', 'legion', 'config', 'get', 'platform_toolsets.acp', '--json'];

test('set up from nothing runs exactly these commands, in this order, and never a clone', async () => {
  const r = await setUpContained(BUILTIN_HERMES);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(calls(), [SHOW, CREATE, SET_MODE, SET_TOOLS, GET_MODE, GET_TOOLS]);
  assert.ok(calls().every((c) => !c.some((a) => a.startsWith('--clone'))), 'no clone flag anywhere');
  assert.ok(existsSync(join(state, 'profiles', 'legion')), 'the profile now exists');
  assert.equal(r.signInCommand, 'hermes -p legion setup', 'the sign-in step is shown, not run');
  assert.ok(!calls().some((c) => c.includes('auth') || c.includes('setup')), 'Legion never runs the sign-in');
});

test('an existing legion profile is not created again, but still gets the two settings', async () => {
  makeProfile();
  const r = await setUpContained(BUILTIN_HERMES);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(calls(), [SHOW, SET_MODE, SET_TOOLS, GET_MODE, GET_TOOLS]);
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
  assert.match(ready.detail, /hermes -p legion setup/);
  assert.ok(calls().every((c) => !c.includes('set') && !c.includes('create')), 'a check changes nothing');

  writeFileSync(join(state, 'profiles', 'legion', 'signed-in'), '');
  const signed = await containedStatus(BUILTIN_HERMES);
  assert.equal(signed.signedIn, true);
  assert.equal(signed.policyOk, true);
});

test('no command line carries a provider key or a Legion token, and every argument is one of the fixed ones', async () => {
  setEnv('ANTHROPIC_API_KEY', KEY_A);
  setEnv('OPENROUTER_API_KEY', KEY_B);
  setEnv('LEGION_AUTH_TOKEN', LEGION_TOKEN);
  const up = await setUpContained(BUILTIN_HERMES);
  const st = await containedStatus(BUILTIN_HERMES);
  const text = JSON.stringify([calls(), up, st]);
  for (const secret of [KEY_A, KEY_B, LEGION_TOKEN]) assert.ok(!text.includes(secret), 'a secret reached a command line or an answer');
  const fixed = new Set([SHOW, CREATE, SET_MODE, SET_TOOLS, GET_MODE, GET_TOOLS, ['-p', 'legion', 'auth', 'list']].map((c) => JSON.stringify(c)));
  for (const c of calls()) assert.ok(fixed.has(JSON.stringify(c)), `unexpected command ${JSON.stringify(c)}`);
});

test('every command goes through the agent launch path with the 60 second limit and a neutral folder', async () => {
  const seen: Array<{ command: string; args: string[]; timeoutMs: number; cwd?: string }> = [];
  const run = async (command: string, args: string[], opts: { timeoutMs: number; cwd?: string }) => {
    seen.push({ command, args, timeoutMs: opts.timeoutMs, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    return { code: 0, stdout: args.includes('--json') ? (args.includes('approvals.mode') ? '"manual"' : '["file"]') : '', stderr: '', timedOut: false };
  };
  const r = await setUpContained(BUILTIN_HERMES, { run });
  assert.equal(r.ok, true, r.detail);
  assert.equal(CONTAINED_TIMEOUT_MS, 60_000);
  assert.ok(seen.length === 5 && seen.every((s) => s.command === 'hermes' && s.timeoutMs === 60_000 && typeof s.cwd === 'string'));
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
  assert.equal(signInCommand({ command: 'hermes' }), 'hermes -p legion setup');
  assert.equal(signInCommand({ command: 'C:\\Program Files\\Hermes\\hermes.exe' }), '"C:\\Program Files\\Hermes\\hermes.exe" -p legion setup');
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
    assert.equal(up.json.signInCommand, 'hermes -p legion setup');
    const after = await call(s.base, { action: 'check' }, admin);
    assert.equal(after.json.exists, true);
    assert.equal(after.json.policyOk, true);

    assert.equal((await call(s.base, { action: 'setup' }, { Authorization: `Bearer ${TOKEN}` })).status, 403, 'a token-only client may not run it');
    assert.equal((await call(s.base, { action: 'check' }, {})).status, 401);
    assert.equal((await call(s.base, { action: 'nope' }, admin)).status, 400);
    assert.equal((await call(s.base, {}, admin)).status, 400);
  } finally { await s.close(); }
});
