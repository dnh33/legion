/**
 * Task 10 (Hermes runtime): the window. The picker group, the thread badge and usage line, the first-use card, the Hermes card, the honest
 * mode control, Settings "Agent hosts" and the Doctor row levels. Pure logic first, then real renders of the components (esbuild bundle +
 * renderToStaticMarkup, the pattern of agent-follow-ui.test.ts), then source pins for the wiring that has no render here.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { buildPickerLayout, type PickerInput } from '../src/shared/model-picker-rows.js';
import {
  ACP_CLOSED_NOTE, ACP_LATE_NOTE, CONTAINED_CHECKS, CONTAINED_SWITCH_HINT, FIRST_USE, HERMES_ASKS, HERMES_BADGE, HERMES_NO_COST, HERMES_NOTE, NOT_APPLIED_TO_HERMES, SWITCH_COPY, SWITCH_ORDER,
  acpModelLabel, agentModeControl, cardCountdown, firstUseOutcome, hermesModeLine, hermesUsageLine, needsFirstUse, slashModelStep, titleAddsInfo,
  CONTAINED_NEEDS_HERMES, HERMES_MODE_CHIP, HERMES_PROMPT_PLACEHOLDER, threadOnHermes,
} from '../src/shared/acp-copy.js';
import { toAcpDetection } from '../src/core/acp/detect.js';
import { limitWords } from '../ui/src/gates/agentFollowLogic.js';
import { unitModel } from '../ui/src/projects/page/pageLogic.js';
import { NAV, NAV_GROUPS } from '../ui/src/components/settingsNav.js';
import { checkKind, keepProbedAgentRows } from '../ui/src/doctorLogic.js';
import { overrideRefusal } from '../src/core/model-cap.js';

const REPO = existsSync(join(fileURLToPath(import.meta.url), '..', '..', 'ui', 'vite.config.ts')) ? join(fileURLToPath(import.meta.url), '..', '..') : join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (p: string): string => readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n');
const unesc = (s: string): string => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const NO_DASH = /[—–]|this computer|this machine/i;

// ---------------------------------------------------------------- the picker group

const baseInput = (over: Partial<PickerInput> = {}): PickerInput => ({ query: '', selected: 'auto', autoDescription: 'x', current: [{ value: 'sonnet', displayName: 'Sonnet 5.5' }], older: [], groups: [], configured: [], olderOpen: false, groupOpen: {}, ...over });

test('picker: a Hermes group with the note appears only when the catalog lists Hermes, and never under a provider group', () => {
  const none = buildPickerLayout(baseInput());
  assert.ok(!JSON.stringify(none.rows).includes('Hermes'), 'no Hermes row when it is not detected');
  const hosts = [{ value: 'acp:hermes', label: 'Hermes', entryId: 'hermes' }];
  const withIt = buildPickerLayout(baseInput({ hosts, groups: [{ id: 'openrouter', label: 'OpenRouter', providerId: 'openrouter', models: ['x/y'] }] }));
  const i = withIt.rows.findIndex((r) => r.kind === 'label' && r.text === 'Hermes');
  assert.ok(i >= 0, 'a Hermes label row');
  const note = withIt.rows[i + 1]!;
  assert.deepEqual(note.kind === 'note' ? note.text : null, HERMES_NOTE, 'the note sits right under the group label');
  const item = withIt.rows[i + 2]!;
  assert.ok(item.kind === 'item' && item.value === 'acp:hermes' && item.displayName === 'Hermes');
  const heads = withIt.rows.filter((r) => r.kind === 'head').map((r) => (r.kind === 'head' ? r.label : ''));
  assert.ok(heads.every((h) => !h.includes('Hermes')), 'Hermes is not a provider group head');
  assert.ok(withIt.nav.some((n) => n.kind === 'item' && n.value === 'acp:hermes'), 'reachable by keyboard');
  assert.ok(!withIt.nav.some((n) => (n as { kind: string }).kind === 'note'), 'the note is not a stop for the arrow keys');
  assert.equal(buildPickerLayout(baseInput({ hosts, query: 'herm' })).rows.some((r) => r.kind === 'item' && r.value === 'acp:hermes'), true, 'a search finds it');
  assert.equal(buildPickerLayout(baseInput({ hosts, query: 'zzz' })).rows.length, 0);
});

test('labels: acp values read as Hermes, never as a raw id; Hermes is never a provider shape', () => {
  assert.equal(acpModelLabel('acp:hermes'), 'Hermes');
  assert.equal(acpModelLabel('acp:hermes/anthropic:claude-x'), 'Hermes · anthropic:claude-x');
  assert.equal(acpModelLabel('openrouter:x/y'), undefined);
  assert.equal(acpModelLabel('sonnet'), undefined);
  const ed = src('ui/src/components/AgentEditor.tsx');
  assert.doesNotMatch(ed, /\[a-z\]\[a-z0-9-\]\{1,31\}:\./, 'AgentEditor no longer shape-tests the prefix');
  assert.match(ed, /runtimeOf\(model\) === 'provider'/);
  const ps = src('ui/src/providers/providersStore.ts');
  assert.doesNotMatch(ps, /\^\(\[a-z\]\[a-z0-9-\]\{1,31\}\):\(\.\+\)\$/, 'providerModelLabel no longer shape-tests the prefix');
  assert.match(src('ui/src/models.ts'), /acpModelLabel/);
  assert.doesNotMatch(overrideRefusal('Rex', 'acp:hermes', 'sonnet'), /provider/i, 'agent host copy does not say provider');
  assert.doesNotMatch(src('src/core/engine.ts'), /own provider setting|cannot pick a provider/);
});

// ---------------------------------------------------------------- the first-use card

test('first use: shown once, Use Hermes takes the model, Not now leaves the agent unchanged, both mark it seen', () => {
  assert.equal(needsFirstUse('acp:hermes', false), true);
  assert.equal(needsFirstUse('acp:hermes', true), false, 'once');
  assert.equal(needsFirstUse('sonnet', false), false, 'only for a Hermes pick');
  assert.deepEqual(firstUseOutcome('use', 'sonnet', 'acp:hermes'), { model: 'acp:hermes', seen: true });
  assert.deepEqual(firstUseOutcome('notNow', 'sonnet', 'acp:hermes'), { model: 'sonnet', seen: true });
  assert.deepEqual([FIRST_USE.use, FIRST_USE.notNow], ['Use Hermes', 'Not now']);
});

// ---------------------------------------------------------------- the card

test('card: time left counts down and the card ends with the agent stopped waiting', () => {
  const at = new Date(1_000_000 + 272_000).toISOString();
  assert.deepEqual(cardCountdown(at, 1_000_000), { ended: false, text: 'Closes in 4:32' });
  assert.deepEqual(cardCountdown(at, 1_000_000 + 272_000), { ended: true, text: 'The agent stopped waiting' });
  assert.equal(cardCountdown(undefined, 0), undefined, 'a card without a deadline shows no time');
  assert.equal(ACP_CLOSED_NOTE, 'The agent stopped waiting');
  assert.equal(ACP_LATE_NOTE, 'Hermes had already stopped waiting, so nothing was run.');
  assert.equal(HERMES_ASKS, 'Hermes asks');
});

// ---------------------------------------------------------------- mode honesty, usage

test('mode control: no Legion picker for Hermes while Match Legion\'s mode is off; the normal picker when it is on', () => {
  assert.deepEqual(agentModeControl({ model: 'sonnet', modeMap: false }), { kind: 'picker' });
  assert.deepEqual(agentModeControl({ model: 'openrouter:x/y', modeMap: false }), { kind: 'picker' });
  assert.deepEqual(agentModeControl({ model: 'acp:hermes', modeMap: false, hermesMode: 'smart' }), { kind: 'fixed', line: 'Hermes decides what to ask you. Its mode: Smart' });
  assert.deepEqual(agentModeControl({ model: 'acp:hermes', modeMap: true }), { kind: 'picker', line: "Legion sets Hermes's mode from this" });
  assert.equal(hermesModeLine({ modeMap: false }), 'Hermes decides what to ask you. Its mode: not read yet');
  assert.equal(hermesModeLine({ modeMap: false, hermesMode: 'manual' }), 'Hermes decides what to ask you. Its mode: Manual');
});

test('a project limit never claims to cover a Hermes agent while the switch is off', () => {
  const agent = (id: string, model: string, approval: 'ask' | 'full') => ({ id, name: id.toUpperCase(), model, approval, approvalSource: 'own' }) as never;
  const view = { app: { version: 1 }, projects: { p1: { version: 1, preset: 'ask', limit: true } }, unreadable: [], changedOutside: [], canSign: true } as never;
  const project = { id: 'p1', name: 'Shop', members: ['a', 'h'] };
  const off = limitWords([agent('a', 'sonnet', 'full'), agent('h', 'acp:hermes', 'full')], project, view, { modeMap: false });
  assert.match(off.on ?? '', /A \(Full\) runs as Ask/);
  assert.doesNotMatch(off.on ?? '', /H \(Full\)/, 'Hermes is not listed as limited');
  assert.ok((off.on ?? '').includes(`H: ${NOT_APPLIED_TO_HERMES}`), 'its row says so');
  const on = limitWords([agent('a', 'sonnet', 'full'), agent('h', 'acp:hermes', 'full')], project, view, { modeMap: true });
  assert.match(on.on ?? '', /H \(Full\)/, 'with the switch on the limit holds Hermes too');
  assert.ok(!(on.on ?? '').includes(NOT_APPLIED_TO_HERMES));
});

test('render: the project cap row and the preset row say Not applied to Hermes agents while the switch is off, and the pages read the switch', async () => {
  const agents = [AGENT('a', { name: 'Alpha', model: 'sonnet', approval: 'full' }), AGENT('h', { name: 'Hermes agent', model: 'acp:hermes', approval: 'full' })];
  const project = { id: 'p1', name: 'Shop', members: ['a', 'h'] };
  const view = { app: { version: 1 }, projects: { p1: { version: 1, preset: 'ask', limit: true } }, unreadable: [], changedOutside: [], canSign: true, keystore: { ok: true } };
  const { r, cleanup } = await loadUi(st(agents));
  try {
    const off = unesc(r.ask({ project, agents, view, modeMap: false }));
    assert.ok(off.includes(`Hermes agent: ${NOT_APPLIED_TO_HERMES}`), 'Settings, project page: the cap row says so');
    assert.doesNotMatch(off, /Hermes agent \(Full\)/);
    const on = unesc(r.ask({ project, agents, view, modeMap: true }));
    assert.ok(!on.includes(NOT_APPLIED_TO_HERMES) && /Hermes agent \(Full\)/.test(on), 'with the switch on the limit holds Hermes');
    assert.ok(unesc(r.ask({ project, agents, view })).includes(NOT_APPLIED_TO_HERMES), 'no value: the shipped default (off)');
    const gOff = unesc(r.presets({ view, scope: 'p1', projects: [project], agents, modeMap: false }));
    assert.ok(gOff.includes(`Hermes agent: ${NOT_APPLIED_TO_HERMES}`), 'Settings, Permission gates: the preset row says so');
    const gOn = unesc(r.presets({ view, scope: 'p1', projects: [project], agents, modeMap: true }));
    assert.ok(!gOn.includes(NOT_APPLIED_TO_HERMES));
  } finally { cleanup(); }
  assert.match(src('ui/src/projects/page/AskSection.tsx'), /switches\.modeMap/, 'the page reads the switch');
  assert.match(src('ui/src/gates/GatesSection.tsx'), /switches\??\.modeMap/, 'the gates section reads the switch');
});

test('usage line: tokens and that Hermes does not report cost', () => {
  assert.equal(hermesUsageLine({ tokenUsage: { inputTokens: 1200, outputTokens: 80 } }), '1200 in / 80 out. Hermes does not report cost.');
  assert.equal(hermesUsageLine({}), 'tokens not reported. Hermes does not report cost.');
  assert.match(hermesUsageLine({ tokenUsage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0123 }), /Cost from your prices: \$0\.0123/, 'an owner price gives a cost');
  assert.equal(HERMES_NO_COST, 'Hermes does not report cost.');
});

// ---------------------------------------------------------------- Doctor levels, detection for the window

test('Doctor: warn is amber and shows its fix, neutral is quiet and is not counted; a refresh keeps the probed Hermes rows', () => {
  assert.equal(checkKind({ ok: true, level: 'warn' }, false), 'warn');
  assert.equal(checkKind({ ok: true, level: 'neutral' }, false), 'neutral');
  assert.equal(checkKind({ ok: false }, false), 'bad');
  assert.equal(checkKind({ ok: true }, false), 'ok');
  assert.equal(checkKind({ ok: false }, true), 'opt');
  const prev = [{ id: 'claude', ok: true, label: 'c', detail: '' }, { id: 'acp-hermes', ok: true, label: 'Hermes: found', detail: 'p' }, { id: 'acp-hermes-starts', ok: true, label: 'Hermes starts', detail: 'ok' }];
  const next = [{ id: 'claude', ok: true, label: 'c2', detail: '' }, { id: 'acp-hermes', ok: true, label: 'Hermes: found', detail: 'p' }, { id: 'acp-hermes-starts', ok: true, level: 'neutral' as const, label: 'Hermes starts', detail: 'Not checked yet. Open the Doctor and choose Re-run checks to check it.' }];
  const kept = keepProbedAgentRows(next, prev);
  assert.equal(kept.find((r) => r.id === 'claude')!.label, 'c2', 'other rows are fresh');
  assert.equal(kept.find((r) => r.id === 'acp-hermes-starts')!.detail, 'ok', 'the probed row stays');
  assert.deepEqual(keepProbedAgentRows(next, null), next, 'nothing earlier: as it came');
});

test('Settings view: detection reads from the cache, with the version and Hermes approvals mode', () => {
  assert.deepEqual(toAcpDetection({ found: true, checked: false, checkOk: false, pending: true, detail: 'x' }), { state: 'found', checked: false, detail: 'x' });
  assert.deepEqual(toAcpDetection({ found: false, checked: true, checkOk: false, detail: 'Hermes not on PATH' }), { state: 'missing', checked: true, detail: 'Hermes not on PATH' });
  assert.deepEqual(toAcpDetection({ found: true, checked: true, checkOk: true, version: '0.22.3', approvalsMode: 'smart', detail: 'ok' }), { state: 'found', checked: true, version: '0.22.3', approvalsMode: 'smart', detail: 'ok' });
  assert.equal(toAcpDetection({ found: true, checked: true, checkOk: false, detail: 'start check failed' }).state, 'error');
});

test('Settings nav: Agent hosts sits in Connections, after Providers', () => {
  assert.ok(NAV.some((n) => n.id === 'hosts' && n.label === 'Agent hosts'));
  const conn = NAV_GROUPS.find((g) => g.heading === 'Connections')!;
  assert.equal(conn.ids.indexOf('hosts'), conn.ids.indexOf('providers') + 1);
});

// ---------------------------------------------------------------- real renders

type Render = Record<string, (...args: any[]) => string>;
async function loadUi(state: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ r: Render; cleanup: () => void }> {
  const ui = (p: string) => JSON.stringify(join(REPO, p));
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { AgentEditor } from ${ui('ui/src/components/AgentEditor.tsx')};
        import { AcpCard, ClosedAcpCard } from ${ui('ui/src/components/AcpCard.tsx')};
        import { AcpFirstUseView } from ${ui('ui/src/components/AcpFirstUse.tsx')};
        import { HermesBadge, HermesUsage } from ${ui('ui/src/acp/HermesBadge.tsx')};
        import { AgentHostsView } from ${ui('ui/src/settings/AgentHostsSection.tsx')};
        import { AskSectionView } from ${ui('ui/src/projects/page/AskSection.tsx')};
        import { GatesPresets } from ${ui('ui/src/gates/GatesPresets.tsx')};
        const render = (el) => renderToStaticMarkup(el);
        export const editor = (id) => render(createElement(AgentEditor, { id }));
        export const card = (a, now) => render(createElement(AcpCard, { a, now }));
        export const closedCard = (c) => render(createElement(ClosedAcpCard, { c }));
        export const firstUse = () => render(createElement(AcpFirstUseView, { onUse() {}, onNotNow() {} }));
        export const badge = (task) => render(createElement(HermesBadge, { task }));
        export const usage = (task) => render(createElement(HermesUsage, { task }));
        export const hosts = (props) => render(createElement(AgentHostsView, props));
        export const ask = (props) => render(createElement(AskSectionView, { run: async () => true, busy: false, note: null, ...props }));
        export const presets = (props) => render(createElement(GatesPresets, { setScope() {}, busy: false, note: null, run: async () => true, ...props }));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        const stub = (filter: RegExp, name: string, contents: string) => {
          b.onResolve({ filter }, () => ({ path: name, namespace: 'stub' }));
          b.onLoad({ filter: new RegExp(`^${name}$`), namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents }));
        };
        stub(/providersStore$/, 'providers-store', `export const providerModelGroups = () => []; export const providerModelLabel = (m) => m;
          export const loadProviders = async () => {}; export const useProviders = (sel) => sel({ view: globalThis.__pv ?? null });`);
        stub(/armory\/AgentSkills$/, 'agent-skills', `export const AgentSkills = () => null; export const settingOf = (v) => v ?? 'inherit'; export const valueOf = () => ({ mode: 'inherit' });`);
        stub(/armory\/armoryStore$/, 'armory-store', `export const revealSkill = () => {};`);
        stub(/useGatesView$/, 'use-gates-view', `export const useGatesView = () => ({ view: null, loadError: null, reload: async () => {}, apply: async () => ({ state: 'ok' }) });
          export const useGatesAction = () => ({ pending: false, note: null, run: async () => true }); export const PENDING_TEXT = 'x'; export const reloadGatesFromDisk = async () => {};`);
        stub(/^(\.\.\/)*store$/, 'store', `export const useStore = (sel) => sel(globalThis.__st);
          export const saveSettings = async () => {}; export const errText = (e) => (e && e.message) ? e.message : String(e);
          export const saveAgent = async () => {}; export const removeAgent = async () => {};
          export const closeOverlays = () => {}; export const openSettings = () => {}; export const loadCatalog = async () => {};
          export const dismissClosed = () => {}; export const decideOption = async () => {}; export const decide = async () => {}; export const toast = () => {}; export const loadSettings = async () => {}; export const runDoctor = async () => {};`);
        stub(/\.\.\/api$/, 'api', `export const api = { acpContained: async () => ({}) }; export const request = async () => ({});`);
      },
    }],
  });
  const dir = cleanupTemp('ui-acp-');
  const file = join(dir, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  const g = globalThis as Record<string, unknown>;
  g.__st = state; g.__pv = extra.pv ?? null;
  return { r: createRequire(file)(file) as Render, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const AGENT = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), emoji: id[0], description: '', systemPrompt: '', model: 'auto', approval: 'ask', mcpServers: ['*'], vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, createdAt: '', updatedAt: '', ...over });
const HOSTS = [{ value: 'acp:hermes', label: 'Hermes', entryId: 'hermes' }];
const acp = (over: Record<string, unknown> = {}, sw: Record<string, boolean> = {}) => ({
  entries: [{ id: 'hermes', label: 'Hermes', command: 'hermes', args: ['acp'], envKeys: [], tested: true, enabled: true, legionTools: true, fullAllowed: true, detection: { state: 'found', checked: true, version: '0.22.3', approvalsMode: 'smart', detail: 'ok' }, ...over }],
  switches: { disasterStop: false, modeMap: false, stripSkipFlags: false, answerOnce: false, ...sw }, watchdogMinutes: 10, firstUseSeen: true,
});
const st = (agents: unknown[], a = acp()) => ({ agents, projects: [], tasks: [], catalog: { hosts: HOSTS, models: [], commands: [], fetchedAt: '' }, boatHealth: null, settings: { acp: a } });

test('render: a Hermes agent in the editor gets the Hermes note, no provider note, no Legion mode picker, and a folder field first', async () => {
  const { r, cleanup } = await loadUi(st([AGENT('h', { model: 'acp:hermes' }), AGENT('c', { model: 'sonnet' })]));
  try {
    const h = unesc(r.editor('h'));
    assert.match(h, /<optgroup label="Hermes">[\s\S]*?<option value="acp:hermes"[^>]*>Hermes<\/option>/, 'Hermes is its own group in the select');
    assert.doesNotMatch(h, /\(not Claude\)[\s\S]*acp:hermes/, 'never under a not-Claude provider group');
    assert.ok(h.includes(HERMES_NOTE), 'the Hermes note');
    assert.doesNotMatch(h, /Runs outside Claude/, 'the provider note is not shown for Hermes');
    assert.doesNotMatch(h, /Approvals<select/, 'no Legion mode picker while Match Legion\'s mode is off');
    assert.ok(h.includes('Hermes decides what to ask you. Its mode: Smart'));
    assert.ok(h.includes("Match Legion's mode"), 'a link to the switch');
    assert.match(h, /Folder<input/, 'a Hermes agent chooses its folder first');
    assert.ok(h.indexOf('Folder<input') < h.indexOf('System prompt'), 'the folder comes first');
    const c = unesc(r.editor('c'));
    assert.match(c, /Approvals<select/);
    assert.doesNotMatch(c, /Folder<input/);
    assert.doesNotMatch(c, new RegExp(HERMES_NOTE.slice(0, 30)));
  } finally { cleanup(); }
  const on = await loadUi(st([AGENT('h', { model: 'acp:hermes' })], acp({}, { modeMap: true })));
  try {
    const h = unesc(on.r.editor('h'));
    assert.match(h, /Approvals<select/, 'the normal picker with the switch on');
    assert.ok(h.includes("Legion sets Hermes's mode from this"));
  } finally { on.cleanup(); }
  const prov = await loadUi(st([AGENT('p', { model: 'openrouter:x/y' })]), { pv: { providers: [{ id: 'openrouter', label: 'OpenRouter', models: [] }] } });
  try {
    const p = unesc(prov.r.editor('p'));
    assert.ok(p.includes('Runs outside Claude, on OpenRouter'), 'the provider note keeps its text');
    assert.ok(!p.includes(HERMES_NOTE));
  } finally { prov.cleanup(); }
});

test('render: the Hermes card shows the command, the options as Hermes named them, the time left, and no Remember', async () => {
  const { r, cleanup } = await loadUi(st([]));
  try {
    const a = { id: 'apr_1', taskId: 't', agentId: 'h', toolName: 'acp_execute', summary: 'rm -rf build', input: {}, at: '', noRemember: true, acpTitle: 'Run a command',
      acpOptions: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }, { optionId: 'o2', name: 'Allow for session', kind: 'allow_always' }, { optionId: 'o3', name: 'Deny', kind: 'reject_once' }],
      expiresAt: new Date(1_000_000 + 272_000).toISOString() };
    const html = unesc(r.card(a, 1_000_000));
    assert.ok(html.includes('Hermes asks'));
    assert.ok(html.includes('rm -rf build'), 'the exact command');
    for (const n of ['Allow once', 'Allow for session', 'Deny']) assert.ok(new RegExp(`<button[^>]*>${n}</button>`).test(html), `${n} is a button`);
    assert.ok(html.includes('Closes in 4:32'));
    assert.doesNotMatch(html, /Remember|Always allow/);
    const late = unesc(r.card(a, 1_000_000 + 280_000));
    assert.ok(late.includes('The agent stopped waiting'));
    assert.equal((late.match(/<button/g) ?? []).length, 0, 'a late card offers no answer (it would be refused)');
    assert.doesNotMatch(late, NO_DASH);
  } finally { cleanup(); }
});

test('render: first-use card, thread badge, usage line, Agent hosts section', async () => {
  const { r, cleanup } = await loadUi(st([]));
  try {
    const f = unesc(r.firstUse());
    assert.ok(f.includes(HERMES_NOTE));
    assert.match(f, /<button[^>]*>Use Hermes<\/button>/);
    assert.match(f, /<button[^>]*>Not now<\/button>/);

    const b = unesc(r.badge({ runtime: 'Hermes', model: 'acp:hermes' }));
    assert.ok(b.includes(HERMES_BADGE));
    assert.ok(b.includes(`title="${HERMES_NOTE}"`), 'the tooltip is the note');
    assert.equal(r.badge({ model: 'sonnet' }), '', 'no badge on a Claude task');
    const u = unesc(r.usage({ runtime: 'Hermes', model: 'acp:hermes', tokenUsage: { inputTokens: 5, outputTokens: 2 } }));
    assert.ok(u.includes('5 in / 2 out') && u.includes(HERMES_NO_COST));

    const base = { acp: acp(), checking: false, contained: null, containedBusy: false, onSwitch() {}, onWatchdog() {}, onContained() {}, onToggle() {}, onRecheck() {} };
    const h = unesc(r.hosts(base));
    assert.ok(h.includes('Hermes') && h.includes('0.22.3'), 'state and version');
    for (const k of SWITCH_ORDER) assert.ok(h.includes(SWITCH_COPY[k].label) && h.includes(SWITCH_COPY[k].hint), SWITCH_COPY[k].label);
    assert.equal((h.match(/checked=""/g) ?? []).length, 1, 'only "Offer Hermes" is on: the four switches and Contained start off');
    const allOn = unesc(r.hosts({ ...base, acp: acp({}, { disasterStop: true, modeMap: true, stripSkipFlags: true, answerOnce: true }) }));
    assert.equal((allOn.match(/checked=""/g) ?? []).length, 5, 'each switch reads its own value');
    assert.match(h, /Contained/);
    // R53 / live check 2026-10-22: the switch says what the read-back checks, and that the main Hermes sign-in may be used. It never over-claims.
    assert.doesNotMatch(h, /none of your other Hermes settings|only file tools/);
    assert.ok(h.includes(CONTAINED_SWITCH_HINT), 'the switch text is the shared wording');
    assert.ok(CONTAINED_SWITCH_HINT.includes(CONTAINED_CHECKS), 'it reuses the core wording of what is checked');
    assert.match(CONTAINED_SWITCH_HINT, /asks before it runs a command/);
    assert.match(CONTAINED_SWITCH_HINT, /tool list for Legion runs is set to file tools/);
    assert.match(CONTAINED_SWITCH_HINT, /does not borrow your Claude Code login or another coding tool's login/);
    assert.match(CONTAINED_SWITCH_HINT, /may use your main Hermes sign-in/);
    assert.doesNotMatch(CONTAINED_SWITCH_HINT, NO_DASH);
    assert.match(src('src/core/acp/contained.ts'), /CONTAINED_CHECKS/, 'the core builds its read-back sentence from the same words');
    // the heading and its paragraph sit together, without the card gap between them
    assert.match(h, /<div class="host-head"><h4>In between<\/h4><p/);
    assert.match(src('ui/src/styles/app.css'), /\.host-head\s*\{[^}]*gap:\s*4px/);
    assert.match(src('ui/src/styles/app.css'), /\.host-head > \* \{ margin: 0; \}/, 'the paragraph default margin made a 16 px gap under the heading (live check 2026-10-22)');
    assert.match(h, /Watchdog/i);
    assert.ok(h.includes('config file'), 'custom entries are not edited here');
    const missing = unesc(r.hosts({ ...base, acp: acp({ detection: { state: 'missing', checked: true, detail: 'Hermes is not on your PATH.' } }) }));
    assert.ok(missing.includes('Hermes is not installed'), 'not installed state');
    const real = unesc(r.hosts({ ...base, acp: acp({ detection: { state: 'missing', checked: true, detail: 'Hermes is not installed. Install it from hermes-agent.nousresearch.com, then check again.' } }) }));
    assert.equal((real.match(/Hermes is not installed/g) ?? []).length, 1, 'the core detail already starts with the state: say it once (live check 2026-10-22)');
    const withSignIn = unesc(r.hosts({ ...base, acp: acp({ contained: true }), contained: { kind: 'setup', ok: true, detail: 'The profile exists.', signInCommand: 'hermes -p legion setup model' } }));
    assert.ok(withSignIn.includes('hermes -p legion setup model') && withSignIn.includes('The profile exists.'), 'the core wording, as returned');
  } finally { cleanup(); }
});

/** The real store with only the network edge replaced: `api.doctor` answers what the test says, and records whether the call asked to probe. */
async function loadStore(): Promise<{ s: Record<string, (...a: any[]) => any>; cleanup: () => void }> {
  const out = await build({
    entryPoints: [join(REPO, 'ui/src/store.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'api-stub',
      setup(b) {
        b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /^api$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export class ApiError extends Error {}
          export const request = async () => ({}); export const subscribe = () => () => {};
          export const api = { doctor: async (probe) => { (globalThis.__doctorCalls ||= []).push(probe); return globalThis.__doctorNext; }, decideOption: async (...a) => { (globalThis.__decideCalls ||= []).push(a); return globalThis.__decideNext; } };` }));
      },
    }],
  });
  const dir = cleanupTemp('ui-acp-store-');
  const file = join(dir, 'store.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  // the store reads window/matchMedia while it loads; the Node globals are borrowed for that and put back
  const g = globalThis as Record<string, unknown>;
  const had = ['window', 'location', 'matchMedia'].map((k) => [k, g[k]] as const);
  g.window = globalThis; g.location = { search: '', hash: '', pathname: '/' }; g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  let s: Record<string, (...a: any[]) => any>;
  try { s = createRequire(file)(file) as Record<string, (...a: any[]) => any>; } finally { for (const [k, v] of had) { if (v === undefined) delete g[k]; else g[k] = v; } }
  return { s, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Doctor behaviour: a refresh that does not probe keeps the Hermes rows the window shows; opening or Re-run replaces them', async () => {
  const { s, cleanup } = await loadStore();
  const g = globalThis as Record<string, unknown>;
  const probed = [{ id: 'claude', ok: true, label: 'Claude', detail: '' }, { id: 'acp-hermes-starts', ok: false, level: 'warn', label: 'Hermes starts', detail: 'It started, but sign-in is missing.', fix: 'Run hermes setup' }];
  const unprobed = [{ id: 'claude', ok: true, label: 'Claude 2', detail: '' }, { id: 'acp-hermes-starts', ok: true, level: 'neutral', label: 'Hermes starts', detail: 'Not checked yet. Open the Doctor and choose Re-run checks to check it.' }];
  try {
    g.__doctorCalls = [];
    s.setState({ doctor: null, doctorOpen: true });
    g.__doctorNext = probed; await s.runDoctor(true);
    assert.deepEqual(g.__doctorCalls, [true], 'Re-run asks the core to probe');
    g.__doctorNext = unprobed; await s.runDoctor();
    const rows = s.getState().doctor as Array<{ id: string; label: string; detail: string }>;
    assert.equal(g.__doctorCalls.at(-1), false, 'a settings save refreshes without probing');
    assert.equal(rows.find((c) => c.id === 'acp-hermes-starts')!.detail, 'It started, but sign-in is missing.', 'the probed Hermes row stays');
    assert.equal(rows.find((c) => c.id === 'claude')!.label, 'Claude 2', 'every other row is fresh');
    s.setState({ doctorOpen: false });
    await s.runDoctor();
    assert.match((s.getState().doctor as typeof rows).find((c) => c.id === 'acp-hermes-starts')!.detail, /^Not checked yet/, 'window closed: the fresh answer');
    s.setState({ doctorOpen: true });
    await s.runDoctor(true);
    assert.match((s.getState().doctor as typeof rows).find((c) => c.id === 'acp-hermes-starts')!.detail, /^Not checked yet/, 'a probe always shows what the core said');
  } finally { delete g.__doctorCalls; delete g.__doctorNext; cleanup(); }
});

test('card countdown: the text counts down each second and ends exactly at the deadline, with the late text', () => {
  const at = new Date(10_000 + 3_000).toISOString();
  const seq = [10_000, 11_000, 12_000, 12_999, 13_000, 14_000].map((now) => cardCountdown(at, now)!);
  assert.deepEqual(seq.map((c) => c.text), ['Closes in 0:03', 'Closes in 0:02', 'Closes in 0:01', 'Closes in 0:01', ACP_CLOSED_NOTE, ACP_CLOSED_NOTE]);
  assert.deepEqual(seq.map((c) => c.ended), [false, false, false, false, true, true]);
  assert.equal(cardCountdown(undefined, 1), undefined, 'no deadline, no countdown');
});

// ---------------------------------------------------------------- R60: a closed card stays in the thread

const HCARD = (id = 'apr_1', over: Record<string, unknown> = {}) => ({ id, taskId: 't1', agentId: 'h', toolName: 'acp_execute', summary: 'rm -rf build\ndelete the build folder', input: {}, at: '', noRemember: true, acpTitle: 'delete the build folder: rm -rf build',
  acpOptions: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }, { optionId: 'o3', name: 'Deny', kind: 'reject_once' }], expiresAt: new Date(Date.now() + 60_000).toISOString(), ...over });

test('R60 render: a closed card says the agent stopped waiting, offers no answer, and has a Dismiss control', async () => {
  const { r, cleanup } = await loadUi(st([]));
  try {
    const html = unesc(r.closedCard({ card: HCARD(), note: ACP_CLOSED_NOTE }));
    assert.ok(html.includes('Hermes asks'));
    assert.ok(html.includes(ACP_CLOSED_NOTE), 'the R36 text');
    assert.ok(html.includes('rm -rf build'), 'what was asked stays readable');
    assert.equal((html.match(/<button/g) ?? []).length, 1, 'one button: Dismiss, no answer buttons');
    assert.match(html, /<button[^>]*>Dismiss<\/button>/);
    assert.doesNotMatch(html, /Allow once|Deny/);
    const late = unesc(r.closedCard({ card: HCARD(), note: ACP_CLOSED_NOTE, late: ACP_LATE_NOTE }));
    assert.ok(late.includes(ACP_LATE_NOTE), 'an answer pressed in the same instant shows the Task 6 late note');
    assert.doesNotMatch(html + late, NO_DASH);
  } finally { cleanup(); }
});

test('M5: a live region announces once: the open card has the quiet one for a refused click, the card at its end has none, the closed card holds the end text', async () => {
  const { r, cleanup } = await loadUi(st([]));
  try {
    const open = unesc(r.card(HCARD('apr_m5a', { expiresAt: new Date(Date.now() + 60_000).toISOString() }), Date.now()));
    assert.equal((open.match(/role="status"/g) ?? []).length, 1, 'open: one live region, the empty one a refused click fills');
    assert.match(open, /class="sr-only" role="status" aria-live="polite"><\/span>/);
    const ended = unesc(r.card(HCARD('apr_m5b', { expiresAt: new Date(Date.now() - 1000).toISOString() }), Date.now()));
    assert.ok(ended.includes('The agent stopped waiting'));
    assert.equal((ended.match(/role="status"/g) ?? []).length, 0, 'the end is announced by the closed card that replaces this one, not twice');
    const closed = unesc(r.closedCard({ card: HCARD(), note: ACP_CLOSED_NOTE }));
    assert.equal((closed.match(/role="status"/g) ?? []).length, 1);
  } finally { cleanup(); }
  const card = src('ui/src/components/AcpCard.tsx');
  assert.match(card, /if \(!arm\.click\(e\.detail, performance\.now\(\)\)\) \{ notReady\(\); return; \}/, 'a click inside the arm window says so (it was silent)');
  assert.match(card, /ignored && !armed && !ended && <span className="approval-note">Ready in a moment<\/span>/);
  assert.match(card, /liveReady\(blocks\)/);
});

test('R60 render: the Hermes card shows the command once; the title chip only when it adds information', async () => {
  const { r, cleanup } = await loadUi(st([]));
  try {
    const repeat = unesc(r.card(HCARD('apr_1'), Date.now()));
    assert.equal((repeat.match(/rm -rf build/g) ?? []).length, 1, 'the command appears once (live check 2026-10-22: it was in the header and the body)');
    assert.doesNotMatch(repeat, /class="approval-tool"/, 'a title that only repeats the body is not shown');
    const adds = unesc(r.card(HCARD('apr_2', { acpTitle: 'Network access', summary: 'curl example.com' }), Date.now()));
    assert.match(adds, /class="approval-tool"[^>]*>Network access</, 'a title with new information stays');
  } finally { cleanup(); }
  assert.equal(titleAddsInfo('delete the build folder: rm -rf build', 'rm -rf build\ndelete the build folder'), false);
  assert.equal(titleAddsInfo('rm -rf build', 'rm -rf build'), false);
  assert.equal(titleAddsInfo('Network access', 'curl example.com'), true);
  assert.equal(titleAddsInfo('', 'x'), false);
});

test('R60 behaviour: the real store keeps a card that closed at the deadline, drops it on Dismiss, the task ending or a new turn', async () => {
  const { s, cleanup } = await loadStore();
  const g = globalThis as Record<string, unknown>;
  const closedIds = (): string[] => (s.getState().closedCards as Array<{ card: { id: string } }>).map((c) => c.card.id);
  const hadWindow = g.window; g.window = globalThis; // the toast for a card closed by the task ending sets a timer on window
  const resolve = (id: string, over: Record<string, unknown> = {}) => s.handleEvent({ type: 'approval.resolved', approvalId: id, allowed: false, note: ACP_CLOSED_NOTE, stays: true, ...over });
  try {
    s.setState({ approvals: [], closedCards: [] });
    s.handleEvent({ type: 'approval.requested', approval: HCARD('apr_1') });
    resolve('apr_1');
    assert.deepEqual(s.getState().approvals, [], 'it no longer counts as waiting for the owner');
    assert.deepEqual(closedIds(), ['apr_1'], 'but it stays in the thread');
    assert.equal(s.getState().closedCards[0].note, ACP_CLOSED_NOTE);
    s.dismissClosed('apr_1');
    assert.deepEqual(closedIds(), [], 'Dismiss removes it');

    // a card closed because the task ended does not stay
    s.handleEvent({ type: 'approval.requested', approval: HCARD('apr_2') });
    resolve('apr_2', { stays: undefined });
    assert.deepEqual(closedIds(), []);

    // the task ends: cancelled or deleted
    for (const end of [{ type: 'task.updated', task: { id: 't1', status: 'cancelled' } }, { type: 'task.deleted', taskId: 't1' }]) {
      s.setState({ closedCards: [], tasks: [{ id: 't1', status: 'running' }] });
      s.handleEvent({ type: 'approval.requested', approval: HCARD('apr_3') });
      resolve('apr_3');
      assert.deepEqual(closedIds(), ['apr_3']);
      s.handleEvent({ type: 'task.updated', task: { id: 't1', status: 'running' } });
      assert.deepEqual(closedIds(), ['apr_3'], 'the run going on does not drop it');
      s.handleEvent(end);
      assert.deepEqual(closedIds(), [], `${end.type} drops it`);
    }
    // a finished turn keeps the card the owner never saw; the next turn of the task drops it
    s.setState({ closedCards: [], tasks: [{ id: 't1', status: 'running' }] });
    s.handleEvent({ type: 'approval.requested', approval: HCARD('apr_4') });
    resolve('apr_4');
    s.handleEvent({ type: 'task.updated', task: { id: 't1', status: 'done' } });
    assert.deepEqual(closedIds(), ['apr_4'], 'a normal finish keeps it until dismissed');
    s.handleEvent({ type: 'task.updated', task: { id: 't1', status: 'running' } });
    assert.deepEqual(closedIds(), [], 'a new turn drops it');

    // an answer sent in the same instant: the core says it was late, and the card closes with that note
    s.setState({ closedCards: [], approvals: [HCARD('apr_5')] });
    g.__decideNext = { ok: false, note: ACP_LATE_NOTE };
    await s.decideOption('apr_5', true, 'o1');
    const late = s.getState().closedCards as Array<{ card: { id: string }; note: string; late?: string }>;
    assert.deepEqual(late.map((c) => c.card.id), ['apr_5']);
    assert.equal(late[0]!.note, ACP_CLOSED_NOTE);
    assert.equal(late[0]!.late, ACP_LATE_NOTE);
    // the deadline event for the same card arriving after the click adds no second card
    resolve('apr_5');
    assert.deepEqual(closedIds(), ['apr_5']);
  } finally { delete g.__decideNext; if (hadWindow === undefined) delete g.window; else g.window = hadWindow; cleanup(); }
});

test('R60 behaviour: focus that was inside the card when it closed is handed to the closed card, not dropped to the page', async () => {
  const { s, cleanup } = await loadStore();
  const g = globalThis as Record<string, unknown>;
  const had = g.document;
  try {
    for (const inside of [true, false]) {
      g.document = { activeElement: { closest: (sel: string) => (inside && sel.includes('apr_f') ? {} : null) } };
      s.setState({ approvals: [], closedCards: [] });
      s.handleEvent({ type: 'approval.requested', approval: HCARD('apr_f') });
      s.handleEvent({ type: 'approval.resolved', approvalId: 'apr_f', allowed: false, note: ACP_CLOSED_NOTE, stays: true });
      assert.equal(s.getState().closedCards[0].focus, inside ? true : undefined, inside ? 'focus was on the card: the closed card takes it' : 'focus was elsewhere (the composer): it is left alone');
    }
  } finally { if (had === undefined) delete g.document; else g.document = had; cleanup(); }
});

// ---------------------------------------------------------------- fix round 1

test('I2: a Hermes agent shows no Legion mode chip with a task open or not, while Match Legion\'s mode is off; an old Claude task keeps its own', () => {
  assert.equal(threadOnHermes(undefined, { model: 'acp:hermes' }), true, 'no task yet: the agent decides');
  assert.equal(threadOnHermes(undefined, { model: 'sonnet' }), false);
  assert.equal(threadOnHermes(undefined, undefined), false);
  assert.equal(threadOnHermes({ model: 'sonnet' }, { model: 'acp:hermes' }), false, 'a task that ran on Claude, from before the agent moved to Hermes');
  assert.equal(threadOnHermes({ runtime: 'Hermes', model: 'x' }, { model: 'sonnet' }), true);
  assert.equal(threadOnHermes({ model: 'acp:hermes/m' }, undefined), true);
  assert.equal(threadOnHermes({ requestedModel: 'acp:hermes' }, { model: 'acp:hermes' }), true, 'queued, not run yet');
  const th = src('ui/src/components/Thread.tsx');
  assert.match(th, /threadOnHermes\(task, agent\) && settings\?\.acp\?\.switches\?\.modeMap !== true \? <span className="chip-pill"[^>]*>\{HERMES_MODE_CHIP\}<\/span> : task\?\.runsAs/, 'the fixed line stands where the Legion chip was');
});

test('I3: the project Overview shows no Legion mode and no raw id for a Hermes agent while the switch is off', () => {
  const task = { id: 't1', agentId: 'h', projectId: 'p1', title: 'Fix the build', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const facts = (model: string) => ({
    project: { id: 'p1', name: 'P', members: ['h'], status: 'active', createdAt: '' }, projects: [{ id: 'p1', name: 'P', status: 'active' }],
    agents: [{ id: 'h', name: 'Helper', description: '', model, approval: 'full', approvalSource: 'own' }], tasks: [task], approvals: [], questions: [], queue: null, nowMs: Date.parse('2026-01-01T00:05:00.000Z'),
  }) as unknown as Parameters<typeof unitModel>[0];
  const off = unitModel(facts('acp:hermes'), {}).units[0]!;
  assert.equal(off.mode, HERMES_MODE_CHIP);
  assert.equal(off.model, 'Hermes', 'no raw acp:hermes');
  assert.equal(unitModel(facts('acp:hermes'), { modeMap: true }).units[0]!.mode, 'Full', 'with the switch on the Legion mode is real');
  const claude = unitModel(facts('sonnet'), {}).units[0]!;
  assert.equal(claude.mode, 'Full');
  assert.equal(claude.model, 'sonnet', 'a Claude agent shows what it showed before');
  assert.doesNotMatch(src('ui/src/projects/page/Overview.tsx') + src('ui/src/projects/page/pageLogic.ts'), /Hermes/, 'test/project-page-source.test.ts keeps outside names out of this folder');
  const gt = src('ui/src/gates/GatesSection.tsx');
  assert.match(gt, /const apart = isAgentHostModel\(agent\?\.model\) && !modeMap;/);
  assert.match(gt, /disabled=\{apart \|\|/, 'the Try it tester does not dry-run Legion gates for a Hermes agent');
  assert.match(gt, /\{NOT_APPLIED_TO_HERMES\}\. Hermes decides what to ask you\./);
});

test('I5, item 10: a Hermes agent in the editor has no Claude wording, and the Match Legion\'s mode link asks before it throws away edits', async () => {
  const on = await loadUi(st([AGENT('h', { model: 'acp:hermes' }), AGENT('c', { model: 'sonnet' })], acp({}, { modeMap: true })));
  try {
    const h = unesc(on.r.editor('h'));
    assert.ok(h.includes(`placeholder="${HERMES_PROMPT_PLACEHOLDER}"`), 'a Hermes system prompt placeholder');
    assert.doesNotMatch(h, /Appended to Claude Code|own task tools/, 'no Claude system prompt placeholder, no Claude task list');
    assert.doesNotMatch(h, /Asks before Bash, edits and MCP tools/, 'the Approvals caption is Claude wording');
    assert.ok(h.includes("Legion sets Hermes's mode from this"));
    const c = unesc(on.r.editor('c'));
    assert.ok(c.includes('Appended to Claude Code'), 'a Claude agent keeps its text');
    assert.ok(c.includes('Asks before Bash, edits and MCP tools'));
    assert.ok(c.includes('own task tools'), 'a Claude agent keeps its task list');
  } finally { on.cleanup(); }
  const off = await loadUi(st([AGENT('h', { model: 'acp:hermes' })]));
  try { assert.doesNotMatch(unesc(off.r.editor('h')), /Appended to Claude Code|own task tools|Bash, edits/); } finally { off.cleanup(); }
  assert.doesNotMatch(HERMES_PROMPT_PLACEHOLDER, NO_DASH);
  const ed = src('ui/src/components/AgentEditor.tsx');
  assert.match(ed, /const openHostSettings = \(\): void => \{ if \(dirty\) setLeaving\(\{ to: 'settings' \}\); else openSettings\('hosts'\); \};/);
  assert.match(ed, /onClick=\{openHostSettings\}>\{MATCH_MODE_LINK\}/);
  assert.doesNotMatch(ed, /onClick=\{\(\) => openSettings\('hosts'\)\}/, 'the unguarded link is gone');
  assert.match(ed, /leaving\.to === 'settings'\) openSettings\('hosts'\)/, 'Discard opens Settings');
});

test('item 9: Settings, Agent hosts with Hermes not installed offers no Contained set-up, and the address never breaks at its hyphen', async () => {
  const { r, cleanup } = await loadUi(st([]));
  try {
    const base = { checking: false, contained: null, containedBusy: false, onSwitch() {}, onWatchdog() {}, onContained() {}, onToggle() {}, onRecheck() {} };
    const detail = 'Hermes is not installed. Install it from hermes-agent.nousresearch.com, then check again.';
    // an old result and the Contained switch on from before Hermes went missing
    const gone = unesc(r.hosts({ ...base, acp: acp({ contained: true, detection: { state: 'missing', checked: true, detail } }), contained: { kind: 'setup', ok: true, detail: 'The Legion profile is ready.', signInCommand: 'hermes -p legion setup model' } }));
    assert.doesNotMatch(gone, /profile is ready|>Set up<|>Check<|hermes -p legion/, 'no stale result, no actions');
    assert.ok(gone.includes(CONTAINED_NEEDS_HERMES), 'one plain line says why');
    assert.match(gone, /disabled=""[^>]*\/?><span><b>Contained/);
    assert.ok(gone.includes('<span class="nb">hermes-agent.nousresearch.com</span>'), 'the address stays on one line');
    const found = unesc(r.hosts({ ...base, acp: acp({ contained: true }), contained: { kind: 'setup', ok: true, detail: 'The Legion profile is ready.' } }));
    assert.match(found, />Set up</);
    assert.ok(found.includes('The Legion profile is ready.'));
    assert.ok(!found.includes(CONTAINED_NEEDS_HERMES));
  } finally { cleanup(); }
  assert.doesNotMatch(CONTAINED_NEEDS_HERMES, NO_DASH);
});

test('item 13: the first-use card takes the place of the picker list, so it covers no row and its note shows once', () => {
  const mp = src('ui/src/components/ModelPicker.tsx');
  assert.match(mp, /\{!pendingHost && <div className="pop-body"/);
  assert.match(mp, /\{!pendingHost && <div className="pop-search">/);
  assert.match(mp, /\{pendingHost && <AcpFirstUseView/);
});

test('item 12, 11: the header icons wrap as one group, the usage line is cut not wrapped, and the Doctor text avoids a one-word last line', () => {
  const css = src('ui/src/styles/app.css');
  assert.match(css, /\.th-icons \{[^}]*flex: none/);
  assert.match(css, /\.hermes-usage \{[^}]*white-space: nowrap/);
  assert.match(css, /\.th-right\.is-hermes \.hermes-usage \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.check p \{[^}]*text-wrap: pretty/);
  assert.match(src('ui/src/components/Thread.tsx'), /<span className="th-icons">[\s\S]*Edit agent[\s\S]*<\/span>\s*<\/div>/);
});

test('I7: the card sends the option Hermes named, verbatim; the first-use flows keep the agent unchanged on Not now; Settings asks for the full check; the folder is in the save body', async () => {
  const { s, cleanup } = await loadStore();
  const g = globalThis as Record<string, unknown>;
  const hadWindow = g.window; g.window = globalThis;
  try {
    s.setState({ approvals: [HCARD('apr_v1'), HCARD('apr_v2')], closedCards: [] });
    g.__decideNext = { ok: true }; g.__decideCalls = [];
    await s.decideOption('apr_v1', true, 'opt-session-7');
    await s.decideOption('apr_v2', false, 'opt-deny-9');
    assert.deepEqual((g.__decideCalls as unknown[][]).map((c) => [...c]), [['apr_v1', true, 'opt-session-7'], ['apr_v2', false, 'opt-deny-9']], 'Hermes\'s optionId goes through untouched');
  } finally { delete g.__decideNext; delete g.__decideCalls; if (hadWindow === undefined) delete g.window; else g.window = hadWindow; cleanup(); }
  assert.match(src('ui/src/components/AcpCard.tsx'), /answer\(o\.optionId, o\.kind\)/, 'the card passes the option as Hermes sent it');
  // Not now: the picker and the editor take the outcome's model (the current one), and either way only mark the card seen
  assert.deepEqual(firstUseOutcome('notNow', 'sonnet', 'acp:hermes'), { model: 'sonnet', seen: true });
  const mp = src('ui/src/components/ModelPicker.tsx');
  assert.match(mp, /const o = firstUseOutcome\(choice, model, pendingHost \?\? model\);[\s\S]*if \(o\.model !== model\) setModelChoice\(o\.model\);/);
  const ed = src('ui/src/components/AgentEditor.tsx');
  assert.match(ed, /onNotNow=\{\(\) => \{ const o = firstUseOutcome\('notNow', model, pendingHost\); setModel\(o\.model as ModelChoice\)/);
  assert.match(ed, /onUse=\{\(\) => \{ const o = firstUseOutcome\('use', model, pendingHost\); setModel\(o\.model as ModelChoice\)/);
  // R58: opening Settings, Agent hosts asks for the full check; the picker and the editor never do
  assert.match(src('ui/src/settings/AgentHostsSection.tsx'), /await runDoctor\(true\); await loadSettings\(\)/);
  assert.doesNotMatch(src('ui/src/components/ModelPicker.tsx') + src('ui/src/components/AgentEditor.tsx'), /runDoctor\(true\)|api\.doctor/);
  // R39: the folder travels in the save body for a Hermes agent
  assert.match(ed, /\.\.\.\(onHermes && \(cwd\.trim\(\) \|\| existing\?\.cwd\) \? \{ cwd: cwd\.trim\(\) \} : \{\}\)/);
  assert.match(ed, /const needFolder = onHermes && !cwd\.trim\(\) && !inProject;/);
});

// ---------------------------------------------------------------- wiring pins and copy rules

test('the agent rail never shows a raw model id for an agent with no description', () => {
  assert.doesNotMatch(src('ui/src/components/AgentRail.tsx'), /a\.description \|\| a\.model/, 'live check 2026-10-22: the rail showed "acp:hermes"');
  assert.match(src('ui/src/components/AgentRail.tsx'), /a\.description \|\| modelLabel\(/);
});

test('wiring: the thread, the card, the Doctor and Settings use the new parts', () => {
  const th = src('ui/src/components/Thread.tsx');
  assert.match(th, /<HermesBadge/);
  assert.match(th, /<HermesUsage/);
  assert.match(th, /task\?\.provider && !task\.runtime/, 'the provider tooltip is not for Hermes tasks');
  assert.match(src('ui/src/components/ApprovalCard.tsx'), /a\.acpOptions\?\.length[\s\S]*<AcpCard/);
  assert.match(th, /closedCards[\s\S]*<ClosedAcpCard/, 'R60: the thread renders the closed cards of its task');
  assert.match(src('ui/src/components/AcpCard.tsx'), /hadFocus\.current = box\.current\.contains\(document\.activeElement\)/, 'R60 live check 2026-10-22: the card reads where focus is while rendering, because its buttons are gone by the time an effect runs and focus had dropped to the page');
  assert.match(src('ui/src/components/DoctorModal.tsx'), /checkKind/);
  assert.match(src('ui/src/components/Settings.tsx'), /section === 'hosts'/);
  assert.match(src('ui/src/components/ModelPicker.tsx'), /hosts/);
  assert.match(src('ui/src/store.ts'), /keepProbedAgentRows/);
  assert.match(src('ui/src/api.ts'), /optionId/);
  assert.match(th, /threadOnHermes\(task, agent\)/, 'the run header does not claim a Legion mode for Hermes');
});

test('copy: no dash, no "this computer", only Hermes and Claude named, in every new string', () => {
  for (const f of ['src/electron/acp-switch-ipc.ts', 'src/shared/acp-copy.ts', 'ui/src/components/AcpCard.tsx', 'ui/src/components/AcpFirstUse.tsx', 'ui/src/acp/HermesBadge.tsx', 'ui/src/settings/AgentHostsSection.tsx', 'ui/src/doctorLogic.ts']) {
    const text = src(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(text, NO_DASH, f);
  }
  for (const k of SWITCH_ORDER) assert.doesNotMatch(SWITCH_COPY[k].label + SWITCH_COPY[k].hint, NO_DASH);
  assert.doesNotMatch(HERMES_NOTE + HERMES_BADGE + NOT_APPLIED_TO_HERMES, NO_DASH);
});

test('M2: /model acp:hermes shows the first-use card like the picker; Not now leaves the agent as it was', () => {
  assert.equal(slashModelStep('acp:hermes', false, false), 'ask', 'the card, the same as a pick in the picker');
  assert.equal(slashModelStep('acp:hermes', true, false), 'set', 'met once: the model is set');
  assert.equal(slashModelStep('sonnet', false, false), 'set', 'a Claude model never asks');
  assert.equal(slashModelStep('acp:hermes', false, true), 'send', 'a one-off message goes on as before (it is not a model change)');
  assert.deepEqual(firstUseOutcome('notNow', 'sonnet', 'acp:hermes'), { model: 'sonnet', seen: true }, 'Not now keeps the agent');
  const cmd = src('ui/src/commands.ts');
  assert.match(cmd, /slashModelStep\(value, .*firstUseSeen === true, rest\.length > 0\)/, 'the slash path asks the same question as the picker');
  assert.match(cmd, /new CustomEvent\('legion:model-picker', \{ detail: \{ pending: value \} \}\)/, 'and opens the picker on the card');
  const comp = src('ui/src/components/Composer.tsx');
  assert.match(comp, /<ModelPicker[^>]*pending=\{pendingHost\}/, 'the composer hands the pick to the picker');
  assert.match(src('ui/src/components/ModelPicker.tsx'), /useState<string \| null>\(pending \?\? null\)/, 'the picker opens on the card');
});
