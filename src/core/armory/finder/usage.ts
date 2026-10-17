/**
 * Skill finder usage: which skills each agent loaded, was offered, or was offered and passed over.
 *
 * The finder ranks skills per message. This record gives a small boost to the skills an agent has
 * really used, and a small penalty to the ones it keeps passing over. The file is a cache: a missing
 * or corrupt file starts empty, and a failed write is dropped without a throw.
 *
 * File: <dataDir>/skill-finder/usage.json, shaped { [agentId]: { [skillId]: { loads, suggested, ignored, lastAt } } }.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type UsageRecord = { loads: number; suggested: number; ignored: number; lastAt: string };
export type UsageStore = {
  /** The finder offered these skills to the agent for one message. */
  noteSuggested(agentId: string, ids: readonly string[]): void;
  /** The agent loaded this skill (through the Skill tool or the provider's armory_skill tool). */
  noteLoaded(agentId: string, id: string): void;
  /** The finder offered these skills and the agent did not load them. */
  noteIgnored(agentId: string, ids: readonly string[]): void;
  /** A rank multiplier for one agent. Reads the file once, when called. A skill with no record gets 1. */
  boostFor(agentId: string): (id: string) => number;
};

/** Per-agent and whole-file caps. The newest records are kept. */
export const MAX_SKILLS_PER_AGENT = 500;
export const MAX_FILE_BYTES = 1_000_000;

const LOAD_WEIGHT = 0.15;
const IGNORE_WEIGHT = 0.05;
const IGNORE_CAP = 6;
const BOOST_FLOOR = 0.7;

const LOAD_ARMORY_TOOLS = new Set(['armory_skill', 'mcp__legion_armory__armory_skill']);

export function usageFilePath(dataDir: string): string {
  return join(dataDir, 'skill-finder', 'usage.json');
}

/**
 * The skill id a tool call loads, as the model wrote it: `input.skill` for the Claude Skill tool, `input.id` for
 * the provider armory_skill tool. Any other tool, or a missing or empty field, gives undefined. The caller resolves
 * the id against the catalog (an ambiguous or unknown name is ignored there).
 */
export function skillIdOfLoad(toolName: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const raw = toolName === 'Skill' ? rec.skill : LOAD_ARMORY_TOOLS.has(toolName) ? rec.id : undefined;
  if (typeof raw !== 'string') return undefined;
  const id = raw.trim();
  return id ? id : undefined;
}

type Usage = Map<string, Map<string, UsageRecord>>;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isRecord(x: unknown): x is UsageRecord {
  if (!isObj(x)) return false;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return ok(x.loads) && ok(x.suggested) && ok(x.ignored) && typeof x.lastAt === 'string' && !Number.isNaN(Date.parse(x.lastAt));
}

/** Reads the file text. Anything that is not the right shape is dropped; a bad entry does not spoil the good ones. */
function parse(text: string): Usage {
  const out: Usage = new Map();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return out; }
  if (!isObj(raw)) return out;
  for (const [agent, skills] of Object.entries(raw)) {
    if (!isObj(skills)) continue;
    const per = new Map<string, UsageRecord>();
    for (const [id, rec] of Object.entries(skills)) {
      if (isRecord(rec)) per.set(id, { loads: rec.loads, suggested: rec.suggested, ignored: rec.ignored, lastAt: rec.lastAt });
    }
    if (per.size) out.set(agent, per);
  }
  return out;
}

function read(path: string): Usage {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return new Map(); }
  return parse(text);
}

function newestFirst(per: Map<string, UsageRecord>): Array<[string, UsageRecord]> {
  return [...per].sort((a, b) => Date.parse(b[1].lastAt) - Date.parse(a[1].lastAt));
}

/** Keeps the newest records per agent, orders each agent newest first, and trims the oldest until the file fits the cap. */
function serialise(u: Usage): string {
  for (const [agent, per] of u) {
    u.set(agent, new Map(newestFirst(per).slice(0, MAX_SKILLS_PER_AGENT)));
  }
  const toJson = () => JSON.stringify(Object.fromEntries([...u].map(([agent, per]) => [agent, Object.fromEntries(per)])));
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  let text = toJson();
  // Drop the oldest records in one pass until the excess is covered, then measure again. Re-measuring after
  // every single drop is quadratic on a big file. Each pass removes at least one record, so this ends.
  while (bytes(text) > MAX_FILE_BYTES) {
    const all: Array<{ agent: string; id: string; rec: UsageRecord; at: number }> = [];
    for (const [agent, per] of u) for (const [id, rec] of per) all.push({ agent, id, rec, at: Date.parse(rec.lastAt) });
    if (!all.length) break;
    all.sort((a, b) => a.at - b.at);
    let excess = bytes(text) - MAX_FILE_BYTES;
    for (const e of all) {
      if (excess <= 0) break;
      const per = u.get(e.agent)!;
      per.delete(e.id);
      if (per.size === 0) u.delete(e.agent);
      excess -= bytes(`${JSON.stringify(e.id)}:${JSON.stringify(e.rec)},`);
    }
    text = toJson();
  }
  return text;
}

/** Atomic: a crash mid-write leaves the old file. A failed write is dropped (usage is a cache, not a record of truth). */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* leave it */ }
  }
}

/** The boost for one skill: more loads lift it (log-scaled), repeated ignores push it down, never below 0.7. */
function boostOf(rec: UsageRecord | undefined): number {
  if (!rec) return 1;
  const raw = 1 + LOAD_WEIGHT * Math.log(1 + rec.loads) - IGNORE_WEIGHT * Math.min(rec.ignored, IGNORE_CAP);
  return Math.max(BOOST_FLOOR, raw);
}

/** `now` is injectable for tests; it returns epoch milliseconds. */
export function createUsageStore(dataDir: string, now: () => number = Date.now): UsageStore {
  const path = usageFilePath(dataDir);

  const change = (fn: (u: Usage) => void): void => {
    const u = read(path);
    fn(u);
    writeAtomic(path, serialise(u));
  };

  const bump = (u: Usage, agent: string, id: string, field: 'loads' | 'suggested' | 'ignored'): void => {
    let per = u.get(agent);
    if (!per) { per = new Map(); u.set(agent, per); }
    const rec = per.get(id) ?? { loads: 0, suggested: 0, ignored: 0, lastAt: '' };
    rec[field] += 1;
    rec.lastAt = new Date(now()).toISOString();
    per.set(id, rec);
  };

  const cleanIds = (ids: readonly string[]): string[] => [...new Set(ids)].filter((id) => typeof id === 'string' && id.length > 0);

  return {
    noteSuggested(agentId, ids) {
      const list = cleanIds(ids);
      if (list.length) change((u) => { for (const id of list) bump(u, agentId, id, 'suggested'); });
    },
    noteLoaded(agentId, id) {
      if (!cleanIds([id]).length) return;
      change((u) => bump(u, agentId, id, 'loads'));
    },
    noteIgnored(agentId, ids) {
      const list = cleanIds(ids);
      if (list.length) change((u) => { for (const id of list) bump(u, agentId, id, 'ignored'); });
    },
    boostFor(agentId) {
      const per = read(path).get(agentId);
      return (id) => boostOf(per?.get(id));
    },
  };
}
