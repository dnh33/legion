/**
 * The bundled BSV knowledge pack (src/core/kg/seeds/bsv.json, written by the seed agent).
 * Expected shape: { "nodes": KgNode-like[], "edges": { from, to, rel, weight?, note? }[] }.
 * Every node needs a stable id, a title and at least one source; scope is forced to "bsv", author to "system".
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KG_LIMITS } from '../../shared/kg.js';
import type { KgNodeType, KgSource } from '../../shared/kg.js';
import { validateLinkFields } from './graph.js';
import type { Graph } from './graph.js';
import { isNodeType, KgError, SYSTEM } from './types.js';
import type { NodeInput } from './types.js';

export const BSV_SEED_PATH = fileURLToPath(new URL('./seeds/bsv.json', import.meta.url));

export interface SeedNode {
  id: string; type?: string; title: string; body?: string; tags?: string[];
  props?: Record<string, string | number | boolean>; sources: KgSource[]; confidence?: number;
}
export interface SeedEdge { from: string; to: string; rel: string; weight?: number; note?: string }
export interface SeedPack { nodes: SeedNode[]; edges: SeedEdge[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Returns every problem found (empty array = valid). */
export function validateSeedPack(raw: unknown): string[] {
  const errs: string[] = [];
  const add = (m: string) => { if (errs.length < 25) errs.push(m); };
  if (!isObj(raw)) return ['the pack must be a JSON object with "nodes" and "edges"'];
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) add('"nodes" must be a non-empty array');
  if (raw.edges !== undefined && !Array.isArray(raw.edges)) add('"edges" must be an array');
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
  const r = raw as { nodes: SeedNode[]; edges?: SeedEdge[] };
  return { nodes: r.nodes, edges: r.edges ?? [] };
}

function seedInvalid(errs: string[]): KgError {
  return new KgError('unprocessable', `The BSV knowledge pack is invalid: ${errs.join('; ')}`);
}

/**
 * Idempotent: nodes are upserted by their stable ids, edges are linked (links are idempotent).
 * Every node and edge is vetted (dry run) before the first write, so a bad pack writes nothing.
 */
export function applySeedPack(graph: Graph, pack: SeedPack): { nodes: number; created: number; updated: number; edges: number } {
  const inputs = pack.nodes.map((n): NodeInput => ({
    id: n.id, ...(n.type ? { type: n.type as KgNodeType } : {}), title: n.title, body: n.body ?? '', tags: n.tags ?? [], scope: 'bsv',
    ...(n.props ? { props: n.props } : {}), sources: n.sources, ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
  }));
  const ids = new Set(pack.nodes.map((n) => n.id));
  const problems: string[] = [];
  const vet = (label: string, fn: () => unknown) => { try { fn(); } catch (e) { if (problems.length < 25) problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); } };
  if (graph.counts().nodes + inputs.length > KG_LIMITS.maxNodes) problems.push(`pack would exceed the ${KG_LIMITS.maxNodes}-node limit`);
  for (const i of inputs) vet(i.id!, () => graph.upsertNode(SYSTEM, i, { dryRun: true }));
  for (const [k, e] of pack.edges.entries()) {
    vet(`edges[${k}]`, () => {
      validateLinkFields(e);
      if (!ids.has(e.from) || !ids.has(e.to)) throw new KgError('invalid', 'endpoint is not a node of the pack');
    });
  }
  if (problems.length) throw new KgError('unprocessable', `The BSV knowledge pack was not loaded (nothing was written): ${problems.join('; ')}`);

  let created = 0;
  let updated = 0;
  for (const i of inputs) {
    const r = graph.upsertNode(SYSTEM, i);
    if (r.created) created++; else if (r.changed) updated++;
  }
  let edges = 0;
  for (const e of pack.edges) {
    if (graph.link(SYSTEM, { from: e.from, to: e.to, rel: e.rel, weight: e.weight, note: e.note }).created) edges++;
  }
  return { nodes: pack.nodes.length, created, updated, edges };
}
