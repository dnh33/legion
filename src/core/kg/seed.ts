/**
 * The bundled BSV knowledge pack (src/core/kg/seeds/bsv.json, written by the seed agent).
 * Expected shape: { "nodes": KgNode-like[], "edges": { from, to, rel, weight?, note? }[] }.
 * Every node needs a stable id, a title and at least one source; scope is forced to "bsv", author to "system".
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KG_LIMITS } from '../../shared/kg.js';
import type { KgNode, KgNodeType, KgSource } from '../../shared/kg.js';
import { validateLinkFields } from './graph.js';
import type { Graph } from './graph.js';
import { isNodeType, KgError, SYSTEM } from './types.js';
import type { NodeInput } from './types.js';

export const BSV_SEED_PATH = fileURLToPath(new URL('./seeds/bsv.json', import.meta.url));
/** Content hashes of every pack text shipped before packs carried a seedHash (version 1), so an install from that time can tell "never edited" from "edited by a human". */
export const BSV_LEGACY_HASHES_PATH = fileURLToPath(new URL('./seeds/bsv-legacy-hashes.json', import.meta.url));
/** The node that carries the pack version (props.seedVersion). Falls back to the first node of a pack that has no such node. */
export const BSV_INDEX_ID = 'bsv-curriculum-index';

export interface SeedNode {
  id: string; type?: string; title: string; body?: string; tags?: string[];
  props?: Record<string, string | number | boolean>; sources: KgSource[]; confidence?: number;
}
export interface SeedEdge { from: string; to: string; rel: string; weight?: number; note?: string }
/** `version` defaults to 1 (packs made before versions). */
export interface SeedPack { version?: number; nodes: SeedNode[]; edges: SeedEdge[] }
export interface SeedResult {
  /** loaded: nothing of the pack was there; upgraded: an older pack was there; already-loaded: same or newer version, nothing written. */
  status: 'loaded' | 'upgraded' | 'already-loaded';
  /** The pack version that was loaded before (0 = none) and the bundled one. */
  from: number;
  to: number;
  nodes: number;
  created: number;
  /** Same as `created`: nodes that were not there. */
  added: number;
  /** Untouched nodes that took the new pack text. */
  updated: number;
  edges: number;
  /** Nodes a human edited: their text was left alone. */
  skippedEdited: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Returns every problem found (empty array = valid). */
export function validateSeedPack(raw: unknown): string[] {
  const errs: string[] = [];
  const add = (m: string) => { if (errs.length < 25) errs.push(m); };
  if (!isObj(raw)) return ['the pack must be a JSON object with "nodes" and "edges"'];
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) add('"nodes" must be a non-empty array');
  if (raw.edges !== undefined && !Array.isArray(raw.edges)) add('"edges" must be an array');
  if (raw.version !== undefined && (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1)) add('"version" must be a positive integer');
  const ids = new Set<string>();
  for (const [i, n] of (Array.isArray(raw.nodes) ? raw.nodes : []).entries()) {
    const at = `nodes[${i}]`;
    if (!isObj(n)) { add(`${at} is not an object`); continue; }
    if (typeof n.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(n.id)) { add(`${at}: id must be 1-80 chars of letters, digits and _ . : -`); continue; }
    if (ids.has(n.id)) add(`${at}: duplicate id ${n.id}`);
    ids.add(n.id);
    if (typeof n.title !== 'string' || !n.title.trim() || n.title.length > KG_LIMITS.titleChars) add(`${n.id}: title missing or too long`);
    if (n.body !== undefined && (typeof n.body !== 'string' || n.body.length > KG_LIMITS.bodyChars)) add(`${n.id}: body must be a string of at most ${KG_LIMITS.bodyChars} chars`);
    if (n.type !== undefined && !isNodeType(n.type)) add(`${n.id}: unknown type ${String(n.type)}`);
    if (n.scope !== undefined && n.scope !== 'bsv') add(`${n.id}: scope must be "bsv"`);
    if (n.createdBy !== undefined && n.createdBy !== 'system') add(`${n.id}: createdBy must be "system"`);
    const src = n.sources;
    if (!Array.isArray(src) || !src.length) add(`${n.id}: sources is required (URL and licence)`);
    else if (src.some((s) => !isObj(s) || typeof s.ref !== 'string' || !s.ref.trim())) add(`${n.id}: every source needs a ref`);
  }
  for (const [i, e] of (Array.isArray(raw.edges) ? raw.edges : []).entries()) {
    const at = `edges[${i}]`;
    if (!isObj(e) || typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.rel !== 'string') { add(`${at} needs from, to and rel`); continue; }
    if (!ids.has(e.from)) add(`${at}: dangling "from" ${e.from}`);
    if (!ids.has(e.to)) add(`${at}: dangling "to" ${e.to}`);
    if (e.from === e.to) add(`${at}: self link`);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(e.rel)) add(`${at}: rel "${e.rel}" must be lowercase letters, digits, underscores`);
  }
  return errs;
}

