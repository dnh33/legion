/** The skill finder's model download: approval first, each file's hash before the next, nothing recorded on a failure. Fake ports only. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalFor, getModel, modelDirFor, readInstalled, removeModel, finderRoot } from '../src/core/armory/finder/get-model.js';
import { createGetBlenderPorts } from '../src/core/blender/system.js';
import { FINDER_MODEL_PIN, finderHostOk } from '../src/shared/finder.js';
import type { FinderModelPin } from '../src/shared/finder.js';
import { CONTENT, fakePorts, PIN } from './finder-model-fakes.js';

describe('finder model download', () => {
  it('asks first: a refusal downloads nothing and records nothing', async () => {
    const f = fakePorts();
    const r = await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => false });
    assert.equal(r.ok, false);
    assert.equal(r.denied, true);
    assert.deepEqual(f.log, []);
    assert.deepEqual(f.keys(), []);
  });

  it('treats an approval that throws as a refusal', async () => {
    const f = fakePorts();
    const r = await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => { throw new Error('boom'); } });
    assert.equal(r.denied, true);
    assert.deepEqual(f.log, []);
  });

  it('the card names every address, size, hash, the folder, the licence and the memory use', async () => {
    let card: ReturnType<typeof approvalFor> | undefined;
    const f = fakePorts();
    await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async (c) => { card = c; return false; } });
    assert.ok(card);
    const text = card.summary;
    for (const file of PIN.files) {
      assert.ok(text.includes(file.sha256), `hash of ${file.name}`);
      assert.ok(text.includes(file.url), `address of ${file.name}`);
    }
    assert.ok(text.includes(modelDirFor('/data', PIN)), 'folder');
    assert.ok(text.includes('MIT'), 'licence');
    assert.ok(text.includes('about 1 GB of memory while it is active'), 'memory');
    assert.ok(/about \d+ MB to download/.test(text), 'download size');
    assert.deepEqual(card.hosts, ['cdn.example.com', 'models.example.com']);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), 'no em dash');
  });

  it('success: each file is hashed, the folder is moved into place and installed.json is written', async () => {
    const f = fakePorts();
    const progress: number[] = [];
    const r = await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true, onProgress: (p) => progress.push(p) });
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    assert.equal(f.log.length, 3);
    const dir = modelDirFor('/data', PIN).replace(/\\/g, '/');
    for (const name of Object.keys(CONTENT)) assert.equal(f.files.get(`${dir}/${name}`), CONTENT[name]);
    assert.ok(![...f.files.keys()].some((k) => k.includes('.partial')), 'no staging left');
    const rec = JSON.parse(f.files.get(join(finderRoot('/data'), 'installed.json').replace(/\\/g, '/'))!);
    assert.equal(rec.id, 'test-model');
    assert.equal(rec.revision, 'rev1');
    assert.equal(rec.files.length, 3);
    assert.equal(rec.at, '2026-10-17T10:00:00.000Z');
    assert.deepEqual(progress, [0, 1 / 3, 2 / 3, 1]);
    assert.ok(readInstalled(f.ports, '/data', PIN));
  });

  it('a hash mismatch stops before the next file, deletes the staging folder and records nothing', async () => {
    const f = fakePorts({ serve: (url) => (url.endsWith('b.wasm') ? 'tampered' : CONTENT[url.split('/').pop()!]!) });
    const r = await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true });
    assert.equal(r.ok, false);
    assert.equal(r.steps.at(-1)?.step, 'hash');
    assert.equal(f.log.length, 2, 'the third file is never requested');
    assert.deepEqual(f.keys(), [], 'staging deleted, no record');
    assert.equal(readInstalled(f.ports, '/data', PIN), null);
  });

  it('a download that throws cleans up and records nothing', async () => {
    const f = fakePorts();
    const real = f.ports.download;
    f.ports.download = async (u, d, o) => { if (u.endsWith('m.onnx')) throw new Error('network down'); return real(u, d, o); };
    const r = await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true });
    assert.equal(r.ok, false);
    assert.ok(/network down/.test(r.steps.at(-1)!.detail));
    assert.deepEqual(f.keys(), []);
  });

  it('a failed update leaves an earlier install in place', async () => {
    const f = fakePorts();
    await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true });
    const before = f.keys();
    const pin2: FinderModelPin = { ...PIN, revision: 'rev2' };
    const f2 = { ...f.ports, download: async () => ({ sha256: 'x'.repeat(64), bytes: 1 }) };
    const r = await getModel(f2, { dataDir: '/data', pin: pin2, approve: async () => true });
    assert.equal(r.ok, false);
    assert.deepEqual(f.keys(), before);
    assert.ok(readInstalled(f.ports, '/data', PIN));
  });

  it('already installed: no card, no download', async () => {
    const f = fakePorts();
    await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true });
    f.log.length = 0;
    let asked = false;
    const r = await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => { asked = true; return true; } });
    assert.equal(r.ok, true);
    assert.equal(asked, false);
    assert.deepEqual(f.log, []);
  });

  it('a pin with a missing or bad hash is refused before any card', async () => {
    const f = fakePorts();
    let asked = false;
    const bad: FinderModelPin = { ...PIN, files: [{ ...PIN.files[0]!, sha256: '' }] };
    const r = await getModel(f.ports, { dataDir: '/data', pin: bad, approve: async () => { asked = true; return true; } });
    assert.equal(r.ok, false);
    assert.equal(asked, false);
    assert.deepEqual(f.log, []);
  });

  it('a pin with an address that is not https is refused', async () => {
    const f = fakePorts();
    const bad: FinderModelPin = { ...PIN, files: [{ ...PIN.files[0]!, url: 'http://cdn.example.com/a.mjs' }] };
    const r = await getModel(f.ports, { dataDir: '/data', pin: bad, approve: async () => true });
    assert.equal(r.ok, false);
    assert.deepEqual(f.log, []);
  });

  it('remove deletes the model, the record, the staging folder and the vector cache', async () => {
    const f = fakePorts();
    await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true });
    f.files.set(join(finderRoot('/data'), 'vectors.json').replace(/\\/g, '/'), '{}');
    f.files.set(join(finderRoot('/data'), 'usage.json').replace(/\\/g, '/'), '{}');
    f.files.set(join(finderRoot('/data'), '.partial', 'x').replace(/\\/g, '/'), 'x');
    removeModel(f.ports, '/data');
    assert.deepEqual(f.keys(), [join(finderRoot('/data'), 'usage.json').replace(/\\/g, '/')], 'only the usage record is left');
    assert.equal(readInstalled(f.ports, '/data', PIN), null);
  });
});

describe('finder model hosts and sizes', () => {
  it('readInstalled does not believe a file whose size differs from the pin', async () => {
    const f = fakePorts();
    await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true });
    assert.ok(readInstalled(f.ports, '/data', PIN));
    const key = f.keys().find((k) => k.endsWith('/m.onnx'))!;
    f.files.set(key, CONTENT['m.onnx']! + 'x');
    assert.equal(readInstalled(f.ports, '/data', PIN), null, 'one byte more');
    f.files.set(key, CONTENT['m.onnx']!.slice(1));
    assert.equal(readInstalled(f.ports, '/data', PIN), null, 'one byte less');
  });

  it('the download is given a host check, and a port that applies it refuses a redirect elsewhere', async () => {
    const f = fakePorts();
    const seen: Array<(u: string) => boolean> = [];
    f.ports.download = async (_url, _dest, o) => {
      if (!o.urlOk) throw new Error('no urlOk was passed');
      seen.push(o.urlOk);
      if (!o.urlOk('https://evil.example/steal.bin')) throw new Error('Refusing to download: the address is not on the expected host.');
      return { sha256: 'x', bytes: 1 };
    };
    const r = await getModel(f.ports, { dataDir: '/data', pin: PIN, approve: async () => true });
    assert.equal(r.ok, false);
    assert.match(r.steps.at(-1)!.detail, /not on the expected host/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!('https://cdn.example.com/a.mjs'), true);
    assert.deepEqual(f.keys(), []);
  });

  it('the real download refuses a redirect to another host, and follows one to an allowed host', async () => {
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const u = String(input);
      asked.push(u);
      if (u.startsWith('https://huggingface.co/')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/model.onnx' } });
      if (u.startsWith('https://cdn.jsdelivr.net/')) return new Response(null, { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/x/file' } });
      return new Response('abc', { status: 200 });
    }) as typeof fetch;
    const dest = join(tmpdir(), `finder-dl-${process.pid}-${Date.now()}.bin`);
    try {
      const dl = createGetBlenderPorts().download as (url: string, dest: string, o: { maxBytes: number; urlOk: (u: string) => boolean }) => Promise<{ sha256: string; bytes: number }>;
      const urlOk = (u: string): boolean => finderHostOk(u, FINDER_MODEL_PIN);
      await assert.rejects(dl('https://huggingface.co/a/b', dest, { maxBytes: 100, urlOk }), /not on the expected host/);
      assert.deepEqual(asked, ['https://huggingface.co/a/b'], 'the other host was never asked');
      asked.length = 0;
      const ok = await dl('https://cdn.jsdelivr.net/a', dest, { maxBytes: 100, urlOk });
      assert.equal(ok.bytes, 3);
      assert.deepEqual(asked, ['https://cdn.jsdelivr.net/a', 'https://us.aws.cdn.hf.co/x/file']);
    } finally { globalThis.fetch = realFetch; rmSync(dest, { force: true }); rmSync(dest + '.part', { force: true }); }
  });

  it('finderHostOk takes the pinned hosts and their subdomains only, over https', () => {
    for (const f of FINDER_MODEL_PIN.files) assert.equal(finderHostOk(f.url), true, f.url);
    for (const ok of ['https://us.aws.cdn.hf.co/a', 'https://eu.aws.cdn.hf.co/a', 'https://huggingface.co/a', 'https://cdn.jsdelivr.net/a']) assert.equal(finderHostOk(ok), true, ok);
    for (const bad of ['https://evil.example/a', 'http://huggingface.co/a', 'https://huggingface.co.evil.example/a', 'https://evilhuggingface.co/a', 'https://hf.co/a', 'https://jsdelivr.net/a', 'ftp://huggingface.co/a', 'not a url']) assert.equal(finderHostOk(bad), false, bad);
  });

  it('a pin with an address off its allowed hosts is refused before any card', async () => {
    const f = fakePorts();
    let asked = false;
    const bad: FinderModelPin = { ...PIN, files: [{ ...PIN.files[0]!, url: 'https://evil.example/a.mjs' }] };
    const r = await getModel(f.ports, { dataDir: '/data', pin: bad, approve: async () => { asked = true; return true; } });
    assert.equal(r.ok, false);
    assert.equal(asked, false);
    assert.deepEqual(f.log, []);
  });
});

describe('the real pin', () => {
  it('has https addresses, 64-char hashes, sizes and a total that adds up', () => {
    let sum = 0;
    for (const f of FINDER_MODEL_PIN.files) {
      assert.match(f.url, /^https:\/\//);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.bytes > 0);
      sum += f.bytes;
    }
    assert.equal(FINDER_MODEL_PIN.approxBytes, sum);
    assert.equal(FINDER_MODEL_PIN.revision, '614241f622f53c4eeff9890bdc4f31cfecc418b3');
    assert.deepEqual(new Set(FINDER_MODEL_PIN.files.map((f) => f.role)), new Set(['runtime', 'tokenizer-lib', 'model', 'tokenizer', 'tokenizer-config']));
  });
});
