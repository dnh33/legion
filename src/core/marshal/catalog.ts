/**
 * The Marshal's routing catalog (C4 council verdict, 2026-10-12): what each bot is FOR, generated from the
 * bot's own prose AT FULL LENGTH, plus the guards that decide who may be considered at all — in code, not prose.
 *
 * Prose matching reads `role`; the guards (`eligible`) run before any matcher sees a catalog and after it
 * answers, so a pick that ignores them is refused, never obeyed. Untrusted board text never reaches this
 * file: the caller only passes text the owner wrote or reviewed (see match.ts).
 *
 * The catalog carries the description AND the whole systemPrompt. The roster line the agents tool prints
 * cuts descriptions to 80 characters, which loses the prohibition tails ("never sends", "every spend is
 * manual") a matcher has to see to route safely; nothing here is truncated.
 */
import type { AgentProfile, ApprovalMode } from '../../shared/types.js';
import { toolsOf } from '../agent-reach.js';

/** The verbs that cannot be undone. The council's list: a task containing one is routed, never guessed at. */
export const IRREVERSIBLE_VERBS = ['send', 'sign', 'deploy', 'delete', 'rotate', 'upgrade', 'merge'] as const;
export type IrreversibleVerb = typeof IRREVERSIBLE_VERBS[number];

/** Where a prohibition came from: the owner-adjudicated table, or the bot's own prose (for a bot the table does not know). */
export type NeverSource = 'table' | 'prose';

/** One prohibition a bot's role carries: the verb it never performs, the line that says so, and who decided it. */
export interface NeverClaim { verb: IrreversibleVerb; evidence: string; source: NeverSource }

/** One bot, as the matcher sees it. `role` is the full prose, never cut. */
export interface BotCatalogEntry {
  id: string;
  name: string;
  role: string;
  /** The bot's chosen model. A dispatch honours it by asking for no model of its own. */
  model: string;
  /** The bot's access tier. It is authoritative for irreversible work: `full` acts (pre-authorized), `ask` gates. */
  approval: ApprovalMode;
  /** Verbs this bot's role forbids it, with the line that says so. An irreversible task never routes to a bot listed for its verb. */
  never: NeverClaim[];
  /** What it can do on the owner's computer (agent-reach.ts): a shell and files, or neither. */
  tools?: string;
}

/**
 * The owner-adjudicated deny table for the shipped roster (council: the deny table is a ROUTING SIGNAL —
 * route an irreversible verb to an entitled bot, NEVER to one whose role forbids it).
 *
 * It is a table, not a sentence scan, on purpose. Prose scanned at sentence granularity misreads the Builder's
 * "never weaken, skip or delete a test to make it pass" as a ban on deleting anything, and misses the Forgemaster's
 * "never deploy ... without the user's approval" as the gated permission it is. These entries are the adjudicated
 * truth for the roster the app ships, and a named entry REPLACES the prose scan for that bot; a bot the table does
 * not know falls back to reading its own prose below.
 */
const ADJUDICATED: Record<string, Partial<Record<IrreversibleVerb, string>>> = {
  herald: { send: 'Herald: "You never send, post, schedule or publish; the user does that after reading." Drafts only.' },
  assayer: { sign: 'Assayer: "you may build and explain a transaction but never sign, broadcast or move funds." Every spend is manual.' },
  archivist: { delete: 'Archivist: "flag, do not delete. Never remove, overwrite or merge a node or file unprompted."', merge: 'Archivist: "Never remove, overwrite or merge a node or file unprompted."' },
  quartermaster: { upgrade: 'Quartermaster: "Report only. Never install, upgrade, edit files or settings." It reports; the owner upgrades.' },
  sentinel: { delete: 'Sentinel: "you watch, you do not fix. Never restart, delete or change what you watch without being asked."' },
  // An entry with no verb is still an adjudication, and it wins over the prose scan: the Builder's
  // "never weaken, skip or delete a test to make it pass" bans cheating, not deleting, and routing
  // "delete the dead code" away from the Order's hands would be the misreading, not the safe reading.
  builder: {},
};

