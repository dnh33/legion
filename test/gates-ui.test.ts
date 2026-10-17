/**
 * Settings -> Gates and the agent-shell control, as rendered: the pure view-model (sentences, tester, rails)
 * checked directly, then a real render through esbuild + react-dom/server (store stubbed) proving the section,
 * the builder, the rule cards, the tester readout, the locked rails and the agent editor's Shell fieldset draw
 * what the model says.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import {
  GATE_PRESETS, MODE_TEXT, TOOL_CHIPS, VERDICT_TEXT, consequenceLine, gateSentence, gateTestResult, newGateId, presetRule, ruleHostless, toggleIn,
} from '../ui/src/gates/gatesLogic.js';
import { railRows } from '../ui/src/gates/presetsLogic.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const AGENTS = [
  { id: 'zealot', name: 'Zealot', emoji: 'Z', approval: 'ask', description: '', systemPrompt: '', model: 'auto', mcpServers: ['*'], vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, createdAt: '', updatedAt: '', host: { enabled: true, rootDir: 'D:/work/site', timeoutSeconds: 300 } },
  { id: 'scout', name: 'Scout', emoji: 'S', approval: 'full', description: '', systemPrompt: '', model: 'auto', mcpServers: ['*'], vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, createdAt: '', updatedAt: '' },
];
const nameOf = (id: string) => { const a = AGENTS.find((x) => x.id === id); return a ? `${a.emoji} ${a.name}` : id; };
const rule = (over: Record<string, unknown>) => ({ id: 'gr_' + 'a'.repeat(12), enabled: true, then: 'deny', when: {}, label: 'l', source: 'user', ...over }) as any;

// ---------------------------------------------------------------- view-model

test('gateSentence reads as a sentence for every class and scope', () => {
  assert.equal(gateSentence({ commands: ['git *'] }, 'allow', nameOf), 'Zealot may run `git *`'.replace('Zealot', 'Every agent'), 'no agents = Every agent');
  assert.equal(gateSentence({ agents: ['zealot'], commands: ['git *'] }, 'allow', nameOf), 'Z Zealot may run `git *`');
  assert.equal(gateSentence({ agents: ['scout'], commands: ['rm -rf *'] }, 'deny', nameOf), 'S Scout may never run `rm -rf *`');
  assert.equal(gateSentence({ agents: ['zealot'], commands: ['git *'] }, 'ask', nameOf), 'Z Zealot needs your OK before running `git *`');
  assert.equal(gateSentence({ tools: ['edits'] }, 'ask', nameOf), 'Every agent needs your OK before using file edits');
  assert.equal(gateSentence({ paths: ['src/**'] }, 'deny', nameOf), 'Every agent may never change files matching `src/**`');
  // the pair Remember makes (`X` and `X *`) reads once: both forms are allowed, so neither alone is the truth
  assert.equal(gateSentence({ agents: ['zealot'], commands: ['git status', 'git status *'] }, 'allow', nameOf), 'Z Zealot may run `git status` with any arguments');
  assert.equal(gateSentence({ agents: ['zealot'], commands: ['pwd', 'pwd *', 'ls', 'ls *'] }, 'ask', nameOf), 'Z Zealot needs your OK before running `pwd` with any arguments or `ls` with any arguments');
  assert.equal(gateSentence({ commands: ['git push *'] }, 'deny', nameOf), 'Every agent may never run `git push *`', 'a lone `X *` stays as written');
  assert.equal(gateSentence({ agents: ['zealot'], commands: ['npm run *'], projects: ['website'], contexts: ['capped'] }, 'ask', nameOf),
    'Z Zealot needs your OK before running `npm run *` \u00b7 in website \u00b7 only when started by claude code or another bot');
});

test('newGateId is the gr_<12 hex> shape the config accepts; toggleIn adds and removes', () => {
  assert.match(newGateId(), /^gr_[0-9a-f]{12}$/);
  assert.deepEqual(toggleIn(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b']);
});

test('ruleHostless: a host rule for an agent without the shell says so; a host-enabled agent silences it', () => {
  assert.equal(ruleHostless({ tools: ['shell'] }, AGENTS), false, 'a shell rule is not a host rule');
  assert.equal(ruleHostless({ tools: ['host'] }, AGENTS), false, 'zealot has the shell on');
  assert.equal(ruleHostless({ tools: ['host'], agents: ['scout'] }, AGENTS), true, 'scout has no shell');
  assert.equal(ruleHostless({ tools: ['mcp__host__*'] }, AGENTS), false, 'a host glob is a host rule, and zealot has the shell');
});

test('consequenceLine tells the truth per class, including the Full + Ask rule', () => {
  assert.match(consequenceLine('deny', 'full'), /every mode/);
  assert.match(consequenceLine('ask', 'full'), /Ask rules are off here/);
  assert.match(consequenceLine('ask', 'auto-edits'), /Allow edits, ask for Bash\/MCP/);
  assert.match(consequenceLine('allow', 'ask'), /never loosens a run another bot started/);
});

test('gateTestResult IS decideGate: a deny rule answers DENY with the rule, no rules answers baseline', () => {
  const deny = rule({ id: 'gr_' + 'b'.repeat(12), when: { commands: ['rm -rf *'] }, label: 'No rm -rf' });
  const d = gateTestResult([deny], { toolName: 'Bash', input: { command: 'rm -rf /' }, agentId: 'zealot', mode: 'full' });
  assert.equal(d.verdict, 'deny', 'the tester denies in full, exactly like the engine will');
  assert.deepEqual(d.matched.map((r) => r.label), ['No rm -rf']);
  assert.equal(gateTestResult([], { toolName: 'Bash', input: { command: 'ls' }, agentId: 'zealot', mode: 'ask' }).verdict, 'baseline');
  assert.equal(VERDICT_TEXT.baseline.includes('mode decides'), true);
  assert.equal(MODE_TEXT.full, 'Full access, never ask');
});

test('presets are offered, never auto-applied, and a preset rule is stamped as such', () => {
  const r = presetRule(GATE_PRESETS[0]!);
  assert.equal(r.source, 'preset');
  assert.equal(r.then, 'deny');
  assert.deepEqual(r.when.commands, ['rm -rf *', 'sudo *', 'mkfs*', 'format *']);
  assert.match(r.id, /^gr_/);
  // destructive classes are never proposed as allow (Hermes rule)
  assert.ok(GATE_PRESETS.every((p) => p.then !== 'allow'));
});

// ---------------------------------------------------------------- real render

type Render = Record<string, (...args: any[]) => string>;
async function loadUi(state: Record<string, unknown>): Promise<{ r: Render; saved: unknown[]; cleanup: () => void }> {
  const ui = (p: string) => JSON.stringify(join(REPO, p));
  const reactReal = createRequire(join(REPO, 'package.json')).resolve('react');
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { GatesSection, GateBuilder, GateRuleCard, GateTestOut, GateRails, GateSuggestions } from ${ui('ui/src/gates/GatesSection.tsx')};
        import { AgentEditor } from ${ui('ui/src/components/AgentEditor.tsx')};
        const render = (el) => renderToStaticMarkup(el);
        export const section = (rules) => render(createElement(GatesSection, { s: { gates: { rules, presetsVersion: 0 } } }));
        export const sectionWith = (gates) => render(createElement(GatesSection, { s: { gates } }));
        export const builder = (draft) => render(createElement(GateBuilder, { draft, setDraft: () => {}, agents: globalThis.__st.agents, projects: globalThis.__st.projects, projectOf: globalThis.__projectOf, mode: draft.mode ?? 'ask', onCancel: () => {}, onSave: () => {}, saveLabel: 'Add gate' }));
        export const card = (r, hostless) => render(createElement(GateRuleCard, { r, nameOf: globalThis.__nameOf, projectOf: globalThis.__projectOf, hostless: !!hostless, busy: false, confirmDelete: false, onToggle: () => {}, onEdit: () => {}, onDelete: () => {}, onCancelDelete: () => {} }));
        export const testOut = (result) => render(createElement(GateTestOut, { result }));
        export const rails = () => render(createElement(GateRails));
        export const suggestions = (items) => render(createElement(GateSuggestions, { items, nameOf: globalThis.__nameOf, busy: false, onAdd: () => {}, onDismiss: () => {} }));
        export const editor = (id) => render(createElement(AgentEditor, { id }));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        b.onResolve({ filter: /providersStore$/ }, () => ({ path: 'providers-store', namespace: 'stub' }));
        b.onLoad({ filter: /^providers-store$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const providerModelGroups = () => []; export const providerModelLabel = (m) => m;
          export const loadProviders = async () => {}; export const useProviders = (sel) => sel(globalThis.__prov ?? { view: null });` }));
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
        b.onResolve({ filter: /^(\.\.\/)*store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const useStore = (sel) => sel(globalThis.__st);
          export const saveSettings = async (p) => { globalThis.__saved.push(p); };
          export const errText = (e) => (e && e.message) ? e.message : String(e);
          export const saveAgent = async () => {}; export const removeAgent = async () => {};
          export const loadGateSuggestions = async () => []; export const dismissGateSuggestion = async () => {}; export const rememberGate = async () => {};
          export const closeOverlays = () => {}; export const openSettings = () => {}; export const loadCatalog = async () => {};
          export const toast = () => {}; export const openEditor = () => {}; export const selectAgent = () => {};` }));
      },
    }],
  });
  const dir = cleanupTemp('gates-ui-');
  const file = join(dir, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  const g = globalThis as { __st?: unknown; __saved?: unknown[]; __nameOf?: (id: string) => string; __projectOf?: (id: string) => string };
  g.__st = state; g.__saved = []; g.__nameOf = nameOf; g.__projectOf = (id: string) => id;
  return { r: createRequire(file)(file) as Render, saved: g.__saved, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const baseState = () => ({ agents: AGENTS, projects: [{ id: 'website', name: 'website', members: ['zealot', 'scout'] }], tasks: [], catalog: null, boatHealth: null });

test('render: an empty Gates section teaches the layering and offers the tester, the preset and the locked rails', async () => {
  const { r, saved, cleanup } = await loadUi(baseState());
  try {
    const html = r.section([]);
    assert.match(html, /Mode first, gates on top/);
    assert.match(html, /No gates yet/);
    assert.match(html, /New gate/);
    assert.match(html, /Suggested: never rm -rf \/ sudo/);
    assert.match(html, /Try it/);
    assert.match(html, /Nothing runs/);
    assert.match(html, /Rails — locked|Rails/);
    for (const rail of railRows()) assert.ok(html.includes(rail.label), `rail shown: ${rail.label}`);
    assert.equal(saved.length, 0, 'rendering decides nothing and saves nothing');
  } finally { cleanup(); }
});

test('render: rule cards are sentences with class badge, provenance and the affected agents; a hostless rule says so', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    const deny = rule({ id: 'gr_' + 'c'.repeat(12), when: { agents: ['zealot'], commands: ['rm -rf *'] }, label: 'No rm -rf', source: 'preset' });
    const allowHost = rule({ id: 'gr_' + 'd'.repeat(12), then: 'allow', when: { agents: ['scout'], tools: ['host'] }, label: 'Scout may use the host shell', source: 'user' });
    const html = r.section([deny, allowHost]);
    assert.match(html, /Z Zealot may never run `rm -rf \*`/, 'the card shows the sentence, not the stored label');
    assert.match(html, /from a preset/);
    assert.match(html, /Affects: Z Zealot/);
    assert.match(html, /S Scout may use host shell/);
    assert.match(html, /yours/);
    assert.match(html, /has the host shell on/, 'the scout rule explains it does nothing yet');
  } finally { cleanup(); }
});

test('render: the builder shows Who/What/Where/Then with the live sentence, chips and the consequence line', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    const html = r.builder({ agents: ['zealot'], tools: ['shell'], commands: ['git *'], paths: [], exceptPaths: [], projects: [], contexts: [], then: 'ask', mode: 'ask' });
    assert.match(html, /Who/);
    assert.match(html, /Any agent/);
    assert.match(html, />Z Zealot</);
    assert.match(html, /What/);
    assert.match(html, />Shell</);
    assert.match(html, />File edits</);
    assert.match(html, /git \*/);
    assert.match(html, /Where \(optional\)/);
    assert.match(html, /Started by Claude Code or another bot/);
    assert.match(html, /Then/);
    assert.match(html, /Never ask/);
    assert.match(html, /needs your OK before running `git \*`/, 'the preview sentence sits on top');
    assert.match(html, /Makes matching calls ask you/);
  } finally { cleanup(); }
});

