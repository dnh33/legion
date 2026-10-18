// test/gates-presets-logic.test.ts: the pure view model of the Gates page (Task 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATES, PRESET_LINES } from '../src/shared/gates-registry.js';
import { presetChoices, scopeSummary, permissionRows, qaRows, railRows, runsAsChip, MODE_LABEL, type GatesView } from '../ui/src/gates/presetsLogic.js';

const view = (over: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...over });

test('presetChoices has four rows, Ask first, only Ask is not looser', () => {
  const c = presetChoices();
  assert.deepEqual(c.map((x) => x.id), ['ask', 'accept-edits', 'smart', 'bypass']);
  assert.deepEqual(c.map((x) => x.label), ['Ask', 'Accept edits', 'Smart', 'Bypass']);
  assert.deepEqual(c.map((x) => x.looser), [false, true, true, true]);
  for (const x of c) assert.equal(x.line, PRESET_LINES[x.id]);
});

test('permissionRows covers every permission gate in the registry', () => {
  const ids = permissionRows(view()).map((r) => r.id);
  assert.deepEqual(ids, GATES.filter((g) => g.family === 'permission').map((g) => g.id));
  for (const id of ['protected-path-cards', 'secret-file-reads', 'env-scrub', 'web-reads']) assert.ok(ids.includes(id), id);
});

test('permissionRows marks an override and shows the preset default beside it', () => {
  const v = view({ app: { version: 1, preset: 'ask' }, projects: { p1: { version: 1, preset: 'smart', overrides: { 'tool-cards': false, 'goal-caps': { on: true, limit: 20 } } } } });
  const rows = permissionRows(v, 'p1');
  const tool = rows.find((r) => r.id === 'tool-cards')!;
  assert.equal(tool.overridden, true); assert.equal(tool.value, false); assert.equal(tool.presetDefault, true);
  assert.deepEqual(rows.find((r) => r.id === 'goal-caps')!.value, { on: true, limit: 20 });
  const plain = rows.find((r) => r.id === 'github-write-card')!;
  assert.equal(plain.overridden, false); assert.equal(plain.value, true);
  assert.ok(rows.every((r) => r.label && r.protects && r.ifOff));
  const app = permissionRows(v).find((r) => r.id === 'tool-cards')!;
  assert.equal(app.overridden, false);
});

test('scopeSummary: a project with no preset reads per-agent; a changed-outside project says so', () => {
  const v = view({
    app: { version: 1, preset: 'smart', overrides: { 'tool-cards': false } },
    projects: { a: { version: 1 }, b: { version: 1, preset: 'bypass', limit: false }, c: { version: 1, preset: 'ask' } },
    changedOutside: ['b'], unreadable: ['c'],
  });
  assert.deepEqual(scopeSummary(v, 'a'), { preset: 'per-agent', limit: false, overrides: 0, changedOutside: false, unreadable: false });
  assert.deepEqual(scopeSummary(v, 'b'), { preset: 'bypass', limit: false, overrides: 0, changedOutside: true, unreadable: false });
  assert.deepEqual(scopeSummary(v, 'c'), { preset: 'ask', limit: true, overrides: 0, changedOutside: false, unreadable: true });
  assert.deepEqual(scopeSummary(v), { preset: 'smart', limit: true, overrides: 1, changedOutside: false, unreadable: false });
  assert.equal(scopeSummary(v, 'missing').preset, 'per-agent');
});

test('qaRows lists every qa gate with its care levels', () => {
  const rows = qaRows();
  assert.deepEqual(rows.map((r) => r.id), GATES.filter((g) => g.family === 'qa').map((g) => g.id));
  for (const r of rows) assert.deepEqual([r.quick, r.normal, r.thorough], [true, true, true]);
});

test('railRows are the registry rails, with no expert key', () => {
  const rows = railRows();
  assert.equal(rows.length, GATES.filter((g) => g.family === 'rail').length);
  for (const r of rows) { assert.ok(!('expert' in r)); assert.deepEqual(Object.keys(r).sort(), ['id', 'label', 'protects']); }
});

