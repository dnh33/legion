/**
 * The closing UI fix round of 0.3.5: the pieces that have logic or a pinned design (the rest was read in rendered shots).
 * A test here names the finding it guards (Bug 1-4, P1-P10 of the kodawari close report).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewAgentMode } from '../src/core/gates-settings/agent-mode.js';
import type { ModeWorld } from '../src/core/gates-settings/agent-mode.js';
import { agentModeBatch, agentModeChange } from '../src/electron/agent-mode-ipc.js';
import { usesDefaultFolder } from '../src/shared/projects.js';
import { noticeFor } from '../src/core/web-search/routes.js';
import { KEYED_COST_NOTICE, PROVIDER_NOTICE, TREG_NOTICE } from '../src/shared/web-search-copy.js';
import { parseCap } from '../ui/src/providers/webSearchModel.js';
import { trustHeading } from '../ui/src/gates/trustLogic.js';
import { withBoot } from './agent-mode-rig.js';
import { repoRoot } from './ps-helpers.js';

const src = (p: string): string => readFileSync(join(repoRoot, p), 'utf8').replace(/\r\n/g, '\n');
const OWN_ASK = { approval: 'ask' as const, approvalSource: 'own' as const };
const world = (over: Partial<ModeWorld['projects'][number]> = {}): ModeWorld => ({ appPreset: undefined, projects: [{ id: 'proj_a', name: 'Shop', preset: 'ask', ...over }] });
const preview = (w: ModeWorld, change: { approval?: 'ask' | 'auto-edits' | 'full'; approvalSource?: 'own' | 'project' }) => previewAgentMode({ agentId: 'alpha', name: 'Alpha', before: OWN_ASK, change, world: w });

// ---------------------------------------------------------------- P8: the "ask less" dialog says where a project limit still holds the agent

test('P8: a raise in a project that limits its agents adds "will still ask in the project" (project limit)', () => {
  const pv = preview(world(), { approval: 'auto-edits' });
  assert.equal(pv.raises, true);
  assert.deepEqual(pv.loosening.filter((l) => l.includes('project limit')), ['Alpha will still ask in the project "Shop" (project limit).']);
  assert.match(pv.loosening[0]!, /^Alpha will change files without asking/, 'the main sentence stays first');
});
test('P8: no such line when the limit is off, when the project has no preset, or when the agent follows the project', () => {
  assert.equal(preview(world({ limit: false }), { approval: 'auto-edits' }).loosening.some((l) => l.includes('project limit')), false);
  assert.equal(preview(world({ preset: undefined }), { approval: 'auto-edits' }).loosening.some((l) => l.includes('project limit')), false);
  assert.equal(preview(world({ preset: 'bypass' }), { approval: 'full' }).loosening.some((l) => l.includes('project limit')), false, 'the project allows as much as the agent');
  // following a project that sits at Ask is not a raise at all
  assert.equal(preview(world(), { approvalSource: 'project' }).raises, false);
});
test('P8: a cap that is looser than Ask is named by its mode', () => {
  const pv = preview(world({ preset: 'accept-edits' }), { approval: 'full' });
  assert.ok(pv.loosening.includes('Alpha will still run as Accept edits in the project "Shop" (project limit).'), pv.loosening.join(' | '));
});
test('P8: the digest binds the limit switch, so a limit turned off while the dialog is open cannot reuse the answer', () => {
  const on = preview(world(), { approval: 'auto-edits' }).digest;
  const off = preview(world({ limit: false }), { approval: 'auto-edits' }).digest;
  const absent = preview(world({ limit: true }), { approval: 'auto-edits' }).digest;
  assert.notEqual(on, off);
  assert.equal(on, absent, 'absent means on, like the run');
});
test('P8: the editor dialog (real core, fake dialog) shows the line; with the limit off it does not', withBoot([true, true], async (r) => {
  const p = r.projects.create({ name: 'Shop', instructions: '' });
  r.projects.setMembers(p.id, ['alpha', 'bravo']);
  r.core.store.patchProject(p.id, { preset: 'ask' });
  const res = await agentModeChange({ agentId: 'alpha', approval: 'auto-edits' }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 1);
  assert.ok(r.dialogs[0]!.detail.includes('Alpha will still ask in the project "Shop" (project limit).'), r.dialogs[0]!.detail);
  r.core.store.patchProject(p.id, { limit: false });
  const res2 = await agentModeChange({ agentId: 'bravo', approval: 'auto-edits' }, r.deps);
  assert.equal(res2.ok, true, res2.error);
  assert.ok(!r.dialogs[1]!.detail.includes('project limit'), r.dialogs[1]!.detail);
}));
test('P8: the first-run batch dialog groups agents that share the line, in plain grammar', withBoot([true], async (r) => {
  const p = r.projects.create({ name: 'Shop', instructions: '' });
  r.projects.setMembers(p.id, ['alpha', 'bravo']);
  r.core.store.patchProject(p.id, { preset: 'ask' });
  const res = await agentModeBatch({ changes: [{ agentId: 'alpha', approval: 'auto-edits' }, { agentId: 'bravo', approval: 'auto-edits' }] }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.ok(r.dialogs[0]!.detail.includes('Alpha and Bravo will still ask in the project "Shop" (project limit).'), r.dialogs[0]!.detail);
}));

// ---------------------------------------------------------------- P9: Use default folder

test('P9: a project is on its default folder when the path ends in projects/<its id> (either slash, a trailing one too)', () => {
  const id = 'proj_a87e2c07e386';
  assert.equal(usesDefaultFolder({ id, folder: `C:\\Users\\you\\.legion\\workspaces\\projects\\${id}` }), true);
  assert.equal(usesDefaultFolder({ id, folder: `/home/you/.legion/workspaces/projects/${id}/` }), true);
  assert.equal(usesDefaultFolder({ id, folder: `D:\\work\\shop` }), false);
  assert.equal(usesDefaultFolder({ id, folder: `D:\\work\\projects\\other` }), false);
  assert.equal(usesDefaultFolder({ id, folder: `D:\\work\\notprojects\\${id}` }), false);
  assert.equal(usesDefaultFolder({ id, folder: id }), false);
  assert.equal(usesDefaultFolder({ id, folder: '' }), false);
});
test('P9: the button is off with a reason when the folder is the default, and the reason is on the page', () => {
  const s = src('ui/src/projects/page/SettingsTab.tsx');
  assert.match(s, /disabled=\{busy \|\| isDefault\}/);
  assert.match(s, /This project already uses its default folder\./);
});

// ---------------------------------------------------------------- P7: the folder-trust card heading

test('P7: the heading is "held back" until every folder on the card is trusted, then it says trusted', () => {
  assert.equal(trustHeading(1, 0), "This folder's settings were held back");
  assert.equal(trustHeading(1, 1), 'This folder is trusted');
  assert.equal(trustHeading(2, 1), "These folders' settings were held back");
  assert.equal(trustHeading(2, 2), 'These folders are trusted');
  assert.equal(trustHeading(0, 0), "These folders' settings were held back", 'an empty card never claims trust');
  const s = src('ui/src/components/FolderTrustCard.tsx');
  assert.match(s, /onTrusted\(f\.folder\)/, 'a confirmed Trust reports to the card');
});

// ---------------------------------------------------------------- P10: web search words

test('P10: one term, "per-call spending cap", in the label, the notice, the stop message and the range error', () => {
  const ui = src('ui/src/providers/WebSearchSection.tsx');
  assert.match(ui, /Per-call spending cap/);
  assert.doesNotMatch(ui, /cap per call|limit per call/i);
  assert.match(TREG_NOTICE, /per-call spending cap/);
  const bad = parseCap('5', { min: 0.001, max: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /per-call spending cap/);
  assert.doesNotMatch(src('src/shared/web-search-copy.ts'), /limit per call|cap per call/i);
});
test('P10: a paid provider says it charges; SearXNG says nothing about price; no em dash', () => {
  assert.match(noticeFor('treg'), /treg charges for each call/);
  assert.ok(noticeFor('treg').includes(PROVIDER_NOTICE('treg')));
  for (const id of ['exa', 'tavily', 'brave'] as const) {
    const n = noticeFor(id);
    assert.match(n, /may charge for each call, depending on your plan there/);
    assert.ok(n.includes(KEYED_COST_NOTICE(n.includes('Brave Search') ? 'Brave Search' : id === 'exa' ? 'Exa' : 'Tavily')));
  }
  assert.equal(noticeFor('searxng'), PROVIDER_NOTICE('SearXNG'));
  for (const s of [noticeFor('treg'), noticeFor('exa'), KEYED_COST_NOTICE('Exa')]) assert.ok(!/[\u2014\u2013]/.test(s));
});
test('P10: the selects and fields in that fieldset are styled with the Settings tokens', () => {
  const css = src('ui/src/providers/providers.css');
  assert.match(css, /\.prov-row select \{[^}]*var\(--surface-2\)[^}]*var\(--line-strong\)/);
  assert.match(css, /\.prov-row input:not\(\[type='checkbox'\]\)[^{]*\{[^}]*var\(--surface-2\)/);
});

// ---------------------------------------------------------------- P1: key store notice first, Doctor row without a Copy

test('P1: the key store notice comes before the long explainer on Providers, and the blocked state keeps its one button', () => {
  const s = src('ui/src/providers/ProvidersSection.tsx');
  const notice = s.indexOf("view.keyStoreState === 'blocked'");
  const explainer = s.indexOf('<details className="prov-limits"');
  assert.ok(notice > 0 && explainer > 0 && notice < explainer, 'notice first');
  assert.match(s, /Start over with new keys/);
  assert.equal(s.split('{view.keyStore &&').length - 1, 0, 'the old line below the explainer is gone');
});
test('P1: the Doctor row for the key store shows its fix as a sentence with a button to Providers, not a command to copy', () => {
  const s = src('ui/src/components/DoctorModal.tsx');
  assert.match(s, /SETTINGS_FIX: Record<string, SettingsSection> = \{ 'provider-keys': 'providers' \}/);
  assert.match(s, /!c\.ok && c\.fix && c\.id in SETTINGS_FIX &&/, 'the sentence and the button are shown for it');
  assert.match(s, /!\(c\.id in SETTINGS_FIX\)/, 'the Copy row is skipped for it');
  assert.match(s, /Open Providers settings/);
});

// ---------------------------------------------------------------- P2: the Inherit help

test('P2: the Inherit help is three short blocks, the path is quoted, and the pinned allow-rule sentence is intact', () => {
  const line = src('ui/src/components/Settings.tsx').split('\n').find((l) => l.includes('Inherit my Claude Code settings') && l.includes('<em>'))!;
  const blocks = line.match(/<em>[^<]*<\/em>/g) ?? [];
  assert.equal(blocks.length, 3);
  for (const b of blocks) assert.ok(b.length < 330, `a short block: ${b.length}`);
  assert.match(line, /Settings, Gates, Fine tuning, "Folders you trust"/);
  assert.match(line, /A project's CLAUDE\.md is always read\./);
});

// ---------------------------------------------------------------- Bug 3: the offline state says the next step

test('Bug 3: the next step is one sentence that is true whether the core stopped or is still starting, and every offline place uses it', () => {
  const api = src('ui/src/api.ts');
  const step = /export const CORE_NEXT_STEP = '([^']+)';/.exec(api)?.[1] ?? '';
  assert.equal(step, 'If it stopped, use Restart core in the tray menu, or restart Legion.');
  assert.match(api, /export const CORE_UNREACHABLE = `Cannot reach Legion core\. \$\{CORE_NEXT_STEP\}`;/);
  assert.match(api, /throw new ApiError\(0, CORE_UNREACHABLE\)/);
  for (const f of ['ui/src/components/Thread.tsx', 'ui/src/components/TitleBar.tsx', 'ui/src/graph/GraphView.tsx']) assert.match(src(f), /CORE_NEXT_STEP/, f);
  assert.match(src('ui/src/rooms/roomsStore.ts'), /new Error\(CORE_UNREACHABLE\)/);
  assert.match(src('ui/src/graph/GraphView.tsx'), /bootError === CORE_UNREACHABLE/, 'the graph still recognises the offline error');
  assert.ok(!/[\u2014\u2013]/.test(step));
});
test('Bug 3: no automatic core restart was added in the window (owner ruling: 0.3.6)', () => {
  const main = src('src/electron/main.ts');
  const exit = /child\.on\('exit'[\s\S]*?\n    \}\);/.exec(main)?.[0] ?? '';
  assert.ok(exit, 'the exit handler is there');
  assert.doesNotMatch(exit, /spawnCore|restartCore|ensureCore/, 'the exit handler only records the exit');
});

// ---------------------------------------------------------------- Bug 1, Bug 2, P4, P5, P6: layout rules that were measured in a browser

test('Bug 1: in the tab-strip layout a settings group keeps its width instead of shrinking over its neighbour', () => {
  const css = src('ui/src/styles/app.css');
  const media = /@media \(max-width: 1100px\) \{\n  \.settings[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
  assert.match(media, /\.set-group, \.set-group\.bare \{ flex: none;/);
});
test('Bug 2: in Try it a long agent name is cut inside its select and cannot widen the card', () => {
  const css = src('ui/src/gates/gates.css');
  assert.match(css, /\.gate-tester \.set-inline > label \{[^}]*min-width: 0/);
  assert.match(css, /\.gate-tester \.set-inline select \{[^}]*width: 100%[^}]*max-width: 100%[^}]*text-overflow: ellipsis/);
});
test('P3: Folders you trust has its own heading and a divider, not the indent of a gate row', () => {
  const css = src('ui/src/gates/gates.css');
  assert.match(css, /\.gates-sites\.gates-trust \{[^}]*border-top: 1px solid/);
  assert.match(src('ui/src/gates/TrustedFolders.tsx'), /<h3 className="gates-trust-h">\{TRUSTED_FOLDERS_LABEL\}<\/h3>/);
});
test('P4: no word sits alone on the last line of the first-run keep line', () => {
  assert.match(src('ui/src/welcome/preset-choice.css'), /\.preset-agents li \{[^}]*text-wrap: pretty/);
});
test('P6: the thread header drops its chips to their own row instead of squeezing the name (the composer bar is pinned in ui-fix-round2.test.ts)', () => {
  const css = src('ui/src/styles/app.css');
  assert.match(css, /\.thread-head \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.th-agent \{[^}]*min-width: min\(170px, 100%\)/);
});
