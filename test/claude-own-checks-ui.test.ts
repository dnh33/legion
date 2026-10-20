// test/claude-own-checks-ui.test.ts: the window side of "Claude agents follow Claude's own permission checks" (0.3.6, slice B): the switch and its help on the
// Gates page, what each preset means for a Claude agent, the one-time notice, the first-run sentence, the run chip and the Allow-rules line.
// Pure logic checked directly; each screen is drawn through esbuild + react-dom/server (store and bridge stubbed), as in welcome-preset.test.ts.
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import {
  ALLOW_RULES_LINE, CHECKER_CHIP, CHECKER_FALLBACK_LINE, CLAUDE_CHECKS_LABEL, CLAUDE_CHECKS_LINE, CLAUDE_CHECKS_OFF_LINE, CLAUDE_NOTICE, CLAUDE_PRESET_LINES,
  FIRST_RUN_CLAUDE_LINE, LEARN_LESS, LEARN_MORE, LEARN_MORE_GROUPS, OTHER_PROVIDERS_LINE,
} from '../src/shared/claude-checks-copy.js';
import { PRESETS } from '../src/shared/gates-registry.js';
import { PRESET_STRINGS, presetSubmit, skipSubmit } from '../ui/src/welcome/presetChoiceLogic.js';
import { KEYSTORE_LINE } from '../ui/src/gates/presetsLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';
import { checkerFallbackNow, claudeChecksOn, hasClaudeAgents, shouldShowClaudeNotice } from '../ui/src/gates/claudeChecksLogic.js';
import { runChips } from '../ui/src/gates/agentFollowLogic.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const view = (app: Partial<GatesView['app']> = {}, o: Partial<GatesView> = {}): GatesView => ({ app: { version: 1, ...app }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...o });
const agent = (id: string, model = 'auto', seed = false) => ({ id, name: id, approval: 'ask' as const, approvalSource: 'own' as const, model, ...(seed ? { seedApproval: true as const } : {}) });
const KEY = makeSigner(Buffer.alloc(32, 7))!;
const dir = () => join(cleanupTemp('legion-claude-ui-'), 'gates');
const plain = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ---------------------------------------------------------------- the saved flag

test('the store keeps claudeNoticeSeen on the app file only, only true, and it is not a loosening', async () => {
  const folder = dir();
  const s = new GatesStore(folder, { allowed: ['ask'], signer: KEY });
  assert.equal(s.preview('app', { claudeNoticeSeen: true }).loosens, false);
  assert.deepEqual(s.patchApp({ claudeNoticeSeen: true }), { version: 1, claudeNoticeSeen: true });
  for (const bad of [false, 'yes', 1, null]) assert.throws(() => s.patchApp({ claudeNoticeSeen: bad }), (e: unknown) => e instanceof GatesError && e.status === 400, String(bad));
  assert.throws(() => s.patchProject('proj_000000000001', { claudeNoticeSeen: true }), (e: unknown) => e instanceof GatesError && e.status === 400);
  await s.flush();
  // read back from disk (signed with the rest)
  const again = new GatesStore(folder, { allowed: ['ask'], signer: KEY });
  assert.equal(again.app().claudeNoticeSeen, true);
});

test('the first-run screen counts as having shown the notice: Continue and Decide later both write it', () => {
  for (const id of PRESETS) assert.deepEqual(presetSubmit(id).patch, { preset: id, firstRunChoice: true, claudeNoticeSeen: true }, id);
  assert.deepEqual(skipSubmit().patch, { firstRunChoice: true, claudeNoticeSeen: true });
});

// ---------------------------------------------------------------- logic

test('the switch reads on unless the app file says false', () => {
  assert.equal(claudeChecksOn(view()), true);
  assert.equal(claudeChecksOn(view({ claudeOwnChecks: true })), true);
  assert.equal(claudeChecksOn(view({ claudeOwnChecks: false })), false);
});

test('Claude agents are the ones not on a provider model', () => {
  assert.equal(hasClaudeAgents([agent('a'), agent('b', 'openrouter:x/y')]), true);
  assert.equal(hasClaudeAgents([agent('b', 'deepseek:chat'), agent('c', 'openrouter:x/y')]), false);
  assert.equal(hasClaudeAgents([agent('a', 'arn:aws:bedrock:eu-west-1:1:model/x')]), true, 'an AWS id is Claude');
  assert.equal(hasClaudeAgents([]), false);
});

