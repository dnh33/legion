import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/core/doctor.js';
import { defaultConfig } from '../src/shared/config.js';
import type { QueryFn } from '../src/core/engine.js';

function cfg() {
  const c = defaultConfig();
  c.workspaceDir = join(mkdtempSync(join(tmpdir(), 'legion-doc-')), 'ws');
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
  assert.equal(claude.ok, true);
  assert.match(claude.detail, /a@b\.c/);
  assert.match(claude.detail, /max/);
  assert.equal(seen.closed, 1);
  assert.equal(seen.opts.env.ANTHROPIC_API_KEY, undefined);
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
