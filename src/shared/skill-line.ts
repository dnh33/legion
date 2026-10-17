/**
 * The quiet line under a reply: "Suggested: a, b · loaded: a". Which reply a skill-finder note belongs to, the text of the line and
 * the rows of the popover that explains it. Pure, so the screen and the tests share one rule.
 */
import type { ChatMessage, SkillTurn } from './types.js';

/** The most lines under one reply. The rest are listed in the popover of the last line. */
export const MAX_LINES = 3;

/** The part of a skill id after the last colon: the name a person knows it by. */
export function shortSkillName(id: string): string {
  const i = id.lastIndexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

/**
 * Each note goes under the first assistant message whose time is at or after the note's. A note made before the first loaded message
 * belongs to a reply that is not loaded (an older part of a long thread), and a note after the last reply has no reply yet: both get no
 * line. A note that suggested nothing has no line. Notes keep their time order.
 */
export function skillLinesByMessage(messages: readonly ChatMessage[], turns: readonly SkillTurn[] | undefined): Map<string, SkillTurn[]> {
  const out = new Map<string, SkillTurn[]>();
  if (!turns?.length || !messages.length) return out;
  const first = Date.parse(messages[0]!.at);
  const replies = messages.filter((m) => m.role === 'assistant' && !m.resultFor).map((m) => ({ id: m.id, t: Date.parse(m.at) }));
  for (const turn of turns) {
    if (!turn.suggested.length) continue;
    const t = Date.parse(turn.at);
    if (!Number.isFinite(t) || t < first) continue;
    const reply = replies.find((r) => r.t >= t);
    if (!reply) continue;
    const list = out.get(reply.id);
    if (list) list.push(turn); else out.set(reply.id, [turn]);
  }
  return out;
}

/** The notes past MAX_LINES for one reply. */
export function overflowTurns(turns: readonly SkillTurn[]): SkillTurn[] {
  return turns.slice(MAX_LINES);
}

/** The most short names a line shows before "+N more". The full ids are in the popover. */
export const MAX_NAMES = 3;

function names(ids: readonly string[]): string {
  const short = ids.slice(0, MAX_NAMES).map(shortSkillName).join(', ');
  return ids.length > MAX_NAMES ? `${short} +${ids.length - MAX_NAMES} more` : short;
}

/** "Suggested: a, b · loaded: a", or "Suggested to <subagent>: a, b" for a note made when a subagent started. At most 3 names per part, then "+N more". */
export function lineText(turn: SkillTurn): string {
  const head = turn.subagent ? `Suggested to ${turn.subagent}: ` : 'Suggested: ';
  const loaded = turn.loaded.length ? ` \u00b7 loaded: ${names(turn.loaded)}` : '';
  return head + names(turn.suggested) + loaded;
}

/** One popover row: "id · score 12.3 · matched: pdf, export". A skill the core marked third-party shows its id only. */
export function rowText(why: SkillTurn['why'][number]): string {
  if (why.thirdParty) return why.id;
  const matched = why.matched.length ? ` \u00b7 matched: ${why.matched.join(', ')}` : '';
  return `${why.id} \u00b7 score ${why.score.toFixed(1)}${matched}`;
}
