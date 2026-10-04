/** Shared fixtures for the knowledge graph tests. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/core/kg/graph.js';
import type { GraphOptions } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import type { KgNode } from '../src/shared/kg.js';

export const ALPHA = agentActor('alpha');
export const BETA = agentActor('beta');
export { HUMAN };

export const tmpDir = (): string => cleanupTemp('legion-kg-');

export function mkGraph(opts: Partial<GraphOptions> = {}): { g: Graph; dir: string; file: string; bsv: { on: boolean } } {
  const dir = opts.dir ?? tmpDir();
  const bsv = { on: false };
  const g = new Graph({ dir, bsvEnabled: () => bsv.on, ...opts });
  return { g, dir, file: g.file, bsv };
}

/** Creates a shared note as the human and returns it. */
export function note(g: Graph, title: string, extra: Partial<Parameters<Graph['upsertNode']>[1]> = {}): KgNode {
  return g.upsertNode(HUMAN, { title, ...extra }).node;
}

export const logLines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean);
