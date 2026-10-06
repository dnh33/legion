/**
 * Fixes from the UX review of Release A2a: name resolution (exact id decides alone), built-in labels and the groupKind/command
 * fields, reversible removal of a drill, the notice Undo, and the locked-skill refusal on the agents route.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gate, isClientRoute } from '../src/core/admin.js';
import { createArmoryModule } from '../src/core/armory/index.js';
import { discoverFromSdk, BUILTIN_SKILLS } from '../src/core/armory/discover.js';
import type { SdkSnapshot } from '../src/core/armory/handshake.js';
import { commandOf, groupKindOf } from '../src/core/armory/catalog.js';
import { createHouseModule } from '../src/core/house/index.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import { tempDir } from './tmp-cleanup.js';
import { AUTH } from './helpers-c.js';
import { closeAll, mount } from './token-harness.js';
import { defaultConfig } from '../src/shared/config.js';
import { sha256Of } from '../src/core/armory/store.js';
import { armoryRig, md, mkAgent, noSdk } from './armory-rig.js';

after(closeAll);

const alpha = mkAgent('alpha');
const snap = (o: Partial<SdkSnapshot> = {}): SdkSnapshot => ({ skills: [], commands: [], plugins: [], modelMessages: 0, costUsd: 0, ...o });
const sk = (name: string, description = ''): { name: string; description: string } => ({ name, description });

describe('B1: an exact id decides alone', () => {
  const ENG = { plugins: [{ key: 'eng@x', name: 'engineering', skills: { 'code-review': md('code-review', 'Review.') } }] };

  it('built-in code-review on + engineering:code-review off: /code-review runs, the Skill gate lets it load, /engineering:code-review is off', async () => {
    const r = armoryRig({ cc: ENG });
    await r.call('POST', '/api/armory/state', { id: 'code-review', state: 'on' });
    const ids = (await r.call('GET', '/api/armory')).skills.map((s: any) => `${s.id}:${s.state}`);
    assert.ok(ids.includes('code-review:on') && ids.includes('engineering:code-review:off'), ids.join(' '));
    assert.equal(r.mod.refuseSlashCommand!(alpha, '/code-review'), undefined);
    assert.equal(r.mod.skillGate!(alpha, 'code-review'), undefined);
    assert.match(r.mod.refuseSlashCommand!(alpha, '/engineering:code-review')!, /switched off/);
    assert.match(r.mod.skillGate!(alpha, 'engineering:code-review')!, /off in Legion/);
  });

  it('negative: built-in off and plugin on still refuses the bare name (the built-in is the exact id)', async () => {
    const r = armoryRig({ cc: ENG });
    await r.call('POST', '/api/armory/state', { id: 'engineering:code-review', state: 'on' });
    assert.match(r.mod.refuseSlashCommand!(alpha, '/code-review')!, /switched off/);
    assert.match(r.mod.skillGate!(alpha, 'code-review')!, /off in Legion/);
  });

  it('a bare name that is not an id and matches several skills is ambiguous and names the candidates, even when all are on', async () => {
    const r = armoryRig({ cc: { plugins: [
      { key: 'a@x', name: 'pa', skills: { review: md('review', 'A.') } },
      { key: 'b@x', name: 'pb', skills: { review: md('review', 'B.') } },
    ] } });
    await r.call('POST', '/api/armory/state-bulk', { ids: ['pa:review', 'pb:review'], state: 'on' });
    const msg = r.mod.refuseSlashCommand!(alpha, '/review')!;
    assert.match(msg, /^\/review matches several skills: pa:review, pb:review\. Type the full name, e\.g\. \/pa:review\.$/);
    assert.match(r.mod.skillGate!(alpha, 'review')!, /^review matches several skills: pa:review, pb:review\./);
    assert.equal(r.mod.refuseSlashCommand!(alpha, '/pa:review'), undefined, 'the full name works');
    assert.equal(r.mod.skillGate!(alpha, 'pb:review'), undefined);
  });

  it('a bare name with exactly one match still resolves to it', async () => {
    const r = armoryRig({ cc: { plugins: [{ key: 'a@x', name: 'pa', skills: { solo: md('solo', 'S.') } }] } });
    await r.call('POST', '/api/armory/state', { id: 'pa:solo', state: 'on' });
    assert.equal(r.mod.refuseSlashCommand!(alpha, '/solo'), undefined);
    await r.call('POST', '/api/armory/state', { id: 'pa:solo', state: 'off' });
    assert.match(r.mod.refuseSlashCommand!(alpha, '/solo')!, /switched off/);
  });
});

describe('B6: built-in labels, groupKind and command', () => {
  it("Claude Code's untagged own skills are built-ins, keybindings-help is locked, and an unknown stays plugin text", () => {
    const home = tempDir('legion-cchome-');
    const found = discoverFromSdk(home, snap({ skills: [sk('init', 'x'), sk('security-review'), sk('keybindings-help'), sk('mystery')] }));
    assert.deepEqual(found.map((s) => s.id), ['mystery'], 'the SDK pass leaves the built-ins to the constant list');
    assert.equal(found[0]!.source, 'claude-plugin');
    const by = Object.fromEntries(BUILTIN_SKILLS.map((b) => [b.id, b]));
    for (const id of ['init', 'security-review', 'keybindings-help', 'plugin-authoring']) assert.equal(by[id]!.source, 'claude-builtin', id);
    assert.equal(by.init!.fit, 'other');
    assert.ok(by['keybindings-help']!.offReason, 'it edits Claude Code itself');
  });

  it('the view carries groupKind and command; claude.ai synced skills are claude-ai (source stays claude-plugin, so still third-party)', async () => {
    const home = tempDir('legion-cchome-');
    const probe = async (): Promise<SdkSnapshot> => snap({ skills: [sk('docx', 'Make documents. (claude.ai sync)'), sk('init'), sk('Sync Me', 'Spaced. (claude.ai sync)'), sk('mine', 'Mine. (user)')] });
    const dataDir = tempDir('legion-armory-');
    const mod = createArmoryModule({ dataDir, config: defaultConfig(), store: { getAgent: () => undefined } } as unknown as ModuleDeps, { claudeHome: home, ttlMs: 0, sdkProbe: probe });
    const routes = new Map<string, (c: unknown) => unknown>();
    mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h as (c: unknown) => unknown); });
    const view = await routes.get('GET /api/armory')!({ req: { headers: {} }, body: undefined, params: [], url: new URL('http://x/') }) as { skills: any[] };
    const by = Object.fromEntries(view.skills.map((s) => [s.id, s]));
    assert.equal(by.docx.groupKind, 'claude-ai');
    assert.equal(by.docx.source, 'claude-plugin');
    assert.equal(by.docx.command, 'docx');
    assert.equal(by.init.groupKind, 'claude-builtin');
    assert.equal(by.init.plugin, null, 'no longer an unknown plugin');
    assert.equal(by.mine.groupKind, 'claude-personal');
    assert.equal(by['Sync Me'].command, null, 'a name with a space has no typeable /command');
    assert.equal(by['Sync Me'].id, 'Sync Me', 'the id is unchanged');
    assert.equal(by['deep-research'].groupKind, 'claude-builtin');
  });

  it('commandOf and groupKindOf', () => {
    assert.equal(commandOf({ id: 'a:b-c.d' }), 'a:b-c.d');
    assert.equal(commandOf({ id: 'a b' }), null);
    assert.equal(groupKindOf({ source: 'claude-plugin' }), 'claude-plugin');
    assert.equal(groupKindOf({ source: 'claude-plugin', origin: 'claude-ai' }), 'claude-ai');
    assert.equal(groupKindOf({ source: 'imported' }), 'imported');
  });
});

describe('B9: undo of the notice, P5: locked skill agents', () => {
  it('notice-seen {seen:false} brings the notice back; no body still marks it seen; a non-boolean is 400', async () => {
    const r = armoryRig();
    assert.deepEqual(await r.call('POST', '/api/armory/notice-seen'), { ccNoticeSeen: true });
    assert.equal((await r.call('GET', '/api/armory')).ccNoticeSeen, true);
    assert.deepEqual(await r.call('POST', '/api/armory/notice-seen', { seen: false }), { ccNoticeSeen: false });
    assert.equal((await r.call('GET', '/api/armory')).ccNoticeSeen, false, 'the notice shows again');
    assert.equal(JSON.parse(readFileSync(join(r.dataDir, 'armory', 'armory.json'), 'utf8')).ccNoticeSeen, false);
    await assert.rejects(() => r.call('POST', '/api/armory/notice-seen', { seen: 'no' }), /seen must be true or false/);
  });

  it('POST /api/armory/agents refuses a locked skill (400) and writes nothing; a normal skill still takes a grant', async () => {
    const r = armoryRig({ cc: { personal: { 'p-one': md('p-one', 'One.') } } });
    await assert.rejects(() => r.call('POST', '/api/armory/agents', { id: 'update-config', agents: ['alpha'] }), /acts on Claude Code itself/);
    const rec = JSON.parse(readFileSync(join(r.dataDir, 'armory', 'armory.json'), 'utf8')).skills['update-config'];
    assert.equal(rec, undefined, 'no record was written');
    const ok = await r.call('POST', '/api/armory/agents', { id: 'p-one', agents: ['alpha'] });
    assert.deepEqual(ok.agents, ['alpha']);
  });

  it('the notice route is admin-only (403 with only the bearer token)', async () => {
    assert.equal(isClientRoute('POST', '/api/armory/notice-seen'), false);
    const dataDir = tempDir('legion-armory-');
    const m = await mount(undefined, { extraModules: (deps: ModuleDeps) => [createArmoryModule({ ...deps, dataDir } as ModuleDeps, { claudeHome: tempDir('legion-cchome-'), sdkProbe: noSdk })] });
    assert.equal((await m.http('POST', '/api/armory/notice-seen', { seen: false })).status, 403);
    assert.equal((await m.http('POST', '/api/armory/notice-seen', { seen: false }, AUTH)).status, 200);
  });
});

describe('B9: DELETE /api/house/drill', () => {
  function rig() {
    const a = armoryRig();
    const repo = tempDir('legion-repo-');
    mkdirSync(join(repo, 'skills', 'review', 'second-look'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), '# Rules\n', 'utf8');
    writeFileSync(join(repo, 'skills', 'review', 'second-look', 'SKILL.md'), md('second-look', 'Read it cold.'), 'utf8');
    const deps = { dataDir: a.dataDir, config: a.config, bsvEnabled: () => false } as unknown as ModuleDeps;
    const house = createHouseModule(deps, { repoRoot: repo, claudeHome: a.home });
    const handlers = new Map<string, (c: unknown) => unknown>();
    const paths: string[] = [];
    const add: RouteAdder = (m, p, h) => { paths.push(`${m} ${p}`); handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
    house.routes?.(add);
    const call = async (m: string, p: string, body?: unknown): Promise<any> => {
      const url = new URL(`http://x${p}`);
      const h = handlers.get(`${m} ${url.pathname}`);
      assert.ok(h, `no route ${m} ${url.pathname}`);
      return h({ req: { headers: {} }, body, params: [], url });
    };
    return { call, paths, layer: join(a.dataDir, 'context') };
  }
  const del = (path: string): string => `/api/house/drill?path=${encodeURIComponent(path)}`;

  it('removes the folder, returns the text, and re-posting it with replace restores the drill (Undo)', async () => {
    const r = rig();
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Plan first.', body: '# Plan\nStep one.' });
    const file = join(r.layer, 'skills', 'yours', 'plan', 'SKILL.md');
    const before = readFileSync(file, 'utf8');
    const out = await r.call('DELETE', del('skills/yours/plan/SKILL.md'));
    assert.equal(out.removed, 'skills/yours/plan/SKILL.md');
    assert.equal(out.text, before);
    assert.equal(existsSync(join(r.layer, 'skills', 'yours', 'plan')), false, 'the folder is gone');
    await assert.rejects(() => r.call('DELETE', del('skills/yours/plan/SKILL.md')), /No drill/);
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Plan first.', body: '# Plan\nStep one.', replace: true });
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('refuses a path outside skills/yours, a traversal, a shipped drill and a missing path, and deletes nothing', async () => {
    const r = rig();
    await r.call('POST', '/api/house/drill', { name: 'keep', description: 'd', body: 'b' });
    const shipped = join(r.layer, 'skills', 'review', 'second-look', 'SKILL.md');
    assert.ok(existsSync(shipped), 'the shipped drill is in the layer');
    const bad = [
      'skills/review/second-look/SKILL.md', 'AGENTS.md', 'skills/yours/keep/other.md', 'skills/yours/keep', 'skills/yours/../review/second-look/SKILL.md',
      'skills/yours/../../state.json', '../state.json', 'skills\\yours\\..\\review\\second-look\\SKILL.md', 'skills/yours/Keep/SKILL.md', '',
    ];
    for (const p of bad) await assert.rejects(() => r.call('DELETE', del(p)), /Only one of your own drills|outside|No drill/, p || '(empty)');
    await assert.rejects(() => r.call('DELETE', '/api/house/drill'), /Only one of your own drills/);
    assert.ok(existsSync(shipped), 'the shipped drill survived');
    assert.ok(existsSync(join(r.layer, 'skills', 'yours', 'keep', 'SKILL.md')), 'the owner drill survived');
  });

  it('refuses a drill the app shipped even when it sits under skills/yours', async () => {
    const r = rig();
    await r.call('POST', '/api/house/drill', { name: 'dup', description: 'd', body: 'b' });
    const { readManifest, writeManifest } = await import('../src/core/house/trust.js');
    writeManifest(r.layer, { ...readManifest(r.layer), 'skills/yours/dup/SKILL.md': sha256Of(readFileSync(join(r.layer, 'skills', 'yours', 'dup', 'SKILL.md'))) });
    await assert.rejects(() => r.call('DELETE', del('skills/yours/dup/SKILL.md')), /ships with the app/);
    assert.ok(existsSync(join(r.layer, 'skills', 'yours', 'dup', 'SKILL.md')));
  });

  it('is admin-only: not on the client list, 403 for the bearer token alone', async () => {
    const r = rig();
    assert.ok(r.paths.includes('DELETE /api/house/drill'));
    assert.equal(isClientRoute('DELETE', '/api/house/drill'), false);
    const d = gate({ method: 'DELETE', path: '/api/house/drill', adminOk: false, bearerOk: true, hasSecret: true });
    assert.equal(d.allow, false);
    assert.equal((d as { status: number }).status, 403);
    assert.equal(gate({ method: 'DELETE', path: '/api/house/drill', adminOk: true, bearerOk: false, hasSecret: true }).allow, true);
  });
});
