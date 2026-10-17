import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { readLaunchSecrets, readSecretsFromStream } from '../src/core/admin.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { GatesKeyring } from '../src/core/gates-settings/keyring.js';
import { ProviderKeyring } from '../src/core/providers/keyring.js';

const ADMIN = 'a'.repeat(64);
const NATIVE = 'b'.repeat(64);
const HEX = randomBytes(32).toString('hex');
const GHEX = randomBytes(32).toString('hex');
const CHEX = randomBytes(32).toString('hex');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const rings = () => {
  const connector = new ConnectorKeyring(); const gates = new GatesKeyring(); const provider = new ProviderKeyring();
  return { connector, gates, provider, cb: (l: string) => { connector.installLine(l); gates.installLine(l); provider.installLine(l); } };
};

const seen = (r: ReturnType<typeof rings>) => ({ provider: r.provider.get()?.toString('hex'), gates: r.gates.get()?.toString('hex'), connector: r.connector.get()?.toString('hex') });

test('R1 resolves only after the stream ends: every later line is installed by the time the secrets come back', async () => {
  const r = rings();
  const s = new PassThrough();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, s, r.cb);
  s.write(`${ADMIN}\n${NATIVE}\n`);
  await tick(80); // the secrets alone are not the answer
  let resolved = false; void p.then(() => { resolved = true; });
  await tick(80);
  assert.equal(resolved, false, 'still waiting for the rest of the launch lines');
  s.write(`GATESKEY ${GHEX} old\nPKEY ${HEX}\nKEY ${CHEX}\n`);
  s.end();
  assert.deepEqual(await p, { admin: ADMIN, native: NATIVE });
  assert.deepEqual(r.provider.get(), Buffer.from(HEX, 'hex'));
  assert.deepEqual(r.gates.get(), Buffer.from(GHEX, 'hex'));
  assert.deepEqual(r.connector.get(), Buffer.from(CHEX, 'hex'));
});

test('R1 chunks split mid-line and across lines still deliver every line before the answer', async () => {
  const r = rings();
  const s = new PassThrough();
  const p = readSecretsFromStream(s, 3000, 400, r.cb).then((v) => ({ v, at: seen(r) }));
  const all = `${ADMIN}\n${NATIVE}\nGATESKEY ${GHEX} new\nPKEY ${HEX}\nKEY ${CHEX}\n`;
  // cut inside the admin line, inside the PKEY hex and between lines
  const cuts = [10, 70, all.indexOf('PKEY') + 20, all.indexOf('PKEY') + 40, all.indexOf('KEY ' + CHEX) + 3];
  let from = 0;
  for (const c of cuts) { s.write(all.slice(from, c)); from = c; await tick(15); }
  s.write(all.slice(from));
  s.end();
  const { v, at } = await p;
  assert.deepEqual(v, { admin: ADMIN, native: NATIVE });
  assert.deepEqual(at, { provider: HEX, gates: GHEX, connector: CHEX }, 'all three were installed at the moment the answer came');
});

test('R1 a PKEY line in a late chunk (well after the secrets and the follow window) is installed before the answer', async () => {
  const r = rings();
  const s = new PassThrough();
  const p = readSecretsFromStream(s, 3000, 50, r.cb).then(() => seen(r));
  s.write(`${ADMIN}\n${NATIVE}\n`);
  await tick(200);
  s.write(`PKEY ${HEX}\n`);
  await tick(20);
  s.end();
  assert.equal((await p).provider, HEX, 'installed at the moment the answer came');
});

test('R1 the stream ends with no PKEY line: the answer still comes, and the provider ring has no key and no reason', async () => {
  const r = rings();
  const s = new PassThrough();
  const p = readSecretsFromStream(s, 3000, 400, r.cb);
  s.write(`${ADMIN}\n${NATIVE}\nGATESKEY - unreadable\n`);
  s.end();
  assert.deepEqual(await p, { admin: ADMIN, native: NATIVE });
  assert.equal(r.provider.has(), false);
  assert.equal(r.provider.noKey(), undefined);
});

test('R1 a last line without a newline is delivered when the stream ends', async () => {
  const r = rings();
  const s = new PassThrough();
  const p = readSecretsFromStream(s, 3000, 400, r.cb);
  s.write(`${ADMIN}\n${NATIVE}\nPKEY - unavailable`);
  s.end();
  await p;
  assert.equal(r.provider.noKey(), 'unavailable');
});

test('R1 the stream ends before the second secret: the answer comes at once with what there is, and no hang', async () => {
  const r = rings();
  const s = new PassThrough();
  const p = readSecretsFromStream(s, 3000, 400, r.cb);
  s.write(`${ADMIN}\n`);
  s.end();
  assert.deepEqual(await p, { admin: ADMIN, native: undefined });
});

test('R1 a stream that never ends: the answer comes at the overall limit, and a line that comes later is still delivered', async () => {
  const r = rings();
  const s = new PassThrough();
  const t0 = Date.now();
  const p = readSecretsFromStream(s, 300, 50, r.cb);
  s.write(`${ADMIN}\n${NATIVE}\nGATESKEY ${GHEX} old\n`);
  const got = await p;
  const took = Date.now() - t0;
  assert.deepEqual(got, { admin: ADMIN, native: NATIVE });
  assert.ok(took >= 250 && took < 1500, `waited for the limit, not forever (${took} ms)`);
  assert.equal(r.provider.has(), false);
  s.write(`PKEY ${HEX}\n`);
  await tick(40);
  assert.deepEqual(r.provider.get(), Buffer.from(HEX, 'hex'), 'behaves as before after the limit');
  s.end();
});

test('R1 a stream error ends the wait', async () => {
  const r = rings();
  const s = new PassThrough();
  const p = readSecretsFromStream(s, 3000, 400, r.cb);
  s.write(`${ADMIN}\n${NATIVE}\n`);
  await tick(20);
  s.destroy(new Error('pipe closed'));
  assert.deepEqual(await p, { admin: ADMIN, native: NATIVE });
});

test('R1 without a callback nothing changes: the answer comes after the two secrets and the stream is paused', async () => {
  const s = new PassThrough();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, s);
  s.write(`${ADMIN}\n${NATIVE}\nPKEY ${HEX}\n`);
  assert.deepEqual(await p, { admin: ADMIN, native: NATIVE });
  assert.equal(s.isPaused(), true);
  assert.equal(s.listenerCount('data'), 0);
});
