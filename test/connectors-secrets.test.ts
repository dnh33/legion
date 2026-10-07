/** The core registers the secrets it holds with the log redactor as it reads them: the admin secret, the native secret and the connectors data key. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readAdminSecret, readLaunchSecrets } from '../src/core/admin.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { clearRegisteredSecrets, redact } from '../src/core/log/redact.js';

// not hex and not a token shape, so only a registration can make the redactor mask them
const ADMIN = 'Zq9-admin-secret-for-the-test-run-0001';
const NATIVE = 'Zq9-native-secret-for-the-test-run-0002';
const KEY_BYTES = Buffer.alloc(32, 0x5a);

test('readLaunchSecrets registers the admin and native secrets; the data key is registered when the key line is installed', async () => {
  clearRegisteredSecrets();
  assert.equal(redact(`admin ${ADMIN} native ${NATIVE}`), `admin ${ADMIN} native ${NATIVE}`, 'before registration they are not masked (so the test proves the call)');
  const pipe = new PassThrough();
  const kr = new ConnectorKeyring();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, pipe, (l) => { kr.installLine(l); });
  pipe.write(`${ADMIN}\n${NATIVE}\n`);
  const got = await p;
  assert.equal(got.admin, ADMIN);
  assert.equal(got.native, NATIVE);
  const out = redact(`admin ${ADMIN} native ${NATIVE}`);
  assert.ok(!out.includes(ADMIN) && !out.includes(NATIVE), out);
  assert.ok(!redact(Buffer.from(ADMIN).toString('base64')).includes(Buffer.from(ADMIN).toString('base64')), 'also in base64');
  // the key arrives later on the same pipe
  const b64 = KEY_BYTES.toString('base64');
  assert.equal(redact(`k=${b64}`), `k=${b64}`);
  pipe.write(`KEY ${KEY_BYTES.toString('hex')}\n`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(kr.has(), true);
  assert.ok(!redact(`k=${b64}`).includes(b64), 'base64 of the raw key');
  assert.ok(!redact(`k=${KEY_BYTES.toString('base64url')}`).includes(KEY_BYTES.toString('base64url')), 'base64url');
  assert.ok(!redact(`k=${KEY_BYTES.toString('hex')}`).includes(KEY_BYTES.toString('hex')), 'hex');
  clearRegisteredSecrets();
});

test('ConnectorKeyring.install registers the raw key bytes; a refused key (wrong length, second key) registers nothing', () => {
  clearRegisteredSecrets();
  const kr = new ConnectorKeyring();
  const short = Buffer.alloc(16, 0x61);
  assert.equal(kr.install(short), false);
  assert.equal(redact(`k=${short.toString('base64')}`), `k=${short.toString('base64')}`);
  assert.equal(kr.install(KEY_BYTES), true);
  assert.ok(!redact(`k=${KEY_BYTES.toString('base64')}`).includes(KEY_BYTES.toString('base64')));
  clearRegisteredSecrets();
});

test('the single-secret reader registers the admin secret too (the bridge-started core path)', async () => {
  clearRegisteredSecrets();
  const pipe = new PassThrough();
  const p = readAdminSecret({ LEGION_ADMIN_STDIN: '1' }, pipe);
  pipe.write(`${ADMIN}\n`);
  assert.equal(await p, ADMIN);
  assert.ok(!redact(`s=${ADMIN}`).includes(ADMIN));
  clearRegisteredSecrets();
});

test('a secret that is too short is neither accepted nor registered', async () => {
  clearRegisteredSecrets();
  const pipe = new PassThrough();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, pipe);
  pipe.write('short-secret\nshort-native\n');
  const got = await p;
  assert.equal(got.admin, undefined);
  assert.equal(redact('x short-secret y'), 'x short-secret y');
  clearRegisteredSecrets();
});
