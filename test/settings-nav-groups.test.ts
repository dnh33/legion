/** Settings sidebar: sections are grouped and ordered by how often people reach for them. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NAV, NAV_GROUPS, groupNav } from '../ui/src/components/settingsNav.js';

test('groups and their members, in order', () => {
  assert.deepEqual(NAV_GROUPS.map((g) => [g.heading, g.ids]), [
    ['Get started', ['claude']],
    ['Your agents', ['gates', 'armory', 'house']],
    ['Staying informed', ['spending', 'notifications']],
    ['Connections', ['mcp', 'github', 'providers', 'hosts', 'connections', 'boat', 'blender']],
    ['Advanced', ['accessibility', 'logs', 'compaction']],
    [null, ['about']],
  ]);
});

test('flat NAV follows the group order and keeps every section once', () => {
  assert.deepEqual(NAV.map((n) => n.id), ['claude', 'gates', 'armory', 'house', 'spending', 'notifications', 'mcp', 'github', 'providers', 'hosts', 'connections', 'boat', 'blender', 'accessibility', 'logs', 'compaction', 'about']);
  assert.equal(new Set(NAV.map((n) => n.id)).size, 17);
});

test('labels and hints survive; Notifications hint updated', () => {
  const by = Object.fromEntries(NAV.map((n) => [n.id, n]));
  assert.equal(by.notifications.hint, 'Pop-ups, sounds, quiet hours');
  assert.equal(by.house.label, 'Doctrine');
  assert.equal(by.connections.label, 'Use from Claude');
  assert.equal(by.boat.label, 'boat.dev (VMs)');
});

test('groupNav drops a hidden section and any group left empty', () => {
  const g = groupNav(NAV.filter((n) => n.id !== 'providers'));
  assert.ok(!g.some((x) => x.items.some((i) => i.id === 'providers')));
  const only = groupNav(NAV.filter((n) => n.id === 'about'));
  assert.equal(only.length, 1);
  assert.equal(only[0].heading, null);
});

test('Settings.tsx renders labelled groups, not clickable headings, and no accent stripe', () => {
  const src = readFileSync('ui/src/components/Settings.tsx', 'utf8');
  assert.match(src, /role="group"/);
  assert.match(src, /aria-labelledby/);
  const css = readFileSync('ui/src/styles/app.css', 'utf8');
  assert.doesNotMatch(css.split('\n').find((l) => l.startsWith('.set-link.sel')) ?? '', /inset 2px/);
});
