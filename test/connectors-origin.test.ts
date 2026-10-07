/**
 * Runs started from an MCP client are refused by the connector gateway, and the flag survives every hop (design 4.1, R1): direct, down the
 * agent bridge, through a room, and on a continue. Engine tests use the real Engine; room tests use the comms harness.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_REFUSED, CONNECTORS_SERVER_NAME } from '../src/core/connectors/gateway.js';
import type { FakeGitHub } from './connectors-fake-github.js';
import { lateModule, signedInGitHub } from './connectors-rig.js';
import { init, mkAgent, ok, setup, waitDone } from './library-fakes.js';
import { makeHarness } from './comms-fakes.test.js';
import type { Harness } from './comms-fakes.test.js';

const fakes: FakeGitHub[] = [];
after(async () => { for (const f of fakes) await f.stop(); });

const withConnectors = (id: string, name: string) => ({ ...mkAgent(id, name, 'full'), connectors: ['github'] });

async function rig(seen: Record<string, string>) {
  const gh = await signedInGitHub();
  fakes.push(gh.fake);
  let s: ReturnType<typeof setup>;
  const mod = lateModule(() => s.store, gh);
  s = setup((c) => (async function* () {
    yield init(`s-${c.agent}`);
    const t = c.options.mcpServers[CONNECTORS_SERVER_NAME]?.instance._registeredTools.github_repo_get;
    seen[c.agent] = t ? (await t.handler({ repo: 'o/r' }, {})).content[0].text : 'NO SERVER';
    yield ok('done', `s-${c.agent}`);
  })(), { modules: [mod], agents: [withConnectors('alpha', 'Alpha'), withConnectors('beta', 'Beta'), withConnectors('gamma', 'Gamma')] });
  return { s, gh };
}
const bridge = (agentId: string, from: string, parent: string) => ({ agentId, prompt: 'do it', source: 'agent' as const, bridge: { fromAgentId: from, parentTaskId: parent, hop: 1 } });

test('engine: an MCP-started run carries the flag and the gateway refuses it; an app-started run does not and is served', async () => {
  const seen: Record<string, string> = {};
  const { s, gh } = await rig(seen);
  const viaClient = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'x', source: 'mcp' }));
  assert.equal(viaClient.origin?.viaMcpClient, true);
  assert.equal(seen.alpha, CLIENT_REFUSED);
  assert.equal(gh.fake.apiRequests().length, 0, 'nothing was requested for the client-started run');
  const fromApp = await waitDone(s, s.engine.startTask({ agentId: 'beta', prompt: 'x', source: 'ui' }));
  assert.equal(fromApp.origin, undefined);
  assert.match(seen.beta!, /^<github-data/);
});

test('engine: the flag crosses an agent-bridge hop and a second hop, so a client-started chain is refused at the end; an app-started chain is not', async () => {
  const seen: Record<string, string> = {};
  const { s, gh } = await rig(seen);
  const a = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'x', source: 'mcp' }));
  const b = s.engine.startTask(bridge('beta', 'alpha', a.id));
  assert.equal(b.origin?.viaMcpClient, true, 'ask/tell hop');
  assert.equal(b.origin?.roomId, 'agent-bridge');
  await waitDone(s, b);
  assert.equal(seen.beta, CLIENT_REFUSED);
  const c = s.engine.startTask(bridge('gamma', 'beta', b.id));
  assert.equal(c.origin?.viaMcpClient, true, 'second hop');
  await waitDone(s, c);
  assert.equal(seen.gamma, CLIENT_REFUSED);
  assert.equal(gh.fake.apiRequests().length, 0);
  // an app-started chain carries no flag
  const seen2: Record<string, string> = {};
  const r2 = await rig(seen2);
  const ua = await waitDone(r2.s, r2.s.engine.startTask({ agentId: 'alpha', prompt: 'x', source: 'ui' }));
  const ub = r2.s.engine.startTask(bridge('beta', 'alpha', ua.id));
  assert.equal(ub.origin?.viaMcpClient, undefined);
  await waitDone(r2.s, ub);
  assert.match(seen2.beta!, /^<github-data/);
});

test('engine: a continue keeps the flag, also when the earlier task was woken by a bot (the spread of the old origin carries none)', async () => {
  const seen: Record<string, string> = {};
  const { s } = await rig(seen);
  const a = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'x', source: 'mcp' }));
  const again = s.engine.startTask({ agentId: 'alpha', prompt: 'more', source: 'mcp', continueTaskId: a.id });
  assert.equal(again.origin?.viaMcpClient, true);
  await waitDone(s, again);
  // a room-woken task (origin without the flag) continued by a client: the client origin wins
  const woken = await waitDone(s, s.engine.startTask({ agentId: 'beta', prompt: 'x', source: 'bot', origin: { roomId: 'room_1', fromAgentId: 'alpha', hop: 1, approvalCeiling: 'full' } }));
  assert.equal(woken.origin?.viaMcpClient, undefined);
  const cont = s.engine.startTask({ agentId: 'beta', prompt: 'more', source: 'mcp', continueTaskId: woken.id });
  assert.equal(cont.origin?.viaMcpClient, true);
  assert.equal(cont.origin?.roomId, 'room_1', 'the rest of the old origin is kept');
  await waitDone(s, cont);
  assert.equal(seen.beta, CLIENT_REFUSED);
});

// ------------------------------------------------------------------------------------------------ rooms

const reply = (h: Harness, agent: string, text: string) => h.engine.finish(h.engine.last(agent).taskId, text, { cost: 0.01 });

test('room hop: a flagged sender flags the woken bot (bot_send, room_post, handoff) and the flag rides the chain through auto replies', () => {
  const h = makeHarness({ agents: [['a', 'Alpha', 'full'], ['b', 'Beta', 'full'], ['c', 'Gamma', 'full']] });
  const room = h.room(['a', 'b', 'c'], { guards: { maxHops: 20 } });
  // room_post from a flagged run wakes Beta in the room; Beta's final reply @mentions Gamma: the next wake is flagged (read from the task origin)
  h.hub.roomPost('a', room.id, '@Beta go', undefined, { viaMcpClient: true });
  assert.equal(h.engine.last('b').origin?.viaMcpClient, true, 'room_post');
  reply(h, 'b', '@Gamma take this');
  assert.equal(h.engine.last('c').origin?.viaMcpClient, true, 'auto reply, second hop');
  // bot_send (a DM room) and handoff from a flagged run
  h.hub.botSend('a', 'b', 'please look', undefined, { viaMcpClient: true });
  assert.equal(h.engine.startsFor('b').at(-1)!.origin?.viaMcpClient, true, 'bot_send');
  h.hub.handoff('a', room.id, 'Gamma', 'over to you', { viaMcpClient: true });
  assert.equal(h.engine.startsFor('c').at(-1)!.origin?.viaMcpClient, true, 'handoff');
});

test('room hop: without the flag nothing is flagged', () => {
  const h = makeHarness({ agents: [['a', 'Alpha', 'full'], ['b', 'Beta', 'full'], ['c', 'Gamma', 'full']] });
  const room = h.room(['a', 'b', 'c'], { guards: { maxHops: 20 } });
  h.hub.roomPost('a', room.id, '@Beta plain');
  assert.equal(h.engine.last('b').origin?.viaMcpClient, undefined);
  reply(h, 'b', '@Gamma onward');
  assert.equal(h.engine.last('c').origin?.viaMcpClient, undefined, 'a clean chain stays clean');
});

test('the tool layer passes the run origin to the hub: a comms sender built from a flagged run carries the flag', async () => {
  const { buildCommsToolsServer } = await import('../src/core/comms/tools.js');
  const h = makeHarness({ agents: [['a', 'Alpha', 'full'], ['b', 'Beta', 'full']] });
  const srv = buildCommsToolsServer('a', h.hub, { taint: () => false, origin: { roomId: 'mcp', fromAgentId: 'mcp', hop: 0, approvalCeiling: 'ask', viaMcpClient: true } }) as any;
  await srv.instance._registeredTools.bot_send.handler({ to: 'b', text: 'hello there' }, {});
  assert.equal(h.engine.last('b').origin?.viaMcpClient, true);
});
