/**
 * The Lattice graph store: an append-only JSONL event log loaded into in-memory indexes
 * (id map, adjacency, inverted token index). Synchronous, no dependencies, unit-testable on a temp dir.
 * Visibility and write rules are enforced here, so no caller can bypass them.
 */
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { KG_LIMITS } from '../../shared/kg.js';
import type {
  KgEdge, KgLintReport, KgNode, KgScope, KgSearchHit, KgSource, KgSubgraph,
} from '../../shared/kg.js';
import { newId, nowIso } from '../../shared/util.js';
import { makeSnippet, oneLine, safeTitle, tokenize, wrapNode, DATA_LINE, isUntrusted } from './text.js';
import { actorName, isNodeType, KgError } from './types.js';
import type {
  Actor, GraphStats, LinkInput, LinkResult, NeighborsResult, NodeInput, PathResult, RecallResult, UpsertResult,
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
}

export interface SearchOptions { scope?: string; type?: string; tags?: string[]; limit?: number }
export interface NeighborOptions { rel?: string; dir?: 'out' | 'in' | 'both'; depth?: number; limit?: number }
export interface PathOptions { maxDepth?: number; rels?: string[] }

const STALE_DAYS = 90;
const MAX_TAGS = 32;
const MAX_SOURCES = 20;
const MAX_PROPS = 32;
export const MAX_LICENCE_CHARS = 200;
const SCOPE_RE = /^agent:[A-Za-z0-9_.-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const REL_RE = /^[a-z][a-z0-9_]{0,39}$/;
const NODE_FIELDS = ['type', 'title', 'body', 'tags', 'scope', 'props', 'sources', 'confidence', 'updatedAt'] as const;
const K1 = 1.2;
const B = 0.75;

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
  /** What load() found: lines it could not use and whether a torn tail was repaired. */
  readonly loadInfo = { skippedLines: 0, repairedTornTail: false };

  constructor(opts: GraphOptions) {
    this.dir = opts.dir;
    this.file = join(opts.dir, 'graph.jsonl');
    this.bsvOn = opts.bsvEnabled ?? (() => false);
    this.now = opts.now ?? (() => new Date());
    this.compactMinBytes = opts.compactMinBytes ?? 1_048_576;
    this.onChange = opts.onChange;
    mkdirSync(this.dir, { recursive: true });
    this.load();
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

  private seen(actor: Actor, id: string): KgNode | undefined {
    const n = this.nodes.get(id);
    return n && this.canSee(actor, n.scope) ? n : undefined;
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
    for (const n of this.nodes.values()) if (this.canSee(actor, n.scope)) res.push(structuredClone(n));
    return res;
  }

  findByTitle(actor: Actor, title: string): KgNode[] {
    const t = normTitle(title);
    const res: KgNode[] = [];
    for (const n of this.nodes.values()) if (this.canSee(actor, n.scope) && normTitle(n.title) === t) res.push(structuredClone(n));
    return res;
  }

  /** Total counts over every scope (for change events, not for agents). */
  counts(): { nodes: number; edges: number } { return { nodes: this.nodes.size, edges: this.edges.size }; }

  stats(actor: Actor): GraphStats {
    const byType: Record<string, number> = {};
    const byScope: Record<string, number> = {};
    let nodes = 0;
    for (const n of this.nodes.values()) {
      if (!this.canSee(actor, n.scope)) continue;
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
    for (const [id, score] of scores) {
      const n = this.nodes.get(id);
      if (!n || !this.canSee(actor, n.scope)) continue;
      if (opts.scope !== undefined && n.scope !== opts.scope) continue;
      if (opts.type !== undefined && n.type !== opts.type) continue;
      if (wantTags.length && !wantTags.every((t) => n.tags.includes(t))) continue;
      hits.push({
        node: { id: n.id, type: n.type, title: n.title, tags: [...n.tags], scope: n.scope, updatedAt: n.updatedAt, snippet: makeSnippet(n.body, qTokens) || oneLine(n.title) },
        score: Math.round(score * 10_000) / 10_000,
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
    for (const n of this.nodes.values()) if (this.canSee(actor, n.scope)) { visible.push(n); degree.set(n.id, 0); }
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

  /** Search top-k, expand one hop, rank with score decay, return a compact outline within the budget. */
  recall(actor: Actor, query: string, opts: { budgetChars?: number } = {}): RecallResult {
    const budget = clampInt(opts.budgetChars, 120, KG_LIMITS.toolResultChars, 4_000);
    const q = oneLine(query);
    const seeds = this.search(actor, q, { limit: 5 });
    if (!seeds.length) {
      const text = `No matching nodes in the knowledge graph for "${safeTitle(q).slice(0, 80)}". Proceed without it, and write what you learn with kg_upsert_node when it is durable.`;
      return { outline: text.slice(0, budget), nodeIds: [], truncated: false };
    }
    const seedIds = new Set(seeds.map((s) => s.node.id));
    interface Entry { id: string; score: number; seed: boolean; via?: { rel: string; dir: 'out' | 'in'; seedId: string }; snippet?: string }
    const entries = new Map<string, Entry>();
    for (const s of seeds) entries.set(s.node.id, { id: s.node.id, score: s.score, seed: true, snippet: s.node.snippet });
    for (const s of seeds) {
      let taken = 0;
      for (const { edge, other } of this.adjacent(actor, s.node.id, 'both')) {
        if (seedIds.has(other) || taken >= 6) continue;
        const w = Math.min(1, Math.max(0.1, edge.weight ?? 1));
        const score = s.score * 0.5 * w;
        const cur = entries.get(other);
        if (!cur || cur.score < score) {
          entries.set(other, { id: other, score, seed: false, via: { rel: edge.rel, dir: edge.from === s.node.id ? 'out' : 'in', seedId: s.node.id } });
          taken++;
        }
      }
    }
    const ranked = [...entries.values()].sort((a, b) => b.score - a.score || Number(b.seed) - Number(a.seed) || a.id.localeCompare(b.id));
    const header = `Lattice recall for "${safeTitle(q).slice(0, 80)}":`;
    const footer = DATA_LINE;
    let used = header.length + footer.length + 2;
    const blocks: string[] = [];
    const ids: string[] = [];
    let truncated = false;
    let i = 0;
    for (const e of ranked) {
      const n = this.nodes.get(e.id)!;
      let block: string;
      if (e.seed) {
        block = `${++i}. [${n.type}] ${safeTitle(n.title)} (id ${n.id}, ${n.scope}${n.tags.length ? ', tags: ' + n.tags.slice(0, 6).join(' ') : ''})\n${wrapNode(n, e.snippet ?? '')}`;
      } else {
        const sn = this.nodes.get(e.via!.seedId)!;
        const arrow = e.via!.dir === 'out' ? `${e.via!.rel} ->` : `<- ${e.via!.rel}`;
        block = `   related: [${n.type}] ${safeTitle(n.title)} (id ${n.id}) via ${arrow} "${safeTitle(sn.title).slice(0, 60)}"${isUntrusted(n) ? ' [UNTRUSTED SOURCE]' : ''}`;
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
    const visible = [...this.nodes.values()].filter((n) => this.canSee(actor, n.scope));
    const touched = new Set<string>();
    const danglingEdges: string[] = [];
    const contradictions: Array<{ a: string; b: string }> = [];
    let edgeCount = 0;
    for (const e of this.edges.values()) {
      const f = this.nodes.get(e.from);
      const t = this.nodes.get(e.to);
      if (!f || !t) {
        const alive = f ?? t;
        if (actor.kind !== 'agent' || (alive && this.canSee(actor, alive.scope))) danglingEdges.push(e.id);
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
      if (days > STALE_DAYS) stale.push({ id: n.id, daysOld: days });
      if (isUntrusted(n) && n.props?.reviewed !== true) untrustedWithoutReview.push(n.id);
    }
    const duplicateTitles = [...titles.values()].filter((l) => l.length > 1).map((l) => ({ title: l[0]!.title, ids: l.map((x) => x.id) }));
    return {
      orphans, danglingEdges, duplicateTitles, stale: stale.sort((a, b) => b.daysOld - a.daysOld),
      contradictions, untrustedWithoutReview, counts: { nodes: visible.length, edges: edgeCount },
    };
  }

  // ------------------------------------------------------------------ writes

  /**
   * Creates or updates a node. With `dryRun` every check runs (validation, visibility, write rights, limits)
   * but nothing is written, so a batch can be vetted before its first write.
   */
  upsertNode(actor: Actor, input: NodeInput, opts: { dryRun?: boolean } = {}): UpsertResult {
    if (!isObj(input as unknown)) throw new KgError('invalid', 'Node input must be an object.');
    const existing = input.id !== undefined ? this.nodes.get(input.id) : undefined;
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || !ID_RE.test(input.id)) throw new KgError('invalid', 'id must be 1-80 chars of letters, digits and _ . : -');
      if (!existing && actor.kind === 'agent') throw new KgError('not_found', `Unknown node "${input.id}". Omit id to create a new node.`);
    }
    if (existing && !this.canSee(actor, existing.scope)) {
      // do not reveal whether a private node of someone else exists
      throw new KgError(actor.kind === 'agent' ? 'not_found' : 'forbidden', `Unknown node "${input.id}" (it may not exist or may not be visible to you).`);
    }
    if (existing && !this.canWrite(actor, existing.scope)) throw new KgError('forbidden', `Node "${existing.id}" is read-only for you (scope ${existing.scope}).`);

    const f = this.cleanFields(input, !existing);
    const scope = f.scope ?? existing?.scope ?? 'shared';
    if (!this.canWrite(actor, scope)) {
      throw new KgError('forbidden', scope === 'bsv'
        ? 'The bsv scope is written only by the human or the seeder.'
        : `You may write only to "shared" or your own private scope, not "${scope}".`);
    }
    const now = nowIso();
    const who = actorName(actor);

    if (!existing) {
      if (this.nodes.size >= KG_LIMITS.maxNodes) throw new KgError('limit', `The graph is full (${KG_LIMITS.maxNodes} nodes). Delete or merge nodes first.`);
      if (f.title === undefined) throw new KgError('invalid', 'title is required to create a node.');
      if (f.untrusted && !f.sources?.length) throw new KgError('invalid', 'Content from the web, files or other untrusted input needs at least one source (ref).');
      const props = actor.kind === 'human' || actor.kind === 'system' ? f.props : stripReviewed(f.props);
      const node: KgNode = {
        id: input.id ?? newId('n'), type: f.type ?? 'note', title: f.title, body: f.body ?? '', tags: f.tags ?? [], scope,
        ...(props && Object.keys(props).length ? { props } : {}),
        ...(f.sources?.length ? { sources: f.sources } : {}),
        ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        createdBy: who, createdAt: now, updatedAt: now,
      };
      if (opts.dryRun) return { node: structuredClone(node), created: true, changed: true };
      this.append([{ op: 'node', node }]);
      this.nodes.set(node.id, node);
      this.indexNode(node);
      this.changed([node.id]);
      return { node: structuredClone(node), created: true, changed: true };
    }

    // ---- update: merge the given fields
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
    const isOwner = actor.kind !== 'agent';
    if (!isOwner) {
      // an agent can neither launder an untrusted flag nor mark content as human-reviewed
      const before = existing.sources?.filter((s) => s.untrusted) ?? [];
      if (before.length) {
        const have = new Map((next.sources ?? []).map((s) => [s.ref, s]));
        for (const s of before) have.set(s.ref, { ...(have.get(s.ref) ?? s), untrusted: true });
        next.sources = [...have.values()];
      }
      const props = { ...(next.props ?? {}) };
      delete props.reviewed;
      const contentChanged = next.title !== existing.title || next.body !== existing.body;
      if (existing.props?.reviewed === true && !contentChanged) props.reviewed = true;
      if (Object.keys(props).length) next.props = props; else delete next.props;
    }
    if (next.props && !Object.keys(next.props).length) delete next.props;
    if (next.sources && !next.sources.length) delete next.sources;

    const fields: Record<string, unknown> = {};
    for (const k of NODE_FIELDS) {
      if (k === 'updatedAt') continue;
      const a = JSON.stringify(next[k] ?? null);
      if (a !== JSON.stringify(existing[k] ?? null)) fields[k] = next[k] ?? null;
    }
    if (!Object.keys(fields).length) return { node: structuredClone(existing), created: false, changed: false };
    next.updatedAt = now;
    fields.updatedAt = now;
    if (opts.dryRun) return { node: structuredClone(next), created: false, changed: true };
    this.append([{ op: 'patch', id: existing.id, fields }]);
    this.unindexNode(existing.id);
    this.nodes.set(next.id, next);
    this.indexNode(next);
    this.changed([next.id]);
    return { node: structuredClone(next), created: false, changed: true };
  }

  deleteNode(actor: Actor, id: string): { removedEdges: number } {
    const n = this.mustSee(actor, id);
    if (!this.canWrite(actor, n.scope)) throw new KgError('forbidden', `Node "${id}" is read-only for you (scope ${n.scope}).`);
    const edgeIds = [...new Set([...(this.out.get(id) ?? []), ...(this.inn.get(id) ?? [])])];
    this.append([...edgeIds.map((e) => ({ op: 'del_edge', id: e })), { op: 'del_node', id }]);
    for (const e of edgeIds) this.dropEdge(e);
    this.dropNode(id);
    this.changed([id]);
    return { removedEdges: edgeIds.length };
  }

  link(actor: Actor, input: LinkInput): LinkResult {
    if (!isObj(input as unknown)) throw new KgError('invalid', 'Edge input must be an object.');
    const rel = validateLinkFields(input);
    this.mustSee(actor, input.from);
    this.mustSee(actor, input.to);
    const key = edgeKey(input.from, input.to, rel);
    const existingId = this.edgeKeys.get(key);
    if (existingId) {
      const e = this.edges.get(existingId)!;
      const fields: Record<string, unknown> = {};
      if (input.weight !== undefined && input.weight !== e.weight) fields.weight = input.weight;
      if (input.note !== undefined && input.note !== e.note) fields.note = input.note;
      if (Object.keys(fields).length) {
        this.append([{ op: 'patch', id: e.id, fields }]);
        Object.assign(e, fields);
        this.changed([e.id]);
      }
      return { edge: { ...e }, created: false };
    }
    const edge: KgEdge = {
      id: newId('e'), from: input.from, to: input.to, rel,
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...(input.note ? { note: input.note } : {}),
      createdBy: actorName(actor), createdAt: nowIso(),
    };
    this.append([{ op: 'edge', edge }]);
    this.addEdge(edge);
    this.changed([edge.id, edge.from, edge.to]);
    return { edge: { ...edge }, created: true };
  }

  /** Remove an edge by id, or by from+to+rel. */
  unlink(actor: Actor, ref: { id: string } | { from: string; to: string; rel: string }): KgEdge {
    const id = 'id' in ref ? ref.id : this.edgeKeys.get(edgeKey(ref.from, ref.to, normRel(ref.rel)));
    const e = id ? this.edges.get(id) : undefined;
    if (!e || !this.edgeVisible(actor, e)) throw new KgError('not_found', 'No such link.');
    if (actor.kind === 'agent' && e.createdBy !== actor.id) {
      const f = this.nodes.get(e.from)!;
      const t = this.nodes.get(e.to)!;
      if (!this.canWrite(actor, f.scope) || !this.canWrite(actor, t.scope)) throw new KgError('forbidden', 'This link touches read-only (bsv) content and was not created by you.');
    }
    this.append([{ op: 'del_edge', id: e.id }]);
    this.dropEdge(e.id);
    this.changed([e.id, e.from, e.to]);
    return { ...e };
  }

  // ------------------------------------------------------------------ validation

  private cleanFields(input: NodeInput, creating: boolean) {
    const out: {
      type?: KgNode['type']; title?: string; body?: string; tags?: string[]; scope?: KgScope;
      props?: Record<string, string | number | boolean>; sources?: KgSource[]; confidence?: number; untrusted?: boolean;
    } = {};
    if (input.type !== undefined) {
      if (!isNodeType(input.type)) throw new KgError('invalid', `Invalid type "${String(input.type)}".`);
      out.type = input.type;
    }
    if (input.title !== undefined) {
      if (typeof input.title !== 'string') throw new KgError('invalid', 'title must be a string.');
      const t = oneLine(input.title);
      if (!t) throw new KgError('invalid', 'title must not be empty.');
      if (t.length > KG_LIMITS.titleChars) throw new KgError('invalid', `title is too long (${t.length} > ${KG_LIMITS.titleChars} chars). Shorten it; nothing was saved.`);
      out.title = t;
    } else if (creating) throw new KgError('invalid', 'title is required to create a node.');
    if (input.body !== undefined) {
      if (typeof input.body !== 'string') throw new KgError('invalid', 'body must be a string.');
      if (input.body.length > KG_LIMITS.bodyChars) throw new KgError('invalid', `body is too long (${input.body.length} > ${KG_LIMITS.bodyChars} chars). Split it into several linked nodes; nothing was saved.`);
      out.body = input.body;
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== 'string')) throw new KgError('invalid', 'tags must be an array of strings.');
      const tags = [...new Set(input.tags.map(normTag).filter(Boolean))];
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
      for (const [k, v] of entries) {
        if (!k || k.length > 64) throw new KgError('invalid', 'Invalid prop key.');
        if (typeof v === 'string') { if (v.length > 500) throw new KgError('invalid', `props.${k} is longer than 500 chars.`); }
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
        return { ref: s.ref.trim(), ...(s.licence ? { licence: s.licence } : {}), ...(s.untrusted === true ? { untrusted: true } : {}) };
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

  private append(ops: object[]): void {
    const text = ops.map((o) => JSON.stringify(o)).join('\n') + '\n';
    appendFileSync(this.file, text, 'utf8');
    this.bytes += Buffer.byteLength(text);
    this.totalEntries += ops.length;
  }

  private maybeCompact(): void {
    const live = this.nodes.size + this.edges.size;
    const dead = this.totalEntries - live;
    if (this.bytes >= this.compactMinBytes && dead > this.totalEntries / 2) {
      try { this.compact(); } catch { /* the log stays valid; try again after the next write */ }
    }
  }

  /** Rewrites the log from live state (tmp file + rename, so a crash leaves either the old or the new log). */
  compact(): void {
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
    for (const line of buf.subarray(0, keep).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      if (!this.replay(line)) this.loadInfo.skippedLines++;
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
        if (this.nodes.has(n.id)) this.unindexNode(n.id);
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
          const next = loadNode({ ...n, ...patchFields(op.fields) });
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

function truncateTo(file: string, bytes: number): void {
  try { truncateSync(file, bytes); } catch { writeFileSync(file, readFileSync(file).subarray(0, bytes)); }
}

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

const stripReviewed = (p?: Record<string, string | number | boolean>) => {
  if (!p) return p;
  const { reviewed: _r, ...rest } = p;
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
