/** Copy menu: the Markdown parser the bubble renders with (ui/src/chat/mdparse.ts) and "Copy as plain text" (ui/src/chat/plaintext.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, tokenizeInline } from '../ui/src/chat/mdparse.js';
import { markdownToPlainText } from '../ui/src/chat/plaintext.js';

const RICH = [
  '## Plan', '', 'Here is the **plan** with `inline code` and a [docs link](https://example.com/docs).', '',
  '- first item', '- second *item* with emphasis', '', '1. step one', '2. step two', '',
  '```ts', 'const x = 1;', 'console.log(x);', '```', '', 'Done.',
].join('\n');

test('plain text: the rich reply loses its syntax and keeps its structure', () => {
  assert.equal(markdownToPlainText(RICH), [
    'Plan', '', 'Here is the plan with inline code and a docs link (https://example.com/docs).', '',
    '- first item', '- second item with emphasis', '', '1. step one', '2. step two', '',
    'const x = 1;', 'console.log(x);', '', 'Done.',
  ].join('\n'));
});

test('plain text: no Markdown markers survive in prose', () => {
  const out = markdownToPlainText('# H1\n\n### H3 **bold** *em* `code`\n\n* a\n* b\n');
  assert.equal(out, 'H1\n\nH3 bold em code\n\n- a\n- b');
  assert.doesNotMatch(out, /[*`#]/);
});

test('plain text: code blocks keep every line, indentation and blank lines, without fences or the language tag', () => {
  const md = 'Before\n\n```python\ndef f(x):\n    if x:\n\n        return 1\n```\n\nAfter';
  assert.equal(markdownToPlainText(md), 'Before\n\ndef f(x):\n    if x:\n\n        return 1\n\nAfter');
  assert.equal(markdownToPlainText('```\nplain\n```'), 'plain');
});

test('plain text: text inside code is not interpreted (stars and backticks stay)', () => {
  assert.equal(markdownToPlainText('```\na ** b * c `d`\n```'), 'a ** b * c `d`');
});

test('plain text: links keep their address, bare URLs stay and keep trailing punctuation', () => {
  assert.equal(markdownToPlainText('See [the docs](https://a.dev/x) now.'), 'See the docs (https://a.dev/x) now.');
  assert.equal(markdownToPlainText('Open https://a.dev/x, then go.'), 'Open https://a.dev/x, then go.');
  assert.equal(markdownToPlainText('[https://a.dev](https://a.dev)'), 'https://a.dev');
});

test('plain text: numbered lists are numbered 1.. as drawn; a paragraph keeps its line breaks', () => {
  assert.equal(markdownToPlainText('3. three\n4. four'), '1. three\n2. four');
  assert.equal(markdownToPlainText('line one\nline two\n\nnext para'), 'line one\nline two\n\nnext para');
});

test('plain text: CRLF input, empty input and whitespace-only input', () => {
  assert.equal(markdownToPlainText('a\r\n\r\n- b\r\n'), 'a\n\n- b');
  assert.equal(markdownToPlainText(''), '');
  assert.equal(markdownToPlainText('  \n \n'), '');
});

test('plain text: things the renderer does not style are not stripped (what you see is what you copy)', () => {
  assert.equal(markdownToPlainText('> quoted\n\nsnake_case_name and 2 * 3 * 4'), '> quoted\n\nsnake_case_name and 2 * 3 * 4');
});

test('parser: blocks and tokens are what the bubble draws', () => {
  assert.deepEqual(parseMarkdown(RICH).map((b) => b.t), ['h', 'p', 'ul', 'ol', 'code', 'p']);
  assert.deepEqual(parseMarkdown('```js\nx\n```')[0], { t: 'code', lang: 'js', code: 'x' });
  assert.deepEqual(tokenizeInline('a **b** `c` *d* [e](https://f.g) https://h.i.'), [
    { t: 'text', v: 'a ' }, { t: 'strong', v: 'b' }, { t: 'text', v: ' ' }, { t: 'code', v: 'c' }, { t: 'text', v: ' ' }, { t: 'em', v: 'd' }, { t: 'text', v: ' ' },
    { t: 'link', text: 'e', href: 'https://f.g' }, { t: 'text', v: ' ' }, { t: 'link', text: 'https://h.i', href: 'https://h.i' }, { t: 'text', v: '.' },
  ]);
});

test('parser: an unterminated fence runs to the end (a streaming reply is still readable)', () => {
  assert.deepEqual(parseMarkdown('```\nopen'), [{ t: 'code', lang: '', code: 'open' }]);
});
