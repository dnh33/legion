/**
 * Claude Code skill discovery parity: the Armory lists what the Claude Code SDK really loads, not only what installed_plugins.json says.
 * A fake SDK stands in for Claude Code (no real model, no real CLI). The handshake asks three control questions and never sends a prompt.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gate, isClientRoute } from '../src/core/admin.js';
import { discoverClaudeCode, discoverFromSdk } from '../src/core/armory/discover.js';
import { sdkHandshake } from '../src/core/armory/handshake.js';
import type { ProbeQuery, ProbeQueryFn, SdkProbe, SdkSnapshot } from '../src/core/armory/handshake.js';
import { createArmoryModule } from '../src/core/armory/index.js';
import type { ModuleDeps } from '../src/core/modules.js';
import { tempDir } from './tmp-cleanup.js';
import { AUTH } from './helpers-c.js';
import { closeAll, mount } from './token-harness.js';
import { armoryRig, md, writeFile } from './armory-rig.js';

after(closeAll);

/** A plugin folder the desktop app delivered: not in installed_plugins.json, so the old discovery cannot see it. */
function syncedPlugin(home: string, name: string, skills: Record<string, string>, commands: Record<string, string> = {}): string {
  const root = join(home, 'plugins', 'synced', `id-${name}`);
  for (const [n, t] of Object.entries(skills)) writeFile(join(root, 'skills', n, 'SKILL.md'), t);
  for (const [n, t] of Object.entries(commands)) writeFile(join(root, 'commands', `${n}.md`), t);
  return root;
}

const snap = (o: Partial<SdkSnapshot> = {}): SdkSnapshot => ({ skills: [], commands: [], plugins: [], modelMessages: 0, costUsd: 0, ...o });
const sk = (name: string, description = ''): { name: string; description: string } => ({ name, description });

