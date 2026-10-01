import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/core/kg/graph.js';
import { HUMAN } from '../src/core/kg/types.js';

test('R2-P1 episode: key / seed straddling the 300/800 cut is never stored (labelled key at cut, seed words after cut, secret beyond window)', () => {
  const g = new Graph({ dir: mkdtempSync(join(tmpdir(), 'r2p-')), secrets: () => ['sk-live-supersecretvalue123'] });
  const key = 'a1b2c3d4'.repeat(8);
  // a real BIP-39 test vector (the reviewer's first phrase has 4 words that are not on the official list; see library-review2-scrub)
  const P = 'army van defense carry jealous true garbage claim echo media make crunch';
  const cases = [
    { prompt: 'x'.repeat(280) + ' private key ' + key + ' tail', result: 'ok' },
    { prompt: 'ok', result: 'y'.repeat(780) + ' seed phrase: ' + P },
    { prompt: 'ok', result: 'z'.repeat(8100) + ' seed: ' + P },
    { prompt: 'x'.repeat(290) + 'sk-live-supersecretvalue123', result: 'ok' },
    { prompt: 'x'.repeat(250) + ' ' + P + ' ' + 'y'.repeat(100), result: 'ok' },
  ];
  const leaked: number[] = [];
  cases.forEach((c, i) => {
    g.recordEpisode({ taskId: `E${i}`, agentId: 'alpha', title: 't', status: 'done', turns: 9, costUsd: 1, prompt: c.prompt, result: c.result, tainted: false });
    const ep = g.allNodes(HUMAN).find((n) => n.id === `ep:E${i}` || n.title.includes(`E${i}`) || n.title.startsWith('Episode'));
    void ep;
  });
  const all = g.allNodes(HUMAN).map((n) => n.body + n.title).join('\n');
  if (all.includes(key.slice(0, 40))) leaked.push(1);
  if (all.includes('sk-live-supersecretvalue123')) leaked.push(4);
  if (all.includes('army van defense')) leaked.push(2);
  console.log('R2-P1 leaked case ids', JSON.stringify(leaked));
  assert.deepEqual(leaked, []);
});
