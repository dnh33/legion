/**
 * Settings -> House context: the pure view logic (grouping, order, labels, counts, search, reset scope, optimistic
 * switch) and the markup contracts the screen must keep (disclosure semantics, a real switch, a labelled dialog).
 *
 * The logic lives in src/shared/house-view.ts, so these run against the code the UI imports, not a copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bulkDone, bulkLabel, bulkName, bulkNothing, bulkUndone, licenceLabels, licenceNameFromText, pathIsRedundant, buildView, cleanTitle, displayTitle, dropLeadingTitle, endSentence, formatBytes, GROUPS,
  humaniseSkillName, listedCount, matchCount, matches, missingLine, nextHeader, noSkillsShipped, parseOpenGroups, parseSkillText, plural,
  showSearch, skillDisplayTitle, skillGroupLabel, skillGroupTitle, SKILLS_BANNER, TRUST_LEGEND, trustBlurb,
  trustLabel, withSwitch, wouldReset,
} from '../src/shared/house-view.js';
import type { HouseCategory, HouseFileView } from '../src/shared/house-view.js';

const f = (path: string, over: Partial<HouseFileView> = {}): HouseFileView => ({
  path, bytes: 100, trust: 'shipped', category: 'yours', title: path, on: true, locked: false, ...over,
});
const skill = (group: string, name: string, on = false, extra: Partial<HouseFileView> = {}): HouseFileView[] => {
  const p = `skills/${group}/${name}/SKILL.md`;
  return [
    f(p, { category: 'skills', group, skill: p, title: name, description: `Does ${name}.`, on, ...extra }),
    f(`skills/${group}/${name}/LICENSE.md`, { category: 'skills', group, skill: p, title: 'LICENSE', on }),
    f(`skills/${group}/${name}/references/a.md`, { category: 'skills', group, skill: p, title: 'a', on }),
  ];
};
const about = (): HouseFileView[] => [
  f('skills/README.md', { category: 'skills', group: null, skill: null, on: false }),
  f('skills/SOURCES.md', { category: 'skills', group: null, skill: null, on: false }),
];
const layer = (): HouseFileView[] => [
  f('AGENTS.md', { category: 'core', locked: true }),
  f('CONTEXT.md', { category: 'core', locked: true }),
  ...skill('review', 'requesting-code-review'),
  ...skill('verify-debug', 'systematic-debugging', true),
  ...skill('verify-debug', 'verification-before-completion'),
  ...skill('ci-github', 'fix-red-ci'),
  ...skill('zz-new_group', 'thing'),
  ...about(),
  f('docs/ARCHITECTURE.md', { category: 'built' }),
  f('docs/adr/0001-x.md', { category: 'decisions' }),
  f('docs/RELEASE-NOTES.md', { category: 'history', on: false }),
  f('context/a.md', { category: 'facts' }),
  f('mine.md', { category: 'yours', trust: 'untrusted' }),
];

test('groups come in the owner\'s order, each with a one-line blurb and a count; empty groups are hidden', () => {
  const v = buildView(layer());
  assert.deepEqual(v.map((g) => g.info.category), ['core', 'skills', 'built', 'decisions', 'history', 'facts', 'yours']);
  assert.deepEqual(GROUPS.map((g) => g.title), ['Core tenets', 'Drills', 'Foundations', 'Decrees', 'Chronicle', 'Lore', 'Your orders']);
  assert.deepEqual(GROUPS.map((g) => g.hint), [
    'always on', 'drills agents can use · off by default', 'how Legion is built · on by default', 'decisions on record · on by default',
    'release history · on by default', 'facts and data · on by default', 'files you added · on by default',
  ], 'every hint says the default');
  assert.equal(v[0]!.info.blurb, 'Every agent reads these first. They stay on, and you cannot switch them off.');
  assert.equal(v[0]!.countLine, '2 files');
  assert.equal(v[0]!.locked, true);
  assert.equal(v[2]!.countLine, '1 file');
  const noFacts = buildView(layer().filter((x) => x.category !== 'facts' && x.category !== 'yours'));
  assert.deepEqual(noFacts.map((g) => g.info.category), ['core', 'skills', 'built', 'decisions', 'history']);
  assert.deepEqual(buildView([]), []);
});

test('skills: sub-groups in a fixed order with friendly names, reference files folded into their skill, "n of m on"', () => {
  const sk = buildView(layer()).find((g) => g.info.category === 'skills')!;
  assert.deepEqual(sk.skillGroups.map((g) => g.title), ['Verify and debug', 'CI and GitHub', 'Review', 'Zz New Group']);
  assert.deepEqual(sk.skillGroups.map((g) => g.countLine), ['1 of 2 on', '0 of 1 on', '0 of 1 on', '0 of 1 on']);
  assert.equal(sk.countLine, '5 drills, 1 on');
  const dbg = sk.skillGroups[0]!.skills.find((s) => s.file.title === 'systematic-debugging')!;
  assert.equal(dbg.references, 1, 'a.md counts as a reference file');
  assert.deepEqual(dbg.licences.map((l) => l.path), ['skills/verify-debug/systematic-debugging/LICENSE.md'], 'licence found from the file name');
  assert.equal(dbg.references + dbg.licences.length, 2, 'the licence is the Licence link, never one of the "+ n reference files"');
  assert.equal(sk.rows.length, 0, 'no reference file is a row of its own');
  assert.deepEqual(sk.about.map((a) => a.path), ['skills/README.md', 'skills/SOURCES.md']);
  assert.equal(skillGroupTitle('some_odd-name'), 'Some Odd Name');
});

test('skills: no SKILL.md shipped is its own state', () => {
  assert.equal(noSkillsShipped(layer()), false);
  assert.equal(noSkillsShipped(layer().filter((x) => x.category !== 'skills')), true);
  assert.equal(noSkillsShipped(about()), true, 'the about files alone are not skills');
});

test('trust labels: From Legion, Edited, Approved by you; your own unapproved file is "Not approved"', () => {
  assert.equal(trustLabel({ trust: 'shipped', category: 'built' }), 'From Legion');
  assert.equal(trustLabel({ trust: 'untrusted', category: 'built' }), 'Edited');
  assert.equal(trustLabel({ trust: 'untrusted', category: 'skills' }), 'Edited');
  assert.equal(trustLabel({ trust: 'untrusted', category: 'yours' }), 'Not approved');
  assert.equal(trustLabel({ trust: 'adopted', category: 'yours' }), 'Approved by you');
});

test('search: shows only above 12 listed rows, matches title, path and description, and keeps other groups hidden', () => {
  const files = layer();
  assert.equal(listedCount(files), 2 + 5 + 1 + 1 + 1 + 1 + 1, 'reference and about files are not rows');
  assert.equal(showSearch(files), false);
  const many = [...files, ...Array.from({ length: 6 }, (_, i) => f(`context/n${i}.md`, { category: 'facts' }))];
  assert.equal(showSearch(many), true);
  assert.equal(showSearch(many.slice(0, 0)), false);

  assert.equal(matches({ title: 'Fix red CI', path: 'x', description: 'when checks fail' }, 'checks FAIL'), true);
  assert.equal(matches({ title: 'a', path: 'docs/adr/1.md', description: '' }, 'adr'), true);
  assert.equal(matches({ title: 'a', path: 'b', description: 'c' }, 'zzz'), false);
  assert.equal(matches({ title: 'Fix red CI', path: 'x', description: 'when checks fail' }, 'checks zzz'), false, 'every word must match');

  const hit = buildView(many, 'fix-red');
  assert.deepEqual(hit.map((g) => g.info.category), ['skills']);
  assert.deepEqual(hit[0]!.skillGroups.map((g) => g.key), ['ci-github']);
  assert.equal(hit[0]!.skillGroups[0]!.countLine, '0 of 1 on', 'the count describes the group, not the filtered part');
  assert.equal(hit[0]!.about.length, 0, 'no about links while filtering');
  assert.deepEqual(buildView(many, 'no-such-thing'), []);
  assert.equal(buildView(many, '   ').length, 7, 'blank query is no filter');
});

test('reset scope: only what a reset would flip (skills that are on, other rules that are off); core never', () => {
  const files = layer();
  assert.deepEqual(wouldReset(files, { group: 'verify-debug' }).map((x) => x.title), ['systematic-debugging']);
  assert.deepEqual(wouldReset(files, { group: 'review' }), [], 'already at defaults: no confirm needed');
  assert.deepEqual(wouldReset(files, { category: 'skills' }).map((x) => x.title), ['systematic-debugging']);
  assert.deepEqual(wouldReset(files, { category: 'history' }).map((x) => x.path), ['docs/RELEASE-NOTES.md']);
  assert.deepEqual(wouldReset(files, { category: 'facts' }), []);
  assert.deepEqual(wouldReset(files.map((x) => (x.category === 'core' ? { ...x, on: false } : x)), { category: 'core' }), []);
});

test('optimistic switch: moves the file and its skill\'s reference files, never mutates, and rolling back restores', () => {
  const files = layer();
  const p = 'skills/review/requesting-code-review/SKILL.md';
  const next = withSwitch(files, p, true);
  assert.equal(files.find((x) => x.path === p)!.on, false, 'input untouched');
  const mine = next.filter((x) => x.skill === p || x.path === p);
  assert.equal(mine.length, 3);
  assert.ok(mine.every((x) => x.on));
  assert.equal(next.filter((x) => x.on).length, files.filter((x) => x.on).length + 3, 'nothing else moved');
  assert.deepEqual(withSwitch(next, p, false), files, 'rollback gives back the original');
  assert.equal(withSwitch(files, p.toUpperCase().replace('SKILL.MD', 'SKILL.md'), true).filter((x) => x.on).length, files.filter((x) => x.on).length + 3, 'case-insensitive like the core');
});

test('arrow keys move between disclosure headers and wrap; other keys do nothing', () => {
  assert.equal(nextHeader('ArrowDown', 0, 3), 1);
  assert.equal(nextHeader('ArrowDown', 2, 3), 0);
  assert.equal(nextHeader('ArrowUp', 0, 3), 2);
  assert.equal(nextHeader('Home', 2, 3), 0);
  assert.equal(nextHeader('End', 0, 3), 2);
  assert.equal(nextHeader('Enter', 0, 3), null, 'Enter and Space stay with the button');
  assert.equal(nextHeader('ArrowDown', 0, 0), null);
});

test('remembered open groups: tolerant of garbage, only true values survive', () => {
  assert.deepEqual(parseOpenGroups('{"review":true,"x":false,"y":"yes"}'), { review: true });
  for (const bad of [null, undefined, '', 'not json', '[1]', '"s"', 'null']) assert.deepEqual(parseOpenGroups(bad), {});
});

test('small formatters', () => {
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(40 * 1024), '40 KB');
  assert.equal(plural(1, 'skill'), '1 skill');
  assert.equal(plural(0, 'skill'), '0 skills');
  assert.equal(plural(2, 'switch'), '2 switches');
  assert.equal(plural(3, 'reference file'), '3 reference files');
});

/* ---- markup contracts: what a screen reader and a keyboard rely on ---- */
const src = readFileSync(join(process.cwd(), 'ui/src/house/HouseSection.tsx'), 'utf8');
const css = readFileSync(join(process.cwd(), 'ui/src/house/house.css'), 'utf8');
const store = readFileSync(join(process.cwd(), 'ui/src/house/houseStore.ts'), 'utf8');

