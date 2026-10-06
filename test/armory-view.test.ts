/**
 * Settings -> Armory: the pure view logic (grouping, order, labels, counts, bulk targets, the editor's rules, the import review) and
 * the markup contracts the screens must keep (a real radio group, menus, dialogs through the shared Modal, tokens only).
 *
 * The logic lives in src/shared/armory-view.ts, so these run against the code the UI imports. One part of it mirrors the core and is
 * tested against the core's own function on the same fixtures: the agent's access (access). The import review is not mirrored at
 * all: the core answers it (dryRun, test/armory-import-dryrun.test.ts), and a test below keeps the rules out of the shared module.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accessFor, agentChecked, agentsButtonName, agentsLabel, budgetWarning, buildGroups, bulkDone, bulkLabel, bulkName, bulkTargets, bulkUndone, commandOf,
  discoveryLine, discoveryWarning, groupBulkTargets, KEPT_OFF_TAG, lockedNote, relativeTime,
  countLine, countsOf, currentGrant, descriptionError, draftSees, editorErrors, editorOk, FILTERS, frontmatterOf, groupLabel, groupSkills, inFilter,
  isJunkPath, isReadable, looksLikeSecret, matchCount, matches, nameError, nextHeader, parseOpen, parseSkillMd, plural, restorePayload,
  runsNote, seesLine, shortList, showSearch, slugify, sourceLabel, STATE_OPTIONS, stateLabel, toggleAgent, triOf, turnAllOnTargets, withState,
  agentLoads, bodyError, budgetSummary, bulkConsequence, commandView, duplicateNames, flagsLine, loadsLine, matchRank, nameSuggestion, newSkillCommand, NAME_RULE, NO_COMMAND,
  refusalLine, rowTag, showHidden, STATE_FILTERS, tickReason, totalLine, uniqueName,
  seesText, crowdsLine, NOT_BUILTINS, shellConfirm, descriptionCut, CUT_NOTE, SHELL_SCOPE, SHELL_ON_LINE, flagsNamed,
} from '../src/shared/armory-view.js';
import type { ArmorySkill } from '../src/shared/armory-view.js';
import { trustBlurb, trustLabel, skillGroupTitle, skillGroupSummary, buildView } from '../src/shared/house-view.js';
import type { HouseFileView } from '../src/shared/house-view.js';
import { drillId } from '../src/shared/skill-ids.js';
// The core, for parity.
import { access } from '../src/core/armory/catalog.js';
import type { CatalogEntry } from '../src/core/armory/catalog.js';
import { buildSkillMd } from '../src/core/armory/files.js';
import { parseFrontmatter } from '../src/core/house/skills.js';
import { agentSkillsAllow } from '../src/shared/skill-ids.js';

const sk = (id: string, over: Partial<ArmorySkill> = {}): ArmorySkill => ({
  id, name: id.includes(':') ? id.split(':')[1]! : id, description: `Does ${id}.`, source: 'claude-personal', plugin: null, state: 'off', stateIsDefault: true,
  agents: 'all', path: `/x/${id}/SKILL.md`, manualOnlyInFrontmatter: false, ...over,
});
const world = (): ArmorySkill[] => [
  sk('legion-armory:mine', { source: 'yours', plugin: 'legion-armory', state: 'on' }),
  sk('legion-armory:got', { source: 'imported', plugin: 'legion-armory' }),
  sk('personal-one', { source: 'claude-personal' }),
  sk('personal-two', { source: 'claude-personal', state: 'on' }),
  sk('playwright:click', { source: 'claude-plugin', plugin: 'playwright' }),
  sk('playwright:snap', { source: 'claude-plugin', plugin: 'playwright', state: 'manual' }),
  sk('context7:docs', { source: 'claude-plugin', plugin: 'context7', state: 'on' }),
  sk('update-config', { source: 'claude-builtin', path: null, fit: 'self', offReason: 'It edits Claude Code settings.' }),
  sk('verify', { source: 'claude-builtin', path: null, fit: 'fit' }),
  sk('slides', { source: 'claude-builtin', path: null, fit: 'other' }),
];

describe('groups, order and counts', () => {
  it('come in the owner order: Yours, Imported, Your Claude Code skills, one group per plugin by name, built-ins last', () => {
    const g = buildGroups(world());
    assert.deepEqual(g.map((x) => x.key), ['yours', 'imported', 'personal', 'plugin:context7', 'plugin:playwright', 'builtin']);
    assert.deepEqual(g.map((x) => x.title), ['Yours', 'Imported', 'Your Claude Code skills', 'context7', 'playwright', 'Claude Code built-ins']);
  });
  it('every Claude Code group starts collapsed (yours, each plugin, claude.ai, built-ins); only Yours and Imported start open', () => {
    const g = buildGroups(world());
    assert.deepEqual(g.map((x) => x.key), ['yours', 'imported', 'personal', 'plugin:context7', 'plugin:playwright', 'builtin']);
    assert.deepEqual(g.map((x) => x.collapsed), [false, false, true, true, true, true]);
    const cloud = buildGroups([sk('claude.ai:notes', { source: 'claude-plugin', plugin: 'claude.ai' })]);
    assert.deepEqual(cloud.map((x) => [x.title, x.collapsed]), [['claude.ai', true]], 'skills synced from claude.ai are a plugin group and start closed too');
  });
  it('a skill whose name has spaces keeps its id as given: it groups, searches, counts and answers to /id', () => {
    const spaced = [sk('My Skill', { source: 'yours', name: 'My Skill', state: 'on' }), sk('cloud:Weekly Report', { source: 'claude-plugin', plugin: 'claude.ai', name: 'Weekly Report' })];
    const g = buildGroups(spaced);
    assert.deepEqual(g.map((x) => x.skills.map((y) => y.id)), [['My Skill'], ['cloud:Weekly Report']]);
    assert.equal(commandOf(spaced[0]!), '/My Skill');
    assert.deepEqual(buildGroups(spaced, 'all', 'weekly report')[0]!.skills.map((x) => x.id), ['cloud:Weekly Report']);
    assert.deepEqual(groupSkills(spaced, 'plugin:claude.ai').map((x) => x.id), ['cloud:Weekly Report']);
    assert.deepEqual(bulkTargets(groupSkills(spaced, 'plugin:claude.ai'), 'on').map((x) => x.id), ['cloud:Weekly Report']);
  });
  it('count lines say "n of m on", with "only when asked" when some are', () => {
    const g = buildGroups(world());
    assert.equal(g.find((x) => x.key === 'plugin:playwright')!.countLine, '0 of 2 on, 1 only when asked');
    assert.equal(g.find((x) => x.key === 'plugin:context7')!.countLine, '1 of 1 on');
    assert.equal(countLine([]), '0 of 0 on');
    assert.deepEqual(countsOf(world()), { total: 10, on: 3, manual: 1, off: 6 });
  });
  it('built-ins list the fit ones first and the ones that act on Claude Code last', () => {
    const b = buildGroups(world()).find((x) => x.key === 'builtin')!;
    assert.deepEqual(b.skills.map((s) => s.id), ['verify', 'slides', 'update-config']);
  });
  it('a built-in that cannot be on goes after the plain ones whatever its fit says, and "self" goes after "other"', () => {
    const extra = [
      sk('aaa-locked', { source: 'claude-builtin', path: null, fit: 'other', offReason: 'It edits Claude Code settings.' }),
      sk('aaa-self', { source: 'claude-builtin', path: null, fit: 'self' }),
      sk('zzz-plain', { source: 'claude-builtin', path: null, fit: 'other' }),
      sk('zzz-fit', { source: 'claude-builtin', path: null, fit: 'fit' }),
    ];
    const b = buildGroups(extra).find((x) => x.key === 'builtin')!;
    assert.deepEqual(b.skills.map((x) => x.id), ['zzz-fit', 'zzz-plain', 'aaa-self', 'aaa-locked']);
  });
  it('search keeps matching rows, hides groups with none, and counts still describe the whole group', () => {
    const g = buildGroups(world(), 'all', 'playwright');
    assert.deepEqual(g.map((x) => x.key), ['plugin:playwright'], 'the plugin name is searchable');
    assert.equal(g[0]!.skills.length, 2);
    const one = buildGroups(world(), 'all', 'click');
    assert.deepEqual(one[0]!.skills.map((s) => s.id), ['playwright:click']);
    assert.equal(one[0]!.countLine, '0 of 2 on, 1 only when asked', 'the header still describes both');
    assert.equal(matchCount(one), 1);
    assert.equal(buildGroups(world(), 'all', '   ').length, 6, 'spaces are no query');
    assert.deepEqual(buildGroups(world(), 'all', 'zzzz'), []);
  });
  it('filters: Yours, Imported and Claude Code', () => {
    assert.deepEqual(FILTERS.map((f) => f.label), ['All', 'Yours', 'Imported', 'Claude Code']);
    assert.deepEqual(buildGroups(world(), 'yours').map((x) => x.key), ['yours']);
    assert.deepEqual(buildGroups(world(), 'imported').map((x) => x.key), ['imported']);
    assert.deepEqual(buildGroups(world(), 'claude').map((x) => x.key), ['personal', 'plugin:context7', 'plugin:playwright', 'builtin']);
    assert.equal(inFilter(sk('a', { source: 'claude-builtin' }), 'claude'), true);
    assert.equal(inFilter(sk('a', { source: 'yours' }), 'claude'), false);
  });
  it('matches: every word, in name, id, description, plugin or source', () => {
    const s = sk('playwright:click', { source: 'claude-plugin', plugin: 'playwright', description: 'Click a button in the page.' });
    assert.equal(matches(s, 'click page'), true);
    assert.equal(matches(s, 'click zebra'), false);
    assert.equal(matches(s, 'playwright'), true);
    assert.equal(matches(s, 'plugin'), true, 'the source label is searchable');
  });
  it('groupSkills returns the whole group whatever the search says', () => {
    assert.deepEqual(groupSkills(world(), 'plugin:playwright').map((s) => s.id).sort(), ['playwright:click', 'playwright:snap']);
    assert.deepEqual(groupSkills(world(), 'nope'), []);
  });
  it('the search box shows once the list is long enough to need it', () => {
    assert.equal(showSearch(world().slice(0, 8)), false);
    assert.equal(showSearch(world()), true);
  });
  it('group names: the button name is the group and its count', () => {
    const g = buildGroups(world()).find((x) => x.key === 'plugin:playwright')!;
    assert.equal(groupLabel(g), 'playwright, 0 of 2 on, 1 only when asked');
    assert.equal(groupLabel(g, true), 'playwright, 0 of 2 on, 1 only when asked, showing matches');
  });
  it('remembered open state ignores anything unreadable', () => {
    assert.deepEqual(parseOpen('{"plugin:a":true,"builtin":false,"x":1}'), { 'plugin:a': true, builtin: false });
    for (const bad of [null, '', 'nope', '[1]', '"x"', undefined]) assert.deepEqual(parseOpen(bad), {});
  });
  it('arrow keys move between headers, wrapping', () => {
    assert.equal(nextHeader('ArrowDown', 2, 3), 0);
    assert.equal(nextHeader('ArrowUp', 0, 3), 2);
    assert.equal(nextHeader('Home', 2, 3), 0);
    assert.equal(nextHeader('End', 0, 3), 2);
    assert.equal(nextHeader('a', 0, 3), null);
  });
});

describe('labels', () => {
  it('the three states have the owner words, in order', () => {
    assert.deepEqual(STATE_OPTIONS.map((o) => o.label), ['Agents decide', 'Only when I ask', 'Off']);
    assert.deepEqual(STATE_OPTIONS.map((o) => o.value), ['on', 'manual', 'off']);
    assert.equal(stateLabel('manual'), 'Only when I ask');
    for (const o of STATE_OPTIONS) assert.ok(o.hint.endsWith('.'), 'a hint is a sentence');
  });
  it('the source tag says which plugin, and the /command is the id', () => {
    assert.equal(sourceLabel(sk('a', { source: 'claude-plugin', plugin: 'playwright' })), 'Claude Code plugin: playwright');
    assert.equal(sourceLabel(sk('a', { source: 'yours' })), 'Yours');
    assert.equal(commandOf(sk('legion-armory:x')), '/legion-armory:x');
  });
  it('the flag for a skill that runs commands changes its note with the Advanced switch', () => {
    assert.match(runsNote(false), /Blocked in Legion: the commands are not run\.$/);
    assert.match(runsNote(true), /Allowed in Legion/);
  });
  it('plural', () => {
    assert.equal(plural(1, 'skill'), '1 skill');
    assert.equal(plural(0, 'skill'), '0 skills');
  });
});

describe('bulk changes', () => {
  it('turning on skips what is already on and anything that acts on Claude Code itself', () => {
    const t = bulkTargets(groupSkills(world(), 'builtin'), 'on').map((s) => s.id);
    assert.deepEqual(t.sort(), ['slides', 'verify'], 'update-config has an offReason');
    assert.deepEqual(bulkTargets(world(), 'on').filter((s) => s.state === 'on'), []);
  });
  it('turning off takes everything that is not already off, "only when I ask" included', () => {
    const t = bulkTargets(groupSkills(world(), 'plugin:playwright'), 'off');
    assert.deepEqual(t.map((s) => s.id), ['playwright:snap']);
  });
  it('Turn all on takes the Claude Code skills of the owner and of plugins, never built-ins', () => {
    const t = turnAllOnTargets(world()).map((s) => s.id).sort();
    assert.deepEqual(t, ['personal-one', 'playwright:click', 'playwright:snap']);
  });
  it('built-ins: "on" in bulk is only the useful ones (fit), never the others, never the locked; off and other groups are unchanged', () => {
    const t = groupBulkTargets(world(), 'builtin', 'on').map((s) => s.id);
    assert.deepEqual(t, ['verify'], 'slides is "other" and update-config is locked: neither is switched on in bulk');
    assert.deepEqual(groupBulkTargets(withState(world(), 'slides', 'on'), 'builtin', 'off').map((s) => s.id), ['slides'], 'off still takes whatever is not off');
    assert.deepEqual(groupBulkTargets(world(), 'plugin:playwright', 'on').map((s) => s.id).sort(), ['playwright:click', 'playwright:snap'], 'a plugin group still turns all on');
    assert.equal(bulkLabel('on', 5, 'builtin'), 'Turn on the 5 useful ones');
    assert.equal(bulkLabel('on', 1, 'builtin'), 'Turn on the useful one');
    assert.equal(bulkLabel('off', 5, 'builtin'), 'Turn off 5', 'off is not renamed');
    assert.equal(bulkName('on', 5, 'Claude Code built-ins', 'builtin'), 'Turn on the 5 useful ones in Claude Code built-ins');
  });
  it('the note about built-ins that stay off is said once, with the names, and a row only gets a short tag', () => {
    const five = ['doctor', 'fewer-permission-prompts', 'loop', 'schedule', 'update-config'].map((n) => sk(n, { source: 'claude-builtin', path: null, fit: 'self', offReason: 'x' }));
    assert.equal(lockedNote([...five, sk('verify', { source: 'claude-builtin', fit: 'fit' })]),
      'Kept off in Legion: doctor, fewer-permission-prompts, loop, schedule, update-config change Claude Code itself, not the work an agent does.');
    assert.equal(lockedNote([five[0]!]), 'Kept off in Legion: doctor changes Claude Code itself, not the work an agent does.');
    assert.equal(lockedNote([sk('verify', { source: 'claude-builtin' })]), '');
    assert.equal(KEPT_OFF_TAG, 'Kept off');
  });
  it('when the list was made: relative time, the line, and the warning only when Claude Code could not be asked', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const ago = (ms: number): string => new Date(now - ms).toISOString();
    assert.equal(relativeTime(ago(5_000), now), 'just now');
    assert.equal(relativeTime(ago(60_000), now), '1 minute ago');
    assert.equal(relativeTime(ago(3 * 60_000), now), '3 minutes ago');
    assert.equal(relativeTime(ago(2 * 3_600_000), now), '2 hours ago');
    assert.equal(relativeTime(ago(26 * 3_600_000), now), '1 day ago');
    assert.equal(relativeTime(ago(-60_000), now), 'just now', 'a clock a little ahead is not "in the future"');
    assert.equal(relativeTime(null, now), '');
    assert.equal(relativeTime('nonsense', now), '');
    assert.equal(discoveryLine({ inherit: true, discoveredAt: ago(3 * 60_000) }, now), 'Listed from Claude Code 3 minutes ago.');
    assert.equal(discoveryLine({ inherit: true, discoveredAt: null }, now), 'Not listed from Claude Code yet.');
    assert.equal(discoveryLine({ inherit: true }, now), 'Not listed from Claude Code yet.', 'an older core sends no time');
    assert.equal(discoveryLine({ inherit: false, discoveredAt: ago(1000) }, now), '', 'inheriting is off: nothing was asked');
    assert.equal(discoveryWarning({ inherit: true, discovery: 'sdk', discoveryReason: null }), '');
    assert.equal(discoveryWarning({ inherit: true }), '', 'an older core says nothing about how');
    assert.equal(discoveryWarning({ inherit: true, discovery: 'disk-fallback', discoveryReason: 'The handshake timed out.' }),
      'Could not ask Claude Code (The handshake timed out), so this list comes from its folders and may miss skills. Refresh to try again.');
    assert.equal(discoveryWarning({ inherit: true, discovery: 'disk-fallback', discoveryReason: null }),
      'Could not ask Claude Code, so this list comes from its folders and may miss skills. Refresh to try again.');
    assert.equal(discoveryWarning({ inherit: false, discovery: 'disk-fallback', discoveryReason: 'Claude Code settings are not used by your agents.' }), '', 'turned off on purpose is not a failure');
  });
  it('the words: what it will do, which group, what it did, what Undo did', () => {
    assert.equal(bulkLabel('on', 12), 'Turn on 12');
    assert.equal(bulkName('off', 1, 'playwright'), 'Turn off 1 skill in playwright');
    assert.equal(bulkDone('on', 2), 'Turned on 2 skills.');
    assert.equal(bulkUndone(1), 'Put back 1 skill.');
    assert.equal(bulkUndone(3), 'Put back 3 skills.');
  });
  it('withState never mutates', () => {
    const w = world();
    const next = withState(w, 'verify', 'on');
    assert.equal(w.find((s) => s.id === 'verify')!.state, 'off');
    assert.equal(next.find((s) => s.id === 'verify')!.state, 'on');
  });
});

describe('which agents', () => {
  const agents = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];
  it('labels', () => {
    assert.equal(agentsLabel('all', agents), 'All');
    assert.equal(agentsLabel([], agents), 'None');
    assert.equal(agentsLabel(['a'], agents), 'Only Alpha');
    assert.equal(agentsLabel(['a', 'b'], agents), 'All but Gamma');
    assert.equal(agentsLabel(['a', 'b', 'c'], agents), 'All');
    assert.equal(agentsLabel(['a', 'zz'], agents), 'Only Alpha', 'an agent that was deleted is not counted');
    assert.equal(agentsLabel(['gone'], agents), 'None');
    assert.equal(agentsButtonName('Click', ['a'], agents), 'Agents for Click: Only Alpha');
    assert.equal(agentsLabel(['a', 'b', 'c'], [...agents, { id: 'd', name: 'Delta' }]), 'All but Delta');
  });
  it('ticking the last agent turns a list back into "all", so a new agent is not left out', () => {
    assert.deepEqual(toggleAgent(['a', 'b'], agents, 'c', true), 'all');
    assert.deepEqual(toggleAgent('all', agents, 'b', false), ['a', 'c']);
    assert.deepEqual(toggleAgent(['a'], agents, 'b', true), ['a', 'b']);
    assert.equal(agentChecked('all', 'x'), true);
    assert.equal(agentChecked(['a'], 'b'), false);
  });
});

describe('what an agent sees', () => {
  it('lines', () => {
    assert.equal(seesLine('Builder', { drills: 2, armory: 3, claudeCode: 2, total: 7 }), 'Builder sees 7 skills: 2 drills, 3 Armory, 2 Claude Code.');
    assert.equal(seesLine('Builder', { drills: 0, armory: 1, claudeCode: 0, total: 1 }), 'Builder sees 1 Armory skill.');
    assert.equal(seesLine('Scout', { drills: 0, armory: 0, claudeCode: 0, total: 0 }), 'Scout sees no skills.');
    assert.equal(budgetWarning('Builder', 63, 40), 'Builder would see 63 skill descriptions; more than about 40 crowds out the task.');
  });

  // Parity with the core: the same decision, over a matrix of states, grants and agent lists.
  it('accessFor gives the same answer as the core `access` for every combination', () => {
    const states = ['on', 'manual', 'off'] as const;
    const grants: ('all' | string[])[] = ['all', ['a'], ['b'], []];
    const settings: ('inherit' | string[] | undefined)[] = [undefined, 'inherit', ['x:y'], ['X:Y'], [], ['other']];
    const offs = [undefined, 'acts on Claude Code'];
    let n = 0;
    for (const state of states) for (const agents of grants) for (const setting of settings) for (const offReason of offs) {
      const entry = { id: 'x:y', name: 'y', description: '', source: 'claude-plugin', plugin: 'x', path: null, manualOnlyInFrontmatter: false, state, stateIsDefault: true, agents, runsCommandsOnLoad: false, ...(offReason ? { offReason } : {}) } as CatalogEntry;
      const agent = { id: 'a', skills: setting };
      assert.equal(accessFor(entry, agent), access(entry, agent), JSON.stringify({ state, agents, setting, offReason }));
      n++;
    }
    assert.equal(n, 3 * 4 * 6 * 2);
  });

  it('draftSees counts what the core would put in front of the agent, by group', () => {
    const skills = [
      sk('legion-armory:one', { source: 'yours', state: 'on' }),
      sk('legion-armory:two', { source: 'imported', state: 'on', agents: ['other'] }),
      sk('p:a', { source: 'claude-plugin', plugin: 'p', state: 'on' }),
      sk('p:b', { source: 'claude-plugin', plugin: 'p', state: 'manual' }),
      sk('mine', { source: 'claude-personal', state: 'on' }),
      sk('verify', { source: 'claude-builtin', state: 'on', path: null }),
      sk('update-config', { source: 'claude-builtin', state: 'off', path: null, offReason: 'x' }),
    ];
    const drills = [{ id: 'drill:review/a', name: 'A', on: true }, { id: 'drill:review/b', name: 'B', on: false }];
    for (const setting of ['inherit', ['p:a', 'drill:review/a'], []] as ('inherit' | string[])[]) {
      const got = draftSees(skills, drills, 'a', setting);
      const agent = { id: 'a', skills: setting };
      const on = skills.filter((s) => access(s as unknown as CatalogEntry, agent) === 'on');
      const owned = on.filter((s) => s.source === 'yours' || s.source === 'imported').length;
      const d = drills.filter((x) => x.on && agentSkillsAllow(setting, x.id)).length;
      assert.deepEqual({ drills: got.drills, armory: got.armory, claudeCode: got.claudeCode, total: got.total }, { drills: d, armory: owned, claudeCode: on.length - owned, total: d + on.length }, JSON.stringify(setting));
    }
    assert.equal(draftSees(skills, drills, 'a', 'inherit').total, 5, 'one, p:a, mine, verify, and the one drill that is on');
    assert.equal(draftSees(skills, drills, 'a', 'inherit', 4).over, true);
    assert.equal(draftSees(skills, drills, 'a', 'inherit', 5).over, false);
  });

  it('"Choose skills" starts from what the agent gets now, and a group tick reads as all / some / none', () => {
    const skills = [sk('a', { state: 'on' }), sk('b', { state: 'off' }), sk('c', { state: 'on', agents: ['zzz'] })];
    assert.deepEqual(currentGrant(skills, [{ id: 'drill:g/x', name: 'x', on: true }, { id: 'drill:g/y', name: 'y', on: false }], 'a1', 'inherit'), ['a', 'drill:g/x']);
    assert.equal(triOf(['a', 'b'], new Set(['a'])), 'some');
    assert.equal(triOf(['a', 'b'], new Set(['a', 'b'])), 'all');
    assert.equal(triOf(['a', 'b'], new Set()), 'none');
  });
});

describe('the editor rules', () => {
  it('a name is checked live with the core rule, and a taken name is refused', () => {
    assert.equal(nameError('my-skill'), '');
    assert.match(nameError(''), /Give it a name/);
    assert.match(nameError('My Skill'), /lower case letters, digits and hyphens.* Try my-skill\./);
    assert.match(nameError('-lead'), /Try lead\./);
    assert.match(nameError('x'.repeat(65)), /64 characters/);
    assert.equal(nameError('a1'), '');
    assert.match(nameError('mine', ['mine']), /already have one called mine/);
    assert.equal(slugify('  Hello, World!  '), 'hello-world');
  });
  it('description and "when to use" and body: required, limited, counted in the core words', () => {
    assert.match(descriptionError('   '), /Describe it in a line/);
    assert.equal(descriptionError('x'), '');
    assert.match(descriptionError('x'.repeat(501)), /1 over the 500 character limit/);
    assert.equal(descriptionError('x   '.repeat(150)), '', 'white space is folded before it is counted, as the core does');
    const e = editorErrors({ name: 'a', description: 'd', whenToUse: 'w'.repeat(501), body: '' });
    assert.match(e.whenToUse, /over the 500/);
    assert.match(e.body, /Write what the skill tells an agent/);
    assert.equal(editorOk(e), false);
    assert.equal(editorOk(editorErrors({ name: 'a', description: 'd', whenToUse: '', body: 'b' })), true);
  });
  it('secret-shaped text is flagged', () => {
    // Built at runtime so the public export's secret scan does not see a key-shaped literal in this file.
    assert.equal(looksLikeSecret('use ' + 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234'), true);
    assert.equal(looksLikeSecret('ghp_' + 'a'.repeat(36)), true);
    assert.equal(looksLikeSecret('-----BEGIN RSA ' + 'PRIVATE KEY-----'), true);
    assert.equal(looksLikeSecret('password: hunter2hunter2'), true);
    assert.equal(looksLikeSecret('Write a test for the login form. Never store a password in the repo.'), false);
  });
  it('frontmatterOf reads what the core parseFrontmatter reads', () => {
    const texts = [
      '---\nname: a\ndescription: one line\n---\nbody',
      '---\nname: a\ndescription: >-\n  folded line\n  continued\n---\nbody',
      '---\nname: a\ndescription: "quoted: yes"\nmetadata:\n  x: 1\nlicense: MIT\n---\n',
      '---\r\nname: a\r\ndescription: crlf\r\n---\r\nbody',
      'no frontmatter',
      '---\nname: a\ndescription: |\n  keep\n  lines\n---\n',
    ];
    for (const t of texts) assert.deepEqual(frontmatterOf(t), parseFrontmatter(t), JSON.stringify(t));
  });
  it('parseSkillMd splits what buildSkillMd wrote, and restorePayload writes the same file again', () => {
    const cases = [
      { name: 'plain', description: 'Does a thing.', whenToUse: '', body: '# Title\n\nSteps.' },
      { name: 'with-when', description: 'Does a thing: carefully.', whenToUse: 'a task needs it', body: 'Body.' },
      { name: 'quotes', description: 'Say "hi" and it\'s fine', whenToUse: '', body: '```\ncode\n```' },
    ];
    for (const c of cases) {
      const text = buildSkillMd(c);
      const p = parseSkillMd(text);
      assert.deepEqual({ name: p.name, description: p.description, whenToUse: p.whenToUse, body: p.body }, c);
      assert.deepEqual(p.extraKeys, []);
      const r = restorePayload(text);
      assert.equal(buildSkillMd({ name: r.name, description: r.description, body: r.body }), text, `undo for remove posts the same file: ${c.name}`);
    }
    const extra = parseSkillMd('---\nname: a\ndescription: d\nlicense: MIT\nallowed-tools: Bash\n---\nbody');
    assert.deepEqual(extra.extraKeys, ['license', 'allowed-tools']);
  });
});

// ---- the import review: the core answers it; the screen keeps no copy of the rules ----

describe('import review: no copy of the security rules in the shared module', () => {
  it('the shared view code has no import rule: no path check, no stripped-key list, no shell detector, no review function', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'shared', 'armory-view.ts'), 'utf8');
    for (const name of ['prepareImport', 'reviewImport', 'precheckImport', 'readablePaths', 'cleanRelPath', 'stripKeys', 'STRIPPED_KEYS', 'hasShellPreprocessing', 'allowed-tools']) {
      assert.ok(!src.includes(name), `armory-view.ts must not hold ${name}: the core owns that rule`);
    }
  });
  it('the screen reads only .md files up to the read cap; anything else is never read', () => {
    assert.equal(isReadable('a/SKILL.md', 10), true);
    assert.equal(isReadable('a/ref/x.MD', 512_000), true);
    assert.equal(isReadable('a/big.md', 512_001), false);
    assert.equal(isReadable('a/run.sh', 5), false);
    assert.equal(isReadable('a/img.png', 5), false);
  });
  it('hidden and tool folders are set aside, a list is shortened', () => {
    assert.equal(isJunkPath('s/.git/config'), true);
    assert.equal(isJunkPath('s/node_modules/x/y.md'), true);
    assert.equal(isJunkPath('s/refs/a.md'), false);
    assert.equal(isJunkPath('.hidden/a.md'), true);
    assert.equal(shortList(['a', 'b', 'c'], 2), 'a, b and 1 more');
    assert.equal(shortList(['a', 'b'], 2), 'a, b');
  });
});

// ---- the Doctrine side: your own drills ----

describe('Doctrine: your own drills read as not approved, not as edited', () => {
  const own = (over: Partial<HouseFileView> = {}): HouseFileView => ({
    path: 'skills/yours/mine/SKILL.md', bytes: 10, trust: 'untrusted', category: 'skills', title: 'mine', on: false, locked: false, group: 'yours', skill: 'skills/yours/mine/SKILL.md', description: 'd', ...over,
  });
  it('the tag says "Not approved", the sentence says it was never Legion words, and a shipped file edited later still says "Edited"', () => {
    assert.equal(trustLabel(own()), 'Not approved');
    assert.match(trustBlurb({ ...own(), on: false }), /You wrote it and have not approved it/);
    assert.ok(!/no longer matches/.test(trustBlurb({ ...own(), on: false })));
    assert.equal(trustLabel(own({ trust: 'adopted' })), 'Approved by you');
    assert.equal(trustLabel(own({ group: 'review' })), 'Edited');
    assert.match(trustBlurb({ ...own({ group: 'review' }), on: false }), /no longer matches what Legion shipped/);
  });
  it('the sub-group is called Your drills, after the shipped ones', () => {
    assert.equal(skillGroupTitle('yours'), 'Your drills');
    assert.match(skillGroupSummary('yours', 2), /need.*approval|needs your approval/);
    const files: HouseFileView[] = [
      own(), own({ path: 'skills/review/r/SKILL.md', skill: 'skills/review/r/SKILL.md', group: 'review', trust: 'shipped' }),
    ];
    const g = buildView(files).find((x) => x.info.category === 'skills')!.skillGroups;
    assert.deepEqual(g.map((x) => x.title), ['Review', 'Your drills']);
  });
  it('a drill id is what the effective route uses', () => {
    assert.equal(drillId('yours', 'Mine'), 'drill:yours/mine');
  });
});

// ---- markup contracts ----

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');
const section = read('ui/src/armory/ArmorySection.tsx');
const controls = read('ui/src/armory/ArmoryControls.tsx');
const dialogs = read('ui/src/armory/ArmoryDialogs.tsx');
const editor = read('ui/src/armory/SkillEditor.tsx');
const agentSkills = read('ui/src/armory/AgentSkills.tsx');
const store = read('ui/src/armory/armoryStore.ts');
const css = read('ui/src/armory/armory.css');
const descriptionSrc = read('ui/src/armory/Description.tsx');
const mine = { section, controls, dialogs, editor, agentSkills };

describe('markup contracts', () => {
  it('the three states are a native radio group with a name, a hint for each choice, and a fixed Off for skills that act on Claude Code', () => {
    assert.match(controls, /role="radiogroup" aria-label=\{caption \? `\$\{caption\}: \$\{label\}` : `How agents use \$\{label\}`\}/, 'the name said aloud tells two skills with one name apart');
    assert.match(controls, /<input type="radio" name=\{name\} value=\{o\.value\} checked=\{skill\.state === o\.value\} aria-describedby=\{`\$\{hintBase\}-\$\{o\.value\}`\}/);
    const labels = controls.slice(controls.indexOf('<label key={o.value}'), controls.indexOf('The one-line meaning'));
    assert.ok(labels.length > 100 && !/\bhidden\b/.test(labels), 'the hints sit outside the labels, so they never become part of a choice name');
    assert.match(controls, /\{STATE_OPTIONS\.map\(\(o\) => <span key=\{o\.value\} id=\{`\$\{hintBase\}-\$\{o\.value\}`\} hidden>\{o\.hint\}<\/span>\)\}/);
    assert.match(controls, /onChange=\{\(\) => \{ void setSkillState/, 'a change while it saves is queued by the store, never dropped');
    assert.match(controls, /if \(skill\.offReason\) return <span className="arm-fixed" aria-describedby=\{reasonId\}>Off<\/span>;/);
    assert.match(css, /\.arm-state:has\(input:focus-visible\) \{ outline: 2px solid var\(--accent-text\); outline-offset: 2px; box-shadow: inset 0 0 0 2px var\(--bg\)/);
    assert.match(css, /\.arm-state\.on\.v-off \{ background: var\(--muted\); color: var\(--bg\); \}/, 'selected Off is a fill with its own ink, and its name is in the text');
  });
  it('the ⋯ menu has menu semantics, Esc and Tab close it, focus goes to the first item and back to the button', () => {
    assert.match(controls, /aria-haspopup="menu" aria-expanded=\{open\}/);
    assert.match(controls, /role="menu" aria-label=\{label\}/);
    assert.match(controls, /role="menuitem" tabIndex=\{-1\}/);
    assert.match(controls, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); setOpen\(false\); btn\.current\?\.focus\(\{ preventScroll: true \}\)/, 'Esc closes the menu and not Settings');
    assert.match(controls, /querySelector<HTMLElement>\('\[role="menuitem"\]'\)\?\.focus\(\{ preventScroll: true \}\)/, 'focusing the first item never scrolls the list');
    assert.match(controls, /btn\.current\?\.focus\(\{ preventScroll: true \}\); setOpen\(false\); it\.run\(\);/, 'a dialog returns focus to a button that is still there');
    assert.match(section, /label=\{`More for \$\{label\}`\}/, 'every ⋯ button has its own name');
  });
  it('rows carry: the description (one line, then a Show more button that opens all of it), the /command, the source tag, the flag with its reason, and the agents button', () => {
    assert.match(section, /<Description text=\{s\.description \|\| 'No description\.'\} name=\{label\} \/>/);
    assert.ok(!/\.arm-desc \{[^}]*(?:line-clamp|white-space: nowrap|overflow: hidden)/.test(css), 'the base rule never cuts the text');
    assert.match(css, /\.arm-desc\.clamp \{[^}]*-webkit-line-clamp: 1;[^}]*overflow: hidden/, 'only the collapsed state is clamped, to one line');
    assert.match(descriptionSrc, /className=\{`arm-desc\$\{expanded \? '' : ' clamp'\}`\}/, 'expanded drops the clamp: the whole text is in the DOM either way');
    assert.match(descriptionSrc, /<button type="button" className="link-btn arm-desc-toggle" aria-expanded=\{expanded\} aria-controls=\{id\}/, 'a real button, with aria-expanded');
    assert.match(descriptionSrc, /\{long \|\| expanded \? \(/, 'the toggle shows only when the text is cut, and stays once open');
    assert.ok(!/title=\{s\.description/.test(section), 'nothing is only in a tooltip');
    assert.match(section, /<code className=\{`arm-cmd\$\{cmd\.runnable \? '' : ' muted'\}`\}>\{cmd\.text\}<\/code>/);
    assert.match(section, /\{tag \? <span className=\{`house-tag arm-src t-\$\{s\.source\}`\}>\{tag\}<\/span> : null\}/, 'the source tag only when it differs from the group');
    assert.match(section, /Runs commands when loaded\.<\/strong> \{runsNote\(allowShell\)\}/);
    assert.match(section, /aria-haspopup="dialog" aria-label=\{agentsButtonName\(label, grant, agents\)\}/);
    assert.ok(!/Kept off in Legion\. \{s\.offReason\}/.test(section), 'the long reason is not repeated on every locked row');
    assert.match(section, /<span className="house-tag arm-src t-kept" aria-describedby=\{lockId\}>\{KEPT_OFF_TAG\}<\/span>/, 'a short tag, with the reason by aria-describedby');
    assert.match(section, /<p id=\{lockId\} className="set-hint arm-locked">/, 'the reason is said once, at the top of the built-ins group');
    assert.match(section, /<StateRadio skill=\{s\} reasonId=\{s\.offReason \? lockId : undefined\} \/>/);
    assert.match(section, /\{s\.offReason \? null : \(\s*<button/, 'a skill that cannot be on has no agents button');
  });
  it('every dialog goes through the shared Modal and is portalled out of the container column', () => {
    for (const [name, text, n] of [['dialogs', dialogs, 3], ['editor', editor, 1]] as const) {
      assert.equal((text.match(/createPortal\(\s*<Modal/g) ?? []).length, n, `${name}: each Modal is portalled`);
      assert.match(text, /import \{ Modal \} from '\.\.\/components\/Modal'/);
    }
    assert.match(editor, /onClose=\{\(\) => \(guard\.current \? guard\.current\(\) : p\.onClose\(\)\)\}/, 'Esc, the X and a click outside all ask before throwing a draft away');
    assert.match(read('ui/src/house/house.css'), /\.house-cq \{ container: house \/ inline-size; \}/, 'house-cq is the container the Armory shares');
    assert.match(section, /className="set-section house-cq arm"/);
  });
  it('the review step asks the core, reads only what it needs, shows kept / left out / removed keys, and Add puts the skill in off', () => {
    assert.match(dialogs, /isReadable\(p\.path, p\.file\.size\) \? \{ path: p\.path, text: await readText\(p\.file\) \} : \{ path: p\.path, size: p\.file\.size, text: null \}/, 'only readable files are read; the rest go as a name and a size');
    assert.match(dialogs, /await reviewImportFiles\(files\)/, 'the core reviews it (dry run)');
    assert.ok(!/reviewImport\(|precheckImport|readablePaths/.test(dialogs), 'no review is computed in the browser');
    assert.match(dialogs, /await importSkill\(sent\)/, 'Add sends exactly what was reviewed');
    assert.match(dialogs, /Kept \(\{review\.kept\.length\}\)/);
    assert.match(dialogs, /Left out \(\{review\.dropped\.length\}\)/);
    assert.match(dialogs, /Removed from the header: \{review\.stripped\.join/);
    assert.match(dialogs, /'Add \(off\)'/);
    assert.match(dialogs, /<Markdown text=\{showHidden\(doc\.body\)\} headingOffset=\{3\} quietCode \/>/, 'rendered through the app Markdown: no raw HTML');
    assert.ok(!/dangerouslySetInnerHTML/.test(Object.values(mine).join('\n')), 'no raw HTML anywhere');
    assert.match(section, /ref=\{\(el\) => \{ dirInput\.current = el; el\?\.setAttribute\('webkitdirectory', ''\)/, 'the folder picker is set as the element mounts (it only exists once the list has loaded): React has no prop for it');
    assert.match(section, /: 'SKILL\.md';\s*if \(folder && isJunkPath\(path\)\) \{ skipped\+\+; continue; \}/, 'a lone file is the skill itself; a folder sets aside hidden and tool folders');
    assert.match(section, /<RowMenu label="Add from file" items=\{items\} trigger=/, 'Add from file is the same menu as the ⋯ one');
  });
  it('controls that work stay mounted: aria-disabled and a busy label, never the disabled attribute', () => {
    for (const [name, text] of Object.entries(mine)) assert.ok(!/(?<!aria-)disabled=\{/.test(text), `${name} has a disabled attribute on a control that holds focus`);
    assert.match(section, /\{loading \? <>Trying\{'…'\}<\/> : 'Try again'\}/);
    assert.match(section, /retried\.current && loaded && !loadError\) \{ retried\.current = false; heading\.current\?\.focus\(\)/);
    assert.equal((section.match(/<h3 ref=\{heading\} tabIndex=\{-1\}>Armory<\/h3>/g) ?? []).length, 3, 'every state of the screen has the focus target');
  });
  it('failures are visible and say what failed: per row, per group, in the notice, in the dialogs', () => {
    assert.match(section, /role="alert"><Icon name="x" size=\{12\} \/> <span>\{endSentence\(`\$\{ROW_ERR\[err\.op\]/);
    assert.match(section, /It is still \$\{stateLabel\(s\.state\)\.toLowerCase\(\)\}\./, 'a failed change says the old state is still there');
    assert.match(section, /Could not change all of these/);
    assert.match(section, /Try again\.<\/span><\/p>|\{endSentence\(err\)\} Try again\./);
    assert.match(editor, /What you wrote is still here\./);
    assert.match(dialogs, /Could not add it:/);
    assert.match(section, /The switch is still \{on \? 'on' : 'off'\}\./);
  });
  it('Undo waits for the pointer and focus, and focus never falls to the page when the control goes', () => {
    assert.match(section, /onMouseEnter=\{\(\) => holdUndo\('hover'\)\} onMouseLeave=\{\(\) => releaseUndo\('hover'\)\}/);
    assert.match(section, /onMouseEnter=\{\(\) => holdRemoved\('hover'\)\}/);
    assert.match(section, /function useUndoFocus/);
    assert.match(section, /const lost = want\.current \|\| !document\.activeElement \|\| document\.activeElement === document\.body;/);
    assert.match(section, /wantRemovedFocus\.current = intent;\s*void removeSkill/, 'after Remove, focus goes to Undo, if it is still wanted');
  });
  it('Settings has the Armory entry right after Doctrine, with its plain hint, and renders the section', () => {
    const settings = read('ui/src/components/Settings.tsx');
    assert.match(settings, /\{ id: 'house', label: 'Doctrine', hint: 'Rules and drills your agents follow' \},\s*\{ id: 'armory', label: 'Armory', hint: 'Skills your agents can pick up' \},/);
    assert.match(settings, /section === 'armory' \? <ArmorySection \/>/);
    assert.match(read('ui/src/store.ts'), /'house' \| 'armory' \| 'connections'/);
  });
  it('the header says what the Armory is and links to Doctrine; the notice and the Advanced warning use the owner words', () => {
    assert.match(section, /<p>\{HEADER_TEXT\}<\/p>/);
    assert.match(section, /Rules and drills live in Doctrine/);
    assert.equal(read('src/shared/armory-view.ts').includes("'Skills your agents can pick up when a task calls for one. They are not rules: an agent reads one only when it needs it.'"), true);
    assert.match(read('src/shared/armory-view.ts'), /'Choose which Claude Code skills your agents get\. They are off until you turn them on\.'/);
    assert.match(read('src/shared/armory-view.ts'), /'A skill could run any command on this computer when it loads, without asking\. Leave this off unless you trust every skill that is on\.'/);
    assert.match(section, /'Turn all on'/);
    assert.match(section, />Got it<\/button>/);
    assert.match(section, /aria-label="Let skills run commands when they load"/);
    assert.match(section, /type="checkbox" role="switch" checked=\{on\}/);
  });
  it('the agent editor has the Skills section: the default is inherit, the list is searchable and grouped, and the count and warning are there', () => {
    assert.match(read('ui/src/components/AgentEditor.tsx'), /<AgentSkills agentId=\{id\} agentName=\{name\} value=\{skills\} onChange=\{setSkills\}\s+onOpenArmory=/);
    assert.match(read('ui/src/components/AgentEditor.tsx'), /skills: settingOf\(skills\)/);
    assert.match(agentSkills, /Same as the Armory <span className="arm-faint">\(default\)<\/span>/);
    assert.match(agentSkills, /<span>Choose skills<\/span>/);
    assert.match(agentSkills, /aria-label=\{`Choose every \$\{noun\} that is on in \$\{g\.title\}`\}/);
    assert.match(agentSkills, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'\) e\.preventDefault\(\); \}\}/, 'Enter in the search box does not save the agent');
    assert.match(agentSkills, /seesLine\(who, sees\)/);
    assert.match(agentSkills, /budgetWarning\(who, sees\.total, WARN_ABOVE\)/);
    assert.match(agentSkills, /A skill that is off in the Armory stays unavailable even when ticked/);
  });
  it('the effective view per agent: a line, a warning when over budget, a link to choose skills, each failure with Try again', () => {
    assert.match(section, /seesText\(d\.counts\)/, 'the row already carries the name');
    assert.match(section, /void loadEffectiveAll\(agents\.map\(\(a\) => a\.id\)\)/, 'one request for every agent');
    assert.equal(seesText({ drills: 0, armory: 2, claudeCode: 0, total: 2 }), '2 Armory skills.');
    assert.equal(seesText({ drills: 0, armory: 0, claudeCode: 349, total: 349 }), '349 Claude Code skills.', 'one source: no repeated count');
    assert.equal(seesText({ drills: 1, armory: 0, claudeCode: 349, total: 350 }), '350 skills: 1 drill, 349 Claude Code.', 'two sources: the split stays');
    assert.equal(seesText({ drills: 0, armory: 0, claudeCode: 0, total: 0 }), 'No skills.');
    assert.equal(crowdsLine(41), 'More than about 40 skill descriptions crowds out the task.');
    assert.equal(crowdsLine(40), '', 'the same limit the confirm step uses');
    assert.match(section, /overList\.length \? <p className="arm-warn" role="status"><Icon name="warn" size=\{12\} \/> \{budgetSummary\(overList, agents\.length, warnAbove\)\}<\/p> : null/, 'said once, with a warning icon and not an error one');
    assert.ok(!/d\?\.overBudget \?/.test(section), 'not under every agent');
    assert.match(section, /aria-label=\{`Choose skills for \$\{a\.name\}`\} onClick=\{\(\) => openEditor\(a\.id, 'skills'\)\}/);
    assert.match(section, /Could not read this: /);
  });
  it('Doctrine: New drill is in Drills, the editor is the shared one, and the editor refuses a name that would replace a drill', () => {
    const house = read('ui/src/house/HouseSection.tsx');
    assert.match(house, /import \{ SkillEditor \} from '\.\.\/armory\/SkillEditor'/);
    assert.match(house, /<Icon name="plus" size=\{12\} \/> New drill/);
    assert.match(house, /<SkillEditor kind="drill" taken=\{taken\}/);
    assert.match(house, /await saveDrill\(f, target\.mode === 'edit'\)/);
    assert.match(house, /isOwnDrill\(f\) && f\.skill === f\.path/, 'the names already taken are your own drills');
    assert.match(read('ui/src/house/houseStore.ts'), /request<\{ path: string; name: string \}>\('POST', '\/api\/house\/drill'/);
    assert.match(read('ui/src/house/houseStore.ts'), /Your approval no longer applies, so approve it again\./);
  });
  it('the stylesheet uses tokens only, no viewport query, container queries, tabular numbers, and reduced motion', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]), [], 'no hardcoded colour');
    assert.ok(!/@media \(max-width/.test(css), 'the column is narrow because of the sidebars, not the window');
    assert.match(css, /@container house \(max-width: 480px\) \{[^@]*\.arm-states \{ display: flex; width: 100%; \}/);
    assert.match(css, /@container house \(max-width: 480px\) \{[^@]*\.arm-toolbar \{ flex-direction: column;/);
    const narrow = /@container house \(max-width: 360px\) \{([^@]*?)\n\}/.exec(css)?.[1] ?? '';
    assert.match(narrow, /\.arm-states \{ flex-direction: column;/, 'under ~360px the three choices stack as a radio list');
    assert.match(narrow, /\.arm-state::before \{[^}]*border-radius: 50%/, 'each choice has a radio marker');
    assert.match(narrow, /\.arm-state\.on::before \{[^}]*radial-gradient/, 'the chosen one is filled, by shape and not only by colour');
    assert.match(css, /\.arm-state input \{ position: absolute; inset: 0; width: 100%; height: 100%;/, 'still native radios over the whole row, so the arrow keys move between them');
    assert.ok(!/transition:\s*all/.test(css));
    const rm = /@media \(prefers-reduced-motion: reduce\) \{([^}]*)\}/.exec(css)![1]!;
    for (const sel of ['.arm-seebtn .icon', '.arm-filter']) assert.ok(rm.includes(sel), `reduced motion covers ${sel}`);
    assert.match(css, /\.arm-count \{[^}]*font-variant-numeric: tabular-nums/);
    assert.match(css, /\.arm-seetext \{[^}]*font-variant-numeric: tabular-nums/);
    assert.match(css, /\.arm-state:has\(input:focus-visible\)/);
  });
  it('loading text uses the ellipsis character and no three dots reach the screen', () => {
    for (const [name, text] of Object.entries(mine)) for (const m of text.matchAll(/(?<!=)>[^<>{}]*\.\.\.[^<>{}]*</g)) assert.fail(`three dots in visible text of ${name}: ${m[0]}`);
    assert.match(section, /Reading your Claude Code skills\{'…'\}/);
    assert.match(section, /<div className="set-loading arm-loading"><span className="spin" \/>/, 'a spinner');
    assert.match(section, /className="set-section house-cq arm" aria-busy=\{!loaded \|\| undefined\}/, 'busy while the first read runs');
    assert.match(css, /\.arm-loading \{ min-height: 240px;/, 'the loading state keeps the room the list will fill');
    assert.match(section, /Refreshing\{'…'\}/);
    assert.match(section, /aria-disabled=\{refreshing\} aria-busy=\{refreshing \|\| undefined\}/, 'Refresh stays mounted while it works');
    assert.match(section, /\{warn \? <p className="arm-banner">\{warn\}<\/p> : null\}/);
    assert.match(editor, /Saving\{'…'\}/);
    assert.match(dialogs, /Adding\{'…'\}/);
  });
  it('the store never reaches an agent route and talks only to the admin routes', () => {
    const routes = [...store.matchAll(/'(?:GET|POST|DELETE)', [`'](\/api\/[a-z/-]+)/g)].map((m) => m[1]);
    for (const r of routes) assert.match(r!, /^\/api\/(armory|house)/);
    assert.ok(routes.includes('/api/armory/state') && routes.includes('/api/armory/import') && routes.includes('/api/house/drill/promote'));
  });
});

// ---- review fixes (UX review of Release A2a) ----

describe('review fixes: the view logic', () => {
  const agents = [{ id: 'zealot', name: 'Zealot' }, { id: 'builder', name: 'Builder' }];
  const many = (n: number): ArmorySkill[] => Array.from({ length: n }, (_, i) => sk(`cc-${i}`, { source: 'claude-personal' }));
  const allOn = (n: number): ArmorySkill[] => many(n).map((s) => ({ ...s, state: 'on' as const }));

  it('B2: turning many on says the resulting load BEFORE acting; under the budget says nothing', () => {
    const c = bulkConsequence(many(356), many(356), [], agents);
    assert.equal(c.over, true);
    assert.equal(c.message, 'Every agent would see 356 skill descriptions if you turn on 356 skills. More than about 40 crowds out the task. Turn on anyway?');
    const small = bulkConsequence(many(10), many(10), [], agents);
    assert.deepEqual([small.over, small.message], [false, '']);
    // already on + drills count too: the number is what the agent editor would count
    const withDrills = bulkConsequence(many(40), many(40), [{ id: 'yours:a', name: 'a', on: true }], agents);
    assert.equal(withDrills.loads[0]!.total, 41);
    assert.equal(withDrills.over, true);
  });
  it('B2: one agent over, or agents that differ, are named; flagged skills are counted in the question', () => {
    const only = bulkConsequence(many(50), many(50), [], [{ id: 'zealot', name: 'Zealot' }, { id: 'builder', name: 'Builder', skills: [] }]);
    assert.equal(only.message, 'Zealot would see 50 skill descriptions if you turn on 50 skills. More than about 40 crowds out the task. Turn on anyway?', 'Builder has an empty list: it sees none');
    const flagged = many(60).map((s, i) => (i < 3 ? { ...s, runsCommandsOnLoad: true } : i < 5 ? { ...s, hiddenText: true } : s));
    const c = bulkConsequence(flagged, flagged, [], agents);
    assert.deepEqual([c.runs, c.hidden], [3, 2]);
    assert.deepEqual([c.runNames.length, c.hiddenNames.length], [3, 2]);
    assert.match(c.message, / Of the 60 you are turning on, 3 run commands when loaded \(.+\) and 2 have hidden characters \(.+\)\. Turn on anyway\?$/);
    // the ones in question are named, not only counted
    for (const n of [...c.runNames, ...c.hiddenNames]) assert.ok(c.message.includes(n), `${n} is named`);
    assert.match(bulkConsequence(many(50), many(50), [], agents, 40, NOT_BUILTINS).message, /if you turn on 50 skills \(the built-in skills are not included\)\./, 'the count gap is explained');
    assert.equal(flagsLine(1, 0), 'Of these, 1 runs commands when loaded.');
    assert.equal(flagsLine(0, 1), 'Of these, 1 has hidden characters.');
    assert.equal(flagsLine(0, 0), '');
  });
  it('B2: the Undo bar repeats what agents now see', () => {
    assert.equal(loadsLine([{ total: 356 }, { total: 356 }]), 'Agents now see 356 descriptions.');
    assert.equal(loadsLine([{ total: 3 }, { total: 356 }]), 'Agents now see 3 to 356 descriptions.');
    assert.equal(loadsLine([]), '');
    assert.deepEqual(agentLoads(allOn(2), [], []), [{ name: 'An agent', total: 2 }], 'no agents yet: one nominal agent');
  });
  it('m1: the warning is said once for the whole list', () => {
    assert.equal(budgetSummary([], 3), '');
    assert.equal(budgetSummary([{ name: 'A', total: 56 }, { name: 'B', total: 56 }, { name: 'C', total: 56 }], 3), 'Every agent sees more than about 40 skill descriptions (56). That crowds out the task.');
    assert.equal(budgetSummary([{ name: 'A', total: 50 }], 3), 'A sees more than about 40 skill descriptions (50). That crowds out the task.');
    assert.equal(budgetSummary([{ name: 'A', total: 50 }, { name: 'B', total: 60 }], 5), 'A and B see more than about 40 skill descriptions (50 to 60). That crowds out the task.');
    assert.equal(budgetSummary(Array.from({ length: 6 }, (_, i) => ({ name: `a${i}`, total: 99 })), 12), '6 of 12 agents see more than about 40 skill descriptions (99). That crowds out the task.');
  });
  it('B3: a tick that does nothing says why, on that line, and where to change it', () => {
    assert.equal(tickReason({ state: 'on', agents: ['builder'] }, 'zealot', 'Zealot'), 'Not for Zealot: limited to other agents in the Armory. Change it there.');
    assert.equal(tickReason({ state: 'off', agents: 'all' }, 'zealot', 'Zealot'), 'Not for Zealot: off in the Armory. Change it there.');
    assert.equal(tickReason({ state: 'manual', agents: 'all' }, 'zealot', 'Zealot'), 'Not for Zealot: only when asked in the Armory. Change it there.');
    assert.equal(tickReason({ state: 'on', agents: ['zealot'] }, 'zealot', 'Zealot'), '');
    assert.equal(tickReason({ state: 'on', agents: 'all' }, 'zealot', 'Zealot'), '');
    assert.equal(tickReason({ state: 'on', agents: ['zealot'] }, '', 'This agent'), 'Not for This agent: limited to other agents in the Armory. Change it there.', 'an unsaved agent has no id yet');
  });
  it('B6: claude.ai skills are "Synced from claude.ai"; Claude Code\'s own skills in the "unknown" plugin are built-ins; a name with spaces has no /command', () => {
    const w = [
      sk('claude.ai:notes', { source: 'claude-plugin', plugin: 'claude.ai', groupKind: 'claude-ai', name: 'notes' }),
      sk('unknown:init', { source: 'claude-plugin', plugin: 'unknown', groupKind: 'claude-builtin', name: 'init' }),
      sk('pa:review', { source: 'claude-plugin', plugin: 'pa', groupKind: 'claude-plugin', name: 'review' }),
      sk('verify', { source: 'claude-builtin', path: null, fit: 'fit', groupKind: 'claude-builtin' }),
    ];
    const g = buildGroups(w);
    assert.deepEqual(g.map((x) => [x.key, x.title]), [['plugin:pa', 'pa'], ['claude-ai', 'Synced from claude.ai'], ['builtin', 'Claude Code built-ins']]);
    assert.deepEqual(g.find((x) => x.key === 'builtin')!.skills.map((s) => s.id), ['verify', 'unknown:init']);
    assert.equal(g.find((x) => x.key === 'claude-ai')!.collapsed, true);
    assert.equal(sourceLabel(w[0]!), 'Synced from claude.ai');
    assert.equal(sourceLabel(w[1]!), 'Claude Code built-in');
    assert.deepEqual(groupSkills(w, 'claude-ai').map((s) => s.id), ['claude.ai:notes']);
    assert.deepEqual(turnAllOnTargets(w).map((s) => s.id).sort(), ['claude.ai:notes', 'pa:review'], 'Turn all on never takes a built-in, whatever its source says');
    // a core without groupKind groups as before
    assert.deepEqual(buildGroups([sk('x:y', { source: 'claude-plugin', plugin: 'claude.ai' })]).map((x) => x.key), ['plugin:claude.ai']);
    assert.equal(commandOf(sk('review', { command: 'review' })), '/review');
    assert.deepEqual(commandView(sk('Agent Development', { command: null })), { text: NO_COMMAND, runnable: false, note: '' });
    assert.equal(NO_COMMAND, 'No /command (name has spaces)');
  });
  it('P1: a locked built-in shows its command muted, with "not available in Legion"', () => {
    assert.deepEqual(commandView(sk('update-config', { offReason: 'x', source: 'claude-builtin' })), { text: '/update-config', runnable: false, note: 'not available in Legion' });
    assert.deepEqual(commandView(sk('verify')), { text: '/verify', runnable: true, note: '' });
  });
  it('B7: the real command form of a new skill, and the words follow the noun (skill or drill)', () => {
    assert.equal(newSkillCommand('my-review'), '/legion-armory:my-review');
    assert.equal(newSkillCommand(''), '/legion-armory:<name>');
    assert.match(descriptionError('', 'drill'), /open the drill\.$/);
    assert.match(descriptionError(''), /open the skill\.$/);
    assert.equal(bodyError('', 'drill'), 'Write what the drill tells an agent to do.');
    assert.deepEqual(Object.keys(editorErrors({ name: 'a', description: '', whenToUse: '', body: '' }, [], 'drill')).length, 4);
  });
  it('B8: the total line describes what the list shows', () => {
    const w = world();
    assert.equal(totalLine(w, 'all', 'all', '', []), '10 skills, 3 on.');
    assert.equal(totalLine(w, 'yours', 'all', '', []), '1 skill of yours, 1 on.');
    assert.equal(totalLine([], 'yours', 'all', '', []), '0 skills of yours, 0 on.');
    assert.equal(totalLine(w, 'imported', 'all', '', []), '1 imported skill, 0 on.');
    assert.equal(totalLine(w, 'claude', 'all', '', []), '8 Claude Code skills, 2 on.');
    const shown = buildGroups(w, 'all', 'play').flatMap((g) => g.skills);
    assert.equal(totalLine(w, 'all', 'all', 'play', shown), '2 shown, 0 on.');
    const on = buildGroups(w, 'all', '', 'on').flatMap((g) => g.skills);
    assert.equal(totalLine(w, 'all', 'on', '', on), '3 shown, 3 on.');
  });
  it('M1: a state filter (All / On / Only when I ask) and search that puts the exact name first, across groups', () => {
    assert.deepEqual(STATE_FILTERS.map((f) => f.label), ['All', 'On', 'Only when I ask']);
    assert.deepEqual(buildGroups(world(), 'all', '', 'on').flatMap((g) => g.skills.map((s) => s.id)).sort(), ['context7:docs', 'legion-armory:mine', 'personal-two']);
    assert.deepEqual(buildGroups(world(), 'all', '', 'manual').flatMap((g) => g.skills.map((s) => s.id)), ['playwright:snap']);
    assert.equal(buildGroups(world(), 'all', '', 'manual')[0]!.total, 2, 'the counts still describe the whole group');
    const w = [
      sk('review-notes', { source: 'yours', name: 'review-notes' }),
      sk('pb:code-review', { source: 'claude-plugin', plugin: 'pb', name: 'code-review' }),
      sk('pa:review', { source: 'claude-plugin', plugin: 'pa', name: 'review' }),
      sk('zz', { source: 'claude-personal', description: 'Does a review of things.' }),
    ];
    const g = buildGroups(w, 'all', 'review');
    assert.deepEqual(g.map((x) => x.key), ['plugin:pa', 'yours', 'plugin:pb', 'personal'], 'exact first, then prefix, then contains, then the description');
    assert.deepEqual([matchRank(w[2]!, 'review'), matchRank(w[0]!, 'review'), matchRank(w[1]!, 'review'), matchRank(w[3]!, 'review')], [0, 1, 2, 3]);
    assert.equal(matchRank(sk('pa:Review', { name: 'Review' }), 'review'), 0, 'case does not matter');
    assert.equal(buildGroups(w, 'all', '').map((x) => x.key).join(), 'yours,personal,plugin:pa,plugin:pb', 'no query: the usual order');
  });
  it('M1: a row repeats its source only when it differs from its group', () => {
    const g = buildGroups(world()).find((x) => x.key === 'plugin:playwright')!;
    assert.equal(rowTag(g.all[0]!, g), null);
    assert.equal(rowTag(sk('x', { source: 'yours' }), g), 'Yours');
  });
  it('m2: agents are named the short way round', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, name: i === 0 ? 'Zealot' : `Agent${i}` }));
    assert.equal(agentsLabel(nine.slice(1).map((a) => a.id), nine), 'All but Zealot');
    assert.equal(agentsLabel(['a1', 'a2'], nine), 'Only Agent1, Agent2');
    assert.equal(agentsLabel(['a1', 'a2', 'a3'], nine), '3 of 9');
    assert.equal(agentsLabel(nine.slice(2).map((a) => a.id), nine), 'All but Zealot, Agent1');
  });
  it('m3: Undo is said in words that are shown', () => {
    assert.equal(bulkUndone(352), 'Put back 352 skills.');
    assert.equal(bulkUndone(1), 'Put back 1 skill.');
  });
  it('m5: hidden characters are written out as visible markers', () => {
    assert.equal(showHidden('a\u202Eb'), 'a\u27E8U+202E\u27E9b');
    assert.equal(showHidden('x\u200By\u00ADz'), 'x\u27E8U+200B\u27E9y\u27E8U+00AD\u27E9z');
    assert.equal(showHidden('\uFEFFstart\uFEFF'), '\uFEFFstart\u27E8U+FEFF\u27E9', 'a byte order mark at the very start is a file marker, as in the core');
    assert.equal(showHidden('plain text'), 'plain text');
  });
  it('m9: names that two skills share are told apart for a screen reader', () => {
    const w = [sk('debug', { source: 'claude-builtin', name: 'debug' }), sk('superpowers:debug', { source: 'claude-plugin', plugin: 'superpowers', name: 'debug' }), sk('other', { name: 'other' })];
    const d = duplicateNames(w);
    assert.deepEqual(w.map((s) => uniqueName(s, d)), ['debug (built-in)', 'debug (superpowers)', 'other']);
    assert.equal(uniqueName(sk('a', { source: 'yours', name: 'Debug' }), duplicateNames([...w, sk('a', { source: 'yours', name: 'Debug' })])), 'Debug (yours)', 'case does not matter');
  });
  it('P2: the refusal sentence is said once', () => {
    assert.equal(refusalLine('SKILL.md was refused: the header has no name'), 'This cannot be added: the header has no name.');
    assert.equal(refusalLine('This skill runs shell commands while it loads. Legion does not import skills that do that.'), 'This cannot be added: This skill runs shell commands while it loads. Legion does not import skills that do that.');
    assert.equal(refusalLine('Legion does not import that.'), 'Legion does not import that.');
    assert.equal(refusalLine('This cannot be added: too big.'), 'This cannot be added: too big.');
    assert.equal(refusalLine('There is no SKILL.md in what was given.'), 'This cannot be added: There is no SKILL.md in what was given.');
  });
  it('P4: a refused name offers its fix as a suggestion of its own, and the rule stays', () => {
    assert.equal(nameSuggestion('My Review Skill!'), 'my-review-skill');
    assert.equal(nameSuggestion('ok-name'), '');
    assert.equal(nameSuggestion('!!!'), '');
    assert.equal(nameError('My Skill', [], false), NAME_RULE, 'without the "Try" tail the rule is the whole message');
    assert.match(nameError('My Skill'), /Try my-skill\.$/);
  });
});

describe('review fixes: contrast (WCAG 1.4.3, 4.5:1 for text under 18px) in both themes', () => {
  const tokens = readFileSync(join(process.cwd(), 'ui/src/styles/tokens.css'), 'utf8');
  const block = (re: RegExp): Record<string, string> => Object.fromEntries([...(re.exec(tokens)?.[1] ?? '').matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
  const dark = block(/:root \{([^}]*)\}/);
  const light = { ...dark, ...block(/:root\[data-theme='light'\] \{([^}]*)\}/) };
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string): number => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  /** The background and text token a rule uses, read from the stylesheet itself. */
  const pairOf = (sheet: string, selector: string): { bg: string; fg: string } => {
    const body = new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? '';
    return { bg: /background:\s*var\(--([a-z0-9-]+)\)/.exec(body)?.[1] ?? '', fg: /(?:^|[\s;])color:\s*var\(--([a-z0-9-]+)\)/.exec(body)?.[1] ?? '' };
  };
  const app = readFileSync(join(process.cwd(), 'ui/src/styles/app.css'), 'utf8');
  const armory = readFileSync(join(process.cwd(), 'ui/src/armory/armory.css'), 'utf8');

  it('the ratio function is right: white on the old accent is the 3.42 the review measured', () => {
    assert.ok(Math.abs(ratio('#0c9f5e', '#ffffff') - 3.42) < 0.05);
    assert.ok(ratio('#0c9f5e', '#ffffff') < 4.5, 'which is why the accent fill was not usable for text');
  });
  for (const [what, sheet, selector] of [
    ['the selected "Agents decide" segment', armory, '.arm-state.on.v-on'],
    ['the selected "Only when I ask" segment', armory, '.arm-state.on.v-manual'],
    ['the selected "Off" segment', armory, '.arm-state.on.v-off'],
    ['the active filter chip', armory, '.arm-filter.on'],
    ['the primary button', app, '.btn.primary'],
    ['the send button', app, '.send'],
  ] as const) {
    it(`${what} reaches 4.5:1 in the dark and the light theme`, () => {
      const { bg, fg } = pairOf(sheet, selector);
      assert.ok(bg && fg, `${selector} sets a background and a text colour from tokens`);
      for (const [theme, t] of [['dark', dark], ['light', light]] as const) {
        const r = ratio(t[bg]!, t[fg]!);
        assert.ok(r >= 4.5, `${selector} in ${theme}: ${bg} ${t[bg]} with ${fg} ${t[fg]} is ${r.toFixed(2)}:1`);
      }
    });
  }
});

