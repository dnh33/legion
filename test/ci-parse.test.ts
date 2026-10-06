/** CI: the run/job parser, log preparation and the git remote reader. Pure functions plus a temp folder; no network. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { countsFor, LOG_MAX_LINES, maskSecrets, parseJobs, parseRuns, prepareLog, summarizeRun } from '../src/core/ci/parse.js';
import { parseRemoteUrl, parseRepoText, validRepoString, readRepoInfo, validBranch } from '../src/core/ci/repo.js';
import { tempDir } from './tmp-cleanup.js';

const run = (o: Record<string, unknown> = {}) => ({
  id: 11, name: 'CI', head_branch: 'main', head_sha: 'abc', display_title: 'Fix it', event: 'push', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/o/r/actions/runs/11', created_at: '2026-10-07T10:00:00Z', run_started_at: '2026-10-07T10:00:05Z', updated_at: '2026-10-07T10:02:05Z', run_attempt: 1, ...o,
});

describe('parseRuns / parseJobs', () => {
  it('reads the documented fields and computes the duration of a finished run', () => {
    const [r] = parseRuns({ workflow_runs: [run()] });
    assert.equal(r!.id, 11);
    assert.equal(r!.workflow, 'CI');
    assert.equal(r!.title, 'Fix it');
    assert.equal(r!.durationMs, 120_000);
    assert.equal(r!.url, 'https://github.com/o/r/actions/runs/11');
  });
  it('drops rows without a numeric id, takes the title from head_commit when display_title is missing, and keeps only github.com links', () => {
    const rows = parseRuns({ workflow_runs: [run({ id: 'x' }), null, 5, run({ id: 12, display_title: undefined, head_commit: { message: 'first line\nsecond' }, html_url: 'https://evil.example/x' })] });
    assert.deepEqual(rows.map((x) => x.id), [12]);
    assert.equal(rows[0]!.title, 'first line');
    assert.equal(rows[0]!.url, '');
  });
  it('treats anything that is not the documented wrapper as an empty list', () => {
    assert.deepEqual(parseRuns(null), []);
    assert.deepEqual(parseRuns({ workflow_runs: 'no' }), []);
    assert.deepEqual(parseJobs({ jobs: {} }), []);
  });
  it('an unfinished run has no duration; job OS is read from the name or labels', () => {
    assert.equal(parseRuns({ workflow_runs: [run({ status: 'in_progress', conclusion: null })] })[0]!.durationMs, null);
    const jobs = parseJobs({ jobs: [
      { id: 1, name: 'test (windows-latest, 2/4)', status: 'completed', conclusion: 'success', started_at: '2026-10-07T10:00:00Z', completed_at: '2026-10-07T10:01:00Z' },
      { id: 2, name: 'build', labels: ['self-hosted', 'macOS'] }, { id: 3, name: 'lint' }, { id: 4, name: 'unit (ubuntu-latest)' },
    ] });
    assert.deepEqual(jobs.map((j) => j.os), ['windows', 'macos', null, 'linux']);
    assert.equal(jobs[0]!.durationMs, 60_000);
  });
});

describe('summarizeRun / countsFor', () => {
  it('summarizeRun has the github_ci_wait shape and lists only failing jobs', () => {
    const jobs = parseJobs({ jobs: [{ id: 1, name: 'a', status: 'completed', conclusion: 'success' }, { id: 2, name: 'b', status: 'completed', conclusion: 'failure' }, { id: 3, name: 'c', status: 'completed', conclusion: 'timed_out' }, { id: 4, name: 'd', status: 'completed', conclusion: 'cancelled' }] });
    const s = summarizeRun(parseRuns({ workflow_runs: [run({ conclusion: 'failure' })] })[0]!, jobs);
    assert.deepEqual(Object.keys(s).sort(), ['conclusion', 'failedJobs', 'status', 'url']);
    assert.deepEqual(s.failedJobs, [{ id: 2, name: 'b', conclusion: 'failure' }, { id: 3, name: 'c', conclusion: 'timed_out' }]);
  });
  it('counts the latest run of each workflow on the branch, not every run', () => {
    const runs = parseRuns({ workflow_runs: [
      run({ id: 1, conclusion: 'failure', created_at: '2026-10-07T09:00:00Z' }), run({ id: 2, conclusion: 'success', created_at: '2026-10-07T10:00:00Z' }),
      run({ id: 3, name: 'Release', status: 'in_progress', conclusion: null }), run({ id: 4, head_branch: 'other', conclusion: 'failure' }),
    ] });
    assert.deepEqual(countsFor(runs, 'main'), { success: 1, failure: 0, running: 1 });
    assert.deepEqual(countsFor(runs, 'other'), { success: 0, failure: 1, running: 0 });
  });
});

describe('log text', () => {
  it('removes ANSI and control characters and masks secret-shaped values, but leaves markup as plain text', () => {
    const raw = '\u001b[31mred\u001b[0m\u0007 ok\n2026-10-07T10:00:00.1234567Z token=' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789' + '\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\nkey ' + 'AKIA' + 'ABCDEFGHIJKLMNOP' + '\n<img src=x onerror=alert(1)>';
    const p = prepareLog(raw);
    assert.equal(p.masked, true);
    assert.ok(!/ghp_abcdef|AKIAABCDEF|abcdefghijklmnopqrstuvwxyz/.test(p.text), p.text);
    assert.ok(!p.text.includes('\u001b') && !p.text.includes('\u0007'));
    assert.ok(p.text.includes('<img src=x onerror=alert(1)>'), 'markup is kept as text; the UI renders text only');
    assert.ok(p.text.startsWith('red ok'));
  });
  it('keeps the last lines of a long log and says it was cut', () => {
    const raw = Array.from({ length: LOG_MAX_LINES + 100 }, (_, i) => `line ${i}`).join('\n');
    const p = prepareLog(raw);
    assert.equal(p.truncated, true);
    assert.equal(p.text.split('\n').length, LOG_MAX_LINES);
    assert.ok(p.text.endsWith(`line ${LOG_MAX_LINES + 99}`));
  });
  it('masks private key blocks and leaves ordinary text alone', () => {
    assert.equal(maskSecrets('plain text with no secrets').masked, false);
    const m = maskSecrets('-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIabc\n-----END RSA ' + 'PRIVATE KEY-----');
    assert.equal(m.masked, true);
    assert.ok(!m.text.includes('MIIabc'));
  });
});

describe('repo from git', () => {
  it('parses github.com remotes (https, ssh, ssh://, credentials ignored) and refuses other hosts', () => {
    assert.deepEqual(parseRemoteUrl('https://github.com/dnh33/legion.git'), { owner: 'dnh33', name: 'legion' });
    assert.deepEqual(parseRemoteUrl('git@github.com:dnh33/legion.git'), { owner: 'dnh33', name: 'legion' });
    assert.deepEqual(parseRemoteUrl('ssh://git@github.com/dnh33/legion'), { owner: 'dnh33', name: 'legion' });
    assert.deepEqual(parseRemoteUrl('https://user:secret@github.com/dnh33/legion'), { owner: 'dnh33', name: 'legion' });
    assert.equal(parseRemoteUrl('https://gitlab.com/dnh33/legion.git'), null);
    assert.equal(parseRemoteUrl('https://github.com.evil.example/dnh33/legion'), null);
  });
  it('validRepoString: owner/name only, and neither part may be . or ..', () => {
    for (const ok of ['dnh33/legion', 'a.b/c_d-e', '.github/x', 'a/.x']) assert.equal(validRepoString(ok), true, ok);
    for (const bad of ['./x', '../x', 'a/..', 'a/.', '/x', 'a/', 'a/b/c', 'a b/c', 'a/b?x', '', 5, null]) assert.equal(validRepoString(bad), false, String(bad));
  });
  it('validates typed repos and branches', () => {
    assert.deepEqual(parseRepoText(' dnh33/legion '), { owner: 'dnh33', name: 'legion' });
    for (const bad of ['', 'a', 'a/b/c', '../x', './x', 'a b/c', 'a/b c', 'a/..', 'a/b;rm', 5, null]) assert.equal(parseRepoText(bad), null, String(bad));
    assert.equal(validBranch('feat/ci-panel'), true);
    for (const bad of ['', 'a..b', 'a b', 'a?x=1', 'x\ny', 'a'.repeat(201)]) assert.equal(validBranch(bad), false, bad);
  });
  it('reads origin and the branch from a clone, prefers origin to cloud, and follows a linked worktree', () => {
    const root = tempDir('legion-ci-git-');
    const main = join(root, 'main');
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'config'), '[core]\n\tbare = false\n[remote "cloud"]\n\turl = https://github.com/someone/else.git\n[remote "origin"]\n\turl = git@github.com:dnh33/legion.git\n');
    writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.deepEqual(readRepoInfo(main), { repo: { owner: 'dnh33', name: 'legion' }, branch: 'main' });
    const wt = join(root, 'wt');
    mkdirSync(join(wt, 'sub'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feat/ci-panel\n');
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    assert.deepEqual(readRepoInfo(join(wt, 'sub')), { repo: { owner: 'dnh33', name: 'legion' }, branch: 'feat/ci-panel' });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    assert.equal(readRepoInfo(wt).branch, null, 'detached HEAD has no branch');
  });
  it('a folder with no git, or a non-github remote, gives no repo', () => {
    const d = tempDir('legion-ci-nogit-');
    assert.equal(readRepoInfo(d).repo, null);
    mkdirSync(join(d, '.git'));
    writeFileSync(join(d, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/a/b.git\n');
    writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.deepEqual(readRepoInfo(d), { repo: null, branch: 'main' });
  });
});
