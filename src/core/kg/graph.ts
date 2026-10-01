/**
 * The Lattice graph store: an append-only JSONL event log loaded into in-memory indexes
 * (id map, adjacency, inverted token index). Synchronous, no dependencies, unit-testable on a temp dir.
 * Visibility and write rules are enforced here, so no caller can bypass them.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { KG_LIMITS } from '../../shared/kg.js';
import type {
  KgActivityRow, KgEdge, KgInboxRow, KgLintLite, KgLintReport, KgNode, KgNodeType, KgOrigin, KgScope, KgSearchHit, KgSource, KgStatus,
  KgSubgraph, KgTrust,
} from '../../shared/kg.js';
import { newId, nowIso } from '../../shared/util.js';
import { findForbiddenSecretInField, scrubSecrets } from '../comms/scrub.js';
import { ActivityLog, ACTIVITY_DAYS } from './activity.js';
import type { ActivityEntry, LogOp } from './activity.js';
import { bulkHold } from '../../shared/kg-library.js';
import {
  clipCp, effectiveTrust, guarded, isInactive, makeSnippet, oneLine, rankFactor, safeTitle, shownTitle, statusOf, tokenize, trustOf, wrapNode,
  DATA_LINE, isUntrusted,
} from './text.js';
import { actorName, ARCHIVIST_ID, agentActor, HUMAN, isNodeType, isTainted, KgError, SYSTEM, WM_PREFIX, wmId } from './types.js';
import type {
  Actor, BriefingParts, CaptureInput, CaptureResult, GraphStats, LinkInput, LinkResult, MergeResult, NeighborsResult, NodeInput, PathResult,
  RecallResult, SupersedeResult, UpsertResult,
} from './types.js';

export interface GraphOptions {
  /** Directory that holds graph.jsonl (created if missing). */
  dir: string;
  bsvEnabled?: () => boolean;
  now?: () => Date;
  /** Compaction only runs when the log is at least this big (default 1 MiB). */
  compactMinBytes?: number;
  /** Called after every write with the ids that changed. */
  onChange?: (changed: string[]) => void;
  /** Live secret values (config tokens) that are redacted from anything written. Read at every write. */
  secrets?: () => readonly string[];
}

export interface SearchOptions {
  scope?: string; type?: string; tags?: string[]; limit?: number;
  /** Also return superseded and archived nodes (score x0.3, marked). Off by default. */
  includeInactive?: boolean;
}
export interface NeighborOptions { rel?: string; dir?: 'out' | 'in' | 'both'; depth?: number; limit?: number }
export interface PathOptions { maxDepth?: number; rels?: string[] }
export interface RecallEntry { id: string; score: number; seed: boolean; via?: { rel: string; dir: 'out' | 'in'; seedId: string }; snippet?: string }

