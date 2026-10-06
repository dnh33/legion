/** The Armory is registered in the real core and in the harness core, in the same place, and nothing in the routes widens the MCP client list. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { AUTH } from './helpers-c.js';
import { closeAll, mount } from './token-harness.js';

after(closeAll);
import { gate, isClientRoute } from '../src/core/admin.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/** The module identifiers in `const modules = [...]`, in order (calls reduced to their name). */
function moduleList(src: string): string[] {
  const m = /const modules = \[([^\n]+)\];/.exec(src);
  assert.ok(m, 'no modules list found');
  return [...m![1].matchAll(/(?:\.\.\.)?([A-Za-z]+)(?:\(|\b)/g)].map((x) => x[0].replace(/\($/, '')).filter((x) => !/^(moduleDeps|projects|nativeSecret|log|board|notes)$/.test(x));
}

test('legion-core.ts and the harness core-entry.mjs register the same modules in the same order, with the armory', () => {
  void repo;
  const core = moduleList(read('src/bin/legion-core.ts'));
  const harness = moduleList(read('scripts/harness/core-entry.mjs'));
  assert.deepEqual(core, harness);
  assert.ok(core.includes('armory'), 'armory is registered');
  assert.ok(core.indexOf('armory') > core.indexOf('house'));
});

test('the armory routes are not on the MCP client list', () => {
  for (const [m, p] of [['GET', '/api/armory'], ['POST', '/api/armory/state'], ['POST', '/api/armory/state-bulk'], ['POST', '/api/armory/agents'], ['POST', '/api/armory/notice-seen'], ['POST', '/api/armory/skill'], ['DELETE', '/api/armory/skill'], ['POST', '/api/armory/import'], ['GET', '/api/armory/file'], ['GET', '/api/armory/effective'], ['GET', '/api/armory/effective-all'], ['POST', '/api/house/drill'], ['POST', '/api/house/drill/promote']]) {
    assert.equal(isClientRoute(m, p), false, `${m} ${p}`);
  }
});

test('effective-all is admin-only: the default-deny gate refuses the MCP bearer token and lets the admin key through', () => {
  const g = (adminOk: boolean, bearerOk: boolean) => gate({ method: 'GET', path: '/api/armory/effective-all', adminOk, bearerOk, hasSecret: true });
  assert.equal(isClientRoute('GET', '/api/armory/effective-all'), false, 'not on the client list');
  const token = g(false, true);
  assert.equal(token.allow, false);
  assert.equal(token.allow === false && token.status, 403);
  assert.equal(g(true, true).allow, true);
});

test('the skills setting of an agent is validated and stored: inherit, or a list of ids; anything else is a 400', async () => {
  const m = await mount();
  const ok1 = await m.http('PATCH', '/api/agents/worker', { skills: ['legion-armory:a', 'deep-research', 'legion-armory:a'] }, AUTH);
  assert.equal(ok1.status, 200);
  assert.deepEqual(ok1.json.skills, ['legion-armory:a', 'deep-research'], 'trimmed and de-duplicated');
  assert.equal(m.store.getAgent('worker')!.skills![1], 'deep-research', 'stored on the agent');
  assert.equal((await m.http('PATCH', '/api/agents/worker', { skills: 'inherit' }, AUTH)).json.skills, 'inherit');
  for (const bad of ['all', 7, [1], [''], ['x'.repeat(201)], Array.from({ length: 501 }, (_, i) => `s${i}`)]) {
    const r = await m.http('PATCH', '/api/agents/worker', { skills: bad }, AUTH);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
    assert.match(r.json.error, /skills must be/);
  }
  const created = await m.http('POST', '/api/agents', { name: 'Skilled', skills: ['deep-research'] }, AUTH);
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.skills, ['deep-research']);
  assert.equal((await m.http('PATCH', '/api/agents/worker', { skills: ['x'] })).status, 403, 'the MCP bearer token alone cannot change it');
});
