import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { readLaunchSecrets, readSecretsFromStream } from '../src/core/admin.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { ensureConnectorKey, ensureProviderKey, keyFilePath, keyLine, loadConnectorKey, loadProviderKey, providerKeyFilePath, providerKeyLaunchLine, type SafeStorageLike } from '../src/electron/connector-key.js';
import { repoRoot } from './ps-helpers.js';
import { tempDir } from './tmp-cleanup.js';

const ADMIN = 'a'.repeat(64);
const NATIVE = 'b'.repeat(64);
const HEX = randomBytes(32).toString('hex');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ the core reader

test('admin and native secrets parse exactly as before, with or without a third line, with or without the callback', async () => {
  const plain = async (chunks: string[], cb?: (l: string) => void) => {
    const s = new PassThrough();
    const p = readSecretsFromStream(s, 2000, 400, cb);
    for (const c of chunks) s.write(c);
    return p;
  };
  const want = { admin: ADMIN, native: NATIVE };
  assert.deepEqual(await plain([`${ADMIN}\n${NATIVE}\n`]), want);
  assert.deepEqual(await plain([`${ADMIN}\n${NATIVE}\nKEY ${HEX}\n`]), want, 'a third line does not disturb them');
  assert.deepEqual(await plain([`${ADMIN}\n${NATIVE}\nKEY ${HEX}\n`], () => undefined), want);
  assert.deepEqual(await plain([`${ADMIN}\n`, `${NATIVE}\n`], () => undefined), want);
  assert.deepEqual(await plain([`${ADMIN}\n${NATIVE}`], () => undefined), want, 'follow timer path');
  assert.deepEqual(await plain([`${ADMIN}\nshort\n`], () => undefined), { admin: ADMIN, native: undefined });
});

test('without a callback the stream is paused after the two secrets and later lines are not read (the old behaviour)', async () => {
  const s = new PassThrough();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, s);
  s.write(`${ADMIN}\n${NATIVE}\n`);
  await p;
  assert.equal(s.isPaused(), true);
  assert.equal(s.listenerCount('data'), 0);
});

test('the key line is accepted in the same chunk, split across chunks, or later on the open pipe; only the documented form installs; the first wins', async () => {
  for (const chunks of [[`${ADMIN}\n${NATIVE}\nKEY ${HEX}\n`], [`${ADMIN}\n${NATIVE}\nKEY ${HEX.slice(0, 20)}`, `${HEX.slice(20)}\n`], [`${ADMIN}\n${NATIVE}\n`, `KEY ${HEX}\n`]]) {
    const kr = new ConnectorKeyring();
    const s = new PassThrough();
    const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, s, (l) => { kr.installLine(l); });
    s.write(chunks[0]!);
    for (const c of chunks.slice(1)) { await tick(); s.write(c); }
    s.end(); // the answer waits for the end of the pipe (R1), so every line has arrived when it comes
    const got = await p;
    assert.deepEqual(got, { admin: ADMIN, native: NATIVE });
    assert.deepEqual(kr.get(), Buffer.from(HEX, 'hex'), JSON.stringify(chunks.map((c) => c.length)));
  }
  const kr = new ConnectorKeyring();
  const s = new PassThrough();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, s, (l) => { kr.installLine(l); });
  s.write(`${ADMIN}\n${NATIVE}\n`);
  const other = randomBytes(32).toString('hex');
  for (const bad of [`KEY ${HEX.slice(1)}\n`, `KEYS ${HEX}\n`, `key ${HEX}\n`, `${HEX}\n`, `KEY ${HEX.toUpperCase()}\n`, `KEY ${HEX} x\n`, 'x'.repeat(1000) + '\n']) { s.write(bad); await tick(5); }
  assert.equal(kr.has(), false);
  s.write(`KEY ${HEX}\nKEY ${other}\n`);
  s.end();
  await p;
  assert.deepEqual(kr.get(), Buffer.from(HEX, 'hex'));
});

