/** What marks a run as having read outside text, end to end through the engine: shell commands by source, file reads by place, the reason, and the mark surviving a crash. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init, kg, ok, setup, toolUse, waitDone } from './library-fakes.js';
import type { TaintConfig } from '../src/shared/types.js';

type Step = { tool: string; input: Record<string, unknown> };

async function run(steps: Step[], taint?: Partial<TaintConfig>, prep?: (ws: string) => void) {
  let taskId = '';
  let storedMid: boolean | undefined;
  const s = setup((c) => (async function* () {
    yield init('s1');
    for (const [i, st] of steps.entries()) {
      yield toolUse(st.tool, `tu_${i}`, st.input);
      // let the engine see the call before we look at what it stored
      await new Promise((r) => setImmediate(r));
      if (i === 0) storedMid = s.store.getTask(taskId)?.tainted === true;
    }
    yield ok('d', 's1');
  })());
  if (taint) s.config.taint = { shell: 'local', outsideFiles: true, noticeSeen: false, ...taint };
  prep?.(join(s.config.workspaceDir, 'alpha'));
  const started = s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' });
  taskId = started.id;
  const t = await waitDone(s, started);
  return { t, storedMid, s };
}

describe('outside text through the engine', () => {
  it('E1: local shell commands leave a run clean by default, and mark it in strict mode', async () => {
    assert.equal((await run([{ tool: 'Bash', input: { command: 'git status' } }, { tool: 'Bash', input: { command: 'rg foo' } }])).t.tainted, undefined);
    const strict = await run([{ tool: 'Bash', input: { command: 'git status' } }], { shell: 'strict' });
    assert.equal(strict.t.tainted, true);
  });

  it('E2: a command that reaches the network marks the run, with the reason stored', async () => {
    const r = await run([{ tool: 'Bash', input: { command: 'curl https://example.com' } }]);
    assert.equal(r.t.tainted, true);
    assert.match(r.t.taintedBy ?? '', /network/);
  });

  it('E3: a file read outside the agent folder marks the run; inside it does not; the switch turns it off', async () => {
    const prep = (ws: string) => { mkdirSync(join(ws, 'src'), { recursive: true }); writeFileSync(join(ws, 'src', 'a.ts'), 'x'); };
    const inside = await run([{ tool: 'Read', input: { file_path: 'src/a.ts' } }], undefined, prep);
    assert.equal(inside.t.tainted, undefined);
    const outside = await run([{ tool: 'Read', input: { file_path: join(inside.s.dir, 'elsewhere.txt') } }], undefined, prep);
    assert.equal(outside.t.tainted, true);
    assert.match(outside.t.taintedBy ?? '', /outside/);
    const off = await run([{ tool: 'Read', input: { file_path: join(inside.s.dir, 'elsewhere.txt') } }], { outsideFiles: false }, prep);
    assert.equal(off.t.tainted, undefined);
  });

  it('E4: the mark is stored the moment it is set, not only when the run ends (a crash cannot lose it)', async () => {
    const r = await run([{ tool: 'Bash', input: { command: 'curl https://example.com' } }]);
    assert.equal(r.storedMid, true);
  });

  it('E5: tools that were tainting before still taint (web, unknown tools), and clean tools stay clean', async () => {
    assert.equal((await run([{ tool: 'WebFetch', input: { url: 'https://example.com' } }])).t.tainted, true);
    assert.equal((await run([{ tool: 'mcp__someone__tool', input: {} }])).t.tainted, true);
    assert.equal((await run([{ tool: 'Edit', input: { file_path: 'a.ts' } }])).t.tainted, undefined);
  });

  it('E6: a test run marks the run only when a run that read outside text left files in the project', async () => {
    const before = await run([{ tool: 'Bash', input: { command: 'npm test' } }]);
    assert.equal(before.t.tainted, undefined);
    const g = session();
    assert.equal((await g.go([{ tool: 'Bash', input: { command: 'npm test' } }])).tainted, undefined, 'nothing written yet');
    // a run that read the web writes a test file, which marks it
    assert.equal((await g.go([{ tool: 'WebFetch', input: { url: 'https://example.com' } }, { tool: 'Write', input: { file_path: 'a.test.ts', content: 'x' } }])).tainted, true);
    assert.equal((await g.go([{ tool: 'Bash', input: { command: 'npm test' } }])).tainted, true, 'a clean run now runs code a marked run wrote');
    assert.equal((await g.go([{ tool: 'Bash', input: { command: 'git status' } }])).tainted, undefined, 'a local command still does not mark');
  });

  it('E7: files an earlier marked run wrote do not mark a later run that only lists, globs or lists matching files', async () => {
    const g = session();
    await g.go([{ tool: 'WebFetch', input: { url: 'https://example.com' } }, { tool: 'Write', input: { file_path: 'src/x.ts', content: 'x' } }]);
    for (const step of [{ tool: 'Glob', input: { pattern: '**/*.ts' } }, { tool: 'LS', input: { path: '.' } }, { tool: 'Grep', input: { pattern: 'x' } }, { tool: 'Grep', input: { pattern: 'x', output_mode: 'files_with_matches' } }]) {
      assert.equal((await g.go([step])).tainted, undefined, JSON.stringify(step));
    }
  });

  it('E8: reading the marked file itself, or searching with contents shown, marks the later run', async () => {
    const g = session();
    await g.go([{ tool: 'WebFetch', input: { url: 'https://example.com' } }, { tool: 'Write', input: { file_path: 'src/x.ts', content: 'x' } }]);
    assert.equal((await g.go([{ tool: 'Read', input: { file_path: 'src/x.ts' } }])).tainted, true);
    assert.equal((await g.go([{ tool: 'Grep', input: { pattern: 'x', output_mode: 'content' } }])).tainted, true);
  });

  it('E9: the output of a background shell, read back, does not mark the run (strict mode still does)', async () => {
    const g = session();
    assert.equal((await g.go([{ tool: 'Bash', input: { command: 'npm test', run_in_background: true } }, { tool: 'BashOutput', input: { bash_id: 'b1' } }])).tainted, undefined);
    g.s.config.taint = { shell: 'strict', outsideFiles: true, noticeSeen: false };
    assert.equal((await g.go([{ tool: 'BashOutput', input: { bash_id: 'b1' } }])).tainted, true);
  });

  it('E10: the stored reason is a fixed phrase and never holds command text', async () => {
    const r = await run([{ tool: 'Bash', input: { command: 'curl -H "Authorization: Bearer sekret-123" https://example.com' } }]);
    assert.equal(r.t.tainted, true);
    assert.doesNotMatch(r.t.taintedBy ?? '', /sekret|Authorization|example/);
  });
});

