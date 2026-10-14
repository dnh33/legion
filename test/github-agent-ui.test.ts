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
