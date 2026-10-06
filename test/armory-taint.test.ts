/** A Skill load taints the run by the skill it names, read from the stream, in every approval mode. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { init, mkAgent, ok, setup, toolUse, waitDone } from './library-fakes.js';
import { armoryRig, own, md } from './armory-rig.js';

const CC = {
  personal: { 'my-skill': md('my-skill', 'Mine.'), shared: md('shared', 'Personal one.') },
  plugins: [{ key: 'sp@m', name: 'sp', skills: { tdd: md('tdd', 'Tests.'), shared: md('shared', 'Plugin one.') } }],
};

async function loadTaints(skill: unknown, approval: 'full' | 'ask' = 'full', noInput = false): Promise<boolean> {
  const rig = armoryRig({ cc: CC });
  await own(rig, { name: 'mine', description: 'd', body: 'b' });
  await rig.call('POST', '/api/armory/import', { files: [{ path: 'imp/SKILL.md', text: md('imp', 'Imported.') }] });
  const s = setup((c) => (async function* () {
    yield init('s1');
    yield noInput ? toolUse('Skill') : toolUse('Skill', 'tu_skill', { skill });
    yield ok('d', 's1');
  })(), { modules: [rig.mod], agents: [mkAgent('alpha', 'Alpha', approval)] });
  const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
  return t.tainted === true;
}

describe('Skill load taint, by source', () => {
  it('does not taint for the owner\'s own skill, a personal Claude Code skill or a built-in', async () => {
    assert.equal(await loadTaints('legion-armory:mine'), false, 'yours');
    assert.equal(await loadTaints('my-skill'), false, 'claude-personal');
    assert.equal(await loadTaints('debug'), false, 'claude-builtin');
    assert.equal(await loadTaints('deep-research'), false, 'claude-builtin');
    assert.equal(await loadTaints('/my-skill'), false, 'a leading slash is the same skill');
  });

  it('taints for an imported skill and for a Claude Code plugin skill', async () => {
    assert.equal(await loadTaints('legion-armory:imp'), true, 'imported');
    assert.equal(await loadTaints('sp:tdd'), true, 'claude-plugin');
  });

  it('taints for an unknown name, a missing input and a non-string input', async () => {
    assert.equal(await loadTaints('ghost'), true, 'unknown');
    assert.equal(await loadTaints('sp:ghost'), true, 'unknown plugin skill');
    assert.equal(await loadTaints(undefined, 'full', true), true, 'no input at all');
    assert.equal(await loadTaints({ x: 1 }), true, 'not a string');
    assert.equal(await loadTaints(''), true, 'empty');
  });

  it('fails closed on a bare name that is also the short name of a plugin skill', async () => {
    assert.equal(await loadTaints('shared'), true);
  });

  it('is read from the stream, so it holds in the asking mode too', async () => {
    assert.equal(await loadTaints('legion-armory:imp', 'ask'), true);
    assert.equal(await loadTaints('legion-armory:mine', 'ask'), false);
  });

  it('with no Armory module a Skill load taints (unknown is outside content)', async () => {
    const s = setup((c) => (async function* () { yield init('s1'); yield toolUse('Skill', 'tu', { skill: 'debug' }); yield ok('d', 's1'); })());
    const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.equal(t.tainted, true);
  });

  it('a Skill load inside a sub-agent taints the run too', async () => {
    const rig = armoryRig({ cc: CC });
    await rig.call('POST', '/api/armory/import', { files: [{ path: 'imp/SKILL.md', text: md('imp', 'Imported.') }] });
    const s = setup((c) => (async function* () {
      yield init('s1');
      yield { type: 'assistant', parent_tool_use_id: 'tu_task', message: { content: [{ type: 'tool_use', id: 'tu_sub', name: 'Skill', input: { skill: 'legion-armory:imp' } }] } };
      yield ok('d', 's1');
    })(), { modules: [rig.mod] });
    const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.equal(t.tainted, true);
  });
});
