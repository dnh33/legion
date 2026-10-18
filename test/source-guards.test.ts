// test/source-guards.test.ts : review feedback that came back more than once, as checks (0.3.5 task 21, harness lessons 1a-1c).
// Each failure says what is wrong, why it matters and how to fix it. An allowlist entry always carries a reason; an entry that no longer matches fails too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentNameHits, borderLeftStripes, emDashesOutsideComments, outlineRings, swallowedCatches, unreadGates, walk } from './guard-scan.js';
import { GATES, gateShown } from '../src/shared/gates-registry.js';
import type { Hit } from './guard-scan.js';

const ROOT = process.cwd();
const read = (f: string): string => readFileSync(`${ROOT}/${f}`, 'utf8');
const files = (dir: string, ext: RegExp): string[] => walk(ROOT, dir, ext);

interface Allow { file: string; /** a part of the offending line; omitted = the whole file */ line?: string; why: string }

/** Hits that no allowlist entry covers, and entries that covered nothing. */
function judge(hits: Hit[], allow: Allow[]): { bad: Hit[]; stale: Allow[] } {
  const used = new Set<Allow>();
  const bad = hits.filter((h) => {
    const a = allow.find((e) => e.file === h.file && (e.line === undefined || h.text.includes(e.line)));
    if (a) used.add(a);
    return a === undefined;
  });
  return { bad, stale: allow.filter((e) => !used.has(e)) };
}
const list = (hs: Hit[]): string => hs.map((h) => `  ${h.file}:${h.line}  ${h.text.slice(0, 120)}`).join('\n');
function check(hits: Hit[], allow: Allow[], what: string, why: string, fix: string): void {
  for (const e of allow) assert.ok(e.why.trim().length > 8, `allowlist entry for ${e.file} needs a reason`);
  const { bad, stale } = judge(hits, allow);
  assert.equal(bad.length, 0, `${what}\n${list(bad)}\nWhy it matters: ${why}\nHow to fix: ${fix}`);
  assert.equal(stale.length, 0, `These allowlist entries match nothing any more; remove them:\n${stale.map((e) => `  ${e.file} ${e.line ?? ''}`).join('\n')}`);
}

// ---- 1a. swallowed errors in the screens the owner clicks through ----

const CATCH_DIRS = ['ui/src/gates', 'ui/src/providers', 'ui/src/welcome'];
const CATCH_UPDATE = /^(UpdatePanel|UpdateBadge|updatePanel|updateBadge|updateJourney)[^/]*\.tsx?$/;
const CATCH_ALLOW: Allow[] = [
  { file: 'ui/src/providers/providersStore.ts', line: 'POST', why: 'the daily model-list refresh is advisory: the saved lists stay, and a failure shows as the provider\'s own last error in the card' },
  { file: 'ui/src/components/UpdateBadge.tsx', line: 'keep the last state', why: 'ambient status poll: a failed poll keeps the last badge instead of flashing an error into the title bar (documented on useUpdateStatus)' },
  { file: 'ui/src/components/UpdateBadge.tsx', line: 'ack-updated', why: 'best-effort acknowledgement: the notice is already hidden locally; if the ack is lost the notice returns once, which is the safe side' },
];
function catchFiles(): string[] {
  const out = new Set<string>();
  for (const d of CATCH_DIRS) for (const f of files(d, /\.tsx?$/)) out.add(f);
  for (const f of files('ui/src', /\.tsx?$/)) if (CATCH_UPDATE.test(f.split('/').pop() ?? '')) out.add(f);
  return [...out].sort();
}

test('no catch hides a failure in gates, providers, welcome or the update panel', () => {
  const hits = catchFiles().flatMap((f) => swallowedCatches(f, read(f)));
  check(hits, CATCH_ALLOW, 'A catch with no visible result (empty block, comment-only block, or a promise catch that does nothing):',
    'the owner clicks, nothing happens, and nothing says why. A hidden failure looks like a working app.',
    'show the failure (a toast or an inline line in the owner\'s words), or, if it really is advisory, add the line to CATCH_ALLOW in test/source-guards.test.ts with a one-line reason.');
});
test('the catch scanner sees every shape it is meant to see (planted violations)', () => {
  const planted: Array<[string, number]> = [
    ['try { x(); } catch {}', 1], ['try { x(); } catch (e) { }', 1], ['try { x(); } catch { /* nothing */ }', 1], ['try { x(); } catch (e) {\n  // later\n}', 1],
    ['p.catch(() => {})', 1], ['p.catch(() => undefined)', 1], ['p.catch((e) => { /* ignore */ })', 1], ['p.catch(() => null)', 1], ['p.catch(async () => {})', 0],
    ['try { x(); } catch (e) { toast(String(e)); }', 0], ['p.catch((e) => show(e))', 0], ['p.catch(() => { setErr(true); })', 0],
  ];
  for (const [src, n] of planted) assert.equal(swallowedCatches('x.ts', src).length, n, src);
  assert.ok(catchFiles().length >= 15, 'the scan covers the gates, providers, welcome and update files');
  assert.ok(catchFiles().some((f) => f.endsWith('UpdatePanel.tsx')), 'the update panel is in the scan');
});

