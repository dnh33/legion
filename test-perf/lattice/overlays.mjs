// Screenshots of the Lattice legend (open) and the offline banner in two builds, for a visual before/after of the backdrop-filter removal.
//   node test-perf/lattice/overlays.mjs --base <baseline tree> --new <tree> [--out dir]
// Each shot is a crop around the overlay; a numeric diff of the overlay's own box is printed (the graph under it moves between builds, so a few pixels differ by design).
import fs from 'node:fs'; import path from 'node:path'; import { arg, launch, sleep, startCore } from './lib.mjs';
const baseRoot = path.resolve(arg('base')), newRoot = path.resolve(arg('new', process.cwd())), outDir = arg('out', '/tmp/m/overlays');
fs.mkdirSync(outDir, { recursive: true });
for (const [tag, root] of [['base', baseRoot], ['new', newRoot]]) {
  const core = await startCore(root);
  const { browser, ctx } = await launch(root, core.cfg, { dpr: 1 });
  const page = await ctx.newPage(); await page.goto(core.cfg.ui + '/?latticeDiag'); await page.waitForSelector('.titlebar');
  await page.click('button.tb-view[aria-label^="Library"]'); await page.waitForSelector('canvas.lt-canvas');
  for (let i = 0; i < 300; i++) { const a = await page.evaluate(() => document.querySelector('canvas.lt-canvas')?.__lattice?.sim.alpha ?? 1); if (a <= 0.012) break; await sleep(100); }
  await sleep(800);
  const lg = page.locator('.lt-legend'); if (await lg.count()) { const head = lg.locator('.lt-legend-head'); if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click(); await sleep(300);
    const b = await lg.boundingBox(); const css = await lg.evaluate((el) => { const s = getComputedStyle(el); return { background: s.backgroundColor, backdropFilter: s.backdropFilter }; });
    console.log(tag, 'legend', JSON.stringify({ box: b, ...css })); await page.screenshot({ path: path.join(outDir, `${tag}-legend.png`), clip: { x: Math.max(0, b.x - 20), y: Math.max(0, b.y - 60), width: Math.min(1280, b.width + 40), height: b.height + 80 } }); } else console.log(tag, 'no legend');
  core.stop(); await sleep(2500);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  try { await page.click('button.tb-view[aria-label="Chat"]'); await sleep(300); await page.click('button.tb-view[aria-label^="Library"]'); } catch {}
  await sleep(2500);
  const off = page.locator('.lt-offline');
  if (await off.count()) { const b = await off.boundingBox(); const css = await off.evaluate((el) => { const s = getComputedStyle(el); return { background: s.backgroundImage + ' ' + s.backgroundColor, backdropFilter: s.backdropFilter }; });
    console.log(tag, 'offline', JSON.stringify({ box: b, ...css })); await page.screenshot({ path: path.join(outDir, `${tag}-offline.png`), clip: { x: Math.max(0, b.x - 20), y: Math.max(0, b.y - 20), width: Math.min(1260, b.width + 40), height: b.height + 160 } }); }
  else { console.log(tag, 'no offline banner'); await page.screenshot({ path: path.join(outDir, `${tag}-nooffline.png`) }); }
  await browser.close();
}
process.exit(0);
