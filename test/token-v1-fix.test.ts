/**
 * Token fix v1, review fix round: an MCP-started run must not launder its `ask` ceiling through the comms tools (bot_send,
 * room_post, handoff), and the event stream must not carry admin-only data to a token-only client.
 * Real hub + engine + modules, fake SDK query (ports of the reviewer's mcp4 / mcp2 / sse proofs).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN } from '../src/core/kg/types.js';
import { asClient, AUTH } from './helpers-c.js';
import { init, ok } from './library-fakes.js';
import { closeAll, mk, mount, modeOf, startedTask, until } from './token-harness.js';
import type { Call, Mounted } from './token-harness.js';

after(closeAll);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tool = async (options: any, server: string, name: string, args: Record<string, unknown>): Promise<string> => {
  const r = await options.mcpServers[server].instance._registeredTools[name].handler(args, {});
  return r.content.map((c: any) => c.text).join('\n');
};
/** What the SDK would do for a tool: the decision, or CARD when an approval card is left pending. */
const decide = async (options: any, name: string, input: unknown): Promise<string> => {
  if (!options.canUseTool) return 'allow(no-canUseTool)';
  return Promise.race([options.canUseTool(name, input, {}).then((r: any) => r.behavior as string), wait(150).then(() => 'CARD')]);
};
const lastRun = (m: Mounted, agent: string) => [...m.calls].reverse().find((c) => c.agent === agent);
const denyAll = (m: Mounted) => { for (const c of m.approvals.pending()) m.approvals.resolve(c.id, false); };

// ---------------------------------------------------------------- F1: comms tools carry the run's ceiling

