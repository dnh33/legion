/** Internal types shared by the Lattice implementation (the public contract lives in src/shared/kg.ts). */
import type { KgNode, KgNodeType, KgScope, KgSource, KgEdge } from '../../shared/kg.js';

/** Who is acting. Visibility and write rights derive from it. */
export type Actor = { kind: 'agent'; id: string } | { kind: 'human' } | { kind: 'system' };
export const HUMAN: Actor = { kind: 'human' };
export const SYSTEM: Actor = { kind: 'system' };
export const agentActor = (id: string): Actor => ({ kind: 'agent', id });
export const actorName = (a: Actor): string => (a.kind === 'agent' ? a.id : a.kind);

export type KgErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'limit' | 'unavailable' | 'unprocessable';
const STATUS: Record<KgErrorCode, number> = {
  invalid: 400, not_found: 404, forbidden: 403, conflict: 409, limit: 409, unavailable: 503, unprocessable: 422,
};

/** Every expected failure of the graph. Tools turn it into an error result, routes into an HttpError. */
export class KgError extends Error {
  readonly status: number;
  constructor(public readonly code: KgErrorCode, message: string) {
    super(message);
    this.name = 'KgError';
    this.status = STATUS[code];
  }
}

export const NODE_TYPES: readonly KgNodeType[] = [
  'note', 'entity', 'concept', 'task', 'decision', 'source', 'code', 'person', 'lesson', 'question',
];
export const isNodeType = (v: unknown): v is KgNodeType => typeof v === 'string' && (NODE_TYPES as readonly string[]).includes(v);

/** Input of upsertNode. On create `title` is required; on update (id exists) only given fields change. */
export interface NodeInput {
  id?: string;
  type?: KgNodeType;
  title?: string;
  body?: string;
  tags?: string[];
  scope?: KgScope;
  props?: Record<string, string | number | boolean>;
  sources?: KgSource[];
  confidence?: number;
  /** Flags every source given in this call as untrusted (web, email, files, chain data). Needs `sources`. */
  untrusted?: boolean;
}

export interface UpsertResult { node: KgNode; created: boolean; changed: boolean }
export interface LinkInput { from: string; to: string; rel: string; weight?: number; note?: string }
export interface LinkResult { edge: KgEdge; created: boolean }

export interface NeighborsResult {
  start: KgNode;
  nodes: Array<{ node: KgNode; depth: number }>;
  edges: KgEdge[];
  truncated: boolean;
}
export interface PathResult { found: boolean; nodes: KgNode[]; edges: KgEdge[] }
export interface RecallResult { outline: string; nodeIds: string[]; truncated: boolean }

export interface GraphStats {
  nodes: number;
  edges: number;
  byType: Record<string, number>;
  byScope: Record<string, number>;
}

export interface ImportReport {
  files: number;
  created: number;
  updated: number;
  unchanged: number;
  edges: number;
  stubs: number;
  skipped: Array<{ path: string; reason: string }>;
}
export interface ExportReport { dir: string; written: number; removedStale: number }
