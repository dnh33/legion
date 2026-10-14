/** GitHub area UI: the pure state mapping (design 5.4), the create form defaults, the copy rules, and source guards for the accessibility rules. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { GithubAreaView, GithubRepoRow } from '../src/shared/github-area.js';
import { areaState, chipTone, CREATE_DEFAULTS, createConfirmLine, createFailureText, createNameError, listRepos, writesOffText } from '../ui/src/github/areaState.js';

const DIR = join(process.cwd(), 'ui', 'src', 'github');
const files = readdirSync(DIR).filter((f) => /\.(tsx?|css)$/.test(f));
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
const ui = (p: string): string => readFileSync(join(process.cwd(), 'ui', 'src', p), 'utf8');

const row = (name: string, o: Partial<GithubRepoRow> = {}): GithubRepoRow => ({ fullName: `dnh33/${name}`, private: true, installedRead: true, installedWrite: false, ticked: false, htmlUrl: `https://github.com/dnh33/${name}`, installationSettingsUrl: 'https://github.com/settings/installations/1', ...o });
const out = { read: false, write: false, create: false };
const view = (o: Partial<GithubAreaView> = {}): GithubAreaView => ({
  registered: { read: true, write: true, create: false }, signedIn: { read: true, write: false, create: false }, login: 'dnh33',
  agentsEnabled: true, selection: 'selected', repos: [row('legion', { ticked: true }), row('notes')], truncated: false, ...o,
});

describe('areaState (design 5.4)', () => {
  it('app not registered', () => {
    const s = areaState(view({ registered: out, signedIn: out, repos: [] }));
    assert.equal(s.id, 'not-registered');
    assert.equal(s.text, 'GitHub sign-in is not available in this build yet.');
    assert.equal(s.action, undefined);
  });
  it('not connected, with the connect button', () => {
    const s = areaState(view({ signedIn: out, repos: [] }));
    assert.equal(s.id, 'not-connected');
    assert.equal(s.text, 'GitHub is not connected. Connect it to choose which repos Legion can use.');
    assert.deepEqual(s.action, { id: 'connect', label: 'Connect GitHub' });
  });
  it('signing in and loading win over the list', () => {
    assert.equal(areaState(view({ signedIn: out }), { signingIn: true }).id, 'signing-in');
    assert.equal(areaState(null).id, 'loading');
    assert.equal(areaState(view(), { loading: true }).id, 'loading');
  });
  it('connected but nothing installed', () => {
    const s = areaState(view({ repos: [] }));
    assert.equal(s.id, 'nothing-installed');
    assert.equal(s.action?.label, 'Choose repos at GitHub');
  });
  it('installed, none ticked, is a normal state', () => {
    const s = areaState(view({ repos: [row('a'), row('b')] }));
    assert.equal(s.id, 'none-ticked');
    assert.equal(s.tone, 'idle');
    assert.equal(s.text, 'No repo is turned on. Agents cannot see any repo until you turn one on.');
  });
  it('an install that covers every repo is amber', () => {
    const s = areaState(view({ selection: 'all' }));
    assert.equal(s.id, 'all-repos');
    assert.equal(s.tone, 'warn');
    assert.equal(s.action?.label, 'Change at GitHub');
  });
  it('sign-in ended', () => {
    const s = areaState(view({ problem: { kind: 'auth-expired' } }));
    assert.equal(s.id, 'auth-ended');
    assert.equal(s.text, 'Your GitHub sign-in ended. Sign in again.');
    assert.equal(s.action?.id, 'sign-in');
  });
  it('rate limited names the time, disables GitHub buttons and keeps the list', () => {
    const at = new Date(2026, 9, 15, 14, 32).toISOString();
    const s = areaState(view({ problem: { kind: 'rate-limited', resetAt: at } }));
    assert.equal(s.id, 'rate-limited');
    assert.equal(s.text, 'GitHub asks you to wait until 14:32.');
    assert.equal(s.disableGithubButtons, true);
    assert.equal(s.keepsList, true);
  });
  it('offline keeps the last list (Review Focus 3), never a blank panel or a raw error', () => {
    const s = areaState(view({ problem: { kind: 'network' } }));
    assert.equal(s.id, 'offline');
    assert.equal(s.text, 'Legion could not reach GitHub. Showing the last list.');
    assert.equal(s.keepsList, true);
    assert.deepEqual(s.action, { id: 'retry', label: 'Try again' });
    assert.ok(!/error|undefined|[{}]/i.test(s.text));
  });
  it('a problem with an empty list still says the problem, not "nothing installed"', () => {
    assert.equal(areaState(view({ repos: [], problem: { kind: 'network' } })).id, 'offline');
    assert.equal(areaState(view({ repos: [], problem: { kind: 'rate-limited', resetAt: new Date().toISOString() } })).id, 'rate-limited');
  });
  it('a healthy list is ready', () => {
    const s = areaState(view());
    assert.equal(s.id, 'ready');
    assert.equal(s.text, '');
  });
  it('writes off has its own words', () => {
    assert.equal(writesOffText(view()), 'Agents cannot write. Turn on writes to let chosen agents comment, open issues and pull requests, and re-run CI. Every write asks you first.');
    assert.equal(writesOffText(view({ signedIn: { read: true, write: true, create: false } })), null);
    assert.equal(writesOffText(view({ signedIn: out })), null);
  });
});

describe('chip dot', () => {
  it('grey when not connected, green when connected, amber when it needs attention', () => {
    assert.equal(chipTone(view({ signedIn: out, repos: [] })), 'idle');
    assert.equal(chipTone(null), 'idle');
    assert.equal(chipTone(view()), 'ok');
    assert.equal(chipTone(view({ problem: { kind: 'auth-expired' } })), 'warn');
    assert.equal(chipTone(view({ problem: { kind: 'rate-limited' } })), 'warn');
    assert.equal(chipTone(view({ problem: { kind: 'network' } })), 'warn');
    assert.equal(chipTone(view({ selection: 'all' })), 'warn');
  });
});

describe('create form', () => {
  it('defaults: private on, README off, tick off', () => {
    assert.deepEqual(CREATE_DEFAULTS, { private: true, readme: false, tick: false });
  });
  it('the confirm line repeats owner/name and the visibility', () => {
    assert.equal(createConfirmLine('dnh33', 'notes', true), 'This creates the private repo dnh33/notes on GitHub.');
    assert.equal(createConfirmLine('acme', 'site', false), 'This creates the public repo acme/site on GitHub. Anyone can see it.');
  });
  it('checks the name with the shared rule', () => {
    assert.equal(createNameError(''), 'Give the repo a name.');
    assert.equal(createNameError('my repo'), 'Use letters, numbers, dots, dashes and underscores.');
    assert.equal(createNameError('..'), 'Use letters, numbers, dots, dashes and underscores.');
    assert.equal(createNameError('ok-name_1.x'), null);
  });
  it('explains a failure in plain words, 422 as "That name is taken"', () => {
    assert.equal(createFailureText('name-taken'), 'That name is taken. Pick another one.');
    for (const k of ['name-taken', 'no-right', 'org-approval', 'network', 'rate-limited', 'unknown'] as const) assert.ok(createFailureText(k).length > 10);
  });
});

describe('repo list', () => {
  it('lists ticked repos first, filters by the search, and pages by 100', () => {
    const repos = [row('zeta'), row('alpha', { ticked: true }), row('mid')];
    assert.deepEqual(listRepos(repos, '', 100).rows.map((r) => r.fullName), ['dnh33/alpha', 'dnh33/mid', 'dnh33/zeta']);
    assert.deepEqual(listRepos(repos, 'ZE', 100).rows.map((r) => r.fullName), ['dnh33/zeta']);
    const many = Array.from({ length: 130 }, (_, i) => row(`r${String(i).padStart(3, '0')}`));
    const p = listRepos(many, '', 100);
    assert.equal(p.rows.length, 100);
    assert.equal(p.more, 30);
  });
});

describe('copy and source rules', () => {
  it('has no em dash (or en dash) in any file under ui/src/github', () => {
    for (const f of files) assert.ok(!/[—–]/.test(read(f)), `${f} has a dash`);
  });
  it('never says "this computer" or "this machine"', () => {
    for (const f of files) assert.ok(!/this (computer|machine)/i.test(read(f)), f);
  });
  it('no coloured side-stripe accents (border-left, border-inline-start or an inset shadow)', () => {
    for (const f of files.filter((x) => x.endsWith('.css'))) {
      assert.ok(!/border-(left|inline-start)\s*:\s*[2-4]px/.test(read(f)), `${f} has a side stripe`);
      assert.ok(!/box-shadow:\s*inset\s+[2-4]px\s+0\s+0/.test(read(f)), `${f} has an inset stripe`);
    }
  });
  it('the title-bar button has aria-expanded and the panel closes with Esc (the shared FloatPanel)', () => {
    assert.match(read('GithubChip.tsx'), /aria-expanded=\{open\}/);
    assert.match(read('GithubArea.tsx'), /<FloatPanel/);
    assert.match(read('GithubArea.tsx'), /onClose=\{closeGithub\}/);
    assert.match(ui('ci/FloatPanel.tsx'), /e\.key === 'Escape'/);
  });
  it('the mock sits behind one switch in the store', () => {
    assert.equal((read('githubStore.ts').match(/export const USE_MOCK\b/g) ?? []).length, 1);
  });
  it('is wired in with one line each', () => {
    assert.match(ui('components/TitleBar.tsx'), /<GithubChip \/>\s*\n\s*<CiChip \/>/);
    assert.match(ui('components/icons.tsx'), /github/);
    assert.match(ui('commands.ts'), /Open GitHub/);
    assert.match(ui('App.tsx'), /<GithubArea \/>/);
  });
});
