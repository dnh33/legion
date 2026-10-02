import test from 'node:test';
import assert from 'node:assert/strict';
import { connectCdp } from '../src/core/browser/cdp.js';
import { BrowserSession, SessionRefusal } from '../src/core/browser/session.js';
import type { RunningBrowser } from '../src/core/browser/launcher.js';
import { fakeResolver, startFakeCdp } from './browser-fakes.js';
import type { FakeCdp, FakeCdpOptions } from './browser-fakes.js';

const WALLET = 3321;
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

test('C5: with request interception a subresource to a private address is failed at the browser; without it the page is still refused', async () => {
  for (const noFetch of [false, true]) {
    const r = await rig({ noFetch, pages: { 'https://a.test/': { text: 'x', subrequests: ['http://192.168.1.1/pixel.gif'] } } });
    try {
      await assert.rejects(r.session.open('https://a.test/'), SessionRefusal);
      if (!noFetch) assert.ok(r.fake.blocked.length >= 1, 'Fetch.failRequest was sent');
    } finally { await r.done(); }
  }
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
