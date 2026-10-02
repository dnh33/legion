// Screenshots of the queue in dark/light and at the minimum window size (960x600 with the Ops panel open: the centre column is ~460px).
//   node test-perf/chat-ui/shots.mjs [ui-dir]    -> test-perf/chat-ui/shots/*.png (git-ignored)
import { startFake } from './harness.mjs';
import { openPage, sleep, until, composer, typeEnter, queueCount } from './lib.mjs';
const ui = process.argv[2] || '/tmp/m/wt-chat/dist-ui';
const env = await startFake({ ui, repo: '/tmp/m/wt-chat', port: 48700 });
const dir = '/tmp/m/wt-chat/test-perf/chat-ui/shots';
for (const [name, opts] of [['light', { scheme: 'light', width: 1280, height: 860 }], ['narrow-dark', { scheme: 'dark', width: 960, height: 600 }], ['narrow-light', { scheme: 'light', width: 960, height: 600 }]]) {
  const init = opts.scheme === 'light' ? () => localStorage.setItem('legion.theme', 'light') : undefined;
  const { browser, page, errs } = await openPage(env, { ...opts, init });
  await page.click('.tab.new').catch(() => {});
  await composer(page).click();
  await typeEnter(page, '[slow:6000] working on the big refactor');
  await until(() => page.locator('.composer .send.stop').count(), 5000, 'busy');
  await typeEnter(page, 'then run the full test suite and report back');
  await typeEnter(page, 'a much longer follow up message that has to be clipped because it does not fit on a single line of the queue list in a narrow window ' + 'x'.repeat(200));
  await typeEnter(page, '/opus summarize the changes');
  await until(async () => (await queueCount(page)) === 3, 3000, '3 queued');
  await composer(page).fill('typing the next one');
  await page.screenshot({ path: `${dir}/queue-busy-${name}.png` });
  await page.locator('.composer .send.stop').click();
  await until(() => page.locator('[data-testid="queue-hold"]').count(), 4000, 'paused');
  await page.screenshot({ path: `${dir}/queue-paused-${name}.png` });
  await page.locator('.q-text').first().click();
  await page.screenshot({ path: `${dir}/queue-edit-${name}.png` });
  console.log(name, errs.length ? errs : 'ok');
  await browser.close();
  await sleep(300);
}
await env.stop();
