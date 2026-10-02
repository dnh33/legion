import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStreamRedactor } from '../src/core/providers/stream-redact.js';
import { scrubSecrets } from '../src/core/comms/scrub.js';
import { chunk, FAKE_KEY, sseHead, sseSend, startFake } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';

const redactWith = (keys: string[]) => (s: string) => scrubSecrets(s, { exact: keys });

test('A2 a key split across 1-character chunks never appears in the emitted stream (unit)', () => {
  const out: string[] = [];
  const r = makeStreamRedactor((t) => out.push(t), redactWith([FAKE_KEY]), () => [FAKE_KEY]);
  const text = `Here you go: ${FAKE_KEY} and more text after it to push the tail out of the hold-back window. `.repeat(2);
  for (const ch of text) r.push(ch);
  r.flush();
  const all = out.join('');
  assert.equal(all.includes(FAKE_KEY), false);
  assert.equal(all.includes(FAKE_KEY.slice(0, 12)), false, 'not even a long prefix of it');
  assert.match(all, /redacted/);
  assert.ok(all.includes('and more text after it'), 'the rest of the text still comes through');
  assert.ok(out.length > 1, 'it streams (not one block at the end)');
});

test('A2 an sk- shaped token that is not a saved key is held back whole and redacted, even when it is longer than the hold-back window', () => {
  const out: string[] = [];
  const longTok = 'sk-' + 'a1B2c3D4'.repeat(40);
  const r = makeStreamRedactor((t) => out.push(t), redactWith([]), () => []);
  for (const ch of `x ${longTok} y ${'z'.repeat(200)}`) r.push(ch);
  r.flush();
  const all = out.join('');
  assert.equal(all.includes('sk-a1B2'), false);
  assert.ok(all.endsWith('z'.repeat(200)));
});

test('A2 two keys, a key at the very start, and a key ending exactly at the end of the stream', () => {
  for (const text of [FAKE_KEY + ' tail text'.repeat(10), 'head ' + FAKE_KEY, 'a' + FAKE_KEY + 'b' + FAKE_KEY + 'c']) {
    const out: string[] = [];
    const r = makeStreamRedactor((t) => out.push(t), redactWith([FAKE_KEY]), () => [FAKE_KEY]);
    for (const ch of text) r.push(ch);
    r.flush();
    assert.equal(out.join('').includes(FAKE_KEY), false, text.slice(0, 20));
  }
});

test('A2 through the real run: the live message.delta events and the stored message hold no key when the provider echoes it one character at a time', async () => {
  const text = `the key is ${FAKE_KEY} ok. ` + 'padding to flush the window. '.repeat(4);
  const f = await startFake((_r, res) => {
    sseHead(res);
    for (const ch of text) sseSend(res, chunk({ content: ch }));
    sseSend(res, chunk({}, 'stop')); sseSend(res, '[DONE]'); res.end();
  });
  try {
    const h = setup(f);
    h.keys.set('fake', FAKE_KEY, new URL(f.url).origin);
    const t = await run(h);
    assert.equal(t.status, 'done');
    const deltas = h.events.filter((e) => e.type === 'message.delta').map((e: any) => e.text as string).join('');
    assert.equal(deltas.includes(FAKE_KEY), false, 'live deltas');
    assert.ok(deltas.includes('padding to flush'), 'the stream still carries the text');
    assert.equal(JSON.stringify(h.store.msgs).includes(FAKE_KEY), false, 'stored messages');
  } finally { await f.close(); }
});
