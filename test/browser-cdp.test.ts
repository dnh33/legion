import test from 'node:test';
import assert from 'node:assert/strict';
import { CDP_METHODS, CdpError, connectCdp, isLoopbackWsUrl } from '../src/core/browser/cdp.js';
import { startFakeCdp } from './browser-fakes.js';

test('C13: only ws://127.0.0.1:<port> is accepted; other hosts, spellings and schemes are refused before any connect', async () => {
  for (const u of ['ws://127.0.0.1:9222', 'ws://127.0.0.1:9222/devtools/browser/abc-1']) assert.equal(isLoopbackWsUrl(u), true, u);
  for (const u of ['ws://localhost:9222', 'ws://10.0.0.1:9222', 'ws://127.0.0.1.evil.com:9222', 'ws://127.0.0.1@evil.com:9222', 'wss://127.0.0.1:9222', 'http://127.0.0.1:9222', 'ws://[::1]:9222', 'ws://127.0.0.2:9222', 'ws://127.0.0.1:99999', 'ws://127.0.0.1', 'ws://127.0.0.1:9222/../x', 'ws://example.com:9222']) assert.equal(isLoopbackWsUrl(u), false, u);
  await assert.rejects(connectCdp('ws://example.com:9222'), (e: Error) => e instanceof CdpError && /127\.0\.0\.1/.test(e.message));
});

test('C13: a command that is not on the list is never sent', async () => {
  const fake = await startFakeCdp({ pages: {} });
  const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`);
  try {
    for (const m of ['Page.setDownloadBehavior', 'Browser.close', 'Browser.setPermission', 'Browser.grantPermissions', 'Network.setCookies', 'Network.getAllCookies', 'DOM.setFileInputFiles', 'Page.captureScreenshot', 'Emulation.setGeolocationOverride', 'Input.dispatchKeyEvent', 'Storage.clearDataForOrigin', 'Page.printToPDF']) {
      assert.ok(!CDP_METHODS.has(m), m);
      await assert.rejects(cdp.send(m), /does not send/, m);
    }
    assert.deepEqual(fake.sent, []);
    assert.deepEqual(await cdp.send('Target.getTargets'), { targetInfos: [] });
  } finally { cdp.close(); await fake.close(); }
});

test('C13: an oversize message closes the socket; a malformed one closes it; a silent browser times out; an error reply is an error', async () => {
  let fake = await startFakeCdp({ pages: { 'u': {} }, bigReply: 5000 });
  let cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`, { maxMessageBytes: 1000 });
  await assert.rejects(cdp.send('Runtime.evaluate', { expression: '1' }), /size limit|closed/);
  assert.equal(cdp.closed, true); await fake.close();

  fake = await startFakeCdp({ pages: {}, garbleFor: 'Target.getTargets' });
  cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`);
  await assert.rejects(cdp.send('Target.getTargets'), /malformed|closed/);
  assert.equal(cdp.closed, true); await fake.close();

  fake = await startFakeCdp({ pages: {}, silentFor: 'Target.getTargets', errorFor: { 'Page.enable': 'nope' } });
  cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`);
  const t0 = Date.now();
  await assert.rejects(cdp.send('Target.getTargets', {}, { timeoutMs: 150 }), /did not answer/);
  assert.ok(Date.now() - t0 < 2000);
  await assert.rejects(cdp.send('Page.enable'), /nope/);
  assert.equal(cdp.closed, false);
  cdp.close(); await fake.close();
});

test('connect failure and a server that goes away are clear errors', async () => {
  const fake = await startFakeCdp({ pages: {} });
  const port = fake.port;
  const cdp = await connectCdp(`ws://127.0.0.1:${port}`);
  let closed = false; cdp.onClose(() => { closed = true; });
  await fake.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed, true);
  await assert.rejects(cdp.send('Target.getTargets'), /closed/);
  await assert.rejects(connectCdp(`ws://127.0.0.1:${port}`, { connectTimeoutMs: 500 }), CdpError);
});
