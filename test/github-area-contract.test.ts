import test from 'node:test';
import assert from 'node:assert/strict';
import { agentGithubLevel, githubAgentsFor, normRepo, validCreateName } from '../src/shared/github-area.js';

test('agentGithubLevel: none, read, write; githubWrite alone grants nothing', () => {
  assert.equal(agentGithubLevel({}), 'none');
  assert.equal(agentGithubLevel({ connectors: ['github'] }), 'read');
  assert.equal(agentGithubLevel({ connectors: ['github'], githubWrite: ['a/b'] }), 'write');
  assert.equal(agentGithubLevel({ githubWrite: ['a/b'] }), 'none');
  assert.equal(agentGithubLevel({ connectors: ['github'], githubWrite: [] }), 'read');
});

test('validCreateName accepts plain names and refuses path tricks', () => {
  for (const ok of ['legion', 'a.b-c_1']) assert.equal(validCreateName(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', '../x', '%2e%2e', 'a'.repeat(101), 'légion']) assert.equal(validCreateName(bad), false, bad);
  assert.equal(validCreateName('a'.repeat(100)), true);
});

test('normRepo lower-cases and strips a trailing .git', () => {
  assert.equal(normRepo('Dnh33/Legion.git'), 'dnh33/legion');
  assert.equal(normRepo('  dnh33/legion '), 'dnh33/legion');
});

test('githubAgentsFor splits read and write with mixed-case input', () => {
  const got = githubAgentsFor('dnh33/legion', [
    { id: 'none' },
    { id: 'legacy', connectors: ['github'] },
    { id: 'writer', connectors: ['github'], githubWrite: ['Dnh33/Legion.git'] },
    { id: 'other', connectors: ['github'], githubWrite: ['x/y'] },
    { id: 'nogh', githubWrite: ['dnh33/legion'] },
  ]);
  assert.deepEqual(got, { read: ['legacy', 'other'], write: ['writer'] });
});
