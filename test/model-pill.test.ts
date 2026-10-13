/**
 * The model pill keeps one line with any model name (ladder item 2): a provider-qualified name such as
 * "OpenRouter · stealth/space-bunny-alpha" wrapped to a second line inside the fixed-height pill and ran into the send
 * button. The label is cut with an ellipsis and the whole name stays one hover away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

test('the model pill stays one line: nowrap, a width cap, and an ellipsis on its label (which can shrink inside the flex row)', () => {
  const css = read('ui/src/styles/app.css');
  const rules = [...css.matchAll(/(^|\n)\s*\.model-pill\s*\{([^}]*)\}/g)].map((m) => m[2]!).join(';');
  assert.match(rules, /white-space:\s*nowrap/);
  assert.match(rules, /max-width:\s*\S+/);
  assert.match(rules, /min-width:\s*0/);
  const label = /\.model-pill \.mp-label\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(label, /overflow:\s*hidden/);
  assert.match(label, /text-overflow:\s*ellipsis/);
  assert.match(label, /min-width:\s*0/);
});

test('the pill shows the whole model name on hover, and its label is the part that is cut', () => {
  const composer = read('ui/src/components/Composer.tsx');
  assert.match(composer, /className="mp-label">\{modelLabel\(catalog, model\)\}<\/span>/);
  assert.match(composer, /title=\{`\$\{modelLabel\(catalog, model\)\}/);
});