test('the one-time notice: an installed app with Claude agents and the switch on, until dismissed', () => {
  const used = [{ ...agent('a'), approval: 'full' as const }, agent('b')]; // not all untouched seeds: an install that was already in use
  assert.equal(shouldShowClaudeNotice(view(), used), true);
  assert.equal(shouldShowClaudeNotice(view({ preset: 'smart' }), used), true, 'a preset in use');
  assert.equal(shouldShowClaudeNotice(view({ firstRunChoice: true, preset: 'ask' }), used), true, 'answered the first-run screen in an earlier version');
  assert.equal(shouldShowClaudeNotice(view({ claudeNoticeSeen: true }), used), false, 'dismissed: never again');
  assert.equal(shouldShowClaudeNotice(view({ claudeOwnChecks: false }), used), false, 'the owner already turned it off: nothing changed for them');
  assert.equal(shouldShowClaudeNotice(view(), [agent('a', 'deepseek:chat')]), false, 'no Claude agent: nothing changed');
  assert.equal(shouldShowClaudeNotice(view(), []), false, 'the roster has not arrived');
  // a fresh install is about to see the first-run screen, which carries the sentence instead
  assert.equal(shouldShowClaudeNotice(view(), [agent('a', 'auto', true), agent('b', 'auto', true)]), false, 'fresh install, first-run screen pending');
});

test('the fallback is known from the newest task that reports a checker', () => {
  const t = (id: string, at: string, claudeChecker?: 'on' | 'fallback') => ({ id, updatedAt: at, ...(claudeChecker ? { claudeChecker } : {}) });
  assert.equal(checkerFallbackNow([]), false);
  assert.equal(checkerFallbackNow([t('1', '2026-10-20T10:00:00Z')]), false);
  assert.equal(checkerFallbackNow([t('1', '2026-10-20T10:00:00Z', 'fallback')]), true);
  assert.equal(checkerFallbackNow([t('1', '2026-10-20T10:00:00Z', 'fallback'), t('2', '2026-10-20T11:00:00Z', 'on')]), false, 'a later run with the checker clears it');
  assert.equal(checkerFallbackNow([t('1', '2026-10-20T12:00:00Z'), t('2', '2026-10-20T11:00:00Z', 'fallback')]), true, 'a task that reports nothing does not clear it');
});

test('the run chip says the checker is off, once, with the full line as its hover', () => {
  const ra = { mode: 'smart' as const };
  const on = runChips({ runsAs: ra, claudeChecker: 'on' } as never, agent('a') as never, [], null);
  assert.equal(on.checker, undefined);
  const none = runChips({ runsAs: ra } as never, agent('a') as never, [], null);
  assert.equal(none.checker, undefined);
  const off = runChips({ runsAs: ra, claudeChecker: 'fallback' } as never, agent('a') as never, [], null);
  assert.deepEqual(off.checker, { text: CHECKER_CHIP, title: CHECKER_FALLBACK_LINE });
});

test('the words: every line is plain, with no em dash and no "this computer"', () => {
  const all = [
    CHECKER_FALLBACK_LINE, CHECKER_CHIP, CLAUDE_CHECKS_LABEL, CLAUDE_CHECKS_LINE, OTHER_PROVIDERS_LINE, CLAUDE_CHECKS_OFF_LINE, ALLOW_RULES_LINE, FIRST_RUN_CLAUDE_LINE,
    ...Object.values(CLAUDE_PRESET_LINES), ...Object.values(CLAUDE_NOTICE), ...LEARN_MORE_GROUPS.flatMap((g) => [g.title, ...g.lines]),
  ].join('\n');
  assert.doesNotMatch(all, /—|–/);
  assert.doesNotMatch(all, /this (computer|machine)/i);
  assert.equal(CHECKER_FALLBACK_LINE, "Claude's checker is not available for this model, so Claude asks you as in Ask.");
  assert.equal(CLAUDE_CHECKS_LABEL, "Claude agents follow Claude's own permission checks");
  assert.equal(OTHER_PROVIDERS_LINE, "Other providers (OpenRouter, DeepSeek, custom) use Legion's own checks.");
  assert.deepEqual(Object.keys(CLAUDE_PRESET_LINES).sort(), [...PRESETS].sort(), 'a line for every preset');
  assert.equal(CLAUDE_PRESET_LINES.smart, "Claude's own checker decides. Anything it is unsure about comes to you.");
  assert.match(LEARN_MORE_GROUPS.flatMap((g) => g.lines).join(' '), /not a security boundary/);
});