test('MODE_LABEL names every run mode', () => {
  assert.equal(MODE_LABEL.ask, 'Ask'); assert.equal(MODE_LABEL['auto-edits'], 'Accept edits'); assert.equal(MODE_LABEL.smart, 'Smart'); assert.equal(MODE_LABEL.full, 'Bypass');
  assert.ok(MODE_LABEL['smart-edits']);
});

test('runsAsChip names the limit and the follow source', () => {
  assert.deepEqual(runsAsChip({ effective: 'ask', agentMode: 'full', source: 'own', projectName: 'Shop', projectPreset: 'ask', limit: true }), { text: 'Runs as Ask', reason: 'Agent is Full, limited by project Shop' });
  assert.deepEqual(runsAsChip({ effective: 'full', agentMode: 'ask', source: 'project', projectName: 'Shop', projectPreset: 'bypass', limit: true }), { text: 'Runs as Bypass', reason: 'Following project Shop (Bypass)' });
  assert.deepEqual(runsAsChip({ effective: 'ask', agentMode: 'full', source: 'own', ceiling: 'ask', limit: false }), { text: 'Runs as Ask', reason: 'Started by an outside app: asks' });
  assert.deepEqual(runsAsChip({ effective: 'auto-edits', agentMode: 'auto-edits', source: 'own', limit: false }), { text: 'Runs as Accept edits' });
  assert.deepEqual(runsAsChip({ effective: 'ask', agentMode: 'full', source: 'own', limit: false, lease: true }), { text: 'Runs as Ask', reason: 'Goal lease: no cards for this goal' });
});

// ---------------------------------------------------------------- Task 12: the page's own logic

import { NO_SANDBOX_LINE } from '../src/shared/gates-registry.js';
import { PAGE_NOTES, WEB_LINE, disabledReason, overridesWith, siteGroups, staleHosts, staleHostsWhenLoaded, webChip, lastUsedByHost, KEYSTORE_LINE } from '../ui/src/gates/presetsLogic.js';

test('permissionRows shows the attempt-caps limit per preset', () => {
  assert.deepEqual(permissionRows(view({ app: { version: 1, preset: 'ask' } })).find((r) => r.id === 'attempt-caps')!.value, { on: true, limit: 4 });
  assert.deepEqual(permissionRows(view({ app: { version: 1, preset: 'bypass' } })).find((r) => r.id === 'attempt-caps')!.value, { on: true, limit: 8 });
});

test('disabledReason: the keystore text for a looser preset when Legion cannot sign, nothing for Ask', () => {
  assert.equal(disabledReason(view({ canSign: false }), 'ask'), undefined);
  for (const p of ['accept-edits', 'smart', 'bypass'] as const) assert.equal(disabledReason(view({ canSign: false }), p), KEYSTORE_LINE);
  assert.equal(disabledReason(view({ canSign: true }), 'bypass'), undefined);
  assert.ok(!/this computer/i.test(KEYSTORE_LINE));
});

test('overridesWith replaces the whole map: set one gate, or drop it to go back to the preset', () => {
  const v = view({ projects: { p: { version: 1, overrides: { 'tool-cards': false } } } });
  assert.deepEqual(overridesWith(v, 'p', 'goal-caps', { on: true, limit: 20 }), { 'tool-cards': false, 'goal-caps': { on: true, limit: 20 } });
  assert.deepEqual(overridesWith(v, 'p', 'tool-cards', undefined), {});
  assert.deepEqual(overridesWith(v, 'none', 'tool-cards', true), { 'tool-cards': true });
});