/** The verb a sentence is about, or undefined. Deliberately broad: a false positive here only narrows routing. */
const VERB_RE: Record<IrreversibleVerb, RegExp> = {
  send: /\b(sends?|sending|posts?|posting|publish(es|ed|ing)?|schedul(e|es|ed|ing)|delivers?|mails?)\b/i,
  sign: /\b(signs?|signing|broadcasts?|broadcasting|spends?|spending)\b/i,
  deploy: /\b(deploys?|deploying|rollouts?)\b/i,
  delete: /\b(deletes?|deleting|removes?|removing|erases?|erasing|drops?|dropping)\b/i,
  rotate: /\b(rotates?|rotating|rotation)\b/i,
  upgrade: /\b(upgrades?|upgrading|installs?|installing)\b/i,
  merge: /\b(merges?|merging)\b/i,
};
/** A line that forbids: a negative marker within reach of the verb in the same clause. */
const FORBID_RE = /(never|do not|don't|not to|refrain from|no more than|report only|drafts? only|flags?, never|without being asked)[^.!?\n]{0,60}$/i;
/** An escape the sentence itself carries: the prohibition is gated on a human, so it is a permission, not a ban. */
const ESCAPE_RE = /\b(without (the )?(user|owner|human|person)'?s? (approval|permission|say|ask|allow)|unless|until (the|your|a) (user|owner|human|person)|only (after|when|with|once|for)[^.!?\n]{0,50}(approval|approved|allow|ask|say|owner|user|human)|needs? (the |your )?(human|owner|user|person)|is the (user|owner|human)'?s? act|per (the |your )?(owner|user|human)|owner decides)\b/i;

/** Split prose into clauses short enough to read a prohibition out of one. */
const clauses = (prose: string): string[] => prose.split(/[.;!\n]+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 3);

/**
 * Verbs a bot's own prose forbids it, with the clause that says so. Conservative by design: a clause that
 * carries a human-decision escape ("without the user's approval") is a gated permission, not a ban, and is
 * not claimed. Returns [] for prose that forbids nothing here.
 */
export function neverVerbsIn(prose: string): NeverClaim[] {
  const out: NeverClaim[] = [];
  for (const clause of clauses(prose)) {
    for (const verb of IRREVERSIBLE_VERBS) {
      if (out.some((n) => n.verb === verb)) continue;
      if (!VERB_RE[verb].test(clause)) continue;
      if (!FORBID_RE.test(clause)) continue;
      if (ESCAPE_RE.test(clause)) continue;
      out.push({ verb, evidence: clause.slice(0, 220), source: 'prose' });
    }
  }
  return out;
}

const fullRole = (a: Pick<AgentProfile, 'description' | 'systemPrompt'>): string => `${a.description}\n${a.systemPrompt ?? ''}`.trim();

/** One bot's catalog entry: full role prose, chosen model, access tier, and every prohibition that binds it. */
export function catalogOf(a: AgentProfile): BotCatalogEntry {
  const adjudicated = Object.hasOwn(ADJUDICATED, a.id);
  const table = ADJUDICATED[a.id];
  const never: NeverClaim[] = Object.entries(table ?? {}).map(([verb, evidence]) => ({ verb: verb as IrreversibleVerb, evidence: evidence!, source: 'table' as const }));
  const role = fullRole(a);
  if (!adjudicated) for (const claim of neverVerbsIn(role)) if (!never.some((n) => n.verb === claim.verb)) never.push(claim);
  return { id: a.id, name: a.name, role, model: a.model, approval: a.approval, never, tools: toolsOf(a) };
}

/** The whole visible roster as catalog entries. A matcher is only ever shown bots that pass `visible`. */
export function catalogOfAll(agents: readonly AgentProfile[], visible: (a: AgentProfile) => boolean = () => true): BotCatalogEntry[] {
  return agents.filter((a) => visible(a)).map(catalogOf);
}

/** Why one bot may not take a task, in one human line. `transient` marks a reason that passes with time (a busy bot). */
export interface Exclusion { id: string; why: string; transient?: boolean }

/** What the dispatch loop knows that a matcher must not have to: membership, feature switches, load, and history. */
export interface CandidateCtx {
  /** The project's members. Only a member may be routed this project's work. */
  members: readonly string[];
  /** Whether the bot is visible at all (its feature switch is on). */
  visible(id: string): boolean;
  /** Whether the bot already owns a live dispatch (one owner at a time). */
  busy(id: string): boolean;
  /** Where a busy bot is working, in the owner's words ("busy in Shop: Fix the header"); absent: the generic line. */
  busyWhy?(id: string): string | undefined;
  /** The attempt ledger's answer: whether this item may go (back) to this bot at all. */
  reuse(id: string): { ok: true } | { ok: false; why: string };
}

/**
 * Who may be considered for one item: every catalog entry that passes the code guards, and one line per
 * bot left out. This runs BEFORE the prose matcher sees a catalog and is the set a pick must come from.
 */
export function eligible(catalog: readonly BotCatalogEntry[], ctx: CandidateCtx): { candidates: BotCatalogEntry[]; excluded: Exclusion[] } {
  const candidates: BotCatalogEntry[] = [];
  const excluded: Exclusion[] = [];
  for (const b of catalog) {
    if (!ctx.members.includes(b.id)) { excluded.push({ id: b.id, why: 'not a member of this project' }); continue; }
    if (!ctx.visible(b.id)) { excluded.push({ id: b.id, why: 'switched off (its feature is off)' }); continue; }
    if (ctx.busy(b.id)) { excluded.push({ id: b.id, why: ctx.busyWhy?.(b.id) ?? 'already working on another item', transient: true }); continue; }
    const reuse = ctx.reuse(b.id);
    if (!reuse.ok) { excluded.push({ id: b.id, why: reuse.why }); continue; }
    candidates.push(b);
  }
  return { candidates, excluded };
}

/** The verbs in a text the owner wrote or reviewed. The deny table is keyed off this — never off an agent's text. */
export function irreversibleVerbsIn(text: string): IrreversibleVerb[] {
  const found: IrreversibleVerb[] = [];
  for (const clause of clauses(text ?? '')) for (const verb of IRREVERSIBLE_VERBS) {
    if (found.includes(verb)) continue;
    if (VERB_RE[verb].test(clause)) found.push(verb);
  }
  return found;
}

/**
 * Routing an irreversible task: is the bot entitled to its verbs? A bot whose role forbids a verb is NEVER
 * routed its work; a bot that merely gates it on a human is entitled, because its access tier decides at run
 * time (`full` acts, `ask` shows the card) — the tier is honoured, not flattened.
 */
export function verbFit(bot: Pick<BotCatalogEntry, 'never' | 'approval'>, verbs: readonly IrreversibleVerb[]): { ok: true; gated: boolean } | { ok: false; why: string } {
  const ban = bot.never.find((n) => verbs.includes(n.verb));
  if (ban) return { ok: false, why: `${ban.verb} is outside this bot's role: ${ban.evidence}` };
  return { ok: true, gated: bot.approval !== 'full' && verbs.length > 0 };
}
