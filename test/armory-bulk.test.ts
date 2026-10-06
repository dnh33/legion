/**
 * POST /api/armory/state-bulk: many skills, one state, one write. It applies the same rule as the single state route to each id,
 * lists what it refused with the reason, writes armory.json once, and is admin-only (the MCP bearer token alone gets a 403).
 */
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gate, isClientRoute } from '../src/core/admin.js';
import { createArmoryModule, MAX_BULK } from '../src/core/armory/index.js';
import { armoryFilePath } from '../src/core/armory/store.js';
import type { ModuleDeps } from '../src/core/modules.js';
import { tempDir } from './tmp-cleanup.js';
import { AUTH } from './helpers-c.js';
import { closeAll, mount } from './token-harness.js';
import { armoryRig, md, noSdk } from './armory-rig.js';
import type { CcFixture } from './armory-rig.js';

after(closeAll);

const CC: CcFixture = {
  personal: { 'p-one': md('p-one', 'One.'), 'p-two': md('p-two', 'Two.') },
  plugins: [{ key: 'pl@x', name: 'pl', skills: { a: md('a', 'A.'), b: md('b', 'B.') } }],
};
const stateOf = async (r: ReturnType<typeof armoryRig>): Promise<Record<string, string>> =>
  Object.fromEntries((await r.call('GET', '/api/armory')).skills.map((s: any) => [s.id, s.state]));