const DAY = 86_400_000;
test('siteGroups: built-in, you allowed, from a goal, in that order, each sorted', () => {
  const g = siteGroups({ builtIn: ['b.dev', 'a.dev'], allowed: ['y.com', 'x.com'], goal: ['g.com'] }, {});
  assert.deepEqual(g.map((x) => [x.id, x.hosts.map((h) => h.host)]), [['built-in', ['a.dev', 'b.dev']], ['allowed', ['x.com', 'y.com']], ['goal', ['g.com']]]);
  assert.equal(g.find((x) => x.id === 'built-in')!.removable, false);
  assert.equal(g.find((x) => x.id === 'allowed')!.removable, true);
});
test('last used: the newest day, Never when absent', () => {
  const g = siteGroups({ builtIn: [], allowed: ['x.com', 'y.com'], goal: [] }, { 'x.com': '2026-10-01T10:00:00.000Z' });
  assert.equal(g[1]!.hosts[0]!.lastUsed, '2026-10-01'); assert.equal(g[1]!.hosts[1]!.lastUsed, 'Never');
});
test('siteGroups: unknown dates read unknown, never Never', () => {
  const g = siteGroups({ builtIn: [], allowed: ['x.com'], goal: [] }, null);
  assert.equal(g[1]!.hosts[0]!.lastUsed, 'unknown');
});
test('staleHosts: unused for 60 days or never used, only among the hosts you allowed', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const last = { 'old.com': new Date(now - 61 * DAY).toISOString(), 'new.com': new Date(now - 59 * DAY).toISOString() };
  assert.deepEqual(staleHosts(['old.com', 'new.com', 'never.com'], last, now).sort(), ['never.com', 'old.com']);
});
test('staleHosts: a site you approved today is not stale, even if no run has read it yet', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const approved = { 'fresh.com': new Date(now - 60_000).toISOString(), 'oldapproved.com': new Date(now - 90 * DAY).toISOString() };
  assert.deepEqual(staleHosts(['fresh.com', 'oldapproved.com'], {}, now, approved), ['oldapproved.com']);
});
test('staleHostsWhenLoaded: nothing is stale until both the dates and the activity loaded', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  assert.deepEqual(staleHostsWhenLoaded(['old.com', 'never.com'], null, now), []);
  const loaded = { lastUsed: { 'old.com': new Date(now - 61 * DAY).toISOString() }, approvedAt: {} };
  assert.deepEqual(staleHostsWhenLoaded(['old.com', 'never.com'], loaded, now).sort(), ['never.com', 'old.com']);
});
test('webChip: plain words, hidden when nothing was read', () => {
  assert.equal(webChip({ pages: 0, newSites: 0 }), undefined);
  assert.equal(webChip({ pages: 12, newSites: 3 }), 'web: 12 pages, 3 new sites');
  assert.equal(webChip({ pages: 1, newSites: 1 }), 'web: 1 page, 1 new site');
  assert.equal(webChip({ pages: 4, newSites: 0 }), 'web: 4 pages, 0 new sites');
});
test('lastUsedByHost: newest web-call line per host, and the newer of that and the saved date wins', () => {
  const lines = [
    { at: '2026-10-05T10:00:00.000Z', kind: 'web-call', text: 'Web: legion web_read x.com' },
    { at: '2026-10-09T10:00:00.000Z', kind: 'web-call', text: 'Web: legion web_read x.com' },
    { at: '2026-10-02T10:00:00.000Z', kind: 'web-call', text: 'Web: legion web_search' },
    { at: '2026-10-07T10:00:00.000Z', kind: 'run-end', text: 'Web: nonsense y.com' },
  ];
  assert.deepEqual(lastUsedByHost(lines, { 'x.com': '2026-10-01T00:00:00.000Z', 'z.com': '2026-09-01T00:00:00.000Z' }), { 'x.com': '2026-10-09T10:00:00.000Z', 'z.com': '2026-09-01T00:00:00.000Z' });
});

test('the Gates page notes carry the no-sandbox line and the web line, in plain words', () => {
  assert.match(PAGE_NOTES.noSandbox, /^Legion has no sandbox for commands on your computer\./);
  assert.equal(PAGE_NOTES.noSandbox, NO_SANDBOX_LINE); assert.equal(PAGE_NOTES.web, WEB_LINE);
  for (const s of Object.values(PAGE_NOTES)) assert.ok(!s.includes('\u2014') && !/this computer/i.test(s));
});
