/** What the engine hands a Claude run (an explicit skills list, the plugin folder) and the /command refusal. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EngineError } from '../src/core/engine.js';
import { deliveryRoot } from '../src/core/armory/delivery.js';
import { init, mkAgent, ok, setup, waitDone } from './library-fakes.js';
import { armoryRig, own, md } from './armory-rig.js';
import type { CcFixture } from './armory-rig.js';

const CC: CcFixture = { personal: { 'my-skill': md('my-skill', 'Mine.') }, plugins: [{ key: 'sp@m', name: 'sp', skills: { tdd: md('tdd', 'Tests.') } }] };

async function run(o: { cc?: CcFixture; agents?: ReturnType<typeof mkAgent>[]; prep?: (r: ReturnType<typeof armoryRig>) => Promise<void> } = {}) {
  const rig = armoryRig({ cc: o.cc ?? CC });
  await o.prep?.(rig);
  const s = setup((c) => (async function* () { yield init('s' + c.n); yield ok('done', 's' + c.n); })(), { modules: [rig.mod], ...(o.agents ? { agents: o.agents } : {}) });
  return { rig, s, start: async (agent: string, prompt = 'go') => waitDone(s, s.engine.startTask({ agentId: agent, prompt, source: 'ui' })) };
}
const optionsOf = (s: ReturnType<typeof setup>, agent: string) => s.calls.filter((c) => c.agent === agent).at(-1)!.options;

describe('the skills list a Claude run gets', () => {
  it('is an explicit array on every run: [] with no module and [] when nothing is on, never undefined', async () => {
    const bare = setup((c) => (async function* () { yield init('s'); yield ok('d', 's'); })());
    await waitDone(bare, bare.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.deepEqual(optionsOf(bare, 'alpha').skills, []);
    assert.ok(!('plugins' in optionsOf(bare, 'alpha')), 'no plugin folder when there is no Armory skill');

    const r = await run();
    await r.start('alpha');
    const o = optionsOf(r.s, 'alpha');
    assert.ok(Array.isArray(o.skills), 'skills is passed');
    assert.deepEqual(o.skills, [], 'everything from Claude Code starts off');
  });

  it('lists the skills that are on (Armory and Claude Code) and the Armory plugin folder', async () => {
    const r = await run({ prep: async (x) => {
      await own(x, { name: 'mine', description: 'd', body: 'b' });
      await x.call('POST', '/api/armory/state', { id: 'my-skill', state: 'on' });
      await x.call('POST', '/api/armory/state', { id: 'sp:tdd', state: 'on' });
      await x.call('POST', '/api/armory/state', { id: 'deep-research', state: 'on' });
    } });
    await r.start('alpha');
    const o = optionsOf(r.s, 'alpha');
    assert.deepEqual([...o.skills].sort(), ['deep-research', 'legion-armory:mine', 'my-skill', 'sp:tdd']);
    assert.deepEqual(o.plugins, [{ type: 'local', path: deliveryRoot(r.rig.dataDir) }]);
  });

  it('leaves a manual skill and an off skill off the list, but keeps the plugin folder so /name still runs', async () => {
    const r = await run({ prep: async (x) => {
      await own(x, { name: 'm', description: 'd', body: 'b' });
      await x.call('POST', '/api/armory/state', { id: 'legion-armory:m', state: 'manual' });
      await own(x, { name: 'o', description: 'd', body: 'b' });
      await x.call('POST', '/api/armory/state', { id: 'legion-armory:o', state: 'off' });
    } });
    await r.start('alpha');
    const o = optionsOf(r.s, 'alpha');
    assert.deepEqual(o.skills, []);
    assert.equal(o.plugins.length, 1);
  });

  it('per agent: inherit gets every skill on for it, an explicit list only narrows, and the agents list of a skill restricts', async () => {
    const agents = [mkAgent('alpha', 'Alpha'), mkAgent('beta', 'Beta'), { ...mkAgent('gamma', 'Gamma'), skills: ['legion-armory:off-one', 'legion-armory:a'] }];
    const r = await run({ agents, prep: async (x) => {
      for (const n of ['a', 'b', 'c', 'off-one']) await own(x, { name: n, description: 'd', body: 'b' });
      await x.call('POST', '/api/armory/state', { id: 'legion-armory:off-one', state: 'off' });
      await x.call('POST', '/api/armory/agents', { id: 'legion-armory:b', agents: ['alpha'] });
    } });
    await r.start('alpha'); await r.start('beta'); await r.start('gamma');
    assert.deepEqual([...optionsOf(r.s, 'alpha').skills].sort(), ['legion-armory:a', 'legion-armory:b', 'legion-armory:c']);
    assert.deepEqual([...optionsOf(r.s, 'beta').skills].sort(), ['legion-armory:a', 'legion-armory:c'], 'b is limited to alpha');
    assert.deepEqual(optionsOf(r.s, 'gamma').skills, ['legion-armory:a'], 'a list narrows (no c, no b) and never turns an off skill on');
  });

  it('hides Claude Code personal and plugin skills when claude.inheritClaudeCodeSettings is off, even if they were on', async () => {
    const r = await run({ prep: async (x) => { await x.call('POST', '/api/armory/state', { id: 'my-skill', state: 'on' }); x.config.claude.inheritClaudeCodeSettings = false; } });
    await r.start('alpha');
    assert.deepEqual(optionsOf(r.s, 'alpha').skills, []);
  });
});

describe('a /command for a skill that is off is refused', () => {
  const prep = async (x: ReturnType<typeof armoryRig>) => {
    await own(x, { name: 'on-one', description: 'd', body: 'b' });
    await own(x, { name: 'manual-one', description: 'd', body: 'b' });
    await x.call('POST', '/api/armory/state', { id: 'legion-armory:manual-one', state: 'manual' });
    await own(x, { name: 'off-one', description: 'd', body: 'b' });
    await x.call('POST', '/api/armory/state', { id: 'legion-armory:off-one', state: 'off' });
  };

  it('refuses off with a 400 and a plain message, and queues nothing', async () => {
    const r = await run({ prep });
    for (const text of ['/legion-armory:off-one now', '  /legion-armory:off-one', '/opus /legion-armory:off-one go', '/debug please', '/sp:tdd']) {
      let err: unknown;
      try { r.s.engine.startTask({ agentId: 'alpha', prompt: text, source: 'ui' }); } catch (e) { err = e; }
      assert.ok(err instanceof EngineError, `${text} was accepted`);
      assert.equal((err as EngineError).status, 400);
      assert.match((err as EngineError).message, /switched off in the Armory/);
    }
    assert.equal(r.s.store.listTasks().length, 0);
  });

  it('lets manual and on through, and ordinary text and Claude Code\'s own commands', async () => {
    const r = await run({ prep });
    await r.start('alpha', '/legion-armory:manual-one go');
    await r.start('alpha', '/legion-armory:on-one go');
    await r.start('alpha', '/compact');
    await r.start('alpha', 'use /debug as a word in the middle');
    await r.start('alpha', '/sonnet hello');
    assert.equal(r.s.store.listTasks().length, 5);
  });

  it('also refuses a continued task and a message from another agent (it is checked in startTask, not the route)', async () => {
    const r = await run({ prep });
    const t = await r.start('alpha', 'first');
    assert.throws(() => r.s.engine.startTask({ agentId: 'alpha', prompt: '/legion-armory:off-one', source: 'ui', continueTaskId: t.id }), /switched off/);
    assert.throws(() => r.s.engine.startTask({ agentId: 'beta', prompt: '/legion-armory:off-one', source: 'mcp' }), /switched off/);
  });

  it('refuses a /name that is not in the catalog and not a Claude Code command (inherit off hides personal skills; Claude Code would not know it)', async () => {
    const r = await run({ prep: async (x) => { x.config.claude.inheritClaudeCodeSettings = false; } });
    assert.throws(() => r.s.engine.startTask({ agentId: 'alpha', prompt: '/my-skill go', source: 'ui' }), /not a command Legion knows/);
  });
});
