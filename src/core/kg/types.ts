/** Internal types shared by the Lattice implementation (the public contract lives in src/shared/kg.ts). */
import { NODE_TYPES } from '../../shared/kg.js';
import type { KgNode, KgNodeType, KgScope, KgSource, KgEdge } from '../../shared/kg.js';
import type { TaskOrigin } from '../../shared/comms.js';
import type { ApprovalMode } from '../../shared/types.js';
import type { TaskQuota } from './quota.js';

/**
 * What the engine knows about the run an agent is acting in. The Graph reads it to enforce trust, taint and
 * quotas itself, so no caller (and no tool argument) can bypass them.
 */
export interface RunContext {
  taskId?: string;
  /** Set when another bot woke this run. */
  origin?: TaskOrigin;
  /** The approval ceiling inherited from the waking bot (undefined for a human-started run). */
  ceiling?: ApprovalMode;
  /** True once the run touched outside content. Sticky; read at every write. */
  taint?: () => boolean;
  quota?: TaskQuota;
}

/** Who is acting. Visibility and write rights derive from it. */
export type Actor = ({ kind: 'agent'; id: string } & RunContext) | { kind: 'human' } | { kind: 'system' };
export const HUMAN: Actor = { kind: 'human' };
export const SYSTEM: Actor = { kind: 'system' };
export const agentActor = (id: string, run: RunContext = {}): Actor => ({ kind: 'agent', id, ...run });
export const actorName = (a: Actor): string => (a.kind === 'agent' ? a.id : a.kind);
/** True when this agent's run is tainted (engine-observed) or was woken by a tainted chain. */
export const isTainted = (a: Actor): boolean => a.kind === 'agent' && (a.taint?.() === true || a.origin?.tainted === true);

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

export { NODE_TYPES };
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

export interface UpsertResult {
  node: KgNode; created: boolean; changed: boolean;
  /** Secret-looking strings that were redacted before saving. */
  redacted?: number;
  /** The write is waiting for the human (invisible to other agents until accepted). */
  pending?: boolean;
  /** The target was a node the bot may not edit directly: a pending copy that supersedes it was created instead. */
  proposalFor?: string;
  /** Why the write was held back or flagged (shown to the bot). */
  notes?: string[];
}
export interface LinkInput { from: string; to: string; rel: string; weight?: number; note?: string }
export interface LinkResult { edge: KgEdge; created: boolean; redacted?: number; notes?: string[] }

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
