// Queue proof against a real core with a scripted SDK.   node test-perf/chat-ui/queue.mjs [ui-dir]
import { startFake } from './harness.mjs';
import { openPage, runner, assert, until, sleep, composer, typeEnter, queueCount, userBubbles } from './lib.mjs';

const ui = process.argv[2] || '/tmp/m/wt-chat/dist-ui';
const env = await startFake({ ui, repo: '/tmp/m/wt-chat', port: 48600 });
const { browser, page, errs } = await openPage(env);
const { check, report } = runner();
const shot = (n) => page.screenshot({ path: `/tmp/m/wt-chat/test-perf/chat-ui/shots/${n}.png` });
const prompts = () => env.prompts();
const stopBtn = () => page.locator('.composer .send.stop');
const holdBanner = () => page.locator('[data-testid="queue-hold"]');
const idle = () => until(async () => (await stopBtn().count()) === 0 && !(await page.locator('.working').count()), 20000, 'agent idle');
const busy = () => until(() => stopBtn().count(), 6000, 'busy (Stop visible)');
const newThread = async () => { await page.click('.tab.new'); await composer(page).click(); };
const qlabels = () => page.locator('[data-testid="queue-item"] .q-text').allInnerTexts();
const queueN = async (n) => until(async () => (await queueCount(page)) === n, 4000, `${n} queued (have ${await queueCount(page)})`);
const after = (marker) => prompts().slice(prompts().indexOf(marker));
const q = async (...texts) => { for (const t of texts) await typeEnter(page, t); };

