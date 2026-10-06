import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorKeyring, KEY_LINE } from '../src/core/connectors/keyring.js';
import { BLOB_FILE, BLOB_VERSION, openBlob, sealBlob, TokenStore } from '../src/core/connectors/store.js';
import { tempDir } from './tmp-cleanup.js';

const ring = (key?: Buffer) => { const k = new ConnectorKeyring(); if (key) k.install(key); return k; };
const mk = (key: Buffer | undefined = randomBytes(32)) => { const dir = join(tempDir('legion-store-'), 'connectors'); return { dir, file: join(dir, BLOB_FILE), key, store: new TokenStore(dir, ring(key)) }; };
const SECRET = 'ghr_SUPERSECRETREFRESHTOKEN0123456789';

test('round trip: set, get, update, remove; a new store over the same file and key reads it back', async () => {
  const { dir, key, store } = mk();
  await store.set('github', { access: 'ghu_abc', refresh: SECRET });
  assert.deepEqual(await store.get('github'), { access: 'ghu_abc', refresh: SECRET });
  await store.update<{ n: number }>('other', (c) => ({ n: (c?.n ?? 0) + 1 }));
  assert.deepEqual(await new TokenStore(dir, ring(key)).get('other'), { n: 1 });
  assert.equal(await store.status(), 'ok');
  await store.remove('github');
  assert.equal(await store.get('github'), undefined);
  assert.deepEqual(await new TokenStore(dir, ring(key)).get('other'), { n: 1 });
});

test('nothing in clear on disk: no token, no id, no name; a fresh IV for every write; no temp file left; owner-only on POSIX', async () => {
  const { dir, file, store } = mk();
  await store.set('github-read', { access: 'ghu_abc', refresh: SECRET });
  const a = readFileSync(file);
  for (const needle of [SECRET, 'ghu_abc', 'github-read', 'access', 'refresh']) assert.ok(!a.toString('latin1').includes(needle), needle);
  await store.set('github-read', { access: 'ghu_abc', refresh: SECRET });
  const b = readFileSync(file);
  assert.notDeepEqual(a.subarray(1, 13), b.subarray(1, 13), 'IV differs per write');
  assert.equal(a[0], BLOB_VERSION);
  assert.deepEqual(readdirSync(dir), [BLOB_FILE]);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);
});

test('tamper: a flipped ciphertext, tag or IV byte reads as empty with "sign in again", no crash, file untouched', async () => {
  const { dir, file, key, store } = mk();
  await store.set('github', { access: 'a' });
  const good = readFileSync(file);
  for (const at of [1, 13, good.length - 1]) {
    const bad = Buffer.from(good); bad[at] = bad[at]! ^ 0xff;
    writeFileSync(file, bad);
    const s = new TokenStore(dir, ring(key));
    assert.equal(await s.get('github'), undefined, `byte ${at}`);
    assert.equal(await s.status(), 'sign-in-again');
    assert.deepEqual(readFileSync(file), bad, 'left untouched');
  }
  writeFileSync(file, Buffer.from([1, 2, 3]));
  assert.equal(await new TokenStore(dir, ring(key)).status(), 'sign-in-again');
});

test('wrong key reads as empty with "sign in again"', async () => {
  const { dir, store } = mk();
  await store.set('github', { access: 'a' });
  const other = new TokenStore(dir, ring(randomBytes(32)));
  assert.equal(await other.get('github'), undefined);
  assert.equal(await other.status(), 'sign-in-again');
});

test('AAD: the version byte is authenticated (altered, or a blob sealed without it, is refused)', async () => {
  const { dir, file, key } = mk();
  const plain = Buffer.from(JSON.stringify({ v: 1, connectors: { github: { access: 'a' } } }));
  const good = sealBlob(key!, plain);
  assert.ok(openBlob(key!, good));
  // downgrade or upgrade the version byte
  for (const v of [0, 2, 255]) { const b = Buffer.from(good); b[0] = v; assert.equal(openBlob(key!, b), undefined, `version ${v}`); }
  // a blob that says version 1 but was authenticated against a different version byte
  assert.equal(openBlob(key!, sealBlob(key!, plain, 2).fill(BLOB_VERSION, 0, 1)), undefined, 'sealed as version 2, relabelled 1');
  // a blob that says version 1 but carries no AAD at all
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key!, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const noAad = Buffer.concat([Buffer.from([BLOB_VERSION]), iv, c.getAuthTag(), ct]);
  assert.equal(openBlob(key!, noAad), undefined, 'no AAD');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, noAad);
  const s = new TokenStore(dir, ring(key));
  assert.equal(await s.get('github'), undefined);
  assert.equal(await s.status(), 'sign-in-again');
});

test('the queue serialises writes: 25 parallel read-modify-writes lose nothing', async () => {
  const { dir, key, store } = mk();
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.update<string[]>('list', (c) => [...(c ?? []), `w${i}`])));
  const got = (await new TokenStore(dir, ring(key)).get<string[]>('list'))!;
  assert.equal(got.length, 25);
  assert.deepEqual(got, Array.from({ length: 25 }, (_, i) => `w${i}`), 'in submission order');
  assert.deepEqual(readdirSync(dir), [BLOB_FILE]);
});

test('a failed operation does not block the ones after it', async () => {
  const { store } = mk();
  await assert.rejects(store.update('x', () => { throw new Error('boom'); }));
  await store.set('x', 1);
  assert.equal(await store.get('x'), 1);
});

test('no key: memory only, nothing is written, status says so; a later key starts from the file', async () => {
  const dir = join(tempDir('legion-store-'), 'connectors');
  const kr = ring();
  const s = new TokenStore(dir, kr);
  await s.set('github', { access: 'a' });
  assert.deepEqual(await s.get('github'), { access: 'a' });
  assert.equal(await s.status(), 'memory-only');
  assert.throws(() => readdirSync(dir), 'no folder, no file');
  kr.install(randomBytes(32));
  assert.equal(await s.get('github'), undefined);
  await s.set('github', { access: 'b' });
  assert.equal(await s.status(), 'ok');
});

test('keyring: only the documented line installs a key, once; it does not print', () => {
  const k = ring();
  const hex = randomBytes(32).toString('hex');
  for (const bad of ['', 'KEY', `KEY ${hex.slice(2)}`, `KEY ${hex.toUpperCase()}`, `key ${hex}`, `KEY ${hex} extra`, `KEY  ${hex}`, `${hex}`, `KEY ${hex}\nKEY ${hex}`]) assert.equal(k.installLine(bad), false, bad);
  assert.equal(k.has(), false);
  assert.ok(KEY_LINE.test(`KEY ${hex}`));
  assert.equal(k.installLine(`KEY ${hex}\r`), true);
  assert.equal(k.installLine(`KEY ${randomBytes(32).toString('hex')}`), false, 'the first key wins');
  assert.deepEqual(k.get(), Buffer.from(hex, 'hex'));
  assert.ok(!JSON.stringify(k).includes(hex) && !String(k).includes(hex) && !JSON.stringify({ k }).includes(hex));
  assert.equal(ring().install(randomBytes(31)), false);
});
