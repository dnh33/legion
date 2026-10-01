// Eye-follow still works and is scoped: --ex/--ey on the eyes group, --lean on the rig, nothing set on the .mx root.   node check-pointer.mjs <new>
import assert from 'node:assert/strict';
import { startEnv, openPage } from './env.mjs';
const env = await startEnv({ ui: '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48700 });
const { browser, page, errs } = await openPage(env);
const read = () => page.evaluate(() => {
  const mx = document.querySelector('.ops-slot .mx'); const eyes = mx.querySelector('[id$="L-eyes"]'); const rig = mx.querySelector('.mx-rig');
  return { root: [mx.style.getPropertyValue('--ex'), mx.style.getPropertyValue('--ey'), mx.style.getPropertyValue('--lean')], eyes: [eyes.style.getPropertyValue('--ex'), eyes.style.getPropertyValue('--ey')], rig: rig.style.getPropertyValue('--lean') };
});
await page.mouse.move(1400, 100); await page.waitForTimeout(300);
const r = await read(); console.log(JSON.stringify(r));
assert.deepEqual(r.root, ['', '', ''], 'nothing on the root');
assert.ok(parseFloat(r.eyes[0]) > 1, 'eyes look right/up when the pointer is up and to the right');
assert.ok(parseFloat(r.eyes[1]) < 0);
await page.mouse.move(20, 880); await page.waitForTimeout(300);
const l = await read(); console.log(JSON.stringify(l));
assert.ok(parseFloat(l.eyes[0]) < -3 && parseFloat(l.eyes[1]) > 0, 'eyes follow to the bottom left');
// hover lean: pointer over the stage mascot leans the rig
const box = await page.locator('.ops-slot .mx').boundingBox();
await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5); await page.waitForTimeout(300);
await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.5); await page.waitForTimeout(300);
const h = await read(); console.log(JSON.stringify(h));
assert.ok(parseFloat(h.rig) > 0.5, 'hover lean is set on the rig');
// the rect cache follows the panel: close + reopen Ops, eyes still track relative to the new position
await page.keyboard.press('Control+.'); await page.waitForTimeout(500); await page.keyboard.press('Control+.'); await page.waitForTimeout(900);
await page.mouse.move(5, 5); await page.waitForTimeout(300);
const c = await read(); assert.ok(parseFloat(c.eyes[0]) < -3, 'still tracking after the panel was remounted');
console.log('ok', errs);
await browser.close(); await env.stop(); process.exit(0);
