/** Provider agents get Armory skills through armory_skills / armory_skill, under the same per-agent state and taint rules. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARMORY_SERVER_NAME } from '../src/core/armory/index.js';
import { isLegionTool, needsApproval } from '../src/core/approvals.js';
import type { ModuleJob } from '../src/core/modules.js';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import type { FakeReq } from './providers-fakes.js';
import { run, setup as provSetup } from './providers-harness.js';
import { armoryRig, own, mkAgent, md } from './armory-rig.js';

const CC = { personal: { 'my-skill': md('my-skill', 'Mine.', '', 'Personal body.') }, plugins: [{ key: 'sp@m', name: 'sp', skills: { tdd: md('tdd', 'Tests.', '', 'Plugin body.') } }] };

async function rig() {
  const r = armoryRig({ cc: CC, agents: [mkAgent('alpha'), mkAgent('beta'), mkAgent('narrow', { skills: ['legion-armory:mine'] })] });
  await own(r, { name: 'mine', description: 'Mine d.', body: 'My body.' });
  await r.call('POST', '/api/armory/import', { files: [{ path: 'imp/SKILL.md', text: md('imp', 'Imported d.', '', 'Imported body.') }] });
  await r.call('POST', '/api/armory/state', { id: 'legion-armory:imp', state: 'on' });
  await r.call('POST', '/api/armory/state', { id: 'my-skill', state: 'on' });
  await r.call('POST', '/api/armory/state', { id: 'sp:tdd', state: 'on' });
  await own(r, { name: 'manual-one', description: 'd', body: 'b' });
  await r.call('POST', '/api/armory/state', { id: 'legion-armory:manual-one', state: 'manual' });
  await own(r, { name: 'off-one', description: 'd', body: 'b' });
  await r.call('POST', '/api/armory/state', { id: 'legion-armory:off-one', state: 'off' });
  await own(r, { name: 'only-beta', description: 'd', body: 'b' });
  await r.call('POST', '/api/armory/agents', { id: 'legion-armory:only-beta', agents: ['beta'] });
  await r.call('POST', '/api/armory/state', { id: 'deep-research', state: 'on' });
  return r;
}

function tools(r: Awaited<ReturnType<typeof rig>>, agentId: string) {
  const state = { tainted: false };
  const job = { taskId: 't', runtime: 'provider', taint: () => state.tainted, markTainted: () => { state.tainted = true; } } as ModuleJob;
  const srv = r.mod.mcpServers!(r.agents.get(agentId)!, job)[ARMORY_SERVER_NAME] as any;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await srv.instance._registeredTools[name].handler(args, {});
    return { text: out.content.map((c: any) => c.text).join('\n') as string, isError: out.isError === true };
  };
  return { state, call, names: Object.keys(srv.instance._registeredTools).sort() };
}

describe('armory tools for provider agents', () => {
  it('are served to a provider run only, never to a Claude run', async () => {
    const r = await rig();
    assert.deepEqual(r.mod.mcpServers!(r.agents.get('alpha')!, { taskId: 't', runtime: 'claude', taint: () => false } as ModuleJob), {});
    assert.deepEqual(r.mod.mcpServers!(r.agents.get('alpha')!), {});
    assert.deepEqual(tools(r, 'alpha').names, ['armory_skill', 'armory_skills']);
  });

  it('list only what is on for this agent and has text: not manual, off, a built-in or another agent\'s skill', async () => {
    const r = await rig();
    const a = (await tools(r, 'alpha').call('armory_skills')).text;
    for (const id of ['legion-armory:mine', 'legion-armory:imp', 'my-skill', 'sp:tdd']) assert.match(a, new RegExp(id.replace(/[:.]/g, '\\$&')), id);
    for (const id of ['manual-one', 'off-one', 'only-beta', 'deep-research']) assert.doesNotMatch(a, new RegExp(id), id);
    assert.match((await tools(r, 'beta').call('armory_skills')).text, /only-beta/);
    const n = (await tools(r, 'narrow').call('armory_skills')).text;
    assert.match(n, /legion-armory:mine/);
    assert.doesNotMatch(n, /imp|my-skill|sp:tdd/, 'an explicit list narrows');
  });

  it('serve the owner\'s own text plain and untainted', async () => {
    const r = await rig();
    for (const id of ['legion-armory:mine', 'my-skill']) {
      const t = tools(r, 'alpha');
      const out = await t.call('armory_skill', { id });
      assert.equal(out.isError, false, id);
      assert.match(out.text, /own skill/);
      assert.doesNotMatch(out.text, /untrusted|UNTRUSTED/i);
      assert.equal(t.state.tainted, false, id);
    }
  });

  it('wrap third-party text as untrusted and taint the run: imported and plugin skills', async () => {
    const r = await rig();
    for (const [id, body] of [['legion-armory:imp', 'Imported body.'], ['sp:tdd', 'Plugin body.']]) {
      const t = tools(r, 'alpha');
      const out = await t.call('armory_skill', { id });
      assert.match(out.text, new RegExp(body));
      assert.match(out.text, /NOT written by you/);
      assert.match(out.text, /untrusted/i, 'wrapped');
      assert.equal(t.state.tainted, true, id);
    }
  });

  it('refuse off, manual, not-granted, built-in and unknown with one identical answer, and do not taint', async () => {
    const r = await rig();
    const answers = new Set<string>();
    for (const id of ['legion-armory:off-one', 'legion-armory:manual-one', 'legion-armory:only-beta', 'deep-research', 'ghost']) {
      const t = tools(r, 'alpha');
      const out = await t.call('armory_skill', { id });
      assert.equal(out.isError, true, id);
      assert.match(out.text, /No enabled skill matches/);
      answers.add(out.text.replace(id, 'X'));
      assert.equal(t.state.tainted, false, id);
    }
    assert.equal(answers.size, 1, 'the answer does not tell an agent which skills exist but are off');
    const narrow = tools(r, 'narrow');
    assert.equal((await narrow.call('armory_skill', { id: 'legion-armory:imp' })).isError, true, 'outside its own list');
  });

  it('are Legion\'s own tools: no approval card in ask mode, and no blanket taint from the tool name', () => {
    const name = `mcp__${ARMORY_SERVER_NAME}__armory_skill`;
    assert.equal(isLegionTool(name), true);
    assert.equal(needsApproval('ask', name), false);
  });
});

const toolMsg = (req: FakeReq, id: string): string => (req.body.messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';

describe('armory tools in a real provider run', () => {
  it('a provider agent loads an Armory skill through the tool loop in ask mode, and a third-party load taints the task', async () => {
    const r = await rig();
    let n = 0;
    const f = await startFake((_q, res) => {
      n++;
      if (n === 1) replyTools(res, [{ id: 'a', name: `mcp__${ARMORY_SERVER_NAME}__armory_skill`, args: { id: 'legion-armory:imp' } }]);
      else replyText(res, 'done');
    });
    try {
      const h = provSetup(f, { agent: { approval: 'ask', id: 'alpha' } });
      h.engine.setModules([r.mod]);
      const names = [] as string[];
      const t = await run(h);
      assert.equal(t.status, 'done');
      void names;
      assert.match(toolMsg(f.requests[1]!, 'a'), /Imported body\./);
      assert.equal(t.tainted, true, 'an imported skill taints the provider run');
      const offered = (f.requests[0]!.body.tools as any[]).map((x) => x.function.name);
      assert.ok(offered.includes(`mcp__${ARMORY_SERVER_NAME}__armory_skills`));
    } finally { await f.close(); }
  });
});
