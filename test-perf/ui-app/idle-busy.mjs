// Main-thread busy % (CDP TaskDuration) for the shell in several situations.   node idle-busy.mjs <base|new> [seconds]
import { startEnv, openPage, busyPct } from './env.mjs';
const which = process.argv[2] || 'new'; const secs = Number(process.argv[3] || 8) * 1000;
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48300 });
const { browser, page, cdp, errs } = await openPage(env);
const out = {};
out['chat, ops open, idle'] = await busyPct(page, cdp, secs);
await page.keyboard.press('Control+.'); await page.waitForTimeout(800);
out['chat, ops CLOSED'] = await busyPct(page, cdp, secs);
await page.keyboard.press('Control+.'); await page.waitForTimeout(800);
await page.click('.tb-view[title^="Library"]'); await page.waitForSelector('.lib'); await page.waitForTimeout(2500);
out['lattice, ops open, idle'] = await busyPct(page, cdp, secs);
await page.click('.tb-view[title^="Chat"]').catch(() => {});
await page.keyboard.press('Control+Shift+M'); await page.waitForSelector('.lab');
for (const st of ['thinking', 'hacking', 'sleeping']) {
  await page.click(`.lab-grid button:text-is("${st}")`); await page.waitForTimeout(2500);
  out[`chat, lab ${st}`] = await busyPct(page, cdp, secs);
}
console.log(JSON.stringify(out, null, 1), errs);
await browser.close(); await env.stop(); process.exit(0);
