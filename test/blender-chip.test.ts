/**
 * The title-bar Blender chip: the view-model table (every light, plus unknown, failed and absent), the rule that the chip's switch goes through
 * the same function as the Settings switch (a real render of BlenderChip.tsx with a spy in place of the store), and the wording guards.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { BLENDER_CHIP_TIP, BLENDER_UNKNOWN, chipModel, lightLabel, type ChipInput } from '../ui/src/blender/chipModel.js';
import type { BlenderLight } from '../src/shared/blender.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const status = (light: BlenderLight, over: Record<string, unknown> = {}): ChipInput['status'] => ({ enabled: true, light, ...over }) as ChipInput['status'];
const input = (st: ChipInput['status'], over: Partial<ChipInput> = {}): ChipInput => ({ status: st, loaded: true, failed: false, absent: false, busy: false, ...over });
const v510 = { version: '5.1.0', path: 'x', versionGuessed: false };

test('chip view-model: one row per real status', () => {
  const rows: Array<[string, ChipInput, Record<string, unknown>]> = [
    ['off', input(status('off', { enabled: false })), { tone: 'off', enabled: false, label: 'Blender: Off', text: 'Off', action: 'settings' }],
    ['off wins over a stale light', input(status('connected', { enabled: false })), { tone: 'off', enabled: false, text: 'Off' }],
    ['not found offers Get Blender (opens Settings)', input(status('not-found')), { tone: 'bad', enabled: true, label: 'Blender not found', text: 'Get Blender', action: 'get' }],
    ['local ready with version', input(status('local', { selected: v510 })), { tone: 'on', label: 'Ready: this computer, Blender 5.1.0', text: 'Ready: this computer' }],
    ['local ready without a version', input(status('local')), { tone: 'on', label: 'Ready: this computer' }],
    ['cloud VM', input(status('sandbox')), { tone: 'on', label: 'Ready: cloud VM', text: 'Ready: cloud VM' }],
    ['live connected', input(status('connected')), { tone: 'on', label: 'Live Blender connected' }],
    ['needs setup', input(status('needs-setup')), { tone: 'warn', label: 'Blender needs setup', text: 'Needs setup', action: 'setup' }],
    ['running a script', input(status('busy')), { tone: 'warn', label: 'Blender is running a script', announce: false }],
    ['not listening', input(status('disconnected')), { tone: 'warn', label: 'Blender is not listening' }],
    ['problem', input(status('error')), { tone: 'bad', label: 'Blender has a problem' }],
  ];
  for (const [name, i, want] of rows) {
    const m = chipModel(i);
    assert.equal(m.visible, true, name);
    for (const [k, v] of Object.entries(want)) assert.equal((m as unknown as Record<string, unknown>)[k], v, `${name}: ${k}`);
    assert.ok(m.title.endsWith(BLENDER_CHIP_TIP), `${name}: the tooltip carries the one-line explanation`);
    assert.ok(m.actionLabel.length > 0, name);
  }
});

test('chip view-model: unknown is never a stale or invented state', () => {
  const unknown = (m: ReturnType<typeof chipModel>, name: string) => {
    assert.equal(m.visible, true, name);
    assert.equal(m.label, BLENDER_UNKNOWN, name);
    assert.equal(m.text, BLENDER_UNKNOWN, name);
    assert.equal(m.tone, 'unknown', name);
    assert.equal(m.enabled, false, name);
    assert.equal(m.switchDisabled, true, name);
    assert.equal(m.announce, false, name);
  };
  unknown(chipModel(input(null, { loaded: false })), 'nothing loaded yet');
  unknown(chipModel(input(null)), 'no status');
  unknown(chipModel(input(status('connected'), { failed: true })), 'the last request failed: the old light is not shown');
  unknown(chipModel(input(status('local', { selected: v510 }), { failed: true })), 'failed, was ready');
  unknown(chipModel(input(status('warp-drive' as BlenderLight))), 'a light this version does not know');
  unknown(chipModel(input({ enabled: 'yes', light: 'local' } as unknown as ChipInput['status'])), 'enabled is not a boolean');
});

test('chip view-model: nothing renders when the core has no Blender module', () => {
  assert.equal(chipModel(input(null, { absent: true, failed: true, loaded: false })).visible, false);
  assert.equal(chipModel(input(status('local'), { absent: true })).visible, false);
});

test('chip view-model: the switch is locked while an action runs or before the first answer, never otherwise', () => {
  assert.equal(chipModel(input(status('local'), { busy: true })).switchDisabled, true);
  assert.equal(chipModel(input(status('local'), { loaded: false })).switchDisabled, true);
  assert.equal(chipModel(input(status('off', { enabled: false }))).switchDisabled, false);
});

test('chip view-model: its tone matches lightLabel, and the shared lightLabel is unchanged', () => {
  for (const l of ['connected', 'sandbox', 'local', 'busy', 'disconnected', 'needs-setup', 'not-found', 'error'] as const) {
    const t = lightLabel(l).tone;
    assert.equal(chipModel(input(status(l))).tone, t, l);
  }
  assert.deepEqual(lightLabel('local'), { label: 'Local ready', tone: 'on' });
  assert.deepEqual(lightLabel('off'), { label: 'Off', tone: 'off' });
});

test('chip text: plain, scoped, and no overclaim', () => {
  const lights: BlenderLight[] = ['off', 'not-found', 'needs-setup', 'disconnected', 'connected', 'sandbox', 'local', 'busy', 'error'];
  const all = [BLENDER_CHIP_TIP, BLENDER_UNKNOWN, ...lights.flatMap((l) => { const m = chipModel(input(status(l, { enabled: l !== 'off' }))); return [m.label, m.text, m.title, m.actionLabel]; })];
  for (const t of all) assert.ok(!/\b(safe|safely|secure|secured|verified|guarantee|protected)\b/i.test(t), `no overclaim in: ${t}`);
  assert.equal(BLENDER_CHIP_TIP, 'Blender scripts run on this computer with your rights; every script needs your OK');
});

// ---- the real component, rendered with the store replaced by a spy ----
interface Rendered { html: string; buttons: Array<{ label?: string; role?: string; disabled?: boolean; onClick?: () => void }>; calls: Array<[string, unknown]> }
type RenderFn = (state: Record<string, unknown>) => Rendered;

async function loadChip(): Promise<{ render: RenderFn; cleanup: () => void }> {
  const jsxReal = createRequire(join(REPO, 'package.json')).resolve('react/jsx-runtime');
  const r = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { BlenderChip } from ${JSON.stringify(join(REPO, 'ui/src/blender/BlenderChip.tsx'))};
        export function render(state) { const g = globalThis; g.__st = state; g.__calls = []; g.__btns = []; const html = renderToStaticMarkup(createElement(BlenderChip)); return { html, buttons: g.__btns, calls: g.__calls }; }`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'chip-stubs',
      setup(b) {
        b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-shim', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\/blenderStore|\.\.\/store)$/ }, (a) => ({ path: a.path.includes('store') && a.path.startsWith('..') ? 'store-stub' : 'blender-stub', namespace: 'stub' }));
        b.onLoad({ filter: /^jsx-shim$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          import { jsx as j, jsxs as js, Fragment } from ${JSON.stringify(jsxReal)};
          const rec = (t, p) => { if (t === 'button') globalThis.__btns.push({ label: p['aria-label'], role: p.role, disabled: p.disabled, onClick: p.onClick }); };
          export const jsx = (t, p, k) => { rec(t, p); return j(t, p, k); };
          export const jsxs = (t, p, k) => { rec(t, p); return js(t, p, k); };
          export { Fragment };` }));
        b.onLoad({ filter: /^store-stub$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `export const openSettings = (s) => { globalThis.__calls.push(['openSettings', s]); };` }));
        b.onLoad({ filter: /^blender-stub$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
          export const useBlender = (sel) => sel(globalThis.__st);
          export const saveBlenderConfig = async (p) => { globalThis.__calls.push(['saveBlenderConfig', p]); };` }));
      },
    }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'chip-'));
  const file = join(dir, 'chip.cjs');
  writeFileSync(file, r.outputFiles[0].text);
  const mod = createRequire(file)(file) as { render: RenderFn };
  return { render: mod.render, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const uiState = (st: unknown, over: Record<string, unknown> = {}) => ({ status: st, loaded: true, busy: null, error: null, failed: false, absent: false, ...over });

test('the chip switch calls saveBlenderConfig({ enabled }) - the same function as the Settings switch - and opens Settings, Blender from the status button', async () => {
  const { render, cleanup } = await loadChip();
  try {
    const off = render(uiState(status('off', { enabled: false })));
    off.buttons.find((b) => b.role === 'switch')!.onClick!();
    assert.deepEqual(off.calls, [['saveBlenderConfig', { enabled: true }]]);
    const on = render(uiState(status('local', { selected: v510 })));
    on.buttons.find((b) => b.role === 'switch')!.onClick!();
    assert.deepEqual(on.calls, [['saveBlenderConfig', { enabled: false }]]);
    const nf = render(uiState(status('not-found')));
    const get = nf.buttons.find((b) => b.label?.startsWith('Blender not found'))!;
    get.onClick!();
    assert.deepEqual(nf.calls, [['openSettings', 'blender']]); // opens Settings only: nothing is downloaded from here
    assert.match(nf.html, /Get Blender/);
    assert.match(nf.html, /role="switch"/);
    assert.match(nf.html, /aria-checked="true"/);
    assert.match(nf.html, new RegExp(BLENDER_CHIP_TIP));
    // unknown: the switch is disabled and the label is the honest one
    const un = render(uiState(status('local'), { failed: true }));
    assert.match(un.html, /Blender: unknown/);
    assert.equal(un.buttons.find((b) => b.role === 'switch')!.disabled, true);
    // an older core without the module: nothing at all
    const none = render(uiState(null, { loaded: false, failed: true, absent: true }));
    assert.equal(none.html, '');
    assert.deepEqual(none.buttons, []);
  } finally { cleanup(); }
});

test('source: one write path. Settings and the chip both use saveBlenderConfig; the chip has no request of its own', () => {
  const chip = read('ui/src/blender/BlenderChip.tsx');
  const settings = read('ui/src/components/Settings.tsx');
  assert.match(settings, /saveBlenderConfig\(\{ enabled: e\.target\.checked \}\)/);
  assert.match(chip, /saveBlenderConfig\(\{ enabled: !m\.enabled \}\)/);
  assert.match(chip, /import \{[^}]*saveBlenderConfig[^}]*\} from '\.\/blenderStore'/);
  assert.ok(!/\brequest\(|\bfetch\(|runBlenderGet|runBlenderSetup|runBlenderLaunch|XMLHttpRequest/.test(chip), 'the chip never calls the core itself and never starts a download');
  assert.ok(!/confirm\(|window\.prompt|showModal/.test(settings.slice(settings.indexOf('function BlenderSection'), settings.indexOf('function ConnectionsSection'))), 'Settings asks no confirmation for the switch, so the chip needs none');
});

test('source: mounted in the title bar right after the BSV chip (BSV's narrow-window slot draws over what sits before it) and before Doctor; focus ring and narrow-window rules exist', () => {
  const tb = read('ui/src/components/TitleBar.tsx');
  assert.ok(tb.indexOf('<BlenderChip />') > 0 && tb.indexOf('<BsvChip />') < tb.indexOf('<BlenderChip />') && tb.indexOf('<BlenderChip />') < tb.indexOf('className={`tb-doctor'));
  const css = read('ui/src/blender/blender.css');
  assert.match(css, /\.tb-bl-status:focus-visible, \.tb-bl-switch:focus-visible \{ outline: 2px/);
  assert.match(css, /@media \(max-width: 1279px\)[^}]*\.tb-bl-text, \.tb-bl-label \{ display: none; \}/);
  assert.match(css, /:root\[data-theme='light'\] \{ --bl:/);
});
