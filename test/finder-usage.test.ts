/** Skill finder usage record: loads, suggestions, ignores, the boost, the file cap and the onToolUse input. Invented ids only. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUsageStore, skillIdOfLoad } from '../src/core/armory/finder/usage.js';
import type { CoreModule } from '../src/core/modules.js';
import { mkAgent, ok, init, setup, toolUse, waitDone } from './library-fakes.js';
import { tempDir } from './tmp-cleanup.js';
import { armoryRig, own } from './armory-rig.js';
import type { Task } from '../src/shared/types.js';

/** A clock that moves one millisecond per call, so the newest-first order is exact. */
function tickingClock(startMs = Date.UTC(2026, 9, 17)): () => number {
  let t = startMs;
  return () => (t += 1);
}

const usagePath = (dir: string) => join(dir, 'skill-finder', 'usage.json');

describe('boostFor: the formula', () => {
  it('is 1 + 0.15 * ln(1 + loads) for a skill that was only loaded', () => {
    const dir = tempDir('finder-usage-');
    const store = createUsageStore(dir);
    store.noteLoaded('alpha', 'pdf');
    store.noteLoaded('alpha', 'pdf');
    store.noteLoaded('alpha', 'pdf');
    const boost = store.boostFor('alpha')('pdf');
    assert.ok(Math.abs(boost - (1 + 0.15 * Math.log(4))) < 1e-12, `got ${boost}`);
  });

  it('takes 0.05 off for each ignore, with the ignore count capped at 6', () => {
    const dir = tempDir('finder-usage-');
    const store = createUsageStore(dir);
    store.noteIgnored('alpha', ['docx']);
    store.noteIgnored('alpha', ['docx']);
    assert.ok(Math.abs(store.boostFor('alpha')('docx') - 0.9) < 1e-12);
    for (let i = 0; i < 10; i++) store.noteIgnored('alpha', ['docx']);
    assert.ok(Math.abs(store.boostFor('alpha')('docx') - 0.7) < 1e-12, 'capped at 6 ignores: 1 - 0.3');
  });

  it('never goes below 0.7, however many ignores', () => {
    const dir = tempDir('finder-usage-');
    const store = createUsageStore(dir);
    for (let i = 0; i < 50; i++) store.noteIgnored('alpha', ['xlsx']);
    assert.equal(store.boostFor('alpha')('xlsx') >= 0.7, true);
  });

  it('is exactly 1 for a skill with no record, and reads only the asked agent', () => {
    const dir = tempDir('finder-usage-');
    const store = createUsageStore(dir);
    store.noteLoaded('alpha', 'pdf');
    assert.equal(store.boostFor('alpha')('never-seen'), 1);
    assert.equal(store.boostFor('beta')('pdf'), 1, 'beta has no record of pdf');
  });

  it('sees writes made after boostFor was called through a new store on the same folder', () => {
    const dir = tempDir('finder-usage-');
    createUsageStore(dir).noteLoaded('alpha', 'pdf');
    const boost = createUsageStore(dir).boostFor('alpha');
    assert.ok(boost('pdf') > 1);
  });
});

describe('the per-agent cap and the file cap', () => {
  it('keeps the 500 newest skills per agent and drops the oldest', () => {
    const dir = tempDir('finder-usage-');
    const store = createUsageStore(dir, tickingClock());
    const ids = Array.from({ length: 510 }, (_, i) => `skill-${i}`);
    store.noteSuggested('alpha', ids); // one write; the clock still moves per record, so the order is exact
    const again = createUsageStore(dir);
    const kept = again.boostFor('alpha');
    assert.equal(kept('skill-0'), 1, 'oldest dropped');
    assert.equal(kept('skill-9'), 1, 'oldest dropped');
    const raw = JSON.parse(readFileSync(usagePath(dir), 'utf8'));
    assert.equal(Object.keys(raw.alpha).length, 500);
    assert.ok('skill-509' in raw.alpha, 'newest kept');
    assert.ok('skill-10' in raw.alpha, 'oldest kept after the cut');
    assert.ok(!('skill-9' in raw.alpha));
  });

  it('keeps the usage file under 1 MB, whatever the ids are', () => {
    const dir = tempDir('finder-usage-');
    const store = createUsageStore(dir, tickingClock());
    const long = 'x'.repeat(2000);
    store.noteSuggested('alpha', Array.from({ length: 600 }, (_, i) => `${long}-a${i}`));
    store.noteSuggested('beta', Array.from({ length: 600 }, (_, i) => `${long}-b${i}`));
    assert.ok(statSync(usagePath(dir)).size <= 1_000_000, `size ${statSync(usagePath(dir)).size}`);
  });
});

