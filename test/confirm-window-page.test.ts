/**
 * The page of Legion's confirm card (assets/confirm-window.html): static pins on what it may load and how it writes, and its script run against a
 * small stand-in for the DOM. The point of both: only the explicit fields make structure, everything from the model goes in as text, and the page
 * answers only by setting its own title.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseSpendCard, spendLiveDialog, type SpendCard } from '../src/electron/admin-logic.js';
import { ADDRESS_TAIL, buildModel } from '../src/electron/confirm-window-logic.js';
import { MAIN_A } from './bsv-net-helpers.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const html = readFileSync(`${ROOT}/assets/confirm-window.html`, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n');

// ---- static pins ----

test('page: one policy, default-src none, nothing remote; the one inline script is allowed by its hash, not by unsafe-inline; no image source', () => {
  const csps = [...html.matchAll(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)].map((m) => m[1]!);
  assert.equal(csps.length, 1);
  assert.match(csps[0]!, /^default-src 'none';/);
  assert.doesNotMatch(csps[0]!, /https?:|\*|file:|connect-src|frame-src|'unsafe-eval'|img-src/);
  assert.match(csps[0]!, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(csps[0]!.replace(/style-src 'unsafe-inline'/, ''), /unsafe-inline/, 'only styles are inline');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.equal(scripts.length, 1, 'one inline script');
  const hash = createHash('sha256').update(scripts[0]!, 'utf8').digest('base64');
  assert.ok(csps[0]!.includes(`script-src 'sha256-${hash}'`), `the policy names this script by its hash (sha256-${hash})`);
  assert.equal(csps[0]!.match(/script-src[^;]*/g)!.length, 1);
});

