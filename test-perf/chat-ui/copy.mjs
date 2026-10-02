// Copy menu proof: real clipboard, hover/focus/touch visibility, both variants, tool chips excluded, fallback path.   node copy.mjs [ui-dir]
import { startFake, MD_REPLY } from './harness.mjs';
import { openPage, runner, assert, until, sleep, typeEnter } from './lib.mjs';

const ui = process.argv[2] || '/tmp/m/wt-chat/dist-ui';
const env = await startFake({ ui, repo: '/tmp/m/wt-chat', port: 48640 });
const { browser, page, errs } = await openPage(env);
const { check, report } = runner();
const shot = (p, n, o = {}) => p.screenshot({ path: `/tmp/m/wt-chat/test-perf/chat-ui/shots/${n}.png`, ...o });
const clip = (p) => p.evaluate(() => navigator.clipboard.readText());
const asst = (p) => p.locator('.thread .msg.assistant').last();
const opacity = (loc) => loc.evaluate((e) => getComputedStyle(e).opacity);
const PLAIN = [
  'Plan', '', 'Here is the plan with inline code and a docs link (https://example.com/docs).', '',
  '- first item', '- second item with emphasis', '', '1. step one', '2. step two', '', 'const x = 1;', 'console.log(x);', '', 'Done.',
].join('\n');

