import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserPin } from '../src/shared/browser.js';
import { BROWSER_PINS } from '../src/shared/browser.js';
import { getLightpanda, readManaged, verifyManaged, effectiveSha, appDir, recordFile } from '../src/core/browser/get-lightpanda.js';
import type { GetPorts } from '../src/core/browser/get-lightpanda.js';
import { createGetPorts, download } from '../src/core/browser/system.js';

const BYTES = Buffer.from('#!/bin/sh\necho fake lightpanda\n');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PIN: BrowserPin = { id: 'test-linux-x64', platform: 'linux-x64', url: 'https://example.com/lightpanda', sha256: '', approxBytes: 1024 * 1024, maxBytes: 5 * 1024 * 1024, exe: 'lightpanda', license: 'AGPL-3.0', sourceUrl: 'https://example.com/src' };

function rig(over: Partial<GetPorts> = {}, bytes = BYTES) {
  const dataDir = mkdtempSync(join(tmpdir(), 'br-get-'));
  const calls = { download: 0, approve: 0, urls: [] as string[] };
  const ports: GetPorts = {
    ...createGetPorts(), platformKey: 'linux-x64',
    async download(url, dest) { calls.download++; calls.urls.push(url); writeFileSync(dest, bytes); return { sha256: sha(bytes), bytes: bytes.length }; },
    ...over,
  };
  return { dataDir, ports, calls };
}
const run = (r: ReturnType<typeof rig>, o: { cfgSha?: string; answer?: boolean; pins?: BrowserPin[] } = {}) =>
  getLightpanda(r.ports, { dataDir: r.dataDir, ...(o.cfgSha ? { cfgSha: o.cfgSha } : {}), pins: o.pins ?? [PIN], approve: async (a) => { r.calls.approve++; assert.match(a.summary, /AGPL-3\.0/); assert.match(a.summary, /example\.com\/lightpanda/); return o.answer ?? true; } });

test('C10: the shipped pins have no hash, so nothing is asked and nothing is downloaded until the owner records one', async () => {
  for (const p of BROWSER_PINS) assert.equal(p.sha256, '', p.id);
  const r = rig();
  const res = await getLightpanda(r.ports, { dataDir: r.dataDir, pins: BROWSER_PINS.map((p) => ({ ...p, platform: 'linux-x64' })), approve: async () => { r.calls.approve++; return true; } });
  assert.equal(res.ok, false);
  assert.match(res.steps.at(-1)!.detail, /TODO OWNER PC/);
  assert.equal(r.calls.download, 0); assert.equal(r.calls.approve, 0);
});

test('C10: no approval, no download; a denial leaves nothing on disk', async () => {
  const r = rig();
  const res = await run(r, { cfgSha: sha(BYTES), answer: false });
  assert.equal(res.ok, false); assert.equal(res.denied, true);
  assert.equal(r.calls.download, 0);
  assert.equal(existsSync(appDir(r.dataDir)), false);
});

test('C10: the hash is checked BEFORE the file becomes a program; a mismatch installs nothing and removes the partial file', async () => {
  const r = rig({}, Buffer.from('something else entirely'));
  const res = await run(r, { cfgSha: sha(BYTES) });
  assert.equal(res.ok, false);
  assert.match(res.steps.at(-1)!.detail, /does not match/);
  assert.deepEqual(existsSync(appDir(r.dataDir)) ? readdirSync(appDir(r.dataDir)) : [], [], 'no partial file, no staging folder, no install');
  assert.equal(existsSync(recordFile(r.dataDir)), false);
});

test('C10: an approved, matching download is installed once, executable, recorded inside Legion\'s folder', async () => {
  const r = rig();
  const res = await run(r, { cfgSha: sha(BYTES) });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.equal(r.calls.urls[0], PIN.url);
  const m = readManaged(r.ports, r.dataDir)!;
  assert.ok(m.path.startsWith(appDir(r.dataDir)));
  if (process.platform !== 'win32') assert.ok((statSync(m.path).mode & 0o111) !== 0, 'executable');
  assert.equal(await verifyManaged(r.ports, m), true);
  // asking again: already installed and still matching, so no second download and no second card
  const again = await run(r, { cfgSha: sha(BYTES) });
  assert.equal(again.ok, true); assert.equal(r.calls.download, 1); assert.equal(r.calls.approve, 1);
});

test('C16: a changed file no longer verifies (tamper check before every start)', async () => {
  const r = rig();
  await run(r, { cfgSha: sha(BYTES) });
  const m = readManaged(r.ports, r.dataDir)!;
  writeFileSync(m.path, 'tampered');
  assert.equal(await verifyManaged(r.ports, m), false);
  assert.equal(await verifyManaged(r.ports, { ...m, sha256: '' }), false);
});

test('the record is believed only when it points inside Legion\'s own folder', () => {
  const r = rig();
  writeFileSync(join(r.dataDir, 'x'), 'x');
  const ports = { exists: () => true, readText: (p: string) => (p === recordFile(r.dataDir) ? JSON.stringify({ id: 'test-linux-x64', exe: '../../../etc/passwd', sha256: 'a' }) : undefined) };
  assert.equal(readManaged(ports, r.dataDir), null);
  const abs = { exists: () => true, readText: () => JSON.stringify({ id: 'test-linux-x64', exe: '/usr/bin/curl', sha256: 'a' }) };
  assert.equal(readManaged(abs, r.dataDir), null);
});

test('a platform with no pin gets a plain explanation (Windows: WSL)', async () => {
  const r = rig({ platformKey: 'win32-x64' });
  const res = await run(r, { cfgSha: sha(BYTES) });
  assert.equal(res.ok, false); assert.match(res.steps[0]!.detail, /WSL/);
  assert.equal(r.calls.approve, 0);
});

test('effectiveSha: the pin wins over config; neither means empty; a malformed value is ignored', () => {
  const h = 'a'.repeat(64);
  assert.equal(effectiveSha({ sha256: h }, 'b'.repeat(64)), h);
  assert.equal(effectiveSha({ sha256: '' }, 'b'.repeat(64)), 'b'.repeat(64));
  assert.equal(effectiveSha({ sha256: '' }, 'nothex'), '');
  assert.equal(effectiveSha({ sha256: '' }, undefined), '');
});

test('C10: the real download routine refuses anything but a public https address before it makes any request', async () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'br-dl-')), 'f');
  for (const u of ['http://example.com/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://localhost/x', 'file:///etc/passwd', 'https://169.254.169.254/x', 'https://[::1]/x']) {
    await assert.rejects(download(u, dest, { maxBytes: 100 }), /https and public/, u);
  }
});
