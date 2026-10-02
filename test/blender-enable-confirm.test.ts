/**
 * "Turn on Blender?": the confirmation before Blender is turned ON, shared by the title-bar chip and the Settings switch.
 * The store is bundled for real (only the network call is a spy); the dialog is rendered with a stand-in Modal that exposes its onClose.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { ENABLE_CONFIRM, ENABLE_TEXT, ENABLE_TITLE } from '../ui/src/blender/enableCopy.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

type Btn = { label?: string; role?: string; className?: string; autofocus?: unknown; onClick?: () => void };
interface H {
  setStatus(enabled: boolean): void;
  state(): { confirmOpen: boolean; busy: unknown };
  requestEnableBlender(): void; cancelEnableBlender(): void; confirmEnableBlender(): void;
  requests(): Array<[string, string, unknown]>;
  renderDialog(): { html: string; modal: { title: string; onClose: () => void } | null; buttons: Btn[] };
  renderChip(): { buttons: Btn[] };
  reset(): void;
}

async function load(): Promise<{ h: H; cleanup: () => void }> {
  const jsxReal = createRequire(join(REPO, 'package.json')).resolve('react/jsx-runtime');
  const r = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import * as store from ${JSON.stringify(join(REPO, 'ui/src/blender/blenderStore.ts'))};
        import { EnableBlenderDialog } from ${JSON.stringify(join(REPO, 'ui/src/blender/EnableBlenderDialog.tsx'))};
        import { BlenderPopover } from ${JSON.stringify(join(REPO, 'ui/src/blender/BlenderChip.tsx'))};
        import { chipModel } from ${JSON.stringify(join(REPO, 'ui/src/blender/chipModel.ts'))};
        const g = globalThis; g.__req = []; g.__btns = []; g.__modal = null; g.__listeners = new Set();
        const st = (enabled) => ({ enabled, light: enabled ? 'local' : 'off' });
        export const h = {
          setStatus: (enabled) => store.setBlenderStatus(st(enabled)),
          state: () => store.getBlender(),
          requestEnableBlender: store.requestEnableBlender, cancelEnableBlender: store.cancelEnableBlender, confirmEnableBlender: store.confirmEnableBlender,
          requests: () => g.__req,
          renderDialog: () => { g.__btns = []; g.__modal = null; const html = renderToStaticMarkup(createElement(EnableBlenderDialog)); return { html, modal: g.__modal, buttons: g.__btns }; },
          renderChip: () => { g.__btns = []; const s = store.getBlender(); const m = chipModel({ status: s.status, loaded: s.loaded, failed: s.failed, absent: s.absent, busy: s.busy !== null }); renderToStaticMarkup(createElement(BlenderPopover, { m, onSettings: () => {} })); return { buttons: g.__btns }; },
          reset: () => { g.__req.length = 0; store.cancelEnableBlender(); },
        };`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-shim', namespace: 'stub' }));
        b.onResolve({ filter: /^react$/ }, (a) => a.pluginData === 'real' ? { path: createRequire(join(REPO, 'package.json')).resolve('react') } : { path: 'react-shim', namespace: 'stub' });
        b.onLoad({ filter: /^react-shim$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          import * as R from ${JSON.stringify(createRequire(join(REPO, 'package.json')).resolve('react'))};
          export * from ${JSON.stringify(createRequire(join(REPO, 'package.json')).resolve('react'))};
          export default R;
          export const useSyncExternalStore = (s, g, srv) => R.useSyncExternalStore(s, g, srv ?? g);` }));
        b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.\/components\/Modal$/ }, () => ({ path: 'modal-stub', namespace: 'stub' }));
        b.onLoad({ filter: /^jsx-shim$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          import { jsx as j, jsxs as js, Fragment } from ${JSON.stringify(jsxReal)};
          const rec = (t, p) => { if (t === 'button') globalThis.__btns.push({ label: p['aria-label'], role: p.role, className: p.className, autofocus: p['data-autofocus'], onClick: p.onClick }); };
          export const jsx = (t, p, k) => { rec(t, p); return j(t, p, k); };
          export const jsxs = (t, p, k) => { rec(t, p); return js(t, p, k); };
          export { Fragment };` }));
        b.onLoad({ filter: /^api-stub$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
          export class ApiError extends Error { constructor(s, m) { super(m); this.status = s; } }
          export const request = async (method, path, body) => { globalThis.__req.push([method, path, body]); return { enabled: true, light: 'local' }; };` }));
        b.onLoad({ filter: /^store-stub$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `export const openSettings = () => {};` }));
        b.onLoad({ filter: /^modal-stub$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          import { jsx, jsxs } from ${JSON.stringify(jsxReal)};
          export function Modal({ title, onClose, children, footer }) { globalThis.__modal = { title, onClose }; return jsxs('div', { role: 'dialog', 'aria-label': title, children: [children, footer] }); }` }));
      },
    }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'enable-'));
  const file = join(dir, 'm.cjs');
  writeFileSync(file, r.outputFiles[0].text);
  const mod = createRequire(file)(file) as { h: H };
  return { h: mod.h, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test('turning ON opens the dialog and writes nothing; Cancel and Escape leave Blender off and call nothing', async () => {
  const { h, cleanup } = await load();
  try {
    h.setStatus(false); h.reset();
    h.requestEnableBlender();
    assert.equal(h.state().confirmOpen, true);
    assert.deepEqual(h.requests(), []);
    const d = h.renderDialog();
    assert.equal(d.modal?.title, ENABLE_TITLE);
    assert.ok(d.html.includes('Turn on Blender?') || d.html.includes(ENABLE_TITLE));
    assert.match(d.html, /filter, not a sandbox/);
    // Cancel is the default button (data-autofocus) and comes first; the confirm is the primary one
    const cancel = d.buttons.find((b) => b.autofocus !== undefined)!;
    assert.ok(cancel && /btn-ghost/.test(cancel.className ?? ''), 'Cancel carries data-autofocus');
    const confirm = d.buttons.find((b) => /btn primary/.test(b.className ?? ''))!;
    assert.ok(confirm && confirm !== cancel);
    assert.ok(!d.buttons.some((b) => b !== cancel && b.autofocus !== undefined), 'only Cancel is the default');
    assert.match(d.html, new RegExp(`>${ENABLE_CONFIRM}<`));
    cancel.onClick!(); await flush();
    assert.equal(h.state().confirmOpen, false);
    assert.deepEqual(h.requests(), []);
    // Escape and the X and a click outside all reach Modal's onClose
    h.requestEnableBlender();
    h.renderDialog().modal!.onClose(); await flush();
    assert.equal(h.state().confirmOpen, false);
    assert.deepEqual(h.requests(), []);
    assert.equal(h.renderDialog().html, '', 'the dialog is gone');
    // a stray confirm with no dialog open writes nothing
    h.confirmEnableBlender(); await flush();
    assert.deepEqual(h.requests(), []);
  } finally { cleanup(); }
});

test('Confirm writes once, through saveBlenderConfig({ enabled: true }) (POST /api/blender/config)', async () => {
  const { h, cleanup } = await load();
  try {
    h.setStatus(false); h.reset();
    h.requestEnableBlender();
    const confirm = h.renderDialog().buttons.find((b) => /btn primary/.test(b.className ?? ''))!;
    confirm.onClick!(); await flush();
    assert.deepEqual(h.requests(), [['POST', '/api/blender/config', { enabled: true }]]);
    assert.equal(h.state().confirmOpen, false);
    confirm.onClick!(); await flush(); // a second press does nothing
    assert.equal(h.requests().length, 1);
  } finally { cleanup(); }
});

test('both entry points ask: the chip popover switch and the Settings checkbox never write ON by themselves; OFF needs no dialog', async () => {
  const { h, cleanup } = await load();
  try {
    h.setStatus(false); h.reset();
    const offSwitch = h.renderChip().buttons.find((b) => b.role === 'switch')!;
    offSwitch.onClick!(); await flush();
    assert.equal(h.state().confirmOpen, true, 'chip: dialog opened');
    assert.deepEqual(h.requests(), [], 'chip: nothing written before Confirm');
    h.reset();
    // already on: requesting again does not reopen
    h.setStatus(true);
    h.requestEnableBlender();
    assert.equal(h.state().confirmOpen, false);
    // OFF: straight to the write, no dialog
    const onSwitch = h.renderChip().buttons.find((b) => b.role === 'switch')!;
    onSwitch.onClick!(); await flush();
    assert.equal(h.state().confirmOpen, false);
    assert.deepEqual(h.requests(), [['POST', '/api/blender/config', { enabled: false }]]);
    // Settings (source): ON goes to requestEnableBlender; no other place writes enabled:true
    const settings = read('ui/src/components/Settings.tsx');
    assert.match(settings, /if \(e\.target\.checked\) requestEnableBlender\(\); else void saveBlenderConfig\(\{ enabled: false \}\)/);
    const offenders: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(join(REPO, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel); else if (/\.tsx?$/.test(e.name) && rel !== 'ui/src/blender/blenderStore.ts' && [...read(rel).matchAll(/saveBlenderConfig\(\{\s*enabled\s*:\s*([^\s,}]+)/g)].some((m) => m[1] !== 'false')) offenders.push(rel);
    } };
    walk('ui/src');
    assert.deepEqual(offenders, [], 'only confirmEnableBlender (in blenderStore) may write enabled: true');
    assert.match(read('ui/src/blender/blenderStore.ts'), /void saveBlenderConfig\(\{ enabled: true \}\)/);
    assert.match(read('ui/src/App.tsx'), /<EnableBlenderDialog \/>/);
  } finally { cleanup(); }
});

test('the dialog text: plain, scoped, no overclaim, and the owner\'s sentences', () => {
  assert.equal(ENABLE_TITLE, 'Turn on Blender?');
  assert.equal(ENABLE_CONFIRM, 'Turn on Blender');
  assert.match(ENABLE_TEXT, /filter, not a sandbox/);
  assert.match(ENABLE_TEXT, /your Windows user’s rights/);
  assert.match(ENABLE_TEXT, /Every script still needs your OK on its own card/);
  assert.match(ENABLE_TEXT, /A cloud VM is the isolated option\.$/);
  assert.ok(!/\b(safe|safely|secure|secured|verified|guarantee|protected)\b/i.test(`${ENABLE_TITLE} ${ENABLE_TEXT} ${ENABLE_CONFIRM}`));
});