/** Reads and validates the bundled pack. 404 when absent, 422 when invalid. */
export function loadBsvSeed(path: string = BSV_SEED_PATH): SeedPack {
  if (!existsSync(path)) throw new KgError('not_found', 'The BSV knowledge pack is not installed (src/core/kg/seeds/bsv.json is missing from this build).');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw seedInvalid([`not valid JSON: ${e instanceof Error ? e.message : String(e)}`]); }
  const errs = validateSeedPack(raw);
  if (errs.length) throw seedInvalid(errs);
  const r = raw as { version?: number; nodes: SeedNode[]; edges?: SeedEdge[] };
  return { version: r.version ?? 1, nodes: r.nodes, edges: r.edges ?? [] };
}

function seedInvalid(errs: string[]): KgError {
  return new KgError('unprocessable', `The BSV knowledge pack is invalid: ${errs.join('; ')}`);
}

/** Hash of what a seed says: title, body, tags and confidence (props and sources are not part of it). Stored as props.seedHash. */
export function seedContentHash(n: { title: string; body?: string; tags?: string[]; confidence?: number }): string {
  return createHash('sha256').update(JSON.stringify([n.title, n.body ?? '', n.tags ?? [], n.confidence ?? null])).digest('hex').slice(0, 16);
}

let legacyCache: Record<string, string[]> | undefined;
function legacyHashes(): Record<string, string[]> {
  if (legacyCache) return legacyCache;
  try {
    const raw = JSON.parse(readFileSync(BSV_LEGACY_HASHES_PATH, 'utf8')) as { hashes?: Record<string, string[]> };
    legacyCache = raw.hashes && typeof raw.hashes === 'object' ? raw.hashes : {};
  } catch { legacyCache = {}; }
  return legacyCache;
}

/** The pack version a loaded index node records. A node without props.seedVersion was loaded from a pack made before versions (version 1). */
const loadedVersion = (n: KgNode): number => (typeof n.props?.seedVersion === 'number' && n.props.seedVersion >= 1 ? n.props.seedVersion : 1);

/**
 * Loads or upgrades the bundled pack. Always as SYSTEM, never destructive:
 *  - nothing loaded (the index node is missing): every node is added (a node that already exists is treated like the cases below);
 *  - an older version loaded: nodes that are missing are added; nodes nobody has edited take the new text; nodes a human edited are
 *    left alone and listed in `skippedEdited`; edges are added, never removed; nodes the new pack dropped stay where they are (never
 *    deleted or archived: that is a human decision);
 *  - the same or a newer version loaded: nothing is written.
 * "Edited" means the node's current title+body+tags+confidence no longer match the props.seedHash it was seeded with. A node seeded before
 * hashes existed counts as untouched when it was never changed (rev 1) or still matches a text this pack shipped in version 1.
 * Every node and edge is vetted (dry run) before the first write, so a bad pack writes nothing, and a snapshot is taken first.
 */
