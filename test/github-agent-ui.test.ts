/** Task 8: the per-agent GitHub choice (None / Read / Read and write), its tag, and the project buttons that act only on that project's members. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { accessPatch, githubTag, grantCopy, planProjectGrant, tickedRepoNames, WRITE_NOTE } from '../ui/src/github/agentAccess.js';
import { agentGithubLevel } from '../src/shared/github-area.js';

const area = (repos: Array<{ fullName: string; ticked: boolean }>) => ({ repos });

test('the editor choice: none clears everything, read sets connectors and clears githubWrite', () => {
  assert.deepEqual(accessPatch('none', ['a/b']), { connectors: [], githubWrite: [] });
  assert.deepEqual(accessPatch('read', ['a/b']), { connectors: ['github'], githubWrite: [] });
  assert.deepEqual(accessPatch('write', ['a/b', 'c/d']), { connectors: ['github'], githubWrite: ['a/b', 'c/d'] });
  assert.equal(agentGithubLevel(accessPatch('read', ['a/b'])), 'read');
});

test('write checklist offers ticked repos only, and the note is the spec text', () => {
  assert.deepEqual(tickedRepoNames(area([{ fullName: 'a/one', ticked: true }, { fullName: 'a/two', ticked: false }])), ['a/one']);
  assert.equal(WRITE_NOTE, 'Every write asks you first, even with Full access.');
});

test('tag text', () => {
  assert.equal(githubTag({}), null);
  assert.equal(githubTag({ connectors: ['github'] }), 'GitHub: read');
  assert.equal(githubTag({ connectors: ['github'], githubWrite: ['a/b'] }), 'GitHub: write, 1 repo');
  assert.equal(githubTag({ connectors: ['github'], githubWrite: ['a/b', 'c/d'] }), 'GitHub: write, 2 repos');
  assert.equal(githubTag({ githubWrite: ['a/b'] }), null, 'a stale write list without the connector is level none');
});

const agents = [
  { id: 'a1', connectors: [] as string[] },
  { id: 'a2', connectors: ['github'] },
  { id: 'a3', connectors: ['github'], githubWrite: ['x/y'] },
  { id: 'outsider', connectors: [] as string[] },
];

test('project read button: only members, only those who change, never lowers', () => {
  const plan = planProjectGrant('read', 'Dnh33/Legion.git', ['a1', 'a2', 'a3'], agents);
  assert.deepEqual(plan.changes.map((c) => c.id), ['a1']);
  assert.deepEqual(plan.changes[0]!.patch, { connectors: ['github'] });
  assert.equal(plan.changes.some((c) => c.id === 'outsider'), false);
});

test('project write button: members become writers for this repo, existing repos kept, no duplicates in different case', () => {
  const plan = planProjectGrant('write', 'Dnh33/Legion', ['a1', 'a2', 'a3'], agents);
  assert.deepEqual(plan.changes.map((c) => c.id), ['a1', 'a2', 'a3']);
  assert.deepEqual(plan.changes[2]!.patch.githubWrite, ['x/y', 'dnh33/legion']);
  const again = planProjectGrant('write', 'dnh33/legion.git', ['a3'], [{ id: 'a3', connectors: ['github'], githubWrite: ['Dnh33/Legion'] }]);
  assert.equal(again.changes.length, 0);
});

test('confirm copy names how many agents change, and says nothing changes when none do', () => {
  assert.equal(grantCopy('read', 'a/b', 1).confirm, 'Let 1 agent read a/b?');
  assert.equal(grantCopy('write', 'a/b', 3).confirm, 'Let 3 agents write to a/b? Every write still asks you first.');
  assert.equal(grantCopy('read', 'a/b', 0).confirm, null);
  assert.doesNotMatch(JSON.stringify([grantCopy('read', 'a/b', 2), grantCopy('write', 'a/b', 2)]), /—|this computer/);
});

// ---- review fixes: the area states, the project's own repo, one access call, the 100-repo cap
import { accessRefusal, GITHUB_WRITE_MAX, unticked } from '../ui/src/github/agentAccess.js';
import { areaNotice, areaStateOf, projectRepoNotice } from '../ui/src/github/areaState.js';
import type { GithubAreaView } from '../src/shared/github-area.js';

const view = (o: Partial<GithubAreaView> = {}): GithubAreaView => ({ registered: { read: true, write: true }, signedIn: { read: true, write: true }, agentsEnabled: true, selection: 'selected', repos: [{ fullName: 'a/one', private: false, installedRead: true, installedWrite: true, ticked: true, htmlUrl: '', installationSettingsUrl: '' }], truncated: false, ...o });

test('area states: loading and error are never read as an empty list', () => {
  assert.equal(areaNotice({ status: 'loading', view: null }, true)?.kind, 'loading');
  assert.equal(areaNotice({ status: 'loading', view: null }, true)?.text, 'Loading repositories\u2026');
  const e = areaNotice({ status: 'error', view: null }, true)!;
  assert.deepEqual([e.kind, e.retry], ['error', true]);
  assert.equal(e.text, 'Legion could not reach GitHub.');
});

test('area states: not connected, write sign-in missing, and a plain ok list', () => {
  const nc = areaNotice(areaStateOf(view({ signedIn: { read: false, write: false }, problem: { kind: 'not-connected' } })), true)!;
  assert.deepEqual([nc.kind, nc.text, nc.settings], ['not-connected', 'GitHub is not connected.', true]);
  const w = areaNotice(areaStateOf(view({ signedIn: { read: true, write: false } })), true)!;
  assert.deepEqual([w.kind, w.text.startsWith('Write sign-in not done'), w.settings], ['write-signin', true, true]);
  assert.equal(areaNotice(areaStateOf(view({ signedIn: { read: true, write: false } })), false), null, 'only the write choice cares about the write sign-in');
  assert.equal(areaNotice(areaStateOf(view()), true), null);
  assert.equal(areaNotice(areaStateOf(view({ problem: { kind: 'network' } })), true)?.kind, 'error');
  assert.equal(areaNotice(areaStateOf(view({ problem: { kind: 'auth-expired' } })), true)?.settings, true);
});

test('saved write repos are flagged "not ticked" only when the list really loaded', () => {
  const saved = ['a/one', 'b/gone'];
  assert.deepEqual(unticked({ status: 'ok', view: view() }, saved), ['b/gone']);
  assert.deepEqual(unticked({ status: 'loading', view: null }, saved), []);
  assert.deepEqual(unticked({ status: 'error', view: null }, saved), []);
  assert.deepEqual(unticked(areaStateOf(view({ problem: { kind: 'network' } })), saved), [], 'a failed refresh proves nothing');
});

test('the project line says why there is nothing to do instead of showing a buttonless dead end', () => {
  assert.match(projectRepoNotice({ repo: null, ticked: false }).text, /no GitHub repository/);
  assert.equal(projectRepoNotice({ repo: null, ticked: false }).offer, false);
  assert.equal(projectRepoNotice({ repo: 'a/b', ticked: false }).offer, true);
  assert.match(projectRepoNotice({ repo: 'a/b', ticked: false }).text, /not turned on in Legion/);
  assert.match(projectRepoNotice({ repo: 'a/b', ticked: true }).text, /turned on in Legion/);
});

test('access refusals are plain words, no raw codes', () => {
  assert.equal(accessRefusal(409, 'Turn this repo on in the GitHub area first.'), 'Turn this repo on in the GitHub area first.');
  assert.match(accessRefusal(409, 'This project has no GitHub repository. Set its git remote first.'), /no GitHub repository/);
  assert.match(accessRefusal(409, 'too-many-ticked'), /Too many repositories are turned on/);
  assert.match(accessRefusal(0, 'Cannot reach Legion core'), /Try again/);
  assert.match(accessRefusal(500, 'boom'), /Legion could not save that/);
  assert.doesNotMatch(accessRefusal(409, 'too-many-ticked'), /too-many-ticked|—/);
});

test('the write list stops at the server limit', () => {
  assert.equal(GITHUB_WRITE_MAX, 100);
});
