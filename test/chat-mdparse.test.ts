/**
 * The Markdown parser/tokenizer must be linear: a hostile or just odd reply (odd fences, unclosed brackets, huge lines) may never hang the UI.
 * Each input runs in a worker thread that is killed after a few seconds, so a regression fails the test instead of hanging the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown, tokenizeInline, type Block } from '../ui/src/chat/mdparse.js';
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
      else if (b.t === 'table') for (const r of [b.head, ...b.rows]) for (const c of r) tokenizeInline(c);
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
  ['a 5,000-row table', '| a | b | c |\n|---|:-:|--:|\n' + '| 1 | `x | y` | z \\| w |\n'.repeat(5_000)],
  ['a 20,000-row table (rows past the cap are plain lines)', '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(20_000)],
  ['a 2,000-cell row', '|' + ' h |'.repeat(2_000) + '\n|' + '---|'.repeat(2_000) + '\n|' + ' c |'.repeat(2_000) + '\n'],
  ['a header wider than the column cap', '|' + ' h |'.repeat(50_000) + '\n|' + '-|'.repeat(50_000) + '\n'],
  ['table-looking lines that are never tables', '| a | b |\n'.repeat(N / 12)],
  ['delimiter rows without headers', '|---|---|\n'.repeat(N / 12)],
  ['alternating header and delimiter rows', '| a | b |\n|---|---|\n'.repeat(N / 24)],
  ['backticks and escapes inside a very long table row', '| ' + '`a | '.repeat(N / 6) + ' |\n|---|\n| x |'],
  ['a row of 150,000 pipes and a delimiter', '|'.repeat(N) + '\n' + '|'.repeat(N)],
  ['one-column table of 50,000 rows', '| a |\n|---|\n' + '| x |\n'.repeat(50_000)],
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

type Table = Extract<Block, { t: 'table' }>;
const tbl = (src: string): Table => { const b = parseMarkdown(src).find((x) => x.t === 'table'); assert.ok(b, `no table in ${JSON.stringify(src)}`); return b as Table; };

test('table: header, delimiter row with alignment colons, body rows', () => {
  const t = tbl('| Name | Qty | Price |\n|:---|:---:|---:|\n| apple | 3 | 1.50 |\n| pear | 10 | 22 |');
  assert.deepEqual(t.head, ['Name', 'Qty', 'Price']);
  assert.deepEqual(t.align, ['left', 'center', 'right']);
  assert.deepEqual(t.rows, [['apple', '3', '1.50'], ['pear', '10', '22']]);
  assert.deepEqual(tbl('| a | b |\n| --- | --- |\n| 1 | 2 |').align, [null, null]);
});

test('table: pipes at the edges are optional, and a table needs no blank line before it', () => {
  const b = parseMarkdown('Here is the data:\na | b\n--|--\n1 | 2\nafter text without a pipe');
  assert.deepEqual(b.map((x) => x.t), ['p', 'table', 'p']);
  assert.deepEqual((b[1] as Table).rows, [['1', '2']]);
  assert.deepEqual((b[2] as { lines: string[] }).lines, ['after text without a pipe']);
});

test('table: escaped pipes and pipes inside code spans stay in their cell', () => {
  const t = tbl('| a | b |\n|---|---|\n| x \\| y | `p | q` |\n| `r \\| s` | t |');
  assert.deepEqual(t.rows, [['x | y', '`p | q`'], ['`r | s`', 't']]);
  assert.deepEqual(tokenizeInline(t.rows[0]![1]!), [{ t: 'code', v: 'p | q' }]);
  // an unpaired backtick does not swallow the rest of the row
  assert.deepEqual(tbl('| a | b |\n|---|---|\n| it`s | 2 |').rows, [['it`s', '2']]);
});

test('table: short rows are padded, long rows are cut, empty cells are kept', () => {
  const t = tbl('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |\n| | | x |\n| 1 | 2 |  |');
  assert.deepEqual(t.rows, [['1', '', ''], ['1', '2', '3'], ['', '', 'x'], ['1', '2', '']]);
  assert.ok(t.rows.every((r) => r.length === t.head.length));
});

test('table: no delimiter row, a bad one, or a different cell count means no table', () => {
  for (const src of ['| a | b |\n| 1 | 2 |', '| a | b |\n|---|', '| a |\n|---|---|', '| a | b |\n|--|:|', '| a | b |\n|--| x |', 'a | b\n---', '| a | b |\n| - | |', '| a | b |\n']) {
    assert.equal(parseMarkdown(src).some((x) => x.t === 'table'), false, JSON.stringify(src));
  }
  assert.deepEqual(parseMarkdown('| a | b |\n| 1 | 2 |').map((x) => x.t), ['p']);
  // a header-only table is still a table
  assert.equal(tbl('| a | b |\n|---|---|').rows.length, 0);
});

test('table: it ends at a blank line, a fence or a line without a pipe; text, lists and headings around it survive', () => {
  const b = parseMarkdown('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- item\n\n| c |\n|---|\n| 3 |\n```\ncode\n```');
  assert.deepEqual(b.map((x) => x.t), ['h', 'table', 'ul', 'table', 'code']);
});

test('table: a table inside a code fence is code, not a table', () => {
  assert.deepEqual(parseMarkdown('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```').map((x) => x.t), ['code']);
});

test('table: CRLF input and inline markup in cells', () => {
  const t = tbl('| **h** | `c` |\r\n|---|---|\r\n| [l](https://a.dev) | *e* |\r\n');
  assert.deepEqual(tokenizeInline(t.head[0]!), [{ t: 'strong', v: 'h' }]);
  assert.deepEqual(tokenizeInline(t.rows[0]![0]!), [{ t: 'link', text: 'l', href: 'https://a.dev' }]);
  assert.deepEqual(tokenizeInline(t.rows[0]![1]!), [{ t: 'em', v: 'e' }]);
});

test('table: caps. A header over 200 columns is plain text; rows past 5,000 continue as plain lines', () => {
  const wide = (n: number) => '|' + ' h |'.repeat(n) + '\n|' + '-|'.repeat(n) + '\n| x |';
  assert.equal(tbl(wide(200)).head.length, 200);
  assert.equal(parseMarkdown(wide(201)).some((x) => x.t === 'table'), false);
  const long = parseMarkdown('| a |\n|---|\n' + Array.from({ length: 5_003 }, (_, i) => `| r${i} |`).join('\n'));
  assert.deepEqual(long.map((x) => x.t), ['table', 'p']);
  assert.equal((long[0] as Table).rows.length, 5_000);
  assert.deepEqual((long[1] as { lines: string[] }).lines, ['| r5000 |', '| r5001 |', '| r5002 |']);
});

test('table: plain text is the cells joined with tabs, one row per line; markdown copy is the untouched source', () => {
  const src = 'Intro\n\n| Name | Note |\n|:--|--:|\n| **a** | see [x](https://a.dev) |\n| b `c|d` | x \\| y |\n\nOutro';
  assert.equal(markdownToPlainText(src), 'Intro\n\nName\tNote\na\tsee x (https://a.dev)\nb c|d\tx | y\n\nOutro');
  // "Copy as Markdown" hands over the message text as it is (CopyMenu copies the source string, it does not re-render it)
  const menu = readFileSync(join(process.cwd(), 'ui/src/components/CopyMenu.tsx'), 'utf8');
  assert.match(menu, /kind === 'md' \? text : markdownToPlainText\(text\)/);
});

test('table: the renderer draws an accessible table in a scrollable wrapper', () => {
  const md = readFileSync(join(process.cwd(), 'ui/src/components/Markdown.tsx'), 'utf8');
  assert.match(md, /<table className="md-table">/);
  assert.match(md, /<th key=\{c\} scope="col"/);
  assert.match(md, /className="md-table-wrap" role="region" aria-label=/);
  const css = readFileSync(join(process.cwd(), 'ui/src/styles/app.css'), 'utf8');
  assert.match(css, /\.md-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
});
