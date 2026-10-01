// Regenerates the README images in docs/images/ from the built UI and the dev mock server.
//
//   npm run build:ui
//   node ui/dev/docs-shots.mjs
//
// Needs Playwright (not a Legion dependency): see "Regenerating icons and screenshots" in CONTRIBUTING.md.
// Set CHROMIUM_PATH to use an existing Chromium binary. The mock server ships fake data only: no tokens,
// accounts or personal information.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, 'docs', 'images');
mkdirSync(out, { recursive: true });

const PORT = Number(process.env.SHOTS_PORT || 47813);
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = spawn(process.execPath, [join(here, 'mock-server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.stdout.on('data', (d) => { if (String(d).includes('mock legion core')) resolve(); });
  setTimeout(() => reject(new Error('mock server did not start')), 8000);
});

const browser = await launchChromium();
try {
  // 1. Hero: the Relic, transparent background, 600px wide.
  {
    const svg = readFileSync(join(root, 'docs', 'art', 'relic.svg'), 'utf8')
      .replace(/<svg([^>]*?)\swidth="\d+"\s+height="\d+"/, '<svg$1 width="600" height="800"');
    const ctx = await browser.newContext({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    await page.screenshot({ path: join(out, 'relic.png'), omitBackground: true, clip: { x: 0, y: 0, width: 600, height: 800 } });
    await ctx.close();
  }

  // 2. App screenshots, 1440x900 viewport at 2x.
  async function open(theme, scenario) {
    const token = `${scenario}.${theme}${Date.now()}`;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('legion.theme', t); localStorage.setItem('legion.ops', '1'); } catch { /* ignore */ } }, theme);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('pageerror:', e.message));
    await page.goto(`${B}/index.html?base=${B}&token=${token}`);
    await page.waitForSelector('.thread-inner');
    await sleep(900);
    const call = (path, body) => fetch(B + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { ctx, page, call };
  }

  for (const theme of ['dark', 'light']) {
    const { ctx, page, call } = await open(theme, 'doctor-pass.vm-running');
    await page.keyboard.press('Alt+2'); // Builder, mid-task
    await sleep(500);
    await call('/__approval', { taskId: 't3', agentId: 'builder', summary: 'npm install && npm run build' });
    await call('/__emit', { type: 'message.delta', taskId: 't3', text: 'Both sections are in place. Installing dependencies and running the build to check them.' });
    await sleep(1400);
    await page.mouse.move(700, 600);
    await page.screenshot({ path: join(out, `app-${theme}.png`) });
    await ctx.close();
  }

  // 3. Slash menu and model picker (dark), cropped around the composer.
  {
    const { ctx, page } = await open('dark', 'doctor-pass.vm-running');
    await page.getByRole('button', { name: /new task/i }).first().click();
    await sleep(300);
    const box = page.locator('.composer-wrap');
    await page.locator('textarea[aria-label="Message"]').click();
    await page.keyboard.type('/', { delay: 40 });
    await page.waitForSelector('.slash-menu');
    await sleep(700);
    const pad = 16;
    const crop = async (file, popover) => {
      const a = await page.locator(popover).boundingBox();
      const c = await box.boundingBox();
      const x = Math.max(0, Math.min(a.x, c.x) - pad);
      const y = Math.max(0, a.y - 4);
      const x2 = Math.max(a.x + a.width, c.x + c.width) + pad;
      const y2 = c.y + c.height + pad;
      await page.screenshot({ path: join(out, file), clip: { x, y, width: x2 - x, height: y2 - y } });
    };
    await crop('slash-menu.png', '.slash-menu');
    await page.keyboard.press('Escape');
    await page.locator('textarea[aria-label="Message"]').fill('');
    await page.keyboard.press('Control+m');
    await page.waitForSelector('.model-pop');
    await sleep(600);
    await crop('model-picker.png', '.model-pop');
    await ctx.close();
  }
  console.log('wrote images to', out);
} finally {
  await browser.close();
  mock.kill();
}