// ---------------------------------------------------------------- real render

type Render = Record<string, (...args: any[]) => string>;
async function loadUi(): Promise<{ r: Render; cleanup: () => void }> {
  const ui = (p: string) => JSON.stringify(join(REPO, p));
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { ClaudeChecksCardView, ClaudeNoticeView, AllowRulesNote } from ${ui('ui/src/gates/ClaudeChecks.tsx')};
        import { GatesPresets } from ${ui('ui/src/gates/GatesPresets.tsx')};
        import { PresetChoiceView } from ${ui('ui/src/welcome/PresetChoice.tsx')};
        import { RunChips } from ${ui('ui/src/gates/RunChips.tsx')};
        const no = () => {};
        export const card = (p) => renderToStaticMarkup(createElement(ClaudeChecksCardView, { onToggle: no, ...p }));
        export const notice = (p) => renderToStaticMarkup(createElement(ClaudeNoticeView, { onOpen: no, onDismiss: no, ...p }));
        export const allow = (p) => renderToStaticMarkup(createElement(AllowRulesNote, p));
        export const presets = (p) => renderToStaticMarkup(createElement(GatesPresets, { setScope: no, projects: [], agents: [], busy: false, note: null, run: async () => true, scope: 'app', ...p }));
        export const first = (p) => renderToStaticMarkup(createElement(PresetChoiceView, { follow: false, busy: false, note: null, selected: 'ask', agents: [], onPick: no, onFollow: no, onContinue: no, onLater: no, ...p }));
        export const chips = (p) => renderToStaticMarkup(createElement(RunChips, p));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        b.onResolve({ filter: /\/store$/ }, () => ({ path: 'app-store', namespace: 'stub' }));
        b.onLoad({ filter: /^app-store$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `export const toast = () => {}; export const useStore = () => []; export const openSettings = () => {};` }));
        b.onResolve({ filter: /useGatesView$/ }, () => ({ path: 'use-gates-view', namespace: 'stub' }));
        b.onLoad({ filter: /^use-gates-view$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export const useGatesView = () => ({ view: null, loadError: null, reload: async () => {}, apply: async () => ({ state: 'ok' }) });
          export const useGatesAction = () => ({ pending: false, note: null, run: async () => true });
          export const reloadGatesFromDisk = async () => {}; export const PENDING_TEXT = 'Waiting for you to confirm in the window';` }));
      },
    }],
  });
  const d = cleanupTemp('claude-own-checks-ui-');
  const file = join(d, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  return { r: createRequire(file)(file) as Render, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

const switchOn = /role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/;
const switchOff = /role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/;

test('render: the switch is on, says what it means, names where it does not apply, and keeps the details behind Learn more', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const html = r.card({ view: view(), busy: false, note: null, fallback: false });
    const text = plain(html);
    assert.ok(text.includes(CLAUDE_CHECKS_LABEL));
    assert.match(html, switchOn, 'on');
    assert.ok(text.includes(CLAUDE_CHECKS_LINE));
    assert.ok(text.includes(OTHER_PROVIDERS_LINE));
    assert.ok(text.includes(LEARN_MORE));
    assert.match(html, /aria-expanded="false"/);
    assert.ok(!text.includes(LEARN_MORE_GROUPS[0]!.lines[0]!), 'the help is closed until asked for');
    assert.ok(!text.includes(CHECKER_FALLBACK_LINE));
    const open = plain(r.card({ view: view(), busy: false, note: null, fallback: false, defaultOpen: true }));
    assert.ok(open.includes(LEARN_LESS));
    for (const g of LEARN_MORE_GROUPS) { assert.ok(open.includes(g.title), g.title); for (const l of g.lines) assert.ok(open.includes(l), l); }
    for (const p of PRESETS) assert.ok(open.includes(CLAUDE_PRESET_LINES[p]), `the help lists what Claude does in ${p}`);
  } finally { cleanup(); }
});

test('render: off is unticked and says what off means; turning it on needs a signing key, turning it off does not', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const off = r.card({ view: view({ claudeOwnChecks: false }), busy: false, note: null, fallback: true });
    assert.doesNotMatch(off, /role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/);
    assert.ok(plain(off).includes(CLAUDE_CHECKS_OFF_LINE));
    assert.ok(!plain(off).includes(CHECKER_FALLBACK_LINE), 'the checker is not used while the switch is off, so there is nothing to report');
    const noKeyOff = r.card({ view: view({ claudeOwnChecks: false }, { canSign: false }), busy: false, note: null, fallback: false });
    assert.match(noKeyOff, switchOff, 'on needs the key');
    assert.ok(plain(noKeyOff).includes(KEYSTORE_LINE));
    const noKeyOn = r.card({ view: view({}, { canSign: false }), busy: false, note: null, fallback: false });
    assert.doesNotMatch(noKeyOn, switchOff, 'off is always allowed');
    const busy = r.card({ view: view(), busy: true, note: null, fallback: false });
    assert.match(busy, switchOff);
  } finally { cleanup(); }
});

test('render: the fallback line shows once on the card while the switch is on, and a failed change shows its message', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const html = r.card({ view: view(), busy: false, note: { tone: 'error', text: 'The change was not made.' }, fallback: true });
    assert.equal(plain(html).split(CHECKER_FALLBACK_LINE).length - 1, 1, 'once');
    assert.match(html, /role="alert"/);
    assert.ok(plain(html).includes('The change was not made.'));
  } finally { cleanup(); }
});

test('render: the presets say what Claude does in each one while the switch is on, and nothing about Claude while it is off', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const on = plain(r.presets({ view: view() }));
    for (const p of PRESETS) assert.ok(on.includes(CLAUDE_PRESET_LINES[p]), p);
    assert.equal(on.split('Claude agents:').length - 1, 4, 'one line per preset');
    const off = plain(r.presets({ view: view({ claudeOwnChecks: false }) }));
    for (const p of PRESETS) assert.ok(!off.includes(CLAUDE_PRESET_LINES[p]), `${p} off`);
    // a project scope shows them too: the switch is one setting for the whole app
    const proj = plain(r.presets({ view: view({}, { projects: { proj_000000000001: { version: 1 } } }), scope: 'proj_000000000001', projects: [{ id: 'proj_000000000001', name: 'Shop', members: [] }] }));
    assert.ok(proj.includes(CLAUDE_PRESET_LINES.smart));
  } finally { cleanup(); }
});

test('render: the notice says what changed, that it is on, and where to turn it off, with two buttons', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const html = r.notice({ busy: false, note: null });
    const text = plain(html);
    assert.ok(text.includes(CLAUDE_NOTICE.text));
    assert.match(text, /It is on\./);
    assert.match(text, /Settings, Gates/);
    assert.equal((html.match(/<button/g) ?? []).length, 2);
    assert.ok(text.includes(CLAUDE_NOTICE.open) && text.includes(CLAUDE_NOTICE.dismiss));
    assert.match(html, /role="status"/);
    const bad = r.notice({ busy: false, note: { tone: 'error', text: 'Could not save.' } });
    assert.match(bad, /role="alert"/);
  } finally { cleanup(); }
});

test('render: the first-run screen carries the one sentence for Claude agents', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const html = plain(r.first({ view: view() }));
    assert.ok(html.includes(FIRST_RUN_CLAUDE_LINE));
    assert.ok(html.includes(PRESET_STRINGS.title));
    assert.equal(html.split(FIRST_RUN_CLAUDE_LINE).length - 1, 1);
  } finally { cleanup(); }
});

test('render: the Allow rules line for Claude agents shows only while the switch is on', async () => {
  const { r, cleanup } = await loadUi();
  try {
    assert.ok(plain(r.allow({ on: true })).includes(ALLOW_RULES_LINE));
    assert.equal(r.allow({ on: false }), '');
  } finally { cleanup(); }
});

test('render: the run chip for a run without Claude\'s checker, with the full line for screen readers and on hover', async () => {
  const { r, cleanup } = await loadUi();
  try {
    const task = { runsAs: { mode: 'smart' }, claudeChecker: 'fallback' };
    const html = r.chips({ task, agent: agent('a'), projects: [], view: view() });
    assert.ok(plain(html).includes(CHECKER_CHIP));
    assert.ok(html.includes(`title="${CHECKER_FALLBACK_LINE.replace(/'/g, '&#x27;')}"`), 'the hover is the whole line');
    assert.ok(plain(html).includes(CHECKER_FALLBACK_LINE), 'and so is the screen-reader text');
    const fine = r.chips({ task: { runsAs: { mode: 'smart' }, claudeChecker: 'on' }, agent: agent('a'), projects: [], view: view() });
    assert.ok(!plain(fine).includes(CHECKER_CHIP));
  } finally { cleanup(); }
});