// ---- 1b. no other coding-agent product is named ----

const NAME_ALLOW: Allow[] = [
  { file: 'ui/src/providers/ProvidersSection.tsx', why: 'the providers page shows a "later" teaser card for a provider engine that Legion lists; it is a provider, pinned by test/providers-cards.test.ts' },
  { file: 'test/providers-cards.test.ts', why: 'asserts the provider teaser card above' },
  { file: 'test/providers-wording.test.ts', why: 'the over-claim word list names provider engines a card must not say "works with"' },
  { file: 'src/core/protected-paths.ts', why: 'the protected-paths list must name the config folders other tools keep in a project, to keep agents out of them' },
  { file: 'test/protected-paths.test.ts', why: 'asserts the protected config folders above' },
  { file: 'test/model-groups.test.ts', why: 'a model id from a model provider\'s catalog, used as sample data' },
  { file: 'test/away-copy.test.ts', why: 'a negative assertion: the away copy must not spell these words, so the words appear in the assertion' },
  { file: 'test/project-page-source.test.ts', why: 'a negative assertion: the project page source must not spell these words, so the words appear in the assertion' },
  { file: 'scripts/export-public.mjs', why: 'the public-export scrub removes a private local folder name from paths' },
  { file: 'test/export-scrub.test.ts', why: 'asserts the scrub above' },
];
test('no other coding-agent product is named in src, ui, test or scripts', () => {
  const all = ['src', 'ui/src', 'test', 'scripts'].flatMap((d) => files(d, /\.(tsx?|css|mjs|cjs|js)$/));
  const hits = all.flatMap((f) => agentNameHits(f, read(f)));
  check(hits, NAME_ALLOW, 'These lines name another coding-agent product:',
    'Legion is its own product. Naming others in code, comments, tests or copy reads as a comparison we do not make, and it leaks into the public repo.',
    'reword to say what the thing does ("another tool", "a program"). Only a file that must name a model or web search provider, or a negative assertion about these words, belongs in NAME_ALLOW with a reason.');
});
test('the name scanner sees planted names, and not its own feature name', () => {
  const enc = (s: string): string => Buffer.from(s, 'base64').toString();
  assert.equal(agentNameHits('x.ts', `// ${enc('SGVybWVz')} does it`).length, 1);
  assert.equal(agentNameHits('x.ts', `const a = '${enc('Q29kZXg=').toLowerCase()}.exe';`).length, 1);
  assert.equal(agentNameHits('x.ts', `<b>${enc('Q3Vyc29y')} rules</b>`).length, 1);
  assert.equal(agentNameHits('x.css', 'a { cursor: pointer; } const cursor = 1;').length, 0);
  assert.equal(agentNameHits('x.ts', `// Soul ${enc('Q29kZXg=')} v1`).length, 0);
});

// ---- 1c. the owner's UI rules ----

const UI_FILES = (): string[] => files('ui/src', /\.(css|tsx)$/);
// none: a search hit in a thread is marked with the accent tint, not a ring
const RING_ALLOW: Allow[] = [];
test('no outline ring in ui/src except the opt-in focus-ring setting and high contrast', () => {
  const hits = UI_FILES().flatMap((f) => outlineRings(f, read(f)));
  check(hits, RING_ALLOW, 'An outline with a value other than none or 0 outside the opt-in focus-ring rules:',
    'the owner wants no focus rings. Keyboard focus is shown by the hover tint. The ring setting is opt-in, so its rules carry [data-focus-rings].',
    'use the hover tint for focus. If the owner switched rings on for this control, put the selector under :root[data-kbd-nav][data-focus-rings].');
});
test('the outline scanner tells a ring from none and from the opt-in rule (planted)', () => {
  assert.equal(outlineRings('a.css', '.a:focus { outline: 2px solid red; }').length, 1);
  assert.equal(outlineRings('a.css', '.a:focus { outline: none; } .b { outline: 0; } .c { outline-offset: 2px; }').length, 0);
  assert.equal(outlineRings('a.css', ':root[data-focus-rings] .a:focus-visible { outline: 2px solid red; }').length, 0);
  assert.equal(outlineRings('a.css', ':root[data-focus-rings] .a, .b:focus { outline: 2px solid red; }').length, 1);
  assert.equal(outlineRings('a.css', '@media (forced-colors: active) { .a.on { outline: 2px solid Highlight; } }').length, 0);
  assert.equal(outlineRings('a.css', '/* a { tricky */ .a:focus { outline: 1px solid red; }').length, 1);
  assert.equal(outlineRings('A.tsx', "const s = { outline: '2px solid red' };").length, 1);
  assert.equal(outlineRings('A.tsx', "const s = { outline: 'none' };").length, 0);
});

