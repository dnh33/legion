/**
 * 0.3.10, default mode: the mark travels to helpers and room peers as a label, and never lowers a helper's approval ceiling or stops its work.
 * (The same chains under Strict are covered in library-review-launder.test.ts.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommsToolsServer } from '../src/core/comms/tools.js';
import { CommsHub } from '../src/core/comms/hub.js';
import type { CoreModule } from '../src/core/modules.js';
import { HUMAN } from '../src/core/kg/types.js';
import { idOf, init, kg, ok, setup, toolUse, waitDone } from './library-fakes.js';

test('a marked lead that asks a helper leaves the helper labelled, at the lead\'s ceiling, and able to write memory and shared notes', async () => {
  const out: Record<string, string> = {};
  const ask = async (options: any, agent: string, message: string) => {
    const r = await options.mcpServers.legion.instance._registeredTools.ask.handler({ agent, message }, {});
    return r.content.map((x: any) => x.text).join('\n');
  };
  const s = setup((c) => {
    if (c.agent === 'alpha') return (async function* () { yield init('a'); yield toolUse('WebFetch'); await ask(c.options, 'beta', 'pass it on to builder'); yield ok('d', 'a'); })();
    if (c.agent === 'beta' && /pass it on/.test(c.prompt)) return (async function* () { yield init('b'); await ask(c.options, 'builder', 'write the note'); yield ok('d', 'b'); })();
    if (c.agent === 'builder' && /write the note/.test(c.prompt)) return (async function* () {
      yield init('c');
      out.w = (await kg(c.options, 'kg_upsert_node', { title: 'Third hop note', scope: 'shared' })).text;
      out.wm = (await kg(c.options, 'kg_wm_set', { active: 'third hop memory' })).text;
      yield ok('d', 'c');
    })();
    return undefined;
  });
  const lead = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
  assert.equal(lead.tainted, true, 'the lead is labelled');
  const n = s.graph.getNode(HUMAN, idOf(out.w!))!;
  assert.notEqual(n.status, 'pending', 'the helper\'s shared note is live, not held in the Inbox');
  assert.equal(n.origin?.tainted, true, 'but it carries the label');
  assert.doesNotMatch(out.wm!, /Error/, 'the helper may write its working memory');
  const helpers = s.store.listTasks(50).filter((t) => t.agentId === 'beta' || t.agentId === 'builder');
  assert.ok(helpers.length >= 2, 'both helpers ran');
  for (const t of helpers) {
    assert.equal(t.tainted, true, `${t.agentId} is labelled`);
    assert.equal(t.origin?.approvalCeiling, 'full', `${t.agentId} keeps the lead's ceiling: the mark does not lower it`);
  }
});

test('a room peer that reads a marked bot\'s message is labelled, not capped, and may write memory', async () => {
  let roomId = '';
  const out: Record<string, string> = {};
  const hubBox: { hub?: CommsHub } = {};
  const commsMod: CoreModule = {
    id: 'comms-test',
    mcpServers: (agent, job) => ({ legion_comms: buildCommsToolsServer(agent.id, hubBox.hub!, job) }),
  };
  const s = setup((c) => {
    if (c.agent === 'alpha') return (async function* () {
      yield init('a1');
      yield toolUse('WebFetch');
      await c.options.mcpServers.legion_comms.instance._registeredTools.room_post.handler({ room: roomId, text: 'found the API change in the issue' }, {});
      yield ok('posted', 'a1');
    })();
    if (c.agent === 'beta' && /reader/.test(c.prompt)) return (async function* () {
      yield init('b1');
      await c.options.mcpServers.legion_comms.instance._registeredTools.room_read.handler({ room: roomId }, {});
      out.wm = (await kg(c.options, 'kg_wm_set', { active: 'plan: adapt to the API change' })).text;
      yield ok('done', 'b1');
    })();
    return undefined;
  }, { modules: [commsMod] });
  hubBox.hub = new CommsHub({ engine: s.engine as any, store: s.store as any, bus: s.bus, dataDir: s.dir + '/comms' });
  roomId = hubBox.hub.createRoom({ name: 'Ops', members: ['alpha', 'beta', 'builder'] }).id;
  await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'research', source: 'ui' }));
  const reader = await waitDone(s, s.engine.startTask({ agentId: 'beta', prompt: 'reader: read the room', source: 'ui' }));
  assert.equal(reader.tainted, true, 'the peer is labelled once it read the marked message');
  assert.doesNotMatch(out.wm ?? 'Error', /Error|forbidden/, 'and its working memory write goes through');
});
