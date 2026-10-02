/**
 * The Markdown parser/tokenizer must be linear: a hostile or just odd reply (odd fences, unclosed brackets, huge lines) may never hang the UI.
 * Each input runs in a worker thread that is killed after a few seconds, so a regression fails the test instead of hanging the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMarkdown, tokenizeInline } from '../ui/src/chat/mdparse.js';
import { markdownToPlainText } from '../ui/src/chat/plaintext.js';

const dir = fileURLToPath(new URL('../ui/src/chat/', import.meta.url));
const mod = (f: string) => pathToFileURL(dir + f).href;

/** Runs the whole pipeline (blocks, inline tokens of every line, plain text) on `src` in a worker. Resolves with elapsed ms, rejects on timeout. */
function pipeline(src: string, limitMs = 4000): Promise<number> {
  const code = `
    import { workerData, parentPort } from 'node:worker_threads';
    const { parseMarkdown, tokenizeInline } = await import(workerData.md);
    const { markdownToPlainText } = await import(workerData.pt);
    const t0 = Date.now();
    const blocks = parseMarkdown(workerData.src);
    for (const b of blocks) {
      if (b.t === 'p') for (const l of b.lines) tokenizeInline(l);
      else if (b.t === 'h') tokenizeInline(b.text);
      else if (b.t === 'ul' || b.t === 'ol') for (const i of b.items) tokenizeInline(i);
    }
    markdownToPlainText(workerData.src);
    parentPort.postMessage(Date.now() - t0);`;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { src, md: mod('mdparse.js'), pt: mod('plaintext.js') } });
    const timer = setTimeout(() => { void w.terminate(); reject(new Error(`still running after ${limitMs} ms (input ${src.length} chars)`)); }, limitMs);
    w.once('message', (ms: number) => { clearTimeout(timer); void w.terminate(); resolve(ms); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const N = 150_000;
const cases: Array<[string, string]> = [
  ['a fence line with an info string it does not understand', '```js title="x" extra\nbody\n```\n'],
  ['many such fence lines in a row', '``` a b\n'.repeat(20_000)],
  ['odd fences, open and close mixed with text', Array.from({ length: 20_000 }, (_, i) => (i % 3 === 0 ? '```' : i % 3 === 1 ? '``` x y' : 'text')).join('\n')],
  ['a fence followed by a huge run of spaces, then a character', '```' + ' '.repeat(N) + 'x'],
  ['an unterminated fence over a very long body', '```\n' + 'line\n'.repeat(N)],
  ['one line of open brackets', '['.repeat(N)],
  ['link starts without an end', '[a](http://'.repeat(20_000)],
  ['link text that never closes after many openers', '[x '.repeat(50_000)],
  ['a long run of stars', '*'.repeat(N)],
  ['bold openers', '**a '.repeat(50_000)],
  ['backticks that never pair up on a line', '` '.repeat(N / 2)],
  ['bare url openers', 'https://'.repeat(30_000)],
  ['an enormous single line of plain text', 'word '.repeat(N)],
  ['a huge list of one-character items', '- a\n'.repeat(N)],
  ['numbered list with deep spaces', ' '.repeat(N) + '1. x'],
  ['just under the inline limit: open brackets', '['.repeat(19_999)],
  ['just under the inline limit: link starts without an end', '[a](http://'.repeat(1_800)],
  ['just under the inline limit: stars and backticks', '*a`'.repeat(6_600)],
  ['heading markers without text', '#### '.repeat(30_000)],
];
for (const [name, src] of cases) {
  test(`linear: ${name}`, { timeout: 10_000 }, async () => {
    const ms = await pipeline(src);
    assert.ok(ms < 3500, `${ms} ms`);
  });
}

test('an odd fence line is read as text, in order, and parsing always advances', () => {
  const b = parseMarkdown('before\n```js title="x"\nafter');
  assert.deepEqual(b.map((x) => x.t), ['p', 'p']);
  assert.deepEqual((b[0] as { lines: string[] }).lines, ['before']);
  assert.deepEqual((b[1] as { lines: string[] }).lines, ['```js title="x"', 'after']);
  assert.deepEqual(parseMarkdown('``` a b').map((x) => x.t), ['p']);
  assert.equal(markdownToPlainText('``` a b\ntext'), '``` a b\ntext');
});

test('fences: language tags with + and -, indentation and trailing spaces still open and close a block', () => {
  assert.deepEqual(parseMarkdown('  ```c++  \nx\n  ```  ')[0], { t: 'code', lang: 'c++', code: 'x' });
  assert.deepEqual(parseMarkdown('```objective-c\nx\n```')[0], { t: 'code', lang: 'objective-c', code: 'x' });
});

test('inline: a link still works, and an opener inside link text restarts at the inner link', () => {
  assert.deepEqual(tokenizeInline('see [docs](https://a.dev/x) ok'), [{ t: 'text', v: 'see ' }, { t: 'link', text: 'docs', href: 'https://a.dev/x' }, { t: 'text', v: ' ok' }]);
  assert.deepEqual(tokenizeInline('[a [b](https://c.d)'), [{ t: 'text', v: '[a ' }, { t: 'link', text: 'b', href: 'https://c.d' }]);
});

test('inline: a line longer than the limit is left as plain text (no markup scan)', () => {
  const long = '**x** '.repeat(20_000);
  assert.deepEqual(tokenizeInline(long), [{ t: 'text', v: long }]);
});
