/**
 * The last UI fix round of 0.3.5: the findings of the re-shoot (two side effects of the first fix round, and a few small ones).
 * Each test names the finding it guards. Layout rules were measured in the real app; here the pieces with logic or a pinned design are held.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeholderName } from '../ui/src/chat/draft.js';
import { dropErrorEcho } from '../ui/src/chat/errorEcho.js';
import { TRUSTED_AFTER_LINE, TRUSTED_CHANGED_AFTER_LINE, TRUSTED_LEAD, cardTrust } from '../ui/src/gates/trustLogic.js';
import type { TrustedRow } from '../ui/src/gates/trustLogic.js';
import { settingsUnreachableLine } from '../ui/src/components/settingsNav.js';
import { listWords } from '../ui/src/welcome/presetChoiceLogic.js';
import { pendingStatus } from '../ui/src/providers/webSearchModel.js';
import { PLAN_CHECK_FAILED_TEXT, explainClaudeError } from '../src/shared/claude-errors.js';
import type { ChatMessage } from '../src/shared/types.js';
import { repoRoot } from './ps-helpers.js';

const src = (p: string): string => readFileSync(join(repoRoot, p), 'utf8').replace(/\r\n/g, '\n');
const rule = (css: string, sel: string): string => new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

// ---------------------------------------------------------------- 1: the new-task composer at UI scale 1.5

test('1: the composer bar stays on one row (send never drops to a third row); the key hint drops out whole when it does not fit, and the room composer keeps its own wrapping', () => {
  const css = src('ui/src/styles/app.css');
  assert.doesNotMatch(rule(css, '.composer-bar'), /flex-wrap/, 'no wrap in the bar');
  assert.doesNotMatch(rule(css, '.composer-hint'), /flex:\s*none/, 'the base hint rule is as before the first fix round');
  // the slot takes the spare room; the hint wraps to a clipped second line when it does not fit (never half a word)
  assert.match(css, /\.composer-bar \.hint-slot \{[^}]*flex: 1 1 0[^}]*min-width: 0[^}]*overflow: hidden[^}]*flex-wrap: wrap/);
  assert.match(css, /\.composer-bar \.hint-slot \.composer-hint \{[^}]*flex: none/);
  assert.match(css, /\.composer-bar \.target-pill \{[^}]*flex: 0 1 auto[^}]*min-width: 0/, 'the project pill gives way before the send button');
  assert.match(css, /\.rm-composer-wrap \.composer-bar \{ flex-wrap: wrap/, 'the room composer was fixed by the wrap and keeps it');
  assert.match(css, /\.composer-bar \.send \{ flex: none; \}/, 'send is never squeezed');
  const tsx = src('ui/src/components/Composer.tsx');
  assert.match(tsx, /<span className="hint-slot"><span className="hint-strut" aria-hidden="true" \/><span className="composer-hint">/);
  assert.doesNotMatch(tsx, /className="spacer"/, 'the slot is the spacer: a second grower would share the room with it');
});
test('1: the new-task placeholder cuts a long agent name at 24 characters so it stays on one line', () => {
  const long = 'Long-Running Quarterly Release Readiness Reviewer Agent Two';
  assert.equal(placeholderName(long), 'Long-Running Quarterly R\u2026');
  assert.equal(placeholderName('Marshal'), 'Marshal');
  assert.equal(placeholderName('x'.repeat(24)), 'x'.repeat(24), 'a name of exactly 24 is whole');
  assert.equal(placeholderName(undefined), 'Legion');
  assert.equal(placeholderName('Ab cdefghijklmnopqrstu v'), 'Ab cdefghijklmnopqrstu v');
  assert.match(src('ui/src/components/Composer.tsx'), /`Ask \$\{placeholderName\(agent\?\.name\)\} to do something`/);
});

// ---------------------------------------------------------------- 2: the project settings menu at 960

test('2: the menu row shows that it scrolls with an arrow on the side that has more, and the legend sits outside the scrolling row', () => {
  const css = src('ui/src/projects/page/settings.css');
  const narrow = /@container pg \(max-width: 760px\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
  assert.match(narrow, /\.pg-snavw \{[^}]*display: flex/, 'the menu and the legend sit side by side');
  assert.match(narrow, /\.pg-snavs \{[^}]*min-width: 0/);
  assert.match(narrow, /\.pg-snav \{[^}]*overflow-x: auto/);
  assert.doesNotMatch(narrow, /mask-image/, 'no fade as the only sign');
  assert.match(narrow, /\.pg-snav-more \{[^}]*position: absolute/);
  assert.match(narrow, /\.pg-snavw \.leg \{[^}]*flex: none/);
  const tsx = src('ui/src/projects/page/SettingsTab.tsx');
  const nav = /<nav className="pg-snav"[\s\S]*?<\/nav>/.exec(tsx)?.[0] ?? '';
  assert.ok(nav && !nav.includes('className="leg"'), 'the legend is not inside the scrolling nav');
  assert.match(tsx, /<span className="leg"><i aria-hidden="true" \/>Changed from the default<\/span>/);
  assert.match(tsx, /edge\.end && <button[^>]*className="pg-snav-more end"/);
  assert.match(tsx, /edge\.start && <button[^>]*className="pg-snav-more start"/);
});

// ---------------------------------------------------------------- 3 and 4: the folder-trust card in a reopened thread

const msgLines = ['Hook SessionStart in .claude/settings.json runs: node setup.js', 'Environment variables set by .claude/settings.json: TOKEN (values are not shown)'];
const card = { folder: 'D:\\bots\\qa-trust-repo', lines: msgLines, more: 0 };
const row = (over: Partial<TrustedRow> = {}): TrustedRow => ({ folder: 'D:\\bots\\qa-trust-repo', current: true, summary: [...msgLines], more: 0, ...over });

test('3: a folder trusted now with the commands the card names reads as trusted', () => {
  assert.equal(cardTrust(card, [row()]), 'trusted');
  assert.equal(cardTrust(card, [row({ folder: 'd:/bots/qa-trust-repo/' })]), 'trusted', 'the same folder written another way');
});
test('3: not on the list, or on it but its commands changed since it was trusted, stays held back with Trust', () => {
  assert.equal(cardTrust(card, []), 'held');
  assert.equal(cardTrust(card, null), 'held', 'the list could not be read');
  assert.equal(cardTrust(card, [row({ folder: 'D:\\bots\\other' })]), 'held');
  assert.equal(cardTrust(card, [row({ current: false })]), 'held', 'trusted earlier, changed since');
});
test('3: trusted now but the folder holds other commands than the card names: trusted, never Trust again, and the card says it', () => {
  assert.equal(cardTrust(card, [row({ summary: ['Hook Stop in .claude/settings.json runs: node other.js'] })]), 'trusted-differs');
  assert.equal(cardTrust(card, [row({ more: 2 })]), 'trusted-differs');
  const long = 'Helper command apiKeyHelper in .claude/settings.json runs: ' + 'x'.repeat(400);
  const cut = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}\u2026` : s);
  assert.equal(cardTrust({ ...card, lines: [long] }, [row({ summary: [cut(long)] })]), 'trusted', 'the list route cuts a long line at 300, the card keeps it whole');
});
test('3: the card reads the list from the core, offers Trust only while held back, and says what applies from when', () => {
  const s = src('ui/src/components/FolderTrustCard.tsx');
  assert.match(s, /request<TrustedRow\[\]>\('GET', '\/api\/gates\/trusted-folders'\)/);
  assert.match(s, /\{!trusted && <button type="button" className="btn sm"/, 'no Trust button once trusted');
  assert.match(s, /known === 'checking'/, 'no Trust click while the list is being read');
  assert.equal(TRUSTED_AFTER_LINE, 'Trusted. It applies from the next run.');
  assert.match(TRUSTED_CHANGED_AFTER_LINE, /^Trusted with what it holds now\./);
});
test('4: once trusted, the hook list keeps a plain lead-in line (the card\'s first line only ends in "What was held back:" while it is held back)', () => {
  assert.match(TRUSTED_LEAD, /:$/);
  const s = src('ui/src/components/FolderTrustCard.tsx');
  assert.match(s, /\{trusted && <p className="ft-lead">\{differs \? TRUSTED_CHANGED_LEAD : TRUSTED_LEAD\}<\/p>\}/);
  assert.ok(s.indexOf('ft-lead') < s.indexOf('<ul className="ft-lines">'), 'the lead-in is above the list');
});

// ---------------------------------------------------------------- 5: the Doctor is a button in the title bar

test('5: no text sends the owner to a Help menu; the Doctor is named as the title bar button', () => {
  assert.ok(!PLAN_CHECK_FAILED_TEXT.includes('Help'));
  assert.match(PLAN_CHECK_FAILED_TEXT, /open the Doctor button in the title bar\.$/);
  for (const auth of ['claude-login', 'api-key'] as const) for (const allow of [false, true]) {
    const t = explainClaudeError('Credit balance is too low', auth, allow)!;
    assert.ok(!/Help ->|Help, Doctor/.test(t), t);
  }
  assert.match(explainClaudeError('Credit balance is too low', 'claude-login')!, /The Doctor button in the title bar shows which login Legion uses\./);
  assert.match(src('ui/src/components/TitleBar.tsx'), /<Icon name="pulse" size=\{14\} \/> Doctor/, 'the button is really there, under that name');
});
const m = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ id, role, text, ts: 1 } as unknown as ChatMessage);
test('5: while the failure card shows, the history line that says the same is left out; an older failure or another line is not', () => {
  const err = 'This run did not start: Legion could not confirm it. Try again.';
  const list = [m('1', 'user', 'hi'), m('2', 'system', `Error: ${err}`)];
  assert.deepEqual(dropErrorEcho(list, err).map((x) => x.id), ['1']);
  assert.deepEqual(dropErrorEcho(list, undefined).map((x) => x.id), ['1', '2'], 'no card, the line stays');
  assert.deepEqual(dropErrorEcho(list, 'something else').map((x) => x.id), ['1', '2'], 'other words stay');
  const old = [m('1', 'system', `Error: ${err}`), m('2', 'user', 'again'), m('3', 'system', 'Cancelled')];
  assert.deepEqual(dropErrorEcho(old, err).map((x) => x.id), ['1', '2', '3'], 'the last system line is not the echo: nothing is dropped');
  const credits = 'Claude Code is billing this run to API credits.\n\nClaude said: Credit balance is too low';
  assert.deepEqual(dropErrorEcho([m('1', 'system', 'Error: Claude Code is billing this run to API credits.')], credits), []);
  assert.match(src('ui/src/components/Thread.tsx'), /group\(dropErrorEcho\(messages, failedText\)\)/);
});

// ---------------------------------------------------------------- 6: offline, Settings and Gates

test('6: Settings that cannot load say so and name the next step, the same sentence as every other offline line', () => {
  const api = src('ui/src/api.ts');
  const step = /export const CORE_NEXT_STEP = '([^']+)';/.exec(api)?.[1] ?? '';
  assert.equal(settingsUnreachableLine('gates', step), 'Legion core is not reachable, so Gates cannot load. If it stopped, use Restart core in the tray menu, or restart Legion.');
  assert.match(settingsUnreachableLine('claude', step), /^Legion core is not reachable, so this page cannot load\./);
  const s = src('ui/src/components/Settings.tsx');
  assert.match(s, /!settings \? \(settingsFail \|\| conn === 'offline'/, 'the spinner is only for a load in progress');
  assert.match(s, /settingsUnreachableLine\(section, CORE_NEXT_STEP\)/);
  assert.match(s, /onClick=\{\(\) => void loadSettings\(\)\}>Try again/);
  const store = src('ui/src/store.ts');
  assert.match(store, /settingsFail: \{ kind: e instanceof ApiError && e\.status === 0 \? 'offline' : 'other'/);
  assert.match(store, /if \(!getState\(\)\.settings && getState\(\)\.settingsOpen\) void loadSettings\(\)/, 'it loads by itself when the core is back');
});

// ---------------------------------------------------------------- 7: plural

test('7: "and 1 other", then "others"', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `Agent${i}`, approval: 'ask' as const, approvalSource: 'own' as const }));
  assert.match(listWords(mk(4), 'bypass', true).warn ?? '', /^This makes Agent0, Agent1, Agent2 and 1 other ask less than now\./);
  assert.match(listWords(mk(5), 'bypass', true).warn ?? '', /^This makes Agent0, Agent1, Agent2 and 2 others ask less than now\./);
  assert.match(listWords(mk(5), 'bypass', false).lines[0] ?? '', /^Agent0 and 4 others ask first$/);
  assert.match(listWords(mk(2), 'bypass', false).lines[0] ?? '', /^Agent0 and Agent1 ask first$/);
});

// ---------------------------------------------------------------- 8: no orphan in the follow label

test('8: the first-run follow label balances its lines so no word sits alone', () => {
  assert.match(src('ui/src/welcome/preset-choice.css'), /\.preset-follow > span \{[^}]*text-wrap: pretty/);
});

// ---------------------------------------------------------------- 9: one apostrophe style on the Gates page

test('9: the Gates text uses the straight apostrophe everywhere (the rail rows, the empty line and the rails note were curly)', () => {
  for (const f of ['src/shared/gates-registry.ts', 'ui/src/gates/RailsList.tsx', 'ui/src/gates/gatesLogic.ts']) {
    const lines = src(f).split('\n').filter((l) => /[A-Za-z]\u2019[a-z]|[a-z]\u2019 /.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    assert.deepEqual(lines, [], `${f}: curly apostrophes in text`);
  }
});

// ---------------------------------------------------------------- 10: web search, the select and the notice agree

test('10: while a paid provider waits for Use, the select keeps showing what is in use and the notice says so', () => {
  const v = { search: 'builtin' as const, read: 'builtin' as const, providers: [{ id: 'treg' as const, label: 'treg', canSearch: true, canRead: true, needsKey: true, ready: true }, { id: 'exa' as const, label: 'Exa', canSearch: true, canRead: true, needsKey: true, ready: true }] };
  const pending = { name: 'treg', enableLabel: 'Use treg', body: { search: 'treg' } };
  assert.equal(pendingStatus(v, pending), 'Search is still on Built-in. treg is picked but not in use until you choose "Use treg".');
  assert.equal(pendingStatus({ ...v, read: 'exa' as const }, { name: 'treg', enableLabel: 'Use treg', body: { read: 'treg' } }), 'Page reading is still on Exa. treg is picked but not in use until you choose "Use treg".');
  assert.equal(pendingStatus(v, { name: 'treg', enableLabel: 'Use treg', body: { tregMaxCostUsd: 1 } }), undefined, 'a cap change is not a pick');
  const s = src('ui/src/providers/WebSearchSection.tsx');
  assert.match(s, /<select value=\{v\[job\]\}/, 'the select is the provider in use, not the pick');
  assert.match(s, /pendingStatus\(v, pending\)/);
});
