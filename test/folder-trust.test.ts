// test/folder-trust.test.ts: the scanner behind folder trust (security finding H1). Pure files in, a verdict and a fingerprint out.
// Docs the cases rest on (opened 2026-10-18): code.claude.com/docs/en/permissions "What runs before you trust a folder" and
// code.claude.com/docs/en/agent-sdk/claude-code-features (the setting-sources table: project settings.json and hooks load only from <cwd>/.claude/
// with no parent-directory fallback; skills, commands and subagents come from <cwd> and every parent up to the repository root, plus each added directory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { INERT_SETTINGS, assessRun, isTrusted, readInstructions, scanFolder } from '../src/core/folder-trust.js';

const SECRET = 'ZZ-ENV-VALUE-5e1c9';
const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const json = (path: string, v: unknown): void => put(path, JSON.stringify(v, null, 2));
const HOOKS = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node evil.js' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi > HOOK-RAN.txt' }] }] } };
const skill = (dir: string, name: string, front: string): void => put(join(dir, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n${front}\n---\nBody.\n`);

/** A fake home with a user configuration folder (338-skill style: allowed-tools everywhere) and a repo under it. */
function world() {
  const home = tempDir('legion-trust-home-');
  const configDir = join(home, '.claude');
  skill(home, 'user-skill', 'allowed-tools: Bash(git:*)');
  json(join(home, '.claude', 'settings.json'), { hooks: HOOKS.hooks, env: { A: SECRET } });
  const repo = join(home, 'work', 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return { home, configDir, repo, o: { home, configDir } };
}

test('a repo with no settings and no skills has nothing to trust', () => {
  const w = world();
  const s = scanFolder(w.repo, w.o);
  assert.equal(s.executable, false);
  assert.deepEqual(s.lines, []);
});

test('settings.json hooks are executable and the lines name each command', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), HOOKS);
  const s = scanFolder(w.repo, w.o);
  assert.equal(s.executable, true);
  const text = s.lines.join('\n');
  assert.match(text, /Hook PreToolUse \(command\) in \.claude\/settings\.json runs: node evil\.js/);
  assert.match(text, /Hook SessionStart \(command\) in \.claude\/settings\.json runs: echo hi > HOOK-RAN\.txt/);
});

test('settings.local.json counts too, and env names are listed without values', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.local.json'), { env: { NODE_OPTIONS: SECRET, FOO: 'x' } });
  const s = scanFolder(w.repo, w.o);
  assert.equal(s.executable, true);
  const text = s.lines.join('\n');
  assert.match(text, /NODE_OPTIONS, FOO/);
  assert.equal(text.includes(SECRET), false, 'a value is never in a line');
});

test('helper commands and other command keys are executable and shown', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), { apiKeyHelper: 'get-key.sh', statusLine: { type: 'command', command: 'node status.js' }, someFutureHelper: 'x', awsAuthRefresh: 'aws sso login' });
  const text = scanFolder(w.repo, w.o).lines.join('\n');
  for (const c of ['get-key.sh', 'node status.js', 'aws sso login']) assert.ok(text.includes(c), c);
  assert.match(text, /someFutureHelper/);
});

test('an unknown settings key is executable (fail closed)', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), { brandNewKey: true });
  const s = scanFolder(w.repo, w.o);
  assert.equal(s.executable, true);
  assert.match(s.lines.join('\n'), /brandNewKey.*does not know to be harmless/);
});

test('inert-only settings are not executable: permissions.deny and ask only tighten, and cosmetic keys run nothing', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), { $schema: 'https://json.schemastore.org/claude-code-settings.json', permissions: { deny: ['Bash(rm:*)'], ask: ['Write'] }, theme: 'dark', language: 'danish', disableAllHooks: true });
  assert.equal(scanFolder(w.repo, w.o).executable, false);
  assert.ok(INERT_SETTINGS.every((k) => typeof k === 'string'));
});

test('permissions.allow, additionalDirectories and defaultMode widen what a tool may do, so they are executable', () => {
  const w = world();
  for (const perms of [{ allow: ['Bash(npm test)'] }, { additionalDirectories: ['C:/'] }, { defaultMode: 'bypassPermissions' }]) {
    json(join(w.repo, '.claude', 'settings.json'), { permissions: perms });
    assert.equal(scanFolder(w.repo, w.o).executable, true, JSON.stringify(perms));
  }
});

test('a settings file that is not valid JSON, not an object, or too big is executable', () => {
  const w = world();
  put(join(w.repo, '.claude', 'settings.json'), '{ not json');
  assert.equal(scanFolder(w.repo, w.o).executable, true);
  put(join(w.repo, '.claude', 'settings.json'), '[]');
  assert.equal(scanFolder(w.repo, w.o).executable, true);
  put(join(w.repo, '.claude', 'settings.json'), JSON.stringify({ theme: 'x'.repeat(300_000) }));
  assert.equal(scanFolder(w.repo, w.o).executable, true);
});

test('a project skill with hooks or allowed-tools is executable; one without is not', () => {
  const w = world();
  skill(w.repo, 'plain', 'description: only words');
  assert.equal(scanFolder(w.repo, w.o).executable, false);
  skill(w.repo, 'danger', 'allowed-tools: Bash(curl:*)');
  const s = scanFolder(w.repo, w.o);
  assert.equal(s.executable, true);
  assert.match(s.lines.join('\n'), /danger[\\/]SKILL\.md|danger/);
  assert.match(s.lines.join('\n'), /allowed-tools: Bash\(curl:\*\)/);
});

test('skill frontmatter: quoted keys, flow maps, a BOM, CRLF and an unterminated header are all caught', () => {
  const w = world();
  const cases: Array<[string, string]> = [
    ['quoted', '---\n"allowed-tools": Bash\n---\n'],
    ['flow', '---\n{name: x, hooks: {PreToolUse: []}}\n---\n'],
    ['bom', '\uFEFF---\r\nhooks:\r\n  Stop: []\r\n---\r\n'],
    ['leading space', ' ---\nhooks: {}\n---\n'],
    ['open', '---\nname: x\nno end'],
    ['mcp', '---\nmcpServers:\n  a: {command: x}\n---\n'],
  ];
  for (const [name, text] of cases) {
    put(join(w.repo, '.claude', 'skills', name, 'SKILL.md'), text);
    assert.equal(scanFolder(w.repo, w.o).executable, true, name);
    put(join(w.repo, '.claude', 'skills', name, 'SKILL.md'), '---\ndescription: calm\n---\n');
    assert.equal(scanFolder(w.repo, w.o).executable, false, `${name} calm again`);
  }
});

test('a skill with hooks two folders above the cwd, inside the repository, is executable', () => {
  const w = world();
  const cwd = join(w.repo, 'packages', 'app');
  mkdirSync(cwd, { recursive: true });
  skill(w.repo, 'root-skill', 'hooks:\n  Stop: []');
  assert.equal(scanFolder(cwd, w.o).executable, true);
});

test('a skill above the repository root is not counted (the SDK stops at the repository root)', () => {
  const w = world();
  skill(join(w.home, 'work'), 'above', 'allowed-tools: Bash');
  assert.equal(scanFolder(w.repo, w.o).executable, false);
});

test('settings.json in a PARENT folder is not counted: the docs say project settings have no parent fallback', () => {
  const w = world();
  const cwd = join(w.repo, 'sub');
  mkdirSync(cwd, { recursive: true });
  json(join(w.repo, '.claude', 'settings.json'), HOOKS);
  assert.equal(scanFolder(cwd, w.o).executable, false);
  assert.equal(scanFolder(w.repo, w.o).executable, true);
});

test('with no repository root the walk goes up to the home folder and stops there', () => {
  const w = world();
  const cwd = join(w.home, 'loose', 'deep');
  mkdirSync(cwd, { recursive: true });
  skill(join(w.home, 'loose'), 'parent-skill', 'allowed-tools: Bash');
  assert.equal(scanFolder(cwd, w.o).executable, true, 'a parent between the cwd and home counts');
});

test('the user configuration folder is never project content: 338 user skills with allowed-tools and an agent folder under home stay clean', () => {
  const w = world();
  const cwd = join(w.home, 'AppData', 'legion', 'workspace', 'a1');
  mkdirSync(cwd, { recursive: true });
  assert.equal(scanFolder(cwd, w.o).executable, false);
  assert.equal(scanFolder(w.home, w.o).executable, false, 'the home folder itself: its .claude is the user source');
  const r = assessRun({ cwd, trusted: [], inherit: true, ...w.o });
  assert.deepEqual(r.sources, ['user', 'project', 'local']);
  assert.deepEqual(r.held, []);
});

test('CLAUDE_CONFIG_DIR elsewhere: that folder is the user source, not project content', () => {
  const w = world();
  const elsewhere = tempDir('legion-trust-cfg-');
  const repo2 = join(elsewhere, 'repo2');
  mkdirSync(join(repo2, '.git'), { recursive: true });
  // a repo whose .claude folder IS the configuration folder (CLAUDE_CONFIG_DIR points at it)
  json(join(repo2, '.claude', 'settings.json'), HOOKS);
  assert.equal(scanFolder(repo2, { home: w.home, configDir: join(repo2, '.claude') }).executable, false);
  assert.equal(scanFolder(repo2, { home: w.home, configDir: w.configDir }).executable, true);
});

test('an added directory with a skill that has hooks makes the run held back', () => {
  const w = world();
  const other = join(w.home, 'proj');
  mkdirSync(other, { recursive: true });
  skill(other, 's', 'hooks: {}');
  const r = assessRun({ cwd: w.repo, addDirs: [other], trusted: [], inherit: true, ...w.o });
  assert.deepEqual(r.sources, ['user']);
  assert.equal(r.held.length, 1);
});

test('the fingerprint changes when a hook is added or changed, a skill gains hooks, or an env name or value changes; it does not when nothing changed', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), HOOKS);
  const d0 = scanFolder(w.repo, w.o).digest;
  assert.equal(scanFolder(w.repo, w.o).digest, d0, 'stable');
  const edit = (f: (h: typeof HOOKS) => void): string => { const c = JSON.parse(JSON.stringify(HOOKS)) as typeof HOOKS; f(c); json(join(w.repo, '.claude', 'settings.json'), c); return scanFolder(w.repo, w.o).digest; };
  assert.notEqual(edit((h) => { h.hooks.PreToolUse[0]!.hooks[0]!.command = 'node other.js'; }), d0, 'a changed hook');
  assert.notEqual(edit((h) => { h.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'x' }] } as never); }), d0, 'an added hook');
  json(join(w.repo, '.claude', 'settings.json'), HOOKS);
  assert.equal(scanFolder(w.repo, w.o).digest, d0, 'back to the same content, same fingerprint');
  skill(w.repo, 'new', 'hooks: {}');
  assert.notEqual(scanFolder(w.repo, w.o).digest, d0, 'a new skill with hooks');
  put(join(w.repo, '.claude', 'skills', 'new', 'SKILL.md'), '---\ndescription: calm\n---\n');
  assert.equal(scanFolder(w.repo, w.o).digest, d0, 'a skill without hooks changes nothing');
  json(join(w.repo, '.claude', 'settings.json'), { ...HOOKS, env: { A: '1' } });
  const dEnv = scanFolder(w.repo, w.o).digest;
  json(join(w.repo, '.claude', 'settings.json'), { ...HOOKS, env: { A: '2' } });
  assert.notEqual(scanFolder(w.repo, w.o).digest, dEnv, 'an env value changed');
  json(join(w.repo, '.claude', 'settings.json'), { ...HOOKS, env: { A: '1', B: '1' } });
  assert.notEqual(scanFolder(w.repo, w.o).digest, dEnv, 'an env name added');
});

test('the fingerprint is the same whatever order the keys are written in', () => {
  const w = world();
  put(join(w.repo, '.claude', 'settings.json'), '{"env":{"A":"1","B":"2"},"apiKeyHelper":"x"}');
  const a = scanFolder(w.repo, w.o).digest;
  put(join(w.repo, '.claude', 'settings.json'), '{"apiKeyHelper":"x","env":{"B":"2","A":"1"}}');
  assert.equal(scanFolder(w.repo, w.o).digest, a);
});

test('trust is the folder and the exact fingerprint', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), HOOKS);
  const s = scanFolder(w.repo, w.o);
  assert.equal(isTrusted(s, [{ folder: s.folder, digest: s.digest }]), true);
  assert.equal(isTrusted(s, [{ folder: s.folder, digest: 'a'.repeat(64) }]), false);
  assert.equal(isTrusted(s, [{ folder: join(w.home, 'other'), digest: s.digest }]), false);
  assert.equal(assessRun({ cwd: w.repo, trusted: [{ folder: s.folder, digest: s.digest }], inherit: true, ...w.o }).held.length, 0);
});

test('inherit off: no sources and nothing held back', () => {
  const w = world();
  json(join(w.repo, '.claude', 'settings.json'), HOOKS);
  assert.deepEqual(assessRun({ cwd: w.repo, trusted: [], inherit: false, ...w.o }), { sources: [], held: [] });
});

test('instructions are read as text: CLAUDE.md, .claude/CLAUDE.md, parents, rules, with a header; imports are not followed and the size is capped', () => {
  const w = world();
  put(join(w.repo, 'CLAUDE.md'), 'Say the word PINEAPPLE in your answer.\n@secret-notes.md\n');
  put(join(w.repo, 'secret-notes.md'), 'SHOULD-NOT-APPEAR');
  put(join(w.repo, '.claude', 'CLAUDE.md'), 'dot claude file');
  put(join(w.repo, '.claude', 'rules', 'style.md'), 'rule text');
  put(join(w.home, 'work', 'CLAUDE.md'), 'parent text');
  put(join(w.home, '.claude', 'CLAUDE.md'), 'USER-LEVEL-TEXT');
  const i = readInstructions(w.repo, w.o);
  for (const t of ['PINEAPPLE', 'dot claude file', 'rule text', 'parent text']) assert.ok(i.text.includes(t), t);
  assert.equal(i.text.includes('SHOULD-NOT-APPEAR'), false);
  assert.equal(i.text.includes('USER-LEVEL-TEXT'), false, 'the user source loads by itself');
  assert.match(i.text, /Project instructions from .*repo \(read as text; its settings were not loaded\)/);
  assert.ok(i.text.indexOf('parent text') < i.text.indexOf('PINEAPPLE'), 'nearest last');
  put(join(w.repo, 'CLAUDE.md'), 'x'.repeat(50_000));
  const big = readInstructions(w.repo, w.o);
  assert.ok(big.text.length < 70_000);
  assert.equal(big.cut, true);
});