const STRIPE_ALLOW: Allow[] = [
  { file: 'ui/src/rooms/rooms.css', line: '.rm-reply {', why: 'a neutral grey quote line beside the message a reply answers (var(--line-strong)), not an accent stripe. Kept: the owner rule is about coloured accents' },
  { file: 'ui/src/styles/app.css', line: '.msg.from-agent', why: 'a neutral grey thread line beside an agent message (var(--line-strong)), not an accent stripe. Kept: the owner rule is about coloured accents' },
];
test('no coloured or thick left-edge stripe in ui/src', () => {
  const hits = UI_FILES().flatMap((f) => borderLeftStripes(f, read(f)));
  check(hits, STRIPE_ALLOW, 'A border-left wider than 1px, or with a colour, on a card or row:',
    'the owner does not want side-stripe accents; they read as template decoration.',
    'drop the stripe. Use a 1px neutral border-left only as a divider between siblings, or mark the state with a label or a background tint.');
});
test('the stripe scanner tells a stripe from a divider (planted)', () => {
  assert.equal(borderLeftStripes('a.css', '.a { border-left: 3px solid var(--accent); }').length, 1);
  assert.equal(borderLeftStripes('a.css', '.a { border-left: 1px solid var(--accent); }').length, 1);
  assert.equal(borderLeftStripes('a.css', '.a { border-left: 2px solid var(--line); }').length, 1);
  assert.equal(borderLeftStripes('a.css', '.a + .a { border-left: 1px solid var(--control-line); }').length, 0);
  assert.equal(borderLeftStripes('a.css', '.a { border-left: 0; } .b { border-left-color: transparent; }').length, 0);
  assert.equal(borderLeftStripes('A.tsx', "const s = { borderLeft: '4px solid #f80' };").length, 1);
});

const DASH_ALLOW: Allow[] = [
  { file: 'src/shared/house-view.ts', line: '[—–:-]', why: 'a regular expression that reads titles written with a dash; it is parsing, not text shown to the owner' },
];
test('no em dash in text the owner reads (ui/src and src/shared)', () => {
  const all = [...files('ui/src', /\.(tsx?|css)$/), ...files('src/shared', /\.ts$/)];
  const hits = all.flatMap((f) => emDashesOutsideComments(f, read(f)));
  check(hits, DASH_ALLOW, 'An em dash (U+2014) outside a comment:',
    'house style for everything the owner reads: no em dashes. They mark text as machine-written.',
    'use a full stop, a comma, a colon or a new sentence. If the dash is inside a pattern that parses text, add the line to DASH_ALLOW with a reason.');
});
test('the em dash scanner skips comments and finds strings (planted)', () => {
  const dash = '—';
  assert.equal(emDashesOutsideComments('a.ts', `const s = 'a ${dash} b';`).length, 1);
  assert.equal(emDashesOutsideComments('a.tsx', `<p>one ${dash} two</p>`).length, 1);
  assert.equal(emDashesOutsideComments('a.ts', `// one ${dash} two\nconst a = 1;`).length, 0);
  assert.equal(emDashesOutsideComments('a.ts', `/* one ${dash} two\n   three ${dash} four */\nconst a = 1;`).length, 0);
  assert.equal(emDashesOutsideComments('a.ts', `const u = 'http://x'; const s = '${dash}';`).length, 1);
});

// ---- every switch on the Gates page acts ----

/** Fails, naming each gate, when a switch the page shows has no reader. */
function requireGateReaders(ids: readonly string[], sources: ReadonlyArray<{ file: string; text: string }>): void {
  const dead = unreadGates(ids, sources);
  assert.deepEqual(dead, [], `A switch on the Gates page that nothing reads: ${dead.join(', ')}\n`
    + 'Why it matters: the owner turns it off and nothing changes, so the page lies about what is protected.\n'
    + 'How to fix: read the gate where the thing it guards happens (gate(id, projectAtStart) in the core, or gateOffFor in the window) and add a test that turns it off. '
    + "If the feature is not built yet, mark the gate ships: 'goals' in src/shared/gates-registry.ts so the page hides it.");
}
const GATE_READER_FILES = [...files('src', /\.ts$/), ...files('ui/src', /\.tsx?$/)].filter((f) => f !== 'src/shared/gates-registry.ts');
test('every switch the Gates page shows has a reader outside the registry', () => {
  const switches = GATES.filter((g) => g.family !== 'rail' && gateShown(g)).map((g) => g.id);
  assert.ok(switches.length >= 14, 'the page shows its switches');
  requireGateReaders(switches, GATE_READER_FILES.map((f) => ({ file: f, text: read(f) })));
});
test('a gate nothing reads fails the guard with what, why and how (planted)', () => {
  const sources = [{ file: 'a.ts', text: "if (gate('tool-cards')) run(); // 'ghost-gate' is only named in a comment\n/* 'ghost-gate' */" }];
  requireGateReaders(['tool-cards'], sources);
  assert.deepEqual(unreadGates(['tool-cards', 'ghost-gate'], sources), ['ghost-gate']);
  assert.throws(() => requireGateReaders(['tool-cards', 'ghost-gate'], sources), (e: unknown) => {
    const m = (e as Error).message;
    return /ghost-gate/.test(m) && /Why it matters/.test(m) && /How to fix/.test(m) && !/tool-cards,/.test(m);
  });
});
