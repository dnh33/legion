import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { createCommsModule } from '../src/core/comms/index.js';
import { buildCommsToolsServer } from '../src/core/comms/tools.js';
import type { ModuleDeps } from '../src/core/modules.js';
import { makeHarness } from './comms-fakes.test.js';
import type { Harness } from './comms-fakes.test.js';

const text = (r: any): string => (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');

/** An in-process MCP client connected to the agent's legion_comms server instance. */
async function connect(server: McpSdkServerConfigWithInstance): Promise<{ client: Client; close: () => Promise<void> }> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.instance.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); } };
}

async function as(h: Harness, agentId: string) {
  return connect(buildCommsToolsServer(agentId, h.hub));
}

describe('legion_comms MCP tools (in-process client)', () => {
  it('lists exactly the nine tools with real descriptions', async () => {
    const h = makeHarness();
    const { client, close } = await as(h, 'zealot');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['bot_list', 'bot_send', 'handoff', 'room_add_member', 'room_create', 'room_list', 'room_post', 'room_read', 'room_remove_member']);
    for (const t of tools) assert.ok((t.description ?? '').length > 40, t.name);
    await close();
  });

  it('the module exposes the server as "legion_comms" for every agent, plus a preamble and routes', async () => {
    const h = makeHarness();
    const mod = createCommsModule({ config: {} as never, store: h.store as never, bus: h.bus, engine: h.engine as never, approvals: {} as never, dataDir: h.dir, bsvEnabled: () => false } as ModuleDeps);
    assert.equal(mod.id, 'comms');
    const servers = mod.mcpServers!(h.agents.get('scout')!);
    assert.deepEqual(Object.keys(servers), ['legion_comms']);
    const paths: string[] = [];
    mod.routes!((m, p) => { paths.push(`${m} ${p}`); });
    assert.ok(paths.includes('POST /api/rooms/:id/messages'));
    assert.ok(paths.includes('GET /api/rooms/search'));
    assert.ok(paths.indexOf('GET /api/rooms/search') < paths.indexOf('GET /api/rooms/:id'), 'search is registered before :id');
    // Fascia 3a: the comms rules moved into the one teamwork block (teamwork.ts), so the module adds no preamble of its own
    assert.equal(mod.preamble, undefined);
    // the module's server really talks to its hub: a tool call reaches the engine
    const { client, close } = await connect(servers.legion_comms as McpSdkServerConfigWithInstance);
    const r: any = await client.callTool({ name: 'bot_send', arguments: { to: 'zealot', text: 'via module' } });
    assert.equal(r.isError, undefined);
    assert.equal(h.engine.last('zealot').agentId, 'zealot');
    await close();
    await mod.dispose!();
  });

  it('bot_send and room_post take an optional model (sonnet, opus, haiku, auto); the engine gets it for that turn only', async () => {
    const h = makeHarness();
    const room = h.room(['zealot', 'scout']);
    h.agents.get('scout')!.model = 'opus';   // a per-task model is capped at the target's own setting
    const { client, close } = await as(h, 'zealot');
    const { tools } = await client.listTools();
    for (const n of ['bot_send', 'room_post']) {
      const schema: any = tools.find((t) => t.name === n)!.inputSchema;
      assert.deepEqual(schema.properties.model.enum, ['sonnet', 'opus', 'haiku', 'auto'], n);
      assert.ok(!(schema.required ?? []).includes('model'), n);
    }
    const r: any = await client.callTool({ name: 'bot_send', arguments: { to: 'scout', text: 'quick one', model: 'haiku' } });
    assert.equal(r.isError, undefined);
    assert.equal(h.engine.last('scout').model, 'haiku');
    const p: any = await client.callTool({ name: 'room_post', arguments: { room: room.id, text: '@builder hmm', mention: 'scout', model: 'opus' } });
    assert.equal(p.isError, undefined);
    const bad: any = await client.callTool({ name: 'bot_send', arguments: { to: 'scout', text: 'x', model: 'gpt-5' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    assert.equal(bad.isError, true);
    h.agents.get('scout')!.model = 'sonnet';
    const capped: any = await client.callTool({ name: 'bot_send', arguments: { to: 'scout', text: 'think hard', model: 'opus' } });
    assert.equal(capped.isError, true);
    assert.match(text(capped), /above Scout's own model setting/);
    await close();
  });

  it('bot_list: other bots with state and shared rooms, nothing else', async () => {
    const h = makeHarness();
    const room = h.room(['zealot', 'scout']);
    h.hub.postHuman(room.id, '@scout go');
    const { client, close } = await as(h, 'zealot');
    const r: any = await client.callTool({ name: 'bot_list', arguments: {} });
    const list = JSON.parse(text(r));
    assert.equal(list.length, 6);
    const scout = list.find((b: any) => b.id === 'scout');
    assert.equal(scout.state, 'working');
    assert.deepEqual(scout.sharedRooms, [{ id: room.id, name: 'Ops' }]);
    assert.ok(!text(r).includes('sandbox') && !text(r).includes('desktop'));
    await close();
  });

  it('bot_send: returns the message id immediately, creates the dm, wakes the peer; rejects self/unknown/empty with isError', async () => {
    const h = makeHarness();
    const { client, close } = await as(h, 'zealot');
    const r: any = await client.callTool({ name: 'bot_send', arguments: { to: 'Scout', text: 'please look at X' } });
    assert.equal(r.isError, undefined);
    const out = JSON.parse(text(r));
    assert.match(out.messageId, /^rmsg_/);
    assert.equal(h.engine.starts.length, 1, 'woken; the tool did not wait for the reply');
    assert.equal(h.hub.listRooms()[0]!.kind, 'dm');
    assert.equal(h.hub.roomWithMessages(out.roomId).messages[0]!.id, out.messageId);

    for (const [args, re] of [
      [{ to: 'zealot', text: 'me' }, /yourself/],
      [{ to: 'nobody', text: 'x' }, /Unknown bot/],
      [{ to: 'scout', text: '  ' }, /text is required/],
      [{ to: 'scout', text: 'x', replyTo: 'rmsg_nope' }, /replyTo/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const e: any = await client.callTool({ name: 'bot_send', arguments: args });
      assert.equal(e.isError, true, JSON.stringify(args));
      assert.match(text(e), re);
    }
    // schema violations come back as errors, never as a thrown exception
    const bad: any = await client.callTool({ name: 'bot_send', arguments: { to: 5 } }).catch((e) => ({ isError: true, e }));
    assert.equal(bad.isError, true);
    await close();
  });

  it('bot_send is rejected from a paused conversation', async () => {
    const h = makeHarness();
    const dm = h.hub.botSend('zealot', 'scout', 'hi').roomId;
    h.hub.freeze(dm);
    const { client, close } = await as(h, 'zealot');
    const r: any = await client.callTool({ name: 'bot_send', arguments: { to: 'scout', text: 'again' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /paused/);
    await close();
  });

  it('room_post: wakes @mentions, accepts a mention parameter (string or array), rejects non-members and dms', async () => {
    const h = makeHarness();
    const room = h.room(['zealot', 'scout', 'builder']);
    const { client, close } = await as(h, 'zealot');
    const r: any = await client.callTool({ name: 'room_post', arguments: { room: 'Ops', text: 'take a look @Scout' } });
    assert.equal(r.isError, undefined);
    assert.deepEqual(JSON.parse(text(r)).to, ['scout']);
    assert.equal(h.engine.startsFor('scout').length, 1);
    await client.callTool({ name: 'room_post', arguments: { room: room.id, text: 'you too', mention: 'builder' } });
    assert.equal(h.engine.startsFor('builder').length, 1);
    await client.callTool({ name: 'room_post', arguments: { room: room.id, text: 'both', mention: ['scout', 'builder'] } });
    assert.equal(h.engine.startsFor('scout').length, 1, 'scout is busy: queued, not woken twice');
    const dm = h.hub.botSend('zealot', 'ranger', 'x').roomId;
    for (const args of [{ room: dm, text: 'x' }, { room: 'room_nope', text: 'x' }, { room: room.id, text: 'x', mention: ['ranger'] }]) {
      const e: any = await client.callTool({ name: 'room_post', arguments: args });
      assert.equal(e.isError, true, JSON.stringify(args));
    }
    const outsider = await as(h, 'ranger');
    const e: any = await outsider.client.callTool({ name: 'room_post', arguments: { room: room.id, text: 'let me in' } });
    assert.equal(e.isError, true);
    await outsider.close();
    await close();
  });

  it('room_read: wrapped transcript, <= 8000 chars, sinceId and limit', async () => {
    const h = makeHarness();
    const room = h.room(['zealot', 'scout']);
    for (let i = 0; i < 25; i++) h.hub.roomPost('zealot', room.id, `note ${i} ` + 'z'.repeat(800));
    const { client, close } = await as(h, 'scout');
    const r: any = await client.callTool({ name: 'room_read', arguments: { room: room.id, limit: 100 } });
    assert.equal(r.isError, undefined);
    assert.ok(text(r).length <= 8000);
    assert.match(text(r), /<bot-message id="rmsg_\w+" from="Zealot" hop="1"/);
    assert.match(text(r), /note 24 /);
    const first = h.messages(room.id)[0]!.id;
    const since: any = await client.callTool({ name: 'room_read', arguments: { room: room.id, sinceId: first, limit: 2 } });
    assert.equal((text(since).match(/<bot-message/g) ?? []).length, 2);
    const bad: any = await client.callTool({ name: 'room_read', arguments: { room: room.id, sinceId: 'rmsg_nope' } });
    assert.equal(bad.isError, true);
    const nope: any = await client.callTool({ name: 'room_read', arguments: { room: 'missing' } });
    assert.equal(nope.isError, true);
    await close();
  });

  it('room_list: rooms with unread counts', async () => {
    const h = makeHarness();
    const room = h.room(['zealot', 'scout']);
    h.hub.roomPost('scout', room.id, 'psst');
    const { client, close } = await as(h, 'zealot');
    const r: any = await client.callTool({ name: 'room_list', arguments: {} });
    const list = JSON.parse(text(r));
    assert.equal(list.length, 1);
    assert.equal(list[0].unread, 1);
    assert.equal(list[0].lead, 'zealot');
    await client.callTool({ name: 'room_read', arguments: { room: room.id } });
    assert.equal(JSON.parse(text(await client.callTool({ name: 'room_list', arguments: {} }) as any))[0].unread, 0);
    await close();
  });

  it('handoff: passes ownership and wakes the target; errors are isError results', async () => {
    const h = makeHarness();
    const room = h.room(['zealot', 'scout']);
    const { client, close } = await as(h, 'zealot');
    const r: any = await client.callTool({ name: 'handoff', arguments: { room: room.id, to: 'Scout', summary: 'Over to you: finish the report.' } });
    assert.equal(r.isError, undefined);
    assert.equal(JSON.parse(text(r)).newLead, 'scout');
    assert.equal(h.hub.getRoom(room.id).lead, 'scout');
    assert.equal(h.engine.startsFor('scout').length, 1);
    assert.match(h.engine.last('scout').prompt, /Over to you: finish the report/);
    for (const args of [{ room: room.id, to: 'zealot', summary: 'x' }, { room: room.id, to: 'ranger', summary: 'x' }, { room: 'nope', to: 'scout', summary: 'x' }]) {
      const e: any = await client.callTool({ name: 'handoff', arguments: args });
      assert.equal(e.isError, true, JSON.stringify(args));
    }
    await close();
  });

  it('tool results never carry secrets, VM URLs or task internals', async () => {
    const h = makeHarness();
    h.agents.get('scout')!.description = 'uses https://x.desktop.boat.dev/s?token=abc and key sk-abcdefghijkl';
    const room = h.room(['zealot', 'scout']);
    h.hub.roomPost('scout', room.id, 'my desktop is https://sbx.boat.dev/desktop/1 token=abc12345678 ok');
    h.hub.postHuman(room.id, '@scout go');
    const { client, close } = await as(h, 'zealot');
    const all = [
      text(await client.callTool({ name: 'bot_list', arguments: {} }) as any),
      text(await client.callTool({ name: 'room_read', arguments: { room: room.id } }) as any),
      text(await client.callTool({ name: 'room_list', arguments: {} }) as any),
    ].join('\n');
    assert.doesNotMatch(all, /boat\.dev|sk-abcdefghijkl|abc12345678/);
    assert.doesNotMatch(all, /task_\d+|sessionId|taskId|sandbox/);
    await close();
  });

  it('a tool call made while the agent is running a woken task inherits that chain\'s ceiling', async () => {
    const h = makeHarness({ agents: [['a', 'Alpha', 'ask'], ['b', 'Beta', 'full'], ['c', 'Gamma', 'full']] });
    const room = h.room(['a', 'b']);
    h.hub.postHuman(room.id, '@Alpha start');
    h.engine.finish(h.engine.last('a').taskId, '@Beta go');
    assert.equal(h.engine.last('b').origin!.approvalCeiling, 'ask');
    const { client, close } = await as(h, 'b');
    await client.callTool({ name: 'bot_send', arguments: { to: 'c', text: 'deploy please' } });
    assert.equal(h.engine.last('c').origin!.approvalCeiling, 'ask');
    await close();
  });
});