/** Counts how many times armory.json is swapped in (the one atomic step of a write) while `fn` runs. */
async function armoryWrites<T>(dataDir: string, fn: () => Promise<T>): Promise<{ out: T; writes: number }> {
  const target = armoryFilePath(dataDir);
  const real = fs.renameSync;
  let writes = 0;
  fs.renameSync = ((from: string, to: string) => { if (to === target) writes++; return real(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { return { out: await fn(), writes }; } finally { fs.renameSync = real; syncBuiltinESMExports(); }
}

describe('POST /api/armory/state-bulk', () => {
  it('sets every id in one write and returns them in their new state', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('GET', '/api/armory');
    const { out, writes } = await armoryWrites(r.dataDir, () => r.call('POST', '/api/armory/state-bulk', { ids: ['p-one', 'p-two', 'pl:a', 'pl:b'], state: 'on' }));
    assert.equal(writes, 1, 'one atomic write for four skills');
    assert.deepEqual(out.skills.map((s: any) => s.id), ['p-one', 'p-two', 'pl:a', 'pl:b']);
    assert.ok(out.skills.every((s: any) => s.state === 'on' && s.stateIsDefault === false));
    assert.deepEqual(out.refused, []);
    const now = await stateOf(r);
    assert.deepEqual(['p-one', 'p-two', 'pl:a', 'pl:b'].map((id) => now[id]), ['on', 'on', 'on', 'on']);
    const disk = JSON.parse(readFileSync(armoryFilePath(r.dataDir), 'utf8'));
    assert.equal(disk.skills['pl:a'].state, 'on');
    assert.equal(disk.skills['pl:a'].source, 'claude-plugin');
    assert.equal(disk.skills['pl:a'].plugin, 'pl');
  });

  it('applies the single route\'s rules per id: offReason skills and unknown ids are refused with a reason, the rest goes through', async () => {
    const r = armoryRig({ cc: CC });
    const res = await r.call('POST', '/api/armory/state-bulk', { ids: ['p-one', 'update-config', 'ghost', 'verify'], state: 'on' });
    assert.deepEqual(res.skills.map((s: any) => s.id), ['p-one', 'verify']);
    assert.deepEqual(res.refused.map((x: any) => x.id), ['update-config', 'ghost']);
    assert.match(res.refused[0].reason, /update-config acts on Claude Code itself, so Legion keeps it off\./);
    assert.match(res.refused[1].reason, /No skill with the id ghost\./);
    const now = await stateOf(r);
    assert.equal(now['update-config'], 'off');
    assert.equal(now['p-one'], 'on');
    // the very same message the single route gives for the same skill
    const single = await r.call('POST', '/api/armory/state', { id: 'update-config', state: 'on' }).then(() => '', (e) => e.message as string);
    assert.equal(res.refused[0].reason, single);
    // turning an offReason skill OFF is allowed, as in the single route
    const off = await r.call('POST', '/api/armory/state-bulk', { ids: ['update-config'], state: 'off' });
    assert.deepEqual(off.refused, []);
    assert.equal(off.skills[0].state, 'off');
  });

  it('keeps what the single route keeps: the source, the plugin and a per-agent grant', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('POST', '/api/armory/agents', { id: 'p-one', agents: ['alpha'] });
    await r.call('POST', '/api/armory/state-bulk', { ids: ['p-one'], state: 'manual' });
    const viaBulk = JSON.parse(readFileSync(armoryFilePath(r.dataDir), 'utf8')).skills['p-one'];
    await r.call('POST', '/api/armory/state', { id: 'p-one', state: 'manual' });
    assert.deepEqual(JSON.parse(readFileSync(armoryFilePath(r.dataDir), 'utf8')).skills['p-one'], viaBulk, 'the bulk record is the single record');
    assert.deepEqual(viaBulk.agents, ['alpha']);
  });

  it('writes nothing when every id is refused, and de-duplicates ids', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('GET', '/api/armory');
    const before = readFileSync(armoryFilePath(r.dataDir), 'utf8');
    const { out, writes } = await armoryWrites(r.dataDir, () => r.call('POST', '/api/armory/state-bulk', { ids: ['ghost', 'update-config', 42, ''], state: 'on' }));
    assert.equal(writes, 0);
    assert.equal(readFileSync(armoryFilePath(r.dataDir), 'utf8'), before);
    assert.deepEqual(out.skills, []);
    assert.equal(out.refused.length, 4);
    const dup = await r.call('POST', '/api/armory/state-bulk', { ids: ['p-one', 'p-one', 'p-one'], state: 'on' });
    assert.equal(dup.skills.length, 1);
    const none = await armoryWrites(r.dataDir, () => r.call('POST', '/api/armory/state-bulk', { ids: [], state: 'on' }));
    assert.equal(none.writes, 0);
    assert.deepEqual(none.out, { skills: [], refused: [] });
  });

  it('refuses a bad body with a 400: no state, a state that is not one of the three, ids that are not a list, more than the maximum', async () => {
    const r = armoryRig({ cc: CC });
    const fail = async (body: unknown): Promise<{ status: number; message: string }> =>
      r.call('POST', '/api/armory/state-bulk', body).then(() => ({ status: 200, message: '' }), (e) => ({ status: e.status as number, message: e.message as string }));
    assert.equal((await fail(null)).status, 400);
    assert.equal((await fail({ ids: ['p-one'] })).status, 400);
    assert.match((await fail({ ids: ['p-one'], state: 'maybe' })).message, /state must be one of: on, manual, off/);
    assert.equal((await fail({ ids: 'p-one', state: 'on' })).status, 400);
    assert.equal((await fail({ state: 'on' })).status, 400);
    const big = await fail({ ids: Array.from({ length: MAX_BULK + 1 }, (_, i) => `s${i}`), state: 'on' });
    assert.equal(big.status, 400);
    assert.match(big.message, /at most 1000/);
    assert.equal(MAX_BULK, 1000);
    // exactly the maximum is fine: every id is unknown, so all are refused, but the request is accepted
    const edge = await r.call('POST', '/api/armory/state-bulk', { ids: Array.from({ length: MAX_BULK }, (_, i) => `s${i}`), state: 'on' });
    assert.equal(edge.refused.length, MAX_BULK);
    assert.equal((await stateOf(r))['p-one'], 'off', 'a refused body changed nothing');
  });

  it('a failure while writing changes nothing: the old file is kept and the error comes out', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('GET', '/api/armory');
    const before = readFileSync(armoryFilePath(r.dataDir), 'utf8');
    const real = fs.renameSync;
    fs.renameSync = (() => { throw new Error('disk is full'); }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => r.call('POST', '/api/armory/state-bulk', { ids: ['p-one', 'p-two'], state: 'on' }), /disk is full/);
    } finally { fs.renameSync = real; syncBuiltinESMExports(); }
    assert.equal(readFileSync(armoryFilePath(r.dataDir), 'utf8'), before, 'all or nothing');
  });

  it('is admin-only: not on the MCP client list, 403 for the bearer token alone, allowed with the admin secret', async () => {
    assert.equal(isClientRoute('POST', '/api/armory/state-bulk'), false);
    assert.equal(gate({ method: 'POST', path: '/api/armory/state-bulk', adminOk: false, bearerOk: true, hasSecret: true }).allow, false);
    const dataDir = tempDir('legion-armory-bulk-');
    const home = tempDir('legion-cchome-');
    const m = await mount(undefined, { extraModules: (deps: ModuleDeps) => [createArmoryModule({ ...deps, dataDir } as ModuleDeps, { claudeHome: home, sdkProbe: noSdk })] });
    const body = { ids: ['verify'], state: 'on' };
    const denied = await m.http('POST', '/api/armory/state-bulk', body);
    assert.equal(denied.status, 403, 'the MCP bearer token alone cannot change skills in bulk');
    assert.equal(denied.json.error, 'admin_required');
    const allowed = await m.http('POST', '/api/armory/state-bulk', body, AUTH);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.skills[0].state, 'on');
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'armory', 'armory.json'), 'utf8')).skills.verify.state, 'on');
  });
});
