// Queue proof against a real core with a scripted SDK.   node test-perf/chat-ui/queue.mjs [ui-dir]
import { startFake } from './harness.mjs';
import { openPage, runner, assert, until, sleep, composer, typeEnter, queueCount, userBubbles } from './lib.mjs';

const ui = process.argv[2] || '/tmp/m/wt-chat/dist-ui';
const env = await startFake({ ui, repo: '/tmp/m/wt-chat', port: 48600 });
const { browser, page, errs } = await openPage(env);
const { check, report } = runner();
const shot = (n) => page.screenshot({ path: `/tmp/m/wt-chat/test-perf/chat-ui/shots/${n}.png` });
const prompts = () => env.prompts();
const idle = () => until(async () => (await page.locator('.composer .send.stop').count()) === 0 && !(await page.locator('.working').count()), 15000, 'agent idle');
const lastCallIdx = () => prompts().length;

try {
  await check('idle agent: Enter sends at once (no queue)', async () => {
    await typeEnter(page, 'hello idle');
    await until(() => prompts().includes('hello idle'), 5000, 'first call');
    await idle();
    assert.equal(await queueCount(page), 0);
    assert.ok((await userBubbles(page)).includes('hello idle'));
  });

  await check('busy: three messages queue in order, show list, count, hint, and state', async () => {
    await typeEnter(page, '[slow:3000] first');
    await until(() => page.locator('.composer .send.stop').count(), 5000, 'busy');
    for (const t of ['second', 'third', 'fourth']) await typeEnter(page, t);
    await until(async () => (await queueCount(page)) === 3, 3000, '3 queued');
    const labels = await page.locator('[data-testid="queue-item"] .q-text').allInnerTexts();
    assert.deepEqual(labels, ['second', 'third', 'fourth']);
    assert.equal(await page.locator('[data-testid="queue-count"]').innerText(), '3');
    const hint = await page.locator('.q-hint').innerText();
    assert.match(hint, /Enter queues, Ctrl\+Enter interrupts/);
    assert.match(await page.locator('[data-testid="queue-state"]').innerText(), /Waiting for the current run/);
    assert.equal(await composer(page).inputValue(), '', 'input cleared after queueing');
    assert.match(await page.locator('[data-testid="composer-hint"]').innerText(), /Enter queues/);
    await shot('queue-3-dark');
  });

  await check('run ends: queued messages go out automatically, in order, one per run', async () => {
    const at = prompts().indexOf('[slow:3000] first');
    await until(() => prompts().length >= at + 4, 20000, 'three auto-sends');
    await idle();
    assert.deepEqual(prompts().slice(at, at + 4), ['[slow:3000] first', 'second', 'third', 'fourth']);
    assert.equal(await queueCount(page), 0);
    const b = await userBubbles(page);
    assert.deepEqual(b.slice(-4), ['[slow:3000] first', 'second', 'third', 'fourth']);
  });
} finally {
  console.log('page errors:', errs);
  const failed = report();
  await browser.close(); await env.stop();
  process.exit(failed ? 1 : 0);
}
