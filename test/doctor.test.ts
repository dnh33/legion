import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/core/doctor.js';
import { defaultConfig } from '../src/shared/config.js';
import type { QueryFn } from '../src/core/engine.js';

// The Doctor reads the Claude Code settings the runs load: point it at an empty temp folder, never the real one.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'legion-doc-home-'));

function cfg() {
  const c = defaultConfig();
  c.workspaceDir = join(cleanupTemp('legion-doc-'), 'ws');
  return c;
}
const fakeQuery = (accountInfo: () => Promise<unknown>, seen?: { closed: number; opts?: any }): QueryFn =>
  ((params: any) => {
    if (seen) seen.opts = params.options;
    return { accountInfo, interrupt: async () => undefined, close: () => { if (seen) seen.closed++; } };
  }) as unknown as QueryFn;

test('doctor reports signed-in account', async () => {
  const seen = { closed: 0 } as { closed: number; opts?: any };
  const checks = await runDoctor({
    config: cfg(), getBoat: () => null,
    queryFn: fakeQuery(async () => ({ email: 'a@b.c', subscriptionType: 'max' }), seen),
  });
  const claude = checks.find((c) => c.id === 'claude')!;
  assert.equal(seen.opts.permissionMode, 'default');
  assert.equal(seen.opts.persistSession, false);
  assert.equal(claude.ok, true);
  assert.match(claude.detail, /a@b\.c/);
  assert.match(claude.detail, /max/);
  assert.equal(seen.closed, 1);
  assert.equal(seen.opts.env.ANTHROPIC_API_KEY, '');
  assert.equal(checks.find((c) => c.id === 'workspace')!.ok, true);
  assert.equal(checks.find((c) => c.id === 'boat')!.ok, true);
});

test('doctor with failing probe never throws', async () => {
  const checks = await runDoctor({
    config: cfg(), getBoat: () => null,
    queryFn: fakeQuery(async () => { throw new Error('not logged in'); }),
  });
  const claude = checks.find((c) => c.id === 'claude')!;
  assert.equal(claude.ok, false);
  assert.match(claude.detail, /not logged in/);
  assert.match(claude.fix!, /\/login/);
});

test('doctor: queryFn that throws synchronously, and hanging probe times out', async () => {
  let checks = await runDoctor({ config: cfg(), getBoat: () => null, queryFn: (() => { throw new Error('spawn failed'); }) as unknown as QueryFn });
  assert.equal(checks.find((c) => c.id === 'claude')!.ok, false);
  checks = await runDoctor({ config: cfg(), getBoat: () => null, probeTimeoutMs: 30, queryFn: fakeQuery(() => new Promise(() => undefined)) });
  const c = checks.find((x) => x.id === 'claude')!;
  assert.equal(c.ok, false);
  assert.match(c.detail, /timed out/);
});

test('doctor: empty account info in login mode is not signed in; api-key mode without key fails', async () => {
  let checks = await runDoctor({ config: cfg(), getBoat: () => null, queryFn: fakeQuery(async () => ({})) });
  assert.equal(checks.find((c) => c.id === 'claude')!.ok, false);
  const c = cfg();
  c.claude.auth = 'api-key';
  checks = await runDoctor({ config: c, getBoat: () => null, queryFn: fakeQuery(async () => ({ apiKeySource: 'x' })) });
  assert.equal(checks.find((x) => x.id === 'auth')!.ok, false);
});

test('doctor: boat failure is reported, not thrown', async () => {
  const checks = await runDoctor({
    config: cfg(), queryFn: fakeQuery(async () => ({ email: 'e' })),
    getBoat: () => ({ me: async () => { throw new Error('401 bad key'); } }) as any,
  });
  const boat = checks.find((c) => c.id === 'boat')!;
  assert.equal(boat.ok, false);
  assert.match(boat.detail, /401/);
});

test('doctor shows the bundled Claude Code version from the initialize response, and still passes without it', async () => {
  const mk = (init?: () => Promise<unknown>): QueryFn => ((_p: any) => ({
    accountInfo: async () => ({ email: 'a@b.c' }), ...(init ? { initializationResult: init } : {}),
    interrupt: async () => undefined, close: () => undefined,
  })) as unknown as QueryFn;
  const detail = async (q: QueryFn) => (await runDoctor({ config: cfg(), getBoat: () => null, queryFn: q })).find((c) => c.id === 'claude')!;
  const withV = await detail(mk(async () => ({ claude_code_version: '2.1.296' })));
  assert.equal(withV.ok, true);
  assert.match(withV.detail, /a@b\.c, Claude Code 2\.1\.296/);
  assert.equal((await detail(mk())).detail, 'a@b.c');
  const broken = await detail(mk(async () => { throw new Error('closed'); }));
  assert.equal(broken.ok, true);
  assert.equal(broken.detail, 'a@b.c');
});

