/** H1 item 4: a failed or rolled-back update is said once, in plain words, on the next start, and written to the app log. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Outcome } from '../src/core/updater/apply.js';
import { logOutcome, outcomeNotice, plainReason } from '../src/core/updater/outcome-notice.js';

const out = (over: Partial<Outcome> = {}): Outcome => ({ at: '2026-10-15T11:29:00.000Z', from: '0.3.0', to: '0.3.1', result: 'failed', reason: 'a Legion core is still running; nothing was changed', ...over });

test('plainReason turns the helper wording into words an owner can act on', () => {
  assert.equal(plainReason('a Legion core is still running; nothing was changed'), 'Legion was opened while it was updating');
  assert.equal(plainReason('the app did not exit in time; nothing was changed'), 'Legion did not close in time');
  assert.equal(plainReason('files in use: close other Legion windows or tools started in the Legion folder, then try again'), 'Some files were in use');
  assert.equal(plainReason('the new build did not report healthy on 127.0.0.1:4747 within 180 s'), 'The new version did not start correctly, so Legion went back to the previous one');
  assert.equal(plainReason('preflight: disk full'), 'Legion could not back up your data first');
  assert.equal(plainReason('Legion could not prepare the update helper (x). Nothing was changed.'), 'Legion could not prepare the update helper');
  assert.equal(plainReason(undefined), 'Something went wrong');
  assert.ok(!/—/.test(plainReason('odd — reason')), 'no em dash ever reaches the owner');
  assert.ok(plainReason('x'.repeat(500)).length <= 200, 'a long unknown reason is cut');
});

test('outcomeNotice: failed and rolled-back give one notice with Retry and Dismiss; ok, re-exec and none give nothing', () => {
  const n = outcomeNotice(out())!;
  assert.equal(n.message, 'The update to 0.3.1 did not finish. Legion was opened while it was updating. Your files are unchanged.');
  assert.deepEqual(n.buttons, ['Retry', 'Dismiss']);
  assert.equal(n.rolledBack, false);
  const rb = outcomeNotice(out({ result: 'rolled-back', reason: 'the new build did not report healthy on 127.0.0.1:4747 within 180 s' }))!;
  assert.equal(rb.rolledBack, true);
  assert.match(rb.message, /^The update to 0\.3\.1 did not finish\. The new version did not start correctly/);
  assert.equal(outcomeNotice(out({ result: 'ok' })), null);
  assert.equal(outcomeNotice(out({ result: 're-exec' })), null);
  assert.equal(outcomeNotice(null), null);
  for (const o of [n, rb]) assert.ok(!/—/.test(o.message + o.title));
});

test('logOutcome writes one app.log line for a failed or rolled-back update, and for an ok one that just happened', () => {
  const dir = cleanupTemp('h1-notice-');
  const now = Date.parse('2026-10-15T11:30:00.000Z');
  assert.equal(logOutcome(dir, out(), now), true);
  const text = readFileSync(join(dir, 'logs', 'app.log'), 'utf8');
  assert.match(text, /WARN\s+updater outcome/);
  assert.match(text, /result="failed"/);
  assert.match(text, /to="0\.3\.1"/);
  assert.match(text, /a Legion core is still running/);
  assert.equal(logOutcome(dir, out({ result: 'ok', reason: undefined }), now), true);
  assert.equal(logOutcome(dir, out({ result: 'ok', reason: undefined }), now + 3600_000), false, 'an old ok outcome is not logged on every start');
  assert.equal(logOutcome(dir, null, now), false);
});