describe('review fixes: the markup', () => {
  const house = read('ui/src/house/HouseSection.tsx');
  const hstore = read('ui/src/house/houseStore.ts');
  const agentEditor = read('ui/src/components/AgentEditor.tsx');
  const late = read('ui/src/armory/lateFocus.ts');

  it('B2: both bulk paths ask first when it would crowd the prompt, inline, with Turn on and Cancel', () => {
    assert.match(section, /const c = consequenceOf\('notice'\); if \(c\.over\) setConfirm\(c\); else go\(\);/, 'Turn all on');
    assert.match(section, /const c = consequenceOf\(g\.key\); if \(c\.over\) setConfirm\(c\); else run\('on'\);/, 'a group\'s Turn on');
    assert.match(section, /function ConfirmStep/);
    assert.match(section, /role="group" aria-label=\{`Confirm: \$\{title\}`\}/, 'inline, not a modal');
    assert.ok(!/ConfirmStep[^]*Modal/.test(section.slice(section.indexOf('function ConfirmStep'), section.indexOf('function NoticeBar'))), 'no modal wall');
    assert.match(section, />Cancel<\/button>/);
    assert.match(store, /Agents now see|loadsNow\(\)/);
    assert.match(store, /const after = \[loadsNow\(\), to === 'on' \? flagsOf\(res\.done\) : ''\]/, 'the Undo bar repeats the load and the flags');
  });
  it('B3/m7/m8: the agent editor says why a tick does nothing, opens the Armory row, focuses Skills on request, and asks before discarding', () => {
    assert.match(agentSkills, /tickReason\(s, id, who\)/);
    assert.match(agentSkills, /Open in the Armory/);
    assert.match(agentSkills, /\{who\} gets the skills that are on in the Armory for this agent, and your drills that are on\./, 'not "every skill that is on"');
    assert.ok(!/every skill that is on in the Armory/.test(agentSkills.replace(/aria-label=\{`Choose every skill that is on in/, '')), 'the old copy is gone');
    assert.match(agentEditor, /openSettings\('armory'\)/);
    assert.match(agentEditor, /revealSkill\(skill\)/);
    assert.match(agentEditor, /<Modal title=\{[^]*?\} width=\{600\} onClose=\{requestClose\}/, 'Esc, the X and a click outside all ask');
    assert.match(agentEditor, /if \(dirty\) setLeaving\(\{ to: 'close' \}\); else closeOverlays\(\);/);
    assert.match(agentEditor, /const dirty = skillsDirty \|\| fields !== startFields\.current;/, 'every field counts, not only Skills');
    assert.match(agentEditor, /<button type="button" className="btn-ghost" onClick=\{requestClose\}>Cancel<\/button>/, 'a Cancel in the footer asks the same way');
    assert.match(agentEditor, /querySelector<HTMLElement>\('\[data-skills-focus\]'\)/, 'Choose skills for Zealot lands on Skills');
    assert.match(section, /openEditor\(a\.id, 'skills'\)/);
    assert.match(read('ui/src/store.ts'), /openEditor = \(id: string \| null, focus\?: 'skills'\)/);
  });
  it('B5: Remove says "Removing…" on the row at once, and focus moves to Undo only while it is still wanted', () => {
    assert.match(section, /aria-busy=\{op === 'remove' \|\| undefined\}/);
    assert.match(section, /Removing\{'…'\}/);
    assert.match(store, /busyOps: \{ \.\.\.state\.busyOps, \[id\]: 'remove' \}/);
    assert.match(section, /if \(wantFocus\.current\.still\(\)\) undoBtn\.current\?\.focus\(\);/);
    assert.match(late, /return !typed && \(!a \|\| a === document\.body \|\| !!scope\?\.contains\(a\)\);/);
    assert.match(late, /window\.addEventListener\('keydown', onKey, true\)/, 'a key pressed meanwhile cancels the move');
  });
  it('B4: the selected segment, the active chip and the primary button use the accent TEXT token, which passes in both themes', () => {
    assert.match(css, /\.arm-state\.on\.v-on \{ background: var\(--accent-text\); color: var\(--accent-ink\); \}/);
    assert.match(css, /\.arm-filter\.on \{ background: var\(--accent-text\)/);
    assert.match(read('ui/src/styles/app.css'), /\.btn\.primary \{ background: var\(--accent-text\); color: var\(--accent-ink\)/);
  });
  it('B9/M3/m6: drills have Remove with Undo (re-POST replace); Promote opens the drill and focuses it; the Promote bar goes when you leave', () => {
    assert.match(hstore, /request<\{ removed: string; name: string; text: string \}>\('DELETE', `\/api\/house\/drill\?path=\$\{encodeURIComponent\(path\)\}`\)/);
    assert.match(hstore, /'POST', '\/api\/house\/drill', \{ name: p\.name \|\| r\.name, description: p\.description, body: p\.body, replace: true \}/);
    assert.match(house, /aria-label=\{`Remove \$\{label\}`\}/);
    assert.match(house, /Undo brings it back not approved and off\./, 'said honestly: the approval was of those exact words');
    assert.match(store, /await request\('POST', '\/api\/armory\/notice-seen', \{ seen: false \}\)/, 'Undo after Turn all on brings the notice back');
    assert.match(store, /\.\.\.\(marked \? \{ restoreNotice: true \} : \{\}\)/);
    assert.match(section, /const openPromoted = \(\): void => \{ markHouseFresh\(\); showPromotedDrill\(\); setSettingsSection\('house'\); \};/);
    assert.match(store, /revealDrill\(p\.path\);/);
    assert.match(hstore, /set\(\{ justAdded: path, focusPath: path \}\)/);
    assert.match(house, /return focusWhenReady\(\{[\s\S]*fallback: \(\) => heading\.current,[\s\S]*done: \(\) => clearFocusPath\(\)/, 'focus is retried until the row holds it, falls back to the heading, never the page');
    assert.match(section, /useEffect\(\(\) => \(\) => \{ dismissPromoted\(\); clearUndone\(\); \}, \[\]\);/);
    assert.match(section, /Copied \{p\.from\} to Doctrine as the drill \{p\.name\}\./);
  });
  it('M2: the rows of a closed group are not drawn; a row is not content-visibility (it clipped the menu) and is measured before paint', () => {
    assert.match(section, /\{open \? \(\s*<ul className="house-list arm-list">/);
    assert.ok(!/\.arm-row \{[^}]*content-visibility/.test(css), 'content-visibility clips the row menu');
    assert.match(descriptionSrc, /useLayoutEffect\(\(\) => \{ measure\(\); \}, \[text, expanded\]\)/, 'Show more is known before the first paint');
    assert.ok(!/IntersectionObserver/.test(section));
  });
  it('M4: Doctrine holds drills and the Armory holds skills, in the nav, the header and the drill editor', () => {
    assert.match(read('ui/src/components/Settings.tsx'), /label: 'Doctrine', hint: 'Rules and drills your agents follow'/);
    assert.match(editor, /to decide whether to open the \$\{noun\}/);
    assert.match(editor, /What the agent reads once it opens the \$\{noun\}/);
  });
  it('B7: the drill editor says "the drill\'s name", the skill editor the real /command', () => {
    assert.match(editor, /It becomes the drill's name\./);
    assert.match(editor, /It becomes the \/command: \$\{newSkillCommand\(f\.name\)\}\./);
    assert.ok(!/It becomes the \/command\. /.test(editor));
  });
  it('m4/P3/P4: the Agents dialog skips the boxes when All is chosen, Refresh has a full name, a refused name keeps its hint and offers its fix', () => {
    assert.match(dialogs, /aria-disabled=\{all \|\| undefined\} tabIndex=\{all \? -1 : undefined\}/);
    assert.match(section, /aria-label="Refresh the list from Claude Code"/);
    assert.match(editor, /<span id=\{ids\.nameHint\} className="field-note">/, 'the hint is always there');
    assert.match(editor, /className="link-btn arm-suggest" onClick=\{\(\) => \{ upd\('name', suggestion\)/);
  });
  it('m5/P2: the import preview shows hidden characters as markers and says the refusal once', () => {
    assert.match(dialogs, /<Markdown text=\{showHidden\(doc\.body\)\} headingOffset=\{3\} quietCode \/>/);
    assert.match(dialogs, /<span>\{refusalLine\(review\.refusal\)\}<\/span>/);
  });
});

describe('second UX review', () => {
  it('item 6: the shell switch is asked first, says how many skills it reaches, and its two sentences agree', () => {
    assert.match(shellConfirm(2, 0), /nothing asks you first\. 2 skills have such a line now, none of them on\. Turn on anyway\?$/);
    assert.match(shellConfirm(3, 1), /3 skills have such a line now, 1 of them on\./);
    assert.match(shellConfirm(0, 0), /No skill has such a line now\./);
    assert.match(SHELL_SCOPE, /Legion does not import skills that do that/);
    assert.match(SHELL_ON_LINE, /^On: skills can run commands when they load$/);
    const s = read('ui/src/armory/ArmorySection.tsx');
    assert.match(s, /if \(e\.target\.checked\) setAsk\(true\); else void setAllowShell\(false\)/, 'off to on is asked, on to off is not');
    assert.match(s, /<ConfirmStep message=\{shellConfirm\(withLine, withLineOn\)\}/);
    assert.match(s, /\{on \? <p className="arm-shellon">/);
  });
  it('item 12: a description at the cap says it was shortened; a short one does not', () => {
    assert.equal(descriptionCut(`${'a'.repeat(399)}…`), true);
    assert.equal(descriptionCut('Short…'), false);
    assert.equal(descriptionCut('a'.repeat(400)), false);
    assert.match(CUT_NOTE, /400 characters/);
  });
  it('item 10: the flagged skills are named, with "and N more" past four', () => {
    assert.equal(flagsNamed(['a'], ['b', 'c'], 9), 'Of the 9 you are turning on, 1 runs commands when loaded (a) and 2 have hidden characters (b, c).');
    assert.match(flagsNamed([], ['a', 'b', 'c', 'd', 'e', 'f'], 9), /\(a, b, c, d and 2 more\)/);
    assert.equal(flagsNamed([], [], 9), '');
  });
  it('items 1, 4, 5, 7, 8, 13, 14, 15, 18, 20: the style and markup contracts', () => {
    const css = read('ui/src/armory/armory.css');
    const house = read('ui/src/house/house.css');
    const app = read('ui/src/styles/app.css');
    const editor = read('ui/src/armory/SkillEditor.tsx');
    const picks = read('ui/src/armory/AgentSkills.tsx');
    assert.match(css, /\.arm-menu\.up \{ top: auto; bottom: calc\(100% \+ 4px\); \}/, 'the menu opens upward near the bottom edge');
    assert.match(css, /\.form \.arm-agentskills input\[type='radio'\]:focus-visible[^}]*outline: 2px solid var\(--accent-text\); outline-offset: 2px/);
    assert.ok(!/\.arm-states \{[^}]*overflow: hidden/.test(css), 'the group does not clip its own focus ring');
    assert.ok(!/\.arm-state\.on \{[^}]*font-weight/.test(css) && !/\.arm-filter\.on \{[^}]*font-weight/.test(css), 'a chosen segment is not wider than an unchosen one');
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(house, /\.house-sgbtn \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/);
    assert.match(house, /\.house-ghead > \.house-reset:empty \{ display: none; \}/);
    assert.match(editor, /footer=\{loaded \? <div ref=\{setFoot\}/, 'Cancel and Save are in the dialog footer');
    assert.match(editor, /type="submit" form=\{formId\}/);
    assert.match(css, /\.form\.arm-form \[aria-invalid='true'\], \.form\.arm-form \[aria-invalid='true'\]:focus \{ border-color: var\(--danger\)/);
    assert.match(css, /\.arm-check\.dim input \{ opacity: \.45; \}/);
    assert.ok(!/max-height: 320px/.test(css) && !/max-height: 160px/.test(css), 'no scroll box inside the scrolling dialog');
    assert.match(picks, /\{open \? \(\s*<ul className="arm-picklist">/, 'only an open group draws its rows');
    assert.match(picks, /onOpenArmory && has\(r\.id\)/, 'the way out is offered only on a ticked skill');
    assert.match(app, /\.btn\.primary:hover:not\(:disabled\) \{ background: var\(--accent-hover\); \}/);
    assert.match(read('ui/src/styles/tokens.css'), /--accent-hover: #066a3d;/);
    assert.match(app, /\.set-scroll \{[^}]*scrollbar-gutter: stable/);
  });
  it('item 20: the hover colours keep white / dark ink readable (4.5:1) and differ from the resting colour', () => {
    const lum = (hex: string): number => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
    const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    assert.ok(ratio('#066a3d', '#ffffff') >= 4.5);
    assert.ok(ratio('#9dffc6', '#04140b') >= 4.5);
    assert.notEqual('#066a3d', '#087a47');
  });
  it('item 9: Doctrine says drills, the one button says Approve, and Approved by you is not drawn in the warning colour', () => {
    const house = read('ui/src/house/HouseSection.tsx');
    assert.match(house, /'Withdraw approval' : 'Approve'\}/);
    assert.ok(!/Approve as my rules/.test(house));
    assert.match(read('ui/src/house/house.css'), /\.house-tag\.t-adopted \{ color: var\(--text\); \}/);
    assert.match(read('ui/src/armory/AgentSkills.tsx'), /g\.key === 'drills' \? 'drill' : 'skill'/);
  });
  it('item 19: a new skill starts off, and its row says so with Turn on', () => {
    assert.match(read('src/core/armory/store.ts'), /export const defaultState = \(_source: SkillSource\): SkillState => 'off';/);
    assert.match(read('ui/src/armory/SkillEditor.tsx'), /A new skill starts off\./);
    assert.match(read('ui/src/armory/ArmorySection.tsx'), /<span>Saved \(off\)\.<\/span>/);
  });
});