describe('discoverFromSdk: what the SDK lists is what the Armory lists', () => {
  it('lists a plugin that installed_plugins.json does not know, with the description from its file', () => {
    const home = tempDir('legion-cchome-');
    const root = syncedPlugin(home, 'design', { 'ux-copy': md('ux-copy', 'Write interface text.') });
    const found = discoverFromSdk(home, snap({ plugins: [{ name: 'design', path: root, source: 'design@synced' }], skills: [sk('design:ux-copy')] }));
    const hit = found.find((s) => s.id === 'design:ux-copy');
    assert.ok(hit, 'listed from the SDK plugin list');
    assert.equal(hit.source, 'claude-plugin');
    assert.equal(hit.plugin, 'design');
    assert.equal(hit.description, 'Write interface text.');
    assert.ok(hit.path?.endsWith('SKILL.md'));
    // the old discovery reads only installed_plugins.json and settings, so it finds nothing here
    assert.deepEqual(discoverClaudeCode(home).filter((s) => s.plugin === 'design'), []);
  });

  it('reads the folders plugin.json names (an impeccable-style layout) and a SKILL.md at the plugin root', () => {
    const home = tempDir('legion-cchome-');
    const root = join(home, 'plugins', 'cache', 'imp');
    writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'impeccable', skills: './.claude/skills' }));
    writeFile(join(root, '.claude', 'skills', 'polish', 'SKILL.md'), md('polish', 'Final pass.'));
    const flat = join(home, 'skills', 'markdown-fetch');
    writeFile(join(flat, 'SKILL.md'), md('markdown-fetch', 'Fetch pages.'));
    const found = discoverFromSdk(home, snap({
      plugins: [{ name: 'impeccable', path: root }, { name: 'markdown-fetch', path: flat }],
      skills: [sk('impeccable:polish'), sk('markdown-fetch:markdown-fetch')],
    }));
    assert.equal(found.find((s) => s.id === 'impeccable:polish')?.description, 'Final pass.');
    assert.equal(found.find((s) => s.id === 'markdown-fetch:markdown-fetch')?.path, join(flat, 'SKILL.md'));
    // a manifest path that climbs out of the plugin folder is not followed
    writeFile(join(home, 'outside', 'evil', 'SKILL.md'), md('evil', 'Outside.'));
    writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'impeccable', skills: '../../../outside' }));
    const again = discoverFromSdk(home, snap({ plugins: [{ name: 'impeccable', path: root }], skills: [sk('impeccable:evil')] }));
    assert.equal(again.find((s) => s.id === 'impeccable:evil')?.path, null, 'listed by name only: its file was not read');
  });

  it('names a skill the way the SDK does: the id comes from its list, whichever of frontmatter name or folder matches', () => {
    const home = tempDir('legion-cchome-');
    const root = syncedPlugin(home, 'engineering', { 'code-review-dir': md('code-review', 'Review code.'), plain: md('plain', 'Plain.') });
    // the SDK names the first one after its folder, not its frontmatter name
    const found = discoverFromSdk(home, snap({
      plugins: [{ name: 'engineering', path: root }],
      skills: [sk('engineering:code-review-dir'), sk('engineering:plain')],
    }));
    assert.deepEqual(found.map((s) => s.id).sort(), ['engineering:code-review-dir', 'engineering:plain']);
    const byFm = discoverFromSdk(home, snap({ plugins: [{ name: 'engineering', path: root }], skills: [sk('engineering:code-review'), sk('engineering:plain')] }));
    assert.ok(byFm.some((s) => s.id === 'engineering:code-review' && s.path), 'the frontmatter spelling also reconciles when that is what the SDK lists');
    // a personal skill spelled differently by the SDK ("Agent Development" for the folder agent-development)
    writeFile(join(home, 'skills', 'agent-development', 'SKILL.md'), '---\nname: Agent Development\ndescription: Build agents.\n---\nbody\n');
    const personal = discoverFromSdk(home, snap({ skills: [sk('Agent Development')], commands: [sk('Agent Development')] }));
    assert.equal(personal.find((s) => s.id === 'Agent Development')?.description, 'Build agents.');
    assert.equal(personal.filter((s) => s.id === 'agent-development').length, 0);
  });

  it('lists a skill with no file by name, with the SDK description or a plain default; leaves out built-ins and files the SDK did not list', () => {
    const home = tempDir('legion-cchome-');
    const root = syncedPlugin(home, 'data', { 'sql-queries': md('sql-queries', 'SQL.'), 'unloaded': md('unloaded', 'Not loaded.') });
    const found = discoverFromSdk(home, snap({
      plugins: [{ name: 'data', path: root }, { name: 'ghost', path: join(home, 'nowhere') }, { name: 'cc-plugin-telemetry', path: 'builtin' }],
      skills: [sk('data:sql-queries'), sk('ghost:haunt', 'Boo. (claude.ai sync)'), sk('ghost:silent'), sk('stray', 'A user skill. (user)'), sk('verify', 'built in')],
    }));
    const ids = found.map((s) => s.id);
    assert.deepEqual(ids.filter((i) => i !== 'data:sql-queries').sort(), ['ghost:haunt', 'ghost:silent', 'stray']);
    assert.ok(!ids.includes('data:unloaded'), 'a file the SDK does not list is not loaded, so not listed');
    assert.ok(!ids.includes('verify'), 'built-ins stay the constant list');
    const haunt = found.find((s) => s.id === 'ghost:haunt')!;
    assert.equal(haunt.description, 'Boo.');
    assert.equal(haunt.path, null);
    assert.equal(haunt.source, 'claude-plugin');
    assert.equal(haunt.plugin, 'ghost');
    assert.equal(found.find((s) => s.id === 'ghost:silent')!.description, 'No description available');
    // owner-tagged, no plugin: personal. Anything else of unknown origin counts as plugin text (fails closed).
    assert.equal(found.find((s) => s.id === 'stray')!.source, 'claude-personal');
  });
});

