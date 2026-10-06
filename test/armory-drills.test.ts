/** Your own drills (Doctrine): written as owner files, so untrusted and off until the owner approves and switches them; promote; per-agent drill filter. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createHouseModule } from '../src/core/house/index.js';
import { HOUSE_LIMITS } from '../src/core/house/context.js';
import type { ModuleDeps, ModuleJob, RouteAdder } from '../src/core/modules.js';
import { drillId } from '../src/shared/skill-ids.js';
import { tempDir } from './tmp-cleanup.js';
import { armoryRig, own, mkAgent, md } from './armory-rig.js';

function houseRig(extra: Parameters<typeof armoryRig>[0] = {}, withCatalog = true) {
  const a = armoryRig({ ...extra, cc: { personal: { 'my-skill': md('my-skill', 'Mine.', '', 'Personal body.') } }, agents: [mkAgent('alpha'), mkAgent('beta', { skills: ['drill:other/none'] }), mkAgent('gamma', { skills: [drillId('yours', 'plan')] })] });
  const repo = tempDir('legion-repo-');
  mkdirSync(join(repo, 'skills', 'review', 'second-look'), { recursive: true });
  writeFileSync(join(repo, 'AGENTS.md'), '# Rules\n', 'utf8');
  writeFileSync(join(repo, 'skills', 'review', 'second-look', 'SKILL.md'), md('second-look', 'Read it cold.'), 'utf8');
  const deps = { dataDir: a.dataDir, config: a.config, bsvEnabled: () => false } as unknown as ModuleDeps;
  const house = createHouseModule(deps, { repoRoot: repo, claudeHome: a.home, ...(withCatalog ? { catalog: () => a.mod.catalog() } : {}) });
  const handlers = new Map<string, (c: unknown) => unknown>();
  const add: RouteAdder = (m, p, h) => { handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
  house.routes?.(add);
  const call = async (m: string, p: string, body?: unknown): Promise<any> => {
    const h = handlers.get(`${m} ${p}`);
    assert.ok(h, `no route ${m} ${p}`);
    return h({ req: { headers: {} }, body, params: [], url: new URL('http://x/') });
  };
  const tools = (agentId: string) => {
    const st = { tainted: false };
    const job = { taskId: 't', taint: () => st.tainted, markTainted: () => { st.tainted = true; } } as ModuleJob;
    const srv = house.mcpServers!(a.agents.get(agentId)!, job).legion_house as any;
    return async (name: string, args: Record<string, unknown> = {}) => {
      const out = await srv.instance._registeredTools[name].handler(args, {});
      return { text: out.content.map((c: any) => c.text).join('\n') as string, isError: out.isError === true };
    };
  };
  return { a, house, call, tools, layer: join(a.dataDir, 'context') };
}

describe('your own drill', () => {
  it('is written as an owner file: untrusted and off, in the yours group of skills', async () => {
    const r = houseRig();
    const out = await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Plan first.', whenToUse: 'big changes', body: '# Plan\nStep one.' });
    assert.equal(out.path, 'skills/yours/plan/SKILL.md');
    assert.equal(out.trust, 'untrusted');
    assert.equal(out.on, false);
    const view = await r.call('GET', '/api/house');
    const f = view.files.find((x: any) => x.path === 'skills/yours/plan/SKILL.md');
    assert.equal(f.category, 'skills');
    assert.equal(f.group, 'yours');
    assert.equal(f.trust, 'untrusted');
    assert.equal(f.on, false);
    assert.equal(f.title, 'plan');
    assert.match(readFileSync(join(r.layer, 'skills', 'yours', 'plan', 'SKILL.md'), 'utf8'), /Use when: big changes/);
  });

  it('refuses a bad name and an empty body, and writes nothing', async () => {
    const r = houseRig();
    for (const name of ['', '../x', 'A b', 'x/y']) {
      await assert.rejects(() => r.call('POST', '/api/house/drill', { name, description: 'd', body: 'b' }), /name must be/, name);
    }
    await assert.rejects(() => r.call('POST', '/api/house/drill', { name: 'a', description: 'd', body: '' }), /body is required/);
    assert.ok(!existsSync(join(r.layer, 'skills', 'yours')));
  });

  it('stays untrusted after being switched on, is trusted only once adopted, and an edit drops the approval', async () => {
    const r = houseRig();
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Plan first.', body: 'Step one.' });
    await r.call('POST', '/api/house/switch', { path: 'skills/yours/plan/SKILL.md', on: true });
    const read = r.tools('alpha');
    assert.match((await read('house_skill', { name: 'plan' })).text, /NOT vouched for/, 'wrapped as material while untrusted');
    await r.call('POST', '/api/house/adopt', { path: 'skills/yours/plan/SKILL.md' });
    assert.doesNotMatch((await read('house_skill', { name: 'plan' })).text, /NOT vouched for/);
    const edited = await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Plan first, changed.', body: 'Step one, changed.', replace: true });
    assert.equal(edited.trust, 'untrusted', 'any edit drops the approval');
  });

  it('a New with a taken name is refused with 409 and the file is untouched; only replace:true overwrites', async () => {
    const r = houseRig();
    const file = join(r.layer, 'skills', 'yours', 'plan', 'SKILL.md');
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'First.', body: 'One.' });
    const first = readFileSync(file, 'utf8');
    const err = await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Second.', body: 'Two.' }).then(() => null, (e) => e);
    assert.equal(err?.status, 409);
    assert.equal(err?.message, 'A drill called plan already exists. Edit it, or pick another name.');
    assert.equal(readFileSync(file, 'utf8'), first, 'the first drill is untouched');
    for (const replace of [false, 'true', 1, null]) {
      await assert.rejects(() => r.call('POST', '/api/house/drill', { name: 'plan', description: 'Third.', body: 'Three.', replace }), /already exists/, `replace ${JSON.stringify(replace)} is not a yes`);
    }
    assert.equal(readFileSync(file, 'utf8'), first);
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Second.', body: 'Two.', replace: true });
    assert.match(readFileSync(file, 'utf8'), /Two\./);
    const fresh = await r.call('POST', '/api/house/drill', { name: 'other', description: 'D.', body: 'B', replace: true });
    assert.equal(fresh.path, 'skills/yours/other/SKILL.md', 'replace on a free name just writes it');
  });

  it('survives a sync: Legion never deletes a drill the owner wrote', async () => {
    const r = houseRig();
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'd', body: 'b' });
    r.house.sync(); r.house.sync();
    assert.ok(existsSync(join(r.layer, 'skills', 'yours', 'plan', 'SKILL.md')));
  });
});

describe('promote an Armory skill to a drill', () => {
  it('copies the text into Your drills, not approved and off, and leaves the Armory skill where it is', async () => {
    const r = houseRig();
    await own(r.a, { name: 'mine', description: 'Mine d.', body: 'My body.' });
    const out = await r.call('POST', '/api/house/drill/promote', { armoryId: 'legion-armory:mine' });
    assert.equal(out.path, 'skills/yours/mine/SKILL.md');
    assert.equal(out.trust, 'untrusted');
    assert.equal(out.on, false);
    assert.match(readFileSync(join(r.layer, 'skills', 'yours', 'mine', 'SKILL.md'), 'utf8'), /My body\./);
    assert.ok((await r.a.call('GET', '/api/armory')).skills.some((s: any) => s.id === 'legion-armory:mine'));
    const adoptedFile = join(r.a.dataDir, '.adopted.json');
    assert.ok(!existsSync(adoptedFile) || !/mine/.test(readFileSync(adoptedFile, 'utf8')), 'nothing was approved');
  });

  it('promotes an imported skill the same way (still not approved), refuses a second copy, a built-in and an unknown id', async () => {
    const r = houseRig();
    await r.a.call('POST', '/api/armory/import', { files: [{ path: 'imp/SKILL.md', text: md('imp', 'Imported.', '', 'Imported body.') }] });
    const out = await r.call('POST', '/api/house/drill/promote', { armoryId: 'legion-armory:imp' });
    assert.equal(out.trust, 'untrusted');
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', { armoryId: 'legion-armory:imp' }), /A drill called imp already exists/);
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', { armoryId: 'debug' }), /built in to Claude Code/);
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', { armoryId: 'ghost' }), /not in the Armory any more/);
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', {}), /armoryId is required/);
  });
});

describe('the per-agent drill filter', () => {
  it('house_skills, house_skill and the preamble show a drill only to agents whose own setting allows it', async () => {
    const r = houseRig();
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Plan first.', body: 'Step one.' });
    await r.call('POST', '/api/house/switch', { path: 'skills/yours/plan/SKILL.md', on: true });
    await r.call('POST', '/api/house/switch', { path: 'skills/review/second-look/SKILL.md', on: true });
    const asAlpha = r.tools('alpha');
    const asBeta = r.tools('beta');
    const asGamma = r.tools('gamma');
    assert.match((await asAlpha('house_skills')).text, /plan[\s\S]*second-look|second-look[\s\S]*plan/, 'inherit sees both');
    const beta = (await asBeta('house_skills')).text;
    assert.match(beta, /No skills are turned on/, 'a list that names neither sees none');
    assert.equal((await asBeta('house_skill', { name: 'plan' })).isError, true);
    assert.equal((await asBeta('house_skill', { name: 'second-look' })).isError, true);
    const gamma = (await asGamma('house_skills')).text;
    assert.match(gamma, /plan/);
    assert.doesNotMatch(gamma, /second-look/);
    assert.equal((await asGamma('house_skill', { name: 'second-look' })).isError, true);
    assert.match(r.house.preamble!(r.a.agents.get('alpha')!), /plan/);
    assert.doesNotMatch(r.house.preamble!(r.a.agents.get('gamma')!), /second-look/);
    assert.doesNotMatch(r.house.preamble!(r.a.agents.get('beta')!), /turned on these skills/);
  });

  it('the effective list counts the same drills for each agent', async () => {
    const r = houseRig();
    await r.call('POST', '/api/house/drill', { name: 'plan', description: 'Plan first.', body: 'Step one.' });
    await r.call('POST', '/api/house/switch', { path: 'skills/yours/plan/SKILL.md', on: true });
    await r.call('POST', '/api/house/switch', { path: 'skills/review/second-look/SKILL.md', on: true });
    assert.equal((await r.a.call('GET', '/api/armory/effective?agent=alpha')).counts.drills, 2);
    assert.equal((await r.a.call('GET', '/api/armory/effective?agent=beta')).counts.drills, 0);
    const g = await r.a.call('GET', '/api/armory/effective?agent=gamma');
    assert.deepEqual(g.drills.map((d: any) => d.id), ['drill:yours/plan']);
  });
});

describe('promote an SDK-only Claude Code skill (the id has spaces)', () => {
  const sdk = (home: string) => {
    const root = join(home, 'plugins', 'synced', 'id-design');
    mkdirSync(join(root, 'skills', 'Agent Development'), { recursive: true });
    writeFileSync(join(root, 'skills', 'Agent Development', 'SKILL.md'), md('Agent Development', 'Build agents.', '', 'Agent body.'), 'utf8');
    return { skills: [{ name: 'design:Agent Development', description: 'Build agents.' }], commands: [], plugins: [{ name: 'design', path: root }], modelMessages: 0, costUsd: 0 };
  };
  const rig = (withCatalog: boolean) => {
    const home = tempDir('legion-cchome-');
    return houseRig({ sdkProbe: async () => sdk(home), cc: {} }, withCatalog);
  };

  it('is found in the same catalog the Armory lists and copied as a drill with a plain name', async () => {
    const r = rig(true);
    const view = await r.a.call('GET', '/api/armory');
    const hit = view.skills.find((s: any) => s.id === 'design:Agent Development');
    assert.ok(hit, 'the Armory lists it');
    const out = await r.call('POST', '/api/house/drill/promote', { armoryId: hit.id });
    assert.equal(out.path, 'skills/yours/agent-development/SKILL.md');
    assert.match(readFileSync(join(r.layer, 'skills', 'yours', 'agent-development', 'SKILL.md'), 'utf8'), /Agent body\./);
  });

  it('an unknown id answers in plain words without echoing the id', async () => {
    const r = rig(true);
    await r.a.call('GET', '/api/armory');
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', { armoryId: 'zzz-secret-id' }), (e: Error) => /not in the Armory any more/.test(e.message) && !/zzz-secret-id/.test(e.message));
  });

  it('refuses a skill file over the size cap before reading it, and writes nothing', async () => {
    const home = tempDir('legion-cchome-');
    const r = houseRig({ sdkProbe: async () => {
      const out = sdk(home);
      writeFileSync(join(out.plugins[0].path, 'skills', 'Agent Development', 'SKILL.md'), md('Agent Development', 'Build agents.', '', 'x'.repeat(HOUSE_LIMITS.maxFileBytes + 10)), 'utf8');
      return out;
    }, cc: {} }, true);
    await r.a.call('GET', '/api/armory');
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', { armoryId: 'design:Agent Development' }), /too large/);
    assert.equal(existsSync(join(r.layer, 'skills', 'yours', 'agent-development')), false);
  });

  it('refuses a skill file that is a link, and writes nothing', async (t) => {
    const home = tempDir('legion-cchome-');
    const target = join(tempDir('legion-linktarget-'), 'elsewhere.md');
    writeFileSync(target, md('Agent Development', 'Build agents.', '', 'Linked body.'), 'utf8');
    let linked = true;
    const r = houseRig({ sdkProbe: async () => {
      const out = sdk(home);
      const file = join(out.plugins[0].path, 'skills', 'Agent Development', 'SKILL.md');
      rmSync(file);
      try { symlinkSync(target, file, 'file'); } catch { linked = false; }
      return out;
    }, cc: {} }, true);
    await r.a.call('GET', '/api/armory');
    if (!linked) { t.skip('file symlinks need privilege on this machine'); return; }
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', { armoryId: 'design:Agent Development' }), /is a link/);
    assert.equal(existsSync(join(r.layer, 'skills', 'yours', 'agent-development')), false);
  });

  it('negative: a house module that builds its own catalog (the old behaviour) cannot find it', async () => {
    const r = rig(false);
    await r.a.call('GET', '/api/armory');
    await assert.rejects(() => r.call('POST', '/api/house/drill/promote', { armoryId: 'design:Agent Development' }), /not in the Armory any more/);
  });
});
