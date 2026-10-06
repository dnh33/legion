/**
 * The testing-preview notice for BSV mode: BSV mode (and its spend tool) has only been tried against fake wallets, and a person must be told
 * before turning it on and while it is on. Pinned in the title-bar tip, the first-enable dialog, the BSV panel and the docs.
 * The native spend and policy dialogs are not changed by the notice (their own tests pin them).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSV_PREVIEW_FEEDBACK, BSV_PREVIEW_NOTICE, BSV_PREVIEW_TITLE } from '../src/shared/bsv-view.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

test('preview notice: the sentence says fake wallets only, no real wallet or funds yet, and what to use', () => {
  assert.equal(BSV_PREVIEW_TITLE, 'Testing preview');
  assert.match(BSV_PREVIEW_NOTICE, /fake wallets only/);
  assert.match(BSV_PREVIEW_NOTICE, /not yet with a real wallet or real funds/);
  assert.match(BSV_PREVIEW_NOTICE, /testnet wallet with test coins/);
  assert.doesNotMatch(`${BSV_PREVIEW_NOTICE} ${BSV_PREVIEW_FEEDBACK}`, /!|cannot|safe\b|guarantee/i, 'calm and scoped, no absolutes');
});

test('preview notice: feedback goes to the channel the README names (GitHub issues, see CONTRIBUTING.md)', () => {
  assert.match(BSV_PREVIEW_FEEDBACK, /Feedback and ideas are very welcome/);
  assert.match(BSV_PREVIEW_FEEDBACK, /github\.com\/dnh33\/legion/);
  assert.match(read('README.md'), /github\.com\/dnh33\/legion\/releases/, 'the README uses this repository');
  assert.match(read('CONTRIBUTING.md'), /Open an issue/);
});

test('preview notice: the BSV panel shows it, with feedback, above everything else', () => {
  const src = read('ui/src/bsv/BsvPanel.tsx');
  const body = src.slice(src.indexOf('export function BsvPanel'));
  assert.match(body, /data-preview-notice/);
  assert.match(body, /\{BSV_PREVIEW_TITLE\}[\s\S]*\{BSV_PREVIEW_NOTICE\}[\s\S]*\{BSV_PREVIEW_FEEDBACK\}/);
  assert.ok(body.indexOf('data-preview-notice') < body.indexOf('className="bsv-lead"'), 'the notice comes first');
  assert.ok(body.indexOf('data-preview-notice') < body.indexOf('<WalletSection'), 'before the wallet section');
});

test('preview notice: the first-enable dialog leads with it', () => {
  const src = read('ui/src/bsv/ChainOverlay.tsx');
  const lines = src.slice(src.indexOf('const CONFIRM_LINES = ['));
  assert.match(lines, /^const CONFIRM_LINES = \[\n  `\$\{BSV_PREVIEW_TITLE\}\. \$\{BSV_PREVIEW_NOTICE\}`,/);
});

test('preview notice: the title-bar switch tip says testing preview', () => {
  assert.match(read('ui/src/bsv/bsvStore.ts'), /export const BSV_TIP = 'BSV Dev Kit \(testing preview\)/);
});

test('preview notice: the docs carry it (BSV-MODE top, README BSV section, CHANGELOG 0.2.5-g Changed)', () => {
  const modeDoc = read('docs/BSV-MODE.md');
  assert.ok(modeDoc.indexOf('**Testing preview.**') > -1 && modeDoc.indexOf('**Testing preview.**') < modeDoc.indexOf('## What it holds'));
  assert.match(modeDoc, /\*\*Testing preview\.\*\*[^\n]*fake wallets only[^\n]*Feedback and ideas are very welcome/);
  const readme = read('README.md');
  const sec = readme.slice(readme.indexOf('## BSV mode'), readme.indexOf('## Your Claude subscription'));
  assert.match(sec, /\*\*Testing preview\.\*\*[^\n]*fake wallets only[^\n]*Feedback and ideas are very welcome/);
  const log = read('CHANGELOG.md');
  const g = log.slice(log.indexOf('## [0.2.5-g]'), log.indexOf('## [0.2.5-f]'));
  assert.match(g, /### Changed[\s\S]*testing preview/i);
  assert.ok(g.indexOf('### Fixed') < g.indexOf('### Changed'));
});
