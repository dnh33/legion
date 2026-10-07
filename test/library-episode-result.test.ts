/**
 * BUG-3: an episode kept 800 characters of its task's result and nothing more. It now links to the full text
 * (`task:<id>#result`), which kg_get follows from the task store, through the secret guard, in pages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EPISODE_RESULT_CHARS } from '../src/core/kg/graph.js';
import { HUMAN } from '../src/core/kg/types.js';
import { init, kg, ok, setup, waitDone } from './library-fakes.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnop1234';
const SENTINEL = '<<END-OF-RESEARCH>>';
// a result of ~20,000 characters; the secret sits at about 15,000, far past the window the episode summary looks at
const LONG = `${'research line. '.repeat(1000)}key ${SECRET} ${'more findings. '.repeat(330)}${SENTINEL}`;

/** Runs one long task for alpha, then returns a handle to read as alpha (or beta) in a later run. */
async function withEpisode(result = LONG) {
  const reader: Record<string, any> = {};
  const s = setup((c) => {
    if (c.prompt.includes('read-as')) {
      return (async function* () { yield init(`r-${c.agent}`); reader[c.agent] = c.options; yield ok('read', `r-${c.agent}`); })();
    }
    return c.agent === 'alpha' ? (async function* () { yield init('a1'); yield ok(result, 'a1', { num_turns: 10 }); })() : undefined;
  });
  const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'research it', source: 'ui' }));
  for (const agentId of ['alpha', 'beta']) await waitDone(s, s.engine.startTask({ agentId, prompt: `read-as ${agentId}`, source: 'ui' }));
  return { s, t, reader };
}

async function pageThrough(options: any, ref: string) {
  const parts: string[] = [];
  let offset = 0;
  for (let i = 0; i < 40; i++) {
    const r = await kg(options, 'kg_get', { id: ref, offset });
    assert.equal(r.isError, false, r.text);
    const m = /\(characters (\d+)-(\d+) of (\d+)\)/.exec(r.text)!;
    const body = /<kg-node [^>]*>\n([\s\S]*?)\n<\/kg-node>/.exec(r.text)!;
    parts.push(body[1]!.replace(/^\[UNTRUSTED[^\]]*\]\s?/, ''));
    offset = Number(m[2]);
    if (offset >= Number(m[3])) break;
  }
  return parts;
}

test('the episode keeps its short body and a link; kg_get follows the link to the whole result, scrubbed, in pages', async () => {
  const { s, t, reader } = await withEpisode();
  const e = s.graph.getNode(HUMAN, `ep:${t.id}`)!;
  assert.deepEqual(e.sources, [{ ref: `task:${t.id}`, untrusted: true }, { ref: `task:${t.id}#result`, untrusted: true }]);
  const resultPart = /Result: ([\s\S]*?)\n\n\(/.exec(e.body)![1]!;
  assert.ok(resultPart.length <= EPISODE_RESULT_CHARS + 20, 'the node stays short');
  assert.match(e.body, new RegExp(`\\(${LONG.length} characters in all\\. Full result: kg_get task:${t.id}#result\\)`));
  const parts = await pageThrough(reader.alpha, `task:${t.id}#result`);
  const all = parts.join('');
  assert.ok(parts.length >= 3);
  assert.ok(all.includes(SENTINEL), 'the tail of the 20,000 characters arrived');
  assert.doesNotMatch(all, /sk-ant/, 'the secret far past the summary window is scrubbed too');
  assert.match(all, /\[redacted/);
  assert.ok(all.length >= LONG.length - SECRET.length, `all ${all.length}`);
  const first = await kg(reader.alpha, 'kg_get', { id: `task:${t.id}#result` });
  assert.match(first.text, /<kg-node id="ep:task_\w+" created-by="system" untrusted="true">/, 'wrapped as an untrusted node');
  assert.match(first.text, /data/i);
});

test('a seed phrase anywhere in the full text withholds all of it', async () => {
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const { s, t, reader } = await withEpisode(`${'finding. '.repeat(1200)} ${phrase} ${'tail. '.repeat(50)}`);
  void s;
  const r = await kg(reader.alpha, 'kg_get', { id: `task:${t.id}#result` });
  assert.equal(r.isError, true);
  assert.match(r.text, /withheld/);
  assert.doesNotMatch(r.text, /abandon/);
});

test('the link is no key: another agent, a task without an episode and a forged ref all get the same refusal', async () => {
  const { s, t, reader } = await withEpisode();
  // beta cannot see alpha's private episode, so it cannot read alpha's result through it
  const other = await kg(reader.beta, 'kg_get', { id: `task:${t.id}#result` });
  assert.equal(other.isError, true);
  assert.match(other.text, /Unknown node/);
  assert.doesNotMatch(other.text, /research line/);
  // a task that exists but has no episode (the reader task itself: short, no episode)
  const plain = s.store.listTasks(20, 'alpha', true).find((x) => x.id !== t.id)!;
  assert.ok(plain.result);
  const none = await kg(reader.alpha, 'kg_get', { id: `task:${plain.id}#result` });
  assert.equal(none.isError, true);
  assert.match(none.text, /Unknown node/);
  // ids that are not task ids at all fall through to the normal node lookup
  for (const id of ['task:../x#result', 'task:#result', 'task:a b#result']) assert.equal((await kg(reader.alpha, 'kg_get', { id })).isError, true, id);
});

test('a task whose result is gone says so, not "unknown"', async () => {
  const { s, t, reader } = await withEpisode();
  s.store.upsertTask({ ...s.store.getTask(t.id)!, result: undefined });
  const r = await kg(reader.alpha, 'kg_get', { id: `task:${t.id}#result` });
  assert.equal(r.isError, true);
  assert.match(r.text, /no longer stored/);
});

test('reading the result of a tainted task through the link taints the reader; a ref that fails the episode check does not', async () => {
  const { s, t, reader } = await withEpisode();
  const readerTask = s.store.listTasks(20, 'alpha', true).find((x) => x.id !== t.id)!;
  assert.equal(s.engine.isTainted(readerTask.id), false);
  // the reader run is over, so mark through a live-looking stored row: isTainted reads the stored flag too
  s.engine.markTainted(t.id);
  await kg(reader.alpha, 'kg_get', { id: 'task:task_nothere#result' });
  assert.equal(s.engine.isTainted(readerTask.id), false, 'a refused ref reads nothing and taints nothing');
  await kg(reader.alpha, 'kg_get', { id: `task:${t.id}#result` });
  assert.equal(s.engine.isTainted(readerTask.id), true, 'the tainted text came into the reader');
});
