/**
 * Legion — knowledge graph contract ("the Lattice").
 * Owned by the integration lead. The kg module, HTTP routes, MCP tools and UI all speak these types.
 * See docs/KNOWLEDGE-GRAPH.md.
 */

/** Who can see a node. 'agent:<id>' is private to one bot, 'bsv' appears only while BSV mode is on. */
export type KgScope = 'shared' | 'bsv' | `agent:${string}`;

export type KgNodeType =
  | 'note' | 'entity' | 'concept' | 'task' | 'decision' | 'source' | 'code' | 'person' | 'lesson' | 'question';

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
}

export interface KgSubgraph {
  nodes: KgNode[];
  edges: KgEdge[];
  truncated: boolean;
}

export interface KgLintReport {
  orphans: string[];
  danglingEdges: string[];
  duplicateTitles: Array<{ title: string; ids: string[] }>;
  stale: Array<{ id: string; daysOld: number }>;
  contradictions: Array<{ a: string; b: string }>;
  untrustedWithoutReview: string[];
  counts: { nodes: number; edges: number };
}

export const KG_LIMITS = {
  bodyChars: 20_000,
  titleChars: 200,
  maxNodes: 50_000,
  maxDepth: 3,
  toolResultChars: 8_000,
} as const;