test('page: refers to nothing outside itself (no src, href, url(), @import, import, fetch, XHR, WebSocket, window.open, eval)', () => {
  assert.equal(html.match(/<(?:script|img|link|iframe|object|embed|video|audio|source)\b[^>]*\b(?:src|href|data)=/gi), null);
  assert.doesNotMatch(html.replace(/xmlns="[^"]*"/g, ''), /https?:\/\//i);
  assert.doesNotMatch(html, /url\(|@import|<link\b|<iframe\b|<object\b|<embed\b|<base\b/i);
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|WebSocket|window\.open|\beval\(|new Function|importScripts|import\(|navigator\.sendBeacon|localStorage|sessionStorage|postMessage|require\(/);
});

test('page: nothing from the model is written as markup', () => {
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|srcdoc/);
  assert.ok((script.match(/\.textContent\s*=/g) ?? []).length >= 8, 'the model is set with textContent');
});

test('page: no structure is read out of a text (no Key: value or bullet patterns; the only split is on blank lines)', () => {
  assert.doesNotMatch(script, /indexOf\(['"]: ?['"]\)|\[A-Z\]\[A-Za-z|\^- |\^\\s\*[-*]|startsWith\(['"]- /);
  const splits = [...script.matchAll(/\.split\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(splits, ['/\\n{2,}/']);
});

test('page: it answers only by setting its own title, with the one-time id; no preload API is used', () => {
  assert.match(script, /document\.title=PREFIX\+model\.nonce\+':'\+i/);
  assert.equal((script.match(/document\.title\s*=/g) ?? []).length, 1);
  assert.doesNotMatch(script, /window\.legion|ipcRenderer|contextBridge/);
});

// ---- the script, run on a small DOM ----

class El {
  tagName: string; id = ''; children: El[] = []; hidden = false; className = ''; disabled = false; tabIndex = 0; type = '';
  scrollTop = 0; scrollHeight = 0; clientHeight = 0; offsetHeight = 0; style: Record<string, string> = {}; parent: El | null = null;
  attrs: Record<string, string> = {}; text = ''; onclick: ((ev?: { detail: number }) => void) | null = null; fragment = false;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get firstChild(): El | null { return this.children[0] ?? null; }
  get lastChild(): El | null { return this.children[this.children.length - 1] ?? null; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  appendChild(c: El): El { if (c.fragment) { for (const k of [...c.children]) this.appendChild(k); c.children = []; return c; } c.parent = this; this.children.push(c); return c; }
  removeChild(c: El): El { this.children = this.children.filter((k) => k !== c); return c; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  addEventListener(): void { /* the page's listeners are driven through the document */ }
  focus(): void { doc.active = this; }
  getBoundingClientRect(): { height: number } { return { height: 0 }; }
  getElementsByTagName(tag: string): El[] { const out: El[] = []; const walk = (e: El): void => { for (const c of e.children) { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c); } }; walk(this); return out; }
  classList = { toggle: (_n: string, _on: boolean): void => undefined };
  get content(): El { const f = new El('#fragment'); f.fragment = true; f.appendChild(new El('svg')); return f; }
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
type Listener = (e: Record<string, unknown>) => void;
const doc = {
  title: 'Legion', active: null as El | null, byId: new Map<string, El>(), listeners: new Map<string, Listener[]>(), created: [] as El[],
  documentElement: new El('html'),
  get activeElement(): El | null { return doc.active; },
  getElementById(id: string): El { const e = doc.byId.get(id); if (!e) throw new Error(`no element ${id}`); return e; },
  createElement(t: string): El { const e = new El(t); doc.created.push(e); return e; },
  createElementNS(_n: string, t: string): El { return doc.createElement(t); },
  createTextNode(t: string): El { const e = new El('#text'); e.text = t; return e; },
  createDocumentFragment(): El { const e = new El('#fragment'); e.fragment = true; return e; },
  importNode(n: El): El { return n; },
  addEventListener(type: string, fn: Listener): void { doc.listeners.set(type, [...(doc.listeners.get(type) ?? []), fn]); },
  fire(type: string, e: Record<string, unknown> = {}): void { for (const fn of doc.listeners.get(type) ?? []) fn({ preventDefault() { /* none */ }, repeat: false, target: new El('body'), ...e }); },
};
function boot(): { win: Record<string, any> } {
  doc.byId = new Map(ids.map((id) => { const e = new El('div'); e.id = id; return [id, e]; }));
  doc.listeners = new Map(); doc.created = []; doc.title = 'Legion'; doc.documentElement = new El('html'); doc.active = null;
  const win: Record<string, any> = { addEventListener: () => undefined };
  const ctx = vm.createContext({ document: doc, window: win, getComputedStyle: () => ({ marginTop: '0', marginBottom: '0', maxHeight: 'none' }), setTimeout: (f: () => void) => { f(); return 1; }, clearTimeout: () => undefined, isFinite, parseFloat, Math, JSON });
  vm.runInContext(script, ctx);
  return { win };
}
const NONCE = 'c'.repeat(32);
const model = (over: Record<string, unknown> = {}) => ({ nonce: NONCE, theme: 'dark', tone: 'default', toneTag: '', who: 'Settings \u203a Gates', title: 'Trust this folder?', message: 'Trust it?', detail: '', facts: [], items: [], amount: '', amountNote: '', address: '', buttons: ['Cancel', 'Trust this folder'], defaultIndex: 0, cancelIndex: 0, confirmAt: 1, ...over });
const kinds = (): string[] => doc.created.map((e) => e.tagName);

test('page DOM: a detail of "Key: value" and "- x" lines is paragraphs of text: no row, no bullet is made from it', () => {
  const { win } = boot();
  const detail = 'Folder: D:\\work\\repo\n- .claude/settings.json runs a hook\n\n- 3 skills can run scripts: a, b, c\n\nNote: Legion asks again';
  win.confirmWindow.render(model({ detail }));
  const prose = doc.getElementById('prose');
  assert.deepEqual(prose.children.map((p) => p.tagName), ['P', 'P', 'P']);
  assert.deepEqual(prose.children.map((p) => p.textContent), ['Folder: D:\\work\\repo\n- .claude/settings.json runs a hook', '- 3 skills can run scripts: a, b, c', 'Note: Legion asks again']);
  assert.equal(doc.getElementById('facts').children.length, 0);
  assert.equal(doc.getElementById('items').children.length, 0);
  assert.ok(!kinds().includes('DT') && !kinds().includes('DD') && !kinds().includes('LI'), 'no row or bullet was created');
  assert.equal(doc.getElementById('facts').hidden, true); assert.equal(doc.getElementById('items').hidden, true);
});

test('page DOM: facts and items from the explicit fields do make rows and bullets, as text', () => {
  const { win } = boot();
  win.confirmWindow.render(model({ facts: [{ label: 'New folder', value: 'C:\\a <b>b</b>' }, { label: 'Now', value: 'D:\\old' }], items: ['one <i>x</i>', 'two'], detail: 'prose' }));
  const facts = doc.getElementById('facts');
  assert.deepEqual(facts.children.map((c) => [c.tagName, c.textContent]), [['DT', 'New folder'], ['DD', 'C:\\a <b>b</b>'], ['DT', 'Now'], ['DD', 'D:\\old']]);
  const items = doc.getElementById('items');
  assert.deepEqual(items.children.map((li) => li.tagName), ['LI', 'LI']);
  assert.deepEqual(items.children.map((li) => li.children[li.children.length - 1]!.textContent), ['one <i>x</i>', 'two']);
  assert.ok(!kinds().includes('B') && !kinds().includes('I'), 'markup in a value is text, not elements');
});

test('page DOM: tone, tag, who, title, message, amount and address', () => {
  const { win } = boot();
  const a = '1BvMxQ7hN2kpWd3c8TyLr5Ze9FaQm4Jd8K';
  win.confirmWindow.render(model({ tone: 'money', toneTag: 'LAST CHECK', theme: 'light', who: 'BSV \u203a spend review 2 of 2', title: 'Last Legion check', message: '', amount: '25,000 sat', amountNote: 'REAL BSV', address: a, buttons: ['Send 25,000 sat to ...aQm4Jd8K', 'Cancel'], defaultIndex: 1, cancelIndex: 1, confirmAt: 0 }));
  assert.equal(doc.getElementById('cw').className, 'cw money');
  assert.equal(doc.documentElement.attrs['data-theme'], 'light');
  assert.equal(doc.getElementById('who').textContent, 'asked by BSV \u203a spend review 2 of 2');
  assert.equal(doc.getElementById('tag').textContent, 'LAST CHECK'); assert.equal(doc.getElementById('tag').hidden, false);
  assert.equal(doc.getElementById('ttext').textContent, 'Last Legion check');
  assert.equal(doc.getElementById('m').hidden, true);
  assert.equal(doc.getElementById('amtv').textContent, '25,000 sat'); assert.equal(doc.getElementById('amt').hidden, false);
  const addr = doc.getElementById('addrv');
  assert.equal(addr.textContent, a, 'the whole address, nothing added');
  const marked = addr.children.flatMap((g) => g.children.filter((c) => c.tagName === 'I')).map((i) => i.textContent).join('');
  assert.equal(marked, '1BvM' + a.slice(-8), 'the first 4 and the last 8 characters are marked');
  assert.equal(addr.children[addr.children.length - 1]!.textContent, 'Jd8K', 'groups are counted from the end');
  const buttons = doc.getElementById('ft').getElementsByTagName('button');
  assert.deepEqual(buttons.map((b) => [b.textContent, b.className]), [['Send 25,000 sat to ...aQm4Jd8K', 'go'], ['Cancel', '']]);
  assert.equal(doc.active, buttons[1], 'focus starts on the default button (Cancel)');
});

test('page DOM: a click or a key before the card is armed is no answer; after it, one answer, then no more', () => {
  const { win } = boot();
  win.confirmWindow.render(model());
  const buttons = doc.getElementById('ft').getElementsByTagName('button');
  buttons[1]!.onclick!();
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(doc.title, 'Legion', 'not armed: nothing was answered');
  win.confirmWindow.arm();
  buttons[1]!.onclick!();
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`);
  buttons[0]!.onclick!();
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`, 'the first answer stands');
  assert.equal(buttons.every((b) => b.disabled), true);
});

test('page DOM: Escape answers the cancel button; Enter off a button answers the default; a held key does not repeat', () => {
  let { win } = boot();
  win.confirmWindow.render(model({ buttons: ['Send', 'Cancel'], defaultIndex: 1, cancelIndex: 1, confirmAt: 0 }));
  win.confirmWindow.arm();
  doc.fire('keydown', { key: 'Escape', repeat: true });
  assert.equal(doc.title, 'Legion', 'a repeat is ignored');
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`);
  ({ win } = boot());
  win.confirmWindow.render(model({ buttons: ['Send', 'Cancel'], defaultIndex: 1, cancelIndex: 1, confirmAt: 0 }));
  win.confirmWindow.arm();
  doc.fire('keydown', { key: 'Enter' });
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`, 'Enter with no button focused is the default button, which is Cancel here');
  ({ win } = boot());
  win.confirmWindow.render(model());
  win.confirmWindow.arm();
  doc.fire('keydown', { key: 'Enter', target: new El('button') });
  assert.equal(doc.title, 'Legion', 'Enter on a focused button is that button\'s own click, not an answer made by the page');
});

test('page DOM: Tab cycles through the buttons and wraps at both ends (the last check starts on Cancel and Tab reaches the confirm button)', () => {
  const { win } = boot();
  win.confirmWindow.render(model({ buttons: ['Send', 'Cancel'], defaultIndex: 1, cancelIndex: 1, confirmAt: 0 }));
  win.confirmWindow.arm();
  const b = doc.getElementById('ft').getElementsByTagName('button');
  assert.equal(doc.active, b[1]);
  doc.fire('keydown', { key: 'Tab' }); assert.equal(doc.active, b[0], 'forward from the last wraps to the first');
  doc.fire('keydown', { key: 'Tab' }); assert.equal(doc.active, b[1]);
  doc.fire('keydown', { key: 'Tab', shiftKey: true }); assert.equal(doc.active, b[0]);
  doc.fire('keydown', { key: 'Tab', shiftKey: true }); assert.equal(doc.active, b[1], 'backward from the first wraps to the last');
  assert.equal(doc.title, 'Legion', 'moving focus answers nothing');
});

test('page: the money address has a static label above it and the dialog describes its amount and address to a screen reader', () => {
  assert.match(html, /<div class="addr" id="addr" role="group" aria-label="Address" hidden><div class="addr-l">To: check every character<\/div><div class="addr-v" id="addrv"><\/div><\/div>/);
  assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="t" aria-describedby="m amt addr"/);
  assert.doesNotMatch(script, /addr-l|getElementById\('addr'\)\.textContent/, 'the label is markup in the file, never written by the model path');
});

test('page: a button label wraps instead of being cut at the card edge', () => {
  const css = /^  button\{([^}]*)\}/m.exec(html)?.[1] ?? '';
  assert.doesNotMatch(css, /nowrap/);
  assert.match(css, /max-width:100%/);
  assert.match(css, /overflow-wrap:anywhere/);
});

test('page DOM: the last check marks the tail its button names, and the tail is one constant of the model', () => {
  const main = parseSpendCard({
    requestId: 'a'.repeat(40), network: 'main', networkLabel: 'LIVE FUNDS (main network)', hash: 'a'.repeat(64), agentId: 'scout', purpose: 'x',
    outputs: [{ kind: 'payment', recipient: MAIN_A, sats: 25000, allowlisted: true }], fee: { sats: 12 }, totalSpendSats: 25012,
    remaining: { perTxSats: 25000, perSessionSats: 75000, per24hSats: 175000 }, warnings: [], requiredConfirmations: ['approve', 'live-funds'],
  }) as { ok: true; card: SpendCard };
  assert.equal(main.ok, true);
  const d2 = spendLiveDialog(main.card);
  const built = buildModel(d2, { nonce: NONCE, theme: 'dark' });
  assert.equal(built.ok, true);
  const m = (built as { model: import('../src/electron/confirm-window-logic.js').ConfirmModel }).model;
  assert.equal(m.addressTail, ADDRESS_TAIL);
  assert.equal(ADDRESS_TAIL, 8);
  const { win } = boot();
  win.confirmWindow.render(m);
  const addr = doc.getElementById('addrv');
  assert.equal(addr.textContent, MAIN_A, 'the whole address, nothing added');
  const marked = addr.children.flatMap((g) => g.children.filter((c) => c.tagName === 'I')).map((i) => i.textContent);
  const label = doc.getElementById('ft').getElementsByTagName('button')[0]!.textContent;
  const named = label.slice(label.indexOf('...') + 3);
  assert.equal(named.length, ADDRESS_TAIL);
  assert.equal(marked.join(''), MAIN_A.slice(0, 4) + named, 'the first 4 and exactly the characters the button names');
  assert.equal(addr.children.slice(-2).map((g) => g.textContent).join(''), named, 'the tail is two whole groups');
});

test('page DOM: a click counts only when its press began after the card was armed', () => {
  const { win } = boot();
  win.confirmWindow.render(model());
  const b = doc.getElementById('ft').getElementsByTagName('button');
  doc.fire('pointerdown');            // the press begins before the card is armed (a double click on the page behind)
  win.confirmWindow.arm();
  b[1]!.onclick!({ detail: 1 });
  assert.equal(doc.title, 'Legion', 'a click whose press began before arming answers nothing');
  doc.fire('pointerdown');            // a fresh press, after arming
  b[1]!.onclick!({ detail: 1 });
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`);
});

test('page DOM: a click with no press seen counts only when its detail is 0 (a keyboard press or a screen reader invoke); a mouse click with no press is no answer', () => {
  const { win } = boot();
  win.confirmWindow.render(model());
  const b = doc.getElementById('ft').getElementsByTagName('button');
  win.confirmWindow.arm();
  b[1]!.onclick!({ detail: 1 });
  assert.equal(doc.title, 'Legion', 'a mouse click (detail above 0) with no recorded press is refused');
  b[1]!.onclick!({ detail: 2 });
  assert.equal(doc.title, 'Legion');
  b[1]!.onclick!({ detail: 0 });
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`, 'detail 0 and no press: an invoke through the accessibility interface');
});

test('page DOM: a press that began early stays refused whatever the click says; a key resets the press, and each click uses its press up', () => {
  const { win } = boot();
  win.confirmWindow.render(model());
  const b = doc.getElementById('ft').getElementsByTagName('button');
  doc.fire('pointerdown');            // early press
  win.confirmWindow.arm();
  b[1]!.onclick!({ detail: 0 });
  assert.equal(doc.title, 'Legion', 'an early press is refused even for a detail 0 click');
  doc.fire('pointerdown');            // early press again, then a key: the key is a new action
  doc.fire('keydown', { key: 'Shift' });
  b[1]!.onclick!({ detail: 0 });
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`);
});

test('page DOM: a keyboard click (Space or Enter on a focused button) needs no press, only the armed card', () => {
  const { win } = boot();
  win.confirmWindow.render(model());
  const b = doc.getElementById('ft').getElementsByTagName('button');
  b[1]!.onclick!({ detail: 0 });
  assert.equal(doc.title, 'Legion', 'not armed');
  win.confirmWindow.arm();
  b[1]!.onclick!({ detail: 0 });
  assert.equal(doc.title, `legion-confirm:${NONCE}:1`);
});

test('page: its fallback tail is the same constant as the model\'s', () => {
  assert.equal(Number(/DEFAULT_TAIL=(\d+)/.exec(script)?.[1]), ADDRESS_TAIL);
});

test('page: on a very small screen the card scrolls as a whole and the footer sticks, so the buttons never leave the card', () => {
  const cw = /^  \.cw\{([^}]*)\}/m.exec(html)?.[1] ?? '';
  assert.match(cw, /overflow-y:auto/);
  const ft = /^  \.ft\{([^}]*)\}/m.exec(html)?.[1] ?? '';
  assert.match(ft, /position:sticky;bottom:0;background:var\(--bg\)/);
});

test('page: it is an overlay: transparent page, a dimmed backdrop over the whole view, one centred card of at most 480 px, the detail scrolls inside it', () => {
  const root = /^  html,body\{([^}]*)\}/m.exec(html)?.[1] ?? '';
  assert.match(root, /background:transparent/, 'the app behind shows through the page');
  const bd = /^  \.bd\{([^}]*)\}/m.exec(html)?.[1] ?? '';
  assert.match(bd, /position:fixed;inset:0/); assert.match(bd, /align-items:center;justify-content:center/); assert.match(bd, /background:var\(--scrim\)/);
  const cw = /^  \.cw\{([^}]*)\}/m.exec(html)?.[1] ?? '';
  assert.match(cw, /width:min\(480px,100%\)/); assert.match(cw, /max-height:100%/);
  const det = /^  \.det\{([^}]*)\}/m.exec(html)?.[1] ?? '';
  assert.match(det, /overflow-y:auto/); assert.match(det, /flex:0 1 auto/);
  assert.match(html, /--scrim:rgba\([^)]*\)/); assert.match(html, /:root\[data-theme=light\][^}]*--scrim:rgba\(/, 'the dim is set for both themes');
  assert.match(html, /<div class="bd" id="bd">[\r\n]+<div class="cw" id="cw" role="alertdialog"/);
});

test('page: nothing from a window is left (no drag region, no height call for a window to fit)', () => {
  assert.doesNotMatch(html, /-webkit-app-region/);
  assert.doesNotMatch(script, /function height|height:height/);
});

test('page: focusing a button never scrolls the card (the card opens at its top, the title first, even when it scrolls as a whole)', () => {
  assert.match(script, /\.focus\(\{preventScroll:true\}\)/);
});
