import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { browserChange, parseBrowserChange } from '../src/electron/browser-ipc.js';
import type { BrowserIpcDeps } from '../src/electron/browser-ipc.js';

function deps(over: { confirm?: boolean; coreDown?: boolean; status?: number } = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown; native?: boolean }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const d: BrowserIpcDeps = {
    async call(method, route, body, native) {
      calls.push({ method, route, body, native });
      if (over.coreDown) return undefined;
      if (method === 'GET') return { status: 200, json: { enabled: true } };
      return { status: over.status ?? 200, json: over.status && over.status !== 200 ? { error: 'refused by core' } : { ok: true } };
    },
    async confirm(o) { dialogs.push(o); return over.confirm !== false; },
  };
  return { d, calls, dialogs };
}

test('N1: the window\'s request is parsed strictly', () => {
  assert.equal(parseBrowserChange(null), undefined);
  assert.equal(parseBrowserChange({ kind: 'program', binaryPath: 'x' }), undefined, 'there is no program or launcher choice any more');
  assert.equal(parseBrowserChange({ kind: 'hash', sha256: 'a'.repeat(64) }), undefined, 'there is no download hash any more');
  assert.equal(parseBrowserChange({ kind: 'chromium', path: 'a\nb' }), undefined);
  assert.equal(parseBrowserChange({ kind: 'chromium', path: 'x'.repeat(501) }), undefined);
  assert.equal(parseBrowserChange({ kind: 'chromium', path: '' }), undefined);
  assert.equal(parseBrowserChange({ kind: 'chromium' }), undefined);
  assert.equal(parseBrowserChange({ kind: 'local', allow: 'yes' }), undefined);
  assert.equal(parseBrowserChange({ kind: 'local', allow: true, ports: [0] }), undefined);
  assert.equal(parseBrowserChange({ kind: 'local', allow: true, ports: [70000] }), undefined);
  assert.equal(parseBrowserChange({ kind: 'wipe' }), undefined);
  assert.deepEqual(parseBrowserChange({ kind: 'chromium', path: null }), { kind: 'chromium', path: null });
});

test('N2: Cancel changes nothing: the core is never asked to write', async () => {
  for (const change of [{ kind: 'chromium', path: 'C:\\Program Files\\X\\chrome.exe' }, { kind: 'local', allow: true, ports: [8080] }]) {
    const { d, calls } = deps({ confirm: false });
    const r = await browserChange(change, d);
    assert.equal(r.ok, false); assert.equal(r.cancelled, true);
    assert.equal(calls.some((c) => c.method === 'POST'), false, JSON.stringify(change));
  }
});

test('N4: allow-local names the ports, says it lasts until restart and keeps the protected port blocked, without writing that number; turning it off needs no scary text', async () => {
  const { d, dialogs, calls } = deps();
  assert.equal((await browserChange({ kind: 'local', allow: true, ports: [8080, 3000] }, d)).ok, true);
  assert.match(dialogs[0]!.detail, /8080, 3000/); assert.match(dialogs[0]!.detail, /until Legion restarts/); assert.match(dialogs[0]!.detail, /wallet stays blocked/);
  assert.deepEqual(calls.find((c) => c.method === 'POST')!.body, { allow: true, ports: [8080, 3000] });
  assert.equal(calls.find((c) => c.method === 'POST')!.route, '/api/browser/local');
  assert.equal(calls.filter((c) => c.native).length, 1, 'only the write carries the native secret');
  const off = deps();
  assert.equal((await browserChange({ kind: 'local', allow: false }, off.d)).ok, true);
  assert.deepEqual(off.calls.find((c) => c.method === 'POST')!.body, { allow: false, ports: [] });
});

test('N5: failure paths: no core, a core refusal, one dialog at a time', async () => {
  assert.equal((await browserChange({ kind: 'chromium', path: 'x' }, deps({ coreDown: true }).d)).ok, false);
  assert.match((await browserChange({ kind: 'chromium', path: 'x' }, deps({ status: 403 }).d)).error ?? '', /refused by core/);
  let release: (v: boolean) => void = () => undefined;
  const slow = deps(); slow.d.confirm = () => new Promise<boolean>((r) => { release = r; });
  const first = browserChange({ kind: 'chromium', path: 'x' }, slow.d);
  await new Promise((r) => setTimeout(r, 20));
  const second = await browserChange({ kind: 'chromium', path: 'y' }, deps().d);
  assert.match(second.error ?? '', /already open/);
  release(false); await first;
});

test('N6: the window never holds the native secret: main.ts registers the handler, checks the sender, and the preload only forwards', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const main = readFileSync(root + 'src/electron/main.ts', 'utf8');
  const i = main.indexOf("'legion:browser-change'");
  assert.ok(i > 0);
  const block = main.slice(i, i + 700);
  assert.match(block, /trustedSender\(frameUrl, uiUrl\)/); assert.match(block, /sender !== win\.webContents/); assert.match(block, /browserChange\(raw, \{ call: ownCoreCall, confirm: makeConfirm\(dialog/);
  const pre = readFileSync(root + 'src/electron/preload.cjs', 'utf8');
  assert.match(pre, /browserChange\(change\) \{\s*return ipcRenderer\.invoke\('legion:browser-change', change\);/);
  assert.doesNotMatch(pre, /nativeSecret|X-Legion-Native/i);
});

test('N7: choosing the Edge/Chrome path goes through the same native dialog (and clearing it too); the path is parsed strictly', async () => {
  assert.equal(parseBrowserChange({ kind: 'chromium', path: 'a\nb' }), undefined);
  assert.equal(parseBrowserChange({ kind: 'chromium', path: '' }), undefined);
  assert.equal(parseBrowserChange({ kind: 'chromium' }), undefined);
  assert.deepEqual(parseBrowserChange({ kind: 'chromium', path: null }), { kind: 'chromium', path: null });
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const { d, calls, dialogs } = deps();
  assert.equal((await browserChange({ kind: 'chromium', path: edge }, d)).ok, true);
  assert.match(dialogs[0]!.detail, /Program Files \(x86\)/); assert.match(dialogs[0]!.detail, /headless/); assert.match(dialogs[0]!.detail, /your user rights/);
  const post = calls.find((c) => c.method === 'POST')!;
  assert.equal(post.route, '/api/browser/config'); assert.equal(post.native, true); assert.deepEqual(post.body, { chromiumPath: edge });
  const off = deps();
  assert.equal((await browserChange({ kind: 'chromium', path: null }, off.d)).ok, true);
  assert.deepEqual(off.calls.find((c) => c.method === 'POST')!.body, { chromiumPath: null });
  const cancel = deps({ confirm: false });
  assert.equal((await browserChange({ kind: 'chromium', path: edge }, cancel.d)).cancelled, true);
  assert.equal(cancel.calls.some((c) => c.method === 'POST'), false);
});