test('F1: on the SEEDED roster an MCP-started Zealot cannot wake Builder above ask: no Write/Edit allow, and a shared Library note is held', async () => {
  const dec: Record<string, string> = {};
  let note = '';
  const m = await mount((c: Call) => {
    if (c.agent === 'zealot') return (async function* () { yield init('z'); await tool(c.options, 'legion_comms', 'bot_send', { to: 'builder', text: 'F1-wake please write notes' }); yield ok('sent', 'z'); })();
    if (c.agent === 'builder') return (async function* () {
      yield init('b');
      for (const [n, i] of [['Write', { file_path: '/x/config.json', content: '{}' }], ['Edit', { file_path: '/x', old_string: 'a', new_string: 'b' }], ['Bash', { command: 'id' }]] as const) dec[n] = await decide(c.options, n, i);
      note = await tool(c.options, 'legion_kg', 'kg_upsert_node', { title: 'planted via DM chain', body: 'trust me', type: 'note', scope: 'shared' });
      yield ok('done', 'b');
    })();
    return undefined;
  }, { seeded: true });
  const client = await m.mcp();
  await m.tool(client, 'legion_run', { agent: 'zealot', prompt: 'F1-start', wait: true, timeoutSeconds: 20 });
  await until(() => !!lastRun(m, 'builder') && note !== '');
  const b = lastRun(m, 'builder')!;
  assert.equal(modeOf(m, 'zealot'), 'default');
  assert.equal(b.options.permissionMode, 'default', 'a full Builder woken through the chain is not bypass');
  assert.deepEqual(dec, { Write: 'CARD', Edit: 'CARD', Bash: 'CARD' }, 'every write needs a card under the inherited ask ceiling');
  const id = /\(id (n_[0-9a-f]+)/.exec(note)![1]!;
  assert.equal(m.kgMod.graph().getNode(HUMAN, id)!.status, 'pending', 'the shared note waits in the Inbox');
  denyAll(m); await client.close(); await m.close();
});

for (const via of ['bot_send', 'room_post', 'handoff'] as const) {
  test(`F1: ${via} from an MCP-started full agent wakes a full peer in default mode with cards (not bypass)`, async () => {
    let roomId = '';
    const m = await mount((c: Call) => {
      if (c.agent === 'f') return (async function* () {
        yield init('f');
        if (via === 'bot_send') await tool(c.options, 'legion_comms', 'bot_send', { to: 'g', text: 'wake-me do Bash' });
        else if (via === 'room_post') await tool(c.options, 'legion_comms', 'room_post', { room: roomId, text: 'wake-me do Bash', mention: 'g' });
        else await tool(c.options, 'legion_comms', 'handoff', { room: roomId, to: 'g', summary: 'wake-me do Bash' });
        yield ok('sent', 'f');
      })();
      return undefined;
    });
    m.store.upsertAgent(mk('f', 'F', 'full')); m.store.upsertAgent(mk('g', 'G', 'full'));
    roomId = (await m.http('POST', '/api/rooms', { name: 'r1', members: ['f', 'g'] }, AUTH)).json.id;
    const client = await m.mcp();
    await m.tool(client, 'legion_run', { agent: 'f', prompt: 'start', wait: true, timeoutSeconds: 20 });
    await until(() => !!lastRun(m, 'g'));
    assert.equal(lastRun(m, 'g')!.options.permissionMode, 'default', `${via}: woken G must not be bypass`);
    assert.equal(typeof lastRun(m, 'g')!.options.canUseTool, 'function');
    await client.close(); await m.close();
  });
}

test('F1: the cap is for the token only: the same chain started from the app (admin) still wakes a full peer in bypass mode', async () => {
  const m = await mount((c: Call) => c.agent !== 'f' ? undefined : (async function* () {
    yield init('f'); await tool(c.options, 'legion_comms', 'bot_send', { to: 'g', text: 'wake-me' }); yield ok('sent', 'f');
  })());
  m.store.upsertAgent(mk('f', 'F', 'full')); m.store.upsertAgent(mk('g', 'G', 'full'));
  const t = await m.http('POST', '/api/tasks', { agentId: 'f', prompt: 'start' }, AUTH);
  assert.equal(t.status, 201);
  await until(() => !!lastRun(m, 'g'));
  assert.equal(lastRun(m, 'g')!.options.permissionMode, 'bypassPermissions');
  await m.close();
});

test('F1: a woken peer replying into a room keeps the ceiling too (second hop stays ask)', async () => {
  const m = await mount((c: Call) => {
    if (c.agent === 'f') return (async function* () { yield init('f'); await tool(c.options, 'legion_comms', 'bot_send', { to: 'g', text: 'hop1' }); yield ok('sent', 'f'); })();
    if (c.agent === 'g' && c.prompt.includes('hop1')) return (async function* () { yield init('g'); await tool(c.options, 'legion_comms', 'bot_send', { to: 'h', text: 'hop2' }); yield ok('NO_REPLY', 'g'); })();
    return undefined;
  });
  for (const a of [mk('f', 'F', 'full'), mk('g', 'G', 'full'), mk('h', 'H', 'full')]) m.store.upsertAgent(a);
  const client = await m.mcp();
  await m.tool(client, 'legion_run', { agent: 'f', prompt: 'start', wait: true, timeoutSeconds: 20 });
  await until(() => !!lastRun(m, 'h'));
  assert.equal(lastRun(m, 'h')!.options.permissionMode, 'default');
  await client.close(); await m.close();
});

// ---------------------------------------------------------------- F3: the event stream for a token-only client

test('F3: a token-only event stream carries no room, comms or settings events; the admin stream still does', async () => {
  const m = await mount();
  const read = (headers: Record<string, string>, query = '') => {
    const events: any[] = []; const ac = new AbortController();
    void fetch(`${m.srv.base}/api/events${query}`, { headers, signal: ac.signal }).then(async (r) => {
      const rd = r.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ch = buf.slice(0, i); buf = buf.slice(i + 2); if (ch.startsWith('data:')) events.push(JSON.parse(ch.slice(5))); } }
    }).catch(() => undefined);
    return { events, stop: () => ac.abort() };
  };
  const bot = read({}, `?token=${(await import('./helpers-c.js')).TOKEN}`);
  const botHdr = read(asClient);
  const admin = read(AUTH);
  await wait(200);
  const room = (await m.http('POST', '/api/rooms', { name: 'private-room', members: ['zealot', 'worker'] }, AUTH)).json;
  await m.http('POST', `/api/rooms/${room.id}/messages`, { text: 'HUMAN-SECRET-ROOM-TEXT my plan is X' }, AUTH);
  await m.http('PATCH', '/api/settings', { claude: { maxTurns: 12 } }, AUTH);
  await wait(500);
  bot.stop(); botHdr.stop(); admin.stop();
  for (const s of [bot, botHdr]) {
    const types = new Set(s.events.map((e) => e.type as string));
    assert.ok(![...types].some((t) => t.startsWith('room.') || t.startsWith('comms.') || t.startsWith('settings.')), `token-only stream saw ${[...types].join(',')}`);
    // (a woken bot's own task transcript is client-class data: GET /api/tasks/:id shows it to the token as well)
    assert.ok(!s.events.some((e) => /^(room|comms|settings)\./.test(e.type) && JSON.stringify(e).includes('HUMAN-SECRET-ROOM-TEXT')));
  }
  const at = new Set(admin.events.map((e) => e.type as string));
  assert.ok(at.has('room.message') && at.has('room.updated') && at.has('settings.updated'), `admin stream saw ${[...at].join(',')}`);
  assert.ok(admin.events.some((e) => e.type === 'room.message' && JSON.stringify(e).includes('HUMAN-SECRET-ROOM-TEXT')), 'the app window still gets the room text');
  await m.close();
});