describe('a corrupt usage file', () => {
  it('starts empty and never throws', () => {
    const dir = tempDir('finder-usage-');
    mkdirSync(join(dir, 'skill-finder'), { recursive: true });
    writeFileSync(usagePath(dir), '{ this is not json');
    const store = createUsageStore(dir);
    assert.equal(store.boostFor('alpha')('pdf'), 1);
    assert.doesNotThrow(() => store.noteLoaded('alpha', 'pdf'));
    assert.ok(JSON.parse(readFileSync(usagePath(dir), 'utf8')).alpha.pdf.loads === 1, 'the next write makes a valid file');
  });

  it('treats a file that is valid JSON but not an object as empty', () => {
    const dir = tempDir('finder-usage-');
    mkdirSync(join(dir, 'skill-finder'), { recursive: true });
    writeFileSync(usagePath(dir), '[1, 2, 3]');
    assert.equal(createUsageStore(dir).boostFor('alpha')('pdf'), 1);
  });

  it('drops a malformed entry and keeps the good ones', () => {
    const dir = tempDir('finder-usage-');
    mkdirSync(join(dir, 'skill-finder'), { recursive: true });
    writeFileSync(usagePath(dir), JSON.stringify({ alpha: { good: { loads: 2, suggested: 0, ignored: 0, lastAt: '2026-10-17T00:00:00.000Z' }, bad: { loads: 'lots' } } }));
    const boost = createUsageStore(dir).boostFor('alpha');
    assert.ok(Math.abs(boost('good') - (1 + 0.15 * Math.log(3))) < 1e-12);
    assert.equal(boost('bad'), 1);
  });
});

describe('skillIdOfLoad', () => {
  it('reads input.skill for the Claude Skill tool', () => {
    assert.equal(skillIdOfLoad('Skill', { skill: 'pdf' }), 'pdf');
    assert.equal(skillIdOfLoad('Skill', { skill: 'engineering:code-review' }), 'engineering:code-review');
  });

  it('reads input.id for the provider armory_skill tool, bare or prefixed', () => {
    assert.equal(skillIdOfLoad('armory_skill', { id: 'pdf' }), 'pdf');
    assert.equal(skillIdOfLoad('mcp__legion_armory__armory_skill', { id: 'pdf' }), 'pdf');
  });

  it('returns undefined for other tools and for bad input', () => {
    assert.equal(skillIdOfLoad('Read', { file_path: '/x' }), undefined);
    assert.equal(skillIdOfLoad('Skill', {}), undefined);
    assert.equal(skillIdOfLoad('Skill', { skill: '' }), undefined);
    assert.equal(skillIdOfLoad('Skill', { skill: 7 }), undefined);
    assert.equal(skillIdOfLoad('armory_skill', undefined), undefined);
    assert.equal(skillIdOfLoad('Skill', null), undefined);
  });
});

describe('onToolUse input passthrough', () => {
  it('hands the engine tool input to a module as the fourth argument', async () => {
    const seen: Array<{ tool: string; input: unknown }> = [];
    const spy: CoreModule = {
      id: 'spy',
      onToolUse: (_agentId, _taskId, tool, input) => { seen.push({ tool, input }); },
    };
    const s = setup((c) => c.agent !== 'alpha' ? undefined : (async function* () {
      yield init('a1');
      yield toolUse('Skill', 'tu_skill_1', { skill: 'pdf' });
      yield ok('done', 'a1');
    })(), { modules: [spy], agents: [mkAgent('alpha', 'Alpha')] });
    const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'make a pdf', source: 'ui' }));
    assert.equal(t.status, 'done');
    const skillSeen = seen.find((x) => x.tool === 'Skill');
    assert.ok(skillSeen, 'the module saw the Skill tool use');
    assert.deepEqual(skillSeen.input, { skill: 'pdf' });
  });
});


