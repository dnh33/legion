/**
 * Task 13: the first-run preset screen. The pure logic (when it shows, what Continue sends, what the words say), the store field
 * that remembers the answer, and a real render of the screen through esbuild + react-dom/server.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import { PRESET_STRINGS, presetSubmit, shouldShowPresetChoice } from '../ui/src/welcome/presetChoiceLogic.js';
import { KEYSTORE_LINE, presetChoices } from '../ui/src/gates/presetsLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const view = (o: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...o });
const dir = () => join(cleanupTemp('legion-welcome-preset-'), 'gates');
const KEY = makeSigner(Buffer.alloc(32, 7))!;

test('shouldShowPresetChoice: a fresh install yes; an existing install with any preset or the flag no; before the welcome is done no', () => {
  assert.equal(shouldShowPresetChoice(view(), true), true, 'fresh install, sign-in done');
  assert.equal(shouldShowPresetChoice(view(), false), false, 'the sign-in step comes first');
  assert.equal(shouldShowPresetChoice(view({ app: { version: 1, firstRunChoice: true } }), true), false, 'answered once');
  assert.equal(shouldShowPresetChoice(view({ app: { version: 1, preset: 'smart' } }), true), false, 'the app already has a preset');
  assert.equal(shouldShowPresetChoice(view({ projects: { proj_000000000001: { version: 1, preset: 'ask' } } }), true), false, 'a project already has a preset');
  assert.equal(shouldShowPresetChoice(view({ projects: { proj_000000000001: { version: 1 } } }), true), true, 'a project with no preset changes nothing');
});

test('Enter on the default keeps Ask and writes firstRunChoice', () => {
  const p = presetSubmit('ask');
  assert.deepEqual(p.patch, { preset: 'ask', firstRunChoice: true });
  assert.equal(p.needsConfirm, false, 'Ask is the safest: no dialog');
});

test('a looser choice returns a patch that needs the native confirm', () => {
  for (const c of presetChoices().filter((x) => x.looser)) {
    const p = presetSubmit(c.id);
    assert.equal(p.needsConfirm, true, c.id);
    assert.deepEqual(p.patch, { preset: c.id, firstRunChoice: true });
  }
});

test('the screen strings have no em dash and say "your computer" never "this computer"', () => {
  const all = [...Object.values(PRESET_STRINGS), ...presetChoices().map((c) => c.line), KEYSTORE_LINE].join('\n');
  assert.doesNotMatch(all, /—/);
  assert.doesNotMatch(all, /this computer/i);
  assert.equal(PRESET_STRINGS.title, 'How should your agents ask?');
  assert.equal(PRESET_STRINGS.note, 'You can change this any time in Settings, Gates.');
  assert.equal(PRESET_STRINGS.continue, 'Continue');
});

test('the store accepts firstRunChoice and noticeSeen only on the app file, only true', () => {
  const s = new GatesStore(dir(), { allowed: ['ask'] });
  assert.deepEqual(s.patchApp({ preset: 'ask', firstRunChoice: true }), { version: 1, preset: 'ask', firstRunChoice: true });
  assert.deepEqual(s.patchApp({ noticeSeen: true }), { version: 1, preset: 'ask', firstRunChoice: true, noticeSeen: true });
  for (const bad of [false, 'yes', 1, null]) {
    assert.throws(() => s.patchApp({ firstRunChoice: bad }), (e: unknown) => e instanceof GatesError && e.status === 400, `firstRunChoice ${String(bad)}`);
    assert.throws(() => s.patchApp({ noticeSeen: bad }), (e: unknown) => e instanceof GatesError && e.status === 400, `noticeSeen ${String(bad)}`);
  }
  assert.throws(() => s.patchProject('proj_000000000001', { firstRunChoice: true }), (e: unknown) => e instanceof GatesError && e.status === 400);
  assert.throws(() => s.patchProject('proj_000000000001', { noticeSeen: true }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('firstRunChoice is not a loosening, is persisted, and a fresh store reads it back', async () => {
  const d = dir();
  const s = new GatesStore(d, { allowed: ['ask'] });
  assert.equal(s.isLoosening('app', { preset: 'ask', firstRunChoice: true }), false);
  assert.equal(s.isLoosening('app', { noticeSeen: true }), false);
  s.patchApp({ preset: 'ask', firstRunChoice: true, noticeSeen: true });
  await s.flush();
  const file = JSON.parse(readFileSync(join(d, 'app.json'), 'utf8'));
  assert.equal(file.firstRunChoice, true); assert.equal(file.noticeSeen, true);
  assert.deepEqual(new GatesStore(d, { allowed: ['ask'] }).app(), { version: 1, preset: 'ask', firstRunChoice: true, noticeSeen: true });
  // a file that holds the flag as anything but true is damaged
  writeFileSync(join(d, 'app.json'), JSON.stringify({ version: 1, firstRunChoice: 'yes' }));
  const bad = new GatesStore(d, { allowed: ['ask'] });
  assert.deepEqual(bad.view([]).unreadable, ['app']);
});

test('firstRunChoice is signed with the rest of the app file', async () => {
  const d = dir();
  const s = new GatesStore(d, { allowed: ['ask', 'smart'], signer: KEY });
  s.patchApp({ preset: 'ask', firstRunChoice: true });
  await s.flush();
  const file = JSON.parse(readFileSync(join(d, 'app.json'), 'utf8'));
  assert.equal(file.firstRunChoice, true);
  assert.match(String(file.sig), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- real render

type Render = Record<string, (...args: any[]) => string>;
async function loadUi(): Promise<{ r: Render; cleanup: () => void }> {
  const ui = (p: string) => JSON.stringify(join(REPO, p));
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { PresetChoiceView } from ${ui('ui/src/welcome/PresetChoice.tsx')};
        export const screen = (view, state) => renderToStaticMarkup(createElement(PresetChoiceView, { view, ...state, onPick: () => {}, onContinue: () => {}, onLater: () => {} }));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        b.onResolve({ filter: /useGatesView$/ }, () => ({ path: 'use-gates-view', namespace: 'stub' }));
        b.onLoad({ filter: /^use-gates-view$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const useGatesView = () => ({ view: null, loadError: null, reload: async () => {}, apply: async () => ({ state: 'ok' }) });
          export const useGatesAction = () => ({ pending: false, note: null, run: async () => true });
          export const reloadGatesFromDisk = async () => {}; export const PENDING_TEXT = 'Waiting for you to confirm in the window';` }));
      },
    }],
  });
  const d = cleanupTemp('welcome-preset-ui-');
  const file = join(d, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  return { r: createRequire(file)(file) as Render, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('render: four radio rows, Ask preselected, Continue, Decide later, the note', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const html = r.screen(view(), { selected: 'ask', busy: false, note: null }).replace(/&#x27;/g, "'");
    assert.match(html, /How should your agents ask\?/);
    for (const c of presetChoices()) { assert.ok(html.includes(`>${c.label}<`), c.label); assert.ok(html.includes(c.line), `${c.label} line`); }
    assert.equal((html.match(/type="radio"/g) ?? []).length, 4);
    assert.match(html, /value="ask"[^>]*checked=""|checked=""[^>]*value="ask"/);
    assert.match(html, />Continue</);
    assert.match(html, />Decide later</);
    assert.match(html, /You can change this any time in Settings, Gates\./);
  } finally { cleanup(); }
});

test('render: looser rows are off with the keystore reason when Legion cannot sign; a failure shows its message', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const html = r.screen(view({ canSign: false }), { selected: 'ask', busy: false, note: { tone: 'error', text: 'The change was not made.' } });
    assert.equal((html.match(/disabled=""/g) ?? []).length >= 3, true, 'three looser rows disabled');
    assert.ok(html.includes(KEYSTORE_LINE));
    assert.match(html, /The change was not made\./);
    assert.match(html, /role="alert"/);
  } finally { cleanup(); }
});