test('render: the tester readout prints the verdict and the rules that matched, and the honest baseline line', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    const deny = rule({ id: 'gr_' + 'e'.repeat(12), when: { commands: ['rm -rf *'] }, label: 'No rm -rf' });
    const res = gateTestResult([deny], { toolName: 'Bash', input: { command: 'rm -rf /' }, agentId: 'zealot', mode: 'full' });
    const html = r.testOut(res);
    assert.match(html, /DENY \(the call is blocked\)/);
    assert.match(html, /No rm -rf/);
    assert.match(html, /1 matching gate/);
    const base = r.testOut(gateTestResult([], { toolName: 'Bash', input: { command: 'ls' }, agentId: 'zealot', mode: 'ask' }));
    assert.match(base, /BASELINE/);
    assert.match(base, /No gate matched\. Your mode decides/);
  } finally { cleanup(); }
});

test('render: a learned suggestion reads as the rule it would add, says how often you allowed it, and offers Add rule and Dismiss', async () => {
  const { r, saved, cleanup } = await loadUi(baseState());
  try {
    assert.equal(r.suggestions([]), '', 'no suggestions, no card');
    const html = r.suggestions([{ key: 'k1', when: { agents: ['zealot'], commands: ['git status', 'git status *'] }, count: 4, agentId: 'zealot', toolName: 'Bash', input: { command: 'git status' } }]);
    assert.match(html, /Suggested from your answers/);
    assert.match(html, /Z Zealot may run `git status`/);
    assert.match(html, /You allowed this 4 times/);
    assert.match(html, />Add rule</);
    assert.match(html, />Dismiss</);
    assert.equal(saved.length, 0, 'a suggestion is never added on its own');
  } finally { cleanup(); }
});