test('legion-core.ts reads the launch secrets as before, passes only a keyring callback, and the key never goes to a log, env or argv', () => {
  const core = readFileSync(join(repoRoot, 'src/bin/legion-core.ts'), 'utf8');
  assert.match(core, /await readLaunchSecrets\(process\.env, process\.stdin, \(line\) => \{ connectorKeyring\.installLine\(line\); gatesKeyring\.installLine\(line\); providerKeyring\.installLine\(line\); \}\)/);
  assert.doesNotMatch(core, /providerKeyring\.get\(\)[^;]*(console|log\()|process\.env\.\w*PKEY/);
  assert.match(core, /const \{ admin: adminSecret, native: nativeSecret \} = /);
  assert.doesNotMatch(core, /connectorKeyring\.get\(\)|process\.env\.\w*KEY/);
  assert.match(core, /createGitHubClient\(\{ tokens: new TokenStore\(join\(dataDir\(\), 'connectors'\), connectorKeyring\)/);
});

// ------------------------------------------------------------------------------------------------ Electron side

function fakeStorage(over: Partial<SafeStorageLike> & { available?: boolean; reEncrypt?: boolean } = {}) {
  const calls: string[] = [];
  const ss: SafeStorageLike = {
    isAsyncEncryptionAvailable: async () => { calls.push('avail'); return over.available ?? true; },
    encryptStringAsync: async (p) => { calls.push('enc'); return Buffer.from('WRAP:' + Buffer.from(p).toString('hex')); },
    decryptStringAsync: async (b) => { calls.push('dec'); const t = b.toString(); return t.startsWith('WRAP:') ? { result: Buffer.from(t.slice(5), 'hex').toString(), shouldReEncrypt: over.reEncrypt ?? false } : (() => { throw new Error('bad'); })(); },
    ...(over.getSelectedStorageBackend ? { getSelectedStorageBackend: over.getSelectedStorageBackend } : {}),
  };
  return { ss, calls };
}

test('a launch with no key.bin makes no safeStorage call and creates nothing', async () => {
  const dir = tempDir('legion-key-');
  const { ss, calls } = fakeStorage();
  assert.equal(await loadConnectorKey(dir, ss, 'win32'), undefined);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(keyFilePath(dir)), false);
});

test('first Connect creates the key (wrapped, 256 bits, not readable in the file); a later launch hands the same key over', async () => {
  const dir = tempDir('legion-key-');
  const { ss } = fakeStorage();
  const hex = await ensureConnectorKey(dir, ss, 'win32');
  assert.match(hex!, /^[0-9a-f]{64}$/);
  assert.ok(!readFileSync(keyFilePath(dir)).toString('latin1').includes(hex!));
  assert.equal(await loadConnectorKey(dir, ss, 'win32'), hex);
  assert.equal(await ensureConnectorKey(dir, ss, 'win32'), hex, 'no second key');
  assert.equal(keyLine(hex!), `KEY ${hex}\n`);
});

test('Linux basic_text or unknown, or unavailable encryption: nothing is written and no key is returned', async () => {
  for (const [platform, backend, available] of [['linux', 'basic_text', true], ['linux', 'unknown', true], ['linux', undefined, true], ['win32', undefined, false], ['darwin', undefined, false]] as const) {
    const dir = tempDir('legion-key-');
    const { ss } = fakeStorage({ available, ...(platform === 'linux' ? { getSelectedStorageBackend: () => backend as string } : {}) });
    assert.equal(await ensureConnectorKey(dir, ss, platform), undefined, `${platform}/${backend}`);
    assert.equal(existsSync(keyFilePath(dir)), false);
  }
  const dir = tempDir('legion-key-');
  assert.ok(await ensureConnectorKey(dir, fakeStorage({ getSelectedStorageBackend: () => 'gnome_libsecret' }).ss, 'linux'), 'a real keyring works');
});

test('shouldReEncrypt re-wraps the key; a file that does not unwrap is never overwritten', async () => {
  const dir = tempDir('legion-key-');
  const hex = await ensureConnectorKey(dir, fakeStorage().ss, 'win32');
  const before = readFileSync(keyFilePath(dir));
  const { ss, calls } = fakeStorage({ reEncrypt: true });
  writeFileSync(keyFilePath(dir), Buffer.from('WRAP:' + Buffer.from(hex!).toString('hex') + ''));
  assert.equal(await loadConnectorKey(dir, ss, 'win32'), hex);
  assert.ok(calls.includes('enc'));
  const dir2 = tempDir('legion-key-');
  mkdirSync(join(dir2, 'connectors'), { recursive: true });
  writeFileSync(keyFilePath(dir2), 'garbage');
  assert.equal(await ensureConnectorKey(dir2, fakeStorage().ss, 'win32'), undefined);
  assert.equal(readFileSync(keyFilePath(dir2), 'utf8'), 'garbage');
});

// ------------------------------------------------------------------------------------------------ main.ts wiring (source guard)

test('main.ts: the keyless launch line is untouched; the key is a third line only when key.bin unwrapped; safeStorage is read, not created, at launch', () => {
  const main = readFileSync(join(repoRoot, 'src/electron/main.ts'), 'utf8');
  assert.match(main, /child\.stdin\?\.end\(secret \+ '\\n' \+ native \+ '\\n' \+ gatesLine \+ providerLine\)/);
  assert.match(main, /if \(connectorKey\) child\.stdin\?\.end\(secret \+ '\\n' \+ native \+ '\\n' \+ gatesLine \+ providerLine \+ keyLine\(connectorKey\)\);\r?\n\s*else child\.stdin\?\.end/);
  // N14b: there is always a gates line; no key (missing and not made) is read as unreadable, never as "no key"
  assert.match(main, /const gatesLine = gatesKey \? gatesKeyLine\(gatesKey, gatesState\) : gatesKeyLine\(undefined, 'unreadable'\);/);
  assert.match(main, /const connectorKey = await loadConnectorKey\(dataDir\(\), safeStorage\);/);
  // creation is the first Connect (slice 1b): ensureConnectorKey appears only inside the connector-connect handler, never at launch
  assert.equal((main.match(/ensureConnectorKey\(/g) ?? []).length, 1);
  const handler = main.slice(main.indexOf("ipcMain.handle('legion:connector-connect'"), main.indexOf("ipcMain.handle('legion:open-external'"));
  assert.ok(handler.includes('ensureKey: () => ensureConnectorKey(dataDir(), safeStorage)'));
  assert.doesNotMatch(main.slice(main.indexOf('async function spawnCore'), main.indexOf('/** Asks what to do with a foreign core')), /ensureConnectorKey/);
  const spawnBlock = main.slice(main.indexOf('const child = spawn('), main.indexOf('coreProc = child;'));
  assert.doesNotMatch(spawnBlock, /connectorKey|keyLine|gatesKey|providerLine|providerKey|PKEY/, 'not in argv or env');
  // the provider keys' data key: one line, always, made at launch, over stdin only (never env, argv or a log)
  assert.match(main, /const providerLine = await providerKeyLaunchLine\(dataDir\(\), safeStorage\);/);
  assert.equal((main.match(/providerKeyLaunchLine\(/g) ?? []).length, 1);
  assert.doesNotMatch(main, /console\.\w+\([^)]*providerLine/);
  assert.doesNotMatch(main, /env:[^\n]*providerLine/);
  assert.doesNotMatch(main, /LEGION_\w*PKEY|PKEY[^\n]*process\.env/);
  assert.doesNotMatch(main, /console\.\w+\([^)]*connectorKey/);
});

// ------------------------------------------------------------------------------------------------ the provider keys' data key

test('provider key: made at launch (wrapped, 256 bits, not readable in the file) inside the providers folder; the same key comes back; the line is PKEY <hex>', async () => {
  const dir = tempDir('legion-pkey-');
  const { ss } = fakeStorage();
  const line = await providerKeyLaunchLine(dir, ss, 'win32');
  const hex = /^PKEY ([0-9a-f]{64})\n$/.exec(line)?.[1];
  assert.ok(hex, line);
  assert.ok(providerKeyFilePath(dir).split(sep).join('/').endsWith('/providers/key.bin'), 'inside the protected providers folder');
  assert.ok(!readFileSync(providerKeyFilePath(dir)).toString('latin1').includes(hex!));
  assert.equal(await loadProviderKey(dir, ss, 'win32'), hex);
  assert.equal(await providerKeyLaunchLine(dir, ss, 'win32'), line, 'no second key');
  assert.equal(await ensureProviderKey(dir, ss, 'win32'), hex);
});

test('provider key: Linux basic_text or unknown, or no encryption: nothing is written and the line says unavailable', async () => {
  for (const [platform, backend, available] of [['linux', 'basic_text', true], ['linux', 'unknown', true], ['linux', undefined, true], ['win32', undefined, false], ['darwin', undefined, false]] as const) {
    const dir = tempDir('legion-pkey-');
    const { ss } = fakeStorage({ available, ...(platform === 'linux' ? { getSelectedStorageBackend: () => backend as string } : {}) });
    assert.equal(await providerKeyLaunchLine(dir, ss, platform), 'PKEY - unavailable\n', `${platform}/${backend}`);
    assert.equal(existsSync(providerKeyFilePath(dir)), false);
  }
  const dir = tempDir('legion-pkey-');
  assert.match(await providerKeyLaunchLine(dir, fakeStorage({ getSelectedStorageBackend: () => 'gnome_libsecret' }).ss, 'linux'), /^PKEY [0-9a-f]{64}\n$/, 'a real keyring works');
});

test('provider key: a wrapped key that does not unwrap is never overwritten and the line says unreadable; shouldReEncrypt re-wraps', async () => {
  const dir = tempDir('legion-pkey-');
  mkdirSync(join(dir, 'providers'), { recursive: true });
  writeFileSync(providerKeyFilePath(dir), 'garbage');
  assert.equal(await providerKeyLaunchLine(dir, fakeStorage().ss, 'win32'), 'PKEY - unreadable\n');
  assert.equal(readFileSync(providerKeyFilePath(dir), 'utf8'), 'garbage');
  const dir2 = tempDir('legion-pkey-');
  const hex = await ensureProviderKey(dir2, fakeStorage().ss, 'win32');
  const { ss, calls } = fakeStorage({ reEncrypt: true });
  assert.equal(await loadProviderKey(dir2, ss, 'win32'), hex);
  assert.ok(calls.includes('enc'));
});

test('the provider data key line is the only place the key travels: no source file puts it into env, argv or a log', () => {
  const hits: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs)$/.test(e.name) && /PKEY|providerKeyring|providerLine/.test(readFileSync(p, 'utf8'))) hits.push(p.split(sep).join('/').replace(/^.*\/src\//, 'src/')); } };
  walk(join(repoRoot, 'src'));
  assert.deepEqual(hits.sort(), ['src/bin/legion-core.ts', 'src/core/providers/keyring.ts', 'src/electron/connector-key.ts', 'src/electron/main.ts']);
  for (const f of hits) assert.doesNotMatch(readFileSync(join(repoRoot, f), 'utf8'), /process\.env\[?[^\n]*PKEY|env:\s*\{[^}]*(providerLine|PKEY)/, f);
});
