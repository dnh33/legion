/**
 * The title-bar Blender chip: the view-model table (every light, plus unknown, failed and absent), the rule that the chip's switch goes through
 * the same function as the Settings switch (a real render of BlenderChip.tsx with a spy in place of the store), and the wording guards.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
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
    ['off', input(status('off', { enabled: false })), { tone: 'off', enabled: false, label: 'Blender: Off', settingsText: 'Open Blender settings', action: 'settings' }],
    ['off wins over a stale light', input(status('connected', { enabled: false })), { tone: 'off', enabled: false, label: 'Blender: Off' }],
    ['not found offers Get Blender (opens Settings)', input(status('not-found')), { tone: 'bad', enabled: true, label: 'Blender not found', settingsText: 'Get Blender', action: 'get' }],
    ['local ready with version', input(status('local', { selected: v510 })), { tone: 'on', label: 'Ready: this computer, Blender 5.1.0' }],
    ['local ready without a version', input(status('local')), { tone: 'on', label: 'Ready: this computer' }],
    ['cloud VM', input(status('sandbox')), { tone: 'on', label: 'Ready: cloud VM' }],
    ['live connected', input(status('connected')), { tone: 'on', label: 'Live Blender connected' }],
    ['needs setup', input(status('needs-setup')), { tone: 'warn', label: 'Blender needs setup', settingsText: 'Set up in Settings', action: 'setup' }],
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
  const all = [BLENDER_CHIP_TIP, BLENDER_UNKNOWN, ...lights.flatMap((l) => { const m = chipModel(input(status(l, { enabled: l !== 'off' }))); return [m.label, m.settingsText, m.title, m.actionLabel]; })];
  for (const t of all) assert.ok(!/\b(safe|safely|secure|secured|verified|guarantee|protected)\b/i.test(t), `no overclaim in: ${t}`);
  assert.equal(BLENDER_CHIP_TIP, 'Blender scripts run on this computer with your rights; every script needs your OK');
});

// ---- the real component, rendered with the store replaced by a spy ----
interface Rendered { html: string; pop: string; pill: Array<{ label?: string; onClick?: () => void }>; buttons: Array<{ label?: string; role?: string; className?: string; disabled?: boolean; onClick?: () => void }>; calls: Array<[string, unknown]> }
type RenderFn = (state: Record<string, unknown>) => Rendered;

async function loadChip(): Promise<{ render: RenderFn; cleanup: () => void }> {
  const jsxReal = createRequire(join(REPO, 'package.json')).resolve('react/jsx-runtime');
  const r = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { BlenderChip, BlenderPopover } from ${JSON.stringify(join(REPO, 'ui/src/blender/BlenderChip.tsx'))};
        import { chipModel } from ${JSON.stringify(join(REPO, 'ui/src/blender/chipModel.ts'))};
        export function render(state) {
          const g = globalThis; g.__st = state; g.__calls = []; g.__btns = [];
          const html = renderToStaticMarkup(createElement(BlenderChip));
          const pillButtons = g.__btns; g.__btns = [];
          const m = chipModel({ status: state.status, loaded: state.loaded, failed: state.failed, absent: state.absent, busy: state.busy !== null });
          const pop = m.visible ? renderToStaticMarkup(createElement(BlenderPopover, { m, onSettings: () => g.__calls.push(['openSettings', 'blender']) })) : '';
          return { html, pop, pill: pillButtons, buttons: g.__btns, calls: g.__calls };
        }`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'chip-stubs',
      setup(b) {
        b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-shim', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\/blenderStore|\.\.\/store)$/ }, (a) => ({ path: a.path.includes('store') && a.path.startsWith('..') ? 'store-stub' : 'blender-stub', namespace: 'stub' }));
        b.onLoad({ filter: /^jsx-shim$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          import { jsx as j, jsxs as js, Fragment } from ${JSON.stringify(jsxReal)};
          const rec = (t, p) => { if (t === 'button') globalThis.__btns.push({ label: p['aria-label'], role: p.role, className: p.className, disabled: p.disabled, onClick: p.onClick }); };
          export const jsx = (t, p, k) => { rec(t, p); return j(t, p, k); };
          export const jsxs = (t, p, k) => { rec(t, p); return js(t, p, k); };
          export { Fragment };` }));
        b.onLoad({ filter: /^store-stub$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `export const openSettings = (s) => { globalThis.__calls.push(['openSettings', s]); };` }));
        b.onLoad({ filter: /^blender-stub$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
          export const useBlender = (sel) => sel(globalThis.__st);
          export const saveBlenderConfig = async (p) => { globalThis.__calls.push(['saveBlenderConfig', p]); };
          export const requestEnableBlender = () => { globalThis.__calls.push(['requestEnableBlender']); };` }));
      },
    }],
  });
  const dir = cleanupTemp('chip-');
  const file = join(dir, 'chip.cjs');
  writeFileSync(file, r.outputFiles[0].text);
  const mod = createRequire(file)(file) as { render: RenderFn };
  return { render: mod.render, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const uiState = (st: unknown, over: Record<string, unknown> = {}) => ({ status: st, loaded: true, busy: null, error: null, failed: false, absent: false, ...over });

test('the pill is one quiet button; its popover switch asks first when turning ON, writes enabled:false when turning OFF, and Get Blender only opens Settings', async () => {
  const { render, cleanup } = await loadChip();
  try {
    const off = render(uiState(status('off', { enabled: false })));
    assert.equal(off.pill.length, 1, 'one button in the title bar');
    assert.match(off.html, /aria-expanded="false"/);
    assert.match(off.html, />Blender</);
    assert.ok(!/role="switch"/.test(off.html), 'no switch sits in the title bar');
    off.buttons.find((b) => b.role === 'switch')!.onClick!();
    assert.deepEqual(off.calls, [['requestEnableBlender']]); // ON opens the dialog first and writes nothing
    assert.match(off.pop, /Turn on the Blender bridge/);
    const on = render(uiState(status('local', { selected: v510 })));
    on.buttons.find((b) => b.role === 'switch')!.onClick!();
    assert.deepEqual(on.calls, [['saveBlenderConfig', { enabled: false }]]);
    assert.match(on.pop, /aria-checked="true"/);
    assert.match(on.pop, /Ready: this computer, Blender 5\.1\.0/);
    const nf = render(uiState(status('not-found')));
    assert.match(nf.pop, /Blender not found/);
    assert.match(nf.pop, />Get Blender</);
    assert.ok(nf.buttons.some((b) => /btn sm/.test(b.className ?? '')), 'the Settings button exists');
    assert.match(nf.pop, new RegExp(BLENDER_CHIP_TIP));
    // unknown: the switch is disabled and the label is the honest one
    const un = render(uiState(status('local'), { failed: true }));
    assert.match(un.pop, /Blender: unknown/);
    assert.equal(un.buttons.find((b) => b.role === 'switch')!.disabled, true);
    // an older core without the module: nothing at all
    const none = render(uiState(null, { loaded: false, failed: true, absent: true }));
    assert.equal(none.html, '');
    assert.deepEqual(none.buttons, []);
  } finally { cleanup(); }
});

test('source: one write path. Settings and the chip both go through requestEnableBlender; the chip has no request of its own', () => {
  const chip = read('ui/src/blender/BlenderChip.tsx');
  const settings = read('ui/src/components/Settings.tsx');
  assert.match(settings, /if \(e\.target\.checked\) requestEnableBlender\(\); else void saveBlenderConfig\(\{ enabled: false \}\)/);
  assert.match(chip, /if \(m\.enabled\) void saveBlenderConfig\(\{ enabled: false \}\); else requestEnableBlender\(\)/);
  assert.match(chip, /import \{[^}]*saveBlenderConfig[^}]*\} from '\.\/blenderStore'/);
  assert.ok(!/\brequest\(|\bfetch\(|runBlenderGet|runBlenderSetup|runBlenderLaunch|XMLHttpRequest/.test(chip), 'the chip never calls the core itself and never starts a download');
});

test('source: mounted in the title bar right after the BSV chip (its narrow-window slot draws over what sits before it) and before Doctor; focus ring and narrow-window rules exist', () => {
  const tb = read('ui/src/components/TitleBar.tsx');
  assert.ok(tb.indexOf('<BlenderChip />') > 0 && tb.indexOf('<BsvChip />') < tb.indexOf('<BlenderChip />') && tb.indexOf('<BlenderChip />') < tb.indexOf('className={`tb-doctor'));
  const css = read('ui/src/blender/blender.css');
  const chipSrc = read('ui/src/blender/BlenderChip.tsx');
  assert.match(css, /:root\[data-kbd-nav\] \.tb-bl-pill:focus-visible, :root\[data-kbd-nav\] \.bl-pop button:focus-visible \{ outline: 2px/);
  assert.match(css, /@media \(max-width: 1279px\) \{ \.tb-bl-word \{ display: none; \}/);
  assert.ok(!/#f5792a|--bl\b/.test(css), 'no colour of its own: the app tokens only');
  assert.match(chipSrc, /openSettings\('blender'\)/);
});
