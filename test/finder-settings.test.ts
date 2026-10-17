/**
 * The skill finder's owner settings (armory.json `finder`) and the per-agent override (AgentProfile.skillFinder, skillFinderK):
 * the defaults, clamping on read, the admin route as a partial patch, and the merge a run uses.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { armoryRig, mkAgent } from './armory-rig.js';
import { isClientRoute, gate } from '../src/core/admin.js';
import { armoryFilePath, readArmoryFile } from '../src/core/armory/store.js';
import { FINDER_DEFAULTS, cleanFinder, finderFor } from '../src/core/armory/finder/settings.js';
import { AUTH } from './helpers-c.js';
import { closeAll, mount } from './token-harness.js';

after(closeAll);

test('defaults: a fresh Armory reports the full finder block, and the defaults are never written to armory.json', async () => {
  const rig = armoryRig();
  const out = await rig.call('GET', '/api/armory');
  assert.deepEqual(out.finder, {
    suggest: true, searchTool: true, subagents: true, ranker: 'keyword', rerank: false, rerankMonthlyUsd: 1,
    slimListing: false, k: 3, threshold: 'balanced', chatLine: true, noticeSeen: false,
  });
  assert.deepEqual(FINDER_DEFAULTS, out.finder);
  const onDisk = JSON.parse(readFileSync(armoryFilePath(rig.dataDir), 'utf8'));
  assert.equal(onDisk.finder, undefined, 'a default is computed on read, not stored');
});

test('cleanFinder keeps only known keys with the right types, and clamps k and the monthly cap', () => {
  assert.deepEqual(cleanFinder({ k: 99, rerankMonthlyUsd: 500 }), { k: 5, rerankMonthlyUsd: 50 });
  assert.deepEqual(cleanFinder({ k: 0, rerankMonthlyUsd: -3 }), { k: 1, rerankMonthlyUsd: 0 });
  assert.deepEqual(cleanFinder({ k: 2.6 }), { k: 3 }, 'k is a whole number');
  assert.deepEqual(cleanFinder({ ranker: 'local', providerId: 'x'.repeat(121), providerModel: 'm', chatLine: false }), { ranker: 'local', providerModel: 'm', chatLine: false }, 'a 121-character provider id is dropped');
  assert.equal(cleanFinder({ k: 'four', suggest: 'yes', ranker: 'magic', threshold: 'loose', chatLine: 0, nope: true }), undefined, 'nothing valid survives');
  assert.equal(cleanFinder({ k: Number.NaN, rerankMonthlyUsd: Number.POSITIVE_INFINITY }), undefined, 'NaN and Infinity are not numbers here');
  assert.equal(cleanFinder(['k']), undefined);
  assert.equal(cleanFinder(null), undefined);
});

test('armory.json: a hand-edited finder block is cleaned when it is read', () => {
  const rig = armoryRig();
  mkdirSync(join(rig.dataDir, 'armory'), { recursive: true });
  writeFileSync(armoryFilePath(rig.dataDir), JSON.stringify({ version: 1, migrations: [], skills: {}, finder: { k: 42, ranker: 'local', junk: 1 } }));
  assert.deepEqual(readArmoryFile(rig.dataDir).finder, { k: 5, ranker: 'local' });
});

test('POST /api/armory/finder is a partial patch: it merges, stores only what was sent, and returns the full block', async () => {
  const rig = armoryRig();
  const first = await rig.call('POST', '/api/armory/finder', { ranker: 'local' });
  assert.deepEqual(first, { ...FINDER_DEFAULTS, ranker: 'local' });
  const second = await rig.call('POST', '/api/armory/finder', { threshold: 'eager', providerId: 'openai-main' });
  assert.deepEqual(second, { ...FINDER_DEFAULTS, ranker: 'local', threshold: 'eager', providerId: 'openai-main' }, 'the first patch is kept');
  const onDisk = JSON.parse(readFileSync(armoryFilePath(rig.dataDir), 'utf8'));
  assert.deepEqual(onDisk.finder, { ranker: 'local', threshold: 'eager', providerId: 'openai-main' }, 'only the keys sent are stored');
  const cleared = await rig.call('POST', '/api/armory/finder', { providerId: '' });
  assert.equal('providerId' in cleared, false, 'an empty provider id removes the key');
  const clamped = await rig.call('POST', '/api/armory/finder', { k: 9, rerankMonthlyUsd: 75 });
  assert.equal(clamped.k, 5);
  assert.equal(clamped.rerankMonthlyUsd, 50);
});

test('POST /api/armory/finder refuses an unknown key or a bad type with a 400 that names the field, and writes nothing', async () => {
  const rig = armoryRig();
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ turbo: true }, 'turbo'],
    [{ suggest: 'yes' }, 'suggest'],
    [{ ranker: 'magic' }, 'ranker'],
    [{ threshold: 'loose' }, 'threshold'],
    [{ k: 'three' }, 'k'],
    [{ k: Number.NaN }, 'k'],
    [{ rerankMonthlyUsd: '1' }, 'rerankMonthlyUsd'],
    [{ providerId: 'x'.repeat(121) }, 'providerId'],
    [{ providerModel: 5 }, 'providerModel'],
  ];
  for (const [body, field] of bad) {
    await assert.rejects(
      rig.call('POST', '/api/armory/finder', body),
      (e: { status?: number; message?: string }) => e.status === 400 && (e.message ?? '').includes(field),
      `${JSON.stringify(body).slice(0, 60)} should be a 400 naming ${field}`,
    );
  }
  assert.equal(readArmoryFile(rig.dataDir).finder, undefined, 'a refused patch changes nothing');
});

test('the finder route is admin-only: not on the client list, and the bearer token alone is refused', () => {
  assert.equal(isClientRoute('POST', '/api/armory/finder'), false);
  const token = gate({ method: 'POST', path: '/api/armory/finder', adminOk: false, bearerOk: true, hasSecret: true });
  assert.equal(token.allow, false);
  assert.equal(gate({ method: 'POST', path: '/api/armory/finder', adminOk: true, bearerOk: true, hasSecret: true }).allow, true);
});

test('finderFor: the owner settings, then the per-agent override (off, on, and the k override)', () => {
  const file = { finder: { suggest: false, k: 2, ranker: 'local' as const } };
  const owner = { ...FINDER_DEFAULTS, suggest: false, k: 2, ranker: 'local' as const };
  assert.deepEqual(finderFor(file), owner);
  assert.deepEqual(finderFor(file, mkAgent('a')), owner, 'an agent with no override inherits');
  assert.deepEqual(finderFor(file, mkAgent('a', { skillFinder: 'inherit' })), owner);
  assert.deepEqual(finderFor(file, mkAgent('a', { skillFinder: 'off' })), { ...owner, searchTool: false, subagents: false }, 'off disables suggest, search and subagents for this agent');
  assert.equal(finderFor(file, mkAgent('a', { skillFinder: 'on' })).suggest, true, 'on forces suggest on, even when the owner has it off');
  assert.equal(finderFor(file, mkAgent('a', { skillFinder: 'on' })).searchTool, true, 'on changes nothing else');
  assert.equal(finderFor(file, mkAgent('a', { skillFinderK: 5 })).k, 5, 'skillFinderK overrides k');
  assert.equal(finderFor(file, mkAgent('a', { skillFinder: 'off', skillFinderK: 4 })).k, 4);
  assert.deepEqual(finderFor({}), FINDER_DEFAULTS);
});

test('agent settings: skillFinder is inherit, on or off; skillFinderK is a whole number from 1 to 5, and null clears it', async () => {
  const m = await mount();
  const ok = await m.http('PATCH', '/api/agents/worker', { skillFinder: 'off', skillFinderK: 4 }, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.skillFinder, 'off');
  assert.equal(ok.json.skillFinderK, 4);
  assert.equal(m.store.getAgent('worker')!.skillFinderK, 4, 'stored on the agent');
  const kept = await m.http('PATCH', '/api/agents/worker', { description: 'still here' }, AUTH);
  assert.equal(kept.json.skillFinder, 'off', 'a patch without the fields leaves them alone');
  assert.equal(kept.json.skillFinderK, 4);
  const cleared = await m.http('PATCH', '/api/agents/worker', { skillFinderK: null }, AUTH);
  assert.equal(cleared.status, 200);
  assert.equal('skillFinderK' in cleared.json, false, 'null removes the override');
  assert.equal(cleared.json.skillFinder, 'off');
  for (const [body, field] of [
    [{ skillFinder: 'maybe' }, 'skillFinder'],
    [{ skillFinderK: 0 }, 'skillFinderK'],
    [{ skillFinderK: 6 }, 'skillFinderK'],
    [{ skillFinderK: 2.5 }, 'skillFinderK'],
    [{ skillFinderK: '3' }, 'skillFinderK'],
  ] as const) {
    const r = await m.http('PATCH', '/api/agents/worker', body, AUTH);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(String(r.json.error), new RegExp(field));
  }
  const created = await m.http('POST', '/api/agents', { name: 'Finder', skillFinder: 'on', skillFinderK: 2 }, AUTH);
  assert.equal(created.status, 201);
  assert.equal(created.json.skillFinder, 'on');
  assert.equal(created.json.skillFinderK, 2);
});
