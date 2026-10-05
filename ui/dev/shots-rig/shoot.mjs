// Screenshots of the real Legion UI, driven by the real core through the rig. Nothing is mocked here.
// Usage: node shoot.mjs <handleFile> <outDir> [theme]
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pw from 'playwright-core';
const { chromium } = pw;
import { readHandle, client } from '../../../scripts/harness/lib.mjs';

const handleFile = process.argv[2];
const out = process.argv[3] ?? 'shots';   // git-ignored: ui/dev/shots is in .gitignore
const handle = readHandle(handleFile);
const h = client(handle);
const B = 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = (await h.call('GET', '/api/state')).json;
const projects = (await h.call('GET', '/api/projects')).json;
const project = projects.find((p) => p.status === 'active') ?? projects[0];
const tasks = state.tasks ?? [];
const done = tasks.filter((t) => t.status === 'done');
const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
const approvals = (await h.call('GET', '/api/approvals')).json ?? [];
const kg = (await h.call('GET', '/api/kg/stats')).json;
const rooms = (await h.call('GET', '/api/rooms')).json;
console.log('state', JSON.stringify({ version: state.version, agents: state.agents.length, tasks: tasks.length, done: done.length, running: running.length, approvals: approvals.length, kg, rooms: rooms.length, project: project?.name }));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Start one agent's VM so the Computer card shows a real machine, not the empty state.
const vmr = await h.call('POST', '/api/vms/builder/start', {});
console.log('vm start:', vmr.status, JSON.stringify(vmr.json ?? vmr.text).slice(0, 120));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 200)));

const shot = async (name, sel) => {
  if (sel) { const el = page.locator(sel).first(); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: `${out}/${name}.png` }); }
  else await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
};

// The Electron window injects window.legion before the bundle runs. Do the same here: the rig proxy
// holds the admin secret, so the page only needs the base URL and any bearer token.
await page.addInitScript((base) => {
  window.legion = { baseUrl: base, token: 'rig', platform: 'web', openExternal: (u) => window.open(u, '_blank', 'noopener') };
}, B);
await page.goto(`${B}/index.html`);
await page.waitForSelector('.thread-inner, .empty, .center', { timeout: 15000 });
await sleep(1200);

// 1. the thread that is stopped on an approval card: the guardrail, live.
// Select the agent that owns it first, then its running task.
if (running[0]) {
  const owner = state.agents.find((a) => a.id === running[0].agentId);
  if (owner) {
    await page.locator('.rail button, .agents button').filter({ hasText: owner.name }).first().click().catch(() => {});
    await sleep(900);
  }
  await page.locator('.tasks-bar .tab').filter({ hasText: running[0].title.slice(0, 20) }).first().click().catch(() => {});
  await sleep(1400);
  const card = await page.locator('.approval, [class*=approval]').count();
  console.log('approval cards in DOM:', card);
}
await shot('01-approval-card');

// 1b. a finished run on Builder, which is the agent with a live VM: the thread with tool calls and
// a running machine in the Computer card.
const packaged = done.find((t) => /cut 0\.3/.test(t.title)) ?? done.find((t) => t.agentId === 'builder') ?? done[0];
if (packaged) {
  const owner = state.agents.find((a) => a.id === packaged.agentId);
  if (owner) {
    await page.locator('.rail button, .agents button').filter({ hasText: owner.name }).first().click().catch(() => {});
    await sleep(900);
  }
  await page.locator('.tasks-bar .tab').filter({ hasText: packaged.title.slice(0, 20) }).first().click().catch(() => {});
  await sleep(1200);
}
await shot('02-chat-dark');

// 2. the agent rail: the whole muster
await shot('03-muster', '.rail, .agents, [class*=rail]');

// 2b. the Ops panel with the painted mascot, in the chat view where it lives
const opsBtnEarly = page.locator('.icon-btn[aria-label="Toggle Ops panel"]');
if (!(await opsBtnEarly.evaluate((el) => el.classList.contains('on')).catch(() => false))) {
  await opsBtnEarly.click().catch(() => {});
  await sleep(900);
}
await shot('03b-ops-mascot');
if (await page.locator('.mascot-stage').count()) {
  await page.locator('.mascot-stage').first().screenshot({ path: `${out}/03c-mascot.png` });
  console.log('shot 03c-mascot');
}

// 3. project board
await page.locator('.tb-view').nth(0).click().catch(() => {});
await sleep(300);
await page.locator('.tb-view').nth(2).click().catch(() => {});
await sleep(1400);
await shot('04-library');

// 4. rooms
await page.locator('.tb-view').nth(1).click().catch(() => {});
await sleep(1200);
await shot('05-rooms');

// 5. the project page: board, rooms and instructions for one job
await page.locator('.tb-view').nth(0).click().catch(() => {});
await sleep(400);
// The switcher is a native <select>, so drive it as one.
await page.selectOption('#proj-select', { label: project.name });
await sleep(900);
await page.locator('.proj-actions button', { hasText: 'Project page' }).first().click();
await sleep(1800);
await shot('06-project-board');
const board = page.locator('.board, [class*=board]').first();
if (await board.count()) await shot('06b-board-only', '.board, [class*=board]');

// 6. the Ops panel and the painted mascot. It ships open, so only click when it is closed.
// The mascot is shot on its own too: that is the piece worth showing at size.
const opsBtn = page.locator('.icon-btn[aria-label="Toggle Ops panel"]');
if (!(await opsBtn.evaluate((el) => el.classList.contains('on')).catch(() => false))) {
  await opsBtn.click().catch(() => {});
  await sleep(900);
}
await shot('07-ops-mascot');
if (await page.locator('.mascot-stage').count()) {
  await page.locator('.mascot-stage').first().screenshot({ path: `${out}/07b-mascot.png` });
  console.log('shot 07b-mascot');
}
await page.locator('.tb-view').nth(0).click().catch(() => {});
await sleep(500);

// 7. light theme on the same thread, so it shows work and not the empty new-task state
// Clear the project filter first: it hides tasks that belong to no project, so the tab is not there.
await page.selectOption('#proj-select', '').catch(() => {});
await sleep(700);
const lightPick = packaged ?? running[0] ?? done[0];
if (lightPick) await page.locator('.tasks-bar .tab').filter({ hasText: lightPick.title.slice(0, 20) }).first().click().catch(() => {});
await sleep(1200);
console.log('light theme thread:', (await page.locator('.tasks-bar .tab.sel').first().textContent().catch(() => '?'))?.trim());
await page.locator('.icon-btn[aria-label="Toggle theme"]').click().catch(() => {});
await sleep(800);
await shot('08-chat-light');
await page.locator('.icon-btn[aria-label="Toggle theme"]').click().catch(() => {});
await sleep(500);

// 8. command palette
await page.keyboard.press('Control+k');
await sleep(600);
await shot('09-palette');
await page.keyboard.press('Escape');

await browser.close();
console.log('DONE');