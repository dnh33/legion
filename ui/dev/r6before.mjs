// "Before" frames for round 6: the same UI with the round-6 styling switched off (CSS injection), so the comparison is like for like.
const { chromium } = await import(process.env.PW || '/tmp/claude-0/pw/node_modules/playwright/index.mjs');
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots/r6/before');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const old = '.check.ok .check-ic{background:var(--surface-3)!important;color:var(--muted)!important}.tb-doctor.good .icon{animation:none!important;color:inherit!important}.tab-x,.from-chip{display:none!important}.tb-doctor.good{color:var(--muted)}';
for (const [th, w, h] of [['dark', 1280, 820], ['light', 1280, 820], ['dark', 960, 600], ['light', 960, 600]]) {
  for (const [name, flags, act] of [['doctor', 'doctor-pass', async (p) => { await p.locator('.tb-doctor').click(); await p.waitForTimeout(700); }], ['tabs-recent', 'bridge', async (p) => { await p.waitForTimeout(400); }]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => { localStorage.setItem('legion.theme', t); localStorage.setItem('legion.onboarded', '1'); }, th);
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:47811/index.html?base=http://127.0.0.1:47811&token=${flags}.b${name}${th}${w}`); await p.waitForSelector('.app'); await p.waitForTimeout(900);
    await p.addStyleTag({ content: old + '.tb-word{display:contents!important}.tb-name{transform:translateY(1px)}' });
    await act(p); await p.screenshot({ path: `${out}/${name}-${th}-${w}x${h}.png` }); await ctx.close();
  }
}
await b.close();
