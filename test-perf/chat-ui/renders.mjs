// Counts MessageView renders (needs a UI built with a counter in MessageViewImpl: window.__mv) during typing, streaming, hover/copy and queue use.
//   node renders.mjs <instrumented dist-ui> [label]
import { startFake } from './harness.mjs';
import { openPage, sleep, until, composer, typeEnter } from './lib.mjs';
const ui = process.argv[2]; const label = process.argv[3] || ui;
const env = await startFake({ ui, repo: '/tmp/m/wt-chat', port: Number(process.env.PORT || 48690) });
let id;
for (let i = 0; i < 12; i++) { const t = env.engine.startTask({ agentId: 'zealot', prompt: `[md] q ${i}`, source: 'ui', ...(id ? { continueTaskId: id } : {}) }); id = t.id; await env.engine.waitFor(id, 5000); }
const { browser, page } = await openPage(env);
await until(async () => (await page.locator('.thread .msg.assistant').count()) >= 12, 8000, 'thread');
await sleep(600);
const mv = () => page.evaluate(() => window.__mv || 0);
const out = { label };
let a = await mv(); await composer(page).click(); await page.keyboard.type('hello there this is typing', { delay: 15 }); out.typing26chars = (await mv()) - a;
await composer(page).fill('');
a = await mv(); for (let i = 0; i < 100; i++) { env.bus.emit({ type: 'message.delta', taskId: id, text: 'tok ' }); await sleep(15); } await sleep(300); out.stream100deltas = (await mv()) - a;
env.bus.emit({ type: 'message', message: { id: 'final1', taskId: id, role: 'assistant', text: 'final answer', at: new Date().toISOString() } }); await sleep(300);
a = await mv(); const m = page.locator('.thread .msg.assistant').first(); await m.hover(); await page.mouse.move(5, 5); await m.hover();
if (await m.locator('.msg-actions').count()) { await m.getByRole('button', { name: 'Copy as plain text' }).click(); await sleep(300); }
out.hoverAndCopy = (await mv()) - a;
// queue use: busy run, queue two, let them drain
a = await mv(); await typeEnter(page, '[slow:1500] busy'); await until(() => page.locator('.composer .send.stop').count(), 4000, 'busy').catch(() => {});
await typeEnter(page, 'q-one'); await typeEnter(page, 'q-two');
await sleep(5500); out.queueRunOf3Messages = (await mv()) - a;
out.messagesNow = await page.locator('.thread .msg').count();
console.log(JSON.stringify(out));
await browser.close(); await env.stop();
