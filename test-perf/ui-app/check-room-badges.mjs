// Visual check: a room created by a bot is marked in the list, header and settings; a room request card reads as one; a task row
// shows the model another bot chose; a room message shows the model it asked for. Real core + real UI build; synthetic events.
// Usage: node test-perf/ui-app/check-room-badges.mjs [dist-ui dir] [repo dir] [screenshot dir]
import { startEnv, openPage, SECRET } from './env.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const ui = path.resolve(process.argv[2] ?? path.join(repo, 'dist-ui'));
const shots = process.argv[4] ?? '/tmp/m/wt-rooms-shots';
fs.mkdirSync(shots, { recursive: true });
const env = await startEnv({ ui, repo, port: 48400, home: `/tmp/m/wt-rooms-home-badges-${process.pid}` });
const { browser, page, errs } = await openPage(env);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const api = (p, init = {}) => fetch(env.base + p, { ...init, headers: { authorization: `Bearer ${env.token}`, 'x-legion-admin': SECRET, 'content-type': 'application/json', ...(init.headers ?? {}) } });
try {
  const agents = await (await api('/api/agents')).json();
  const [a, b] = agents.map((x) => x.id);
  const room = await (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Made by a bot', members: [a, b] }) })).json();
  // the core never lets the API set createdBy (only an approved room_create does), so tell the app through its own event stream
  const room2 = { ...room, createdBy: a };
  await page.reload(); await page.waitForSelector('.titlebar');
  await page.click('[role=tab][aria-label=Rooms]');
  await page.waitForSelector('.rm-row');
  await env.emit({ type: 'room.updated', room: room2 });
  await env.emit({ type: 'room.message', message: { id: 'rmsg_x1', roomId: room.id, from: { kind: 'bot', agentId: a }, to: [b], kind: 'chat', text: `@${b} quick check, answer in one line.`, at: new Date().toISOString(), hop: 1, model: 'haiku' } });
  await page.click('.rm-row');
  await page.waitForTimeout(400);
  check('list row shows "by <bot>"', (await page.locator('.rm-row .rm-pill', { hasText: /^by / }).count()) === 1);
  check('header shows "created by <bot>"', (await page.locator('.rm-head .rm-pill', { hasText: /created by/ }).count()) === 1);
  check('message shows the model it asked for', (await page.locator('.rm-model', { hasText: /haiku/i }).count()) === 1);
  await env.emit({ type: 'approval.requested', approval: { id: 'apr_1', taskId: 'task_x', agentId: a, toolName: 'mcp__legion_comms__room_create', summary: 'Marshal asks to create a room. The name below is the bot\'s text, not Legion\'s: Launch crew\nMembers: Zealot, Scout, Builder. Lead: Zealot.\nBudget: $1.00 (the room pauses when it is spent), 6 bot-to-bot hops at most.\nOnly you can delete the room later. Deny to stop it.', input: {}, at: new Date().toISOString(), origin: { roomId: room.id, fromAgentId: a, hop: 1 } } });
  await page.waitForSelector('.rm-approval');
  check('room request card is labelled', (await page.locator('.approval-tool', { hasText: 'Room request' }).count()) === 1);
  await page.screenshot({ path: path.join(shots, 'rooms-badges.png') });
  await page.click('button[aria-label="Room settings"]');
  await page.waitForSelector('[role=dialog]');
  check('settings explains who made the room', (await page.locator('[role=dialog] [role=note]', { hasText: /Created by/ }).count()) === 1);
  await page.screenshot({ path: path.join(shots, 'rooms-settings-createdby.png') });
  await page.keyboard.press('Escape');
  // a delegated task that another bot gave a model: its tab and its Recent-tasks row say so
  const now = new Date().toISOString();
  await page.click('[role=tab][aria-label=Chat]');
  await page.click(`.rail button:has-text("${agents[0].name}")`);
  await env.emit({ type: 'task.updated', task: { id: 'task_ov', agentId: agents[0].id, title: `${agents[1].name}: count the files`, status: 'done', source: 'agent', fromAgentId: agents[1].id, requestedModel: 'haiku', modelOverride: { model: 'haiku', by: agents[1].id }, model: 'haiku', createdAt: now, updatedAt: now } });
  await page.waitForSelector('.tasks-bar .model-chip');
  check('task tab shows the chosen model', (await page.locator('.tasks-bar .model-chip', { hasText: /Haiku/ }).count()) === 1);
  check('recent task row shows the chosen model', (await page.locator('.recent .model-chip', { hasText: /Haiku/ }).count()) === 1);
  await page.screenshot({ path: path.join(shots, 'task-model-chip.png'), clip: { x: 240, y: 0, width: 880, height: 120 } });
} catch (e) { check('harness', false, String(e?.message ?? e).split('\n')[0]); }
if (errs.length) console.log('page errors:', errs);
await browser.close(); await env.stop();
process.exit(results.every(Boolean) ? 0 : 1);
