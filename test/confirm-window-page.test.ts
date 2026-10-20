/**
 * The page of the Legion confirm window (assets/confirm-window.html): static pins on what it may load and how it writes, and its script run against a
 * small stand-in for the DOM. The point of both: only the explicit fields make structure, everything from the model goes in as text, and the page
 * answers only by setting its own title.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const html = readFileSync(`${ROOT}/assets/confirm-window.html`, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n');

// ---- static pins ----

test('page: one policy, default-src none, nothing remote, inline style and script only', () => {
  const csps = [...html.matchAll(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)].map((m) => m[1]!);
  assert.equal(csps.length, 1);
  assert.match(csps[0]!, /^default-src 'none';/);
  assert.doesNotMatch(csps[0]!, /https?:|\*|file:|connect-src|frame-src|'unsafe-eval'/);
  assert.match(csps[0]!, /img-src data:/);
  assert.match(csps[0]!, /script-src 'unsafe-inline'/);
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
  attrs: Record<string, string> = {}; text = ''; onclick: (() => void) | null = null; fragment = false;
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
  win.confirmWindow.render(model({ tone: 'money', toneTag: 'LAST CHECK', theme: 'light', who: 'BSV \u203a spend review 2 of 2', title: 'Last Legion check', message: '', amount: '25,000 sat', amountNote: 'REAL BSV', address: a, buttons: ['Send 25,000 sat to ...Jd8K', 'Cancel'], defaultIndex: 1, cancelIndex: 1, confirmAt: 0 }));
  assert.equal(doc.getElementById('cw').className, 'cw money');
  assert.equal(doc.documentElement.attrs['data-theme'], 'light');
  assert.equal(doc.getElementById('who').textContent, 'asked by BSV \u203a spend review 2 of 2');
  assert.equal(doc.getElementById('tag').textContent, 'LAST CHECK'); assert.equal(doc.getElementById('tag').hidden, false);
  assert.equal(doc.getElementById('ttext').textContent, 'Last Legion check');
  assert.equal(doc.getElementById('m').hidden, true);
  assert.equal(doc.getElementById('amtv').textContent, '25,000 sat'); assert.equal(doc.getElementById('amt').hidden, false);
  const addr = doc.getElementById('addr');
  assert.equal(addr.textContent, a, 'the whole address, nothing added');
  const marked = addr.children.flatMap((g) => g.children.filter((c) => c.tagName === 'I')).map((i) => i.textContent).join('');
  assert.equal(marked, '1BvM' + 'Jd8K', 'the first 4 and the last 4 characters are marked');
  assert.equal(addr.children[addr.children.length - 1]!.textContent, 'Jd8K', 'groups are counted from the end');
  const buttons = doc.getElementById('ft').getElementsByTagName('button');
  assert.deepEqual(buttons.map((b) => [b.textContent, b.className]), [['Send 25,000 sat to ...Jd8K', 'go'], ['Cancel', '']]);
  assert.equal(doc.active, buttons[1], 'focus starts on the default button (Cancel)');
});

test('page DOM: a click or a key before the window is armed is no answer; after it, one answer, then no more', () => {
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
