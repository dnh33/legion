// Visual check: node ui/dev/mock-server.mjs & node ui/dev/shoot.mjs  (mock server on :47811, Playwright installed or $PLAYWRIGHT_PATH)
// Writes to ui/dev/shots/ (git-ignored).
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';
import { mkdirSync } from 'node:fs';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(out, { recursive: true });
const B = 'http://127.0.0.1:47811';
const emit = (e) => fetch(B + '/__emit', { method: 'POST', body: JSON.stringify(e) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) console.log('console.error:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`${B}/index.html?base=${B}&token=x`);
await page.waitForSelector('.thread-inner'); await sleep(700);
const shot = (n, sel) => (sel ? page.locator(sel).screenshot({ path: `${out}/${n}.png` }) : page.screenshot({ path: `${out}/${n}.png` }));

await shot('01-dark-thread');
await page.keyboard.press('Control+Shift+M'); await sleep(200);
const lab = (name) => page.locator('.lab button', { hasText: new RegExp('^' + name + '$') }).click();
const states = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed'];
const delay = { victory: 900, error: 300, annoyed: 200, sleeping: 900 };
await page.mouse.move(300, 500);
for (const st of states) { await lab(st); await sleep(delay[st] ?? 650); await shot('relic-' + st, '.relic-holder'); if (st === 'hacking') { await sleep(300); await shot('relic-hacking-b', '.relic-holder'); } }
await lab('idle'); await page.locator('.lab button', { hasText: 'VM running overlay' }).click(); await sleep(500); await shot('relic-vm', '.relic-holder');
await page.locator('.lab button', { hasText: 'VM running overlay' }).click();
// motion check: 6 frames 150ms apart, idle and hacking
for (const st of ['idle', 'hacking']) {
  await lab(st); await sleep(700);
  for (let i = 0; i < 6; i++) { await shot(`motion-${st}-${i}`, '.relic-holder'); await sleep(150); }
}
await lab('auto');
// hover / pointer tracking
await page.locator('.relic-hit').hover(); await page.mouse.move(1000, 140); await sleep(300); await shot('relic-hover', '.relic-holder');
await page.mouse.move(10, 700);
await page.keyboard.press('Control+Shift+M');
// click quip
await page.locator('.relic-hit').click(); await sleep(250); await shot('relic-quip', '.mascot-stage');
await page.mouse.move(300, 500);

// app shots
await page.keyboard.press('Alt+2'); await sleep(400);
await fetch(B + '/__approval', { method: 'POST', body: '{}' });
await emit({ type: 'mascot', mood: 'hacking', note: 'npm create vite' });
await emit({ type: 'message.delta', taskId: 't3', text: 'Scaffolding the project now. First I will pull in **Vite** and `react-ts`' });
await sleep(800);
await shot('02-dark-awaiting');
await page.keyboard.press('Control+k'); await sleep(250); await shot('03-palette'); await page.keyboard.press('Escape');
await page.locator('.tb-doctor').click(); await sleep(400); await shot('04-doctor'); await page.keyboard.press('Escape');
await page.locator('.icon-btn[aria-label="Toggle theme"]').click(); await sleep(300);
await shot('08-light-awaiting');
await page.keyboard.press('Alt+1'); await sleep(400); await shot('07-light-thread');
await browser.close();
