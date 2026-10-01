// Which Relic layers' SMIL costs the main thread while the stage plays (lab "thinking")? Pauses one layer group at a time.   node smil-layers.mjs
import { startEnv, openPage, busyPct } from './env.mjs';
const env = await startEnv({ ui: '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 49400 });
const { browser, page, cdp } = await openPage(env);
await page.keyboard.press('Control+Shift+M'); await page.waitForSelector('.lab');
await page.click('.lab-grid button:text-is("thinking")'); await page.waitForTimeout(2500);
const set = (keep) => page.evaluate((keep) => { document.querySelectorAll('.ops-slot .mx-layer').forEach((l) => { const id = [...l.classList].find((c) => /^mx-L-/.test(c)).slice(3); const svg = l.querySelector('svg'); (keep(id) ? svg.unpauseAnimations() : svg.pauseAnimations()); }); }, keep);
const groups = { 'all playing': () => true, 'none (idle look)': () => false, 'only halo-back+front': (id) => id.startsWith('L-halo'), 'only aura': (id) => id === 'L-aura', 'only plume': (id) => id === 'L-plume', 'only hangs (dash flow)': (id) => id.startsWith('L-hang'), 'only tokens': (id) => id.startsWith('L-token') };
for (const [n, f] of Object.entries(groups)) { await page.evaluate((src) => { window.__k = new Function('id', 'return (' + src + ')(id)'); }, f.toString()); await page.evaluate((src) => { const k = new Function('return ' + src)(); document.querySelectorAll('.ops-slot .mx-layer').forEach((l) => { const id = [...l.classList].find((c) => /^mx-L-/.test(c)).slice(3); const svg = l.querySelector('svg'); k(id) ? svg.unpauseAnimations() : svg.pauseAnimations(); }); }, f.toString()); await page.waitForTimeout(800); console.log(n.padEnd(26), JSON.stringify(await busyPct(page, cdp, 4000))); }
await browser.close(); await env.stop(); process.exit(0);
