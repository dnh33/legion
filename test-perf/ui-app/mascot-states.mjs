// Screenshot every Relic stage state (dark + light) at shipped size, plus the SMIL play state per state.
//   node mascot-states.mjs <base|new> <outDir>
// Frames are normalised so two builds can be compared pixel for pixel: all CSS animations are seeked to a fixed time,
// SMIL is seeked to t=0, random blinks / look-arounds / tricks are cleared. The "playing" PNGs (not normalised) are for the eye.
import fs from 'node:fs';
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new';
const out = process.argv[3] || `/tmp/m/u-shots/${which}`;
fs.mkdirSync(out, { recursive: true });
const STATES = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed'];
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48200 });
const report = {};
for (const scheme of ['dark', 'light']) {
  const { browser, page, errs } = await openPage(env, { scheme, init: () => { Math.random = () => 0.999; } });
  await page.keyboard.press('Control+Shift+M'); // Mascot Lab
  await page.waitForSelector('.lab');
  for (const st of STATES) {
    await page.click(`.lab-grid button:text-is("${st}")`);
    await page.waitForTimeout(2400);
    const probe = () => page.evaluate(() => {
      const svgs = [...document.querySelectorAll('.mascot-stage .mx-layer > svg')];
      return { state: document.querySelector('.mascot-stage .mx')?.dataset.state, smilPaused: svgs.every((s) => s.animationsPaused()), smilSomePaused: svgs.some((s) => s.animationsPaused()), n: svgs.length };
    });
    const info = await probe();
    const stage = page.locator('.mascot-stage .relic-wrap');
    await stage.screenshot({ path: `${out}/${scheme}-${st}-playing.png` });
    // normalise
    await page.evaluate(() => {
      document.querySelectorAll('.mascot-stage .mx svg').forEach((s) => { s.pauseAnimations?.(); s.setCurrentTime?.(0); });
      document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = 1000; } catch {} });
      const mx = document.querySelector('.mascot-stage .mx');
      mx.classList.remove('blink'); [...mx.classList].filter((c) => c.startsWith('trick-') || c === 'bonk').forEach((c) => mx.classList.remove(c));
      mx.style.setProperty('--lx', '0px'); mx.style.setProperty('--ly', '0px');
    });
    await page.waitForTimeout(250);
    await stage.screenshot({ path: `${out}/${scheme}-${st}-frozen.png` });
    (report[scheme] ||= {})[st] = info;
    // leave the page in a playable state for the next state: reload is cheapest to undo the freeze
    await page.reload(); await page.waitForSelector('.titlebar'); await page.waitForTimeout(800);
    await page.keyboard.press('Control+Shift+M'); await page.waitForSelector('.lab');
  }
  if (errs.length) report[scheme].errs = errs;
  await browser.close();
}
fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
await env.stop(); process.exit(0);
