// Round-6 shots + functional checks against the mock. node ui/dev/r6.mjs [only]
const PW = process.env.PW || '/tmp/claude-0/pw/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots/r6/after');
const only = process.argv[2];
const PORT = 47811; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const log = [];
let n = 0;
async function scene(name, flags, fn, { w = 1280, h = 820, theme = 'dark', shot = true, scale = 1 } = {}) {
  if (only && !name.includes(only)) return;
  const tok = `${flags}.r6${Date.now()}${n++}`; // fresh mock state per scene
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await ctx.addInitScript((t) => { try { localStorage.setItem('legion.theme', t); localStorage.setItem('legion.onboarded', '1'); } catch {} }, theme);
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html?base=http://127.0.0.1:${PORT}&token=${tok}`); await page.waitForSelector('.app'); await sleep(900);
  page.tok = tok;
  const res = await fn(page);
  const ov = await page.evaluate(() => { const b = []; document.querySelectorAll('.settings,.set-body,.set-card,.ops,.ops-inner,.rail,.thread,.composer-wrap,.task-menu,.tasks-bar').forEach((e) => { if (e.scrollWidth > e.clientWidth + 1 && !e.classList.contains('tasks-bar')) b.push(e.className.split(' ')[0] + ':' + e.scrollWidth + '>' + e.clientWidth); }); return b; });
  if (shot) await page.screenshot({ path: `${out}/${name}.png` });
  log.push(`${name}: ${res ?? ''}${ov.length ? ' OVERFLOW ' + ov : ''}${errs.length ? ' ERR ' + errs[0] : ''}`);
  await ctx.close();
}
const emit = (page, e) => fetch(`http://127.0.0.1:${PORT}/__emit?token=${page.tok}`, { method: 'POST', headers: { Authorization: `Bearer ${page.tok}` }, body: JSON.stringify(e) });
const txt = (p, s) => p.locator(s).first().innerText().catch(() => 'none');
const sizes = [[1280, 820], [960, 600]];
for (const th of ['dark', 'light']) for (const [w, h] of sizes) {
  const t = `${th}-${w}x${h}`; const o = { theme: th, w, h };
  await scene(`settings-claude-${t}`, '', async (p) => { await p.keyboard.press('Control+,'); await sleep(500); return 'open=' + (await p.locator('.settings').count()); }, o);
  await scene(`settings-boat-none-${t}`, 'noboat', async (p) => { await p.keyboard.press('Control+k'); await p.keyboard.type('boat.dev key'); await p.keyboard.press('Enter'); await sleep(600); return await txt(p, '.set-status'); }, o);
  await scene(`settings-boat-ok-${t}`, '', async (p) => { await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("boat.dev")').click(); await sleep(1400); return (await txt(p, '.set-status')).replace(/\n/g, ' '); }, o);
  await scene(`settings-mcp-${t}`, 'mcp', async (p) => { await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("MCP")').click(); await sleep(300); await p.locator('.mcp-list li').first().locator('button:has-text("Edit")').click(); await sleep(300); return 'rows=' + await p.locator('.mcp-list li').count(); }, o);
  await scene(`settings-connections-${t}`, '', async (p) => { await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("Connections")').click(); await sleep(300); return (await p.locator('.set-code pre').first().innerText()).slice(-40); }, o);
  await scene(`settings-about-${t}`, '', async (p) => { await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("About")').click(); await sleep(300); return (await txt(p, '.set-about')).replace(/\n/g, ' | '); }, o);
  await scene(`doctor-${t}`, '', async (p) => { await p.locator('.tb-doctor').click(); await sleep(800); const c = await p.evaluate(() => [...document.querySelectorAll('.check')].map((e) => e.className.replace('check ', '') + ':' + getComputedStyle(e.querySelector('.check-ic')).color).join(' ')); return c; }, o);
  await scene(`tabs-menu-${t}`, 'bridge', async (p) => { const tab = p.locator('.tab[role=tab]').first(); await tab.hover(); await sleep(200); await tab.click({ button: 'right' }); await sleep(300); return 'menu=' + await p.locator('.task-menu').count(); }, o);
  await scene(`bridge-zealot-${t}`, 'bridge', async (p) => { await p.locator('.tab[role=tab]').first().click(); await sleep(400); const chips = await p.locator('.chip.bridge b').allInnerTexts(); await p.locator('.chip.bridge').nth(1).click(); await sleep(200); return chips.join(' | '); }, o);
  await scene(`bridge-builder-${t}`, 'bridge', async (p) => { await p.keyboard.press('Alt+2'); await sleep(500); await p.locator('.tab[role=tab]').filter({ hasText: 'from Marshal' }).first().click(); await sleep(500); return (await txt(p, '.msg.from-agent')).replace(/\n/g, ' | ') + ' // chip=' + await txt(p, '.tab .from-chip'); }, o);
}
await scene('doctor-good-heartbeat', 'doctor-pass', async (p) => { await sleep(600); const c = await p.evaluate(() => { const i = document.querySelector('.tb-doctor .icon'); const s = getComputedStyle(i); return `cls=${document.querySelector('.tb-doctor').className} color=${s.color} anim=${s.animationName} dur=${s.animationDuration}`; }); return c; }, { scale: 2 });
await scene('doctor-bad-unchanged', '', async (p) => { const i = await p.evaluate(() => { const b = document.querySelector('.tb-doctor'); return `cls=${b.className} anim=${getComputedStyle(b.querySelector('.icon')).animationName}`; }); return i; }, { scale: 2 });
// functional: boat key flow
await scene('f-boat-flow', 'noboat', async (p) => {
  await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("boat.dev")').click(); await sleep(300);
  const r = [];
  r.push('status0=' + await txt(p, '.set-status'));
  await p.locator('#boat-key').fill('abc1234bad'); await p.locator('button:text-is("Test")').click(); await sleep(1100); r.push('badTest=' + await txt(p, '.set-test'));
  await p.locator('#boat-key').fill('abc1234a3f9'); await p.locator('button:text-is("Test")').click(); await sleep(1100); r.push('okTest=' + await txt(p, '.set-test'));
  await p.locator('button:text-is("Save")').click(); await sleep(1600); r.push('toast=' + await txt(p, '.toast')); r.push('status1=' + await txt(p, '.set-status')); r.push('inputEmpty=' + (await p.locator('#boat-key').inputValue() === '') + ' ph=' + await p.locator('#boat-key').getAttribute('placeholder'));
  r.push('computerCardHasKeyMsg=' + await p.evaluate(() => fetch('/api/state?token=x').then(() => 'n/a')));
  await p.locator('button:has-text("Remove key")').first().click(); await p.locator('button:has-text("Yes, remove")').click(); await sleep(800); r.push('afterRemove=' + await txt(p, '.set-status'));
  return r.join(' || ');
}, { shot: false });
await scene('f-claude-validation', '', async (p) => {
  await p.keyboard.press('Control+,'); await sleep(400); const r = [];
  await p.locator('#claude-turns').fill('0'); await p.locator('button:text-is("Save")').click(); await sleep(300); r.push('turns0=' + await txt(p, '.set-error'));
  await p.locator('#claude-turns').fill('60'); await p.locator('button:text-is("API key")').click(); await p.locator('button:text-is("Save")').click(); await sleep(300); r.push('noKey=' + await txt(p, '.set-error'));
  await p.locator('#claude-key').fill('sk-ant-zzzz9999'); await p.locator('button:text-is("Save")').click(); await sleep(900); r.push('saved=' + await txt(p, '.toast') + ' hint=' + await p.locator('#claude-key').getAttribute('placeholder') + ' leaked=' + (await p.content()).includes('sk-ant-zzzz9999'));
  return r.join(' || ');
}, { shot: false });
await scene('f-mcp-flow', '', async (p) => {
  await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("MCP")').click(); await sleep(200); const r = [];
  await p.locator('button:has-text("Add server")').click(); await p.locator('#mcp-name').fill('bad name'); await p.locator('button:has-text("Add server")').last().click(); await sleep(250); r.push('badName=' + await txt(p, '.set-error'));
  await p.locator('#mcp-name').fill('gh'); await p.locator('button:has-text("Add server")').last().click(); await sleep(250); r.push('noCmd=' + await txt(p, '.set-error'));
  await p.locator('#mcp-cmd').fill('npx'); await p.locator('#mcp-args').fill('-y\npkg'); await p.locator('button:has-text("Add server")').last().click(); await sleep(700); r.push('rows=' + await p.locator('.mcp-list li').count());
  await p.locator('.mcp-list li button:has-text("Remove")').first().click(); await p.locator('.mcp-list li button:text-is("Yes")').click(); await sleep(600); r.push('afterRm=' + await p.locator('.mcp-list li').count());
  return r.join(' || ');
}, { shot: false });
// tasks: close, middle click, rename, delete, show closed, task.deleted
await scene('f-task-mgmt', 'bridge', async (p) => {
  const r = []; const tabs = () => p.locator('.tab[role=tab]'); const c0 = await tabs().count(); r.push('tabs0=' + c0);
  await tabs().first().hover(); await tabs().first().locator('.tab-x').click(); await sleep(400); r.push('afterX=' + await tabs().count());
  await tabs().first().click({ button: 'middle' }); await sleep(400); r.push('afterMiddle=' + await tabs().count());
  await p.locator('.show-closed').click(); await sleep(700); r.push('showClosedRows=' + await p.locator('.recent button.closed').count());
  await p.locator('.recent button.closed').first().click(); await sleep(500); r.push('reopened closedLeft=' + await p.locator('.recent button.closed').count() + ' tabs=' + await tabs().count());
  await tabs().first().click({ button: 'right' }); await p.locator('.task-menu button:has-text("Rename")').click(); await p.locator('.rename-input').fill('Renamed task'); await p.keyboard.press('Enter'); await sleep(500); r.push('renamed=' + await tabs().first().innerText().then((t) => t.split('\n')[0]) + ' recent=' + (await p.locator('.recent .r-title').allInnerTexts()).includes('Renamed task'));
  // delete: running task disabled
  await p.locator('.recent button:has-text("landing")').click({ button: 'right' }); await sleep(200); r.push('deleteDisabledWhileRunning=' + await p.locator('.task-menu .tm-item.danger').isDisabled() + ' stopItem=' + await p.locator('.task-menu button:has-text("Stop")').count()); await p.keyboard.press('Escape'); await sleep(200);
  await p.locator('.recent button:has-text("Summarise")').click({ button: 'right' }); await p.locator('.task-menu button:has-text("Delete")').click(); r.push('confirmShown=' + await p.locator('.tm-note').count()); await p.locator('.task-menu button:has-text("Delete for good")').click(); await sleep(600); r.push('afterDelete=' + (await p.locator('.recent .r-title').allInnerTexts()).some((t) => /Summarise/.test(t)));
  await emit(p, { type: 'task.deleted', taskId: 't5' }); await sleep(400); r.push('eventDeleted t5 present=' + (await p.locator('.recent .r-title').allInnerTexts()).some((t) => /deploy client/.test(t)));
  return r.join(' || ');
}, { shot: false });
await scene('mascot-bridge-note', 'bridge', async (p) => {
  await p.locator('.tab[role=tab]').first().click(); await sleep(400);
  await emit(p, { type: 'task.updated', task: { id: 't1', agentId: 'zealot', title: 'Audit', status: 'running', source: 'ui', requestedModel: 'auto', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  await emit(p, { type: 'message', message: { id: 'live1', taskId: 't1', role: 'tool', toolName: 'mcp__legion__ask', text: JSON.stringify({ agent: 'builder', message: 'Run the tests' }), at: new Date().toISOString() } });
  await emit(p, { type: 'mascot', mood: 'thinking' }); await sleep(900);
  return 'label=' + (await txt(p, '.mood-label')).replace(/\n/g, ' ');
}, { shot: true });
console.log(log.join('\n'));
await browser.close();
