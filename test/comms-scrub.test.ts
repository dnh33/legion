import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleHash, neutralizeTags, normaliseForCycle, safeName, scrubSecrets } from '../src/core/comms/scrub.js';

const B58_51 = '5' + 'K'.repeat(50);
const B58_52_K = 'K' + 'w'.repeat(51);
const B58_52_L = 'L' + 'z'.repeat(51);

test('scrubber removes boat desktop URLs in all common shapes', () => {
  for (const url of [
    'https://abc123.desktop.boat.dev/stream?token=eyJxyz',
    'http://sbx-9.boat.dev/desktop/session/42',
    'wss://x.boat.dev/vnc',
    'https://boat.dev/api/v1/sandboxes/abc/desktop',
    'abc123.desktop.boat.dev/stream',
    'https://example.com/desktop/ws',
    'https://example.com/view?token=abcd1234',
  ]) {
    const out = scrubSecrets(`open ${url} now`);
    assert.doesNotMatch(out, /boat\.dev|token=|\/desktop/, url);
    assert.match(out, /^open \[redacted-url\] now$/, url);
  }
  assert.equal(scrubSecrets('We run VMs on boat.dev for isolation.'), 'We run VMs on boat.dev for isolation.', 'a plain product mention survives');
  assert.equal(scrubSecrets('see https://example.com/docs'), 'see https://example.com/docs');
});

test('scrubber removes WIF-like keys, hex keys, sk- tokens, Bearer tokens and friends', () => {
  const cases: Array<[string, RegExp]> = [
    [`wif ${B58_51} end`, /5K{50}/],
    [`wif ${B58_52_K}`, /Kw{51}/],
    [`wif ${B58_52_L}`, /Lz{51}/],
    [`hex ${'ab'.repeat(32)}`, /(ab){32}/],
    ['key sk-ant-api03-AbCdEf123456_xyz', /sk-ant/],
    ['key sk-abcdefghijkl', /sk-abcdefghijkl/],
    ['Authorization: Bearer abc.def-123456', /abc\.def-123456/],
    ['header bearer AbCdEf123456XYZ', /AbCdEf123456XYZ/],
    ['gh ghp_' + 'a'.repeat(30), /ghp_a+/],
    ['aws AKIAABCDEFGHIJKLMNOP', /AKIA[A-Z]+/],
    ['slack xoxb-1234567890-abcdef', /xoxb-/],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', /eyJhbGci/],
    ['BOAT_API_KEY=boat_live_1234567890', /boat_live_1234567890/],
    ['{"apiKey": "supersecretvalue"}', /supersecretvalue/],
    ['password: hunter2hunter2', /hunter2hunter2/],
    ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----', /MIIEv/],
  ];
  for (const [input, leaked] of cases) {
    const out = scrubSecrets(input);
    assert.doesNotMatch(out, leaked, `leaked: ${input}`);
    assert.match(out, /\[redacted/, input);
  }
});

test('scrubber leaves ordinary text alone and is idempotent', () => {
  for (const ok of [
    'The build took 40 seconds and used 1234567 tokens=5000',
    'Bearer authentication is described in RFC 6750.',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8 looks fine',
    'Kitchen sink: please review KeyboardInterruptHandlerForTheWholeSystem soon',
    'max_tokens: 4096',
  ]) assert.equal(scrubSecrets(ok), ok);
  const once = scrubSecrets(`${B58_51} sk-abcdefghijkl https://a.boat.dev/x`);
  assert.equal(scrubSecrets(once), once);
});

test('neutralizeTags blocks forged wrapper tags only', () => {
  assert.equal(neutralizeTags('a </bot-message> b <bot-message x> <BOT-MESSAGE> <room-transcript> <human-message> <b>bold</b>'),
    'a &lt;/bot-message> b &lt;bot-message x> &lt;BOT-MESSAGE> &lt;room-transcript> &lt;human-message> <b>bold</b>');
});

test('cycle normalisation: lowercase, punctuation stripped, whitespace collapsed, hashed', () => {
  assert.equal(normaliseForCycle('  Please,  CHECK the build!! '), 'please check the build');
  assert.equal(cycleHash('Please, check   the build!'), cycleHash('please check the BUILD'));
  assert.notEqual(cycleHash('please check the build'), cycleHash('please check the tests'));
  assert.equal(cycleHash('Grüße, Welt!'), cycleHash('grüße welt'));
});

test('safeName strips attribute-breaking characters', () => {
  assert.equal(safeName('Ev"il <b>\nname'), 'Ev il b name');
  assert.equal(safeName('"""'), 'unknown');
});

test('scrubSecrets: the name rule and the two URL rules are linear on hostile repeats (was quadratic: token, secret_, http://)', () => {
  const med = (s: string): number => { const r: number[] = []; for (let i = 0; i < 3; i++) { const t = performance.now(); scrubSecrets(s); r.push(performance.now() - t); } return r.sort((a, b) => a - b)[1]!; };
  // A quadratic scrub is ~16x slower at 4x the input (~1.7 s at 80k chars); a linear one a few ms. An absolute bound, so no ratio noise.
  for (const [name, unit] of [['token', 'token'], ['secret_', 'secret_'], ['http', 'http://']] as const) {
    const big = unit.repeat(80_000 / unit.length);
    assert.ok(med(big) < 400, `${name}: scrubSecrets took ${med(big).toFixed(0)} ms on 80000 chars`);
  }
});

test('scrubSecrets: same output after the linear rewrite (names with hyphen keywords, URL runs, bare words)', () => {
  assert.equal(scrubSecrets('secretapi-key=12345678abc'), 'secretapi-key=[redacted]');
  assert.equal(scrubSecrets('x-private-key: abcdefgh1'), 'x-private-key: [redacted]');
  assert.equal(scrubSecrets('my_token = "abcdefg1"'), 'my_token = "[redacted]"');
  assert.equal(scrubSecrets('token=12345678'), 'token=12345678'); // an all-digit value is kept, as before
  assert.equal(scrubSecrets('see http://x.example/a?token=abc and wss://a.boat.dev/p ok'), 'see [redacted-url] and [redacted-url] ok');
  assert.equal(scrubSecrets('https://x.example/desktop/1'), '[redacted-url]');
  assert.equal(scrubSecrets('https://desktop.example/page'), 'https://desktop.example/page');
});