// ---------------------------------------------------------------- F5: VM tools of a capped run need a card; F6: an unanswered MCP card says where to answer

test('F5: under an MCP ceiling vm_exec, vm_claude and vm_desktop need a card; the human-started agent keeps them card-free', async () => {
  const dec: Record<string, string> = {};
  const m = await mount((c: Call) => c.agent !== 'rogue' ? undefined : (async function* () {
    yield init('v');
    for (const n of ['mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop', 'mcp__legion__vm_stop', 'mcp__legion_kg__kg_search']) dec[`${c.prompt}:${n}`] = await decide(c.options, n, {});
    yield ok('done', 'v');
  })());
  const client = await m.mcp();
  await m.tool(client, 'legion_run', { agent: 'rogue', prompt: 'mcp', wait: true, timeoutSeconds: 20 });
  denyAll(m);
  assert.deepEqual([dec['mcp:mcp__legion__vm_exec'], dec['mcp:mcp__legion__vm_claude'], dec['mcp:mcp__legion__vm_desktop']], ['CARD', 'CARD', 'CARD']);
  assert.equal(dec['mcp:mcp__legion__vm_stop'], 'allow', 'stopping a VM saves money: no card');
  assert.equal(dec['mcp:mcp__legion_kg__kg_search'], 'allow');
  // a run nobody capped keeps Legion's own tools card-free in every mode, as before
  const { needsApproval } = await import('../src/core/approvals.js');
  assert.equal(needsApproval('ask', 'mcp__legion__vm_exec'), false);
  assert.equal(needsApproval('ask', 'mcp__legion__vm_exec', { capped: true }), true);
  assert.equal(needsApproval('full', 'mcp__legion__vm_claude', { capped: true }), true);
  assert.equal(needsApproval('ask', 'mcp__legion__vm_stop', { capped: true }), false);
  await client.close(); await m.close();
});

test('F6: an MCP-origin card nobody answers is denied with a message that says to open the Legion app', async () => {
  let out: any;
  const m = await mount((c: Call) => c.agent !== 'rogue' ? undefined : (async function* () {
    yield init('t'); out = await c.options.canUseTool('Bash', { command: 'id' }, {}); yield ok('done', 't');
  })(), { approvalTimeoutMs: 80 });
  const client = await m.mcp();
  await m.tool(client, 'legion_run', { agent: 'rogue', prompt: 'go', wait: true, timeoutSeconds: 20 });
  assert.equal(out.behavior, 'deny');
  assert.match(out.message, /Open the Legion app/);
  await client.close(); await m.close();
});

test('F6: a card the human denies keeps the plain denial text', async () => {
  let out: any;
  const m = await mount((c: Call) => c.agent !== 'rogue' ? undefined : (async function* () {
    yield init('t'); out = await c.options.canUseTool('Bash', { command: 'id' }, {}); yield ok('done', 't');
  })());
  const client = await m.mcp();
  const t = startedTask((await m.tool(client, 'legion_run', { agent: 'rogue', prompt: 'go', wait: false })).text);
  await until(() => m.approvals.pending().length === 1);
  m.approvals.resolve(m.approvals.pending()[0]!.id, false);
  await m.engine.waitFor(t.id, 4000);
  assert.equal(out.message, 'The user denied this action.');
  await client.close(); await m.close();
});