try {
  await check('idle agent: Enter sends at once (no queue)', async () => {
    await typeEnter(page, 'hello idle');
    await until(() => prompts().includes('hello idle'), 5000, 'first call');
    await idle();
    assert.equal(await queueCount(page), 0);
    await until(async () => (await userBubbles(page)).includes('hello idle'), 4000, 'bubble');
    assert.equal(await page.locator('.composer .send.queue').count(), 0, 'no Queue button while idle');
  });

  await check('busy: three messages queue in order, show list, count, hint, and state', async () => {
    await typeEnter(page, '[slow:3000] first');
    await busy();
    await q('second', 'third', 'fourth');
    await queueN(3);
    assert.deepEqual(await qlabels(), ['second', 'third', 'fourth']);
    assert.equal(await page.locator('[data-testid="queue-count"]').innerText(), '3');
    assert.match(await page.locator('.q-hint').innerText(), /Enter queues, Ctrl\+Enter interrupts/);
    assert.match(await page.locator('[data-testid="queue-state"]').innerText(), /Waiting for the current run/);
    assert.equal(await composer(page).inputValue(), '', 'input cleared after queueing');
    assert.match(await page.locator('[data-testid="composer-hint"]').innerText(), /Enter queues/);
    await shot('queue-3-dark');
  });

  await check('run ends: queued messages go out automatically, in order, one per run', async () => {
    await until(() => prompts().includes('fourth'), 25000, 'all auto-sent');
    await idle();
    assert.deepEqual(after('[slow:3000] first'), ['[slow:3000] first', 'second', 'third', 'fourth']);
    assert.equal(await queueCount(page), 0);
    assert.deepEqual((await userBubbles(page)).slice(-4), ['[slow:3000] first', 'second', 'third', 'fourth']);
  });

  await check('Ctrl+Enter interrupts the run, sends now, and the queue stays queued behind it', async () => {
    await newThread();
    await typeEnter(page, '[slow:9000] long run'); await busy();
    const t0 = Date.now();
    await q('after1', 'after2'); await queueN(2);
    await typeEnter(page, 'urgent now', 'Control+Enter');
    await until(() => prompts().includes('urgent now'), 5000, 'urgent sent');
    assert.ok(Date.now() - t0 < 6000, 'did not wait for the 9 s run');
    assert.equal(await holdBanner().count(), 0, 'our own cancel does not pause the queue: ' + (await holdBanner().allInnerTexts()).join('|'));
    await until(() => prompts().includes('after2'), 15000, 'queue continues');
    await idle();
    assert.deepEqual(after('[slow:9000] long run'), ['[slow:9000] long run', 'urgent now', 'after1', 'after2']);
    assert.equal(await queueCount(page), 0);
    const sys = await page.locator('.thread .msg.system').allInnerTexts();
    assert.ok(sys.includes('Cancelled'), 'the interrupted run says Cancelled: ' + JSON.stringify(sys));
    assert.deepEqual((await userBubbles(page)).slice(-3), ['urgent now', 'after1', 'after2']);
  });

  await check('Stop pauses the queue: banner with Resume/Clear, nothing is sent on its own, Resume goes on in order', async () => {
    await newThread();
    await typeEnter(page, '[slow:9000] run3'); await busy();
    await q('q1', 'q2'); await queueN(2);
    await stopBtn().click();
    await until(() => holdBanner().count(), 3000, 'pause banner');
    const txt = await holdBanner().innerText();
    assert.match(txt, /Queue paused/); assert.match(txt, /Resume/); assert.match(txt, /Clear/);
    await sleep(1800);
    assert.ok(!prompts().includes('q1'), 'q1 must not be sent after a stop');
    assert.equal(await queueCount(page), 2);
    assert.match(await page.locator('[data-testid="queue-state"]').innerText(), /Paused/);
    await shot('queue-paused-dark');
    await page.getByRole('button', { name: 'Resume' }).click();
    await until(() => prompts().includes('q2'), 8000, 'resumed');
    await idle();
    assert.deepEqual(after('q1'), ['q1', 'q2']);
    assert.equal(await queueCount(page), 0);
  });

  await check('Stop then Clear: the messages are dropped and never sent', async () => {
    await newThread();
    await typeEnter(page, '[slow:9000] run4'); await busy();
    await q('gone1', 'gone2'); await queueN(2);
    await stopBtn().click();
    await until(() => holdBanner().count(), 3000, 'pause banner');
    await page.getByRole('button', { name: 'Clear' }).click();
    await until(async () => (await queueCount(page)) === 0 && (await page.locator('[data-testid="queue-strip"]').count()) === 0, 3000, 'cleared');
    await sleep(1200);
    assert.ok(!prompts().includes('gone1') && !prompts().includes('gone2'));
  });

  await check('while paused and idle, a fresh Enter sends right away (the held queue is not touched)', async () => {
    await newThread();
    await typeEnter(page, '[slow:9000] run5'); await busy();
    await q('held1'); await queueN(1);
    await stopBtn().click(); await until(() => holdBanner().count(), 3000, 'pause');
    await idle();
    await typeEnter(page, 'fresh message');
    await until(() => prompts().includes('fresh message'), 4000, 'fresh sent');
    await idle(); await sleep(600);
    assert.ok(!prompts().includes('held1'));
    assert.equal(await queueCount(page), 1);
    await page.getByRole('button', { name: 'Clear' }).click();
  });

  await check('edit in place, remove, pull back with Up, and keyboard order', async () => {
    await newThread();
    await typeEnter(page, '[slow:9000] run6'); await busy();
    await q('alpha', 'beta', 'gamma'); await queueN(3);
    await page.locator('[data-testid="queue-item"] .q-text').nth(1).click();
    const ed = page.locator('.q-edit'); await ed.waitFor();
    assert.equal(await ed.inputValue(), 'beta');
    await ed.fill('beta edited'); await ed.press('Enter');
    await until(async () => (await qlabels())[1] === 'beta edited', 2000, 'edited label');
    // Escape cancels an edit
    await page.locator('[data-testid="queue-item"] .q-text').nth(0).click();
    await page.locator('.q-edit').fill('should not stick'); await page.locator('.q-edit').press('Escape');
    assert.deepEqual(await qlabels(), ['alpha', 'beta edited', 'gamma']);
    await page.getByRole('button', { name: 'Remove queued message 3' }).click();
    await queueN(2);
    // keyboard: Shift+Tab from the composer reaches the strip's last control
    await composer(page).click();
    await page.keyboard.press('Shift+Tab');
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || ''), /Remove queued message 2/);
    await composer(page).click();
    await page.keyboard.press('ArrowUp');
    assert.equal(await composer(page).inputValue(), 'beta edited');
    await queueN(1);
    assert.deepEqual(await qlabels(), ['alpha']);
    await composer(page).fill('');
    await stopBtn().click(); await until(() => holdBanner().count(), 3000, 'pause');
    await page.getByRole('button', { name: 'Clear' }).click();
  });

  await check('"Send now" on a queued message interrupts the run and sends that one first', async () => {
    await newThread();
    await typeEnter(page, '[slow:9000] run7'); await busy();
    await q('n1', 'n2', 'n3'); await queueN(3);
    await page.getByRole('button', { name: /Send queued message 2 now/ }).click();
    await until(() => prompts().includes('n3'), 12000, 'all sent');
    await idle();
    assert.deepEqual(after('[slow:9000] run7'), ['[slow:9000] run7', 'n2', 'n1', 'n3']);
  });

  await check('approval wait counts as running: the queue holds until the card is answered', async () => {
    await page.locator('.agent', { hasText: 'Careful' }).click();
    await newThread();
    await typeEnter(page, '[approval] needs ok'); 
    await until(() => page.locator('.approval').count(), 6000, 'approval card');
    await q('after approval'); await queueN(1);
    await sleep(1500);
    assert.ok(!prompts().includes('after approval'), 'held while the approval is pending');
    assert.match(await page.locator('[data-testid="queue-state"]').innerText(), /Waiting/);
    await page.getByRole('button', { name: /^Allow/ }).click();
    await until(() => prompts().includes('after approval'), 8000, 'sent after approval');
    await idle();
    assert.equal(await holdBanner().count(), 0);
  });

  await check('a failed run pauses the queue with the error shown', async () => {
    await page.locator('.agent', { hasText: 'Zealot' }).click();
    await newThread();
    await typeEnter(page, '[slow:2500][error] boom'); await busy();
    await q('after boom'); await queueN(1);
    await until(() => holdBanner().count(), 8000, 'error pause');
    assert.match(await holdBanner().innerText(), /Queue paused/);
    await sleep(1000);
    assert.ok(!prompts().includes('after boom'));
    await shot('queue-error-dark');
    await page.getByRole('button', { name: 'Resume' }).click();
    await until(() => prompts().includes('after boom'), 6000, 'resumed after error');
    await idle();
  });

  await check('agent busy from another source (a room task) queues even in the New task view, then sends and opens the task', async () => {
    await page.locator('.agent', { hasText: 'Scout' }).click();
    await newThread();
    env.engine.startTask({ agentId: 'scout', prompt: '[slow:3500] room work', source: 'bot' });
    await sleep(500);
    await typeEnter(page, 'hello scout');
    await queueN(1);
    assert.match(await page.locator('[data-testid="queue-state"]').innerText(), /busy with another task/);
    assert.ok(!prompts().includes('hello scout'));
    await until(() => prompts().includes('hello scout'), 12000, 'sent after the room task');
    await until(async () => (await userBubbles(page)).includes('hello scout'), 5000, 'thread shows it');
    await idle();
  });

  await check('a second agent keeps its own queue while another agent is selected', async () => {
    await page.locator('.agent', { hasText: 'Zealot' }).click(); await newThread();
    await typeEnter(page, '[slow:4000] z-run'); await busy();
    await q('z-queued'); await queueN(1);
    await page.locator('.agent', { hasText: 'Scout' }).click();
    await newThread();
    assert.equal(await queueCount(page), 0, 'Scout shows no queue');
    await page.locator('.agent', { hasText: 'Zealot' }).click();
    await until(async () => (await queueCount(page)) <= 1, 2000, 'zealot back');
    // the queue drains even while another agent is selected
    await page.locator('.agent', { hasText: 'Scout' }).click();
    await until(() => prompts().includes('z-queued'), 12000, 'z-queued sent while Scout selected');
    await page.locator('.agent', { hasText: 'Zealot' }).click();
    await idle();
  });

  await check('reload: the queue comes back HELD and nothing is sent until Resume', async () => {
    await page.locator('.agent', { hasText: 'Zealot' }).click(); await newThread();
    await typeEnter(page, '[slow:3000] run8'); await busy();
    await q('r1', 'r2'); await queueN(2);
    await page.reload(); await page.waitForSelector('textarea[aria-label="Message"]');
    await until(() => holdBanner().count(), 5000, 'restored banner');
    assert.match(await holdBanner().innerText(), /Restored after reload/);
    assert.deepEqual(await qlabels(), ['r1', 'r2']);
    await sleep(4500); // the 3 s run ends meanwhile
    assert.ok(!prompts().includes('r1'), 'no auto-send after a reload');
    await shot('queue-restored-dark');
    await page.getByRole('button', { name: 'Resume' }).click();
    await until(() => prompts().includes('r2'), 10000, 'resumed');
    await idle();
    assert.deepEqual(after('r1'), ['r1', 'r2']);
  });

  await check('max length: 20 queue, the 21st is refused with a visible message', async () => {
    await newThread();
    await typeEnter(page, '[slow:20000] big'); await busy();
    for (let i = 1; i <= 20; i++) await typeEnter(page, `m${i}`);
    await queueN(20);
    await typeEnter(page, 'm21');
    await until(() => page.locator('.toast, [role="status"], [role="alert"]', { hasText: /queue is full/i }).count(), 3000, 'full message');
    assert.equal(await queueCount(page), 20);
    assert.equal(await composer(page).inputValue(), 'm21', 'the text stays in the input');
    await shot('queue-full-dark');
    await composer(page).fill('');
    await stopBtn().click(); await until(() => holdBanner().count(), 3000, 'pause');
    await page.getByRole('button', { name: 'Clear' }).click();
  });

  await check('slash commands: /opus msg queues and sends like any message; a bare /sonnet runs locally and does not queue', async () => {
    await newThread();
    await typeEnter(page, '[slow:2500] cmd run'); await busy();
    await q('/opus after-opus'); await queueN(1);
    await composer(page).fill('/sonnet'); await composer(page).press('Enter'); await sleep(300);
    assert.equal(await queueCount(page), 1, 'the bare model switch did not queue');
    await until(() => prompts().some((p) => p.includes('after-opus')), 10000, 'opus message sent');
    await idle();
    const sent = prompts().find((p) => p.includes('after-opus'));
    assert.ok(/after-opus/.test(sent));
  });

  await check('a very long message queues, shows clipped in the list, and is sent whole', async () => {
    await newThread();
    await typeEnter(page, '[slow:2500] long msg run'); await busy();
    const big = 'word '.repeat(4000).trim() + ' END-MARK';
    await composer(page).fill(big); await composer(page).press('Enter');
    await queueN(1);
    const shown = (await qlabels())[0];
    assert.ok(shown.length <= 160, 'clipped in the DOM: ' + shown.length);
    await until(() => prompts().some((p) => p.endsWith('END-MARK')), 10000, 'sent whole');
    await idle();
  });

  await check('thread state: no page errors', async () => { assert.deepEqual(errs, []); });
} finally {
  console.log('page errors:', errs);
  const failed = report();
  await browser.close(); await env.stop();
  process.exit(failed ? 1 : 0);
}