test('render: the owner can switch learned suggestions off; the switch says what off means', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    const on = r.sectionWith({ rules: [], presetsVersion: 0 });
    assert.match(on, /Suggest gates from my answers/);
    assert.match(on, /aria-label="Suggest gates from my answers" checked=""/);
    assert.match(on, /Off keeps no record of your answers/);
    const off = r.sectionWith({ rules: [], presetsVersion: 0, learn: false });
    assert.doesNotMatch(off, /aria-label="Suggest gates from my answers" checked=""/);
  } finally { cleanup(); }
});

test('render: the agent editor has the Shell fieldset — on with the saved root and timeout, off with the placeholders', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    const on = r.editor('zealot');
    assert.match(on, /Shell \(your computer\)/);
    assert.match(on, /Let this agent run commands and read\/write files on your computer/);
    assert.match(on, /value="D:\/work\/site"/);
    assert.match(on, /value="300"/);
    assert.match(on, /1 to 3600; 120 by default/);
    const off = r.editor('scout');
    assert.match(off, /Shell \(your computer\)/);
    assert.doesNotMatch(off.slice(off.indexOf('Shell (your computer)')), /checked=""/, 'scout starts unchecked');
    assert.match(off, /placeholder="120"/);
  } finally { cleanup(); }
});

test('every tool group the core knows has a chip in Settings -> Gates (a group the owner cannot pick is a group nobody can use)', async () => {
  const { GATE_TOOL_GROUPS } = await import('../src/core/gates.js');
  assert.deepEqual(TOOL_CHIPS.map((c) => c.id).sort(), Object.keys(GATE_TOOL_GROUPS).sort());
  assert.equal(TOOL_CHIPS.find((c) => c.id === 'tasks')?.label, 'Task list');
});