try {
  await check('a finished reply shows the copy menu on hover; it is hidden otherwise', async () => {
    await typeEnter(page, '[md] give me a plan');
    await until(async () => (await page.locator('.thread .msg.assistant .msg-actions').count()) === 1, 8000, 'menu rendered');
    const bar = asst(page).locator('.msg-actions');
    await page.mouse.move(5, 5);
    assert.equal(await opacity(bar), '0', 'hidden when not hovered');
    await asst(page).hover();
    assert.equal(await opacity(bar), '1', 'visible on hover');
    assert.equal(await bar.getByRole('button').count(), 2);
    const names = await bar.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    assert.deepEqual(names, ['Copy as Markdown', 'Copy as plain text']);
  });

  await check('Copy as Markdown puts the original source on the clipboard (exact), with a "Copied" note and no motion', async () => {
    await asst(page).hover();
    await asst(page).getByRole('button', { name: 'Copy as Markdown' }).click();
    assert.equal(await clip(page), MD_REPLY);
    const note = asst(page).locator('.ma-note');
    assert.equal(await note.innerText(), 'Copied Markdown');
    const motion = await asst(page).locator('.msg-actions').evaluate((e) => { const c = getComputedStyle(e); return [c.transitionDuration, c.animationName]; });
    assert.deepEqual(motion, ['0s', 'none'], 'no transition or animation on the menu');
    await shot(page, 'copy-menu-dark', { clip: { x: 240, y: 130, width: 720, height: 560 } });
    await until(async () => (await note.innerText()) === '', 4000, 'note clears');
  });

  await check('Copy as plain text: rendered text, no syntax, code as plain lines, list structure kept', async () => {
    await asst(page).hover();
    await asst(page).getByRole('button', { name: 'Copy as plain text' }).click();
    assert.equal(await clip(page), PLAIN);
    assert.equal(await asst(page).locator('.ma-note').innerText(), 'Copied text');
  });

  await check('keyboard: Tab reaches the buttons (menu becomes visible), Enter copies, focus stays on the button', async () => {
    await page.mouse.move(5, 5);
    const bar = asst(page).locator('.msg-actions');
    await asst(page).getByRole('button', { name: 'Copy as Markdown' }).focus();
    assert.equal(await opacity(bar), '1', 'visible while focused');
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await page.keyboard.press('Enter');
    await until(async () => (await clip(page)) === MD_REPLY, 3000, 'copied by keyboard');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Copy as Markdown');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Copy as plain text');
  });

  await check('tool chips and tool output are not in the copied text, only the message\'s own text', async () => {
    await typeEnter(page, '[tool] use a tool');
    await until(async () => (await page.locator('.thread .msg.assistant', { hasText: 'Used a tool.' }).count()) === 1, 8000, 'tool reply');
    const m = page.locator('.thread .msg.assistant', { hasText: 'Used a tool.' });
    await m.hover(); await m.getByRole('button', { name: 'Copy as Markdown' }).click();
    assert.equal(await clip(page), 'Used a tool.');
    await m.getByRole('button', { name: 'Copy as plain text' }).click();
    assert.equal(await clip(page), 'Used a tool.');
  });

  await check('a streaming reply has no copy menu until it is complete', async () => {
    await typeEnter(page, '[slow:2500] stream');
    await until(() => page.locator('.thread .caret').count(), 5000, 'streaming bubble');
    const live = page.locator('.thread .msg.assistant', { has: page.locator('.caret') });
    assert.equal(await live.locator('.msg-actions').count(), 0, 'no menu while streaming');
    await until(async () => (await page.locator('.thread .caret').count()) === 0, 8000, 'finished');
    await until(async () => (await page.locator('.thread .msg.assistant', { hasText: 'slow done' }).locator('.msg-actions').count()) === 1, 3000, 'menu after completion');
  });

  await check('using the menu does not touch the message list (no DOM mutations in any reply body)', async () => {
    await page.evaluate(() => { window.__muts = 0; new MutationObserver((l) => { window.__muts += l.length; }).observe(document.querySelector('.thread-inner'), { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['class', 'style'] }); });
    const m = page.locator('.thread .msg.assistant', { hasText: 'Plan' }).first();
    await m.hover(); await m.getByRole('button', { name: 'Copy as plain text' }).click();
    const bodyMuts = await page.evaluate(() => window.__muts);
    // only the toolbar's own note (+ its class) may change: a handful of mutations, none in .md bodies
    const mdMuts = await page.evaluate(() => { let n = 0; const rec = new MutationObserver((l) => { n += l.filter((x) => x.target.closest?.('.md') || x.target.parentElement?.closest?.('.md')).length; }); rec.observe(document.querySelector('.thread-inner'), { subtree: true, childList: true, attributes: true, characterData: true }); return new Promise((r) => setTimeout(() => { r(n); }, 300)); });
    assert.equal(mdMuts, 0, 'reply bodies stable');
    assert.ok(bodyMuts < 12, 'few mutations: ' + bodyMuts);
  });

  await check('clipboard API refused: the hidden-textarea fallback still copies and keeps focus on the button', async () => {
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx2.addInitScript(({ base, token, admin }) => {
      window.legion = { baseUrl: base, token, admin, platform: 'win32', openExternal() {} };
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      window.__api = { calls: 0 };
      navigator.clipboard.writeText = () => { window.__api.calls++; return Promise.reject(new Error('denied')); };
      window.__origWrite = orig;
    }, { base: env.base, token: env.token, admin: env.admin });
    const p2 = await ctx2.newPage(); await p2.goto(env.uiUrl); await p2.waitForSelector('textarea[aria-label="Message"]');
    await until(async () => (await p2.locator('.tab', { hasText: 'give me a plan' }).count()) > 0, 5000, 'task tab');
    await p2.locator('.tab', { hasText: 'give me a plan' }).click();
    const m = p2.locator('.thread .msg.assistant', { hasText: 'Plan' }).first();
    await m.waitFor();
    const btn = m.getByRole('button', { name: 'Copy as plain text' });
    await m.hover(); await btn.focus(); await btn.click();
    await until(async () => (await m.locator('.ma-note').innerText()) === 'Copied text', 3000, 'copied via fallback');
    assert.equal(await p2.evaluate(() => window.__api.calls), 1, 'the API was tried first');
    assert.equal(await p2.evaluate(() => window.__origWrite && navigator.clipboard.readText()), PLAIN);
    assert.equal(await p2.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Copy as plain text', 'focus returned to the button');
    await ctx2.close();
  });

  await check('touch device: the menu is always visible (no hover needed)', async () => {
    const ctx3 = await browser.newContext({ viewport: { width: 1000, height: 700 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'], colorScheme: 'dark' });
    await ctx3.addInitScript(({ base, token, admin }) => { window.legion = { baseUrl: base, token, admin, platform: 'win32', openExternal() {} }; }, { base: env.base, token: env.token, admin: env.admin });
    const p3 = await ctx3.newPage(); await p3.goto(env.uiUrl); await p3.waitForSelector('textarea[aria-label="Message"]');
    // the newest task opens by itself (the narrow layout has no tab strip to click)
    const m = p3.locator('.thread .msg.assistant', { hasText: 'slow done' }).first(); await m.waitFor();
    assert.equal(await opacity(m.locator('.msg-actions')), '1');
    await m.locator('.msg-actions').scrollIntoViewIfNeeded();
    await shot(p3, 'copy-menu-touch-dark');
    await ctx3.close();
  });

  await check('light theme and narrow window screenshots', async () => {
    const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx4.addInitScript(({ base, token, admin }) => { window.legion = { baseUrl: base, token, admin, platform: 'win32', openExternal() {} }; localStorage.setItem('legion.theme', 'light'); }, { base: env.base, token: env.token, admin: env.admin });
    const p4 = await ctx4.newPage(); await p4.goto(env.uiUrl); await p4.waitForSelector('textarea[aria-label="Message"]');
    await p4.locator('.tab', { hasText: 'give me a plan' }).click();
    const m = p4.locator('.thread .msg.assistant', { hasText: 'Plan' }).first(); await m.waitFor();
    await m.hover(); await m.getByRole('button', { name: 'Copy as Markdown' }).click();
    await shot(p4, 'copy-menu-light', { clip: { x: 240, y: 130, width: 720, height: 560 } });
    await p4.setViewportSize({ width: 960, height: 620 }); await p4.waitForTimeout(300);
    await m.hover(); await shot(p4, 'copy-menu-narrow-light');
    await ctx4.close();
  });

  await check('no page errors', async () => { assert.deepEqual(errs, []); });
} finally {
  console.log('page errors:', errs);
  const failed = report();
  await browser.close(); await env.stop();
  process.exit(failed ? 1 : 0);
}
