/**
 * Named end-to-end scenarios against a running harness stack (real core process, scripted model, fake boat.dev, fake wallet, fake blender).
 * Each scenario states what it PROVES and what it does NOT prove; the second list is as important as the first. A scenario that passes proves
 * only what its checks assert, about Legion's own code, in this fake setting.
 *
 * Adding one: push `{name, proves, doesNotProve, run(h, t)}` onto SCENARIOS. `h` is the client from lib.mjs, `t` the check recorder
 * (t.ok, t.eq). Use unique names for anything you create, call h.resetModel() first, and never contact anything outside the stack.
 */
import { spawnSync } from 'node:child_process';
import { startHarness, stopHarness, client } from './lib.mjs';
import { assertSafeWalletTarget, FORBIDDEN_PORT, startFakeWallet } from './fake-wallet.mjs';

const F = { when: 'a harness run needs a note', do: 'capture it', because: 'it is a test' };
const NOT_EXEC = /tool not executed/;

class Check {
  constructor() { this.checks = []; }
  ok(label, cond, detail) {
    this.checks.push({ label, ok: !!cond });
    if (!cond) throw new Error(`check failed: ${label}${detail === undefined ? '' : ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  }
  eq(label, actual, expected) { this.ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected }); }
}

export const SCENARIOS = [];
const scenario = (def) => SCENARIOS.push(def);

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'core-task-run',
  proves: ['A task started over HTTP runs through the real Engine and a scripted model, and ends done with the scripted result, cost and chat messages.',
    'A read-only tool in an `ask` agent needs no card; the run is in default permission mode with a canUseTool gate.',
    'The run makes zero boat.dev calls and zero wallet calls.'],
  doesNotProve: ['Anything about the real Claude Agent SDK, real model behaviour, real tool execution (tools other than Legion\'s own are not executed) or real cost.'],
  async run(h, t) {
    await h.resetModel(); await h.boatClear(); await h.walletClear();
    await h.script({ agent: 'scout', promptIncludes: 'harness-core-run' }, [{ say: 'Looking around.' }, { tool: 'Read', input: { file_path: 'notes.txt' }, as: 'read' }, { result: 'scripted answer', costUsd: 0.03 }]);
    const task = await h.runTask('scout', 'harness-core-run please');
    t.eq('task status', task.status, 'done');
    t.eq('result is the scripted text', task.result, 'scripted answer');
    t.eq('cost comes from the scripted result', task.costUsd, 0.03);
    const detail = (await h.call('GET', `/api/tasks/${task.id}`)).json;
    t.ok('assistant text and the tool call are in the chat log', detail.messages.some((m) => m.role === 'assistant' && m.text === 'Looking around.') && detail.messages.some((m) => m.role === 'tool' && m.toolName === 'Read'), detail.messages.map((m) => m.role));
    t.eq('no approval card was needed for Read', await h.pendingApprovals(), []);
    const run = (await h.modelLog()).at(-1);
    t.ok('the scripted model was used', run.scripted && run.agent === 'scout');
    t.eq('ask agent runs in default permission mode with canUseTool', [run.permissionMode, run.hasCanUseTool], ['default', true]);
    t.ok('read tool was allowed and simulated, not executed', run.vars.read.decision === 'allow' && NOT_EXEC.test(run.vars.read.text));
    t.eq('zero boat.dev requests', (await h.boat()).requests.length, 0);
    t.eq('zero wallet requests', (await h.wallet()).seen.length, 0);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'approval-card-flow',
  proves: ['A Bash call from an `ask` agent stops on an approval card whose summary is the command, until someone answers.',
    'The MCP-class token cannot answer the card (403) and the card stays pending; the admin caller can.',
    'Allow lets the run continue (the tool result is returned to the script); Deny returns "The user denied this action." and the task still finishes.'],
  doesNotProve: ['The card UI, the A/D keys, the 10-minute auto-deny timer, or that a real Claude Code process honours the denial.'],
  async run(h, t) {
    await h.resetModel();
    await h.script({ agent: 'scout', promptIncludes: 'harness-allow' }, [{ tool: 'Bash', input: { command: 'echo allowed' }, as: 'b' }, { result: 'allow-done' }]);
    await h.script({ agent: 'scout', promptIncludes: 'harness-deny' }, [{ tool: 'Bash', input: { command: 'echo denied' }, as: 'b' }, { result: 'deny-done' }]);
    const a = await h.call('POST', '/api/tasks', { agentId: 'scout', prompt: 'harness-allow' });
    t.eq('task accepted', a.status, 201);
    const card = await h.waitApproval();
    t.eq('card names the tool', card.toolName, 'Bash');
    t.eq('card summary is the command', card.summary, 'echo allowed');
    t.eq('card belongs to the task', card.taskId, a.json.id);
    const asToken = await h.call('POST', `/api/approvals/${card.id}`, { allow: true }, 'token');
    t.eq('token-only caller is refused', asToken.status, 403);
    t.eq('card still pending after the refused answer', (await h.pendingApprovals()).length, 1);
    t.eq('admin allows', (await h.call('POST', `/api/approvals/${card.id}`, { allow: true })).status, 200);
    const done = await h.waitTask(a.json.id);
    t.eq('allowed run finished', [done.status, done.result], ['done', 'allow-done']);
    t.eq('script saw "allow"', (await h.modelLog()).at(-1).vars.b.decision, 'allow');
    const d = await h.call('POST', '/api/tasks', { agentId: 'scout', prompt: 'harness-deny' });
    const card2 = await h.waitApproval();
    t.eq('second card', card2.summary, 'echo denied');
    await h.call('POST', `/api/approvals/${card2.id}`, { allow: false });
    const done2 = await h.waitTask(d.json.id);
    t.eq('denied run still finishes', [done2.status, done2.result], ['done', 'deny-done']);
    const v = (await h.modelLog()).at(-1).vars.b;
    t.eq('script saw the denial text', [v.decision, v.text], ['deny', 'The user denied this action.']);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'rooms-bot-room-request',
  proves: ['A bot\'s room_create call creates NOTHING until a card is answered; the card says "No spend limit" when no budget is named.',
    'Deny leaves no room and the bot is told not to ask again; the MCP token cannot answer the card.',
    'Allow creates the room exactly as shown, marked created by the bot, with no default budget (guards.budgetUsd is null), and only the admin can delete it.',
    'This holds for a bot that is set to `full` approval: the wait is in the tool handler, not in canUseTool.'],
  doesNotProve: ['The Rooms UI, a real model deciding to call the tool, or the later behaviour of a room (hops, cycle and budget guards are covered by test/comms-*.test.ts, not here).'],
  async run(h, t) {
    await h.resetModel();
    const rooms = async () => (await h.call('GET', '/api/rooms')).json;
    const before = (await rooms()).length;
    // builder is a `full` agent: no canUseTool, yet the card must still appear
    await h.script({ agent: 'builder', promptIncludes: 'harness-room-deny' }, [{ tool: 'mcp__legion_comms__room_create', input: { name: 'Harness crew', members: ['scout'] }, as: 'rc' }, { result: 'asked' }]);
    await h.script({ agent: 'builder', promptIncludes: 'harness-room-allow' }, [{ tool: 'mcp__legion_comms__room_create', input: { name: 'Harness crew', members: ['scout'] }, as: 'rc' }, { result: 'asked' }]);
    const a = await h.call('POST', '/api/tasks', { agentId: 'builder', prompt: 'harness-room-deny' });
    const card = await h.waitApproval();
    t.eq('card tool', card.toolName, 'mcp__legion_comms__room_create');
    t.ok('card says it is the bot\'s text and that nothing caps the cost', /asks to create a room/.test(card.summary) && /No spend limit/.test(card.summary), card.summary);
    t.eq('no room exists while the card is open', (await rooms()).length, before);
    t.eq('token cannot answer', (await h.call('POST', `/api/approvals/${card.id}`, { allow: true }, 'token')).status, 403);
    await h.call('POST', `/api/approvals/${card.id}`, { allow: false });
    await h.waitTask(a.json.id);
    const denied = (await h.modelLog()).at(-1).vars.rc;
    t.ok('bot was told the user did not approve', denied.isError && /did not approve/.test(denied.text), denied.text);
    t.eq('no room after deny', (await rooms()).length, before);
    const b = await h.call('POST', '/api/tasks', { agentId: 'builder', prompt: 'harness-room-allow' });
    const card2 = await h.waitApproval();
    await h.call('POST', `/api/approvals/${card2.id}`, { allow: true });
    await h.waitTask(b.json.id);
    const made = await rooms();
    t.eq('exactly one new room', made.length, before + 1);
    const room = made.find((r) => r.name === 'Harness crew');
    t.ok('room exists, created by the bot, no default budget', room && room.createdBy === 'builder' && room.guards.budgetUsd === null, room);
    t.eq('token cannot delete the room', (await h.call('DELETE', `/api/rooms/${room.id}`, undefined, 'token')).status, 403);
    t.eq('admin can delete it', (await h.call('DELETE', `/api/rooms/${room.id}`)).status, 200);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'mcp-token-limits',
  proves: ['With only the MCP-class bearer token, the short client list works (state, agents, start a task) and everything else answers 403 admin_required, including unknown paths (default deny) and the BSV policy changes.',
    'No bearer at all is 401; /health is open and says only whether a secret exists.',
    'A task started with the token alone carries origin {roomId:"mcp", approvalCeiling:"ask"}, so even a `full` agent runs in default mode with approval cards.',
    'Freeze is the one BSV policy route the token can reach.'],
  doesNotProve: ['Anything about a process that can read Legion\'s memory or files as the same OS user (SECURITY.md lists that residual), or about /mcp tool calls over the MCP transport (test/mcp*.test.ts).'],
  async run(h, t) {
    await h.resetModel();
    const s = (method, path, body, auth) => h.call(method, path, body, auth).then((r) => r.status);
    t.eq('/health open', await s('GET', '/health', undefined, 'none'), 200);
    const hz = (await h.call('GET', '/health', undefined, 'none')).json;
    t.ok('/health reports a boolean, not a secret', hz.admin === true && !JSON.stringify(hz).match(/[0-9a-f]{32}/), hz);
    t.eq('no bearer is 401', await s('GET', '/api/state', undefined, 'none'), 401);
    t.eq('GET /api/state', await s('GET', '/api/state', undefined, 'token'), 200);
    t.eq('GET /api/agents', await s('GET', '/api/agents', undefined, 'token'), 200);
    for (const [m, p] of [['GET', '/api/rooms'], ['GET', '/api/settings'], ['GET', '/api/config'], ['GET', '/api/approvals'], ['GET', '/api/kg/inbox'], ['GET', '/api/bsv'], ['GET', '/api/bsv/wallet'], ['GET', '/api/blender'], ['GET', '/api/vms'], ['POST', '/api/vms/scout/start'], ['POST', '/api/approvals/apr_none'], ['PATCH', '/api/agents/scout'], ['GET', '/api/no-such-route']]) {
      t.eq(`${m} ${p} refuses the token`, await s(m, p, m === 'GET' ? undefined : {}, 'token'), 403);
    }
    t.eq('arm needs the native secret too (token)', await s('POST', '/api/bsv/policy/arm', { minutes: 5 }, 'token'), 403);
    t.eq('arm needs the native secret (admin without native)', await s('POST', '/api/bsv/policy/arm', { minutes: 5 }, 'admin'), 403);
    t.eq('toggle BSV needs admin', await s('POST', '/api/bsv', { enabled: true }, 'token'), 403);
    const frz = await h.call('POST', '/api/bsv/policy/freeze', { reason: 'harness: token freeze' }, 'token');
    t.ok('the token CAN freeze (stop-only)', frz.status === 200 && !!frz.json.frozen, frz.json);
    // a task from the token alone is capped at `ask`, even for a `full` agent
    await h.script({ agent: 'builder', promptIncludes: 'harness-capped' }, [{ tool: 'Bash', input: { command: 'echo capped' }, as: 'b' }, { result: 'capped-done' }]);
    const started = await h.call('POST', '/api/tasks', { agentId: 'builder', prompt: 'harness-capped' }, 'token');
    t.eq('token can start a task', started.status, 201);
    t.eq('origin is the MCP origin with the ask ceiling', [started.json.origin?.roomId, started.json.origin?.approvalCeiling], ['mcp', 'ask']);
    const card = await h.waitApproval();
    t.eq('the full agent still needs a card for Bash', card.toolName, 'Bash');
    await h.call('POST', `/api/approvals/${card.id}`, { allow: false });
    await h.waitTask(started.json.id);
    const run = (await h.modelLog()).at(-1);
    t.eq('run was in default mode with canUseTool', [run.permissionMode, run.hasCanUseTool], ['default', true]);
    // the same agent started by the app (admin) is bypass mode
    await h.script({ agent: 'builder', promptIncludes: 'harness-app' }, [{ result: 'app-done' }]);
    await h.runTask('builder', 'harness-app');
    t.eq('app-started full agent runs in bypass mode', (await h.modelLog()).at(-1).permissionMode, 'bypassPermissions');
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'library-capture-taint',
  proves: ['A clean run\'s shared kg_capture note is live; a run that used WebFetch (taint) gets a note stored untrusted and PENDING in the Inbox, hidden from other bots.',
    'The Inbox is admin-only (token gets 403); the human can reject the held note.'],
  doesNotProve: ['That real web content is wrapped for a real model, or the Library UI. Taint here is set by the tool NAME only (WebFetch is not executed); the fuller taint matrix is in test/library-*.test.ts.'],
  async run(h, t) {
    await h.resetModel();
    const title = `Harness pattern ${Date.now()}`;
    await h.script({ agent: 'zealot', promptIncludes: 'harness-clean' }, [{ tool: 'mcp__legion_kg__kg_capture', input: { kind: 'pattern', title: `${title} clean`, fields: F }, as: 'c' }, { result: 'ok' }]);
    await h.script({ agent: 'zealot', promptIncludes: 'harness-tainted' }, [{ tool: 'WebFetch', input: { url: 'https://example.invalid/', prompt: 'x' } }, { tool: 'mcp__legion_kg__kg_capture', input: { kind: 'pattern', title: `${title} tainted`, fields: F }, as: 'c' }, { result: 'ok' }]);
    const clean = await h.runTask('zealot', 'harness-clean');
    const tainted = await h.runTask('zealot', 'harness-tainted');
    t.ok('clean run is not tainted, the WebFetch run is', !clean.tainted && tainted.tainted === true, [clean.tainted, tainted.tainted]);
    const [c1, c2] = (await h.modelLog()).slice(-2).map((r) => r.vars.c.text);
    t.ok('clean note captured live', /^Captured/.test(c1) && !/PENDING/.test(c1), c1);
    t.ok('tainted note flagged untrusted and PENDING', /untrusted/.test(c2) && /PENDING/.test(c2), c2);
    const inbox = (await h.call('GET', '/api/kg/inbox')).json;
    const held = inbox.find((i) => i.node.title === `${title} tainted`);
    t.ok('tainted note is in the Inbox as untrusted/pending', held && held.node.status === 'pending' && held.node.trust === 'untrusted' && held.tainted === true, held);
    t.ok('clean note is not in the Inbox', !inbox.some((i) => i.node.title === `${title} clean`));
    t.eq('token cannot read the Inbox', (await h.call('GET', '/api/kg/inbox', undefined, 'token')).status, 403);
    const rej = await h.call('POST', `/api/kg/inbox/${held.id}/reject`, {});
    t.eq('human rejects the held note', rej.status, 200);
    t.ok('rejected note leaves the Inbox', !((await h.call('GET', '/api/kg/inbox')).json.some((i) => i.id === held.id)));
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'boat-lazy-key-probe',
  proves: ['Core start (with a boat.dev key configured and no stored VMs) makes ZERO boat.dev calls.',
    'The key-permission probe runs on the first VM use, never creates a sandbox (exactly one POST /sandboxes, the VM itself), and runs once, not on every call.'],
  doesNotProve: ['What the real boat.dev answers: the fake mirrors three error bodies seen in real use and nothing more (docs/VM-NOTES.md, "Not verified against the real boat.dev"). The real-key check K1 is owner-only.'],
  async run(h, t) {
    await h.resetModel();
    const fresh = (await h.boat()).requests.length === 0;
    // a shared stack may already have used the fake boat; the claim is about THIS stack's start, so restart the core and look again
    if (!fresh) { await h.boatClear(); await h.restartCore(); }
    await new Promise((r) => setTimeout(r, 1200));
    t.eq('zero boat.dev requests after core start', (await h.boat()).requests, []);
    t.eq('start the VM', (await h.call('POST', '/api/vms/zealot/start')).status, 200);
    await h.until(async () => (await h.boat()).requests.some((r) => r.method === 'GET' && r.path === '/me'), 15000, 'the lazy probe');
    await new Promise((r) => setTimeout(r, 800));
    const reqs = (await h.boat()).requests;
    t.eq('exactly one sandbox was created (the VM), the probe creates none', reqs.filter((r) => r.method === 'POST' && r.path === '/sandboxes').length, 1);
    const probes = reqs.filter((r) => r.method === 'GET' && r.path === '/me').length;
    await h.call('POST', '/api/vms/zealot/stop');
    await h.call('POST', '/api/vms/zealot/start');
    const probes2 = (await h.boat()).requests.filter((r) => r.method === 'GET' && r.path === '/me').length;
    t.eq('a second VM start does not probe again', probes2, probes);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'vm-start-stop',
  proves: ['VM start and stop go through the real VmManager to the fake boat.dev: the sandbox is created, usage is reported, stop snapshots it and Legion confirms the state with a follow-up read.',
    'A stop with boat.dev ignoring it is reported as NOT stopped ("may still be billing"), not as success.',
    'The token cannot start or stop a VM.'],
  doesNotProve: ['Real boat.dev behaviour, timing, billing or the desktop stream; Windows paths; the Computer card UI.'],
  async run(h, t) {
    await h.resetModel(); await h.boatClear(); await h.boatConfig({ stopSticks: false });
    t.eq('token cannot start a VM', (await h.call('POST', '/api/vms/zealot/start', {}, 'token')).status, 403);
    const start = await h.call('POST', '/api/vms/zealot/start');
    t.eq('start', start.status, 200);
    t.ok('VM is usable', ['ready', 'running', 'idle'].includes(start.json.state), start.json.state);
    const usage = (await h.call('GET', '/api/vms/zealot/usage')).json;
    t.eq('usage says running', usage.running, true);
    const stop = await h.call('POST', '/api/vms/zealot/stop');
    t.ok('stop confirmed', stop.status === 200 && stop.json.stopped === true && stop.json.verified === true, stop.json);
    t.ok('fake boat shows the sandbox archived', (await h.boat()).sandboxes.some((s) => s.state === 'archived'));
    // a boat.dev that ignores stop
    await h.boatConfig({ stopSticks: true });
    await h.call('POST', '/api/vms/zealot/start');
    const stuck = await h.call('POST', '/api/vms/zealot/stop');
    t.ok('a sticky stop is not reported as success', stuck.json.stopped === false, stuck.json);
    await h.boatConfig({ stopSticks: false });
    await h.call('POST', '/api/vms/zealot/stop');
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'bsv-readonly',
  proves: ['A wallet connect needs the admin secret AND the native secret; the admin secret alone is refused. (The native DIALOG is emulated by sending the native header, as Electron main does after its dialog.)',
    'A non-loopback address is refused with zero contact; with a loopback fake wallet, the probe sends exactly the four read-only questions (getVersion, getNetwork, isAuthenticated, getHeight) and nothing else reaches the wire.',
    'The Assayer\'s bsv_status tool needs a card (it is not a Legion-trusted name), returns the wallet\'s answer wrapped as untrusted data, and the run is tainted.',
    'A hand-edited bsv.walletUrl in config.json is NOT used after a restart (not connected, zero wallet requests).',
    'Freeze works from the token class and blocks arming.'],
  doesNotProve: ['Any real BRC-100 wallet behaviour, the real Electron native dialog, wallet prompts, spends (no spend tool exists on this base), mainnet, or anything about the owner\'s funded wallet (never contacted; the harness refuses its port).'],
  async run(h, t) {
    await h.resetModel(); await h.walletClear();
    const wurl = (await h.wallet()).url;
    assertSafeWalletTarget(wurl);
    t.eq('BSV mode on (admin)', (await h.call('POST', '/api/bsv', { enabled: true })).json.enabled, true);
    const adminOnly = await h.call('POST', '/api/bsv/wallet/connect', { url: wurl }, 'admin');
    t.ok('admin alone cannot connect', adminOnly.status === 403 && /native/.test(adminOnly.json.error), adminOnly.json);
    t.eq('still no contact', (await h.wallet()).seen.length, 0);
    const bad = await h.call('POST', '/api/bsv/wallet/connect', { url: 'http://example.com:8080' }, 'native');
    t.eq('non-loopback refused', bad.status, 400);
    t.eq('refused address caused zero contact', (await h.wallet()).seen.length, 0);
    const ok = await h.call('POST', '/api/bsv/wallet/connect', { url: wurl }, 'native');
    t.ok('connected and reachable on a testnet claim', ok.status === 200 && ok.json.connected && ok.json.reachable && ok.json.condition === 'testnet', ok.json);
    const w = await h.wallet();
    t.eq('exactly the four probe questions were sent', w.seen.map((s) => s.method), ['getVersion', 'getNetwork', 'isAuthenticated', 'getHeight']);
    t.eq('nothing off the allowlist reached the wallet', w.offAllowlist, []);
    t.ok('every call was a POST with an empty body and the legion.local origin', w.seen.every((s) => s.httpMethod === 'POST' && s.body === '{}' && /legion\.local/.test(s.origin ?? '')), w.seen[0]);
    // the Assayer's tool
    await h.script({ agent: 'assayer', promptIncludes: 'harness-bsv-status' }, [{ tool: 'mcp__legion_bsv__bsv_status', input: {}, as: 's' }, { result: 'checked' }]);
    const run = await h.call('POST', '/api/tasks', { agentId: 'assayer', prompt: 'harness-bsv-status' });
    const card = await h.waitApproval();
    t.eq('bsv_status needs a card', card.toolName, 'mcp__legion_bsv__bsv_status');
    await h.call('POST', `/api/approvals/${card.id}`, { allow: true });
    const done = await h.waitTask(run.json.id);
    const s = (await h.modelLog()).at(-1).vars.s;
    t.ok('answer is wrapped as untrusted data and says testnet', /<bsv-wallet-status untrusted="true">/.test(s.text) && /testnet/.test(s.text), s.text.slice(0, 200));
    t.eq('the run is tainted', done.tainted, true);
    // freeze from the token class
    const frz = await h.call('POST', '/api/bsv/policy/freeze', { reason: 'harness' }, 'token');
    t.ok('token freeze works', frz.status === 200 && !!frz.json.frozen, frz.json);
    const arm = await h.call('POST', '/api/bsv/policy/arm', { minutes: 5 }, 'native');
    t.eq('arming a frozen chain is refused', arm.status, 409);
    t.eq('wallet disconnected by the freeze', (await h.call('GET', '/api/bsv/wallet')).json.connected, false);
    // hand-edited walletUrl
    await h.restartCore({ bsv: { enabled: true, walletUrl: wurl } });
    await h.walletClear();
    const after = (await h.call('GET', '/api/bsv/wallet')).json;
    t.ok('after a restart with a hand-edited walletUrl the wallet is not connected', after.connected === false && after.probed === false, after);
    t.eq('and no wallet request was made', (await h.wallet()).seen.length, 0);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'bsv-policy-tamper',
  proves: ['A BSV policy change made with admin + native is saved to bsv/policy.json and recorded in the hash-chained audit log.',
    'A hand edit of that file (caps raised to a large value) is noticed on the next policy read: the chain freezes, the edited file is kept aside as evidence, the caps in force stay the recorded ones, and the audit log gets a file-tampered line. It stays frozen after a core restart.'],
  doesNotProve: ['Protection against a program that rewrites the policy file AND the audit log AND its head anchor consistently (docs/BSV-MODE.md lists this as a residual), or any real wallet behaviour.'],
  async run(h, t) {
    await h.resetModel();
    t.eq('BSV on', (await h.call('POST', '/api/bsv', { enabled: true })).json.enabled, true);
    const set = await h.call('POST', '/api/bsv/policy/caps', { perTxSats: 500 }, 'native');
    t.ok('caps change accepted with native', set.status === 200 && set.json.caps.perTxSats === 500, set.json);
    const file = JSON.parse((await h.homeFile('read', 'bsv/policy.json')).content);
    t.eq('the file holds the new cap', file.caps.perTxSats, 500);
    file.caps.perTxSats = 900000;
    await h.homeFile('write', 'bsv/policy.json', JSON.stringify(file));
    const view = (await h.call('GET', '/api/bsv/policy')).json;
    t.ok('the next policy read freezes the chain', !!view.frozen && /outside Legion/.test(view.frozen.reason), view.frozen);
    t.eq('the cap in force is still the recorded one', view.caps.perTxSats, 500);
    t.ok('the edited file was kept as evidence', (await h.homeFile('list', 'bsv')).files.some((n) => n.startsWith('policy.json.tampered-')));
    const audit = (await h.call('GET', '/api/bsv/audit')).json;
    t.ok('the audit log has a file-tampered line', audit.entries.some((e) => e.decision === 'file-tampered'), audit.entries.map((e) => e.decision));
    await h.restartCore();
    const again = (await h.call('GET', '/api/bsv/policy')).json;
    t.ok('still frozen after a restart, cap unchanged', !!again.frozen && again.caps.perTxSats === 500, again);
    t.eq('unfreeze needs native (admin alone is refused)', (await h.call('POST', '/api/bsv/policy/unfreeze', {}, 'admin')).status, 403);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'blender-off-and-fake-exe',
  proves: ['The Blender bridge is off by default, admin-only, and the in-process legion_blender server is not given to a normal agent.',
    'The fake `blender` executable answers --version and records a --background --python call without running it (the base for the future local headless mode).'],
  doesNotProve: ['Anything about real Blender, bpy, the static check, the sandbox VM path or the live socket (see docs/TESTING-BLENDER.md); the LOCAL headless mode is not on this base, so no scenario drives it yet.'],
  async run(h, t) {
    await h.resetModel();
    const b = await h.call('GET', '/api/blender');
    t.ok('bridge off by default', b.status === 200 && b.json.enabled === false && b.json.light === 'off', b.json);
    t.eq('token cannot read it', (await h.call('GET', '/api/blender', undefined, 'token')).status, 403);
    t.eq('token cannot configure it', (await h.call('POST', '/api/blender/config', { enabled: true }, 'token')).status, 403);
    await h.script({ agent: 'scout', promptIncludes: 'harness-blender-servers' }, [{ result: 'ok' }]);
    await h.runTask('scout', 'harness-blender-servers');
    t.ok('a normal agent has no legion_blender server', !(await h.modelLog()).at(-1).servers.includes('legion_blender'));
    const exe = (await h.status()).blender;
    const v = spawnSync(process.execPath, [exe, '--version'], { encoding: 'utf8' });
    t.ok('fake blender prints a version line', /^Blender 5\.1\.0/.test(v.stdout), v.stdout);
    const bg = spawnSync(process.execPath, [exe, '--background', '--python', 'x.py'], { encoding: 'utf8' });
    t.ok('fake blender does not execute scripts', bg.status === 0 && /not executed/.test(bg.stdout), bg.stdout);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
scenario({
  name: 'harness-guards',
  proves: ['The fake wallet refuses to bind the forbidden real-wallet port and refuses non-loopback targets (the guard that keeps every other scenario away from the owner\'s wallet).'],
  doesNotProve: ['Anything about Legion. This checks the harness itself only.'],
  async run(_h, t) {
    let threw = false;
    try { await startFakeWallet({ port: FORBIDDEN_PORT }); } catch { threw = true; }
    t.ok('binding the forbidden port is refused', threw);
    for (const bad of ['http://192.168.1.5:8080', `http://127.0.0.1:${FORBIDDEN_PORT}`, `http://localhost:${FORBIDDEN_PORT}`, 'http://example.com:9']) {
      let refused = false; try { assertSafeWalletTarget(bad); } catch { refused = true; }
      t.ok(`target refused: ${bad.replace(/:\d+$/, ':<port>')}`, refused);
    }
    const w = await startFakeWallet();
    t.ok('a fake wallet gets a random port that is not the forbidden one', w.port !== FORBIDDEN_PORT);
    await w.stop();
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
/** Runs scenarios. With `shared` (a handle) they run in that stack; otherwise each gets a fresh stack that is stopped afterwards. */
export async function runScenarios(names, shared, { verbose = false } = {}) {
  const results = [];
  for (const name of names) {
    const sc = SCENARIOS.find((s) => s.name === name);
    const t = new Check();
    const started = Date.now();
    let handle = shared; let own = false; let error;
    try {
      if (!handle) { handle = await startHarness(); own = true; }
      await sc.run(client(handle), t);
    } catch (e) { error = String(e?.message ?? e); }
    let cleanup;
    if (own && handle) cleanup = await stopHarness(handle);
    results.push({
      name, status: error ? 'FAIL' : 'PASS', ms: Date.now() - started, checks: t.checks.length, ...(error ? { error } : {}),
      ...(cleanup && (cleanup.pidsAlive.length || cleanup.dirLeft) ? { cleanup } : {}),
      ...(verbose ? { proves: sc.proves, doesNotProve: sc.doesNotProve } : {}),
    });
  }
  const failed = results.filter((r) => r.status === 'FAIL').length;
  return { ok: failed === 0, passed: results.length - failed, failed, results };
}
