/**
 * Settings -> Safety, as rendered and as clicked: the reads switch only ASKS; the grant is written by the Confirm button alone (spec 4.8).
 * The component is bundled with esbuild and rendered with react-dom/server (store and grant calls stubbed). The element props are recorded as
 * the tree is built, so a test can fire the handler a click would fire and see which grant calls it makes.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { readsGrantRule } from '../ui/src/projects/page/settingsLogic.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PROJECT = { id: 'proj_aaaaaaaaaaaa', name: 'Shop', folder: 'C:\Shop' };
type G = { __rules?: unknown[]; __calls?: string[]; __els?: Record<string, Record<string, unknown>>; __asking?: boolean };
type Out = { html: string; calls: string[]; click: (id: string) => void };

async function loadSafety(): Promise<{ render: (rules: unknown[], asking: boolean) => Out; cleanup: () => void }> {
  const reactDir = createRequire(join(REPO, 'package.json')).resolve('react/jsx-runtime');
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { Safety } from ${JSON.stringify(join(REPO, 'ui/src/projects/page/SettingsTab.tsx'))};
        export const safety = (project) => renderToStaticMarkup(createElement(Safety, { project }));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'stubs',
      setup(b) {
        const stub = (filter: RegExp, name: string, contents: string) => {
          b.onResolve({ filter }, () => ({ path: name, namespace: 'stub' }));
          b.onLoad({ filter: new RegExp('^' + name + '$'), namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents }));
        };
        // records every element's props by id, so the handler a click would fire can be called without a browser
        stub(/^react\/jsx-runtime$/, 'jsx-spy', `
          const real = require(${JSON.stringify(reactDir)});
          const spy = (fn) => (type, props, key) => { if (props && props.id) (globalThis.__els ??= {})[props.id] = props; return fn(type, props, key); };
          exports.jsx = spy(real.jsx); exports.jsxs = spy(real.jsxs); exports.Fragment = real.Fragment;`);
        // the question is shown when the test says so: the first useState of Safety is "confirming"
        stub(/^react$/, 'react-spy', `
          const real = require(${JSON.stringify(createRequire(join(REPO, 'package.json')).resolve('react'))});
          module.exports = { ...real, useState: (i) => { const r = real.useState(i); if (globalThis.__n++ === 0 && globalThis.__asking) return [true, r[1]]; return r; } };`);
        stub(/(^|\/)store$/, 'store', `exports.useStore = (sel) => sel({ settings: { gates: { rules: globalThis.__rules, presetsVersion: 0 } } }); exports.loadSettings = async () => {};`);
        stub(/projectsStore$/, 'projects-store', `for (const n of ['archiveProject','changeMembers','chooseFolder','saveProject','unarchiveProject','useDefaultFolder']) exports[n] = async () => true;`);
        stub(/boardStore$/, 'board-store', `exports.loadMarshal = async () => {}; exports.saveMarshal = async () => {}; exports.useBoard = () => null;`);
        stub(/awayStore$/, 'away-store', `exports.patchAway = async () => {}; exports.projectAway = () => ({}); exports.setPaused = async () => {}; exports.useAway = () => ({});`);
        stub(/\/announce$/, 'announce', `exports.announce = () => {};`);
        stub(/useGatesView$/, 'use-gates-view', `exports.useGatesView = () => ({ view: null, apply: async () => ({ state: 'ok' }) }); exports.useGatesAction = () => ({ pending: false, note: null, run: async () => true }); exports.PENDING_TEXT = '';`);
        stub(/\/readsGrant$/, 'reads-grant', `exports.grantReads = async (p) => { globalThis.__calls.push('grant'); return true; }; exports.revokeReads = async (p) => { globalThis.__calls.push('revoke'); return true; };`);
      },
    }],
  });
  const dir = cleanupTemp('settings-safety-ui-');
  const file = join(dir, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  const mod = createRequire(file)(file) as { safety: (p: unknown) => string };
  const g = globalThis as G;
  return {
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    render: (rules, asking) => {
      g.__rules = rules; g.__asking = asking; (g as { __n?: number }).__n = 0; g.__calls = []; g.__els = {};
      const html = mod.safety(PROJECT);
      const els = g.__els; const calls = g.__calls;
      return { html, calls, click: (id) => { (els[id]!.onClick as () => void)(); } };
    },
  };
}

test('the reads switch only asks: turning it on never writes the grant; only Confirm does', async () => {
  const { render, cleanup } = await loadSafety();
  try {
    const off = render([], false);
    assert.equal(off.calls.length, 0, 'drawing the section grants nothing');
    try { off.click('safe-reads-sw'); } catch { /* the question state is not drawn by a static render; the grant calls are what matter */ }
    assert.deepEqual(off.calls, [], 'the switch alone must not call grantReads');
    const asking = render([], true);
    assert.match(asking.html, /data-testid="reads-confirm"/);
    assert.equal(asking.calls.length, 0, 'the question is on screen and nothing is granted yet');
    asking.click('safe-reads-confirm');
    assert.deepEqual(asking.calls, ['grant'], 'Confirm writes the grant');
  } finally { cleanup(); }
});

test('the switch says what is true: while the question is open it is not "on", it is expanded; once granted it is on', async () => {
  const { render, cleanup } = await loadSafety();
  try {
    const sw = (html: string) => /<button[^>]*id="safe-reads-sw"[^>]*>/.exec(html)![0];
    const off = sw(render([], false).html);
    assert.match(off, /aria-checked="false"/); assert.match(off, /aria-expanded="false"/);
    const asking = sw(render([], true).html);
    assert.match(asking, /aria-checked="false"/, 'asking is not granting');
    assert.match(asking, /aria-expanded="true"/);
    const on = render([readsGrantRule(PROJECT, 'gr_000000000001')], false);
    assert.match(sw(on.html), /aria-checked="true"/); assert.match(sw(on.html), /aria-expanded="false"/);
    on.click('safe-reads-sw');
    assert.deepEqual(on.calls, ['revoke'], 'turning a granted switch off revokes');
  } finally { cleanup(); }
});
