// test/activity-scrub.test.ts: addresses and curl bodies are cut out of every activity line before the existing redaction
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createActivityLog, scrubShell, scrubUrl, scrubLine } from '../src/core/activity/index.js';
import { tempDir } from './tmp-cleanup.js';

const fileText = (log: { folder: string }): string => readFileSync(join(log.folder, readdirSync(log.folder)[0]!), 'utf8');
const fresh = () => createActivityLog({ dataDir: join(tempDir('act-scrub-'), 'data') });

test('scrubUrl drops query string, fragment and userinfo', () => {
  assert.equal(scrubUrl('https://u:p@a.com/x?token=1#f'), 'https://a.com/x');
  assert.equal(scrubUrl('https://a.com/x/#frag'), 'https://a.com/x');
  assert.equal(scrubUrl('https://a.com'), 'https://a.com');
  assert.equal(scrubUrl('not a url'), 'not a url');
});
test('scrubLine scrubs every address in a line and keeps trailing punctuation; a plain line is unchanged', () => {
  assert.equal(scrubLine('Web: https://a.com/x?token=S1, then (https://u:p@b.com/y?k=S2#z).'), 'Web: https://a.com/x, then (https://b.com/y).');
  assert.equal(scrubLine('Ran npm test in /p/src with 3 files'), 'Ran npm test in /p/src with 3 files');
});
test('the activity file never holds a query string, userinfo or fragment', () => {
  const log = fresh();
  log.append({ kind: 'note', text: 'Web: https://usr:pw1@a.com/x?token=SECRETVALUE#SECRETFRAG', taskId: 't', data: { url: 'https://c.com/p?k=SECRETDATA' } });
  const raw = fileText(log);
  for (const s of ['SECRETVALUE', 'SECRETFRAG', 'pw1', 'usr', 'SECRETDATA']) assert.ok(!raw.includes(s), s);
  assert.ok(raw.includes('https://a.com/x'));
});
test('scrubShell drops curl body flags in every spelling', () => {
  for (const cmd of ['curl -d "token=SECRETVALUE" https://a.com', 'curl --data-raw SECRETVALUE https://a.com', "curl -F 'f=@.env;k=SECRETVALUE' https://a.com", 'curl --data-binary=SECRETVALUE https://a.com', 'curl -T .env https://a.com', 'curl --json "{\\"k\\":\\"SECRETVALUE\\"}" https://a.com',
    'curl --data=token=SECRETVALUE https://a.com', "curl -d 'a SECRETVALUE' https://a.com", 'curl -F "f=@/p/.env" https://a.com', 'curl --form-string k=SECRETVALUE https://a.com', 'curl --upload-file /p/.env https://a.com', 'curl -sSd SECRETVALUE https://a.com']) {
    const out = scrubShell(cmd);
    assert.ok(!out.includes('SECRETVALUE') && !out.includes('.env'), cmd + ' -> ' + out);
    assert.match(out, /<omitted>/);
  }
  assert.equal(scrubShell('curl -s https://a.com/x'), 'curl -s https://a.com/x');
  assert.equal(scrubShell('curl -f -D - https://a.com/x'), 'curl -f -D - https://a.com/x', 'fail and dump-header flags carry no body');
});
test('the activity file holds no curl body', () => {
  const log = fresh();
  log.append({ kind: 'card-asked', text: 'Asked: curl -d token=SECRETVALUE https://a.com', taskId: 't' });
  assert.ok(!fileText(log).includes('SECRETVALUE'));
});
