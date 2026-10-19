/**
 * The 0.2.6-s controls, rendered for real (React server render of the actual components, stores stubbed): the task-list
 * switch and the .env setting in the agent editor, the approval card's Remember choices, and a provider's tool-calls choice.
 * The same harness as gates-ui.test.ts: what the owner sees is checked, not only the logic behind it.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const agent = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, emoji: name[0], approval: 'ask', description: '', systemPrompt: '', model: 'auto', mcpServers: ['*'],
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, createdAt: '', updatedAt: '', ...over,
});
const AGENTS = [
  agent('zealot', 'Marshal', { host: { enabled: true, rootDir: 'D:/work/site' } }),
  agent('scout', 'Scout'),
  agent('builder', 'Builder', { host: { enabled: true, envFiles: 'block' }, taskList: 'on' }),
];

async function loadUi(): Promise<Record<string, (...a: any[]) => string>> {
  const ui = (p: string) => JSON.stringify(join(REPO, p));
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { AgentEditor } from ${ui('ui/src/components/AgentEditor.tsx')};
        import { ApprovalCard, RememberChoices } from ${ui('ui/src/components/ApprovalCard.tsx')};
        import { ProvidersSection } from ${ui('ui/src/providers/ProvidersSection.tsx')};
        const render = (el) => renderToStaticMarkup(el);
        export const editor = (id) => render(createElement(AgentEditor, { id }));
        export const card = (a) => render(createElement(ApprovalCard, { a }));
        export const remember = (a) => render(createElement(RememberChoices, { a }));
        export const providers = () => render(createElement(ProvidersSection));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        const stub = (filter: RegExp, name: string, contents: string) => {
          b.onResolve({ filter }, () => ({ path: name, namespace: 'stub' }));
          b.onLoad({ filter: new RegExp(`^${name}$`), namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents }));
        };
        stub(/providersStore$/, 'providers-store', `
          export const providerModelGroups = () => []; export const providerModelLabel = (m) => m;
          export const useProviders = (sel) => sel(globalThis.__prov);
          export const getProviders = () => globalThis.__prov; export const loadProviders = async () => {};
          export const refreshModels = async () => {}; export const removeKey = async () => {}; export const removeProvider = async () => {};
          export const saveEntry = async () => true; export const saveKey = async () => {}; export const saveLimits = async () => {}; export const testProvider = async () => {}; export const startOverKeys = async () => false;`);
        stub(/armory\/AgentSkills$/, 'agent-skills', `export const AgentSkills = () => null; export const settingOf = (v) => v ?? 'inherit'; export const valueOf = () => ({ mode: 'inherit' });`);
        stub(/armory\/armoryStore$/, 'armory-store', `export const revealSkill = () => {};`);
        stub(/rooms\/roomsStore$/, 'rooms-store', `export const openRoom = () => {}; export const useRoomName = () => 'a room';`);
        stub(/^(\.\.\/)*store$/, 'store', `
          export const useStore = (sel) => sel(globalThis.__st);
          export const decide = async () => {}; export const rememberGate = async () => {};
          export const errText = (e) => String(e); export const toast = () => {};
          export const saveAgent = async () => {}; export const removeAgent = async () => {};
          export const closeOverlays = () => {}; export const openSettings = () => {}; export const loadCatalog = async () => {};
          export const openEditor = () => {}; export const selectAgent = () => {};`);
      },
    }],
  });
  const dir = cleanupTemp('release-ui-');
  const file = join(dir, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  const g = globalThis as Record<string, unknown>;
  g.__st = { agents: AGENTS, projects: [], catalog: null, boatHealth: null, view: 'agents' };
  g.__prov = {
    busy: null, error: null, notes: {},
    view: { providers: [{ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, preset: true, needsKey: true, keySet: true, keyMatchesAddress: true, keyless: false, allowPrivateNetwork: false, wire: 'chat', toolCalls: 'prompted', loopback: false, models: [], hasPrices: false, status: 'ready' }], maxTurns: 40, maxToolCallsPerTurn: 8, dropped: [], cannotDo: [] },
  };
  // some UI modules register a listener or a timer when they load; a server render needs only that they do not throw
  if (!('window' in g)) {
    const noop = () => undefined;
    g.window = { addEventListener: noop, removeEventListener: noop, setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }), location: { search: '', hash: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }, history: { replaceState: noop } };
  }
  if (!('document' in g)) g.document = { hidden: true, addEventListener: noop2, removeEventListener: noop2 };
  return createRequire(file)(file) as Record<string, (...a: any[]) => string>;
}

const noop2 = (): undefined => undefined;
const selected = (html: string, label: RegExp): boolean => [...html.matchAll(/<option[^>]*>[^<]*<\/option>/g)].some((m) => /selected=""/.test(m[0]) && label.test(m[0]));
const req = (toolName: string, input: Record<string, unknown>, agentId = 'builder') => ({ id: 'ap1', taskId: 't1', agentId, toolName, summary: 'x', input, at: '' });

test('agent editor: the task-list switch shows the default (on for the Marshal, off for others) and an explicit choice', async () => {
  const r = await loadUi();
  const lead = r.editor('zealot');
  assert.match(lead, /Keep a task list on Claude/);
  assert.match(lead, /<input type="checkbox" checked=""[^>]*\/> Keep a task list on Claude/, 'the Marshal: on by default');
  assert.doesNotMatch(r.editor('scout'), /checked=""[^>]*\/> Keep a task list on Claude/, 'another agent: off by default');
  assert.match(r.editor('builder'), /checked=""[^>]*\/> Keep a task list on Claude/, 'an explicit on');
});

test('agent editor: the .env setting shows masked by default and the saved choice otherwise', async () => {
  const r = await loadUi();
  const lead = r.editor('zealot');
  assert.match(lead, /\.env files/);
  assert.ok(selected(lead, /Masked/), 'masked when nothing is saved');
  assert.ok(selected(r.editor('builder'), /Blocked/), 'the saved block');
  assert.match(lead, /\.env\.example and other templates are ordinary files/);
});

test('approval card: Remember is offered on an ordinary card, never on a rail card; its choices read as the rule', async () => {
  const r = await loadUi();
  assert.match(r.card(req('Bash', { command: 'git status -s' })), /Remember…/);
  assert.doesNotMatch(r.card(req('mcp__legion_blender__blender_exec', { code: 'x' })), /Remember…/, 'a Blender script is never remembered');
  const choices = r.remember(req('Bash', { command: 'git status -s' }));
  assert.match(choices, /Always allow: Builder may run `git status` with any arguments/);
  assert.match(choices, /Always block: Builder may never run `git status` with any arguments/);
  assert.match(choices, /An allow never applies to a run another bot or Claude Code started/);
  const wildcard = r.remember(req('Bash', { command: 'python *.py' }));
  assert.doesNotMatch(wildcard, /Always allow/, 'no allow for a runner with a wildcard');
  assert.match(wildcard, /Always block/);
});

test('providers: the tool-calls choice shows the saved setting', async () => {
  const r = await loadUi();
  const html = r.providers();
  assert.match(html, /Tool calls/);
  assert.ok(selected(html, /Always in the prompt/));
});
