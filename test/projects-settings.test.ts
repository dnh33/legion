/** The project Settings tab (pure): park minutes, budget amount, what counts as changed, the reads grant rule and its round trip through the real gate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideGate } from '../src/core/gates.js';
import type { GateRule } from '../src/shared/types.js';
import {
  PARK_ERROR, SETTINGS_NAV, awayFormModel, budgetPatch, changedSections, findReadsGrant, folderGlob, parseBudget, parseParkMinutes, readsGrantRule, staleReadsGrants,
} from '../ui/src/projects/page/settingsLogic.js';

const DEFAULT = { onSilence: { mode: 'deny' as const, parkMinutes: 3 }, paused: false, budget: null, notify: 'problems' as const };

test('park minutes: a whole number from 1 to 120; everything else is refused with the alert text', () => {
  assert.equal(PARK_ERROR, 'Enter a whole number from 1 to 120.');
  assert.deepEqual(parseParkMinutes('3'), { ok: true, value: 3 });
  assert.deepEqual(parseParkMinutes(' 120 '), { ok: true, value: 120 });
  assert.deepEqual(parseParkMinutes('1'), { ok: true, value: 1 });
  for (const bad of ['0', '121', '3.5', '', ' ', 'abc', '-4', '1e2', '3 min', '0x10']) assert.deepEqual(parseParkMinutes(bad), { ok: false, error: PARK_ERROR }, `"${bad}"`);
});

test('budget amount: a positive finite dollar amount, rounded to cents; zero, negative, NaN and words are refused', () => {
  assert.deepEqual(parseBudget('50'), { ok: true, value: 50 });
  assert.deepEqual(parseBudget('$12.345'), { ok: true, value: 12.35 });
  assert.deepEqual(parseBudget(' 0.5 '), { ok: true, value: 0.5 });
  for (const bad of ['0', '-3', '', 'NaN', 'Infinity', 'abc', '0.001', '1000001']) assert.equal(parseBudget(bad).ok, false, `"${bad}"`);
});

test('the budget patch: on sends the limit and period, off sends null', () => {
  assert.deepEqual(budgetPatch(true, 50, 'week'), { budget: { limit: 50, period: 'week' } });
  assert.deepEqual(budgetPatch(false, 50, 'week'), { budget: null });
});

test('changed from the default: only the sections that differ get a dot', () => {
  assert.deepEqual([...changedSections(DEFAULT)], []);
  assert.deepEqual([...changedSections({ ...DEFAULT, paused: true })], ['away']);
  assert.deepEqual([...changedSections({ ...DEFAULT, onSilence: { mode: 'park', parkMinutes: 5 } })], ['away']);
  assert.deepEqual([...changedSections({ ...DEFAULT, budget: { limit: 50, period: 'week' } })], ['budget']);
  assert.deepEqual([...changedSections({ ...DEFAULT, notify: 'nothing' })], ['notify']);
  assert.deepEqual([...changedSections({ ...DEFAULT, onSilence: { mode: 'deny', parkMinutes: 9 } })], [], 'park minutes only matter while parking');
});

test('the nav lists the eight sections in the spec order', () => {
  assert.deepEqual(SETTINGS_NAV.map((n) => n.label), ['General', 'Folders', 'Members', 'While you are away', 'Safety', 'Budget', 'Notifications', 'Archive']);
});

test('While you are away: Park is offered only when the core says it can; keep-awake likewise', () => {
  const none = awayFormModel({});
  assert.deepEqual(none.silenceModes, ['deny']);
  assert.equal(none.keepAwake, false);
  assert.deepEqual(awayFormModel({ park: true, keepAwake: true }).silenceModes, ['deny', 'park']);
  assert.equal(awayFormModel({ keepAwake: true }).keepAwake, true);
  // a project already set to park on a core that cannot park still shows the truth: wait, then deny
  assert.equal(awayFormModel({}, 'park').shownMode, 'deny');
});

test('folder glob: forward slashes, no trailing slash, spaces kept', () => {
  assert.equal(folderGlob('C:\\Users\\Daniel\\My Shop\\'), 'C:/Users/Daniel/My Shop/**');
  assert.equal(folderGlob('/home/dan/shop/'), '/home/dan/shop/**');
});

test('the reads grant is one project-scoped allow rule, and the real gate honours exactly that scope', () => {
  const project = { id: 'proj_aaaaaaaaaaaa', folder: 'C:\\Users\\Daniel\\My Shop' };
  const rule = readsGrantRule(project, 'gr_000000000001');
  assert.deepEqual(rule.when, { projects: ['proj_aaaaaaaaaaaa'], tools: ['reads'], paths: ['C:/Users/Daniel/My Shop/**'] });
  assert.equal(rule.then, 'allow'); assert.equal(rule.source, 'card'); assert.equal(rule.enabled, true);
  const call = (toolName: string, input: Record<string, unknown>, projectId = project.id) => decideGate({ toolName, input, agentId: 'scout', projectId, cwd: project.folder }, [rule], 'ask', false).verdict;
  assert.equal(call('Read', { file_path: 'C:\\Users\\Daniel\\My Shop\\src\\a.ts' }), 'allow');
  assert.equal(call('Read', { file_path: 'src/a.ts' }), 'allow', 'relative to the project folder');
  assert.equal(call('Read', { file_path: 'C:\\Users\\Daniel\\Other\\a.ts' }), 'baseline', 'outside the folder still asks');
  assert.equal(call('Read', { file_path: 'C:\\Users\\Daniel\\My Shop\\..\\Other\\a.ts' }), 'baseline', 'a dot-dot way out still asks');
  assert.equal(call('Write', { file_path: 'C:\\Users\\Daniel\\My Shop\\src\\a.ts' }), 'baseline', 'writes still ask');
  assert.equal(call('Bash', { command: 'cat src/a.ts' }), 'baseline', 'commands still ask');
  assert.equal(call('Read', { file_path: 'src/a.ts' }, 'proj_bbbbbbbbbbbb'), 'baseline', 'another project is not covered');
  // a capped run (started by an outside client) never gets it
  assert.equal(decideGate({ toolName: 'Read', input: { file_path: 'src/a.ts' }, projectId: project.id, cwd: project.folder }, [rule], 'ask', true).verdict, 'baseline');
});

test('finding the grant: this project\'s reads rule, nothing else; a disabled copy does not count as granted', () => {
  const project = { id: 'proj_aaaaaaaaaaaa', folder: '/p' };
  const mine = readsGrantRule(project, 'gr_000000000001');
  const other = readsGrantRule({ id: 'proj_bbbbbbbbbbbb', folder: '/q' }, 'gr_000000000002');
  const typed: GateRule = { id: 'gr_000000000003', enabled: true, then: 'allow', when: { tools: ['reads'] }, label: 'x', source: 'user' };
  assert.equal(findReadsGrant([other, typed], project), undefined);
  assert.equal(findReadsGrant([other, typed, mine], project)?.id, 'gr_000000000001');
  assert.equal(findReadsGrant([{ ...mine, enabled: false }], project), undefined);
});

test('after a folder change: the old folder reads rule is stale; the current one, other projects and hand-typed rules are not', () => {
  const was = { id: 'proj_aaaaaaaaaaaa', folder: '/old' };
  const now = { id: 'proj_aaaaaaaaaaaa', folder: '/new' };
  const oldRule = readsGrantRule(was, 'gr_000000000001');
  const newRule = readsGrantRule(now, 'gr_000000000002');
  const otherProject = readsGrantRule({ id: 'proj_bbbbbbbbbbbb', folder: '/old' }, 'gr_000000000003');
  const typed: GateRule = { id: 'gr_000000000004', enabled: true, then: 'allow', when: { projects: [now.id], tools: ['reads'], paths: ['/old/**'] }, label: 'my own rule', source: 'user' };
  const wider: GateRule = { ...oldRule, id: 'gr_000000000005', when: { ...oldRule.when, tools: ['reads', 'shell'] } };
  assert.deepEqual(staleReadsGrants([oldRule, newRule, otherProject, typed, wider], now).map((r) => r.id), ['gr_000000000001']);
  assert.equal(findReadsGrant([oldRule], now), undefined, 'the old rule never reads as the new folder grant (the grant does not move)');
  assert.deepEqual(staleReadsGrants([oldRule], was), [], 'nothing is stale while the folder is unchanged');
  assert.deepEqual(staleReadsGrants([{ ...oldRule, enabled: false }], now).map((r) => r.id), ['gr_000000000001'], 'a switched-off leftover is cleaned up too');
});

test('no em or en dash and no "this computer" in the settings copy', () => {
  const src = readFileSync(join(process.cwd(), 'ui', 'src', 'projects', 'page', 'settingsLogic.ts'), 'utf8');
  assert.equal(/[\u2013\u2014]/.test(src), false);
  assert.equal(/this (computer|machine)/i.test(src), false);
});
