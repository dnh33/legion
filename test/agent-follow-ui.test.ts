/**
 * Task 14: how agents ask is visible, always. The agent editor's "Follow project" field and its per-project lines, the project settings
 * section and one-time notice, and the chips on a run header (Runs as, web). Pure logic first, then the routes, then real renders.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe, it } from 'node:test';
import { build } from 'esbuild';
import { AUTH, makeFakes, start } from './helpers-c.js';
import { PROJECT_NOTICE, agentProjectLines, approvalPatch, choiceOf, runChips, shouldShowProjectNotice } from '../ui/src/gates/agentFollowLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';
import type { Project } from '../src/shared/projects.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const P_SHOP = 'proj_00000000000a';
const P_BLOG = 'proj_00000000000b';
const view = (o: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...o });
const project = (id: string, name: string, members: string[]): Project => ({ id, name, instructions: '', folder: 'D:/p/' + name, members, status: 'active', createdAt: '', updatedAt: '' });
const PROJECTS = [project(P_SHOP, 'Shop', ['a1']), project(P_BLOG, 'Blog', ['a1', 'a2'])];

// ---------------------------------------------------------------- the choice and what a save sends

test('a new agent is created with approvalSource project; loading an existing agent keeps own', () => {
  assert.equal(choiceOf(undefined), 'project', 'a new agent starts on Follow project');
  assert.deepEqual(approvalPatch(undefined, 'project'), { approval: 'ask', approvalSource: 'project' }, 'the create call sends the source');
  assert.deepEqual(approvalPatch(undefined, 'full'), { approval: 'full', approvalSource: 'own' });
  // an agent made before this version: no source stored, and saving without touching the field sends nothing
  const old = { approval: 'full' as const };
  assert.equal(choiceOf(old), 'full');
  assert.deepEqual(approvalPatch(old, 'full'), {}, 'loading and saving never rewrites the source');
  assert.deepEqual(approvalPatch({ approval: 'auto-edits', approvalSource: 'own' }, 'auto-edits'), {});
  assert.deepEqual(approvalPatch({ approval: 'ask', approvalSource: 'project' }, 'project'), {});
  // a real change
  assert.deepEqual(approvalPatch(old, 'project'), { approvalSource: 'project' }, 'following keeps the agent\'s own mode');
  assert.deepEqual(approvalPatch({ approval: 'ask', approvalSource: 'project' }, 'full'), { approval: 'full', approvalSource: 'own' });
  assert.deepEqual(approvalPatch(old, 'ask'), { approval: 'ask', approvalSource: 'own' });
});

test('the editor line lists each project with the effective mode and the reason', () => {
  const v = view({ projects: { [P_SHOP]: { version: 1, preset: 'ask', limit: true }, [P_BLOG]: { version: 1 } } });
  // Full on its own: limited to Ask in Shop, free in Blog (no preset there)
  assert.equal(agentProjectLines({ id: 'a1', approval: 'full', source: 'own' }, PROJECTS, v), 'In Shop: runs as Ask (project limit). In Blog: Full.');
  // following: Shop has a preset, Blog does not (the app default decides)
  const v2 = view({ app: { version: 1, preset: 'smart' }, projects: { [P_SHOP]: { version: 1, preset: 'accept-edits' }, [P_BLOG]: { version: 1 } } });
  assert.equal(agentProjectLines({ id: 'a1', approval: 'ask', source: 'project' }, PROJECTS, v2), 'In Shop: runs as Accept edits (project preset). In Blog: runs as Smart (app default).');
  // only the projects the agent is in
  assert.equal(agentProjectLines({ id: 'a2', approval: 'ask', source: 'own' }, PROJECTS, v), 'In Blog: Ask.');
  // no project: nothing for an own mode, the app default for a follower
  assert.equal(agentProjectLines({ id: 'a9', approval: 'full', source: 'own' }, PROJECTS, v), '');
  assert.equal(agentProjectLines({ id: null, approval: 'ask', source: 'project' }, PROJECTS, v), 'Not in a project, so it follows the app default: Ask.');
  assert.equal(agentProjectLines({ id: 'a1', approval: 'ask', source: 'own' }, PROJECTS, null), '', 'nothing is guessed before the settings are known');
});

test('the notice shows once for an install with projects and never for a fresh install', () => {
  assert.equal(shouldShowProjectNotice(view(), 3), true, 'an install that had projects, nothing set yet');
  assert.equal(shouldShowProjectNotice(view(), 0), false, 'no project yet');
  assert.equal(shouldShowProjectNotice(view({ app: { version: 1, noticeSeen: true } }), 3), false, 'dismissed');
  assert.equal(shouldShowProjectNotice(view({ app: { version: 1, firstRunChoice: true } }), 3), false, 'a fresh install answered the first-run screen');
  assert.equal(shouldShowProjectNotice(view({ app: { version: 1, preset: 'ask' } }), 3), false, 'the owner already set something');
  assert.equal(shouldShowProjectNotice(view({ projects: { [P_SHOP]: { version: 1, preset: 'smart' } } }), 3), false);
  assert.equal(PROJECT_NOTICE.text, 'Projects can now set how agents ask. Nothing changed: each of your agents keeps the setting it had. You can look at it in Settings, Gates.');
  assert.doesNotMatch(PROJECT_NOTICE.text + PROJECT_NOTICE.dismiss, /\u2014|this computer/i);
});

test('the chip text on a run header uses runsAsChip with the start project, not the live one', () => {
  const v = view({ projects: { [P_SHOP]: { version: 1, preset: 'ask', limit: true }, [P_BLOG]: { version: 1, preset: 'bypass', limit: true } } });
  // the run started in Shop; the task has since moved to Blog
  const task = { runsAs: { mode: 'ask' as const, projectId: P_SHOP }, projectId: P_BLOG };
  const bare = (r: { title?: string } | undefined) => { const { title: _t, ...rest } = r ?? {}; return rest; };
  const c = runChips(task, { approval: 'full', approvalSource: 'own' }, PROJECTS, v);
  assert.ok(c.runsAs?.title, 'the hover explains it');
  assert.deepEqual(bare(c.runsAs), { text: 'Runs as Ask', reason: 'Agent is Full, limited by project Shop' });
  const follow = runChips({ runsAs: { mode: 'full', projectId: P_BLOG } }, { approval: 'ask', approvalSource: 'project' }, PROJECTS, v);
  assert.deepEqual(bare(follow.runsAs), { text: 'Runs as Bypass', reason: 'Following project Blog (Bypass)', full: true });
  assert.deepEqual(bare(runChips({ runsAs: { mode: 'full' } }, { approval: 'full' }, PROJECTS, v).runsAs), { text: 'Runs as Full', full: true }, 'Full on its own is Full, not Bypass');
  assert.deepEqual(bare(runChips({ runsAs: { mode: 'ask' } }, { approval: 'ask', approvalSource: 'project' }, PROJECTS, v).runsAs), { text: 'Runs as Ask', reason: 'Following the app default' });
  assert.equal(runChips({ runsAs: { mode: 'ask' }, origin: { roomId: 'r', fromAgentId: 'x', hop: 0, approvalCeiling: 'ask' } }, { approval: 'full' }, PROJECTS, v).runsAs?.reason, 'Started by an outside app: asks');
});

test('the web chip shows pages and new sites, and is hidden when the run read nothing', () => {
  const v = view();
  assert.equal(runChips({ web: { pages: 3, newSites: 1 } }, undefined, PROJECTS, v).web, 'web: 3 pages, 1 new site');
  assert.equal(runChips({ web: { pages: 1, newSites: 0 } }, undefined, PROJECTS, v).web, 'web: 1 page, 0 new sites');
  assert.equal(runChips({ web: { pages: 0, newSites: 0 } }, undefined, PROJECTS, v).web, undefined);
  assert.equal(runChips({}, undefined, PROJECTS, v).web, undefined);
  assert.deepEqual(runChips(undefined, undefined, PROJECTS, v), {});
});

// ---------------------------------------------------------------- the routes

describe('POST and PATCH /api/agents take approvalSource', () => {
  const f = makeFakes();
  let base = ''; let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
  after(async () => { await close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...AUTH, 'Content-Type': 'application/json' } });
  const post = (body: unknown) => api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
  const patch = (id: string, body: unknown) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  it('a create without it stays own (absent); with it the source is stored', async () => {
    const a = await (await post({ name: 'Plain' })).json();
    assert.equal(a.approvalSource, undefined);
    const b = await (await post({ name: 'Follower', approvalSource: 'project' })).json();
    assert.equal(b.approvalSource, 'project');
    assert.equal(f.ctx.store.getAgent(b.id)?.approvalSource, 'project', 'stored, so the engine reads it');
  });

  it('a patch without it leaves the source alone; project and own switch it; anything else is a 400', async () => {
    const a = await (await post({ name: 'Mover', approvalSource: 'project' })).json();
    const kept = await (await patch(a.id, { description: 'x' })).json();
    assert.equal(kept.approvalSource, 'project');
    const own = await (await patch(a.id, { approval: 'ask', approvalSource: 'own' })).json();
    assert.equal(own.approvalSource, 'own'); assert.equal(own.approval, 'ask');
    const r = await patch(a.id, { approvalSource: 'everyone' });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /approvalSource/);
  });
});

// ---------------------------------------------------------------- real renders

type Render = Record<string, (...args: any[]) => string>;
const unesc = (s: string): string => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
async function loadUi(state: Record<string, unknown>, gv: GatesView | null): Promise<{ r: Render; cleanup: () => void }> {
  const ui = (p: string) => JSON.stringify(join(REPO, p));
  const reactReal = createRequire(join(REPO, 'package.json')).resolve('react');
  void reactReal;
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { AgentEditor } from ${ui('ui/src/components/AgentEditor.tsx')};
        import { RunChips } from ${ui('ui/src/gates/RunChips.tsx')};
        import { AskSectionView, ProjectNoticeView } from ${ui('ui/src/projects/page/AskSection.tsx')};
        const render = (el) => renderToStaticMarkup(el);
        export const editor = (id) => render(createElement(AgentEditor, { id }));
        export const chips = (task, agent, projects, view) => render(createElement(RunChips, { task, agent, projects, view }));
        export const ask = (props) => render(createElement(AskSectionView, { run: async () => true, busy: false, note: null, ...props }));
        export const notice = (props) => render(createElement(ProjectNoticeView, { busy: false, note: null, onDismiss: () => {}, ...props }));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        b.onResolve({ filter: /providersStore$/ }, () => ({ path: 'providers-store', namespace: 'stub' }));
        b.onLoad({ filter: /^providers-store$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const providerModelGroups = () => []; export const providerModelLabel = (m) => m;
          export const loadProviders = async () => {}; export const useProviders = (sel) => sel({ view: null });` }));
        b.onResolve({ filter: /armory\/AgentSkills$/ }, () => ({ path: 'agent-skills', namespace: 'stub' }));
        b.onLoad({ filter: /^agent-skills$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const AgentSkills = () => null; export const settingOf = (v) => v ?? 'inherit'; export const valueOf = () => ({ mode: 'inherit' });` }));
        b.onResolve({ filter: /armory\/armoryStore$/ }, () => ({ path: 'armory-store', namespace: 'stub' }));
        b.onLoad({ filter: /^armory-store$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `export const revealSkill = () => {};` }));
        b.onResolve({ filter: /useGatesView$/ }, () => ({ path: 'use-gates-view', namespace: 'stub' }));
        b.onLoad({ filter: /^use-gates-view$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const useGatesView = () => ({ view: globalThis.__gv ?? null, loadError: null, reload: async () => {}, apply: async () => ({ state: 'ok' }) });
          export const useGatesAction = () => ({ pending: false, note: null, run: async () => true });
          export const loadWebHosts = async () => ({ lastUsed: {}, approvedAt: {} }); export const loadActivity = async () => []; export const reloadGatesFromDisk = async () => {};
          export const PENDING_TEXT = 'Waiting for you to confirm in the window';` }));
        b.onResolve({ filter: /announce$/ }, () => ({ path: 'announce', namespace: 'stub' }));
        b.onLoad({ filter: /^announce$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `export const announce = () => {};` }));
        b.onResolve({ filter: /^(\.\.\/)*store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const useStore = (sel) => sel(globalThis.__st);
          export const saveSettings = async () => {}; export const errText = (e) => (e && e.message) ? e.message : String(e);
          export const saveAgent = async () => {}; export const removeAgent = async () => {};
          export const closeOverlays = () => {}; export const openSettings = () => {}; export const loadCatalog = async () => {};
          export const toast = () => {}; export const openEditor = () => {}; export const selectAgent = () => {};` }));
      },
    }],
  });
  const dir = cleanupTemp('agent-follow-ui-');
  const file = join(dir, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  const g = globalThis as { __st?: unknown; __gv?: unknown };
  g.__st = state; g.__gv = gv;
  return { r: createRequire(file)(file) as Render, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const AGENT = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), emoji: id[0], description: '', systemPrompt: '', model: 'auto', approval: 'ask', mcpServers: ['*'], vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, createdAt: '', updatedAt: '', ...over });
const state = (agents: unknown[]) => ({ agents, projects: PROJECTS, tasks: [], catalog: null, boatHealth: null });

test('render: the editor offers Follow project first, new agents start on it, saved agents keep their own mode', async () => {
  const v = view({ projects: { [P_SHOP]: { version: 1, preset: 'ask', limit: true }, [P_BLOG]: { version: 1 } } });
  const { r, cleanup } = await loadUi(state([AGENT('a1', { approval: 'full', seedApproval: true }), AGENT('a2', { approval: 'ask', approvalSource: 'project' })]), v);
  try {
    const fresh = unesc(r.editor(null));
    const sel = /Approvals<select[^>]*>([\s\S]*?)<\/select>/.exec(fresh)?.[1] ?? '';
    assert.ok(sel, 'the Approvals field is a select');
    assert.deepEqual([...sel.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), ['project', 'ask', 'auto-edits', 'full']);
    assert.match(sel, /<option value="project" selected="">Follow project<\/option>/, 'a new agent follows its project');
    assert.match(fresh, /Not in a project, so it follows the app default: Ask\./);

    const saved = unesc(r.editor('a1'));
    assert.match(saved, /<option value="full" selected="">Full<\/option>/, 'an existing agent keeps its own mode');
    assert.doesNotMatch(saved, /<option value="project" selected/);
    assert.match(saved, /In Shop: runs as Ask \(project limit\)\. In Blog: Full\./, 'one line per project, with the reason');
    assert.match(saved, /data-testid="seed-note"><span class="chip-pill">Comes with Legion<\/span> You have not changed this agent's setting\./, 'a seeded agent nobody changed says so');
    assert.doesNotMatch(unesc(r.editor('a2')), /Comes with Legion/, 'an agent without the mark says nothing');
    assert.doesNotMatch(fresh, /Comes with Legion/, 'a new agent says nothing');

    const follower = unesc(r.editor('a2'));
    assert.match(follower, /<option value="project" selected="">Follow project<\/option>/);
    assert.match(follower, /In Blog: runs as Ask \(app default\)\./);
  } finally { cleanup(); }
});

test('render: the run chips draw Runs as with its reason and the web chip, and nothing when there is nothing to say', async () => {
  const v = view({ projects: { [P_SHOP]: { version: 1, preset: 'ask', limit: true } } });
  const { r, cleanup } = await loadUi(state([]), v);
  try {
    const agent = AGENT('a1', { approval: 'full' });
    const html = unesc(r.chips({ id: 't', runsAs: { mode: 'ask', projectId: P_SHOP }, web: { pages: 3, newSites: 1 } }, agent, PROJECTS, v));
    assert.match(html, /Runs as Ask/);
    assert.match(html, /title="A1's own setting is Full\. Project Shop is set to Ask and limits agents to it\. Result: this run asks before every command and file change\."/);
    assert.match(html, /web: 3 pages, 1 new site/);
    assert.equal(r.chips({ id: 't', runsAs: { mode: 'ask' } }, AGENT('a1'), PROJECTS, v).includes('web:'), false, 'no web chip without reads');
    assert.equal(r.chips({ id: 't' }, agent, PROJECTS, v), '', 'a task that has not run shows no chips');
    assert.equal(r.chips(undefined, agent, PROJECTS, v), '');
  } finally { cleanup(); }
});

test('render: project settings repeat the preset radio and the limit box for that project', async () => {
  const shopView = view({ projects: { [P_SHOP]: { version: 1, preset: 'smart', limit: true } } });
  const { r, cleanup } = await loadUi(state([]), shopView);
  try {
    const agents = [AGENT('a1', { approvalSource: 'project' }), AGENT('a2', { approval: 'full' })];
    const html = unesc(r.ask({ project: project(P_SHOP, 'Shop', ['a1', 'a2']), agents, view: shopView }));
    assert.match(html, /How agents ask/);
    assert.equal((html.match(/type="radio"/g) ?? []).length, 5, 'Per agent and the four presets');
    assert.match(html, /name="ask-preset-proj_00000000000a"[^>]*checked=""[^>]*\/><span>Smart</);
    assert.match(html, /Limit agents to this/);
    assert.match(html, /type="checkbox"[^>]*checked=""/);
    assert.match(html, /This limits 1 agent here: A2 \(Full\) runs as Smart in Shop\. 1 agent follows the preset\./);
    // the limit switched off: the warning names who runs looser there, and the "limits" line is gone
    const offView = view({ projects: { [P_SHOP]: { version: 1, preset: 'smart', limit: false } } });
    const loose = unesc(r.ask({ project: project(P_SHOP, 'Shop', ['a1', 'a2']), agents, view: offView }));
    assert.match(loose, /data-testid="limit-warn"[^>]*>With the limit off, A2 runs as Full in Shop and never asks\./);
    assert.doesNotMatch(loose, /This limits/);
    const perAgent = unesc(r.ask({ project: project(P_BLOG, 'Blog', ['a1']), agents, view: view() }));
    assert.match(perAgent, /type="checkbox"[^>]*disabled=""/, 'no limit to set while there is no preset');
    const off = unesc(r.ask({ project: project(P_SHOP, 'Shop', []), agents, view: view({ canSign: false }), note: { tone: 'error', text: 'The change was not made.' } }));
    assert.match(off, /Legion cannot sign settings on your computer, so only Ask is available\./);
    assert.match(off, /role="alert">The change was not made\./);
  } finally { cleanup(); }
});

test('render: the one-time notice says nothing changed and offers one way to dismiss it', async () => {
  const { r, cleanup } = await loadUi(state([]), null);
  try {
    const html = r.notice({});
    assert.ok(unesc(html).includes(PROJECT_NOTICE.text));
    assert.match(html, />Got it</);
    assert.match(r.notice({ note: { tone: 'error', text: 'Could not save.' } }), /role="alert">Could not save\./);
  } finally { cleanup(); }
});

test('render: a run that asks for nothing keeps the warning tint on the runs-as chip; an Ask run does not', async () => {
  const v = view();
  const { r, cleanup } = await loadUi(state([]), v);
  try {
    const agent = AGENT('a1', { approval: 'full' });
    assert.match(r.chips({ id: 't', runsAs: { mode: 'full' } }, agent, PROJECTS, v), /class="chip-pill runs-as ap-full"/);
    assert.match(r.chips({ id: 't', runsAs: { mode: 'ask' } }, agent, PROJECTS, v), /class="chip-pill runs-as"/);
  } finally { cleanup(); }
});
