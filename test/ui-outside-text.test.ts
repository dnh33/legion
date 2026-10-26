import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTSIDE_TEXT_COPY } from '../ui/src/gates/outsideTextLogic.js';

const all = (): string[] => {
  const C = OUTSIDE_TEXT_COPY;
  return [C.title, C.lead, C.notice, C.keep, C.useStrict, C.shellLabel, C.shell.local.name, C.shell.local.help, C.shell.strict.name, C.shell.strict.help, C.filesName, C.filesHelp, C.limits];
};

test('U1: the Outside text words have no em dash and never say "taint" to the owner', () => {
  for (const t of all()) {
    assert.ok(!t.includes('—'), t);
    assert.ok(!/\btaint/i.test(t), t);
  }
});

test('U2: the limits are stated in the Settings text, not only in the docs', () => {
  assert.match(OUTSIDE_TEXT_COPY.shell.strict.help, /script/);
  assert.match(OUTSIDE_TEXT_COPY.limits, /program fetches by itself/);
  assert.match(OUTSIDE_TEXT_COPY.shell.local.help, /labelled, not locked/);
  assert.match(OUTSIDE_TEXT_COPY.shell.strict.help, /locked/);
});
