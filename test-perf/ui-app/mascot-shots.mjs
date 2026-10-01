// Kodawari gate for the mascot round: screenshot the Relic stage in all 9 states, dark and light, at shipped size, before (base build,
// ring present, native SMIL) and after (new build, ring hidden, scripted motion clock). Frames are normalised so the two builds can be
// compared pixel for pixel: random blinks/look-arounds off, every CSS animation seeked to 1000 ms, SMIL (base) / motion clock (new) at
// the same time T. A third frame, "base without ring", is the base with the ring group deleted by the harness: new vs that one must be
// identical apart from sub-pixel glyph antialiasing, base vs that one differs only along the ring.
//   node mascot-shots.mjs <baseUi> <newUi> <outDir> [T=3.5]
import fs from 'node:fs';
import { startEnv, openPage } from './env.mjs';
const [baseUi, newUi, out, Targ] = process.argv.slice(2);
const T = Number(Targ || 3.5);
fs.mkdirSync(out, { recursive: true });
const repo = process.env.LEGION_REPO || '/tmp/m/wt-m';
const STATES = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed'];
const RING = 'circle[stroke-width="2.2"][stroke-dasharray^="242.8"]';
const envs = { base: await startEnv({ ui: baseUi, repo, port: 49530, home: '/tmp/m/m-home-49530' }), new: await startEnv({ ui: newUi, repo, port: 49540, home: '/tmp/m/m-home-49540' }) };
const geo = {};
for (const scheme of ['dark', 'light']) {
  for (const which of ['base', 'new']) {
    const { browser, page, errs } = await openPage(envs[which], { scheme, init: () => { Math.random = () => 0.999; } });
    for (const st of STATES) {
      await page.keyboard.press('Control+Shift+M'); await page.waitForSelector('.lab');
      await page.click(`.lab-grid button:text-is("${st}")`);
      await page.waitForTimeout(2400);
      const stage = page.locator('.mascot-stage .relic-wrap');
      const freeze = (t) => page.evaluate((t) => {
        const mx = document.querySelector('.mascot-stage .mx');
        mx.classList.remove('blink'); [...mx.classList].filter((c) => c.startsWith('trick-') || c === 'bonk').forEach((c) => mx.classList.remove(c));
        mx.style.setProperty('--lx', '0px'); mx.style.setProperty('--ly', '0px');
        if (mx.__mx) mx.__mx.motionAt(t); else document.querySelectorAll('.mascot-stage .mx svg').forEach((s) => { s.pauseAnimations?.(); s.setCurrentTime?.(t); });
        document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = 1000; } catch {} });
      }, t);
      await stage.screenshot({ path: `${out}/${scheme}-${st}-${which}-playing.png` });
      await freeze(T); await page.waitForTimeout(300);
      await stage.screenshot({ path: `${out}/${scheme}-${st}-${which}.png` });
      if (which === 'base') {
        // where the ring is, in stage-screenshot pixels (for the annulus check) and the same frame with the ring group removed
        const g = await page.evaluate((RING) => {
          const c = document.querySelector('.mascot-stage .mx-L-aura svg ' + RING); const r = c.getBoundingClientRect(); const s = document.querySelector('.mascot-stage .relic-wrap').getBoundingClientRect();
          return { cx: r.left + r.width / 2 - s.left, cy: r.top + r.height / 2 - s.top, r: r.width / 2 - 1.1 * r.width / 336 };
        }, RING);
        geo[`${scheme}-${st}`] = g;
        await page.evaluate((RING) => { document.querySelector('.mascot-stage .mx-L-aura svg ' + RING).parentElement.remove(); }, RING);
        await page.waitForTimeout(200);
        await stage.screenshot({ path: `${out}/${scheme}-${st}-basenoring.png` });
      }
      await page.reload(); await page.waitForSelector('.titlebar'); await page.waitForTimeout(700);
    }
    if (errs.length) console.log('page errors', which, scheme, errs);
    await browser.close();
  }
}
fs.writeFileSync(`${out}/ring-geometry.json`, JSON.stringify(geo, null, 1));
for (const e of Object.values(envs)) await e.stop();
console.log('shots done', out);
process.exit(0);
