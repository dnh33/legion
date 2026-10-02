// Regression check: typing in a dialog's text field must keep focus in that field, letter after letter.
// Bug it guards (New room dialog): the focus jumped to the close button after one letter, because the Modal's
// focus effect depended on the (inline, so new every render) onClose and ran again on every keystroke.
// Usage: node test-perf/ui-app/check-dialog-focus.mjs [dist-ui dir] [repo dir]
// Real core + real UI build via env.mjs. LEGION_HOME stays under /tmp/m/wt-rooms-home*.
import { startEnv, openPage, SECRET } from './env.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const ui = path.resolve(process.argv[2] ?? path.join(repo, 'dist-ui'));
const env = await startEnv({ ui, repo, port: 48300, home: `/tmp/m/wt-rooms-home-focus-${process.pid}` });
const { browser, page, errs } = await openPage(env);
const results = [];
const TEXT = 'Launch crew 2';

async function focusInfo() {
  return page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, label: a?.getAttribute?.('aria-label') ?? '', value: a && 'value' in a ? a.value : undefined, cls: a?.className ?? '' };
  });
}
/** Types like a person (one key at a time) and checks focus after every single key. */
async function typeAndCheck(name, selector) {
  const trace = [];
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.locator(selector).first().focus();
  await page.keyboard.press('Control+a'); // fields can start filled (Room settings): replace the content
  let lost = null;
  for (const ch of TEXT) {
    await page.keyboard.type(ch, { delay: 10 });
    await page.waitForTimeout(25);
    const f = await focusInfo();
    trace.push(f.tag + (f.label ? `[${f.label}]` : ''));
    const stillIn = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector);
    if (!stillIn && !lost) lost = { after: JSON.stringify(ch), focusOn: f.tag + (f.label ? ` "${f.label}"` : '') };
  }
  const value = await page.locator(selector).first().inputValue();
  const ok = !lost && value === TEXT;
  results.push({ name, ok, value, ...(lost ? { focusLost: lost } : {}) });
}
const openedFocus = async (name, selector) => {
  // the field that should hold focus when the dialog opens
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.waitForTimeout(100);
  const on = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector);
  results.push({ name: name + ' autofocus on open', ok: on });
};
const api = (p, init = {}) => fetch(env.base + p, { ...init, headers: { authorization: `Bearer ${env.token}`, 'x-legion-admin': SECRET, 'content-type': 'application/json', ...(init.headers ?? {}) } });

try {
  const agents = await (await api('/api/agents')).json();
  const ids = agents.map((a) => a.id);
  const roomRes = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Focus room', members: ids.slice(0, 2) }) });
  if (!roomRes.ok) throw new Error('could not create the test room: ' + (await roomRes.text()));
  await page.reload(); await page.waitForSelector('.titlebar'); await page.waitForTimeout(800);

  // 1. New room (the owner's report)
  await page.click('[role=tab][aria-label=Rooms]');
  await page.waitForSelector('.rooms');
  await page.click('button[aria-label="New room"]');
  await openedFocus('New room', '[role=dialog] input[data-autofocus]');
  await typeAndCheck('New room: Name', '[role=dialog] input[data-autofocus]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  // 2. Room settings: Name
  await page.click('.rm-list [role=option], .rm-list li button, .rm-list button.rm-item', { timeout: 3000 }).catch(() => {});
  await page.click('button[aria-label="Room settings"]');
  await openedFocus('Room settings', '[role=dialog] input[data-autofocus]');
  await typeAndCheck('Room settings: Name', '[role=dialog] input[data-autofocus]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  // 3. Command palette (not a Modal)
  await page.click('[role=tab][aria-label=Chat]');
  await page.keyboard.press('Control+k');
  await typeAndCheck('Command palette', '.palette input');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached' });

  // 4. New agent (AgentEditor Modal)
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input');
  await page.keyboard.type('new agent', { delay: 10 });
  await page.keyboard.press('Enter');
  await openedFocus('New agent', '[role=dialog] input[data-autofocus]');
  await typeAndCheck('New agent: Name', '[role=dialog] input[data-autofocus]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  // 5. Settings > MCP servers > Add server (inline form, not a Modal)
  await page.click('button[aria-label=Settings]');
  await page.waitForSelector('.set-section, .settings');
  const mcpTab = page.locator('text=MCP servers').first();
  if (await mcpTab.count()) await mcpTab.click();
  const add = page.locator('button:has-text("Add server")').first();
  if (await add.count()) { await add.click(); await typeAndCheck('Settings: MCP server Name', '#mcp-name'); }
  else results.push({ name: 'Settings: MCP server Name', ok: false, skipped: 'Add server button not found' });
  await page.click('button[aria-label=Settings]'); // toggles the panel closed

  // 6. Library: New note dialog
  await page.click('[role=tab][aria-label^=Library]');
  await page.waitForTimeout(2500);
  const nn = page.locator('button:has-text("New note"), button:has-text("Write the first note")').first();
  if (await nn.count()) {
    await nn.click();
    await openedFocus('Library New note', '[role=dialog] input[data-autofocus]');
    await typeAndCheck('Library New note: Title', '[role=dialog] input[data-autofocus]');
  } else results.push({ name: 'Library New note: Title', ok: false, skipped: 'New note button not found' });
} catch (e) {
  results.push({ name: 'harness', ok: false, error: String(e?.message ?? e).split('\n')[0] });
}

for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', JSON.stringify(r));
if (errs.length) console.log('page errors:', errs);
await browser.close(); await env.stop();
process.exit(results.every((r) => r.ok) ? 0 : 1);