export function applySeedPack(graph: Graph, bundled: SeedPack): SeedResult {
  const pack = { ...bundled, version: bundled.version ?? 1 };
  const indexId = pack.nodes.find((n) => n.id === BSV_INDEX_ID)?.id ?? pack.nodes[0]!.id;
  const indexNode = graph.getNode(SYSTEM, indexId);
  const from = indexNode ? loadedVersion(indexNode) : 0;
  if (indexNode && from >= pack.version) {
    return { status: 'already-loaded', from, to: pack.version, nodes: pack.nodes.length, created: 0, added: 0, updated: 0, edges: 0, skippedEdited: [] };
  }

  const legacy = legacyHashes();
  const ids = new Set(pack.nodes.map((n) => n.id));
  const problems: string[] = [];
  const vet = <T>(label: string, fn: () => T): T | undefined => { try { return fn(); } catch (e) { if (problems.length < 25) problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); return undefined; } };

  interface Plan { input: NodeInput; action: 'add' | 'update' | 'refresh' | 'skip' }
  const plans: Plan[] = [];
  const skippedEdited: string[] = [];
  for (const n of pack.nodes) {
    const input: NodeInput = {
      id: n.id, ...(n.type ? { type: n.type as KgNodeType } : {}), title: n.title, body: n.body ?? '', tags: n.tags ?? [], scope: 'bsv',
      props: { ...(n.props ?? {}), ...(n.id === indexId ? { seedVersion: pack.version } : {}) }, sources: n.sources,
      ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
    };
    // the dry run gives the node as the graph would store it (normalised), which is what the hash must be taken from
    const dry = vet(n.id, () => graph.upsertNode(SYSTEM, input, { dryRun: true }));
    if (!dry) continue;
    const newHash = seedContentHash(dry.node);
    const withHash: NodeInput = { ...input, props: { ...input.props, seedHash: newHash } };
    const cur = graph.getNode(SYSTEM, n.id);
    if (!cur) { plans.push({ input: withHash, action: 'add' }); continue; }
    const curHash = seedContentHash(cur);
    const stored = typeof cur.props?.seedHash === 'string' ? cur.props.seedHash : undefined;
    const untouched = stored !== undefined ? curHash === stored : (cur.rev ?? 1) <= 1 || curHash === newHash || (legacy[n.id] ?? []).includes(curHash);
    if (untouched) plans.push({ input: withHash, action: curHash !== newHash ? 'update' : 'refresh' });
    else {
      skippedEdited.push(n.id);
      // the version marker still moves on, or every later toggle would run the upgrade again
      plans.push(n.id === indexId && cur.props ? { input: { id: n.id, props: { ...cur.props, seedVersion: pack.version } }, action: 'skip' } : { input: withHash, action: 'skip' });
    }
  }
  const adding = plans.filter((p) => p.action === 'add').length;
  if (graph.counts().nodes + adding > KG_LIMITS.maxNodes) problems.push(`pack would exceed the ${KG_LIMITS.maxNodes}-node limit`);
  for (const [k, e] of pack.edges.entries()) {
    vet(`edges[${k}]`, () => {
      validateLinkFields(e);
      if (!ids.has(e.from) || !ids.has(e.to)) throw new KgError('invalid', 'endpoint is not a node of the pack');
    });
  }
  if (problems.length) throw new KgError('unprocessable', `The BSV knowledge pack was not loaded (nothing was written): ${problems.join('; ')}`);

  graph.snapshot();
  let created = 0;
  let updated = 0;
  for (const p of plans) {
    // an edited node is not written (except the version marker, whose input carries only props)
    if (p.action === 'skip' && p.input.title !== undefined) continue;
    const r = graph.upsertNode(SYSTEM, p.input);
    if (r.created) created++; else if (p.action === 'update' && r.changed) updated++;
  }
  let edges = 0;
  for (const e of pack.edges) {
    if (graph.link(SYSTEM, { from: e.from, to: e.to, rel: e.rel, weight: e.weight, note: e.note }).created) edges++;
  }
  return { status: from === 0 ? 'loaded' : 'upgraded', from, to: pack.version, nodes: pack.nodes.length, created, added: created, updated, edges, skippedEdited };
}