describe('usage follows the switches', () => {
  const DONE = { status: 'done' as const, isError: false, tainted: false };
  const stub = (id: string) => ({ id }) as Task;
  const record = (dir: string, agent: string, skill: string) => (JSON.parse(readFileSync(usagePath(dir), 'utf8')) as Record<string, Record<string, { loads: number; suggested: number; ignored: number }>>)[agent]?.[skill];

  it('an agent whose finder is off records no usage at all; a normal agent does', async () => {
    const rig = armoryRig();
    const s = await own(rig, { name: 'pdf-tool', description: 'Make PDF files', body: 'b' });
    rig.agents.get('alpha')!.skillFinder = 'off';
    const alpha = rig.agents.get('alpha')!;
    rig.mod.onToolUse!('alpha', 't1', 'Skill', { skill: s.id });
    rig.mod.noteShown!('alpha', 't1', [s.id]);
    rig.mod.onTaskEnd!(stub('t1'), alpha, DONE);
    assert.throws(() => statSync(usagePath(rig.dataDir)), 'no usage.json for an agent that is off');
    rig.mod.onToolUse!('beta', 't2', 'Skill', { skill: s.id });
    assert.equal(record(rig.dataDir, 'beta', s.id)?.loads, 1, 'the same call for an agent with the search tool on is kept');
  });

  it('with the search tool and suggestions both off for the Armory, nothing is recorded', async () => {
    const rig = armoryRig();
    const s = await own(rig, { name: 'pdf-tool', description: 'Make PDF files', body: 'b' });
    await rig.call('POST', '/api/armory/finder', { searchTool: false, suggest: false });
    rig.mod.onToolUse!('beta', 't1', 'Skill', { skill: s.id });
    assert.throws(() => statSync(usagePath(rig.dataDir)));
  });

  it('a task that began with the finder on and ended with it off records no ignores', async () => {
    const rig = armoryRig();
    const s = await own(rig, { name: 'pdf-tool', description: 'Make PDF files', body: 'b' });
    const beta = rig.agents.get('beta')!;
    rig.mod.noteShown!('beta', 't1', [s.id]);
    assert.equal(record(rig.dataDir, 'beta', s.id)?.suggested, 1, 'recorded while on');
    beta.skillFinder = 'off';
    rig.mod.onTaskEnd!(stub('t1'), beta, DONE);
    assert.equal(record(rig.dataDir, 'beta', s.id)?.ignored, 0, 'the end of the task, with the finder off, adds nothing');
  });

  it('with three suggested and one loaded, the other two are not ignored; with none loaded, all three are', async () => {
    const rig = armoryRig();
    const ids = [] as string[];
    for (const n of ['sk-one', 'sk-two', 'sk-three']) ids.push((await own(rig, { name: n, description: `Skill ${n}`, body: 'b' })).id);
    const beta = rig.agents.get('beta')!;
    rig.mod.noteShown!('beta', 't1', ids);
    rig.mod.onToolUse!('beta', 't1', 'Skill', { skill: ids[0] });
    rig.mod.onTaskEnd!(stub('t1'), beta, DONE);
    assert.equal(record(rig.dataDir, 'beta', ids[0]!)?.loads, 1);
    assert.equal(record(rig.dataDir, 'beta', ids[1]!)?.ignored ?? 0, 0, 'the second-ranked skill is not penalised');
    assert.equal(record(rig.dataDir, 'beta', ids[2]!)?.ignored ?? 0, 0);
    rig.mod.noteShown!('beta', 't2', ids);
    rig.mod.onTaskEnd!(stub('t2'), beta, DONE);
    for (const id of ids) assert.equal(record(rig.dataDir, 'beta', id)?.ignored, 1, `${id} passed over when nothing was loaded`);
  });
});
