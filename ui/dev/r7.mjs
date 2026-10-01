const { chromium } = await import(process.env.PW || '/tmp/claude-0/pw/node_modules/playwright/index.mjs');
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots/r7');
const PORT = 47811; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const log = []; let n = 0;
async function scene(name, flags, fn, { w = 1280, h = 820, theme = 'dark' } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((t) => { localStorage.setItem('legion.theme', t); localStorage.setItem('legion.onboarded', '1'); }, theme);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${PORT}/index.html?base=http://127.0.0.1:${PORT}&token=${flags}.s${Date.now()}${n++}`); await p.waitForSelector('.app'); await sleep(900);
  const r = await fn(p);
  const ov = await p.evaluate(() => [...document.querySelectorAll('.settings,.set-body,.set-card,.thread,.composer-wrap,.ops')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className.split(' ')[0]));
  await p.screenshot({ path: `${out}/${name}.png` });
  log.push(`${name}: ${r ?? ''}${ov.length ? ' OVERFLOW ' + ov : ''}${errs.length ? ' ERR ' + errs[0] : ''}`); await ctx.close();
}
const t = (p, s) => p.locator(s).first().innerText().catch(() => 'none');
for (const th of ['dark', 'light']) for (const [w, h] of [[1280, 820], [960, 600]]) {
  const o = { theme: th, w, h }; const k = `${th}-${w}x${h}`;
  await scene(`bridge-tell-${k}`, 'bridge', async (p) => { await p.locator('.tab[role=tab]').first().click(); await sleep(400); const chips = await p.locator('.chip b').allInnerTexts(); await p.locator('.chip.bridge').filter({ hasText: 'Told' }).click(); await sleep(250); await p.locator('.chip-detail').scrollIntoViewIfNeeded(); return 'chips=' + chips.join('|') + ' detail=' + (await t(p, '.bridge-detail')).replace(/\n/g, ' '); }, o);
  await scene(`bridge-ask-agents-${k}`, 'bridge', async (p) => { await p.locator('.tab[role=tab]').first().click(); await sleep(400); await p.locator('.chip.bridge').filter({ hasText: 'Asked' }).click(); await sleep(250); const a = (await t(p, '.bridge-detail')).replace(/\n/g, ' '); await p.locator('.chip.bridge').filter({ hasText: 'Checked' }).click(); await sleep(250); return 'ask=' + a.slice(0, 90) + ' || agents=' + (await t(p, '.bridge-detail')).replace(/\n/g, ' '); }, o);
  await scene(`reply-${k}`, 'bridge', async (p) => { await p.locator('.tab[role=tab]').first().click(); await sleep(400); await p.locator('.msg.from-agent').last().scrollIntoViewIfNeeded(); return (await t(p, '.msg.from-agent')).replace(/\n/g, ' | ') + ' // tag=' + await t(p, '.reply-tag'); }, o);
  await scene(`doctor-${k}`, 'noboat', async (p) => { await p.locator('.tb-doctor').click(); await sleep(700); return 'buttons=' + (await p.locator('.modal button').allInnerTexts()).filter((x) => /Settings/.test(x)).join('|'); }, o);
  await scene(`tabs-many-${k}`, 'many', async (p) => { await sleep(300); const more = await t(p, '.more-btn'); await p.locator('.more-btn').click(); await sleep(250); const rows = await p.locator('.more-item').count(); const first = await p.locator('.tab[role=tab]').first().boundingBox(); return `more="${more}" rows=${rows} firstTabX=${Math.round(first.x)}`; }, o);
  await scene(`connections-${k}`, '', async (p) => { await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("Connections")').click(); await sleep(300); return (await p.locator('.set-code pre').nth(1).innerText()).replace(/\n/g, ' '); }, o);
  await scene(`mcp-masked-${k}`, 'mcp', async (p) => { await p.keyboard.press('Control+,'); await p.locator('.set-link:has-text("MCP")').click(); await sleep(250); await p.locator('.mcp-list li').first().locator('button:has-text("Edit")').click(); await sleep(300); const ph = await p.locator('.kv-row input.is-masked').first().getAttribute('placeholder'); await p.locator('.mcp-form').scrollIntoViewIfNeeded(); await p.locator('.set-scroll').evaluate((e) => (e.scrollTop = 400)); return 'placeholder=' + ph; }, o);
}
// functional
await scene('f-r7', 'mcp', async (p) => {
  const r = [];
  await p.keyboard.press('Control+,'); await sleep(300);
  await p.locator('#claude-turns').fill('1000'); await p.locator('button:text-is("Save")').click(); await sleep(700); r.push('turns1000=' + await t(p, '.toast'));
  await p.locator('#claude-turns').fill('1001'); await p.locator('button:text-is("Save")').click(); await sleep(300); r.push('turns1001=' + await t(p, '.set-error'));
  await p.locator('.set-link:has-text("boat")').click(); await sleep(300);
  await p.locator('summary:has-text("Advanced")').click(); await p.locator('#boat-url').fill('https://staging.boat.dev/api'); await p.locator('#boat-key').fill('abcd1234');
  const req = p.waitForRequest((q) => q.url().includes('/boat/test')); await p.locator('button:text-is("Test")').click(); r.push('testBody=' + (await req).postData());
  await sleep(900);
  await p.locator('.set-link:has-text("MCP")').click(); await sleep(250);
  await p.locator('.mcp-list li').first().locator('button:has-text("Edit")').click(); await sleep(200);
  const patch = p.waitForRequest((q) => q.method() === 'PATCH' && q.url().endsWith('/api/settings'));
  await p.locator('.mcp-form button:has-text("Save server")').click(); r.push('mcpPatch=' + (await patch).postData().slice(0, 220));
  return r.join(' || ');
});
await scene('f-hidden', 'bridge', async (p) => { await p.locator('.tab[role=tab]').first().click(); await sleep(400); return 'ToolSearchChips=' + await p.locator('.chip:has-text("ToolSearch")').count(); });
console.log(log.join('\n')); await b.close();
