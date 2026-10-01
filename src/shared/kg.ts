/**
 * Legion — knowledge graph contract ("the Lattice").
 * Owned by the integration lead. The kg module, HTTP routes, MCP tools and UI all speak these types.
 * See docs/KNOWLEDGE-GRAPH.md.
 */

/** Who can see a node. 'agent:<id>' is private to one bot, 'bsv' appears only while BSV mode is on. */
export type KgScope = 'shared' | 'bsv' | `agent:${string}`;

/** The single list of node types: tools, validation and the type itself all derive from it. */
export const NODE_TYPES = [
  'note', 'entity', 'concept', 'task', 'decision', 'source', 'code', 'person', 'lesson', 'question',
  'mistake', 'pattern', 'project', 'memory', 'idea', 'episode',
] as const;
export type KgNodeType = (typeof NODE_TYPES)[number];

/**
 * Who stands behind a node. Engine-derived, never taken from agent input:
 * 'human' = written or accepted by the human, 'agent' = written by a bot in a clean run,
 * 'untrusted' = flagged untrusted or written by a run that touched outside content (web, shell, external tools).
 */
export type KgTrust = 'human' | 'agent' | 'untrusted';
/** 'pending' waits for the human (invisible to other agents), 'archived' is a tombstone. A missing status means active. */
export type KgStatus = 'active' | 'pending' | 'superseded' | 'archived';
/** Which task wrote the node, and whether that task was tainted. `via` names the bot that woke it, if any. */
export interface KgOrigin { taskId: string; tainted: boolean; via?: string }

/** Edge vocabulary. Free-form rels are allowed but these are preferred and listed in tool help. */
export const KG_RELS = [
  'relates', 'depends_on', 'part_of', 'cites', 'supersedes', 'contradicts',
  'derived_from', 'mentions', 'teaches', 'blocks', 'answers',
] as const;
export type KgRel = (typeof KG_RELS)[number] | (string & {});

export interface KgSource {
  /** URL, file path, task id or free text. */
  ref: string;
  licence?: string;
  /** True when the content came from the web, email, chain data or other untrusted input. */
  untrusted?: boolean;
}

export interface KgNode {
  id: string;
  type: KgNodeType;
  title: string;
  /** Markdown, max 20,000 chars. May contain [[wikilinks]] by title; the importer turns them into edges. */
  body: string;
  tags: string[];
  scope: KgScope;
  props?: Record<string, string | number | boolean>;
  sources?: KgSource[];
  /** 0..1, how sure the author was. */
  confidence?: number;
  /** Engine-derived. Missing on older nodes: read it with trustOf(). */
  trust?: KgTrust;
  /** Engine-derived. Missing means active. */
  status?: KgStatus;
  supersededBy?: string;
  origin?: KgOrigin;
  /** Agent id, 'human', or 'system'. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface KgEdge {
  id: string;
  from: string;
  to: string;
  rel: KgRel;
  weight?: number;
  note?: string;
  createdBy: string;
  createdAt: string;
}

export interface KgSearchHit {
  node: Pick<KgNode, 'id' | 'type' | 'title' | 'tags' | 'scope' | 'updatedAt'> & { snippet: string };
  score: number;
  /** Only set on hits of a non-active node, which search returns only when asked (includeInactive). */
  inactive?: { status: KgStatus; supersededBy?: string };
}

export interface KgSubgraph {
  nodes: KgNode[];
  edges: KgEdge[];
  truncated: boolean;
}

/** What the nightly lint-lite pass did and found (no model calls; see Graph.lintLite). */
export interface KgLintLite {
  at: string;
  /** Episodes older than 30 days that were retired (tombstoned). */
  expiredEpisodes: number;
  /** Tombstones past their 30 days that were removed for good. */
  purgedTombstones: number;
  /** Nodes past their per-type time-to-live that nobody touched (flagged, never changed). */
  stale: number;
  staleIds: string[];
  /** Activity entries older than 7 days that were dropped (they can no longer be undone). */
  prunedActivity: number;
  /** Notes waiting for the human. */
  pending: number;
}

export interface KgLintReport {
  orphans: string[];
  danglingEdges: string[];
  duplicateTitles: Array<{ title: string; ids: string[] }>;
  stale: Array<{ id: string; daysOld: number }>;
  contradictions: Array<{ a: string; b: string }>;
  untrustedWithoutReview: string[];
  counts: { nodes: number; edges: number };
  /** The last nightly lint-lite run, once there was one. */
  lite?: KgLintLite;
}

/** One row of the human's inbox: a note, edit proposal or supersede/merge proposal waiting for a decision. */
export interface KgInboxRow {
  id: string;
  kind: 'note' | 'edit' | 'supersede' | 'merge';
  /** The bot that wrote it. */
  agentId: string;
  node: KgNode;
  /** The note an edit would replace (kind 'edit'). */
  target?: KgNode;
  tainted: boolean;
  /** True when the note is untrusted or has an untrusted source: bulk accept skips it. */
  untrusted: boolean;
  createdAt: string;
}

/** One write in the Activity list. */
export interface KgActivityRow {
  id: string;
  at: string;
  /** Agent id, or 'system'. */
  who: string;
  taskId?: string;
  kind: string;
  nodeId?: string;
  nodeType?: KgNodeType;
  title?: string;
  trust?: KgTrust;
  tainted: boolean;
  /** Within 7 days and not undone yet. */
  undoable: boolean;
  undone: boolean;
  /** Set when an Undo would be refused: past the 7-day window, too large to keep undo data for, or a note changed since. */
  blocked?: 'expired' | 'too_large' | 'changed';
}

export const KG_LIMITS = {
  bodyChars: 20_000,
  titleChars: 200,
  maxNodes: 50_000,
  maxDepth: 3,
  toolResultChars: 8_000,
} as const;
