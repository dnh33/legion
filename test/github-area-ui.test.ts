/** GitHub area UI: the pure state mapping (design 5.4), the create form defaults, the copy rules, and source guards for the accessibility rules. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { GithubAreaView, GithubRepoRow } from '../src/shared/github-area.js';
import { activityFrom, parseCreateReply, parseOrgs, parseProjectsUsing, parseWriteFlow, plainError } from "../ui/src/github/githubRoutes.js";
import { activityVerb, areaState, chipTone, CREATE_DEFAULTS, createConfirmLine, createFailureKind, createFailureText, createNameError, createOwner, listRepos, writesOffText } from '../ui/src/github/areaState.js';

const DIR = join(process.cwd(), 'ui', 'src', 'github');
const files = readdirSync(DIR).filter((f) => /\.(tsx?|css)$/.test(f));
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
const ui = (p: string): string => readFileSync(join(process.cwd(), 'ui', 'src', p), 'utf8');

const row = (name: string, o: Partial<GithubRepoRow> = {}): GithubRepoRow => ({ fullName: `dnh33/${name}`, private: true, installedRead: true, installedWrite: false, ticked: false, htmlUrl: `https://github.com/dnh33/${name}`, installationSettingsUrl: 'https://github.com/settings/installations/1', ...o });
const out = { read: false, write: false };
const view = (o: Partial<GithubAreaView> = {}): GithubAreaView => ({
  registered: { read: true, write: true }, signedIn: { read: true, write: false }, login: 'dnh33',
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
    assert.equal(s.action?.label, 'Install at GitHub');
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
    assert.equal(writesOffText(view({ signedIn: { read: true, write: true } })), null);
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
  it('is wired in with one line each', () => {
    assert.match(ui('components/TitleBar.tsx'), /<GithubChip \/>\s*\n\s*<CiChip \/>/);
    assert.match(ui('components/icons.tsx'), /github/);
    assert.match(ui('commands.ts'), /Open GitHub/);
    assert.match(ui('App.tsx'), /<GithubArea \/>/);
  });
});

describe('real route shapes (githubRoutes)', () => {
  const agents = [{ id: 'a1', name: 'Builder' }];
  it('maps an area activity item to a row with the agent name (mutation: showing the agent id)', () => {
    const [x] = activityFrom([{ at: '2026-10-14T10:00:00Z', agentId: 'a1', repo: 'dnh33/legion', kind: 'pull-request', title: '#9 Add it' }], agents);
    assert.equal(x!.agent, 'Builder');
    assert.equal(x!.title, '#9 Add it');
  });
  it('an unknown agent id reads "An agent", never the raw id (mutation: raw id)', () => {
    assert.equal(activityFrom([{ at: '2026-10-14T10:00:00Z', agentId: 'gone', repo: 'a/b', kind: 'comment' }], agents)[0]!.agent, 'An agent');
  });
  it('an item without a link gets no url, so the row is not a fake link (mutation: inventing a url)', () => {
    assert.equal(activityFrom([{ at: '2026-10-14T10:00:00Z', agentId: 'a1', repo: 'a/b', kind: 'rerun' }], agents)[0]!.url, undefined);
  });
  it('parses projects-using as { projects: [{ id, name, level }] } (mutation: expecting a bare array)', () => {
    assert.deepEqual(parseProjectsUsing({ projects: [{ id: 'p1', name: 'Legion', level: 'write' }] }), [{ id: 'p1', name: 'Legion', level: 'write' }]);
    assert.throws(() => parseProjectsUsing([{ id: 'p1' }]), /could not read/);
    assert.throws(() => parseProjectsUsing({ projects: [{ id: 'p1', name: 'x', level: 'admin' }] }), /could not read/);
  });
  it('parses the create answer, both phases (mutation: treating needs-write as done)', () => {
    assert.deepEqual(parseCreateReply({ phase: 'done', fullName: 'a/b', htmlUrl: 'https://github.com/a/b', ticked: true }), { phase: 'done', fullName: 'a/b', htmlUrl: 'https://github.com/a/b', ticked: true });
    assert.deepEqual(parseCreateReply({ phase: 'needs-write', message: 'Connect writes first' }), { phase: 'needs-write', message: 'Connect writes first' });
    assert.throws(() => parseCreateReply({ phase: 'done' }), /could not read/);
    assert.throws(() => parseCreateReply(null), /could not read/);
  });
  it('parses orgs as { orgs: [{ login }] } (mutation: expecting strings)', () => {
    assert.deepEqual(parseOrgs({ orgs: [{ login: 'acme' }, { nope: 1 }] }), ['acme']);
    assert.throws(() => parseOrgs('x'), /could not read/);
  });
  it('parses the write sign-in answer: pending, failed, idle (mutation: ignoring failed)', () => {
    assert.deepEqual(parseWriteFlow({ phase: 'pending', userCode: 'AB-12', verificationUri: 'https://github.com/login/device', expiresAt: 5 }), { phase: 'pending', userCode: 'AB-12', verificationUri: 'https://github.com/login/device', expiresAt: 5 });
    assert.deepEqual(parseWriteFlow({ phase: 'failed', reason: 'denied', message: 'No.' }), { phase: 'failed', message: 'No.' });
    assert.deepEqual(parseWriteFlow({ phase: 'idle' }), { phase: 'idle' });
  });
  it('turns the core\'s code words into plain text (mutation: showing "not-installed")', () => {
    assert.match(plainError(404, 'not-installed'), /not installed/i);
    assert.match(plainError(409, 'too-many-ticked'), /too many/i);
    assert.match(plainError(409, 'not-available'), /not available/i);
    assert.match(plainError(409, 'needs-key'), /key/i);
    assert.match(plainError(0, 'Cannot reach Legion core'), /did not answer/);
    assert.equal(plainError(409, 'Turn this repo on in the GitHub area first.'), 'Turn this repo on in the GitHub area first.');
    assert.ok(!/[a-z]+-[a-z]+/.test(plainError(500, 'internal-error')) || plainError(500, 'internal-error').includes(' '));
  });
  it('create failures: 401, 409, 502 and a missing route each get their own words (mutation: 502 says nothing was created)', () => {
    assert.equal(createFailureKind(401, 'Sign in to Legion (write) again.'), 'sign-in');
    assert.equal(createFailureKind(409, 'A create is already running.'), 'busy');
    assert.equal(createFailureKind(502, 'Could not reach GitHub. Check your repositories before you try again.'), 'unsure');
    assert.equal(createFailureKind(404, 'Not found'), 'unavailable');
    assert.equal(createFailureKind(404, 'GitHub did not find that.'), 'no-right');
    assert.ok(!/nothing was created/i.test(createFailureText('unsure')));
    assert.match(createFailureText('unsure'), /check/i);
  });
  it('a first load that failed is an error with Try again, not "not connected" (mutation: falling to not-connected)', () => {
    const s = areaState(null, { failed: 'Legion\'s core did not answer.' });
    assert.equal(s.id, 'load-failed');
    assert.equal(s.action?.id, 'retry');
    assert.match(s.text, /did not answer/);
  });
  it('activity wording without a title stays grammatical', () => {
    assert.equal(activityVerb('pull-request', false), 'opened a pull request');
    assert.equal(activityVerb('pull-request'), 'opened the pull request');
  });
  it('the mock is gone from the store, the api and the folder', () => {
    assert.ok(!/USE_MOCK|githubMock|mockApprove/.test(read('githubStore.ts')));
    assert.ok(!files.includes('githubMock.ts'));
    assert.ok(!/USE_MOCK/.test(ui('api.ts')));
  });
});

describe('fix round: review findings', () => {
  it('chipTone: signed in for reading with a not-connected problem is grey, not green', () => {
    assert.equal(chipTone(view({ problem: { kind: 'not-connected' } })), 'idle');
  });
  it('create failures: 403 for an organisation to approve, plain 403, and 429', () => {
    assert.equal(createFailureKind(403, 'Resource protected by organization SAML enforcement.'), 'org-approval');
    assert.equal(createFailureKind(403, 'The organization has enabled OAuth App access restrictions, ask an owner to approve.'), 'org-approval');
    assert.equal(createFailureKind(403, 'Forbidden'), 'no-right');
    assert.equal(createFailureKind(429, 'slow down'), 'rate-limited');
    assert.match(createFailureText('org-approval'), /organisation must approve Legion/);
    assert.match(createFailureText('rate-limited'), /wait a little/);
  });
  it('after a read sign-in ended, Sign in starts the flow and shows the code panel (the core still says signed in)', () => {
    const ended = view({ problem: { kind: 'auth-expired' } });
    assert.equal(areaState(ended).id, 'auth-ended');
    assert.equal(areaState(ended, { signingIn: true }).id, 'signing-in');
  });
  it('the owner of a new repo is only sent when one was picked (no login yet means the personal account)', () => {
    assert.equal(createOwner(''), undefined);
    assert.equal(createOwner('acme'), 'acme');
    assert.equal(createConfirmLine('', 'notes', true), 'This creates the private repo notes in your own account on GitHub.');
  });
  it('one verb pair for writes: Turn on writes / Turn off writes, never "Connect Legion (write)"', () => {
    const area = read('GithubArea.tsx');
    assert.ok(!/Connect Legion \(write\)/.test(area));
    assert.match(area, />Turn off writes</);
    assert.match(area, /Turn on writes</);
    assert.ok(!/Connect it again/.test(createFailureText('sign-in')));
    assert.match(createFailureText('sign-in'), /Turn on writes again/);
  });
  it('every link to GitHub goes through openAtGithub: the panel never calls openExternal itself', () => {
    assert.ok(!/openExternal/.test(read('GithubArea.tsx')));
    assert.match(read('GithubArea.tsx'), /openAtGithub/);
  });
  it('the turn-off line points to GitHub through the helper', () => {
    assert.match(read('GithubArea.tsx'), /To remove it completely, /);
    assert.match(read('GithubArea.tsx'), /remove Legion \(write\) at GitHub/);
  });
});

it('the GitHub button for "nothing installed" opens the App install page (installations/new), never settings/installations (mutation: fall back to settings/installations)', async () => {
  const { githubActionUrl, areaState: st } = await import('../ui/src/github/areaState.js');
  const { githubInstallUrl, GITHUB_APP_SLUGS } = await import('../src/core/connectors/github/hosts.js');
  const empty = { registered: { read: true, write: true }, signedIn: { read: true, write: false }, agentsEnabled: true, selection: 'unknown', repos: [], truncated: false } as never;
  assert.equal(githubActionUrl(empty), githubInstallUrl(GITHUB_APP_SLUGS.read));
  assert.match(st(empty).text, /Install Legion \(read\)/);
  const one = { ...(empty as object), selection: 'all', repos: [{ fullName: 'a/b', private: true, installedRead: true, installedWrite: false, ticked: false, htmlUrl: 'https://github.com/a/b', installationSettingsUrl: 'https://github.com/settings/installations/7' }] } as never;
  assert.equal(githubActionUrl(one), 'https://github.com/settings/installations/7');
});
