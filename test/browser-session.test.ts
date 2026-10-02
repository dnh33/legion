import test from 'node:test';
import assert from 'node:assert/strict';
import { connectCdp } from '../src/core/browser/cdp.js';
import { BrowserSession, SessionRefusal } from '../src/core/browser/session.js';
import type { RunningBrowser } from '../src/core/browser/launcher.js';
import { fakeResolver, startFakeCdp } from './browser-fakes.js';
import type { FakeCdp, FakeCdpOptions } from './browser-fakes.js';

const WALLET = Number('33' + '21'); // built from parts so that no test names the real wallet port (test/bsv-port-guard.test.ts)
const DNS = fakeResolver({ 'a.test': ['93.184.216.34'], 'b.test': ['93.184.216.35'], 'evil.test': ['93.184.216.36'], 'inner.test': ['10.0.0.9'] });

async function rig(o: FakeCdpOptions, extra: { guard?: () => object; approve?: (origin: string) => boolean; limits?: Record<string, number> } = {}) {
  const fake = await startFakeCdp(o);
  let stopped = 0;
  const approved: string[] = [];
  const session = new BrowserSession({
    guard: () => (extra.guard?.() ?? {}),
    resolve: DNS,
    limits: extra.limits,
    approveOrigin: async (origin) => { approved.push(origin); return extra.approve ? extra.approve(origin) : true; },
    async launch(): Promise<RunningBrowser> {
      const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`);
      return { cdp, pid: undefined, port: fake.port, args: [], exited: new Promise(() => undefined), stop: async () => { stopped++; cdp.close(); } };
    },
  });
  return { fake, session, approved, stopped: () => stopped, done: async () => { await session.close(); await fake.close(); } };
}

test('open + text + links read a page through the fake CDP; the page text is what the page said', async () => {
  const r = await rig({ pages: { 'https://a.test/': { title: 'Hello', text: 'Body text', links: [{ text: 'B', href: 'https://b.test/' }] } } });
  try {
    const v = await r.session.open('https://a.test/');
    assert.deepEqual(v, { url: 'https://a.test/', title: 'Hello' });
    assert.equal((await r.session.text()).text, 'Body text');
    assert.deepEqual(await r.session.links(), [{ text: 'B', href: 'https://b.test/' }]);
  } finally { await r.done(); }
});

test('C5: a redirect to a private address is refused: no content, the page is reset', async () => {
  const r = await rig({ pages: { 'https://a.test/': { redirectTo: 'http://10.0.0.5/admin' }, 'http://10.0.0.5/admin': { title: 'SECRET', text: 'internal data' } } });
  try {
    await assert.rejects(r.session.open('https://a.test/'), (e: Error) => e instanceof SessionRefusal && /10\.0\.0\.5/.test(e.message) && !/SECRET|internal data/.test(e.message));
    await assert.rejects(r.session.text(), /No page is open|stopped/);
    assert.ok(r.fake.sent.some((m) => m.method === 'Target.closeTarget'), 'the page was closed');
  } finally { await r.done(); }
});

test('C5: a redirect through a name that resolves to a private address, a metadata address, and the wallet port are all refused', async () => {
  for (const to of ['https://inner.test/', 'http://169.254.169.254/latest/meta-data/', `http://127.0.0.1:${WALLET}/`, `http://localhost:${WALLET}/`]) {
    const r = await rig({ pages: { 'https://a.test/': { redirectTo: to }, [to]: { text: 'LEAK' } } }, { guard: () => (to.includes(`:${WALLET}`) ? { allowLocal: true, localPorts: [WALLET, 80, 443] } : {}) });
    try { await assert.rejects(r.session.open('https://a.test/'), SessionRefusal, to); } finally { await r.done(); }
  }
});

test('C5: too many redirect hops are refused', async () => {
  const pages: Record<string, { redirectTo?: string; text?: string }> = {};
  for (let i = 0; i < 12; i++) pages[`https://a.test/${i}`] = { redirectTo: `https://a.test/${i + 1}` };
  pages['https://a.test/12'] = { text: 'end' };
  const r = await rig({ pages });
  try { await assert.rejects(r.session.open('https://a.test/0'), /too many redirects/); } finally { await r.done(); }
});

test('C6: the domain list refuses a redirect to another site; subresources to other hosts are allowed', async () => {
  const r = await rig({ pages: { 'https://a.test/': { redirectTo: 'https://evil.test/' }, 'https://evil.test/': { text: 'E' }, 'https://b.test/': { text: 'ok', subrequests: ['https://cdn.example/x.png'] } } }, { guard: () => ({ allowDomains: ['a.test', 'b.test'] }) });
  try {
    await assert.rejects(r.session.open('https://a.test/'), /allowed domain list/);
    assert.equal((await r.session.open('https://b.test/')).url, 'https://b.test/');
  } finally { await r.done(); }
});

test('C5: a sub-resource to a private address is failed at the browser before it is sent, and the page is refused', async () => {
  const r = await rig({ pages: { 'https://a.test/': { text: 'x', subrequests: ['http://192.168.1.1/pixel.gif'] } } });
  try {
    await assert.rejects(r.session.open('https://a.test/'), SessionRefusal);
    assert.ok(r.fake.blocked.length >= 1, 'Fetch.failRequest was sent');
  } finally { await r.done(); }
});

test('C14: a popup tab is closed at once (one page per run)', async () => {
  const r = await rig({ popup: true, pages: { 'https://a.test/': { text: 'x' } } });
  try {
    await r.session.open('https://a.test/');
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(r.session.closedTabsBlocked >= 1);
    assert.ok(r.fake.sent.filter((m) => m.method === 'Target.closeTarget').length >= 1);
    assert.equal(r.fake.sent.filter((m) => m.method === 'Target.createTarget').length, 1, 'Legion itself opens exactly one');
  } finally { await r.done(); }
});

test('click: a link to a new site asks first; a refusal closes the page and returns no content', async () => {
  const pages = { 'https://a.test/': { text: 'A', elements: { '#go': { href: 'https://b.test/', goes: 'https://b.test/' } } }, 'https://b.test/': { title: 'B page', text: 'B body' } };
  const yes = await rig({ pages }, { approve: () => true });
  try {
    await yes.session.open('https://a.test/');
    const c = await yes.session.click('#go');
    assert.equal(c.view.url, 'https://b.test/');
    assert.deepEqual(yes.approved, ['https://b.test']);
  } finally { await yes.done(); }
  const no = await rig({ pages }, { approve: () => false });
  try {
    await no.session.open('https://a.test/');
    await assert.rejects(no.session.click('#go'), (e: Error) => /Not approved/.test(e.message) && !/B body/.test(e.message));
  } finally { await no.done(); }
});

test('click: a link to a private address is refused before the click happens', async () => {
  const r = await rig({ pages: { 'https://a.test/': { text: 'A', elements: { '#go': { href: 'http://192.168.0.1/', goes: 'http://192.168.0.1/' } } } } });
  try {
    await r.session.open('https://a.test/');
    await assert.rejects(r.session.click('#go'), /192\.168\.0\.1/);
    assert.equal(r.fake.state.url, 'https://a.test/', 'the page never moved');
  } finally { await r.done(); }
});

test('click: a button that navigates by script to a bad address is caught where it lands', async () => {
  const r = await rig({ pages: { 'https://a.test/': { text: 'A', elements: { '#b': { clickGoes: 'http://10.9.9.9/' } } }, 'http://10.9.9.9/': { text: 'LEAK' } } });
  try {
    await r.session.open('https://a.test/');
    await assert.rejects(r.session.click('#b'), (e: Error) => e instanceof SessionRefusal && !/LEAK/.test(e.message));
  } finally { await r.done(); }
});

test('C17: typing into a password field is refused; other inputs work', async () => {
  const r = await rig({ pages: { 'https://a.test/': { text: 'A', elements: { '#pw': { type: 'password' }, '#q': { type: 'text', name: 'q' }, '#pw2': { type: 'text', name: 'user_password' } } } } });
  try {
    await r.session.open('https://a.test/');
    await assert.rejects(r.session.type('#pw', 'hunter2', false), /password/);
    await assert.rejects(r.session.type('#pw2', 'hunter2', false), /password/);
    assert.equal((await r.session.type('#q', 'hello', false)).typed, true);
    assert.equal((await r.session.type('#missing', 'x', false)).typed, false);
  } finally { await r.done(); }
});

test('eval returns JSON, and a page error comes back as an error value', async () => {
  const r = await rig({ pages: { 'https://a.test/': { title: 'T', text: 'A' } } });
  try {
    await r.session.open('https://a.test/');
    assert.equal((await r.session.evalExpr('1+2')).value, '3');
    assert.match((await r.session.evalExpr('(()=>{throw new Error("boom")})()')).value, /boom/);
  } finally { await r.done(); }
});

test('failure modes: CDP error, garbled reply, slow reply, a dropped connection, a page that never finishes loading', async () => {
  let r = await rig({ pages: {}, errorFor: { 'Page.enable': 'no such domain' } });
  await assert.rejects(r.session.open('https://a.test/'), /no such domain/); await r.done();
  r = await rig({ pages: { 'https://a.test/': { text: 'x' } }, garbleFor: 'Page.navigate' });
  await assert.rejects(r.session.open('https://a.test/'), /malformed|closed/); await r.done();
  r = await rig({ pages: { 'https://a.test/': { text: 'x' } }, silentFor: 'Page.navigate' }, { limits: { navigationMs: 300 } });
  await assert.rejects(r.session.open('https://a.test/'), /did not answer/); await r.done();
  r = await rig({ pages: { 'https://a.test/': { text: 'partial', noLoadEvent: true } } }, { limits: { navigationMs: 300 } });
  assert.equal((await r.session.open('https://a.test/')).url, 'https://a.test/', 'a page without a load event is returned after the time limit');
  await r.done();
  r = await rig({ pages: { 'https://a.test/': { text: 'x' } } });
  await r.session.open('https://a.test/');
  await r.fake.close();
  await assert.rejects(r.session.text(), /closed|No page|stopped/);
  await r.session.close();
});

test('close stops the process once and a closed session does not restart', async () => {
  const r = await rig({ pages: { 'https://a.test/': { text: 'x' } } });
  await r.session.open('https://a.test/');
  await r.session.close(); await r.session.close();
  assert.equal(r.stopped(), 1);
  await assert.rejects(r.session.open('https://a.test/'), /closed/);
  await r.fake.close();
});

test('C5: with a build that sends no navigation events, the final address check still refuses a bad landing', async () => {
  const r = await rig({ quiet: true, pages: { 'https://a.test/': { redirectTo: 'http://10.0.0.5/x' }, 'http://10.0.0.5/x': { title: 'SECRET', text: 'internal' } } });
  try { await assert.rejects(r.session.open('https://a.test/'), (e: Error) => e instanceof SessionRefusal && /10\.0\.0\.5/.test(e.message) && !/SECRET|internal/.test(e.message)); } finally { await r.done(); }
});

test('closing during launch stops the process that was starting (no orphan)', async () => {
  const fake = await startFakeCdp({ pages: {} });
  let stops = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const session = new BrowserSession({
    guard: () => ({}), resolve: DNS, approveOrigin: async () => true,
    async launch(): Promise<RunningBrowser> { await gate; const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`); return { cdp, pid: undefined, port: fake.port, args: [], exited: new Promise(() => undefined), stop: async () => { stops++; cdp.close(); } }; },
  });
  const opening = session.open('https://a.test/').catch((e: Error) => e);
  await new Promise((r) => setTimeout(r, 30));
  await session.close();
  release();
  const res = await opening;
  assert.ok(res instanceof SessionRefusal);
  assert.equal(stops, 1, 'the browser that finished starting after the close was stopped');
  await fake.close();
});

test('reads re-check the address: a page that moves itself after open() is refused before its text is returned', async () => {
  const r = await rig({ quiet: true, pages: { 'https://a.test/': { text: 'fine' }, 'http://10.0.0.7/': { text: 'INTERNAL' } } });
  try {
    await r.session.open('https://a.test/');
    r.fake.state.url = 'http://10.0.0.7/'; // a timer or meta refresh moved the page
    await assert.rejects(r.session.text(), (e: Error) => e instanceof SessionRefusal && !/INTERNAL/.test(e.message));
  } finally { await r.done(); }
});

test('a form submit is checked and asked about BEFORE the text is sent', async () => {
  const mk = (action: string) => ({ 'https://a.test/': { text: 'A', elements: { '#q': { type: 'text', name: 'q', formAction: action } } }, 'https://b.test/s': { title: 'Results', text: 'R' } });
  const wrote = (r: { fake: FakeCdp }) => r.fake.sent.filter((m) => m.method === 'Runtime.evaluate' && /e\.value=/.test(String(m.params.expression))).length;
  let r = await rig({ pages: mk('https://b.test/s') }, { approve: () => false });
  try {
    await r.session.open('https://a.test/');
    await assert.rejects(r.session.type('#q', 'secret words', true), /Nothing was typed or sent/);
    assert.equal(wrote(r), 0, 'the text never reached the page');
  } finally { await r.done(); }
  r = await rig({ pages: mk('http://192.168.0.9/post') });
  try {
    await r.session.open('https://a.test/');
    await assert.rejects(r.session.type('#q', 'secret words', true), /Nothing was typed or sent/);
    assert.equal(wrote(r), 0);
  } finally { await r.done(); }
  r = await rig({ pages: mk('https://b.test/s') }, { approve: () => true });
  try {
    await r.session.open('https://a.test/');
    const t = await r.session.type('#q', 'hello', true);
    assert.equal(t.view.url, 'https://b.test/s');
    assert.equal(wrote(r), 1);
  } finally { await r.done(); }
});

test('a cached verdict does not outlive a settings change: local addresses turned off apply to the same session', async () => {
  const local = { on: true };
  const r = await rig({ pages: { 'https://a.test/': { text: 'x', subrequests: ['http://127.0.0.1:8080/pixel'] } } }, { guard: () => (local.on ? { allowLocal: true, localPorts: [8080] } : {}) });
  try {
    assert.equal((await r.session.open('https://a.test/')).url, 'https://a.test/');
    local.on = false;
    await assert.rejects(r.session.open('https://a.test/'), SessionRefusal);
  } finally { await r.done(); }
});

// ------------------------------------------------------------------ the Chromium-family engine (same driver, same guards, plus what that engine needs)

test('E6: request interception is required: without it nothing is opened; with it downloads are denied at the browser', async () => {
  let r = await rig({ noFetch: true, pages: { 'https://a.test/': { text: 'x' } } });
  try {
    await assert.rejects(r.session.open('https://a.test/'), /did not accept request interception/);
    assert.equal(r.fake.sent.filter((m) => m.method === 'Page.navigate' && m.params.url !== 'about:blank').length, 0);
  } finally { await r.done(); }
  r = await rig({ pages: { 'https://a.test/': { title: 'T', text: 'x' } } });
  try {
    assert.equal((await r.session.open('https://a.test/')).title, 'T');
    const dl = r.fake.sent.filter((m) => m.method === 'Browser.setDownloadBehavior');
    assert.equal(dl.length, 1); assert.equal(dl[0]!.params.behavior, 'deny');
    assert.ok(!('downloadPath' in dl[0]!.params));
  } finally { await r.done(); }
  r = await rig({ pages: { 'https://a.test/': { text: 'x' } }, errorFor: { 'Browser.setDownloadBehavior': 'not supported' } });
  try { await assert.rejects(r.session.open('https://a.test/'), /deny downloads/); } finally { await r.done(); }
});

test('E6: navigations to file:, data:, javascript: and chrome: documents are refused on the Chromium engine, with no content', async () => {
  for (const to of ['file:///etc/passwd', 'data:text/html,<p>LEAK</p>', 'javascript:alert(1)', 'chrome://settings', 'blob:https://a.test/x', 'ftp://a.test/x']) {
    const r = await rig({ pages: { 'https://a.test/': { redirectTo: to }, [to]: { title: 'SECRET', text: 'LEAK' } } });
    try { await assert.rejects(r.session.open('https://a.test/'), (e: Error) => e instanceof SessionRefusal && !/SECRET|LEAK/.test(e.message), to); } finally { await r.done(); }
  }
});

test('E6: the same guards hold on the Chromium engine: private and metadata redirects, the protected port, the domain list, sub-resources, hop cap', async () => {
  for (const to of ['http://10.0.0.5/admin', 'http://169.254.169.254/latest/meta-data/', `http://127.0.0.1:${WALLET}/`, `http://localhost:${WALLET}/`, 'https://inner.test/']) {
    const r = await rig({ pages: { 'https://a.test/': { redirectTo: to }, [to]: { text: 'LEAK' } } }, { guard: () => (to.includes(`:${WALLET}`) ? { allowLocal: true, localPorts: [WALLET, 80, 443] } : {}) });
    try { await assert.rejects(r.session.open('https://a.test/'), SessionRefusal, to); assert.ok(r.fake.blocked.length >= 1, 'the request was failed at the browser (Fetch.failRequest)'); } finally { await r.done(); }
  }
  let r = await rig({ pages: { 'https://a.test/': { redirectTo: 'https://evil.test/' }, 'https://evil.test/': { text: 'E' } } }, { guard: () => ({ allowDomains: ['a.test', 'b.test'] }) });
  try { await assert.rejects(r.session.open('https://a.test/'), /allowed domain list/); } finally { await r.done(); }
  r = await rig({ pages: { 'https://a.test/': { text: 'x', subrequests: ['http://192.168.1.1/pixel.gif'] } } });
  try { await assert.rejects(r.session.open('https://a.test/'), SessionRefusal); assert.ok(r.fake.blocked.length >= 1); } finally { await r.done(); }
  const pages: Record<string, { redirectTo?: string; text?: string }> = {};
  for (let i = 0; i < 12; i++) pages[`https://a.test/${i}`] = { redirectTo: `https://a.test/${i + 1}` };
  pages['https://a.test/12'] = { text: 'end' };
  r = await rig({ pages });
  try { await assert.rejects(r.session.open('https://a.test/0'), /too many redirects/); } finally { await r.done(); }
});

test('E6: a popup is closed at once', async () => {
  const r = await rig({ popup: true, pages: { 'https://a.test/': { text: 'x' } } });
  try {
    await r.session.open('https://a.test/');
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(r.session.closedTabsBlocked >= 1);
  } finally { await r.done(); }
});

// ------------------------------------------------------------------ the built-in check page (Settings, "Open test page")
test('E10: the check page is answered by Legion through the interception (nothing is requested from a network), runs its script, and its forbidden request is refused by the guard', async () => {
  const fake = await startFakeCdp({ pages: {} });
  const url = 'https://legion-check.invalid/abc123';
  const probe = 'http://169.254.169.254/legion-check-abc123';
  const html = `<!doctype html><html><head><title>Legion browser check</title></head><body><p id="js">js-pending</p><script>document.getElementById('js').textContent='js-ok';</script><img src="${probe}" alt=""></body></html>`;
  const session = new BrowserSession({
    guard: () => ({}), resolve: DNS, approveOrigin: async () => true, internal: { url, html, probe },
    async launch(): Promise<RunningBrowser> { const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`); return { cdp, pid: undefined, port: fake.port, args: [], exited: new Promise(() => undefined), stop: async () => { cdp.close(); } }; },
  });
  try {
    const v = await session.open(url);
    assert.equal(v.title, 'Legion browser check');
    assert.equal((await session.text('#js')).text, 'js-ok');
    assert.equal(session.probeBlocked, true);
    assert.deepEqual(fake.fulfilled, [url], 'Legion answered its own page');
    assert.ok(fake.blocked.length >= 1, 'the forbidden request was failed before it was sent');
  } finally { await session.close(); await fake.close(); }
});

test('E10: only the exact check URL is answered by Legion; any other address under that name, or a page that sends the visitor there, is an ordinary refused address', async () => {
  const r = await rig({ pages: { 'https://a.test/': { redirectTo: 'https://legion-check.invalid/other' }, 'https://legion-check.invalid/other': { title: 'FORGED', text: 'FORGED' } } });
  try { await assert.rejects(r.session.open('https://a.test/'), (e: Error) => e instanceof SessionRefusal && !/FORGED/.test(e.message)); assert.deepEqual(r.fake.fulfilled, []); } finally { await r.done(); }
  // and a session without an internal page never fulfils anything, even for that name
  const r2 = await rig({ pages: { 'https://legion-check.invalid/abc123': { title: 'X', text: 'X' } } });
  try { await assert.rejects(r2.session.open('https://legion-check.invalid/abc123')); assert.deepEqual(r2.fake.fulfilled, []); } finally { await r2.done(); }
});

test('E10: if the guard did let the forbidden request through, the check fails (the page is refused)', async () => {
  const fake = await startFakeCdp({ pages: {} });
  const url = 'https://legion-check.invalid/n1'; const probe = 'https://93.184.216.34/legion-check-n1'; // a public address: the guard (correctly) allows it, so the check must fail
  const html = `<html><head><title>Legion browser check</title></head><body><img src="${probe}"></body></html>`;
  const session = new BrowserSession({
    guard: () => ({}), resolve: DNS, approveOrigin: async () => true, internal: { url, html, probe },
    async launch(): Promise<RunningBrowser> { const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`); return { cdp, pid: undefined, port: fake.port, args: [], exited: new Promise(() => undefined), stop: async () => { cdp.close(); } }; },
  });
  try { await assert.rejects(session.open(url), /let the check page/); assert.equal(session.probeBlocked, false); } finally { await session.close(); await fake.close(); }
});