describe('discoverFromSdk: skills that come from outside the plugin list', () => {
  it('claude.ai-synced skills are plugin text (taint), a bare untagged name Legion does not know is plugin text (taints), and nested commands get a namespace', () => {
    const home = tempDir('legion-cchome-');
    const root = join(home, 'plugins', 'cache', 'b');
    writeFile(join(root, 'commands', 'docs', 'prd.md'), md('prd', 'Write a PRD.'));
    const found = discoverFromSdk(home, snap({
      plugins: [{ name: 'bopen-tools', path: root }],
      skills: [sk('bopen-tools:docs:prd'), sk('docx', 'Make documents. (claude.ai sync)'), sk('anthropic-skills:pdf', 'Read PDFs. (claude.ai sync)'), sk('mystery-skill', 'Start a CLAUDE.md')],
    }));
    const by = Object.fromEntries(found.map((s) => [s.id, s]));
    assert.equal(by['bopen-tools:docs:prd']!.path?.endsWith('prd.md'), true, 'commands/docs/prd.md is bopen-tools:docs:prd');
    assert.equal(by.docx!.source, 'claude-plugin');
    assert.equal(by.docx!.plugin, 'claude.ai');
    assert.equal(by['anthropic-skills:pdf']!.plugin, 'anthropic-skills');
    assert.equal(by['anthropic-skills:pdf']!.name, 'pdf');
    assert.equal(by['mystery-skill']!.source, 'claude-plugin', 'an untagged skill that is not in the built-in list is not trusted as a built-in');
    assert.equal(by['mystery-skill']!.plugin, 'unknown');
    assert.equal(by.docx!.origin, 'claude-ai', 'the claude.ai sync tag is kept so the screen can say where it came from');
    assert.equal(by['anthropic-skills:pdf']!.origin, 'claude-ai');
    assert.equal(by['bopen-tools:docs:prd']!.origin, undefined);
  });
});

