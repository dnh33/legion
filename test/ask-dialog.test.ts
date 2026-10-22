/** The app's own yes/no question (replaces the page's confirm box, which Electron now suppresses): the queue, the answers, and the fail-closed rules. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { answerAsk, askApp, currentAsk, resetAskForTests } from '../ui/src/components/askStore.js';
import { askToStop, stopWarning } from '../ui/src/chat/background.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string): string => readFileSync(`${ROOT}/${f}`, 'utf8');
const Q = { title: 'Stop the run?', message: 'Stop anyway?', yes: 'Stop anyway', no: 'Keep running' };

test('a question is open until it is answered; yes resolves true, no resolves false', async () => {
  resetAskForTests();
  assert.equal(currentAsk(), null);
  const a = askApp(Q);
  const cur = currentAsk();
  assert.ok(cur);
  assert.deepEqual([cur.title, cur.message, cur.yes, cur.no], [Q.title, Q.message, Q.yes, Q.no]);
  answerAsk(cur.id, true);
  assert.equal(await a, true);
  assert.equal(currentAsk(), null);
  const b = askApp({ ...Q, no: undefined });
  assert.equal(currentAsk()!.no, 'Cancel', 'the No button has a plain default name');
  answerAsk(currentAsk()!.id, false);
  assert.equal(await b, false);
});

test('a second question waits its turn: it never replaces the first, and the first answer is not given to it', async () => {
  resetAskForTests();
  const a = askApp({ ...Q, title: 'first' });
  const b = askApp({ ...Q, title: 'second' });
  assert.equal(currentAsk()!.title, 'first');
  const first = currentAsk()!;
  answerAsk(first.id, true);
  assert.equal(await a, true);
  assert.equal(currentAsk()!.title, 'second', 'the next one is shown after the first is answered');
  answerAsk(first.id, true); // a stale answer for the first one
  assert.equal(currentAsk()!.title, 'second', 'a stale answer does nothing');
  answerAsk(currentAsk()!.id, false);
  assert.equal(await b, false);
});

test('stopping fails closed: a question that cannot be asked, or that is refused, stops nothing; a run with no background agents is not asked', async () => {
  resetAskForTests();
  assert.equal(await askToStop(2, () => { throw new Error('no dialog'); }), false);
  assert.equal(await askToStop(2, () => Promise.reject(new Error('no dialog'))), false);
  assert.equal(await askToStop(2, () => false), false);
  assert.equal(await askToStop(2, () => Promise.resolve(false)), false);
  assert.equal(await askToStop(2, () => Promise.resolve(true)), true);
  assert.equal(await askToStop(2, () => true), true);
  assert.equal(await askToStop(0, () => { throw new Error('unused'); }), true);
  const asked: string[] = [];
  await askToStop(1, (m) => { asked.push(m); return true; });
  assert.deepEqual(asked, [stopWarning(1)]);
});

test('the dialog: made from the app Modal, Esc, the scrim and Close all answer No, and No holds the first focus; it is mounted once in the app', () => {
  const dlg = read('ui/src/components/AskDialog.tsx');
  assert.match(dlg, /import \{ Modal \} from '\.\/Modal';/);
  assert.match(dlg, /onClose=\{\(\) => answerAsk\(q\.id, false\)\}/, 'every way out of the Modal is a No');
  assert.match(dlg, /data-autofocus/, 'focus starts on the safe button');
  assert.match(dlg, /onClick=\{\(\) => answerAsk\(q\.id, true\)\}/);
  assert.match(read('ui/src/App.tsx'), /<AskDialog \/>/);
});

test('the places that asked with the page\'s box now ask in the app, and wait for the answer', () => {
  assert.match(read('ui/src/store.ts'), /return askToStop\(n, \(m\) => askApp\(\{/);
  assert.match(read('ui/src/projects/projectsStore.ts'), /if \(!\(await askApp\(\{[^]*?unarchiveQuestion/);
  assert.match(read('ui/src/projects/projectsStore.ts'), /if \(!\(await askApp\(\{[^]*?archiveQuestion/);
  assert.match(read('ui/src/components/UpdatePanel.tsx'), /askApp\(\{[^]*?AUTO_INSTALL_TEXT/);
  // every caller of the stop question waits for it
  for (const f of ['ui/src/store.ts', 'ui/src/chat/queueStore.ts', 'ui/src/components/Composer.tsx']) assert.doesNotMatch(read(f), /!confirmStop\(/, `${f}: a promise is always truthy, so it must be awaited`);
});