const STALE_DAYS = 90;
/** Days after which an untouched node is flagged stale, by type. decision, pattern and mistake never go stale. */
const STALE_DAYS_BY_TYPE: Partial<Record<KgNodeType, number>> = { episode: 30, idea: 60, project: 45 };
const NEVER_STALE = new Set<KgNodeType>(['decision', 'pattern', 'mistake']);
/** Days after which an episode (an automatic run summary) is retired. */
export const EPISODE_DAYS = 30;
/** Working memory: the part the bot sees at the start of every run is capped; the archive keeps only the newest lines. */
export const WM_ACTIVE_MAX = 2_500;
/** The ARCHIVE section is a scratch log: when it grows past this, the oldest lines are dropped (a sane cap, well under the 20,000-char body limit). */
export const WM_ARCHIVE_MAX = 6_000;
/** Largest merge a single call may do. */
export const MAX_MERGE_DROPS = 10;
const DAY_MS = 86_400_000;
/** Titles at least this alike (token Jaccard) count as the same note when capturing. */
export const SIMILAR_TITLE_JACCARD = 0.7;
export const EPISODE_PROMPT_CHARS = 300;
/** How much of a prompt or result is looked at before it is cut: far more than is kept, so a secret that straddles the cut is still seen whole. */
const EPISODE_SCRUB_WINDOW = 8_000;
export const EPISODE_RESULT_CHARS = 800;
export const staleDaysFor = (type: KgNodeType): number => (NEVER_STALE.has(type) ? Infinity : STALE_DAYS_BY_TYPE[type] ?? STALE_DAYS);
const MAX_TAGS = 32;
const MAX_SOURCES = 20;
const MAX_PROPS = 32;
export const MAX_LICENCE_CHARS = 200;
const SCOPE_RE = /^agent:[A-Za-z0-9_.-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const REL_RE = /^[a-z][a-z0-9_]{0,39}$/;
const NODE_FIELDS = [
  'type', 'title', 'body', 'tags', 'scope', 'props', 'sources', 'confidence',
  'trust', 'status', 'supersededBy', 'origin', 'updatedAt',
] as const;
/** The fields an editor controls; a write that changes none of them is a no-op whatever its origin. */
const CONTENT_FIELDS = ['type', 'title', 'body', 'tags', 'scope', 'props', 'sources', 'confidence'] as const;
/** Most pending (waiting for the human) shared notes one bot may have at a time. */
export const MAX_PENDING_PER_AGENT = 50;
/** Most live notes (private ones included) one bot may own: a looping bot cannot fill the graph on its own. */
export const AGENT_NODE_CAP = 10_000;
/** Room above the graph's node cap that only the human (and the system) may use, so bots can never lock the human out. */
export const HUMAN_RESERVE = 500;
/** Writers on one directory take turns through this lock file; a lock older than this is treated as left behind by a crash. */
const LOCK_STALE_MS = 30_000;
/** A live holder keeps the lock for milliseconds; waiting longer than this means something is wrong, and the core must not freeze on it. */
const LOCK_WAIT_MS = 1_500;
/** A lock file with no readable content may be one its owner has only just created; after this long it is a leftover. */
const LOCK_EMPTY_GRACE_MS = 250;
/**
 * A multi-op write is bracketed by two marker lines that both carry the number of ops: {"op":"begin","n":3}, the 3 ops,
 * {"op":"commit","n":3}. The count lets load tell a batch that crashed half way (drop it) from a later, complete write
 * that follows it. Markers without a count (older builds, hand-edited logs) are read the old way: a begin that has a
 * commit somewhere after it brackets a batch, a begin with none is ignored and its lines apply one by one.
 */
/** How much of one field is joined to its neighbours when looking for a seed phrase split across fields. */
const SEAM_CHARS = 400;
const BATCH_BEGIN = '{"op":"begin"';
const BATCH_COMMIT = '{"op":"commit"';
const batchMark = (kind: typeof BATCH_BEGIN | typeof BATCH_COMMIT, n: number): string => `${kind},"n":${n}}`;
const markerKind = (line: string): 'begin' | 'commit' | undefined => {
  if (!line.startsWith('{"op":"')) return undefined;
  if (line.startsWith(BATCH_BEGIN) && /^\{"op":"begin"(,"n":\d+)?\}$/.test(line)) return 'begin';
  if (line.startsWith(BATCH_COMMIT) && /^\{"op":"commit"(,"n":\d+)?\}$/.test(line)) return 'commit';
  return undefined;
};
const markerCount = (line: string): number | undefined => { const m = /"n":(\d+)/.exec(line); return m ? Number(m[1]) : undefined; };
/** Tombstones (forgotten nodes) are purged this long after they were forgotten. */
export const TOMBSTONE_DAYS = 30;
const SNAPSHOTS_KEPT = 5;
const BULK_DELETES = 5;
const BULK_WINDOW_MS = 10 * 60_000;
const TRUST_RANK: Record<KgTrust, number> = { untrusted: 0, agent: 1, human: 2 };
const minTrust = (a: KgTrust, b: KgTrust): KgTrust => (TRUST_RANK[a] <= TRUST_RANK[b] ? a : b);
const K1 = 1.2;
const B = 0.75;

interface CleanFields {
  type?: KgNode['type']; title?: string; body?: string; tags?: string[]; scope?: KgScope;
  props?: Record<string, string | number | boolean>; sources?: KgSource[]; confidence?: number; untrusted?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isScope = (v: unknown): v is KgScope => v === 'shared' || v === 'bsv' || (typeof v === 'string' && SCOPE_RE.test(v));
const normTitle = (t: string): string => oneLine(t).toLowerCase();

export class Graph {
  private readonly dir: string;
  readonly file: string;
  private readonly bsvOn: () => boolean;
  private readonly now: () => Date;
  private readonly compactMinBytes: number;
  private readonly onChange?: (changed: string[]) => void;
  private readonly secrets?: () => readonly string[];
  /** Deletes in the current window, and the pre-window copy of the log that becomes a snapshot if it turns bulk. */
  private delWindow?: { start: number; count: number; preCopied: boolean };
  private readonly activity: ActivityLog;
  private lite?: KgLintLite;

  private nodes = new Map<string, KgNode>();
  private edges = new Map<string, KgEdge>();
  private out = new Map<string, Set<string>>();
  private inn = new Map<string, Set<string>>();
  private edgeKeys = new Map<string, string>();
  // inverted index
  private postings = new Map<string, Set<string>>();
  private docTf = new Map<string, Map<string, number>>();
  private docLen = new Map<string, number>();
  private totalLen = 0;
  // log bookkeeping
  private totalEntries = 0;
  private bytes = 0;
  /** Identity of graph.jsonl as this instance last saw it (inode, size, mtime): a different value means another writer changed it. */
  private diskId = 'none';
  /** What load() found: lines it could not use and whether a torn tail was repaired. */
  readonly loadInfo = { skippedLines: 0, repairedTornTail: false };
  /**
   * What the human removed from the bundled BSV pack (seed-removed.json beside the log): node ids and edge keys "from|rel|to".
   * The pack upgrade reads it so a delete is a decision that sticks; restoring (seed.ts) clears entries.
   */
  private seedGone: { nodes: Set<string>; edges: Set<string> } = { nodes: new Set(), edges: new Set() };

  constructor(opts: GraphOptions) {
    this.dir = opts.dir;
    this.file = join(opts.dir, 'graph.jsonl');
    this.bsvOn = opts.bsvEnabled ?? (() => false);
    this.now = opts.now ?? (() => new Date());
    this.compactMinBytes = opts.compactMinBytes ?? 1_048_576;
    this.onChange = opts.onChange;
    this.secrets = opts.secrets;
    mkdirSync(this.dir, { recursive: true });
    this.activity = new ActivityLog(join(opts.dir, 'activity.jsonl'), this.now);
    try { this.lite = JSON.parse(readFileSync(join(opts.dir, 'lint-lite.json'), 'utf8')) as KgLintLite; } catch { /* no run yet */ }
    this.load();
    this.loadSeedGone();
    this.diskId = this.fileId();
    rmSync(`${this.file}.pre-delete`, { force: true });
    try { this.purgeTombstones(); } catch { /* the log stays valid; purge again next start */ }
  }

  // ------------------------------------------------------------------ what the human removed from the BSV pack

  private loadSeedGone(): void {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, 'seed-removed.json'), 'utf8')) as { nodes?: unknown; edges?: unknown };
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      this.seedGone = { nodes: new Set(strs(raw.nodes)), edges: new Set(strs(raw.edges)) };
    } catch { /* no ledger yet */ }
  }

  private saveSeedGone(): void {
    const file = join(this.dir, 'seed-removed.json');
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ nodes: [...this.seedGone.nodes].sort(), edges: [...this.seedGone.edges].sort() }), 'utf8');
      renameSync(tmp, file);
    } catch { /* the delete itself already happened; worst case the next upgrade re-adds the node */ }
  }

  /** Pack nodes and edges a human deleted (they stay deleted through upgrades until restored). */
  seedRemoved(): { nodes: string[]; edges: string[] } { return { nodes: [...this.seedGone.nodes], edges: [...this.seedGone.edges] }; }

  /** Takes entries off the ledger (the restore path). Edge keys are "from|rel|to". */
  forgetSeedRemoved(p: { nodes?: string[]; edges?: string[] }): void {
    let hit = false;
    for (const id of p.nodes ?? []) hit = this.seedGone.nodes.delete(id) || hit;
    for (const k of p.edges ?? []) hit = this.seedGone.edges.delete(k) || hit;
    if (hit) this.saveSeedGone();
  }

  private noteSeedNodeGone(n: KgNode): void {
    if (n.scope !== 'bsv' || n.createdBy !== 'system' || this.seedGone.nodes.has(n.id)) return;
    this.seedGone.nodes.add(n.id);
    this.saveSeedGone();
  }

  // ------------------------------------------------------------------ visibility

  canSee(actor: Actor, scope: KgScope): boolean {
    if (scope === 'shared') return true;
    if (scope === 'bsv') return this.bsvOn();
    return actor.kind === 'agent' ? scope === `agent:${actor.id}` : true;
  }

  canWrite(actor: Actor, scope: KgScope): boolean {
    if (scope === 'shared') return true;
    if (actor.kind !== 'agent') return true;
    return scope === `agent:${actor.id}`;
  }

  /**
   * Scope visibility plus lifecycle: an agent never sees tombstones, and sees a pending (not yet accepted) node
   * only when it wrote it. The human sees everything.
   */
  canSeeNode(actor: Actor, n: KgNode): boolean {
    if (!this.canSee(actor, n.scope)) return false;
    if (actor.kind !== 'agent') return true;
    const st = statusOf(n);
    if (st === 'archived') return false;
    if (st === 'pending') return n.createdBy === actor.id;
    return true;
  }

  private seen(actor: Actor, id: string): KgNode | undefined {
    const n = this.nodes.get(id);
    return n && this.canSeeNode(actor, n) ? n : undefined;
  }

  private mustSee(actor: Actor, id: string): KgNode {
    const n = this.seen(actor, id);
    if (!n) throw new KgError('not_found', `Unknown node "${id}" (it may not exist or may not be visible to you).`);
    return n;
  }

  /** An edge is visible only when both endpoints exist and are visible. */
  private edgeVisible(actor: Actor, e: KgEdge): boolean {
    return !!this.seen(actor, e.from) && !!this.seen(actor, e.to);
  }

  // ------------------------------------------------------------------ reads

  getNode(actor: Actor, id: string): KgNode | undefined {
    const n = this.seen(actor, id);
    return n ? structuredClone(n) : undefined;
  }

  getEdge(actor: Actor, id: string): KgEdge | undefined {
    const e = this.edges.get(id);
    return e && this.edgeVisible(actor, e) ? { ...e } : undefined;
  }

  /** Visible edges touching a node. */
  edgesOf(actor: Actor, id: string, dir: 'out' | 'in' | 'both' = 'both'): KgEdge[] {
    this.mustSee(actor, id);
    return this.adjacent(actor, id, dir).map((a) => ({ ...a.edge }));
  }

  allNodes(actor: Actor): KgNode[] {
    const res: KgNode[] = [];
    for (const n of this.nodes.values()) if (this.canSeeNode(actor, n)) res.push(structuredClone(n));
    return res;
  }

  findByTitle(actor: Actor, title: string): KgNode[] {
    const t = normTitle(title);
    const res: KgNode[] = [];
    for (const n of this.nodes.values()) if (this.canSeeNode(actor, n) && normTitle(n.title) === t) res.push(structuredClone(n));
    return res;
  }

  /** Total counts over every scope (for change events, not for agents). */
  counts(): { nodes: number; edges: number } { return { nodes: this.nodes.size, edges: this.edges.size }; }

  stats(actor: Actor): GraphStats {
    const byType: Record<string, number> = {};
    const byScope: Record<string, number> = {};
    let nodes = 0;
    for (const n of this.nodes.values()) {
      if (!this.canSeeNode(actor, n)) continue;
      nodes++;
      byType[n.type] = (byType[n.type] ?? 0) + 1;
      byScope[n.scope] = (byScope[n.scope] ?? 0) + 1;
    }
    let edges = 0;
    for (const e of this.edges.values()) if (this.edgeVisible(actor, e)) edges++;
    return { nodes, edges, byType, byScope };
  }

  // ------------------------------------------------------------------ search

  search(actor: Actor, q: string, opts: SearchOptions = {}): KgSearchHit[] {
    const qTokens = [...new Set(tokenize(q))];
    const limit = clampInt(opts.limit, 1, 50, 10);
    const wantTags = (opts.tags ?? []).map((t) => normTag(t)).filter(Boolean);
    if (opts.scope !== undefined && !isScope(opts.scope)) throw new KgError('invalid', `Invalid scope "${opts.scope}". Use shared, bsv or agent:<id>.`);
    if (opts.type !== undefined && !isNodeType(opts.type)) throw new KgError('invalid', `Invalid node type "${opts.type}".`);
    if (!qTokens.length || (opts.scope !== undefined && !this.canSee(actor, opts.scope as KgScope))) return [];

    const N = this.nodes.size || 1;
    const avg = this.totalLen / N || 1;
    const scores = new Map<string, number>();
    for (const t of qTokens) {
      const post = this.postings.get(t);
      if (!post) continue;
      const idf = Math.log(1 + (N - post.size + 0.5) / (post.size + 0.5));
      for (const id of post) {
        const tf = this.docTf.get(id)?.get(t) ?? 0;
        const len = this.docLen.get(id) ?? avg;
        scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avg))));
      }
    }
    const hits: KgSearchHit[] = [];
    const nowMs = this.now().getTime();
    for (const [id, score] of scores) {
      const n = this.nodes.get(id);
      if (!n || !this.canSeeNode(actor, n)) continue;
      const inactive = isInactive(n);
      if (inactive && !opts.includeInactive) continue;
      if (opts.scope !== undefined && n.scope !== opts.scope) continue;
      if (opts.type !== undefined && n.type !== opts.type) continue;
      if (wantTags.length && !wantTags.every((t) => n.tags.includes(t))) continue;
      // recall v2: BM25 x recency x confidence x trust; a retired node, when asked for, counts for a third
      const ranked = score * rankFactor(n, nowMs) * (inactive ? 0.3 : 1);
      hits.push({
        node: { id: n.id, type: n.type, title: n.title, tags: [...n.tags], scope: n.scope, updatedAt: n.updatedAt, snippet: makeSnippet(n.body, qTokens) || oneLine(n.title) },
        score: Math.round(ranked * 10_000) / 10_000,
        ...(inactive ? { inactive: { status: statusOf(n), ...(n.supersededBy ? { supersededBy: n.supersededBy } : {}) } } : {}),
      });
    }
    hits.sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt) || a.node.id.localeCompare(b.node.id));
    return hits.slice(0, limit);
  }

  // ------------------------------------------------------------------ traversal

  private adjacent(actor: Actor, id: string, dir: 'out' | 'in' | 'both', rels?: Set<string>): Array<{ edge: KgEdge; other: string }> {
    const res: Array<{ edge: KgEdge; other: string }> = [];
    const add = (ids: Set<string> | undefined, otherOf: (e: KgEdge) => string) => {
      for (const eid of ids ?? []) {
        const e = this.edges.get(eid);
        if (!e || (rels && !rels.has(e.rel))) continue;
        if (!this.edgeVisible(actor, e)) continue;
        res.push({ edge: e, other: otherOf(e) });
      }
    };
    if (dir !== 'in') add(this.out.get(id), (e) => e.to);
    if (dir !== 'out') add(this.inn.get(id), (e) => e.from);
    return res;
  }

  neighbors(actor: Actor, id: string, opts: NeighborOptions = {}): NeighborsResult {
    const start = this.mustSee(actor, id);
    const depth = clampInt(opts.depth, 1, KG_LIMITS.maxDepth, 1);
    const limit = clampInt(opts.limit, 1, 200, 50);
    const dir = opts.dir ?? 'both';
    if (dir !== 'out' && dir !== 'in' && dir !== 'both') throw new KgError('invalid', 'dir must be out, in or both.');
    const rels = opts.rel ? new Set([opts.rel]) : undefined;
    const seen = new Map<string, number>([[id, 0]]);
    const order: string[] = [];
    const edgeIds = new Set<string>();
    let truncated = false;
    let frontier = [id];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const { edge, other } of this.adjacent(actor, cur, dir, rels)) {
          if (seen.has(other)) { edgeIds.add(edge.id); continue; }
          if (order.length >= limit) { truncated = true; continue; }
          seen.set(other, d);
          order.push(other);
          next.push(other);
          edgeIds.add(edge.id);
        }
      }
      frontier = next;
    }
    const nodes = order.map((oid) => ({ node: structuredClone(this.nodes.get(oid)!), depth: seen.get(oid)! }));
    const edges = [...edgeIds].map((eid) => this.edges.get(eid)!).filter((e) => seen.has(e.from) && seen.has(e.to)).map((e) => ({ ...e }));
    return { start: structuredClone(start), nodes, edges, truncated };
  }

  /** Shortest path by hops. Links are walked in both directions; returned edges keep their own direction. */
  path(actor: Actor, from: string, to: string, opts: PathOptions = {}): PathResult {
    this.mustSee(actor, from);
    this.mustSee(actor, to);
    const maxDepth = clampInt(opts.maxDepth, 1, 10, 6);
    const rels = opts.rels?.length ? new Set(opts.rels) : undefined;
    if (from === to) return { found: true, nodes: [structuredClone(this.nodes.get(from)!)], edges: [] };
    const parent = new Map<string, { prev: string; edge: KgEdge } | null>([[from, null]]);
    let frontier = [from];
    let found = false;
    for (let d = 1; d <= maxDepth && frontier.length && !found; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const { edge, other } of this.adjacent(actor, cur, 'both', rels)) {
          if (parent.has(other)) continue;
          parent.set(other, { prev: cur, edge });
          if (other === to) { found = true; break; }
          next.push(other);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (!found) return { found: false, nodes: [], edges: [] };
    const ids: string[] = [to];
    const edges: KgEdge[] = [];
    for (let cur = to; parent.get(cur); ) {
      const p = parent.get(cur)!;
      edges.unshift({ ...p.edge });
      ids.unshift(p.prev);
      cur = p.prev;
    }
    return { found: true, nodes: ids.map((i) => structuredClone(this.nodes.get(i)!)), edges };
  }

  subgraph(actor: Actor, seeds: string[], opts: { depth?: number; maxNodes?: number } = {}): KgSubgraph {
    const depth = clampInt(opts.depth, 0, KG_LIMITS.maxDepth, 1);
    const maxNodes = clampInt(opts.maxNodes, 1, 500, 100);
    const included = new Set<string>();
    let truncated = false;
    let frontier: string[] = [];
    for (const s of seeds) {
      if (included.has(s) || !this.seen(actor, s)) continue;
      if (included.size >= maxNodes) { truncated = true; continue; }
      included.add(s);
      frontier.push(s);
    }
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const { other } of this.adjacent(actor, cur, 'both')) {
          if (included.has(other)) continue;
          if (included.size >= maxNodes) { truncated = true; continue; }
          included.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }
    const nodes = [...included].map((i) => structuredClone(this.nodes.get(i)!));
    const edges: KgEdge[] = [];
    for (const e of this.edges.values()) if (included.has(e.from) && included.has(e.to)) edges.push({ ...e });
    return { nodes, edges, truncated };
  }

  /** The most connected nodes (by visible degree; isolated ones fill up the rest) and the edges among them. */
  overview(actor: Actor, limit?: number): KgSubgraph {
    const max = clampInt(limit, 1, 200, 60);
    const degree = new Map<string, number>();
    const visible: KgNode[] = [];
    for (const n of this.nodes.values()) if (this.canSeeNode(actor, n)) { visible.push(n); degree.set(n.id, 0); }
    for (const e of this.edges.values()) {
      if (!this.edgeVisible(actor, e)) continue;
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    visible.sort((a, b) => degree.get(b.id)! - degree.get(a.id)! || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const top = visible.slice(0, max);
    const ids = new Set(top.map((n) => n.id));
    const edges: KgEdge[] = [];
    for (const e of this.edges.values()) if (ids.has(e.from) && ids.has(e.to)) edges.push({ ...e });
    return { nodes: top.map((n) => structuredClone(n)), edges, truncated: visible.length > max };
  }

  /**
   * Search top-k, expand one hop, rank, and return the entries (best first). Shared by recall() and the briefing.
   * An untrusted node can be a hit but never seeds the expansion, so a poisoned note cannot pull its neighbours in.
   * With `scope`, the hits AND the neighbours pulled in through links are restricted to that one scope (visibility still applies:
   * a hidden scope, such as bsv while BSV mode is off, or another bot's private scope, yields nothing).
   */
  recallEntries(actor: Actor, query: string, opts: { includeInactive?: boolean; scope?: string } = {}): RecallEntry[] {
    const q = oneLine(query);
    const seeds = this.search(actor, q, { limit: 5, includeInactive: opts.includeInactive, scope: opts.scope });
    if (!seeds.length) return [];
    const seedIds = new Set(seeds.map((s) => s.node.id));
    const entries = new Map<string, RecallEntry>();
    for (const s of seeds) entries.set(s.node.id, { id: s.node.id, score: s.score, seed: true, snippet: s.node.snippet });
    for (const s of seeds) {
      const sn = this.nodes.get(s.node.id)!;
      if (isUntrusted(sn) || isInactive(sn)) continue;
      let taken = 0;
      for (const { edge, other } of this.adjacent(actor, s.node.id, 'both')) {
        if (seedIds.has(other) || taken >= 6) continue;
        const on = this.nodes.get(other)!;
        if (isInactive(on) && !opts.includeInactive) continue;
        if (opts.scope !== undefined && on.scope !== opts.scope) continue;
        const w = Math.min(1, Math.max(0.1, edge.weight ?? 1));
        const score = s.score * 0.5 * w * (effectiveTrust(on) === 'untrusted' ? 0.25 : 1);
        const cur = entries.get(other);
        if (!cur || cur.score < score) {
          entries.set(other, { id: other, score, seed: false, via: { rel: edge.rel, dir: edge.from === s.node.id ? 'out' : 'in', seedId: s.node.id } });
          taken++;
        }
      }
    }
    return [...entries.values()].sort((a, b) => b.score - a.score || Number(b.seed) - Number(a.seed) || a.id.localeCompare(b.id));
  }

  /** Recall: the ranked entries as a compact outline within the budget. Untrusted nodes show only as "[untrusted lead]" with their id. */
  recall(actor: Actor, query: string, opts: { budgetChars?: number; includeInactive?: boolean; scope?: string } = {}): RecallResult {
    const budget = clampInt(opts.budgetChars, 120, KG_LIMITS.toolResultChars, 4_000);
    const q = oneLine(query);
    const ranked = this.recallEntries(actor, q, { includeInactive: opts.includeInactive, scope: opts.scope });
    if (!ranked.length) {
      const text = `No matching nodes in the knowledge graph for "${safeTitle(q).slice(0, 80)}". Proceed without it, and write what you learn with kg_capture (or kg_upsert_node) when it is durable.`;
      return { outline: text.slice(0, budget), nodeIds: [], truncated: false };
    }
    const header = `Lattice recall for "${safeTitle(q).slice(0, 80)}":`;
    const footer = DATA_LINE;
    let used = header.length + footer.length + 2;
    const blocks: string[] = [];
    const ids: string[] = [];
    let truncated = false;
    let i = 0;
    for (const e of ranked) {
      const n = this.nodes.get(e.id)!;
      const retired = isInactive(n) ? ` [${statusOf(n)}${n.supersededBy ? ` by ${n.supersededBy}` : ''}]` : '';
      let block: string;
      if (e.seed) {
        const head = `${++i}. [${n.type}] ${shownTitle(n)} (id ${n.id}, ${n.scope}${guarded(n) ? '' : n.tags.length ? ', tags: ' + n.tags.slice(0, 6).map(safeTitle).join(' ') : ''})${retired}`;
        block = guarded(n) ? head : `${head}\n${wrapNode(n, e.snippet ?? '')}`;
      } else {
        const sn = this.nodes.get(e.via!.seedId)!;
        const arrow = e.via!.dir === 'out' ? `${e.via!.rel} ->` : `<- ${e.via!.rel}`;
        block = `   related: [${n.type}] ${shownTitle(n)} (id ${n.id}) via ${arrow} "${shownTitle(sn).slice(0, 60)}"${guarded(n) ? ' [UNTRUSTED SOURCE]' : ''}${retired}`;
      }
      if (used + block.length + 1 > budget) { truncated = true; continue; }
      used += block.length + 1;
      blocks.push(block);
      ids.push(e.id);
    }
    if (!blocks.length) {
      // the budget is too small for even one entry: say so rather than overflow
      return { outline: `Lattice recall: budget too small, raise budgetChars.\n${footer}`.slice(0, budget), nodeIds: [], truncated: true };
    }
    if (truncated) {
      const note = '(more results omitted: budget reached)';
      if (used + note.length + 1 <= budget) blocks.push(note);
    }
    return { outline: [header, ...blocks, footer].join('\n'), nodeIds: ids, truncated };
  }

  // ------------------------------------------------------------------ lint

  lint(actor: Actor): KgLintReport {
    const nowMs = this.now().getTime();
    const visible = [...this.nodes.values()].filter((n) => this.canSeeNode(actor, n) && !isInactive(n));
    const touched = new Set<string>();
    const danglingEdges: string[] = [];
    const contradictions: Array<{ a: string; b: string }> = [];
    let edgeCount = 0;
    for (const e of this.edges.values()) {
      const f = this.nodes.get(e.from);
      const t = this.nodes.get(e.to);
      if (!f || !t) {
        const alive = f ?? t;
        if (actor.kind !== 'agent' || (alive && this.canSeeNode(actor, alive))) danglingEdges.push(e.id);
        continue;
      }
      if (!this.edgeVisible(actor, e)) continue;
      edgeCount++;
      touched.add(e.from);
      touched.add(e.to);
      if (e.rel === 'contradicts') contradictions.push({ a: e.from, b: e.to });
    }
    const titles = new Map<string, KgNode[]>();
    const stale: Array<{ id: string; daysOld: number }> = [];
    const untrustedWithoutReview: string[] = [];
    const orphans: string[] = [];
    for (const n of visible) {
      if (!touched.has(n.id)) orphans.push(n.id);
      const list = titles.get(normTitle(n.title)) ?? [];
      list.push(n);
      titles.set(normTitle(n.title), list);
      const t = Date.parse(n.updatedAt);
      const days = Number.isFinite(t) ? Math.floor((nowMs - t) / 86_400_000) : 0;
      if (days > staleDaysFor(n.type)) stale.push({ id: n.id, daysOld: days });
      if (isUntrusted(n) && n.props?.reviewed !== true) untrustedWithoutReview.push(n.id);
    }
    const duplicateTitles = [...titles.values()].filter((l) => l.length > 1).map((l) => ({ title: l[0]!.title, ids: l.map((x) => x.id) }));
    return {
      orphans, danglingEdges, duplicateTitles, stale: stale.sort((a, b) => b.daysOld - a.daysOld),
      contradictions, untrustedWithoutReview, counts: { nodes: visible.length, edges: edgeCount },
      ...(this.lite && actor.kind !== 'agent' ? { lite: this.lite } : {}),
    };
  }

  // ------------------------------------------------------------------ writes

  /** Per-write guard: rejects seed phrases and private keys outright, redacts other secrets, counts what it changed. */
  private guard(): { text: (s: string) => string; readonly count: number } {
    const exact = this.secrets?.() ?? [];
    let count = 0;
    // the tail of what this write has carried so far: a phrase split over tags, props, title and body is read across the seams
    let seen = '';
    return {
      text: (s: string): string => {
        const bad = findForbiddenSecretInField(s) ?? (seen ? findForbiddenSecretInField(`${seen} | ${s.slice(0, SEAM_CHARS)}`) : undefined);
        seen = `${seen} | ${s.slice(-SEAM_CHARS)}`.slice(-SEAM_CHARS * 2);
        if (bad) throw new KgError('invalid', `Refused: this looks like a ${bad}. Secrets never go into the knowledge graph. Nothing was saved.`);
        const out = scrubSecrets(s, { keepHex: true, exact });
        if (out !== s) count++;
        return out;
      },
      get count() { return count; },
    };
  }

  /**
   * Text for the markdown mirror: legacy notes (written before the boundary scrub existed) may still hold secrets, and the
   * mirror is the one place data leaves the log. A seed phrase or private key withholds the whole field.
   */
  scrubForExport(s: string): string {
    if (findForbiddenSecretInField(s)) return '[withheld: this looked like a seed phrase or private key]';
    return scrubSecrets(s, { keepHex: true, exact: this.secrets?.() ?? [] });
  }

  /**
   * What this write is allowed to be. Trust and taint come from the engine (the actor's run context), never from
   * the input: a tainted run writes untrusted notes whatever the bot passes, and a shared note from a tainted run,
   * or from a run woken by a bot under "ask" approvals, waits for the human.
   */
  private writeCtx(actor: Actor, scope: KgScope, untrustedFlag: boolean) {
    const agent = actor.kind === 'agent' ? actor : undefined;
    const tainted = !!agent && isTainted(agent);
    const trust: KgTrust = tainted || untrustedFlag ? 'untrusted' : actor.kind === 'human' ? 'human' : 'agent';
    const ceiling = agent ? agent.ceiling ?? agent.origin?.approvalCeiling : undefined;
    const askWoken = !!agent && agent.origin !== undefined && ceiling === 'ask';
    const archivist = agent?.id === ARCHIVIST_ID;
    const hold = !!agent && scope === 'shared' && (tainted || askWoken || archivist);
    const origin: KgOrigin | undefined = agent?.taskId
      ? { taskId: agent.taskId, tainted, ...(agent.origin?.fromAgentId ? { via: agent.origin.fromAgentId } : {}) }
      : undefined;
    const notes: string[] = [];
    if (tainted) notes.push('This run touched outside content (web, shell or external tools), so what you write is stored as untrusted' + (hold ? ' and shared notes wait for the human to accept them.' : '.'));
    else if (hold && askWoken) notes.push('This run was started by another bot under "ask" approvals, so shared notes wait for the human to accept them.');
    else if (hold) notes.push('You are the Archivist: you flag and propose, you never decide. Shared notes you write wait for the human to accept them.');
    return { agent, tainted, trust, hold, origin, notes };
  }

  /** Room for one more node: bots stop at the graph cap (and at their own per-bot cap), the human has a reserve above it. */
  private assertRoom(actor: Actor): void {
    const max = KG_LIMITS.maxNodes;
    const total = this.nodes.size;
    if (total < max) {
      if (actor.kind !== 'agent') return;
    } else {
      // Archived notes (forgotten notes waiting out their 30 days, retired and merged notes) do not use up the graph's room, or one bot
      // that creates and forgets in a loop could lock everyone else out. They count toward their author's own cap below, and a
      // hard backstop bounds the whole file.
      let live = 0;
      for (const n of this.nodes.values()) if (statusOf(n) !== 'archived') live++;
      if (actor.kind !== 'agent') {
        if (live >= max + HUMAN_RESERVE) throw new KgError('limit', `The graph is full (${max + HUMAN_RESERVE} nodes). Delete or merge nodes first.`);
        if (total >= 2 * max + HUMAN_RESERVE) throw new KgError('limit', 'The graph holds too many retired notes. Purge forgotten notes or compact first.');
        return;
      }
      if (live >= max) throw new KgError('limit', `The graph is full (${max} nodes). Nothing was saved: tell the human to delete or merge notes.`);
      if (total >= 2 * max) throw new KgError('limit', 'The graph holds too many forgotten and retired notes. Nothing was saved: tell the human to purge them.');
    }
    const cap = Math.min(AGENT_NODE_CAP, max);
    if (total < cap) return; // cannot reach the per-bot cap yet
    // everything the bot made counts, forgotten notes included, until they are purged
    let mine = 0;
    for (const n of this.nodes.values()) if (n.createdBy === actor.id || n.scope === `agent:${actor.id}`) mine++;
    if (mine >= cap) throw new KgError('limit', `You already own ${mine} notes, forgotten ones included (limit ${cap}). Nothing was saved: merge or forget some, or ask the human to review them.`);
  }

  private requirePendingRoom(actor: Actor): void {
    if (actor.kind !== 'agent') return;
    let n = 0;
    for (const x of this.nodes.values()) if (statusOf(x) === 'pending' && x.createdBy === actor.id) n++;
    if (n >= MAX_PENDING_PER_AGENT) {
      throw new KgError('limit', `You already have ${n} notes waiting for the human to review (limit ${MAX_PENDING_PER_AGENT}). Nothing was saved: write to your private scope, or stop and ask the human to review the inbox.`);
    }
  }

  private chargeNode(actor: Actor, bytes: number): void { if (actor.kind === 'agent') actor.quota?.node(bytes); }
  private chargeEdge(actor: Actor, bytes = 0): void { if (actor.kind === 'agent') actor.quota?.edge(bytes); }

  /**
   * The node a create would store: every create-time rule in one place (graph size, title, untrusted needs a source,
   * agents cannot self-review, the 50-pending cap). `w` says what the write is allowed to be (trust, held for review).
   */
  private buildNode(actor: Actor, f: CleanFields, scope: KgScope, w: ReturnType<Graph['writeCtx']>, idHint: string | undefined, dryRun: boolean): KgNode {
    this.assertRoom(actor);
    if (f.title === undefined) throw new KgError('invalid', 'title is required to create a node.');
    if (f.untrusted && !f.sources?.length) throw new KgError('invalid', 'Content from the web, files or other untrusted input needs at least one source (ref).');
    const props = actor.kind === 'human' || actor.kind === 'system' ? f.props : stripReviewed(f.props);
    if (w.hold && !dryRun) this.requirePendingRoom(actor);
    const now = nowIso();
    return {
      id: idHint ?? newId('n'), type: f.type ?? 'note', title: f.title, body: f.body ?? '', tags: f.tags ?? [], scope,
      ...(props && Object.keys(props).length ? { props } : {}),
      ...(f.sources?.length ? { sources: f.sources } : {}),
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
      trust: w.trust, ...(w.hold ? { status: 'pending' as const } : {}), ...(w.origin ? { origin: w.origin } : {}),
      createdBy: actorName(actor), createdAt: now, updatedAt: now, rev: 1,
    };
  }

  /** A run that touched outside content may not plant trigger tags (standing rules for other runs). */
  private guardTriggerTags(actor: Actor, tags: string[] | undefined): void {
    if (actor.kind === 'agent' && isTainted(actor) && tags?.some((t) => t.startsWith('trigger:'))) {
      throw new KgError('forbidden', 'This run touched outside content (web, shell or external tools), so it may not write trigger tags. Nothing was saved.');
    }
  }

  /**
   * Creates or updates a node. With `dryRun` every check runs (validation, visibility, write rights, limits)
   * but nothing is written, so a batch can be vetted before its first write. With `held` (the vault importer, for files it
   * cannot vouch for) a new note is stored pending and untrusted, and a change to a live note becomes a pending proposal
   * that supersedes it, exactly as if a bot had written it; a note that is still pending is updated in place.
   */
  upsertNode(actor: Actor, input: NodeInput, opts: { dryRun?: boolean; held?: boolean } = {}): UpsertResult {
    if (!isObj(input as unknown)) throw new KgError('invalid', 'Node input must be an object.');
    const existing = input.id !== undefined ? this.nodes.get(input.id) : undefined;
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || !ID_RE.test(input.id)) throw new KgError('invalid', 'id must be 1-80 chars of letters, digits and _ . : -');
      if (!existing && actor.kind === 'agent') throw new KgError('not_found', `Unknown node "${input.id}". Omit id to create a new node.`);
    }
    if (existing && !this.canSeeNode(actor, existing)) {
      // do not reveal whether a private node of someone else exists
      throw new KgError(actor.kind === 'agent' ? 'not_found' : 'forbidden', `Unknown node "${input.id}" (it may not exist or may not be visible to you).`);
    }
    if (existing && !this.canWrite(actor, existing.scope)) throw new KgError('forbidden', `Node "${existing.id}" is read-only for you (scope ${existing.scope}).`);
    if (existing && actor.kind === 'agent' && existing.id.startsWith(WM_PREFIX)) throw new KgError('forbidden', 'Working memory is written only with kg_wm_set.');

    const g = this.guard();
    const f = this.cleanFields(input, !existing, g);
    this.guardTriggerTags(actor, f.tags);
    const scope = f.scope ?? existing?.scope ?? 'shared';
    if (!this.canWrite(actor, scope)) {
      throw new KgError('forbidden', scope === 'bsv'
        ? 'The bsv scope is written only by the human or the seeder.'
        : `You may write only to "shared" or your own private scope, not "${scope}".`);
    }
    if (existing && actor.kind === 'agent' && scope !== existing.scope) {
      throw new KgError('forbidden', 'Only the human can move a node between shared and private scope. Create a new node in the scope you want instead.');
    }
    const now = nowIso();
    const who = actorName(actor);
    const w0 = this.writeCtx(actor, scope, f.untrusted === true);
    const w = opts.held ? { ...w0, trust: 'untrusted' as KgTrust, hold: true } : w0;
    const bytes = Buffer.byteLength(JSON.stringify([f.title, f.body, f.tags, f.props, f.sources]));
    const extra = (r: UpsertResult): UpsertResult => ({
      ...r, ...(g.count ? { redacted: g.count } : {}), ...(w.notes.length ? { notes: w.notes } : {}),
    });

    if (!existing) {
      const node = this.buildNode(actor, f, scope, w, input.id, !!opts.dryRun);
      if (opts.dryRun) return extra({ node: structuredClone(node), created: true, changed: true, ...(w.hold ? { pending: true } : {}) });
      this.chargeNode(actor, bytes);
      this.append([{ op: 'node', node }]);
      this.nodes.set(node.id, node);
      this.indexNode(node);
      this.logActivity(actor, 'create', [{ op: 'del_node', id: node.id }], node);
      this.changed([node.id]);
      return extra({ node: structuredClone(node), created: true, changed: true, ...(w.hold ? { pending: true } : {}) });
    }

    // ---- update: merge the given fields
    const next = this.mergeUpdate(actor, existing, f);
    if (CONTENT_FIELDS.every((k) => JSON.stringify(next[k] ?? null) === JSON.stringify(existing[k] ?? null))) {
      if (!opts.dryRun) this.chargeNode(actor, bytes);
      return { node: structuredClone(existing), created: false, changed: false };
    }
    const existingTrust = trustOf(existing);
    const heldEdit = opts.held === true && statusOf(existing) !== 'pending';
    if ((w.agent && existing.scope === 'shared') || heldEdit) {
      const ownedByRun = !!w.agent?.taskId && existing.origin?.taskId === w.agent.taskId;
      // A bot never rewrites a human's note, and a held run never rewrites someone else's: it proposes a copy.
      if (heldEdit || existingTrust === 'human' || (w.hold && !ownedByRun)) {
        if (!opts.dryRun) { this.requirePendingRoom(actor); this.assertRoom(actor); }
        const copy: KgNode = {
          ...structuredClone(next), id: newId('n'), trust: w.trust, status: 'pending',
          ...(w.origin ? { origin: w.origin } : {}), createdBy: who, createdAt: now, updatedAt: now, rev: 1,
        };
        delete copy.supersededBy;
        if (!w.origin) delete copy.origin;
        const edge: KgEdge = { id: newId('e'), from: copy.id, to: existing.id, rel: 'supersedes', note: 'proposed edit', createdBy: who, createdAt: now };
        const notes = [...w.notes, `You may not edit "${existing.id}" directly (${existingTrust === 'human' ? 'it was written or accepted by the human' : 'your run is held for review'}): your change was saved as a pending proposal that supersedes it. The human decides.`];
        if (opts.dryRun) return { node: copy, created: true, changed: true, pending: true, proposalFor: existing.id, notes, ...(g.count ? { redacted: g.count } : {}) };
        this.chargeNode(actor, bytes);
        this.chargeEdge(actor);
        this.append([{ op: 'node', node: copy }, { op: 'edge', edge }]);
        this.nodes.set(copy.id, copy);
        this.indexNode(copy);
        this.addEdge(edge);
        this.logActivity(actor, 'proposal', [{ op: 'del_edge', id: edge.id }, { op: 'del_node', id: copy.id }], copy);
        this.changed([copy.id, edge.id, existing.id]);
        return { node: structuredClone(copy), created: true, changed: true, pending: true, proposalFor: existing.id, notes, ...(g.count ? { redacted: g.count } : {}) };
      }
    }
    // the clean version of a note that this run wrote while still clean and is now rewriting after turning tainted
    let keepLive: { copy: KgNode; edges: KgEdge[]; sup: KgEdge } | undefined;
    if (w.agent) {
      // an agent edit can only keep or lower trust, and records which run last touched the node
      next.trust = minTrust(existingTrust, w.trust);
      if (w.origin) next.origin = { ...w.origin, tainted: w.origin.tainted || existing.origin?.tainted === true };
      if (w.hold && existing.scope === 'shared' && statusOf(existing) === 'active') {
        // A live note this run wrote while it was still clean, rewritten after the run turned tainted: the rewrite goes to the
        // inbox under the same id, and the clean version stays live as a copy (with the same links) until the human decides, so
        // rejecting the rewrite loses nothing and other bots do not lose the note meanwhile.
        if (!opts.dryRun) { this.requirePendingRoom(actor); this.assertRoom(actor); }
        next.status = 'pending';
        const copy: KgNode = { ...structuredClone(existing), id: newId('n'), updatedAt: now, rev: 1 };
        const links = [...new Set([...(this.out.get(existing.id) ?? []), ...(this.inn.get(existing.id) ?? [])])]
          .map((eid) => this.edges.get(eid)).filter((e): e is KgEdge => !!e && e.rel !== 'supersedes');
        const edges = links.map((e): KgEdge => ({ ...structuredClone(e), id: newId('e'), from: e.from === existing.id ? copy.id : e.from, to: e.to === existing.id ? copy.id : e.to }));
        const sup: KgEdge = { id: newId('e'), from: existing.id, to: copy.id, rel: 'supersedes', note: 'proposed edit', createdBy: who, createdAt: now };
        keepLive = { copy, edges, sup };
        w.notes.push(`"${existing.id}" was live before this run touched outside content; your rewrite now waits for the human to accept it, and the earlier text stays live as "${copy.id}" until then.`);
      }
    }
    const fields: Record<string, unknown> = {};
    for (const k of NODE_FIELDS) {
      if (k === 'updatedAt') continue;
      const a = JSON.stringify(next[k] ?? null);
      if (a !== JSON.stringify(existing[k] ?? null)) fields[k] = next[k] ?? null;
    }
    if (!Object.keys(fields).length) return { node: structuredClone(existing), created: false, changed: false };
    next.updatedAt = now;
    fields.updatedAt = now;
    next.rev = (existing.rev ?? 0) + 1;
    if (opts.dryRun) return extra({ node: structuredClone(next), created: false, changed: true });
    this.chargeNode(actor, bytes);
    const ops: LogOp[] = [
      ...(keepLive ? [{ op: 'node', node: keepLive.copy } as LogOp, ...[...keepLive.edges, keepLive.sup].map((edge) => ({ op: 'edge', edge }) as LogOp)] : []),
      { op: 'patch', id: existing.id, fields },
    ];
    const undo = this.inverseOf(ops);
    this.append(ops);
    this.unindexNode(existing.id);
    this.nodes.set(next.id, next);
    this.indexNode(next);
    if (keepLive) {
      this.nodes.set(keepLive.copy.id, keepLive.copy);
      this.indexNode(keepLive.copy);
      for (const e of [...keepLive.edges, keepLive.sup]) this.addEdge(e);
    }
    this.logActivity(actor, 'update', undo, next);
    this.changed(keepLive ? [next.id, keepLive.copy.id] : [next.id]);
    return extra({ node: structuredClone(next), created: false, changed: true });
  }

  /** The content of an update applied to a copy of the node (no trust, status or origin changes yet). */
  private mergeUpdate(actor: Actor, existing: KgNode, f: CleanFields): KgNode {
    const next: KgNode = structuredClone(existing);
    if (f.type !== undefined) next.type = f.type;
    if (f.title !== undefined) next.title = f.title;
    if (f.body !== undefined) next.body = f.body;
    if (f.tags !== undefined) next.tags = f.tags;
    if (f.scope !== undefined) next.scope = f.scope;
    if (f.confidence !== undefined) next.confidence = f.confidence;
    if (f.sources !== undefined) {
      if (f.untrusted && !f.sources.length) throw new KgError('invalid', 'Content from the web, files or other untrusted input needs at least one source (ref).');
      next.sources = f.sources;
    } else if (f.untrusted) throw new KgError('invalid', 'Content from the web, files or other untrusted input needs at least one source (ref).');
    if (f.props !== undefined) next.props = f.props;
    if (actor.kind === 'agent') {
      // an agent can neither launder an untrusted flag nor mark content as human-reviewed
      const before = existing.sources?.filter((s) => s.untrusted) ?? [];
      if (before.length) {
        const have = new Map((next.sources ?? []).map((s) => [s.ref, s]));
        for (const s of before) have.set(s.ref, { ...(have.get(s.ref) ?? s), untrusted: true });
        next.sources = [...have.values()];
      }
      const props = { ...(next.props ?? {}) };
      for (const k of ENGINE_PROPS) delete props[k];
      const contentChanged = next.title !== existing.title || next.body !== existing.body;
      if (existing.props?.reviewed === true && !contentChanged) props.reviewed = true;
      if (Object.keys(props).length) next.props = props; else delete next.props;
    }
    if (next.props && !Object.keys(next.props).length) delete next.props;
    if (next.sources && !next.sources.length) delete next.sources;
    return next;
  }

  /**
   * Forget a node. The human deletes for good. A bot may only forget its own private nodes (or a note of its own
   * that is still waiting for review), and that is a tombstone: hidden from agents, purged after 30 days, the
   * human can bring it back with setStatus.
   */
  deleteNode(actor: Actor, id: string): { removedEdges: number; tombstoned?: boolean } {
    const n = this.mustSee(actor, id);
    if (!this.canWrite(actor, n.scope)) throw new KgError('forbidden', `Node "${id}" is read-only for you (scope ${n.scope}).`);
    if (actor.kind === 'agent' && actor.id === ARCHIVIST_ID) {
      throw new KgError('forbidden', 'The Archivist flags and proposes, it never deletes. Say what should go and why; the human decides.');
    }
    if (actor.kind === 'agent' && id.startsWith(WM_PREFIX)) throw new KgError('forbidden', 'Working memory is written only with kg_wm_set; it cannot be forgotten by a bot.');
    if (actor.kind === 'agent') {
      const ownPending = statusOf(n) === 'pending' && n.createdBy === actor.id;
      if (n.scope !== `agent:${actor.id}` && !ownPending) {
        throw new KgError('forbidden', `Only the human can delete shared notes. You may forget only your own private notes. To retire a shared note, update it (a proposal goes to the human) or tell the user.`);
      }
      this.chargeNode(actor, 0);
      this.noteDelete();
      const now = nowIso();
      const patch: LogOp = { op: 'patch', id, fields: { status: 'archived', updatedAt: now } };
      const undo = this.inverseOf([patch]);
      this.append([patch]);
      this.nodes.set(id, { ...n, status: 'archived', updatedAt: now, rev: (n.rev ?? 0) + 1 });
      this.logActivity(actor, 'forget', undo, this.nodes.get(id));
      this.changed([id]);
      return { removedEdges: 0, tombstoned: true };
    }
    this.noteDelete();
    const edgeIds = [...new Set([...(this.out.get(id) ?? []), ...(this.inn.get(id) ?? [])])];
    this.append([...edgeIds.map((e) => ({ op: 'del_edge', id: e })), { op: 'del_node', id }]);
    for (const e of edgeIds) this.dropEdge(e);
    this.dropNode(id);
    if (actor.kind === 'human') this.noteSeedNodeGone(n);
    this.changed([id]);
    return { removedEdges: edgeIds.length };
  }

  /**
   * Moves a node between lifecycle states (accept a pending note, restore a tombstone, archive). Human or system only:
   * a bot can never accept its own write. `trust` raises or sets trust at the same time (accepting a note = 'human').
   */
  setStatus(actor: Actor, id: string, status: KgStatus, opts: { trust?: KgTrust; supersededBy?: string } = {}): KgNode {
    if (actor.kind === 'agent') throw new KgError('forbidden', 'Only the human can accept, restore or archive notes.');
    const n = this.nodes.get(id);
    if (!n) throw new KgError('not_found', `Unknown node "${id}".`);
    const next: KgNode = structuredClone(n);
    if (status === 'active') delete next.status; else next.status = status;
    if (opts.trust) next.trust = opts.trust;
    if (opts.supersededBy !== undefined) next.supersededBy = opts.supersededBy;
    next.updatedAt = nowIso();
    next.rev = (n.rev ?? 0) + 1;
    const fields: Record<string, unknown> = { updatedAt: next.updatedAt };
    for (const k of ['status', 'trust', 'supersededBy'] as const) {
      if (JSON.stringify(next[k] ?? null) !== JSON.stringify(n[k] ?? null)) fields[k] = next[k] ?? null;
    }
    if (Object.keys(fields).length === 1) return structuredClone(n);
    this.append([{ op: 'patch', id, fields }]);
    this.nodes.set(id, next);
    this.changed([id]);
    return structuredClone(next);
  }

  /** Removes tombstones older than 30 days (and their links) for good. Returns how many nodes went. */
  purgeTombstones(): number {
    const cutoff = this.now().getTime() - TOMBSTONE_DAYS * 86_400_000;
    const ids = [...this.nodes.values()].filter((n) => statusOf(n) === 'archived' && Date.parse(n.updatedAt) < cutoff).map((n) => n.id);
    if (!ids.length) return 0;
    if (ids.length > BULK_DELETES) this.snapshot();
    for (const id of ids) {
      // a purged pack node goes on the removal ledger first, so startup repair does not bring back what a human archived
      const gone = this.nodes.get(id);
      if (gone) this.noteSeedNodeGone(gone);
      const edgeIds = [...new Set([...(this.out.get(id) ?? []), ...(this.inn.get(id) ?? [])])];
      this.append([...edgeIds.map((e) => ({ op: 'del_edge', id: e })), { op: 'del_node', id }]);
      for (const e of edgeIds) this.dropEdge(e);
      this.dropNode(id);
    }
    this.changed(ids);
    return ids.length;
  }

  link(actor: Actor, input: LinkInput): LinkResult {
    if (!isObj(input as unknown)) throw new KgError('invalid', 'Edge input must be an object.');
    const rel = validateLinkFields(input);
    const fromNode = this.mustSee(actor, input.from);
    const toNode = this.mustSee(actor, input.to);
    if (actor.kind === 'agent' && (fromNode.scope === 'bsv' || toNode.scope === 'bsv')) {
      throw new KgError('forbidden', 'The BSV knowledge pack is read-only for bots: you cannot link onto its notes or change its links. Link your own notes to each other, or tell the user.');
    }
    const g = this.guard();
    this.checkRel(g, rel);
    let note = input.note !== undefined ? g.text(input.note) : undefined;
    const notes: string[] = [];
    if (actor.kind === 'agent' && isTainted(actor)) {
      // a tainted run may only wire up what it wrote itself, so it cannot hijack hubs or plant text on trusted links
      const mine = (n: KgNode) => !!actor.taskId && n.origin?.taskId === actor.taskId;
      if (!mine(fromNode) && !mine(toNode)) {
        throw new KgError('forbidden', 'This run touched outside content (web, shell or external tools), so it may link only notes it wrote itself in this run.');
      }
      if (note !== undefined) { note = undefined; notes.push('Link note dropped: this run touched outside content.'); }
    }
    const key = edgeKey(input.from, input.to, rel);
    const existingId = this.edgeKeys.get(key);
    const extra = { ...(g.count ? { redacted: g.count } : {}), ...(notes.length ? { notes } : {}) };
    if (existingId) {
      const e = this.edges.get(existingId)!;
      const fields: Record<string, unknown> = {};
      if (input.weight !== undefined && input.weight !== e.weight) fields.weight = input.weight;
      if (note !== undefined && note !== e.note) fields.note = note;
      this.chargeEdge(actor, Buffer.byteLength(note ?? ''));
      if (Object.keys(fields).length) {
        const undo = this.inverseOf([{ op: 'patch', id: e.id, fields }]);
        this.append([{ op: 'patch', id: e.id, fields }]);
        Object.assign(e, fields);
        this.logActivity(actor, 'link', undo, undefined, [], `${e.from} -${e.rel}-> ${e.to}`);
        this.changed([e.id]);
      }
      return { edge: { ...e }, created: false, ...extra };
    }
    this.chargeEdge(actor, Buffer.byteLength(note ?? ''));
    const edge: KgEdge = {
      id: newId('e'), from: input.from, to: input.to, rel,
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...(note ? { note } : {}),
      createdBy: actorName(actor), createdAt: nowIso(),
    };
    this.append([{ op: 'edge', edge }]);
    this.addEdge(edge);
    this.logActivity(actor, 'link', [{ op: 'del_edge', id: edge.id }], undefined, [], `${edge.from} -${edge.rel}-> ${edge.to}`);
    this.changed([edge.id, edge.from, edge.to]);
    return { edge: { ...edge }, created: true, ...extra };
  }

  /** A relation is a short word; it must not be a place to stash a secret (the same guard as every other text, plus a bar on key-sized hex). */
  private checkRel(g: { text: (s: string) => string }, rel: string): void {
    if (g.text(rel) !== rel || /[0-9a-f]{24,}/.test(rel)) throw new KgError('invalid', 'rel must be a short word such as depends_on: it looks like a key or token. Nothing was saved.');
    const exact = this.secrets?.() ?? [];
    if (rel.length >= 12 && exact.some((s) => typeof s === 'string' && s.length >= 12 && s.toLowerCase().includes(rel))) {
      throw new KgError('invalid', 'rel must be a short word such as depends_on: it matches part of a stored credential. Nothing was saved.');
    }
  }

  /** Remove an edge by id, or by from+to+rel. */
  unlink(actor: Actor, ref: { id: string } | { from: string; to: string; rel: string }): KgEdge {
    const id = 'id' in ref ? ref.id : this.edgeKeys.get(edgeKey(ref.from, ref.to, normRel(ref.rel)));
    const e = id ? this.edges.get(id) : undefined;
    if (!e || !this.edgeVisible(actor, e)) throw new KgError('not_found', 'No such link.');
    if (actor.kind === 'agent' && actor.id === ARCHIVIST_ID && e.createdBy !== actor.id) {
      throw new KgError('forbidden', 'The Archivist flags and proposes, it never removes links it did not make.');
    }
    if (actor.kind === 'agent' && e.createdBy !== actor.id) {
      if (isTainted(actor)) throw new KgError('forbidden', 'This run touched outside content (web, shell or external tools), so it may remove only links it created itself.');
      const f = this.nodes.get(e.from)!;
      const t = this.nodes.get(e.to)!;
      if (!this.canWrite(actor, f.scope) || !this.canWrite(actor, t.scope)) throw new KgError('forbidden', 'This link touches read-only (bsv) content and was not created by you.');
    }
    this.chargeEdge(actor);
    this.append([{ op: 'del_edge', id: e.id }]);
    this.dropEdge(e.id);
    if (actor.kind === 'human' && e.createdBy === 'system' && this.nodes.get(e.from)?.scope === 'bsv' && this.nodes.get(e.to)?.scope === 'bsv') {
      this.seedGone.edges.add(`${e.from}|${e.rel}|${e.to}`);
      this.saveSeedGone();
    }
    this.logActivity(actor, 'unlink', [{ op: 'edge', edge: { ...e } }], undefined, [], `${e.from} -${e.rel}-> ${e.to}`);
    this.changed([e.id, e.from, e.to]);
    return { ...e };
  }

  /**
   * Change an edge's relation, note or weight. Human only: no bot tool reaches it. The note goes through the same
   * secret guard as every other write. A relation change is one atomic append (drop the old edge, add it back under the
   * new relation, same id); it is refused when that relation already links the same two notes.
   */
  updateEdge(actor: Actor, id: string, patch: { rel?: string; note?: string | null; weight?: number | null }): KgEdge {
    if (actor.kind !== 'human') throw new KgError('forbidden', 'Only the human can edit a link.');
    if (!isObj(patch as unknown)) throw new KgError('invalid', 'Edge patch must be an object.');
    const e = this.edges.get(id);
    if (!e || !this.edgeVisible(actor, e)) throw new KgError('not_found', 'No such link.');
    if (patch.rel === undefined && patch.note === undefined && patch.weight === undefined) throw new KgError('invalid', 'Nothing to change: give rel, note or weight.');
    const rel = patch.rel !== undefined ? normRel(patch.rel) : e.rel;
    if (patch.note !== undefined && patch.note !== null && (typeof patch.note !== 'string' || patch.note.length > 500)) throw new KgError('invalid', 'note must be a string of at most 500 chars.');
    if (patch.weight !== undefined && patch.weight !== null && (typeof patch.weight !== 'number' || !Number.isFinite(patch.weight))) throw new KgError('invalid', 'weight must be a finite number.');
    if (rel !== e.rel) {
      const clash = this.edgeKeys.get(edgeKey(e.from, e.to, rel));
      if (clash && clash !== e.id) throw new KgError('conflict', `These two notes are already linked as "${rel}". Remove that link first, or keep this one as "${e.rel}".`);
    }
    const g = this.guard();
    if (rel !== e.rel) this.checkRel(g, rel);
    const next: KgEdge = { ...e, rel };
    if (patch.note !== undefined) {
      const t = patch.note === null ? '' : g.text(patch.note).trim();
      if (t) next.note = t; else delete next.note;
    }
    if (patch.weight !== undefined) { if (patch.weight === null) delete next.weight; else next.weight = patch.weight; }
    if (JSON.stringify(next) === JSON.stringify(e)) return { ...e };
    if (rel !== e.rel) {
      this.apply([{ op: 'del_edge', id: e.id }, { op: 'edge', edge: next }]);
      // a pack link given another relation: the pack's own version of it must not be added back beside it
      if (e.createdBy === 'system' && this.nodes.get(e.from)?.scope === 'bsv' && this.nodes.get(e.to)?.scope === 'bsv') {
        this.seedGone.edges.add(`${e.from}|${e.rel}|${e.to}`);
        this.saveSeedGone();
      }
    } else {
      const fields: Record<string, unknown> = {};
      if (next.note !== e.note) fields.note = next.note ?? null;
      if (next.weight !== e.weight) fields.weight = next.weight ?? null;
      this.apply([{ op: 'patch', id: e.id, fields }]);
    }
    this.changed([e.id, e.from, e.to]);
    return { ...this.edges.get(e.id)! };
  }

  // ------------------------------------------------------------------ commit helpers, activity, undo

  private stamp(): string { return this.now().toISOString(); }

  /**
   * The ops that put things back as they were, computed from the state BEFORE `ops` are applied (in the order to
   * apply them). Used for the Activity list's Undo.
   */
  private inverseOf(ops: LogOp[]): LogOp[] {
    const inv: LogOp[] = [];
    const connected = (id: string) => [...new Set([...(this.out.get(id) ?? []), ...(this.inn.get(id) ?? [])])];
    for (const op of ops) {
      switch (op.op) {
        case 'node': {
          const n = op.node as KgNode;
          const cur = this.nodes.get(n.id);
          inv.push(cur ? { op: 'node', node: structuredClone(cur) } : { op: 'del_node', id: n.id });
          break;
        }
        case 'edge': {
          const e = op.edge as KgEdge;
          const clash = this.edgeKeys.get(edgeKey(e.from, e.to, e.rel));
          const clashEdge = clash && clash !== e.id ? this.edges.get(clash) : undefined;
          // pushed in reverse intent: the whole list is reversed at the end
          if (clashEdge) inv.push({ op: 'edge', edge: { ...clashEdge } });
          inv.push(this.edges.has(e.id) ? { op: 'edge', edge: { ...this.edges.get(e.id)! } } : { op: 'del_edge', id: e.id });
          break;
        }
        case 'patch': {
          const id = op.id as string;
          const fields = op.fields as Record<string, unknown>;
          const n = this.nodes.get(id);
          const e = n ? undefined : this.edges.get(id);
          // the revision counter goes back too, so undoing the latest change leaves the earlier entries' stamps valid again
          if (n) inv.push({ op: 'patch', id, fields: { ...Object.fromEntries(Object.keys(fields).map((k) => [k, (n as unknown as Record<string, unknown>)[k] ?? null])), rev: n.rev ?? 0 } });
          else if (e) inv.push({ op: 'patch', id, fields: Object.fromEntries(Object.keys(fields).map((k) => [k, (e as unknown as Record<string, unknown>)[k] ?? null])) });
          break;
        }
        case 'del_node': {
          const id = op.id as string;
          const n = this.nodes.get(id);
          if (!n) break;
          for (const eid of connected(id)) inv.push({ op: 'edge', edge: { ...this.edges.get(eid)! } });
          inv.push({ op: 'node', node: structuredClone(n) });
          break;
        }
        case 'del_edge': {
          const e = this.edges.get(op.id as string);
          if (e) inv.push({ op: 'edge', edge: { ...e } });
          break;
        }
      }
    }
    return inv.reverse();
  }

  /** Appends ops to the log and applies them to memory exactly as a reload would (so live state and replayed state cannot differ). */
  private apply(ops: LogOp[]): void {
    this.append(ops);
    for (const op of ops) if (this.replay(JSON.stringify(op))) this.totalEntries--; // append() already counted it
  }

  /** Puts one write on the Activity list (bots and the system only: the human's own edits are not listed). */
  private logActivity(actor: Actor, kind: string, inverse: LogOp[], main?: KgNode, touched: string[] = [], label?: string): void {
    if (actor.kind === 'human') return;
    const stamps: Record<string, number> = {};
    const edges: Record<string, string> = {};
    for (const id of new Set([main?.id, ...touched])) {
      const n = id ? this.nodes.get(id) : undefined;
      if (n) { stamps[n.id] = n.rev ?? 0; edges[n.id] = this.edgeSig(n.id); }
    }
    const m = main ? this.nodes.get(main.id) ?? main : undefined;
    this.activity.add({
      id: newId('act'), at: this.stamp(), who: actorName(actor),
      ...(actor.kind === 'agent' && actor.taskId ? { taskId: actor.taskId } : {}),
      ...(actor.kind === 'agent' && actor.origin?.fromAgentId ? { via: actor.origin.fromAgentId } : {}),
      kind, ...(m ? { nodeId: m.id, nodeType: m.type, trust: effectiveTrust(m) } : {}),
      ...(m || label ? { title: oneLine(m?.title ?? label ?? '').slice(0, 120) } : {}),
      tainted: m?.origin?.tainted ?? isTainted(actor), inverse, stamps, edges,
    });
  }

  /** A short fingerprint of the links touching a node (undo of a create refuses when a link was added or removed since). */
  private edgeSig(id: string): string {
    const ids = [...new Set([...(this.out.get(id) ?? []), ...(this.inn.get(id) ?? [])])].sort();
    return `${ids.length}:${createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 16)}`;
  }

  /**
   * Why an undo would be refused because things moved on, or undefined. Nodes are compared by revision counter (older
   * entries carry a timestamp instead), and an undo that would delete a node also checks that its links are as they were.
   */
  private undoStale(e: ActivityEntry): { id: string; what: 'node' | 'links' } | undefined {
    for (const [id, at] of Object.entries(e.stamps)) {
      const n = this.nodes.get(id);
      if (!n) continue;
      if (typeof at === 'number' ? (n.rev ?? 0) !== at : n.updatedAt !== at) return { id, what: 'node' };
    }
    for (const op of e.inverse ?? []) {
      if (op.op !== 'del_node' || typeof op.id !== 'string') continue;
      const was = e.edges?.[op.id];
      if (was !== undefined && this.nodes.has(op.id) && this.edgeSig(op.id) !== was) return { id: op.id, what: 'links' };
    }
    return undefined;
  }

  private requireHuman(actor: Actor, what: string): void {
    if (actor.kind === 'agent') throw new KgError('forbidden', `Only the human can ${what}.`);
  }

  /** The last writes by bots and the system, newest first. Human only. */
  activityFeed(actor: Actor, opts: { limit?: number; agentId?: string } = {}): KgActivityRow[] {
    this.requireHuman(actor, 'read the activity list');
    const limit = clampInt(opts.limit, 1, 200, 50);
    const rows: KgActivityRow[] = [];
    for (const e of this.activity.list()) {
      if (opts.agentId && e.who !== opts.agentId) continue;
      rows.push(this.activityRow(e));
      if (rows.length >= limit) break;
    }
    return rows;
  }

  private activityRow(e: ActivityEntry): KgActivityRow {
    const blocked = this.undoBlock(e);
    return {
      id: e.id, at: e.at, who: e.who, ...(e.taskId ? { taskId: e.taskId } : {}), kind: e.kind,
      ...(e.nodeId ? { nodeId: e.nodeId } : {}), ...(e.nodeType ? { nodeType: e.nodeType } : {}), ...(e.title ? { title: e.title } : {}),
      ...(e.trust ? { trust: e.trust } : {}), tainted: e.tainted, undoable: this.activity.isUndoable(e), undone: e.undone === true,
      ...(blocked ? { blocked } : {}),
    };
  }

  /** Why an Undo would be refused (same checks as undo()), so the list can say it before the click. */
  private undoBlock(e: ActivityEntry): KgActivityRow['blocked'] {
    if (e.undone) return undefined;
    if (!e.inverse) return 'too_large';
    if (!this.activity.isUndoable(e)) return 'expired';
    return this.undoStale(e) ? 'changed' : undefined;
  }

  /**
   * Undo one Activity entry (within 7 days): restores what it changed. Human only. Refuses when a node it touched
   * has been changed since, so an undo can never wipe out a later edit.
   */
  undo(actor: Actor, entryId: string): KgActivityRow {
    this.requireHuman(actor, 'undo a write');
    const e = this.activity.get(entryId);
    if (!e) throw new KgError('not_found', `Unknown activity entry "${entryId}" (entries are kept for ${ACTIVITY_DAYS} days).`);
    if (e.undone) throw new KgError('conflict', 'This write was already undone.');
    if (!this.activity.isUndoable(e)) throw new KgError('conflict', `This write can no longer be undone (older than ${ACTIVITY_DAYS} days, or too large to keep).`);
    const stale = this.undoStale(e);
    if (stale) {
      throw new KgError('conflict', stale.what === 'links'
        ? `"${stale.id}" has had links added or removed since this write, and undoing would delete it with them. Remove it yourself if you still want it gone (nothing was undone).`
        : `"${stale.id}" has changed since this write. Undo the later change first (nothing was undone).`);
    }
    const ops = (e.inverse ?? []).filter((op) => {
      if (op.op === 'patch') return this.nodes.has(op.id as string) || this.edges.has(op.id as string);
      return true;
    });
    const touched = new Set<string>();
    for (const op of ops) for (const k of ['id']) if (typeof op[k] === 'string') touched.add(op[k] as string);
    if (ops.length) { this.apply(ops); this.changed([...touched, ...Object.keys(e.stamps)]); }
    this.activity.markUndone(entryId);
    return this.activityRow(e);
  }

  // ------------------------------------------------------------------ capture, working memory, supersede, merge

  /** Existing live nodes whose title is a near-duplicate (token Jaccard >= 0.7), best first. */
  similarTitles(actor: Actor, title: string): Array<{ id: string; title: string; score: number }> {
    const a = new Set(tokenize(title));
    if (!a.size) return [];
    const out: Array<{ id: string; title: string; score: number }> = [];
    for (const n of this.nodes.values()) {
      if (!this.canSeeNode(actor, n) || isInactive(n) || n.type === 'episode' || n.id.startsWith(WM_PREFIX)) continue;
      const b = new Set(tokenize(n.title));
      if (!b.size) continue;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const j = inter / (a.size + b.size - inter);
      if (j >= SIMILAR_TITLE_JACCARD) out.push({ id: n.id, title: shownTitle(n), score: Math.round(j * 100) / 100 });
    }
    return out.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id)).slice(0, 3);
  }

  /**
   * How an agent may change an existing node: 'direct', as a 'proposal' for the human (human-trust notes, anything a
   * held run or the Archivist touches that it did not write in this run), or not at all.
   */
  private editMode(actor: Actor, n: KgNode): 'direct' | 'proposal' | 'forbidden' {
    if (actor.kind !== 'agent') return 'direct';
    if (!this.canWrite(actor, n.scope) || n.id.startsWith(WM_PREFIX)) return 'forbidden';
    if (n.scope !== 'shared') return 'direct';
    const w = this.writeCtx(actor, n.scope, false);
    const ownedByRun = !!actor.taskId && n.origin?.taskId === actor.taskId;
    return trustOf(n) === 'human' || (w.hold && (!ownedByRun || statusOf(n) === 'active')) ? 'proposal' : 'direct';
  }

  /**
   * Captures one structured note (kind decision, mistake, pattern, project or idea; the body is already rendered by
   * the caller). ONE atomic append: the node, its links and, for `supersedes`, the old node's retirement. Near-duplicate
   * titles are reported and nothing is written unless `force` or `supersedes` is given.
   */
  capture(actor: Actor, input: CaptureInput): CaptureResult {
    if (actor.kind !== 'agent') throw new KgError('forbidden', 'kg_capture is a bot tool: the human writes notes directly.');
    const g = this.guard();
    const f = this.cleanFields({
      type: input.type, title: input.title, body: input.body, tags: input.tags, sources: input.sources, confidence: input.confidence,
      ...(input.scope ? { scope: input.scope } : {}),
    }, true, g);
    const scope = f.scope ?? 'shared';
    if (!this.canWrite(actor, scope)) throw new KgError('forbidden', `You may write only to "shared" or your own private scope, not "${scope}".`);
    this.guardTriggerTags(actor, f.tags);
    if (!input.supersedes && !input.force) {
      const similar = this.similarTitles(actor, f.title!);
      if (similar.length) return { saved: false, similar, edges: 0, notes: [] };
    }
    let w = this.writeCtx(actor, scope, false);
    const notes = [...w.notes];
    let target: KgNode | undefined;
    let direct = false;
    if (input.supersedes) {
      target = this.mustSee(actor, input.supersedes);
      this.assertReplaceable(target, 'superseded');
      if (target.scope !== scope) throw new KgError('invalid', `supersedes must name a note in the same scope as the new one (${scope}); "${target.id}" is in ${target.scope}.`);
      const mode = this.editMode(actor, target);
      if (mode === 'forbidden') throw new KgError('forbidden', `You may not replace "${target.id}".`);
      direct = mode === 'direct' && !w.hold;
      if (!direct && !w.hold) {
        // a note the bot may not rewrite: its replacement is a pending proposal, the old note stays until the human accepts
        w = { ...w, hold: true };
        notes.push(`You may not replace "${target.id}" directly (it was written or accepted by the human): your note was saved as a pending proposal that supersedes it. The human decides.`);
      } else if (!direct) notes.push(`"${target.id}" stays live until the human accepts your pending note.`);
    }
    const links = (input.links ?? []).map((l) => ({ to: l.to, rel: normRel(l.rel ?? 'relates') }));
    for (const l of links) this.checkRel(g, l.rel);
    // links run FROM the new node, so even a tainted run (which may only wire up what it wrote itself) may add them
    for (const l of links) this.mustSee(actor, l.to);
    const node = this.buildNode(actor, f, scope, w, undefined, false);
    const edges: KgEdge[] = [];
    const seen = new Set<string>();
    const addEdge = (to: string, rel: string) => {
      const k = edgeKey(node.id, to, rel);
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ id: newId('e'), from: node.id, to, rel, createdBy: actor.id, createdAt: nowIso() });
    };
    if (target) addEdge(target.id, 'supersedes');
    for (const l of links) addEdge(l.to, l.rel);
    this.chargeNode(actor, Buffer.byteLength(JSON.stringify([f.title, f.body, f.tags, f.sources])));
    for (const _e of edges) this.chargeEdge(actor);
    const ops: LogOp[] = [{ op: 'node', node }, ...edges.map((edge) => ({ op: 'edge', edge }) as LogOp)];
    if (target && direct) ops.push({ op: 'patch', id: target.id, fields: { status: 'superseded', supersededBy: node.id, updatedAt: this.stamp() } });
    const undo = this.inverseOf(ops);
    this.apply(ops);
    const stored = this.nodes.get(node.id)!;
    this.logActivity(actor, input.supersedes ? 'supersede' : 'capture', undo, stored, target ? [target.id] : []);
    this.changed([node.id, ...edges.map((e) => e.id), ...(target ? [target.id] : [])]);
    return {
      saved: true, node: structuredClone(stored), edges: edges.length, ...(w.hold ? { pending: true } : {}),
      ...(target ? { superseded: target.id, supersededNow: direct } : {}), ...(g.count ? { redacted: g.count } : {}), notes,
    };
  }

  private assertReplaceable(n: KgNode, what: string): void {
    const st = statusOf(n);
    if (st === 'superseded' || st === 'archived') throw new KgError('conflict', `"${n.id}" is already ${st}${n.supersededBy ? ` (by ${n.supersededBy})` : ''}; it cannot be ${what} again.`);
  }

  /**
   * A bot's working memory: the node `wm:<agentId>` (private, type memory) with an ACTIVE section (at most 2,500
   * chars, shown to the bot at the start of its next run) and an ARCHIVE scratch log. The only writer; refused in a
   * run that touched outside content, so nothing a web page said can ever reach the next run's briefing.
   */
  setWorkingMemory(actor: Actor, input: { active: string; archiveAppend?: string }): { node: KgNode; created: boolean; changed: boolean; archiveTrimmed: boolean; redacted?: number } {
    if (actor.kind !== 'agent') throw new KgError('forbidden', 'Working memory belongs to a bot.');
    if (isTainted(actor)) {
      throw new KgError('forbidden', 'This run touched outside content (web, shell or external tools), so it may not write working memory: the next run would read it as its own. Nothing was saved. Put findings in a note (they go to the human inbox) and keep your working memory for clean runs.');
    }
    if (typeof input.active !== 'string') throw new KgError('invalid', 'active must be a string.');
    if (input.archiveAppend !== undefined && typeof input.archiveAppend !== 'string') throw new KgError('invalid', 'archiveAppend must be a string.');
    const g = this.guard();
    const active = g.text(input.active).replace(/\s+$/, '');
    if (active.length > WM_ACTIVE_MAX) throw new KgError('invalid', `active is ${active.length} chars; the cap is ${WM_ACTIVE_MAX}. Shorten it (move old items into archiveAppend); nothing was saved.`);
    const extraLines = input.archiveAppend ? g.text(input.archiveAppend).split('\n').map((l) => l.trim()).filter(Boolean) : [];
    if ([active, ...extraLines].some((t) => /^##[ \t]+(ACTIVE|ARCHIVE)\b/im.test(t))) throw new KgError('invalid', 'Working memory text may not contain "## ACTIVE" or "## ARCHIVE" headings. Nothing was saved.');
    const id = wmId(actor.id);
    const scope = `agent:${actor.id}` as KgScope;
    if (!ID_RE.test(id) || !isScope(scope)) throw new KgError('invalid', 'This agent id cannot own working memory.');
    const existing = this.nodes.get(id);
    const old = existing ? parseWorkingMemory(existing.body) : { active: '', archive: [] as string[] };
    const day = this.stamp().slice(0, 10);
    let archive = [...old.archive, ...extraLines.map((l) => `- ${day} ${l}`)];
    let trimmed = false;
    // the archive is scratch: keep the newest lines that fit
    while (archive.join('\n').length > WM_ARCHIVE_MAX && archive.length > 1) { archive = archive.slice(1); trimmed = true; }
    if (archive.length === 1 && archive[0]!.length > WM_ARCHIVE_MAX) { archive = [archive[0]!.slice(-WM_ARCHIVE_MAX)]; trimmed = true; }
    const body = renderWorkingMemory(active, archive);
    const bytes = Buffer.byteLength(body);
    const origin: KgOrigin | undefined = actor.taskId ? { taskId: actor.taskId, tainted: false, ...(actor.origin?.fromAgentId ? { via: actor.origin.fromAgentId } : {}) } : undefined;
    this.chargeNode(actor, bytes);
    const extra = g.count ? { redacted: g.count } : {};
    if (existing) {
      if (existing.body === body) return { node: structuredClone(existing), created: false, changed: false, archiveTrimmed: trimmed, ...extra };
      const fields: Record<string, unknown> = { body, updatedAt: this.stamp() };
      if (origin) fields.origin = origin;
      const op: LogOp = { op: 'patch', id, fields };
      const undo = this.inverseOf([op]);
      this.apply([op]);
      const n = this.nodes.get(id)!;
      this.logActivity(actor, 'wm', undo, n);
      this.changed([id]);
      return { node: structuredClone(n), created: false, changed: true, archiveTrimmed: trimmed, ...extra };
    }
    const now = this.stamp();
    const node: KgNode = {
      id, type: 'memory', title: `Working memory: ${actor.id}`, body, tags: ['working-memory'], scope, trust: 'agent',
      ...(origin ? { origin } : {}), createdBy: actor.id, createdAt: now, updatedAt: now,
    };
    this.apply([{ op: 'node', node }]);
    const n = this.nodes.get(id)!;
    this.logActivity(actor, 'wm', [{ op: 'del_node', id }], n);
    this.changed([id]);
    return { node: structuredClone(n), created: true, changed: true, archiveTrimmed: trimmed, ...extra };
  }

  private supersedeOps(old: KgNode, nw: KgNode, who: string): LogOp[] {
    const ops: LogOp[] = [{ op: 'patch', id: old.id, fields: { status: 'superseded', supersededBy: nw.id, updatedAt: this.stamp() } }];
    if (!this.edgeKeys.has(edgeKey(nw.id, old.id, 'supersedes'))) {
      ops.push({ op: 'edge', edge: { id: newId('e'), from: nw.id, to: old.id, rel: 'supersedes', createdBy: who, createdAt: nowIso() } });
    }
    return ops;
  }

  /** Merge plan: every drop is archived and points at keep; its links move to keep (a link that would loop or repeat just goes). */
  private mergeOps(actor: Actor, keep: KgNode, drops: KgNode[], who: string): { ops: LogOp[]; newEdges: number } {
    const ops: LogOp[] = [];
    const dropIds = new Set(drops.map((d) => d.id));
    const taken = new Set<string>();
    let newEdges = 0;
    for (const d of drops) {
      ops.push({ op: 'patch', id: d.id, fields: { status: 'archived', supersededBy: keep.id, updatedAt: this.stamp() } });
      if (!this.edgeKeys.has(edgeKey(keep.id, d.id, 'supersedes')) && !taken.has(edgeKey(keep.id, d.id, 'supersedes'))) {
        taken.add(edgeKey(keep.id, d.id, 'supersedes'));
        ops.push({ op: 'edge', edge: { id: newId('e'), from: keep.id, to: d.id, rel: 'supersedes', createdBy: who, createdAt: nowIso() } });
        newEdges++;
      }
    }
    const gone = new Set<string>();
    for (const d of drops) {
      for (const { edge, other } of this.adjacent(actor, d.id, 'both')) {
        if (gone.has(edge.id) || (edge.rel === 'supersedes' && other === keep.id && edge.from === keep.id)) continue;
        gone.add(edge.id);
        ops.push({ op: 'del_edge', id: edge.id });
        if (other === keep.id || dropIds.has(other)) continue;
        const from = edge.from === d.id ? keep.id : edge.from;
        const to = edge.to === d.id ? keep.id : edge.to;
        const key = edgeKey(from, to, edge.rel);
        if (this.edgeKeys.has(key) || taken.has(key)) continue;
        taken.add(key);
        ops.push({ op: 'edge', edge: { id: newId('e'), from, to, rel: edge.rel, ...(edge.weight !== undefined ? { weight: edge.weight } : {}), ...(edge.note ? { note: edge.note } : {}), createdBy: edge.createdBy, createdAt: nowIso() } });
        newEdges++;
      }
    }
    return { ops, newEdges };
  }

  /** A pending note that stands for a supersede or merge a bot may not do itself (props.proposal says which). */
  private proposalMarker(actor: Actor & { kind: 'agent' }, kind: 'supersede' | 'merge', props: Record<string, string>, title: string, reason: string | undefined, g: { text: (s: string) => string }): KgNode {
    const w = this.writeCtx(actor, 'shared', false);
    this.requirePendingRoom(actor);
    const now = nowIso();
    const text = reason ? oneLine(g.text(reason)).slice(0, 500) : '';
    return {
      id: newId('n'), type: 'note', title, body: text ? `Reason given by ${actor.id}: ${text}` : `Proposed by ${actor.id}.`, tags: ['proposal'], scope: 'shared',
      props: { proposal: kind, ...props }, trust: w.trust, status: 'pending', ...(w.origin ? { origin: w.origin } : {}),
      createdBy: actor.id, createdAt: now, updatedAt: now,
    };
  }

  /**
   * Replace `oldId` by `newId` (the old one is kept, marked superseded and hidden from recall). One atomic append.
   * A bot that may not edit the old note directly (human-trust, or a held run, or the Archivist) gets a pending proposal instead.
   */
  supersede(actor: Actor, oldId: string, newId_: string, opts: { reason?: string } = {}): SupersedeResult {
    if (oldId === newId_) throw new KgError('invalid', 'oldId and newId must differ.');
    const old = this.mustSee(actor, oldId);
    const nw = this.mustSee(actor, newId_);
    this.assertReplaceable(old, 'superseded');
    if (isInactive(nw)) throw new KgError('invalid', `"${nw.id}" is ${statusOf(nw)}: supersede with a live note.`);
    if (old.scope !== nw.scope) throw new KgError('invalid', `Both notes must be in the same scope (${old.id} is ${old.scope}, ${nw.id} is ${nw.scope}).`);
    const mode = this.editMode(actor, old);
    if (mode === 'forbidden') throw new KgError('forbidden', `You may not replace "${old.id}" (scope ${old.scope}).`);
    const g = this.guard();
    const asBot = actor.kind === 'agent';
    const direct = !asBot || (mode === 'direct' && statusOf(nw) === 'active' && !(old.scope === 'shared' && effectiveTrust(nw) === 'untrusted'));
    if (direct) {
      if (!asBot) this.requireNotPending(nw);
      const ops = this.supersedeOps(old, nw, actorName(actor));
      this.chargeNode(actor, 0);
      for (const o of ops) if (o.op === 'edge') this.chargeEdge(actor);
      const undo = this.inverseOf(ops);
      this.apply(ops);
      this.logActivity(actor, 'supersede', undo, this.nodes.get(nw.id), [old.id]);
      this.changed([old.id, nw.id]);
      return { mode: 'direct', old: structuredClone(this.nodes.get(old.id)!), notes: [] };
    }
    const marker = this.proposalMarker(actor as Actor & { kind: 'agent' }, 'supersede', { oldId: old.id, newId: nw.id }, `Proposal: supersede ${old.id} with ${nw.id}`, opts.reason, g);
    this.chargeNode(actor, Buffer.byteLength(JSON.stringify(marker)));
    const undo = this.inverseOf([{ op: 'node', node: marker }]);
    this.apply([{ op: 'node', node: marker }]);
    this.logActivity(actor, 'proposal', undo, this.nodes.get(marker.id));
    this.changed([marker.id]);
    return { mode: 'proposal', old: structuredClone(old), proposal: structuredClone(this.nodes.get(marker.id)!), notes: ['Saved as a pending proposal: the human decides whether to replace the note.'] };
  }

  private requireNotPending(n: KgNode): void {
    if (statusOf(n) === 'pending') throw new KgError('conflict', `"${n.id}" is still waiting for review: accept it first.`);
  }

  /**
   * Merge duplicates: `drop` notes are archived (superseded by `keep`) and their links move to `keep`. One atomic append.
   * Becomes a pending proposal when any of the notes may not be changed directly by this bot.
   */
  merge(actor: Actor, keepId: string, dropIds: string[], opts: { reason?: string } = {}): MergeResult {
    const ids = [...new Set(dropIds)];
    if (!ids.length) throw new KgError('invalid', 'drop must name at least one note.');
    if (ids.length > MAX_MERGE_DROPS) throw new KgError('invalid', `At most ${MAX_MERGE_DROPS} notes per merge.`);
    if (ids.includes(keepId)) throw new KgError('invalid', 'keep cannot also be in drop.');
    const keep = this.mustSee(actor, keepId);
    const drops = ids.map((i) => this.mustSee(actor, i));
    for (const n of [keep, ...drops]) {
      if (isInactive(n)) throw new KgError('conflict', `"${n.id}" is ${statusOf(n)}: merge only live notes.`);
      if (n.scope !== keep.scope) throw new KgError('invalid', `All notes must be in one scope (${keep.id} is ${keep.scope}, ${n.id} is ${n.scope}).`);
    }
    const modes = [keep, ...drops].map((n) => this.editMode(actor, n));
    if (modes.includes('forbidden')) throw new KgError('forbidden', `You may not change one of these notes (scope ${keep.scope}).`);
    const g = this.guard();
    const asBot = actor.kind === 'agent';
    const untrustedIntoTrusted = asBot && keep.scope === 'shared' && effectiveTrust(keep) === 'untrusted' && drops.some((d) => effectiveTrust(d) !== 'untrusted');
    const direct = !asBot || (modes.every((m) => m === 'direct') && !untrustedIntoTrusted && [keep, ...drops].every((n) => statusOf(n) === 'active'));
    if (direct) {
      const { ops } = this.mergeOps(actor, keep, drops, actorName(actor));
      for (let i = 0; i < drops.length; i++) this.chargeNode(actor, 0);
      for (const o of ops) if (o.op === 'edge') this.chargeEdge(actor);
      const undo = this.inverseOf(ops);
      this.apply(ops);
      this.logActivity(actor, 'merge', undo, this.nodes.get(keep.id), drops.map((d) => d.id));
      this.changed([keep.id, ...drops.map((d) => d.id)]);
      return { mode: 'direct', keep: structuredClone(this.nodes.get(keep.id)!), dropped: drops.map((d) => d.id), notes: [] };
    }
    const marker = this.proposalMarker(actor as Actor & { kind: 'agent' }, 'merge', { keep: keep.id, drop: ids.join(',') }, `Proposal: merge ${ids.join(', ')} into ${keep.id}`, opts.reason, g);
    this.chargeNode(actor, Buffer.byteLength(JSON.stringify(marker)));
    const undo = this.inverseOf([{ op: 'node', node: marker }]);
    this.apply([{ op: 'node', node: marker }]);
    this.logActivity(actor, 'proposal', undo, this.nodes.get(marker.id));
    this.changed([marker.id]);
    return { mode: 'proposal', keep: structuredClone(keep), dropped: [], proposal: structuredClone(this.nodes.get(marker.id)!), notes: ['Saved as a pending proposal: the human decides whether to merge.'] };
  }

  // ------------------------------------------------------------------ inbox (human only)

  /** Everything waiting for the human: held notes, edit proposals, supersede and merge proposals. Newest first. */
  inbox(actor: Actor, opts: { agentId?: string } = {}): KgInboxRow[] {
    this.requireHuman(actor, 'read the inbox');
    const rows: KgInboxRow[] = [];
    for (const n of this.nodes.values()) {
      if (statusOf(n) !== 'pending') continue;
      if (opts.agentId && n.createdBy !== opts.agentId) continue;
      const proposal = n.props?.proposal;
      let target: KgNode | undefined;
      if (proposal !== 'supersede' && proposal !== 'merge') target = this.editTarget(n);
      const kind = proposal === 'supersede' ? 'supersede' : proposal === 'merge' ? 'merge' : target ? 'edit' : 'note';
      const involved = kind === 'edit' ? [target] : kind === 'supersede' ? [n.props?.oldId, n.props?.newId].map((i) => this.nodes.get(String(i)))
        : kind === 'merge' ? [n.props?.keep, ...String(n.props?.drop ?? '').split(',')].map((i) => this.nodes.get(String(i))) : [];
      rows.push({
        id: n.id, kind,
        agentId: n.createdBy, node: structuredClone(n), ...(target ? { target: structuredClone(target) } : {}),
        tainted: n.origin?.tainted === true, untrusted: isUntrusted(n) || n.origin?.tainted === true, createdAt: n.createdAt,
        woken: n.origin?.via !== undefined, trigger: n.tags.some((t) => t.startsWith('trigger:')),
        touchesHuman: involved.some((x) => !!x && trustOf(x) === 'human'),
      });
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  /** The live note a pending edit proposal replaces (the target of its `supersedes` link). */
  private editTarget(n: KgNode): KgNode | undefined {
    for (const eid of this.out.get(n.id) ?? []) {
      const e = this.edges.get(eid);
      const t = e?.rel === 'supersedes' ? this.nodes.get(e.to) : undefined;
      if (t && statusOf(t) === 'active') return t;
    }
    return undefined;
  }

  /**
   * Accept a pending note: it goes live. Trust stays what the run earned: a note from a tainted run becomes 'agent'
   * (never 'human'), anything else becomes 'human' (the human accepted it), and an explicit edit by the human makes it
   * 'human' and clears the taint. An edit proposal replaces its target; a supersede or merge proposal is carried out.
   */
  acceptPending(actor: Actor, id: string, opts: { edit?: { title?: string; body?: string; tags?: string[] } } = {}): KgNode {
    this.requireHuman(actor, 'accept notes');
    const n = this.nodes.get(id);
    if (!n) throw new KgError('not_found', `Unknown node "${id}".`);
    if (statusOf(n) !== 'pending') throw new KgError('conflict', `"${id}" is not waiting for review.`);
    const who = actorName(actor);
    const proposal = n.props?.proposal;
    const ops: LogOp[] = [];
    if (proposal === 'supersede' || proposal === 'merge') {
      const live = (i: unknown): KgNode => {
        const x = typeof i === 'string' ? this.nodes.get(i) : undefined;
        if (!x || isInactive(x) || statusOf(x) === 'pending') throw new KgError('conflict', 'One of the notes in this proposal has changed or is gone: reject it instead.');
        return x;
      };
      if (proposal === 'supersede') {
        const old = live(n.props?.oldId);
        const nw = live(n.props?.newId);
        ops.push(...this.supersedeOps(old, nw, who));
      } else {
        const keep = live(n.props?.keep);
        const drops = String(n.props?.drop ?? '').split(',').filter(Boolean).map(live);
        ops.push(...this.mergeOps(HUMAN, keep, drops, who).ops);
      }
      ops.push({ op: 'patch', id, fields: { status: 'archived', props: { ...n.props, resolved: 'accepted' }, updatedAt: this.stamp() } });
    } else {
      const g = this.guard();
      const f = opts.edit ? this.cleanFields({ title: opts.edit.title, body: opts.edit.body, tags: opts.edit.tags }, false, g) : {};
      const edited = !!opts.edit && (f.title !== undefined || f.body !== undefined || f.tags !== undefined);
      const trust: KgTrust = edited ? 'human' : n.origin?.tainted || trustOf(n) === 'untrusted' ? 'agent' : 'human';
      const fields: Record<string, unknown> = { status: null, trust, updatedAt: this.stamp() };
      if (f.title !== undefined) fields.title = f.title;
      if (f.body !== undefined) fields.body = f.body;
      if (f.tags !== undefined) fields.tags = f.tags;
      if (edited && n.origin?.tainted) fields.origin = { ...n.origin, tainted: false };
      ops.push({ op: 'patch', id, fields });
      const target = this.editTarget(n);
      if (target) ops.push({ op: 'patch', id: target.id, fields: { status: 'superseded', supersededBy: id, updatedAt: this.stamp() } });
    }
    this.apply(ops);
    this.changed([id, ...ops.filter((o) => o.op === 'patch').map((o) => o.id as string)]);
    return structuredClone(this.nodes.get(id)!);
  }

  /**
   * Accept many. Bulk accept only takes plain rows: it skips a row with an untrusted source or from a tainted run (unless
   * `overrideUntrusted`), and ALWAYS skips a trigger note (a standing rule for every bot), a change to one of the human's own
   * notes, and anything written by a bot another bot woke under "ask" approvals. Those go through acceptPending, one at a time.
   */
  acceptMany(actor: Actor, opts: { ids?: string[]; agentId?: string; overrideUntrusted?: boolean } = {}): { accepted: string[]; skipped: Array<{ id: string; reason: string; code?: string }> } {
    this.requireHuman(actor, 'accept notes');
    const rows = this.inbox(actor, { agentId: opts.agentId }).filter((r) => !opts.ids || opts.ids.includes(r.id));
    const accepted: string[] = [];
    const skipped: Array<{ id: string; reason: string; code?: string }> = [];
    for (const id of opts.ids ?? []) if (!rows.some((r) => r.id === id)) skipped.push({ id, reason: 'not waiting for review', code: 'not_waiting' });
    for (const r of rows) {
      const hold = bulkHold(r, opts.overrideUntrusted === true);
      if (hold) { skipped.push({ id: r.id, ...hold }); continue; }
      try { this.acceptPending(actor, r.id); accepted.push(r.id); } catch (e) { skipped.push({ id: r.id, reason: e instanceof Error ? e.message : String(e), code: 'error' }); }
    }
    return { accepted, skipped };
  }

  /** Reject a pending note: it becomes a tombstone (hidden, purged after 30 days). */
  rejectPending(actor: Actor, id: string): KgNode {
    this.requireHuman(actor, 'reject notes');
    const n = this.nodes.get(id);
    if (!n) throw new KgError('not_found', `Unknown node "${id}".`);
    if (statusOf(n) !== 'pending') throw new KgError('conflict', `"${id}" is not waiting for review.`);
    this.apply([{ op: 'patch', id, fields: { status: 'archived', updatedAt: this.stamp() } }]);
    this.changed([id]);
    return structuredClone(this.nodes.get(id)!);
  }

  // ------------------------------------------------------------------ close-out, lint-lite, briefing

  /**
   * The deterministic summary the module writes when a long task ended without the bot capturing anything: an
   * `episode` node (private to the agent, written by the system, its source marked untrusted because the result may
   * quote web content). Same task, same node: a follow-up run updates it. No actor quota applies (system write).
   */
  recordEpisode(e: { taskId: string; agentId: string; title: string; status: string; turns: number; costUsd: number; prompt: string; result: string; tainted: boolean }): KgNode | undefined {
    const id = `ep:${e.taskId}`;
    const scope = `agent:${e.agentId}` as KgScope;
    if (!ID_RE.test(id) || !isScope(scope) || (this.nodes.size >= KG_LIMITS.maxNodes && !this.nodes.has(id))) return undefined;
    const g = this.guard();
    const header = `Task ${e.taskId} ended ${e.status} after ${e.turns} turns, $${e.costUsd.toFixed(2)}.`;
    let body: string;
    let title: string;
    try {
      title = clipCp(oneLine(g.text(`Episode: ${e.title || e.taskId}`)), KG_LIMITS.titleChars);
      // scrub the text first and cut it afterwards: a key or a seed phrase must never be cut in half and slip past the scrubber
      const gen = (s: string, max: number): string => clipCp(g.text(s.slice(0, EPISODE_SCRUB_WINDOW)), max);
      body = `${header}\n\nPrompt: ${gen(e.prompt, EPISODE_PROMPT_CHARS)}\n\nResult: ${gen(e.result, EPISODE_RESULT_CHARS)}`;
    } catch (err) {
      if (!(err instanceof KgError)) throw err;
      // a seed phrase or key in the text: keep the fact that the task ran, drop the text
      title = `Episode: ${e.taskId}`;
      body = `${header}\n\n(prompt and result left out: they contained a secret)`;
    }
    const now = this.stamp();
    const props = { taskId: e.taskId, turns: e.turns, costUsd: Math.round(e.costUsd * 100) / 100, status: e.status };
    const existing = this.nodes.get(id);
    const origin: KgOrigin = { taskId: e.taskId, tainted: e.tainted };
    let op: LogOp;
    if (existing) {
      op = { op: 'patch', id, fields: { title, body, props, origin, updatedAt: now } };
    } else {
      const node: KgNode = {
        id, type: 'episode', title, body, tags: ['episode', 'auto'], scope, props,
        sources: [{ ref: `task:${e.taskId}`, untrusted: true }], trust: 'untrusted', origin, createdBy: 'system', createdAt: now, updatedAt: now,
      };
      op = { op: 'node', node };
    }
    const undo = this.inverseOf([op]);
    this.apply([op]);
    const n = this.nodes.get(id)!;
    this.logActivity(SYSTEM, 'episode', undo, n);
    this.changed([id]);
    return structuredClone(n);
  }

  /**
   * The nightly free pass (no model calls): retire episodes older than 30 days, purge tombstones past their 30 days,
   * flag nodes past their per-type time-to-live (flag only: decision, pattern and mistake never go stale), drop
   * Activity entries past 7 days. Pure over the graph and its clock, so tests call it directly.
   */
  lintLite(): KgLintLite {
    const nowMs = this.now().getTime();
    const old = [...this.nodes.values()].filter((n) => n.type === 'episode' && !isInactive(n) && nowMs - Date.parse(n.updatedAt) > EPISODE_DAYS * DAY_MS);
    if (old.length) {
      this.apply(old.map((n) => ({ op: 'patch', id: n.id, fields: { status: 'archived', updatedAt: this.stamp() } }) as LogOp));
      this.changed(old.map((n) => n.id));
    }
    const purgedTombstones = this.purgeTombstones();
    const staleIds: string[] = [];
    let stale = 0;
    let pending = 0;
    for (const n of this.nodes.values()) {
      if (statusOf(n) === 'pending') pending++;
      if (isInactive(n) || statusOf(n) === 'pending') continue;
      const t = Date.parse(n.updatedAt);
      if (Number.isFinite(t) && (nowMs - t) / DAY_MS > staleDaysFor(n.type)) { stale++; if (staleIds.length < 50) staleIds.push(n.id); }
    }
    const report: KgLintLite = {
      at: this.stamp(), expiredEpisodes: old.length, purgedTombstones, stale, staleIds, prunedActivity: this.activity.prune(), pending,
    };
    this.lite = report;
    try { writeFileSync(join(this.dir, 'lint-lite.json'), JSON.stringify(report), 'utf8'); } catch { /* status only: memory holds it */ }
    return report;
  }

  lastLintLite(): KgLintLite | undefined { return this.lite; }

  /**
   * What an agent's run briefing may contain, and nothing else: its own working memory (written by a clean run), human-trust
   * trigger notes, the titles of the best recall hits that are trusted and live, and how many of its notes await review.
   * Pure and synchronous. Nothing from a tainted run, an untrusted source or a pending note can appear here.
   */
  briefingParts(agentId: string, opts: { projectKey?: string; prompt?: string } = {}): BriefingParts {
    const me = agentActor(agentId);
    const clean = (n: KgNode): boolean => statusOf(n) === 'active' && effectiveTrust(n) !== 'untrusted' && n.origin?.tainted !== true;
    let wm: string | undefined;
    const w = this.nodes.get(wmId(agentId));
    if (w && w.scope === `agent:${agentId}` && clean(w)) wm = parseWorkingMemory(w.body).active.trim() || undefined;
    const wanted = new Set(['trigger:always', normTag(`trigger:${agentId}`), ...(opts.projectKey ? [normTag(`trigger:project:${opts.projectKey}`)] : [])]);
    const rank = (n: KgNode): number => (n.tags.includes(normTag(`trigger:${agentId}`)) ? 0 : n.tags.includes('trigger:always') ? 2 : 1);
    const triggers = [...this.nodes.values()]
      .filter((n) => (n.scope === 'shared' || n.scope === `agent:${agentId}`) && statusOf(n) === 'active' && effectiveTrust(n) === 'human' && n.origin?.tainted !== true && n.tags.some((t) => wanted.has(t)))
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((n) => ({ id: n.id, title: n.title, body: n.body }));
    const skip = new Set([wmId(agentId), ...triggers.map((t) => t.id)]);
    const hits: Array<{ id: string; title: string }> = [];
    if (opts.prompt?.trim()) {
      for (const e of this.recallEntries(me, opts.prompt)) {
        const n = this.nodes.get(e.id);
        if (!n || skip.has(n.id) || !clean(n) || n.type === 'episode') continue;
        hits.push({ id: n.id, title: n.title });
        if (hits.length >= 3) break;
      }
    }
    let pending = 0;
    for (const n of this.nodes.values()) if (statusOf(n) === 'pending' && n.createdBy === agentId) pending++;
    return { ...(wm ? { wm } : {}), triggers, hits, pending };
  }

  // ------------------------------------------------------------------ validation

  private cleanFields(input: NodeInput, creating: boolean, g: { text: (s: string) => string }): CleanFields {
    const out: CleanFields = {};
    if (input.type !== undefined) {
      if (!isNodeType(input.type)) throw new KgError('invalid', `Invalid type "${String(input.type)}".`);
      out.type = input.type;
    }
    if (input.title !== undefined) {
      if (typeof input.title !== 'string') throw new KgError('invalid', 'title must be a string.');
      const t = oneLine(g.text(input.title));
      if (!t) throw new KgError('invalid', 'title must not be empty.');
      if (t.length > KG_LIMITS.titleChars) throw new KgError('invalid', `title is too long (${t.length} > ${KG_LIMITS.titleChars} chars). Shorten it; nothing was saved.`);
      out.title = t;
    } else if (creating) throw new KgError('invalid', 'title is required to create a node.');
    if (input.body !== undefined) {
      if (typeof input.body !== 'string') throw new KgError('invalid', 'body must be a string.');
      if (input.body.length > KG_LIMITS.bodyChars) throw new KgError('invalid', `body is too long (${input.body.length} > ${KG_LIMITS.bodyChars} chars). Split it into several linked nodes; nothing was saved.`);
      out.body = g.text(input.body);
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== 'string')) throw new KgError('invalid', 'tags must be an array of strings.');
      const tags = [...new Set(input.tags.map((t) => normTag(g.text(t))).filter(Boolean))];
      if (tags.length > MAX_TAGS) throw new KgError('invalid', `At most ${MAX_TAGS} tags.`);
      if (tags.some((t) => t.length > 64)) throw new KgError('invalid', 'A tag is longer than 64 chars.');
      out.tags = tags;
    }
    if (input.scope !== undefined) {
      if (!isScope(input.scope)) throw new KgError('invalid', `Invalid scope "${String(input.scope)}". Use shared, bsv or agent:<id>.`);
      out.scope = input.scope;
    }
    if (input.props !== undefined) {
      if (!isObj(input.props)) throw new KgError('invalid', 'props must be an object.');
      const entries = Object.entries(input.props);
      if (entries.length > MAX_PROPS) throw new KgError('invalid', `At most ${MAX_PROPS} props.`);
      const props: Record<string, string | number | boolean> = {};
      for (const [k0, v0] of entries) {
        const k = g.text(k0);
        if (!k || k.length > 64) throw new KgError('invalid', 'Invalid prop key.');
        let v = v0;
        if (typeof v === 'string') { v = g.text(v); if (v.length > 500) throw new KgError('invalid', `props.${k} is longer than 500 chars.`); }
        else if (typeof v === 'number') { if (!Number.isFinite(v)) throw new KgError('invalid', `props.${k} must be finite.`); }
        else if (typeof v !== 'boolean') throw new KgError('invalid', `props.${k} must be a string, number or boolean.`);
        props[k] = v;
      }
      out.props = props;
    }
    if (input.sources !== undefined) {
      if (!Array.isArray(input.sources)) throw new KgError('invalid', 'sources must be an array.');
      if (input.sources.length > MAX_SOURCES) throw new KgError('invalid', `At most ${MAX_SOURCES} sources.`);
      out.sources = input.sources.map((s) => {
        if (!isObj(s) || typeof s.ref !== 'string' || !s.ref.trim() || s.ref.length > 500) throw new KgError('invalid', 'Each source needs a ref string (max 500 chars).');
        if (s.licence !== undefined && (typeof s.licence !== 'string' || s.licence.length > MAX_LICENCE_CHARS)) throw new KgError('invalid', `source.licence must be a string of at most ${MAX_LICENCE_CHARS} chars.`);
        return { ref: g.text(s.ref.trim()), ...(s.licence ? { licence: g.text(s.licence) } : {}), ...(s.untrusted === true ? { untrusted: true } : {}) };
      });
    }
    if (input.untrusted !== undefined) {
      if (typeof input.untrusted !== 'boolean') throw new KgError('invalid', 'untrusted must be a boolean.');
      if (input.untrusted) {
        out.untrusted = true;
        out.sources = (out.sources ?? []).map((s) => ({ ...s, untrusted: true }));
      }
    }
    if (input.confidence !== undefined) {
      if (typeof input.confidence !== 'number' || !(input.confidence >= 0 && input.confidence <= 1)) throw new KgError('invalid', 'confidence must be a number between 0 and 1.');
      out.confidence = input.confidence;
    }
    return out;
  }

  // ------------------------------------------------------------------ index + memory state

  private indexNode(n: KgNode): void {
    const tf = new Map<string, number>();
    const bump = (text: string, w: number) => { for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + w); };
    bump(n.title, 3);
    bump(n.tags.join(' '), 2);
    bump(n.body, 1);
    let len = 0;
    for (const [t, c] of tf) {
      len += c;
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Set()));
      p.add(n.id);
    }
    this.docTf.set(n.id, tf);
    this.docLen.set(n.id, len);
    this.totalLen += len;
  }

  private unindexNode(id: string): void {
    const tf = this.docTf.get(id);
    if (!tf) return;
    for (const t of tf.keys()) {
      const p = this.postings.get(t);
      p?.delete(id);
      if (p && !p.size) this.postings.delete(t);
    }
    this.totalLen -= this.docLen.get(id) ?? 0;
    this.docTf.delete(id);
    this.docLen.delete(id);
  }

  private addEdge(e: KgEdge): void {
    const key = edgeKey(e.from, e.to, e.rel);
    const old = this.edgeKeys.get(key);
    if (old && old !== e.id) this.dropEdge(old);
    this.edges.set(e.id, e);
    this.edgeKeys.set(key, e.id);
    (this.out.get(e.from) ?? this.out.set(e.from, new Set()).get(e.from)!).add(e.id);
    (this.inn.get(e.to) ?? this.inn.set(e.to, new Set()).get(e.to)!).add(e.id);
  }

  private dropEdge(id: string): void {
    const e = this.edges.get(id);
    if (!e) return;
    this.edges.delete(id);
    if (this.edgeKeys.get(edgeKey(e.from, e.to, e.rel)) === id) this.edgeKeys.delete(edgeKey(e.from, e.to, e.rel));
    this.out.get(e.from)?.delete(id);
    this.inn.get(e.to)?.delete(id);
  }

  private dropNode(id: string): void {
    this.unindexNode(id);
    this.nodes.delete(id);
    this.out.delete(id);
    this.inn.delete(id);
  }

  /** Called after every committed write: maybe compact, then notify. */
  private changed(ids: string[]): void {
    this.maybeCompact();
    try { this.onChange?.(ids); } catch { /* listeners must not break writes */ }
  }

  // ------------------------------------------------------------------ log

  /**
   * Appends ops to the log. Several ops are written as ONE bracketed batch (begin, the ops, commit) in a single write, and a
   * log whose tail holds a batch that never reached its commit line loses that batch on load, so a crash can never leave
   * half of a merge or a supersede behind. The write takes the directory's lock and first catches up with any other writer.
   */
  private append(ops: object[]): void {
    const lines = ops.map((o) => JSON.stringify(o));
    const text = (ops.length > 1 ? [batchMark(BATCH_BEGIN, ops.length), ...lines, batchMark(BATCH_COMMIT, ops.length)] : lines).join('\n') + '\n';
    this.withLock(() => {
      this.syncFromDisk();
      const before = this.fileSize();
      try {
        appendFileSync(this.file, text, 'utf8');
      } catch (e) {
        // a failed write (a full disk) may have left part of the batch on disk while memory has not changed: cut it away,
        // or the next successful write would land behind a half batch
        try { truncateTo(this.file, before); } catch { /* nothing more can be done */ }
        throw e;
      }
      this.bytes += Buffer.byteLength(text);
      this.totalEntries += ops.length;
      this.diskId = this.fileId();
    });
  }

  private fileSize(): number {
    try { return statSync(this.file).size; } catch { return 0; }
  }

  private fileId(): string {
    try { const s = statSync(this.file); return `${s.ino}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'none'; }
  }

  /** Another Graph (a second process, or a restart that overlapped the old one) changed the log since we last looked: read it again before writing. */
  private syncFromDisk(): void {
    if (this.fileId() === this.diskId) return;
    this.nodes = new Map(); this.edges = new Map(); this.out = new Map(); this.inn = new Map(); this.edgeKeys = new Map();
    this.postings = new Map(); this.docTf = new Map(); this.docLen = new Map(); this.totalLen = 0;
    this.totalEntries = 0; this.bytes = 0;
    this.load();
    this.diskId = this.fileId();
  }

  /** Runs `fn` while holding `graph.jsonl.lock` (exclusive create). A lock left by a dead process, or older than 30 s, is taken over. */
  private withLock<T>(fn: () => T): T {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    const mine = `${process.pid} ${Date.now()}`;
    for (;;) {
      let fd: number;
      try {
        fd = openSync(lock, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return fn(); // a read-only or odd file system: no lock, same as before
        if (lockIsStale(lock)) { rmSync(lock, { force: true }); continue; }
        if (Date.now() > deadline) {
          throw new KgError('unavailable', `Another Legion process is holding ${lock} (${lockHolder(lock)}). If no other Legion is running, delete that file and try again.`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
        continue;
      }
      try { writeSync(fd, mine); } catch {
        // a full disk: the empty file we just made must not stay behind as a lock nobody owns
        try { closeSync(fd); } catch { /* already closed */ }
        rmSync(lock, { force: true });
        return fn();
      }
      closeSync(fd);
      break;
    }
    try { return fn(); } finally {
      try { if (readFileSync(lock, 'utf8') === mine) rmSync(lock, { force: true }); } catch { /* already gone */ }
    }
  }

  private maybeCompact(): void {
    const live = this.nodes.size + this.edges.size;
    const dead = this.totalEntries - live;
    if (this.bytes >= this.compactMinBytes && dead > this.totalEntries / 2) {
      try { this.compact(); } catch { /* the log stays valid; try again after the next write */ }
    }
  }

  /**
   * Copies the log to graph.jsonl.bak-N (N counts up; the newest 5 are kept). Taken before anything that rewrites or
   * mass-removes history: compaction, vault import, seeding, bulk deletes. Skipped when the newest snapshot is identical.
   * Returns the snapshot path, or undefined when there was nothing to copy.
   */
  snapshot(): string | undefined {
    if (!existsSync(this.file) || statSync(this.file).size === 0) return undefined;
    return this.snapshotFrom(this.file);
  }

  private snapshotFrom(src: string): string | undefined {
    const nums = readdirSync(this.dir).map((f) => /^graph\.jsonl\.bak-(\d+)$/.exec(f)).filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1])).sort((a, b) => a - b);
    const last = nums[nums.length - 1];
    if (last !== undefined) {
      const prev = join(this.dir, `graph.jsonl.bak-${last}`);
      if (statSync(prev).size === statSync(src).size && readFileSync(prev).equals(readFileSync(src))) return prev;
    }
    const dest = join(this.dir, `graph.jsonl.bak-${(last ?? 0) + 1}`);
    copyFileSync(src, dest);
    for (const n of nums.slice(0, Math.max(0, nums.length + 1 - SNAPSHOTS_KEPT))) rmSync(join(this.dir, `graph.jsonl.bak-${n}`), { force: true });
    return dest;
  }

  /**
   * Called before every delete or tombstone. The first delete of a 10-minute window copies the log aside; when the
   * window reaches a sixth delete (a bulk delete) that copy, which still holds everything, becomes a snapshot.
   */
  private noteDelete(): void {
    const t = this.now().getTime();
    let w = this.delWindow;
    const pre = `${this.file}.pre-delete`;
    if (!w || t - w.start > BULK_WINDOW_MS) {
      w = { start: t, count: 0, preCopied: false };
      this.delWindow = w;
      try { if (existsSync(this.file)) { copyFileSync(this.file, pre); w.preCopied = true; } } catch { /* the snapshot below falls back to the live log */ }
    }
    w.count++;
    if (w.count === BULK_DELETES + 1) {
      try { this.snapshotFrom(w.preCopied && existsSync(pre) ? pre : this.file); } catch { /* best effort */ }
      rmSync(pre, { force: true });
    }
  }

  /** Rewrites the log from live state (tmp file + rename, so a crash leaves either the old or the new log). */
  compact(): void { this.withLock(() => this.compactLocked()); }

  private compactLocked(): void {
    this.syncFromDisk();
    this.snapshot();
    const lines: string[] = [];
    for (const n of this.nodes.values()) lines.push(JSON.stringify({ op: 'node', node: n }));
    for (const e of this.edges.values()) lines.push(JSON.stringify({ op: 'edge', edge: e }));
    const text = lines.length ? lines.join('\n') + '\n' : '';
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(tmp, this.file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
    this.totalEntries = lines.length;
    this.bytes = Buffer.byteLength(text);
    this.diskId = this.fileId();
  }

  /** Log size and how many entries are dead (superseded or deleted). For tests and diagnostics. */
  logInfo(): { bytes: number; entries: number; live: number } {
    return { bytes: this.bytes, entries: this.totalEntries, live: this.nodes.size + this.edges.size };
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const buf = readFileSync(this.file);
    this.bytes = buf.length;
    if (!buf.length) return;
    // everything up to the last newline is complete lines; what follows is a partial or unterminated record
    const keep = buf.lastIndexOf(0x0a) + 1;
    // a batch (begin ... commit) applies as a whole or not at all
    let open: { start: number; n: number | undefined; lines: string[] } | undefined;
    for (let pos = 0; pos < keep; ) {
      const nl = buf.indexOf(0x0a, pos);
      const line = buf.toString('utf8', pos, nl);
      const start = pos;
      pos = nl + 1;
      if (!line.trim()) continue;
      const mark = markerKind(line);
      // a counted batch already holds all its ops: anything but its commit now means it was cut short by a failed write
      if (open && open.n !== undefined && open.lines.length >= open.n && mark !== 'commit') {
        this.loadInfo.skippedLines += open.lines.length + 1;
        open = undefined;
      }
      if (mark === 'begin') {
        if (open) this.loadInfo.skippedLines += open.lines.length + 1; // an earlier batch never committed
        const n = markerCount(line);
        // an uncounted begin with no commit anywhere after it cannot be told from a crash tail: ignore the marker, apply the lines
        if (n === undefined && buf.indexOf('\n{"op":"commit"', pos - 1) < 0) { open = undefined; continue; }
        open = { start, n, lines: [] };
      } else if (mark === 'commit') {
        if (open) {
          const n = markerCount(line);
          if (n !== undefined && n !== open.lines.length) this.loadInfo.skippedLines += open.lines.length + 1;
          else for (const l of open.lines) if (!this.replay(l)) this.loadInfo.skippedLines++;
          open = undefined;
        }
      } else if (open) open.lines.push(line);
      else if (!this.replay(line)) this.loadInfo.skippedLines++;
    }
    if (open) {
      const rest = buf.subarray(keep).toString('utf8').trim();
      if (markerKind(rest) === 'commit' && (markerCount(rest) ?? open.lines.length) === open.lines.length) {
        // the commit line was written but its newline was not
        for (const l of open.lines) if (!this.replay(l)) this.loadInfo.skippedLines++;
        appendFileSync(this.file, '\n');
        this.bytes += 1;
        return;
      }
      // a crash in the middle of a batch: drop it whole and cut the file back to where it began
      this.loadInfo.skippedLines += open.lines.length + 1;
      this.loadInfo.repairedTornTail = true;
      truncateTo(this.file, open.start);
      this.bytes = open.start;
      return;
    }
    if (keep === buf.length) return;
    const tail = buf.subarray(keep).toString('utf8');
    if (tail.trim() && this.replay(tail)) {
      // a complete record that only lacks its newline
      appendFileSync(this.file, '\n');
      this.bytes += 1;
    } else {
      // torn write: cut the file back to the last complete line so the next append starts clean
      if (tail.trim()) this.loadInfo.skippedLines++;
      this.loadInfo.repairedTornTail = true;
      truncateTo(this.file, keep);
      this.bytes = keep;
    }
  }

  /** Applies one log line to memory. Returns false for lines that cannot be used. */
  private replay(line: string): boolean {
    let op: unknown;
    try { op = JSON.parse(line); } catch { return false; }
    if (!isObj(op) || typeof op.op !== 'string') return false;
    switch (op.op) {
      case 'node': {
        const n = loadNode(op.node);
        if (!n) return false;
        const prev = this.nodes.get(n.id);
        // every change moves the revision counter on (a restored before-image included), so undo stamps cannot collide
        n.rev = prev ? Math.max(prev.rev ?? 0, n.rev ?? 0) + 1 : n.rev ?? 1;
        if (prev) this.unindexNode(n.id);
        this.nodes.set(n.id, n);
        this.indexNode(n);
        break;
      }
      case 'edge': {
        const e = loadEdge(op.edge);
        if (!e) return false;
        this.addEdge(e);
        break;
      }
      case 'del_node': {
        if (typeof op.id !== 'string') return false;
        for (const eid of [...(this.out.get(op.id) ?? []), ...(this.inn.get(op.id) ?? [])]) this.dropEdge(eid);
        this.dropNode(op.id);
        break;
      }
      case 'del_edge': {
        if (typeof op.id !== 'string') return false;
        this.dropEdge(op.id);
        break;
      }
      case 'patch': {
        if (typeof op.id !== 'string' || !isObj(op.fields)) return false;
        const n = this.nodes.get(op.id);
        if (n) {
          const next = loadNode({ ...n, ...patchFields(op.fields), rev: typeof op.fields.rev === 'number' ? op.fields.rev : (n.rev ?? 0) + 1 });
          if (!next) return false;
          this.unindexNode(n.id);
          this.nodes.set(n.id, next);
          this.indexNode(next);
        } else {
          const e = this.edges.get(op.id);
          if (e) {
            if (op.fields.weight === null) delete e.weight; else if (typeof op.fields.weight === 'number') e.weight = op.fields.weight;
            if (op.fields.note === null) delete e.note; else if (typeof op.fields.note === 'string') e.note = op.fields.note;
          }
          // a patch for a node that no longer exists is harmless
        }
        break;
      }
      default: return false;
    }
    this.totalEntries++;
    return true;
  }
}

// ---------------------------------------------------------------------- helpers

/** A lock file is stale when it is old, or names a process on this machine that no longer exists. */
function lockIsStale(lock: string): boolean {
  let age: number;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return true; } // gone already: the next create decides
  let text = '';
  try { text = readFileSync(lock, 'utf8'); } catch { return age > LOCK_EMPTY_GRACE_MS; }
  const m = /^(\d+) (\d+)$/.exec(text.trim());
  // empty, cut short or garbage: a crashed writer or a stray file; give a live creator a moment to fill it in, then take it over
  if (!m) return age > LOCK_EMPTY_GRACE_MS;
  const pid = Number(m[1]);
  const at = Number(m[2]);
  if (Date.now() - at > LOCK_STALE_MS || age > LOCK_STALE_MS) return true;
  // this process never holds the lock outside withLock, so a lock naming us is a leftover (a restart that reused our pid)
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
  return false;
}

function lockHolder(lock: string): string {
  try { const t = readFileSync(lock, 'utf8').trim(); return t ? `pid/time ${t}` : 'empty lock file'; } catch { return 'unreadable'; }
}

function truncateTo(file: string, bytes: number): void {
  try { truncateSync(file, bytes); } catch { writeFileSync(file, readFileSync(file).subarray(0, bytes)); }
}

/** `## ACTIVE` / `## ARCHIVE` sections of a working-memory body. */
export function parseWorkingMemory(body: string): { active: string; archive: string[] } {
  const m = /^## ACTIVE\n([\s\S]*?)\n*^## ARCHIVE\n?([\s\S]*)$/m.exec(body);
  if (!m) return { active: '', archive: [] };
  return { active: m[1]!.replace(/\s+$/, ''), archive: m[2]!.split('\n').map((l) => l.trim()).filter(Boolean) };
}
const renderWorkingMemory = (active: string, archive: string[]): string => `## ACTIVE\n${active}\n\n## ARCHIVE\n${archive.join('\n')}\n`;

const edgeKey = (from: string, to: string, rel: string): string => `${from}\u0000${to}\u0000${rel}`;

export function normTag(t: string): string { return oneLine(t).replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-'); }

/** Checks everything about a link that does not depend on graph state; returns the normalised rel. */
export function validateLinkFields(input: { from: unknown; to: unknown; rel: unknown; weight?: unknown; note?: unknown }): string {
  const rel = normRel(input.rel);
  if (typeof input.from !== 'string' || typeof input.to !== 'string') throw new KgError('invalid', 'from and to must be node ids.');
  if (input.from === input.to) throw new KgError('invalid', 'A node cannot link to itself.');
  if (input.weight !== undefined && (typeof input.weight !== 'number' || !Number.isFinite(input.weight))) throw new KgError('invalid', 'weight must be a finite number.');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500)) throw new KgError('invalid', 'note must be a string of at most 500 chars.');
  return rel;
}

function normRel(rel: unknown): string {
  if (typeof rel !== 'string') throw new KgError('invalid', 'rel is required.');
  const r = oneLine(rel).toLowerCase().replace(/[\s-]+/g, '_');
  if (!REL_RE.test(r)) throw new KgError('invalid', 'rel must be 1-40 chars: a letter then letters, digits or underscores (e.g. depends_on).');
  return r;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new KgError('invalid', 'Expected a number.');
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/**
 * Props only the engine or the human may set: `reviewed` (human-reviewed) and the proposal fields that make a pending
 * note a supersede or merge proposal. A bot cannot forge them, so the inbox label and what accepting does stay honest.
 */
export const ENGINE_PROPS = ['reviewed', 'proposal', 'oldId', 'newId', 'keep', 'drop', 'resolved'] as const;
const stripReviewed = (p?: Record<string, string | number | boolean>) => {
  if (!p) return p;
  const rest = { ...p };
  for (const k of ENGINE_PROPS) delete rest[k];
  return rest;
};

function patchFields(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of NODE_FIELDS) {
    if (!(k in f)) continue;
    out[k] = f[k] === null ? (k === 'tags' ? [] : k === 'body' ? '' : undefined) : f[k];
  }
  return out;
}

/** Defensive: a hand-edited or damaged log must never put a malformed node in memory. */
function loadNode(v: unknown): KgNode | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id || typeof v.title !== 'string') return undefined;
  const scope = isScope(v.scope) ? v.scope : 'shared';
  const n: KgNode = {
    id: v.id, type: isNodeType(v.type) ? v.type : 'note', title: v.title, body: typeof v.body === 'string' ? v.body : '',
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [],
    scope, createdBy: typeof v.createdBy === 'string' ? v.createdBy : 'system',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : nowIso(),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : (typeof v.createdAt === 'string' ? v.createdAt : nowIso()),
  };
  if (isObj(v.props)) n.props = v.props as KgNode['props'];
  if (Array.isArray(v.sources)) {
    const src = v.sources.filter((s): s is KgSource => isObj(s) && typeof s.ref === 'string');
    if (src.length) n.sources = src;
  }
  if (typeof v.confidence === 'number') n.confidence = v.confidence;
  if (v.trust === 'human' || v.trust === 'agent' || v.trust === 'untrusted') n.trust = v.trust;
  if (v.status === 'pending' || v.status === 'superseded' || v.status === 'archived') n.status = v.status;
  if (typeof v.supersededBy === 'string' && v.supersededBy) n.supersededBy = v.supersededBy;
  if (typeof v.rev === 'number' && Number.isFinite(v.rev) && v.rev >= 0) n.rev = Math.floor(v.rev);
  if (isObj(v.origin) && typeof v.origin.taskId === 'string') {
    n.origin = { taskId: v.origin.taskId, tainted: v.origin.tainted === true, ...(typeof v.origin.via === 'string' ? { via: v.origin.via } : {}) };
  }
  return n;
}

function loadEdge(v: unknown): KgEdge | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.from !== 'string' || typeof v.to !== 'string' || typeof v.rel !== 'string') return undefined;
  const e: KgEdge = {
    id: v.id, from: v.from, to: v.to, rel: v.rel, createdBy: typeof v.createdBy === 'string' ? v.createdBy : 'system',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : nowIso(),
  };
  if (typeof v.weight === 'number') e.weight = v.weight;
  if (typeof v.note === 'string') e.note = v.note;
  return e;
}