test('sub-group headers are real disclosure buttons with aria-expanded and aria-controls, collapsed unless remembered', () => {
  assert.match(src, /<button[^>]*aria-expanded=\{open\}[^>]*aria-controls=\{id\}/);
  assert.match(src, /id=\{id\} className="house-sgbody" hidden=\{!open\}/, 'the controlled panel is hidden, not just styled away');
  assert.match(src, /open=\{searching \|\| !!open\[sg\.key\]\}/, 'closed unless remembered or searching');
  assert.match(src, /try \{[^}]*localStorage[^}]*\} catch/, 'storage reads and writes are guarded');
});

test('each switch is a labelled checkbox with role=switch, and core rows have a lock instead of a switch', () => {
  assert.match(src, /<input type="checkbox" role="switch" checked=\{f\.on\} aria-disabled=\{switching \|\| undefined\} aria-label=\{caption \? `\$\{caption\}: \$\{label\}` : label\}/);
  assert.match(src, /onChange=\{\(e\) => \{ if \(!switching\) void setHouseSwitch/, 'a change while it saves is ignored, not queued');
  assert.match(src, /f\.locked \? \(\s*<span className="house-lock">/);
  assert.match(src, /const meaning = `\$\{trustBlurb\(f\)\}\$\{f\.locked \? ` \$\{LOCK_REASON\}` : ''\}`;/, 'the lock reason reaches the row as its description, not a hover');
  assert.match(src, /<li ref=\{li\} tabIndex=\{-1\} data-house-path=\{f\.path\} aria-busy=\{removing \|\| undefined\} className=\{`house-row[^`]*`\}>/, 'the sentence is not hung on the li');
});

test('a failed switch rolls back and says so on the row; a failed reset says so too', () => {
  assert.match(store, /catch \(e\) \{\s*if \(state\.status && before !== undefined\) set\(\{ status: \{ \.\.\.state\.status, files: withSwitch\(state\.status\.files, path, before\) \} \}\);\s*set\(\{ switchErrors/);
  assert.match(src, /role="alert"><Icon name="x" size=\{12\} \/> <span>\{endSentence\(`Could not save: \$\{err\}`\)\} The switch is still \{f\.on \? 'on' : 'off'\}\./);
  assert.match(store, /resetErrors: \{ \.\.\.state\.resetErrors, \[key\]: msg\(e\) \}/);
});

test('"Read it" opens a labelled modal dialog through the shared Modal (focus trap, Esc, focus return)', () => {
  assert.match(src, /import \{ Modal \} from '\.\.\/components\/Modal'/);
  assert.match(src, /createPortal\(\s*<Modal title=\{r\.title\}/);
  assert.match(readFileSync(join(process.cwd(), 'ui/src/components/Modal.tsx'), 'utf8'), /role="dialog" aria-modal="true" aria-label=\{title\}/);
  assert.match(readFileSync(join(process.cwd(), 'ui/src/App.tsx'), 'utf8'), /!document\.querySelector\('\.scrim \.modal'\)/, 'Esc in a dialog does not also leave Settings');
});

test('the stylesheet gives every control a focus ring and the switch never moves on toggle', () => {
  assert.match(css, /\.house-sw input:focus-visible ~ \.house-swtrack \{ outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.house-sgbtn:focus-visible \{ outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.house-swtext \{ width: 22px;/, 'On/Off text has a fixed width');
  assert.match(css, /\.house-actions \{ flex: none;/, 'controls never shrink');
  assert.match(css, /\.house-title \{[^}]*text-overflow: ellipsis/, 'long titles truncate');
  assert.match(src, /title=\{label\}/, 'and the full text is on hover');
});

const cats: HouseCategory[] = ['core', 'skills', 'decisions', 'built', 'history', 'facts', 'yours'];
test('every core category has a group definition', () => {
  assert.deepEqual([...GROUPS.map((g) => g.category)].sort(), [...cats].sort());
});

test('skill titles are readable: slugs become words, acronyms and GitHub stay right, the path keeps the slug', () => {
  assert.equal(humaniseSkillName('systematic-debugging'), 'Systematic debugging');
  assert.equal(humaniseSkillName('verification-before-completion'), 'Verification before completion');
  assert.equal(humaniseSkillName('fix-red-ci'), 'Fix red CI');
  assert.equal(humaniseSkillName('harden-github-actions'), 'Harden GitHub Actions');
  assert.equal(humaniseSkillName('ci-github'), 'CI GitHub');
  assert.equal(skillDisplayTitle({ path: 'skills/ci-github/fix-red-ci/SKILL.md', title: 'fix-red-ci' }), 'Fix red CI');
  assert.equal(skillDisplayTitle({ path: 'docs/adr/0001-x.md', title: 'ADR one' }), 'ADR one', 'only a SKILL.md is humanised');
  const row = buildView(layer()).find((g) => g.info.category === 'skills')!.skillGroups.flatMap((g) => g.skills).find((s) => s.file.path.includes('fix-red-ci'))!;
  assert.equal(row.displayTitle, 'Fix red CI');
  assert.equal(row.file.path, 'skills/ci-github/fix-red-ci/SKILL.md');
  assert.equal(matches({ title: 'fix-red-ci', path: 'skills/ci-github/fix-red-ci/SKILL.md', description: '' }, 'fix red ci'), true, 'search finds the words the row shows');
  assert.match(src, /const label = skill \? \(isOwnDrill\(f\) \? \(f\.path\.split\('\/'\)\[2\] \?\? skill\.displayTitle\) : skill\.displayTitle\) : displayTitle\(f\);/, 'your own drill is called what you typed, as in the Armory');
  assert.match(src, /openHouseFile\(f\.path, label\)/, 'the dialog title is the readable one too');
});

test('sub-group accessible name is the group and its count; the summary is a description, not part of the name', () => {
  const sg = buildView(layer()).find((g) => g.info.category === 'skills')!.skillGroups[0]!;
  assert.equal(skillGroupLabel(sg), 'Verify and debug, 1 of 2 on');
  assert.match(src, /aria-label=\{skillGroupLabel\(sg, forced\)\} aria-describedby=\{sumId\}/);
  assert.match(src, /<span id=\{sumId\} className="house-sgsum">/);
  assert.match(src, /aria-expanded=\{open\}[^>]*aria-controls=\{id\}/, 'disclosure semantics kept');
});

test('the dialog splits frontmatter from the body: a header of facts, the rest as markdown, commit shortened to 7', () => {
  const text = '---\nname: fix-red-ci\ndescription: x\nlicense: Apache-2.0 AND MIT\nmetadata: { source: "https://github.com/openai/skills", commit: 77963424cd7687fd52e5fcfdd3f08d826ab9b1ab, edited: "for Legion" }\n---\n\n# Fix red CI\n\nBody.\n';
  const d = parseSkillText(text);
  assert.deepEqual({ ...d }, { body: '# Fix red CI\n\nBody.\n', name: 'fix-red-ci', licence: 'Apache-2.0 AND MIT', source: 'https://github.com/openai/skills', commit: '7796342' });
  assert.ok(!d.body.includes('---'), 'no frontmatter left in the body');
  assert.deepEqual({ ...parseSkillText('# Plain\n\n---\nnot frontmatter\n') }, { body: '# Plain\n\n---\nnot frontmatter\n', name: '', licence: '', source: '', commit: '' });
  assert.equal(parseSkillText('---\nname: a\nmetadata: { source: "javascript:alert(1)", commit: nothex }\n---\nx').source, '', 'only http(s) sources become links');
  assert.equal(parseSkillText('---\nname: a\nmetadata: { commit: nothex }\n---\nx').commit, '');
  assert.equal(parseSkillText('---\r\nname: a\r\n---\r\nbody').body, 'body', 'CRLF frontmatter');
  // the real skill files parse into a complete header
  for (const rel of ['skills/ci-github/fix-red-ci/SKILL.md', 'skills/verify-debug/systematic-debugging/SKILL.md']) {
    const r = parseSkillText(readFileSync(join(process.cwd(), rel), 'utf8'));
    assert.ok(r.name && r.licence && /^https:\/\//.test(r.source) && /^[0-9a-f]{7}$/.test(r.commit), `${rel} header: ${JSON.stringify({ ...r, body: '' })}`);
    assert.ok(r.body.startsWith('#'), 'body starts at the heading');
  }
});

test('the dialog renders the body with the app Markdown component (no raw HTML) and keeps a licence as typed', () => {
  assert.match(src, /import \{ Markdown \} from '\.\.\/components\/Markdown'/);
  assert.match(src, /<Markdown text=\{body\} headingOffset=\{2\} quietCode \/>/, 'headings in the dialog are real heading elements');
  assert.ok(!/dangerouslySetInnerHTML/.test(src), 'no raw HTML');
  assert.match(src, /LICENCE_RE\.test\(r\.path/, 'a licence file is shown as plain text');
  assert.match(src, /openExternal\(doc\.source\)/, 'the source opens through the app link mechanism');
  assert.match(src, /Pinned at <code>\{doc\.commit\}<\/code>/);
});

test('the screen is called Doctrine; internal names stay, and loading text uses the ellipsis character', () => {
  assert.match(src, /<h3 ref=\{heading\} tabIndex=\{-1\}>Doctrine<\/h3>\s*<p>\s*The rules and drills your agents follow\./);
  assert.ok(!/House context<\/h3>/.test(src), 'no old heading');
  const settings = readFileSync(join(process.cwd(), 'ui/src/components/Settings.tsx'), 'utf8');
  assert.match(settings, /\{ id: 'house', label: 'Doctrine', hint: 'Rules and drills your agents follow' \}/);
  assert.equal(SKILLS_BANNER, 'Drills from Legion are off until you turn them on. Each drill changes how agents work.');
  assert.match(src, /Working\{'…'\}/);
  assert.match(src, /Saving\{'…'\}/);
  assert.match(src, /Reading your doctrine files\{'…'\}/);
  for (const m of src.matchAll(/>[^<>{}]*\.\.\.[^<>{}]*</g)) assert.fail(`three dots in visible text: ${m[0]}`);
});

test('narrow layout keys off the column (container query), not the window; rows stack without overlap', () => {
  assert.match(css, /\.house-cq \{ container: house \/ inline-size; \}/);
  assert.match(src, /className="set-section house-cq"/, 'the section is the container');
  assert.match(css, /@container house \(max-width: \d+px\) \{[^@]*\.house-line \{ flex-direction: column;/);
  assert.match(css, /@container house \(max-width: \d+px\) \{[^@]*\.house-actions \{ flex-wrap: wrap;/, 'controls wrap instead of overlapping');
  assert.match(css, /@container house \(max-width: \d+px\) \{[^@]*\.house-title \{ white-space: normal;/);
  assert.match(css, /\.house-meta > \* \{ white-space: nowrap; \}/, 'Read it and Licence never wrap per word');
  assert.match(css, /\.house-meta \{ flex-wrap: wrap;/, 'the meta line wraps as a unit');
  assert.match(css, /\.house-sgtext \{[^}]*min-width: 0;[^}]*flex-direction: column/, 'sub-group name above its wrapping summary');
  assert.match(css, /\.house-sgsum \{[^}]*overflow-wrap: anywhere/);
  assert.ok(!/white-space: nowrap/.test(/\.house-sgsum \{[^}]*\}/.exec(css)![0]), 'the summary wraps, never truncates');
  assert.match(css, /\.house-sgbtn \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/, 'the header is one grid row (chevron, text, count): nothing wraps, whatever the column width');
  assert.match(css, /\.house-sgcount \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/, 'and it can shrink and wrap');
  assert.ok(!/@media \(max-width/.test(css), 'no viewport query: the column is narrow because of the sidebars, not the window');
});

test('descriptions show in full on the row (no clamp, no hover-only text); no transition: all; reduced motion covers the chevron', () => {
  assert.ok(!/\.house-desc \{[^}]*(?:line-clamp|white-space: nowrap|overflow: hidden)/.test(css), 'the "when to use" sentence is never cut');
  assert.match(src, /<Description text=\{f\.description\} name=\{label\} cutNote="[^"]*" \/>/, 'the shared one-line description with Show more, the same as the Armory');
  assert.ok(!/house-desc" title=/.test(src), 'the full text is not left to a tooltip');
  assert.ok(!/transition:\s*all/.test(css));
  const rm = /@media \(prefers-reduced-motion: reduce\) \{([^}]*)\}/.exec(css)![1]!;
  for (const sel of ['.house-sgbtn .icon', '.house-swtrack', '.house-search']) assert.ok(rm.includes(sel), `reduced motion covers ${sel}`);
  assert.match(css, /\.house-count \{[^}]*font-variant-numeric: tabular-nums/);
  assert.match(css, /\.house-sgcount \{[^}]*font-variant-numeric: tabular-nums/);
});

/* ---- fix round 2: copy, search, titles, bulk actions, dialog, contrast ---- */
test('an error sentence is closed before another is added; a finished one is left alone', () => {
  assert.equal(endSentence('Cannot reach Legion core'), 'Cannot reach Legion core.');
  assert.equal(endSentence('Cannot reach Legion core.'), 'Cannot reach Legion core.');
  assert.equal(endSentence('Nope!'), 'Nope!');
  assert.equal(endSentence('Why?'), 'Why?');
  assert.equal(endSentence('  spaced  '), 'spaced.');
  assert.equal(endSentence(''), 'Something went wrong.');
  assert.match(src, /endSentence\(`Could not save: \$\{err\}`\)\} The switch is still/, 'the glued sentence is the one that was reported');
  for (const m of src.matchAll(/\$\{(err|trustErr|r\.error|loadError)\}/g)) {
    assert.ok(src.slice(Math.max(0, m.index! - 90), m.index!).includes('endSentence('), `an interpolated error is not wrapped: ${m[0]}`);
  }
});

test('titles are plain words: no backticks, decisions are always "ADR NNNN: title", GitHub Actions keeps its capitals', () => {
  assert.equal(cleanTitle('`depsSha256` hashes **content**, see [x](http://a.b)'), 'depsSha256 hashes content, see x');
  assert.equal(displayTitle({ path: 'docs/adr/0004-dependency-hash.md', category: 'decisions', title: 'ADR 0004 — `depsSha256` hashes dependency content' }), 'ADR 0004: depsSha256 hashes dependency content');
  assert.equal(displayTitle({ path: 'docs/adr/0011-derive-trust.md', category: 'decisions', title: '0011 — Derive trust from the source' }), 'ADR 0011: Derive trust from the source');
  assert.equal(displayTitle({ path: 'docs/adr/0013-no-number.md', category: 'decisions', title: 'House rules you can switch' }), 'ADR 0013: House rules you can switch');
  assert.equal(displayTitle({ path: 'docs/adr/0012-x.md', category: 'decisions', title: 'ADR 0012: already right' }), 'ADR 0012: already right');
  assert.equal(displayTitle({ path: 'docs/ARCHITECTURE.md', category: 'built', title: 'Architecture of `Legion`' }), 'Architecture of Legion', 'only decisions get the prefix');
  assert.equal(displayTitle({ path: 'skills/ci-github/harden-github-actions/SKILL.md', category: 'skills', title: 'x' }), 'Harden GitHub Actions');
  assert.equal(matches({ title: '`x`', path: 'docs/adr/0004-a.md', category: 'decisions' }, 'adr 0004'), true, 'search sees the prefixed title');
});

test('the dialog drops a first heading that repeats its own title, and only then', () => {
  assert.equal(dropLeadingTitle('# Fix red CI\n\nBody.', 'Fix red CI'), 'Body.');
  assert.equal(dropLeadingTitle('# Systematic Debugging\n\nBody.', 'Systematic debugging'), 'Body.', 'case and punctuation do not matter');
  assert.equal(dropLeadingTitle('# Something else\n\nBody.', 'Fix red CI'), '# Something else\n\nBody.');
  assert.equal(dropLeadingTitle('Intro\n\n# Fix red CI', 'Fix red CI'), 'Intro\n\n# Fix red CI', 'only a first line');
  assert.equal(dropLeadingTitle('## Fix red CI\n\nBody', 'Fix red CI'), '## Fix red CI\n\nBody', 'only an H1');
});

test('search also matches group names, counts matches, and the bulk actions step aside while it runs', () => {
  const many = [...layer(), ...Array.from({ length: 6 }, (_, i) => f(`context/n${i}.md`, { category: 'facts' }))];
  const decrees = buildView(many, 'decrees');
  assert.deepEqual(decrees.map((g) => g.info.category), ['decisions'], '"Decrees" finds the decisions by their group name');
  assert.equal(matchCount(decrees), 1);
  assert.equal(matchCount(buildView(many, 'lore')), 6 + 1, 'a group name brings its whole group');
  const sub = buildView(many, 'review');
  assert.deepEqual(sub[0]!.skillGroups.map((g) => g.key), ['review'], 'a skill group matches by its title and summary');
  assert.deepEqual(buildView(many, 'ci github').flatMap((g) => g.skillGroups.map((x) => x.key)), ['ci-github']);
  assert.deepEqual(buildView(many, 'default'), [], 'the "· on by default" tail is not searched');
  assert.equal(matchCount(buildView(many)), listedCount(many), 'no query: every listed row');
  assert.equal(plural(3, 'match'), '3 matches');
  assert.equal(plural(1, 'match'), '1 match');
  assert.match(src, /\$\{plural\(count, 'match'\)\} for “/);
  assert.match(src, /hasBulk = !g\.locked && !searching/, 'no group-level bulk action while filtering');
  assert.match(src, /\{forced \? null : \(\s*<div className="house-sgtools">/, 'nor in a sub-group');
  assert.match(src, /Clear search<\/button>/);
  assert.match(src, /placeholder=\{'Search by title, file name or description…'\}/, 'the placeholder ends with an ellipsis character');
  assert.match(css, /\.house-search input::placeholder \{ color: var\(--muted\); opacity: 1; \}/, 'themed, not the browser grey');
});

test('while searching a sub-group is shown open on purpose: the toggle is inert and says so', () => {
  assert.match(src, /aria-disabled=\{forced \|\| undefined\}/);
  assert.match(src, /onClick=\{\(\) => \{ if \(!forced\) onToggle\(\); \}\}/);
  assert.match(src, /\(showing matches\)/);
  assert.equal(skillGroupLabel({ title: 'Review', countLine: '0 of 1 on' }, true), 'Review, 0 of 1 on, showing matches');
  assert.equal(skillGroupLabel({ title: 'Review', countLine: '0 of 1 on' }), 'Review, 0 of 1 on');
});

test('a skill that is off is never described as read as the app\'s rules', () => {
  const off = trustBlurb({ trust: 'shipped', category: 'skills', on: false });
  assert.match(off, /^Off: agents are not shown this drill\./);
  assert.ok(!/rules/.test(off), off);
  assert.match(trustBlurb({ trust: 'shipped', category: 'skills', on: true }), /^On: agents can open this drill\./);
  assert.match(trustBlurb({ trust: 'untrusted', category: 'skills', on: false }), /^Off: .*material, not as instructions/);
  assert.match(trustBlurb({ trust: 'shipped', category: 'built' }), /Agents read it as the app’s own rules/, 'other files keep their sentence');
  assert.match(src, /trustBlurb\(\{ trust: r\.trust, category, on: skillFile\?\.on, group: \(skillFile \?\? file\)\?\.group \}\)/, 'the dialog passes the skill\'s state and group');
});

test('one bulk pattern: the visible words give the effect, the accessible name gives the group, all with an Undo and a reason when idle', () => {
  assert.equal(bulkLabel({ category: 'skills' }, 2), 'Turn off 2');
  assert.equal(bulkLabel({ group: 'review' }, 1), 'Turn off 1');
  assert.equal(bulkLabel({ category: 'built' }, 2), 'Turn 2 back on');
  // Two buttons that both turn off one skill must not sound alike: Drills and one of its sub-groups.
  const drills = bulkName({ category: 'skills' }, 1, 'Drills');
  const sub = bulkName({ group: 'ci-github' }, 1, 'CI and GitHub');
  assert.equal(drills, 'Turn off 1 drill in Drills');
  assert.equal(sub, 'Turn off 1 drill in CI and GitHub');
  assert.notEqual(drills, sub);
  assert.equal(bulkName({ category: 'built' }, 2, 'Foundations'), 'Turn 2 back on in Foundations');
  // WCAG 2.5.3: what the button shows is the start of what it is called.
  for (const [s, n, t] of [[{ category: 'skills' }, 2, 'Drills'], [{ group: 'review' }, 3, 'Review'], [{ category: 'built' }, 2, 'Foundations']] as const) {
    assert.ok(bulkName(s, n, t).startsWith(bulkLabel(s, n)), `label in name: ${bulkLabel(s, n)} / ${bulkName(s, n, t)}`);
  }
  assert.equal(bulkDone({ group: 'review' }, 1), 'Turned off 1 drill.');
  assert.equal(bulkDone({ category: 'history' }, 2), 'Turned 2 files back on.');
  assert.equal(bulkUndone({ category: 'skills' }, 2), 'Turned 2 drills back on.');
  assert.equal(bulkNothing({ category: 'skills' }), '', 'the skills header already says "0 of 4 on"');
  assert.equal(bulkNothing({ group: 'review' }), '');
  assert.equal(bulkNothing({ category: 'facts' }), 'Already at the defaults.');
  assert.ok(!/Reset to defaults|Turn all off/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'the label comes from one place, so Drills cannot show two names');
  assert.ok(!/<ResetButton|house-confirm|Confirm reset/.test(src), 'no confirm step is left');
  assert.match(src, /bulkNothing\(scope\)/, 'a short reason instead of a dead button');
  assert.ok(!/disabled=\{n === 0/.test(src), 'no disabled bulk button');
  assert.match(src, /aria-label=\{bulkName\(scope, n, title\)\}/, 'the button\'s name says what it will do and where');
  assert.match(src, /<BulkAction scope=\{\{ category: cat \}\} title=\{g\.info\.title\}/);
  assert.match(src, /<BulkAction scope=\{\{ group: sg\.key \}\} title=\{sg\.title\}/);
  assert.match(src, /undoBtn\.current\?\.focus\(\)/, 'focus goes to Undo after the change');
  assert.match(src, /\(btn\.current \?\? fallback\(\)\)\?\.focus\(\)/, 'and back to the button, or the group heading, when Undo goes');
  assert.match(src, /role="status" aria-live="polite" aria-atomic="true">\{notice\}/, 'one polite live region');
});

test('copy: no internal word "layer", a plain lead sentence, plural counts, one visible key to the tags', () => {
  const visible = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.ok(!/\blayer\b/i.test(visible), 'user copy says "layer"');
  for (const g of GROUPS) assert.ok(!/\blayer\b/i.test(`${g.title} ${g.hint} ${g.blurb}`));
  assert.ok(!/\blayer\b/i.test(`${TRUST_LEGEND} ${missingLine(['a.md'])} ${SKILLS_BANNER}`));
  assert.match(src, /Agents read these rules before they start work\. Drills are different:\s+an agent opens one only when its job calls for it\./);
  assert.ok(!/before they ask you something/.test(src));
  assert.match(src, /Reading your doctrine files/);
  assert.match(src, /No doctrine files yet\./);
  assert.equal(missingLine(['a.md']), '1 expected file is missing, so your doctrine is incomplete: a.md. This usually means a partial install. Reinstall or update Legion to restore them.');
  assert.match(missingLine(['a.md', 'b.md']), /^2 expected files are missing, /);
  assert.match(readFileSync(join(process.cwd(), 'src/shared/house-view.ts'), 'utf8'), /What Settings → Doctrine shows/, 'the file comment names the screen');
  assert.match(TRUST_LEGEND, /From Legion.*Approved by you.*Edited.*Not approved/);
  assert.match(TRUST_LEGEND, /“From Legion” means .*“Approved by you” means .*“Edited” and “Not approved” mean /, 'the tag names are quoted so the sentence reads');
  assert.match(src, /\{TRUST_LEGEND\}/);
  assert.ok(!/title=\{trustBlurb/.test(src) && !/title=\{LOCK_REASON/.test(src), 'trust meaning is not hover-only');
});

test('every control has its own name: Read it and Licence say which skill; licences are numbered, not named by file', () => {
  assert.match(src, /aria-label=\{`Read it: \$\{label\}`\}/);
  assert.match(src, /aria-label=\{`\$\{text\} for \$\{label\}`\}/);
  assert.match(src, /licenceLabels\(skill\.licences\.map/, 'licence buttons are named by licence, numbered only when two would be alike');
  assert.ok(!/split\('\/'\)\.pop\(\)\}\)`/.test(src), 'the licence button is not labelled by file name');
});

test('the dialog: focus starts on the text, it has the skill\'s switch, one Close, a full-sentence error with Try again', () => {
  assert.match(src, /tabIndex=\{0\} data-autofocus role="region"/);
  assert.match(src, /<pre ref=\{\(el\) => \{ readEl\.current = el; \}\} className="house-read" tabIndex=\{0\} data-autofocus/);
  assert.ok(!/<button[^>]*data-autofocus/.test(src), 'focus no longer starts on the Close button');
  assert.match(src, /skillFile \? <SwitchControl f=\{skillFile\}/, 'turn it on right after reading it');
  assert.match(src, /files\?\.find\(\(f\) => f\.path === file\.skill\)/, 'a licence or reference file offers its skill\'s switch');
  assert.ok(!/>Close<\/button>/.test(src), 'the header already has the one Close');
  assert.match(src, />Done<\/button>/);
  assert.match(src, /endSentence\(`Could not read this file: \$\{r\.error \?\? 'unknown error'\}`\)/);
  assert.match(src, /openHouseFile\(r\.path, r\.title\)\}>Try again/);
  assert.match(src, /<Markdown text=\{body\} headingOffset=\{2\} quietCode \/>/);
});

test('the dead-core and stale-list states say why and offer Try again', () => {
  assert.match(src, /Could not read your doctrine files: \$\{loadError\}/);
  assert.match(src, /This list may be out of date: \$\{loadError\}/);
  assert.equal((src.match(/<TryAgain loading=\{loading\} onRetry=\{retry\} \/>/g) ?? []).length, 2, 'load failure and stale list share one button');
  assert.match(src, /openHouseFile\(r\.path, r\.title\)\}>Try again/, 'and the unreadable file has its own');
  assert.match(src, /if \(loadError && !loaded\)/, 'nothing loaded: the error replaces the spinner');
  assert.match(src, /loadError && loaded/, 'something loaded: the list stays');
  assert.match(store, /set\(\{ loadError: msg\(e\)/);
  assert.match(store, /trustErrors: \{ \.\.\.state\.trustErrors, \[path\]: msg\(e\) \}/, 'approve errors are per row');
  assert.ok(!/set\(\{ error:/.test(store), 'no screen-wide error from an approval');
});

test('the switch keeps 3:1: the off track has a --muted outline, the on track is solid accent with an ink knob', () => {
  assert.match(css, /\.house-swtrack \{[^}]*border: 1px solid var\(--muted\);/);
  assert.match(css, /\.house-sw input:checked ~ \.house-swtrack \{ background: var\(--accent\); border-color: var\(--accent\); \}/);
  assert.match(css, /\.house-sw input:checked ~ \.house-swtrack i \{[^}]*background: var\(--accent-ink\);/);
  // Numeric check on the real tokens: the pairs that matter, in both themes.
  const tokens = readFileSync(join(process.cwd(), 'ui/src/styles/tokens.css'), 'utf8');
  const [dark, light] = [tokens.split(":root[data-theme='light']")[0]!, tokens.split(":root[data-theme='light']")[1]!];
  const tok = (block: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)![1]!;
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  for (const [name, block] of [['dark', dark], ['light', light]] as const) {
    assert.ok(ratio(tok(block, '--muted'), tok(block, '--surface-2')) >= 3, `${name}: off outline on the row`);
    assert.ok(ratio(tok(block, '--accent'), tok(block, '--surface-2')) >= 3, `${name}: on track on the row`);
    assert.ok(ratio(tok(block, '--accent-ink'), tok(block, '--accent')) >= 3, `${name}: knob on the on track`);
  }
});

test('Settings brings the selected tab into view in the narrow tab strip', () => {
  const settings = readFileSync(join(process.cwd(), 'ui/src/components/Settings.tsx'), 'utf8');
  assert.match(settings, /scrollIntoView\?\.\(\{ inline: 'nearest', block: 'nearest' \}\)/);
  assert.match(settings, /querySelector<HTMLElement>\('\.set-link\.sel'\)/);
  assert.match(settings, /<nav ref=\{navEl\} className="set-nav"/);
});

test('Markdown can draw real headings for the dialog and leaves chat as it was', () => {
  const md = readFileSync(join(process.cwd(), 'ui/src/components/Markdown.tsx'), 'utf8');
  assert.match(md, /headingOffset === undefined\) return <p key=\{bi\} className=\{`md-h md-h\$\{b\.level\}`\}>/, 'no option: styled paragraph, as in chat');
  assert.match(md, /Math\.min\(6, b\.level \+ headingOffset\)/);
});

/* ---- fix round 3 ---- */
test('a query of only spaces is no query: no match line, bulk actions and open state stay as they were', () => {
  assert.match(src, /const q = searchable \? query\.trim\(\) : '';/, 'everything downstream reads the trimmed query');
  assert.equal(buildView(layer(), '   \t ').length, 7);
  assert.equal(matchCount(buildView(layer(), '  ')), listedCount(layer()));
});

test('"licence", "license", a licence name and a licence file name all find the skills that have one', () => {
  const files = layer();
  const licPath = 'skills/review/requesting-code-review/LICENSE.md';
  const names = { [licPath]: 'MIT' };
  const keys = (q: string, n: Record<string, string> = {}): string[] =>
    buildView(files, q, n).flatMap((g) => g.skillGroups.flatMap((sg) => sg.skills.map((s) => s.file.title))).sort();
  const all = ['fix-red-ci', 'requesting-code-review', 'systematic-debugging', 'thing', 'verification-before-completion'];
  assert.deepEqual(keys('licence'), all, 'every skill here has a licence file');
  assert.deepEqual(keys('license'), all, 'both spellings');
  assert.deepEqual(keys('mit', names), ['requesting-code-review'], 'a name read from the licence text');
  assert.deepEqual(keys('mit'), [], 'unknown until read, never guessed');
  assert.deepEqual(keys('licence zzz'), [], 'every word still has to match');
  // a skill without a licence file is not found by the word
  const bare = [f('skills/g/x/SKILL.md', { category: 'skills', group: 'g', skill: 'skills/g/x/SKILL.md', title: 'x' })];
  assert.deepEqual(buildView(bare, 'licence'), []);
});

test('licence names come from the licence text; two licences never share a button name', () => {
  assert.equal(licenceNameFromText('Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/'), 'Apache-2.0');
  assert.equal(licenceNameFromText('MIT License\n\nCopyright (c) 2026 x'), 'MIT');
  assert.equal(licenceNameFromText('The MIT License\n\nCopyright'), 'MIT');
  assert.equal(licenceNameFromText('Permission is hereby granted, free of charge, to any person'), 'MIT');
  assert.equal(licenceNameFromText('Some custom terms.'), '');
  assert.deepEqual(licenceLabels(['Apache-2.0', 'MIT']), ['Licence (Apache-2.0)', 'Licence (MIT)']);
  assert.deepEqual(licenceLabels(['MIT', 'MIT']), ['Licence (MIT) 1', 'Licence (MIT) 2']);
  assert.deepEqual(licenceLabels(['', '']), ['Licence 1', 'Licence 2'], 'unknown: numbered, as before');
  assert.deepEqual(licenceLabels(['MIT', '']), ['Licence (MIT)', 'Licence 2']);
  assert.deepEqual(licenceLabels(['MIT']), ['Licence (MIT)']);
  assert.deepEqual(licenceLabels(['']), ['Licence'], 'a lone unknown licence is just "Licence"');
  // the real files: fix-red-ci ships Apache and MIT licences, and they must come out different
  const root = process.cwd();
  const names = ['LICENSE.md', 'LICENSE-baby-sit.md'].map((n) => licenceNameFromText(readFileSync(join(root, 'skills/ci-github/fix-red-ci', n), 'utf8')));
  assert.deepEqual(names, ['Apache-2.0', 'MIT']);
  assert.match(src, /openHouseFile\(l\.path, `\$\{text\}: \$\{label\}`\)/, 'the dialog is titled by the licence and the skill');
  assert.match(src, /loadLicenceNames\(licencePaths\)/);
});

test('the dialog shows the skill description under its title, and its switch says what it is for', () => {
  assert.match(src, /file\?\.description && file\.path === r\.path \? <p className="house-readdesc">\{file\.description\}<\/p>/);
  assert.ok(src.indexOf('house-readdesc') < src.indexOf('id={stateId}'), 'before the trust sentence');
  assert.match(src, /caption="Use this drill"/);
  assert.match(src, /aria-label=\{caption \? `\$\{caption\}: \$\{label\}` : label\}/, 'the visible words are in the name');
  assert.match(src, /\{caption \? <span className="house-swcap">\{caption\}<\/span> : null\}/);
});

test('copy: one verb for agents using files, and the dialog never says the skill name twice', () => {
  assert.equal(GROUPS.find((g) => g.category === 'skills')!.blurb, 'Step-by-step ways of working. An agent opens one only when its job calls for it.');
  assert.ok(!/\bloads? (?:one|this skill)\b/.test(`${GROUPS.map((g) => g.blurb).join(' ')} ${trustBlurb({ trust: 'shipped', category: 'skills', on: true })}`), 'no "load" for skills');
  assert.match(src, /skillName && !same\(skillName, r\.title\) \? skillName : ''/);
  assert.match(src, /On: agents can \$\{verb\} this\./);
});

test('a file name that opens the title is not said twice; the mono path goes when it equals the title', () => {
  assert.equal(displayTitle({ path: 'AGENTS.md', category: 'core', title: 'AGENTS.md — Working on Legion' }), 'Working on Legion');
  // the shipped headings are lower case after the dash ("AGENTS.md — working on Legion"); the stripped title still starts with a capital
  assert.equal(displayTitle({ path: 'AGENTS.md', category: 'core', title: 'AGENTS.md — working on Legion' }), 'Working on Legion');
  assert.equal(displayTitle({ path: 'CONTEXT.md', category: 'core', title: 'CONTEXT.md — the glossary' }), 'The glossary');
  assert.equal(displayTitle({ path: 'docs/TESTING.md', category: 'built', title: 'TESTING.md: How to test' }), 'How to test');
  assert.equal(displayTitle({ path: 'docs/X.md', category: 'built', title: 'Other title' }), 'Other title', 'only a leading file name goes');
  assert.equal(displayTitle({ path: 'AGENTS.md', category: 'core', title: 'AGENTS.md' }), 'AGENTS.md', 'nothing left to show: keep it');
  assert.equal(pathIsRedundant('AGENTS.md', 'AGENTS.md'), true);
  assert.equal(pathIsRedundant('docs/A.md', 'Architecture'), false);
  assert.equal(pathIsRedundant('docs/A.md', 'a.md'), false, 'the folder still says something');
  assert.match(src, /\{pathIsRedundant\(f\.path, label\) \? null : <span className="house-path"/);
  const md = readFileSync(join(process.cwd(), 'ui/src/components/Markdown.tsx'), 'utf8');
  assert.match(md, /\{lang \|\| \(quiet \? '' : 'text'\)\}/, 'chat keeps its "text" label; only the opt-in drops it');
  assert.match(md, /quiet=\{quietCode\}/);
});

test('the trust sentence is attached once per row, to the control the owner uses, and not to the li', () => {
  assert.ok(!/<li[^>]*aria-describedby/.test(src));
  assert.match(src, /const hasControl = approvable \|\| !f\.locked;/);
  assert.match(src, /<span id=\{descId\} className=\{hasControl \? undefined : 'sr-only'\} hidden=\{hasControl\}>/, 'hidden text still describes; a locked row has no control so it is read as text');
  assert.match(src, /aria-describedby=\{descId\} onClick=\{\(\) => \{ if \(busy \|\| disabled\) return; void setHouseTrust/);
  assert.match(src, /describedBy=\{approvable \? undefined : descId\}/, 'never on both Approve and the switch');
});

test('buttons that work stay mounted: aria-disabled and a busy label, never swapped for a span', () => {
  assert.match(src, /<button type="button" className=\{`btn sm\$\{f\.trust === 'adopted' \? '' : ' primary'\}`\} aria-disabled=\{busy \|\| disabled\} aria-busy=\{busy \|\| undefined\}/);
  assert.ok(!/busy \? <span className="house-busy"><span className="spin" \/> Saving/.test(src), 'Approve is not replaced by a Saving span');
  assert.ok(!/(?<!aria-)disabled=\{/.test(src), 'no disabled attribute on a control that holds focus while it works');
  assert.match(src, /aria-disabled=\{loading\} aria-busy=\{loading \|\| undefined\} onClick=\{\(\) => \{ if \(!loading\) onRetry\(\); \}\}/);
  assert.match(src, /\{loading \? <>Trying\{'…'\}<\/> : 'Try again'\}/, 'Trying… while it works');
  assert.match(src, /retried\.current && loaded && !loadError\) \{ retried\.current = false; heading\.current\?\.focus\(\)/, 'a recovered load focuses the heading');
  assert.equal((src.match(/<h3 ref=\{heading\} tabIndex=\{-1\}>/g) ?? []).length, 3, 'every state of the screen has the focus target');
  assert.match(css, /\.house-actions button\[aria-disabled='true'\][^{]*\{ opacity: \.6; cursor: progress; \}/);
});

test('Undo waits for the pointer and focus, stays on a failed try, says why, and focus never goes to the page', () => {
  assert.match(src, /onMouseEnter=\{\(\) => holdUndo\('hover'\)\} onMouseLeave=\{\(\) => releaseUndo\('hover'\)\}/);
  assert.match(src, /onFocus=\{\(\) => \{ undoFocused\.current = true; holdUndo\('focus'\); \}\}/);
  assert.match(src, /onBlur=\{\(e\) => \{ if \(e\.relatedTarget\) undoFocused\.current = false; releaseUndo\('focus'\); \}\}/);
  assert.match(src, /\{undo\.error \?\? undo\.message\}/, 'the reason replaces the message, with Try again at its end');
  assert.match(src, /aria-disabled=\{busy\} aria-busy=\{busy \|\| undefined\}/, 'the Undo button stays mounted while it works');
  assert.match(src, /if \(getHouse\(\)\.undo\) want\.current = null;/, 'a failed Undo does not leave a stale "give focus back"');
  assert.match(css, /\.house-undoerr \{ color: var\(--danger\); \}/);
});

test('the Undo slot keeps its footprint, and a skill group says nothing when there is nothing to turn off', () => {
  assert.match(css, /\.house-reset \{[^}]*min-width: min\(260px, 100%\);[^}]*min-height: 28px;/);
  assert.match(src, /busy \|\| nothing \? <span className="house-none">/, 'no text for skills at rest');
});

test('the dialog puts focus on the text once it is there, but not over a choice the owner already made', () => {
  assert.match(src, /if \(!status \|\| status === 'loading'\) return;/);
  assert.match(src, /const parked = !a \|\| a === document\.body \|\| !!a\.closest\('\.modal-head'\);\s*if \(!parked\) return;/);
  assert.match(src, /\(status === 'ready' \? readEl\.current : retryEl\.current\)\?\.focus\(\)/, 'text when read, Try again when it failed');
  assert.match(src, /\[status, r\?\.path\]\);/);
  assert.match(src, /<pre ref=\{\(el\) => \{ readEl\.current = el; \}\}/);
  assert.match(src, /<div ref=\{\(el\) => \{ readEl\.current = el; \}\} className="house-read house-readmd"/);
  assert.match(src, /<button ref=\{retryEl\} type="button"/);
});

test('Settings follows the selected tab when the strip is resized, one frame at a time, and cleans up', () => {
  const settings = readFileSync(join(process.cwd(), 'ui/src/components/Settings.tsx'), 'utf8');
  assert.match(settings, /new ResizeObserver\(\(\) => \{ cancelAnimationFrame\(raf\); raf = requestAnimationFrame\(show\); \}\)/);
  assert.match(settings, /ro\.observe\(el\);\s*return \(\) => \{ ro\.disconnect\(\); cancelAnimationFrame\(raf\); \};/);
  assert.match(settings, /typeof ResizeObserver === 'undefined'/, 'old engines simply skip it');
});