describe('the module: handshake, cache, fallback, refresh', () => {
  const probeOf = (get: () => SdkSnapshot): { probe: SdkProbe; calls: () => number } => {
    let n = 0;
    return { probe: async () => { n++; return get(); }, calls: () => n };
  };

  it('GET lists the SDK plugins once, reports when and how, and a second GET does not ask again', async () => {
    const home = tempDir('legion-cchome-');
    const root = syncedPlugin(home, 'marketing', { 'brand-review': md('brand-review', 'Review a brand.') });
    const p = probeOf(() => snap({ plugins: [{ name: 'marketing', path: root }], skills: [sk('marketing:brand-review'), sk('marketing:nofile', 'x (user)')] }));
    const r = armoryRig({ sdkProbe: p.probe, cc: { personal: { mine: md('mine', 'Mine.') } } });
    r.mod.catalog(); // before any read: the disk listing, not the SDK's
    assert.equal(r.mod.catalog().some((e) => e.id === 'marketing:brand-review'), false);
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'sdk');
    assert.equal(a.discoveryReason, null);
    assert.match(a.discoveredAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(a.discoveryPlugins, 1);
    const byId = Object.fromEntries(a.skills.map((s: any) => [s.id, s]));
    assert.equal(byId['marketing:brand-review'].state, 'off', 'Claude Code skills stay off by default');
    assert.equal(byId['marketing:nofile'].state, 'off');
    assert.equal(byId['marketing:nofile'].description, 'x');
    assert.equal(byId.mine, undefined, 'a personal skill the SDK did not list is not listed in SDK mode');
    assert.equal(a.counts.byPlugin.marketing, 2);
    await r.call('GET', '/api/armory');
    assert.equal(p.calls(), 1, 'kept until a refresh');
    assert.ok(a.skills.some((s: any) => s.id === 'verify' && s.source === 'claude-builtin'), 'built-ins still listed');
  });

  it('keeps every state rule: built-ins with a reason stay locked off, and an SDK-only skill can be switched on', async () => {
    const home = tempDir('legion-cchome-');
    const p = probeOf(() => snap({ skills: [sk('gone:thing', 'Thing.')], plugins: [{ name: 'gone', path: join(home, 'x') }] }));
    const r = armoryRig({ sdkProbe: p.probe });
    await r.call('GET', '/api/armory');
    await assert.rejects(() => r.call('POST', '/api/armory/state', { id: 'schedule', state: 'on' }), /Legion keeps it off/);
    const on = await r.call('POST', '/api/armory/state', { id: 'gone:thing', state: 'on' });
    assert.equal(on.state, 'on');
    const agent = r.agents.get('alpha')!;
    assert.deepEqual(r.mod.claudeSkills!(agent).skills, ['gone:thing']);
  });

  it('falls back to the disk when the listing fails, says so and why, and tries again after retryMs', async () => {
    let fail = true;
    let calls = 0;
    const probe: SdkProbe = async () => { calls++; if (fail) throw new Error('Claude Code is not signed in'); return snap({ skills: [sk('p:x')] }); };
    const r = armoryRig({ sdkProbe: probe, cc: { plugins: [{ key: 'p@m', name: 'p', skills: { disk: md('disk', 'From disk.') } }] } });
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'disk-fallback');
    assert.match(a.discoveryReason, /not signed in/);
    assert.ok(a.skills.some((s: any) => s.id === 'p:disk'), 'the disk listing is what the screen shows');
    await r.call('GET', '/api/armory');
    assert.equal(calls, 1, 'a failure is not retried on every read');
    fail = false;
    const b = await r.call('POST', '/api/armory/refresh');
    assert.equal(b.discovery, 'sdk');
    assert.ok(b.skills.some((s: any) => s.id === 'p:x'));
    assert.ok(!b.skills.some((s: any) => s.id === 'p:disk'));
  });

  it('retries a failed listing on a later read once retryMs has passed', async () => {
    let calls = 0;
    const probe: SdkProbe = async () => { calls++; throw new Error('down'); };
    const dataDir = tempDir('legion-armory-');
    const config = (await import('../src/shared/config.js')).defaultConfig();
    const mod = createArmoryModule({ dataDir, config, store: { getAgent: () => undefined } } as unknown as ModuleDeps, { claudeHome: tempDir('legion-cchome-'), ttlMs: 0, sdkProbe: probe, retryMs: 0 });
    const routes = new Map<string, (c: unknown) => unknown>();
    mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h as (c: unknown) => unknown); });
    const get = routes.get('GET /api/armory')!;
    await get({ body: undefined, url: new URL('http://x/api/armory'), params: [] });
    await get({ body: undefined, url: new URL('http://x/api/armory'), params: [] });
    assert.equal(calls, 2);
  });

  it('does not start the listing when Claude Code settings are off for the agents', async () => {
    const p = probeOf(() => snap());
    const r = armoryRig({ inherit: false, sdkProbe: p.probe });
    const a = await r.call('GET', '/api/armory');
    assert.equal(p.calls(), 0);
    assert.equal(a.discovery, 'disk-fallback');
    assert.match(a.discoveryReason, /not used by your agents/);
    assert.equal(a.counts.claudePersonal + a.counts.claudePlugin, 0);
  });

  it('refresh lists again and shows a plugin installed since', async () => {
    const home = tempDir('legion-cchome-');
    const root = syncedPlugin(home, 'late', { s: md('s', 'S.') });
    let withLate = false;
    const probe: SdkProbe = async () => snap(withLate ? { plugins: [{ name: 'late', path: root }], skills: [sk('late:s')] } : {});
    const r = armoryRig({ sdkProbe: probe });
    const a = await r.call('GET', '/api/armory');
    assert.ok(!a.skills.some((s: any) => s.id === 'late:s'));
    withLate = true;
    const b = await r.call('POST', '/api/armory/refresh');
    assert.ok(b.skills.some((s: any) => s.id === 'late:s'));
    assert.ok(b.discoveredAt >= a.discoveredAt);
  });

  it('runs one listing at a time: two refreshes at once ask the SDK once', async () => {
    let calls = 0;
    let open!: () => void;
    const hold = new Promise<void>((res) => { open = res; });
    const probe: SdkProbe = async () => { calls++; await hold; return snap(); };
    const r = armoryRig({ sdkProbe: probe });
    const both = Promise.all([r.call('POST', '/api/armory/refresh'), r.call('GET', '/api/armory')]);
    await new Promise((res) => setImmediate(res));
    open();
    await both;
    assert.equal(calls, 1);
  });

  it('refresh is admin-only: off the MCP client list, 403 for the bearer token alone, allowed with the admin secret', async () => {
    assert.equal(isClientRoute('POST', '/api/armory/refresh'), false);
    assert.equal(gate({ method: 'POST', path: '/api/armory/refresh', adminOk: false, bearerOk: true, hasSecret: true }).allow, false);
    let calls = 0;
    const probe: SdkProbe = async () => { calls++; return snap(); };
    const dataDir = tempDir('legion-armory-');
    const m = await mount(undefined, { extraModules: (deps: ModuleDeps) => [createArmoryModule({ ...deps, dataDir } as ModuleDeps, { claudeHome: tempDir('legion-cchome-'), sdkProbe: probe })] });
    const denied = await m.http('POST', '/api/armory/refresh', {});
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'admin_required');
    assert.equal(calls, 0, 'a refused call starts nothing');
    const allowed = await m.http('POST', '/api/armory/refresh', {}, AUTH);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.discovery, 'sdk');
    assert.equal(calls, 1);
  });
});