// A Console (API-billed) login passes the email check but bills API credits on every run.
test('doctor: Console login (API key source) is flagged; a Claude plan stays ok', async () => {
  let checks = await runDoctor({ config: cfg(), getBoat: () => null, queryFn: fakeQuery(async () => ({ email: 'a@b.c', apiKeySource: '/login managed key' })) });
  let c = checks.find((x) => x.id === 'claude')!;
  assert.equal(c.ok, false);
  assert.match(c.detail, /Runs would bill API credits \(key source: \/login managed key\), so Legion will not start them/);
  assert.match(c.fix!, /\/logout, then \/login/);
  checks = await runDoctor({ config: cfg(), getBoat: () => null, queryFn: fakeQuery(async () => ({ email: 'a@b.c', subscriptionType: 'max', apiKeySource: 'ANTHROPIC_API_KEY' })) });
  assert.equal(checks.find((x) => x.id === 'claude')!.ok, false, 'an API key wins over the plan');
  checks = await runDoctor({ config: cfg(), getBoat: () => null, queryFn: fakeQuery(async () => ({ email: 'a@b.c', subscriptionType: 'max', apiKeySource: 'none' })) });
  c = checks.find((x) => x.id === 'claude')!;
  assert.equal(c.ok, true);
});

async function withClaudeHome(settings: string | undefined, fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-doc-claude-'));
  const save = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), settings);
    await fn(dir);
  } finally {
    if (save === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = save;
    rmSync(dir, { recursive: true, force: true });
  }
}
const planQuery = () => fakeQuery(async () => ({ email: 'a@b.c', subscriptionType: 'max', apiKeySource: 'none' }));

test('doctor: an API key in the Claude Code settings is named (never its value) once API billing is allowed; plan only blanks it', async () => {
  const allow = () => { const c = cfg(); c.claude.allowApiBilling = true; return c; };
  await withClaudeHome(JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-secret-value' } }), async () => {
    const c = (await runDoctor({ config: allow(), getBoat: () => null, queryFn: planQuery() })).find((x) => x.id === 'claude')!;
    assert.equal(c.ok, true);
    assert.match(c.detail, /Your Claude Code settings set ANTHROPIC_API_KEY; runs bill it, as you allowed in Settings/);
    assert.doesNotMatch(JSON.stringify(c), /sk-secret-value/);
    const p = (await runDoctor({ config: cfg(), getBoat: () => null, queryFn: planQuery() })).find((x) => x.id === 'claude')!;
    assert.equal(p.ok, true, 'plan only: the key is blanked for runs, so it is not a problem');
  });
  await withClaudeHome(JSON.stringify({ apiKeyHelper: '/bin/get-key' }), async () => {
    const c = (await runDoctor({ config: allow(), getBoat: () => null, queryFn: planQuery() })).find((x) => x.id === 'claude')!;
    assert.equal(c.ok, true);
    assert.match(c.detail, /set apiKeyHelper/);
    assert.doesNotMatch(JSON.stringify(c), /get-key/);
  });
  await withClaudeHome(JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-x' } }), async () => {
    const config = allow();
    config.claude.inheritClaudeCodeSettings = false;
    const c = (await runDoctor({ config, getBoat: () => null, queryFn: planQuery() })).find((x) => x.id === 'claude')!;
    assert.doesNotMatch(c.detail, /ANTHROPIC_API_KEY/, 'settings the runs do not load are not read');
  });
});

test('doctor: corrupt or missing Claude Code settings do not throw or flag', async () => {
  for (const body of ['{ not json', undefined, '[]', JSON.stringify({ env: { ANTHROPIC_API_KEY: '' } })]) {
    await withClaudeHome(body, async () => {
      const c = (await runDoctor({ config: cfg(), getBoat: () => null, queryFn: planQuery() })).find((x) => x.id === 'claude')!;
      assert.equal(c.ok, true, String(body));
    });
  }
});