describe('what a marked run is refused', () => {
  it('E11: after local commands a run may write working memory; after a network command it is refused and the refusal names the cause', async () => {
    const out: Record<string, { isError: boolean; text: string }> = {};
    const s = setup((c) => c.agent !== 'alpha' ? undefined : (async function* () {
      yield init('s1');
      yield toolUse('Bash', 'b1', { command: 'git status' });
      yield toolUse('Bash', 'b2', { command: 'npm test' });
      out.clean = await kg(c.options, 'kg_wm_set', { active: 'plan: fix the parser' });
      yield toolUse('Bash', 'b3', { command: 'gh pr view 12' });
      out.marked = await kg(c.options, 'kg_wm_set', { active: 'plan: something else' });
      yield ok('d', 's1');
    })());
    await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.equal(out.clean!.isError, false, out.clean!.text);
    assert.equal(out.marked!.isError, true);
    assert.match(out.marked!.text, /marked by: a command Legion cannot check/);
  });
});

/** One engine, several runs: the marks a run leaves in the workspace are still there for the next one. */
function session() {
  let steps: Step[] = [];
  const s = setup((c) => (async function* () {
    yield init('s1');
    for (const [i, st] of steps.entries()) { yield toolUse(st.tool, `tu_${i}`, st.input); await new Promise((r) => setImmediate(r)); }
    yield ok('d', 's1');
  })());
  return {
    s,
    go: async (next: Step[]) => { steps = next; return waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' })); },
  };
}