// ---------------------------------------------------------------- the Gates page (Task 12)

test('render: the Gates page shows the presets, the notes, fine tuning, QA, rails and activity', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    (globalThis as { __gv?: unknown }).__gv = { app: { version: 1, preset: 'smart' }, projects: {}, unreadable: [], changedOutside: [], canSign: true };
    const html = r.section([]);
    assert.match(html, /How agents ask/);
    assert.match(html, /role="radio"|type="radio"/);
    for (const label of ['Ask', 'Accept edits', 'Smart', 'Bypass']) assert.ok(html.includes(`<b>${label}</b>`), label);
    assert.match(html, /<input type="radio"[^>]*checked=""[^>]*\/><span><b>Smart<\/b>/, 'Smart is the chosen preset');
    assert.ok(html.includes('Legion has no sandbox for commands on your computer.'));
    assert.match(html, /Fine tuning/);
    assert.match(html, /class="gates-value">On, limit 4</, 'at the app default the gates read as plain values, not switches');
    assert.ok(!/role="switch"/.test(html));
    assert.match(html, /Check which websites agents read/, 'the new web gate has a row');
    assert.match(html, /These follow each goal.s care level/);
    assert.match(html, /Always on/);
    assert.match(html, /Activity/);
    assert.ok(!/Gate settings changed outside Legion/.test(html), 'no banner when nothing changed');
    assert.ok(!/Shell safety floor|Expert/.test(html), 'no expert block, no shell-floor switch');
    assert.ok(!html.includes('\u2014'), 'no em dash anywhere on the page');
  } finally { delete (globalThis as { __gv?: unknown }).__gv; cleanup(); }
});

test('render: a file changed outside Legion shows the banner with Accept and Keep mine; without a key the looser presets say why', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    (globalThis as { __gv?: unknown }).__gv = { app: { version: 1 }, projects: {}, unreadable: ['website'], changedOutside: ['app'], canSign: false };
    const html = r.section([]);
    assert.match(html, /Gate settings changed outside Legion\./);
    assert.match(html, /Legion is using Ask for all projects until you decide\./);
    assert.match(html, />Accept</); assert.match(html, />Keep mine</); assert.match(html, />Reload</);
    assert.match(html, /The gate settings for the project website could not be read, so Legion is using Ask for it\./);
    assert.ok(html.includes('Legion cannot sign settings on your computer, so only Ask is available.'));
    assert.equal((html.match(/type="radio"[^>]*disabled=""/g) ?? []).length, 3, 'the three looser radios are disabled');
  } finally { delete (globalThis as { __gv?: unknown }).__gv; cleanup(); }
});
