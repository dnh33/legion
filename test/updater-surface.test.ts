/** C21, C24 and the Electron-side helpers: what may touch the network or start a process, who may import the updater, what the production wiring passes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST, lex, scanTree } from './bsv-scan.js';
import { CODE_SET } from '../src/core/updater/apply.js';
import { buildJob, commitMatches, restartNowText } from '../src/core/updater/main-logic.js';
import { UPDATE_KEYS } from '../src/core/updater/trust.js';
import { createPublicKey } from 'node:crypto';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const updaterFiles = readdirSync(join(REPO, 'src/core/updater')).filter((n) => n.endsWith('.ts')).map((n) => `src/core/updater/${n}`).concat(['src/electron/updater-main.ts']);

test('C21: the tripwire is green with the updater in the tree, and its allowlist entries are exactly the three planned files with the planned kinds', () => {
  assert.deepEqual(scanTree(REPO).violations, []);
  const mine = Object.entries(ALLOWLIST).filter(([f]) => /updater/.test(f)).map(([f, v]) => [f, [...v.kinds].sort()]).sort();
  assert.deepEqual(mine, [['src/core/updater/apply.ts', ['child-process', 'fetch']], ['src/core/updater/net.ts', ['fetch']], ['src/electron/updater-main.ts', ['child-process']]]);
  for (const [f, v] of Object.entries(ALLOWLIST)) if (/updater/.test(f)) assert.ok(v.reason.length > 60, `${f} has a real reason`);
});
test('C21: only net.ts (and the apply helper) use fetch; only the apply helper and updater-main start processes; nothing else in the updater does either', () => {
  const uses = (rel: string) => { const code = lex(read(rel)).code; return { fetch: /\bfetch\s*\(/.test(code), cp: /node:child_process/.test(read(rel).replace(/\/\*[\s\S]*?\*\//g, '')) }; };
  const got: Record<string, { fetch: boolean; cp: boolean }> = {};
  for (const f of updaterFiles) got[f] = uses(f);
  const expectFetch = new Set(['src/core/updater/net.ts', 'src/core/updater/apply.ts']);
  const expectCp = new Set(['src/core/updater/apply.ts', 'src/electron/updater-main.ts']);
  for (const [f, u] of Object.entries(got)) { assert.equal(u.fetch, expectFetch.has(f), `${f} fetch`); assert.equal(u.cp, expectCp.has(f), `${f} child_process`); }
  assert.ok(updaterFiles.length >= 12);
});
test('C21: net.ts and the config hold no other host, and nothing in the updater reads an environment variable to pick a source (the helper only passes its environment on)', () => {
  const cfg = read('src/core/updater/config.ts');
  const hosts = [...cfg.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]).filter((h) => !/^\$/.test(h!));
  assert.deepEqual([...new Set(hosts)], ['github.com']);
  for (const f of updaterFiles) {
    const code = lex(read(f)).code;
    if (f.endsWith('apply.ts') || f.endsWith('updater-main.ts')) continue; // both only pass their own environment on to the helper / the relaunched app
    assert.equal(/\bprocess\s*\.\s*env\b/.test(code), false, `${f} reads process.env`);
  }
  assert.match(read('src/core/updater/index.ts'), /opts\.source \?\? PRODUCTION_SOURCE/);
  assert.match(read('src/core/updater/index.ts'), /opts\.keys \?\? UPDATE_KEYS/);
});
test('C21: production wiring passes no source, key, fetch, clock, version, platform or timer override to the updater', () => {
  const core = read('src/bin/legion-core.ts');
  const call = /createUpdaterModule\(moduleDeps, \{([\s\S]*?)\n  \}\);/.exec(core);
  assert.ok(call, 'the call is found');
  for (const forbidden of ['source', 'keys', 'fetchImpl', 'version', 'platform', 'now', 'timers', 'freeBytes']) assert.equal(new RegExp(`\\b${forbidden}\\s*[:,]`).test(call![1]!), false, `legion-core.ts must not pass ${forbidden}`);
});
test('C21: the apply helper is self-contained (node: imports only), because it is copied out of the folders it swaps', () => {
  const src = read('src/core/updater/apply.ts');
  for (const m of src.matchAll(/^import .* from '([^']+)';/gm)) assert.match(m[1]!, /^node:/, `apply.ts imports ${m[1]}`);
});
test('C16: the code set is the planned list and never node_modules, the data folder, shortcuts or uninstall.cmd', () => {
  assert.deepEqual([...CODE_SET], ['dist', 'dist-ui', 'assets', 'scripts', 'licenses', 'package.json', 'package-lock.json', 'build-info.json', 'NOTICE', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'setup.cmd', 'setup-yes.cmd', 'start-legion.cmd']);
});
test('C5: every embedded update key (none until the owner adds one) is an Ed25519 public key with a unique id', () => {
  const ids = UPDATE_KEYS.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of UPDATE_KEYS) assert.equal(createPublicKey(k.publicKeyPem).asymmetricKeyType, 'ed25519');
});

test('C24: release notes are untrusted text: only the updater, the Electron side and legion-core import the updater; no agent-facing file does; the panel renders text only', () => {
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${n.name}`;
      if (n.isDirectory()) { walk(rel); continue; }
      if (!/\.(ts|tsx)$/.test(n.name) || rel.startsWith('src/core/updater/')) continue;
      if (/from\s+['"][^'"]*updater\//.test(read(rel))) importers.push(rel);
    }
  };
  walk('src'); walk('ui/src');
  assert.deepEqual(importers.sort(), ['src/bin/legion-core.ts', 'src/electron/updater-main.ts']);
  assert.match(read('src/electron/main.ts'), /from '\.\/updater-main\.js'/);
  const panel = read('ui/src/components/UpdatePanel.tsx');
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(panel), false);
  for (const f of ['src/core/engine.ts', 'src/core/agent-tools.ts', 'src/core/mcp-tools.ts', 'src/core/bridge.ts']) assert.equal(/updater|release notes/i.test(read(f)), false, f);
});

test('Electron side: commit facts are used only if they describe THIS install and a staged tree inside its own .update/staging', () => {
  const inst = resolve('/tmp/legion-inst');
  const ok = { installDir: inst, stagedDir: join(inst, '.update', 'staging', '1.1.0', 'x', 'legion-1.1.0'), from: '1.0.0', to: '1.1.0' };
  assert.equal(commitMatches(ok, inst), true);
  assert.equal(commitMatches({ ...ok, installDir: resolve('/tmp/other') }, inst), false);
  assert.equal(commitMatches({ ...ok, stagedDir: resolve('/tmp/elsewhere/legion-1.1.0') }, inst), false);
  assert.equal(commitMatches({ ...ok, stagedDir: join(inst, '.update', 'staging', '..', '..', 'dist') }, inst), false);
  assert.equal(commitMatches({ ...ok, stagedDir: join(inst, 'dist') }, inst), false);
  for (const bad of [null, 5, {}, { ...ok, to: '' }, { ...ok, from: 3 }]) assert.equal(commitMatches(bad, inst), false);
});
test('Electron side: the job relaunches the same command as the shortcut; the restart-now text names what stops and what does not', () => {
  const inst = resolve('/tmp/legion-inst');
  const j = buildJob({ installDir: inst, stagedDir: join(inst, 's'), from: '1.0.0', to: '1.1.0' }, { parentPid: 77, port: 4747, execPath: 'C:\\electron.exe' });
  assert.deepEqual(j.relaunch, { cmd: 'C:\\electron.exe', args: [inst], cwd: inst });
  assert.equal(j.parentPid, 77); assert.equal(j.port, 4747);
  const t = restartNowText(['2 tasks running or waiting', '1 approval waiting for you'], '1.1.0');
  assert.match(t.detail, /- 2 tasks running or waiting/); assert.match(t.detail, /not resumed automatically/); assert.match(t.detail, /Cloud VMs are not touched/); assert.match(t.detail, /previous one/);
  assert.deepEqual(t.buttons, ['Cancel', 'Stop work and restart']);
  assert.match(restartNowText([], '1.1.0').detail, /nothing is running/);
});
