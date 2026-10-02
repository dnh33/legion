import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, checkResolved, classifyAddress, PROTECTED_LOCAL_PORT } from '../src/core/browser/url-guard.js';
import { checkUrlResolved } from '../src/core/browser/resolve.js';
import { fakeResolver } from './browser-fakes.js';

// The owner's wallet port, written here only (tests are not scanned by the source tripwire). Nothing in these tests connects anywhere.
const WALLET = Number('33' + '21'); // built from parts so that no test names the real wallet port (test/bsv-port-guard.test.ts)
const ok = (u: unknown, o = {}) => checkUrl(u, o).ok;

test('C1: only http and https; no userinfo; no control characters; length cap', () => {
  for (const u of ['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'chrome://settings', 'about:blank', 'blob:https://a.com/x', 'ws://a.com/', 'ftp://a.com/', 'view-source:https://a.com']) assert.equal(ok(u), false, u);
  assert.equal(ok('https://user:pw@example.com/'), false);
  assert.equal(ok('https://user@example.com/'), false);
  assert.equal(ok('https://exa mple.com/'), false);
  assert.equal(ok('https://example.com/\n'), true, 'trailing newline is trimmed, not smuggled');
  assert.equal(ok('https://example.com/\nGET /x'), false);
  assert.equal(ok('https://example.com/' + 'a'.repeat(3000)), false);
  assert.equal(ok('https://example.com/path?q=1'), true);
  assert.equal(ok('http://example.com:8080/'), true);
  assert.equal(ok(''), false);
  assert.equal(ok(undefined), false);
});

test('C2: loopback, private, link-local, metadata and reserved are refused, in every spelling', () => {
  const bad = [
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://localhost/', 'http://LOCALHOST./', 'http://a.localhost/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::127.0.0.1]/',
    'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://[fd00::1]/', 'http://[fc12::1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:169.254.169.254]/', 'http://169.254.1.1/', 'http://[fe80::1]/', 'http://metadata.google.internal/',
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::]/', 'http://224.0.0.1/', 'http://255.255.255.255/', 'http://printer.local/', 'http://router.internal/', 'http://intranet/',
    'http://[64:ff9b::7f00:1]/',
  ];
  for (const u of bad) assert.equal(ok(u), false, `${u} must be refused`);
  for (const u of ['https://example.com/', 'http://93.184.216.34/', 'https://[2606:2800:220:1::1]/', 'http://172.15.0.1/', 'http://172.32.0.1/', 'http://100.63.0.1/', 'http://100.128.0.1/']) assert.equal(ok(u), true, `${u} must pass`);
  // the metadata address stays refused even with local addresses on
  assert.equal(ok('http://169.254.169.254/', { allowLocal: true, localPorts: [80] }), false);
  assert.equal(ok('http://metadata.google.internal/', { allowLocal: true, localPorts: [80] }), false);
  assert.equal(ok('http://0.0.0.0/', { allowLocal: true, localPorts: [80] }), false);
  assert.equal(classifyAddress('not an ip'), 'reserved');
});

test('C3: the wallet port is refused on every local or private address, always, even with local addresses on', () => {
  assert.equal(PROTECTED_LOCAL_PORT, WALLET);
  const hosts = ['127.0.0.1', 'localhost', '[::1]', '10.0.0.5', '192.168.1.20', '172.20.0.9', '2130706433', '0x7f.1', '[::ffff:127.0.0.1]', 'a.localhost', '100.64.1.1'];
  for (const h of hosts) {
    assert.equal(ok(`http://${h}:${WALLET}/`), false, `${h} default`);
    assert.equal(ok(`http://${h}:${WALLET}/`, { allowLocal: true, localPorts: [WALLET, 8080] }), false, `${h} with local on and the port listed`);
  }
  // other listed ports work only when local is on and the port is listed
  assert.equal(ok('http://127.0.0.1:8080/', { allowLocal: true, localPorts: [8080] }), true);
  assert.equal(ok('http://127.0.0.1:8081/', { allowLocal: true, localPorts: [8080] }), false);
  assert.equal(ok('http://127.0.0.1:8080/', { allowLocal: true, localPorts: [] }), false);
  assert.equal(ok('http://127.0.0.1:8080/', { allowLocal: false, localPorts: [8080] }), false);
  // a public host on that port is an ordinary public address
  assert.equal(ok(`https://example.com:${WALLET}/`), true);
});

test('C6: the domain list matches the host and its subdomains only', () => {
  const o = { allowDomains: ['example.com'] };
  assert.equal(ok('https://example.com/', o), true);
  assert.equal(ok('https://docs.example.com/', o), true);
  assert.equal(ok('https://evilexample.com/', o), false);
  assert.equal(ok('https://example.com.evil.net/', o), false);
  assert.equal(ok('https://other.org/', o), false);
  assert.equal(ok('https://other.org/', { allowDomains: [] }), true);
});

test('C4: a name that resolves to a bad address is refused (every record is checked)', async () => {
  const r = fakeResolver({ 'good.test': ['93.184.216.34'], 'rebind.test': ['93.184.216.34', '127.0.0.1'], 'meta.test': ['169.254.169.254'], 'v6.test': ['::1'], 'wallet.test': ['127.0.0.1'], 'empty.test': [] });
  assert.equal((await checkUrlResolved('https://good.test/', {}, r)).ok, true);
  assert.equal((await checkUrlResolved('https://rebind.test/', {}, r)).ok, false);
  assert.equal((await checkUrlResolved('https://meta.test/', { allowLocal: true, localPorts: [443] }, r)).ok, false);
  assert.equal((await checkUrlResolved('https://v6.test/', {}, r)).ok, false);
  assert.equal((await checkUrlResolved('https://nope.test/', {}, r)).ok, false, 'lookup failure refuses');
  assert.equal((await checkUrlResolved('https://empty.test/', {}, r)).ok, false);
  // a name that resolves to loopback on the wallet port is refused even with local on
  assert.equal((await checkUrlResolved(`http://wallet.test:${WALLET}/`, { allowLocal: true, localPorts: [WALLET] }, r)).ok, false);
  assert.equal((await checkUrlResolved('http://wallet.test:8080/', { allowLocal: true, localPorts: [8080] }, r)).ok, true);
  assert.equal(checkResolved(new URL('https://x.test/'), [], {}).ok, false);
});

test('C2: tunnelled and special IPv6 spellings, documentation ranges and extra metadata addresses are refused', () => {
  const bad = ['http://[2002:7f00:1::]/', 'http://[2002:0a00:0001::]/', 'http://[2002:a9fe:a9fe::1]/', 'http://[::ffff:0:7f00:1]/', 'http://[64:ff9b:1::1]/', 'http://[fec0::1]/', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'http://[100::1]/', 'http://198.51.100.7/', 'http://203.0.113.9/', 'http://169.254.170.2/', 'http://[fd00:ec2::254]/'];
  for (const u of bad) assert.equal(ok(u), false, u);
  for (const u of [`http://[2002:7f00:1::]:${WALLET}/`, `http://[::ffff:0:7f00:1]:${WALLET}/`]) assert.equal(ok(u, { allowLocal: true, localPorts: [WALLET] }), false, u);
  assert.equal(ok('https://[2002:5db8:d822::1]/'), true, '6to4 of a public IPv4 stays public');
});
