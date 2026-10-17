/** The Armory's finder test box (POST /api/armory/finder/test) and the rerank spend line (GET /api/armory/finder/rerank-spend). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gate, isClientRoute } from '../src/core/admin.js';
import { monthKey, spendFilePath } from '../src/core/armory/finder/rerank.js';
import { armoryRig, md, own } from './armory-rig.js';
import type { CcFixture } from './armory-rig.js';

const CC: CcFixture = { plugins: [{ key: 'sp@m', name: 'sp', skills: { 'invoice-audit': md('invoice-audit', 'SECRETDESC audit invoices export pdf accounting') } }] };
const QUERY = 'please export the invoices to pdf for accounting';

async function rigWith() {
  const rig = armoryRig({ cc: CC });
  await own(rig, { name: 'invoice-pdf-export', description: 'Export invoices to PDF documents for accounting', body: 'b' });
  for (const n of ['garden-notes', 'travel-plan', 'recipe-card']) await own(rig, { name: n, description: `Helps with ${n} things`, body: 'b' });
  await rig.call('POST', '/api/armory/state', { id: 'sp:invoice-audit', state: 'on' });
  const man = await rig.call('POST', '/api/armory/skill', { name: 'manual-invoice-export', description: 'Export invoices to PDF for accounting', body: 'b' });
  await rig.call('POST', '/api/armory/state', { id: man.id, state: 'manual' });
  await rig.call('POST', '/api/armory/skill', { name: 'off-invoice-export', description: 'Export invoices to PDF for accounting', body: 'b' });
  return rig;
}
const rejects = async (p: Promise<unknown>, status: number, re: RegExp): Promise<void> => {
  await assert.rejects(p, (e: Error & { status?: number }) => e.status === status && re.test(e.message));
};

describe('the finder test box', () => {
  it('is admin-only: not on the client list, and the bearer token alone is refused', () => {
    for (const [method, path] of [['POST', '/api/armory/finder/test'], ['GET', '/api/armory/finder/rerank-spend']]) {
      assert.equal(isClientRoute(method!, path!), false, `${method} ${path}`);
      assert.equal(gate({ method: method!, path: path!, adminOk: false, bearerOk: true, hasSecret: true }).allow, false);
      assert.equal(gate({ method: method!, path: path!, adminOk: true, bearerOk: true, hasSecret: true }).allow, true);
    }
  });

  it('ranks exactly as armory_find does for the same agent and message (same ids, order and scores)', async () => {
    const rig = await rigWith();
    const out = await rig.call('POST', '/api/armory/finder/test', { query: QUERY, agent: 'alpha' });
    const find = (rig.mod.mcpServers!(rig.agents.get('alpha')!, undefined) as any).legion_armory.instance._registeredTools.armory_find.handler;
    const text: string = (await find({ query: QUERY, limit: 10 }, {})).content[0].text;
    const fromFind = [...text.matchAll(/^- (\S+) \((?:third-party|(\d+\.\d+))\)/gm)].map((m) => ({ id: m[1]!, score: m[2] }));
    assert.deepEqual(out.rows.map((r: any) => r.id), fromFind.map((r) => r.id));
    assert.equal(out.rows[0].id, 'legion-armory:invoice-pdf-export');
    for (const [i, r] of fromFind.entries()) if (r.score) assert.equal(out.rows[i].score.toFixed(2), r.score);
    const top = out.rows[0];
    assert.ok(top.bm25 > 0 && top.boost === 1 && top.matched.includes('invoice'));
    assert.equal(top.cosine, undefined, 'the keyword ranker has no cosine');
  });

  it('lists only skills that are on for the agent, and a third-party skill by id only', async () => {
    const rig = await rigWith();
    const out = await rig.call('POST', '/api/armory/finder/test', { query: QUERY, agent: 'alpha' });
    const ids: string[] = out.rows.map((r: any) => r.id);
    assert.ok(ids.includes('sp:invoice-audit'));
    assert.ok(!ids.some((i) => /manual-invoice|off-invoice/.test(i)));
    assert.doesNotMatch(JSON.stringify(out), /SECRETDESC/);
    const third = out.rows.find((r: any) => r.id === 'sp:invoice-audit');
    assert.equal(third.thirdParty, true);
    assert.equal(third.description, undefined);
  });

  it('without an agent, ranks the skills that are on in the Armory', async () => {
    const rig = await rigWith();
    const out = await rig.call('POST', '/api/armory/finder/test', { query: QUERY });
    assert.equal(out.scope, 'on');
    assert.ok(out.rows.some((r: any) => r.id === 'legion-armory:invoice-pdf-export'));
    assert.ok(!out.rows.some((r: any) => /manual-invoice|off-invoice/.test(r.id)));
  });

  it('answers 400 to an empty message, 404 to an unknown agent', async () => {
    const rig = await rigWith();
    await rejects(rig.call('POST', '/api/armory/finder/test', { query: '   ' }), 400, /^Type a message to test$/);
    await rejects(rig.call('POST', '/api/armory/finder/test', {}), 400, /^Type a message to test$/);
    await rejects(rig.call('POST', '/api/armory/finder/test', { query: 'x y', agent: 'nobody' }), 404, /Unknown agent/);
  });

  it('keeps at most 10 rows', async () => {
    const rig = armoryRig();
    for (let i = 0; i < 14; i++) await own(rig, { name: `report-tool-${i}`, description: 'Builds the quarterly report', body: 'b' });
    const out = await rig.call('POST', '/api/armory/finder/test', { query: 'quarterly report', agent: 'alpha' });
    assert.equal(out.rows.length, 10);
  });

  it('without an agent, lists only what the Claude path would deliver: a bare skill shadowed by a plugin skill that is off is left out', async () => {
    const rig = armoryRig({ cc: { personal: { 'invoice-audit': md('invoice-audit', 'Audit invoices and export accounting') }, plugins: [{ key: 'sp@m', name: 'sp', skills: { 'invoice-audit': md('invoice-audit', 'Audit invoices and export accounting') } }] } });
    await own(rig, { name: 'invoice-pdf-export', description: 'Export invoices to PDF documents for accounting', body: 'b' });
    await rig.call('POST', '/api/armory/state', { id: 'invoice-audit', state: 'on' });
    await rig.call('POST', '/api/armory/state', { id: 'sp:invoice-audit', state: 'off' });
    const out = await rig.call('POST', '/api/armory/finder/test', { query: 'audit invoices export accounting' });
    const ids: string[] = out.rows.map((r: any) => r.id);
    assert.ok(ids.includes('legion-armory:invoice-pdf-export'));
    assert.ok(!ids.includes('invoice-audit') && !ids.includes('sp:invoice-audit'), ids.join(','));
    const forAgent = await rig.call('POST', '/api/armory/finder/test', { query: 'audit invoices export accounting', agent: 'alpha' });
    assert.deepEqual(out.rows.map((r: any) => r.id), forAgent.rows.map((r: any) => r.id), 'the same set an agent with no limits gets');
  });

  it('returns no rows, not an error, when nothing matches', async () => {
    const rig = await rigWith();
    const out = await rig.call('POST', '/api/armory/finder/test', { query: 'zebra quantum yodel' });
    assert.deepEqual(out.rows, []);
  });
});

describe('the rerank spend line', () => {
  it('reads this month from the same file the rerank writes, with the cap', async () => {
    const rig = armoryRig();
    const month = monthKey(new Date());
    assert.deepEqual(await rig.call('GET', '/api/armory/finder/rerank-spend'), { month, spentUsd: 0, capUsd: 1 });
    mkdirSync(dirname(spendFilePath(rig.dataDir)), { recursive: true });
    writeFileSync(spendFilePath(rig.dataDir), JSON.stringify({ [month]: 0.42, '2000-01': 9 }));
    await rig.call('POST', '/api/armory/finder', { rerankMonthlyUsd: 3 });
    assert.deepEqual(await rig.call('GET', '/api/armory/finder/rerank-spend'), { month, spentUsd: 0.42, capUsd: 3 });
  });
});

describe('the finder settings read route', () => {
  it('is admin-only like the write route, and answers the same block the Armory shows', async () => {
    assert.equal(isClientRoute('GET', '/api/armory/finder'), false);
    assert.equal(gate({ method: 'GET', path: '/api/armory/finder', adminOk: false, bearerOk: true, hasSecret: true }).allow, false);
    assert.equal(gate({ method: 'GET', path: '/api/armory/finder', adminOk: true, bearerOk: true, hasSecret: true }).allow, true);
    const rig = armoryRig({});
    assert.equal((await rig.call('GET', '/api/armory/finder')).chatLine, true);
    await rig.call('POST', '/api/armory/finder', { chatLine: false });
    const after = await rig.call('GET', '/api/armory/finder');
    assert.equal(after.chatLine, false);
    assert.deepEqual(after, (await rig.call('GET', '/api/armory')).finder);
  });
});