/** A fake Query: records what the handshake does to it. */
function fakeQuery(over: Partial<ProbeQuery> & { messages?: unknown[]; hang?: boolean } = {}) {
  const log = { options: undefined as Record<string, unknown> | undefined, prompt: undefined as AsyncIterable<never> | undefined, interrupts: 0, closes: 0, calls: [] as string[] };
  const queryFn: ProbeQueryFn = (a) => {
    log.options = a.options;
    log.prompt = a.prompt;
    const msgs = [...(over.messages ?? [])];
    const never = new Promise<never>(() => undefined);
    const q: ProbeQuery = {
      initializationResult: async () => { log.calls.push('init'); if (over.hang) return never; return { commands: [{ name: 'c:one', description: 'One. (user)' }] }; },
      reloadSkills: async () => { log.calls.push('skills'); return { skills: [{ name: 'c:one', description: 'One.' }] }; },
      reloadPlugins: async () => { log.calls.push('plugins'); await new Promise((r) => setImmediate(r)); return { plugins: [{ name: 'c', path: 'C:\\x', source: 'c@synced' }] }; },
      interrupt: async () => { log.interrupts++; return undefined; },
      close: () => { log.closes++; },
      [Symbol.asyncIterator]: () => ({ next: async () => (msgs.length ? { done: false as const, value: msgs.shift() } : { done: true as const, value: undefined }) }),
    };
    return q;
  };
  return { queryFn, log };
}

describe('the handshake: no prompt, no model turn', () => {
  it('asks three questions, sends no message, and closes; the prompt stream yields nothing', async () => {
    const f = fakeQuery({ messages: [{ type: 'system', subtype: 'commands_changed' }] });
    const got = await sdkHandshake({ inheritClaudeCode: true, queryFn: f.queryFn });
    assert.deepEqual(f.log.calls, ['init', 'skills', 'plugins']);
    assert.equal(got.plugins[0]!.path, 'C:\\x');
    assert.equal(got.skills[0]!.name, 'c:one');
    assert.equal(got.modelMessages, 0);
    assert.equal(got.costUsd, 0);
    // the stream the SDK reads user messages from ended without ever producing one
    const it = f.log.prompt![Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { done: true, value: undefined });
    assert.equal(f.log.interrupts, 1);
    assert.equal(f.log.closes, 1);
    assert.deepEqual(f.log.options!.settingSources, ['user']);
    assert.equal(f.log.options!.strictMcpConfig, true);
    assert.deepEqual(f.log.options!.settings, { disableAllHooks: true });
    assert.ok(!('resume' in f.log.options!) && !('maxTurns' in f.log.options!));
  });

  it('counts a model message and its cost if one ever appeared, so a leak cannot hide', async () => {
    const f = fakeQuery({ messages: [{ type: 'system', subtype: 'commands_changed' }, { type: 'assistant' }, { type: 'result', total_cost_usd: 0.02 }] });
    const got = await sdkHandshake({ inheritClaudeCode: true, queryFn: f.queryFn });
    assert.equal(got.modelMessages, 2, 'assistant and result counted, the system notice is not');
    assert.equal(got.costUsd, 0.02);
  });

  it('closes and rejects when Claude Code does not answer in time', async () => {
    const f = fakeQuery({ hang: true });
    await assert.rejects(() => sdkHandshake({ inheritClaudeCode: true, queryFn: f.queryFn, timeoutMs: 40 }), /did not answer within/);
    assert.equal(f.log.closes, 1);
    assert.equal(f.log.interrupts, 1);
  });

  it('closes and rejects when the SDK throws; settingSources is empty when settings are not inherited', async () => {
    const f = fakeQuery();
    const bad: ProbeQueryFn = (a) => { const q = f.queryFn(a); q.reloadSkills = async () => { throw new Error('no auth'); }; return q; };
    await assert.rejects(() => sdkHandshake({ inheritClaudeCode: false, queryFn: bad }), /no auth/);
    assert.equal(f.log.closes, 1);
    assert.deepEqual(f.log.options!.settingSources, []);
  });
});
