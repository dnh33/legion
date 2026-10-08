/**
 * Fascia 3b (claude/plan-fascia.md 6.3): the typed brief an agent sends on ask/tell, and the typed result it reads back.
 *
 * A brief is optional: prose still works. When one is given the bridge renders it into the callee's message as a short
 * header (Goal, numbered Done when, Context, Returns) under the existing "from" line, so the callee receives a contract
 * instead of free text. The brief also bounds the child run's spend (budget.usd -> maxBudgetUsd, clamped by the owner's
 * claude.maxBudgetUsd) and, when the answer's first line matches the callee's own output contract, the ask result names
 * the verdict. Nothing here writes state, touches the board, or calls a model: it is pure, so it is cheap to test.
 *
 * A verdict is read from the answer, never written anywhere as a board status: bots never set Review or Done.
 */

/** The urgency of a delegated task. Accepted for forward compatibility; nothing orders by it in v1 (no scheduler exists). */
export type BriefPriority = 'low' | 'normal' | 'high';

/** The typed brief. Mirrored by briefSchema in agent-tools.ts, which is what a tool call is validated against. */
export interface Brief {
  /** One outcome, at most GOAL_MAX characters. This is also the only text the router scores (see routeTextFor). */
  goal: string;
  /** One to four observable checks that decide done. The plan gate (3c) edits one check at a time. */
  done_when: string[];
  /** Pointers the callee needs: file:line refs, task ids. */
  context?: string[];
  /** What to hand back. */
  returns?: string;
  /** A spend cap for the child run, in USD. Clamped at run time by the owner's claude.maxBudgetUsd. */
  budget?: { usd?: number };
  priority?: BriefPriority;
}

/** Longest goal (characters), and the least and most done_when checks. The zod schema and the renderer share these. */
export const GOAL_MAX = 300;
export const DONE_WHEN_MIN = 1;
export const DONE_WHEN_MAX = 4;

/**
 * The callee's message: the brief header, then the prose message when one was given too. The bridge prepends the
 * existing "[From X ...]" line above this (engine.ts job.header), so the callee sees the header under it, as the plan says.
 */
export function renderBrief(brief: Brief, message?: string): string {
  const lines = [`Goal: ${brief.goal}`, 'Done when:'];
  brief.done_when.forEach((check, i) => lines.push(`${i + 1}. ${check}`));
  if (brief.context?.length) lines.push(`Context: ${brief.context.join('; ')}`);
  if (brief.returns) lines.push(`Returns: ${brief.returns}`);
  const head = lines.join('\n');
  const body = message?.trim();
  return body ? `${head}\n\n${body}` : head;
}

/**
 * The text the auto router may score when a brief is used: the goal only. The done_when checks, the context refs and the
 * returns line are a checklist, not the task, and must not flip `auto` (router.ts scores words such as plan, review and
 * debug, and any prompt over 1800 characters). undefined means "no brief": score the whole prompt, exactly as before.
 */
export function routeTextFor(brief: Brief | undefined): string | undefined {
  return brief && brief.goal.trim() ? brief.goal : undefined;
}

/** The positive, finite USD amount a brief asks for, or undefined. The engine clamps it against the owner's cap. */
export function briefBudget(brief: Brief | undefined): number | undefined {
  const usd = brief?.budget?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : undefined;
}

/**
 * The per-run spend cap for a child run: the requested amount, never above the owner's claude.maxBudgetUsd.
 * An absent owner cap leaves the requested amount as the only bound (there is nothing to clamp to); an absent request
 * leaves the owner's cap in charge. A non-positive or non-finite request is dropped rather than passed on.
 */
export function clampBudget(requested: number | undefined, ownerCap: number | undefined): number | undefined {
  const req = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : undefined;
  if (req === undefined) return ownerCap;
  if (ownerCap === undefined) return req;
  return Math.min(req, ownerCap);
}

const OUTPUT_SHAPE_RE = /^Output shape: (.+)$/m;
/** Runs of two or more uppercase words: the first-line verdicts a soul's contract names (BUILT, PARTIAL, NOT FIXED, ...). */
const UPPER_RUN_RE = /\b[A-Z][A-Z]+(?:\s+[A-Z][A-Z]+)*\b/g;

/** The verdict tokens a soul's "Output shape:" line names, in the order they appear, without duplicates. [] when it names none. */
export function verdictTokens(soulText: string): string[] {
  const shape = OUTPUT_SHAPE_RE.exec(soulText ?? '')?.[1];
  if (!shape) return [];
  const out: string[] = [];
  for (const m of shape.matchAll(UPPER_RUN_RE)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/** The answer's first line, with leading markdown/quote decoration stripped, so "**BUILT**" still reads as BUILT. */
function firstLineOf(answer: string): string {
  const line = (answer ?? '').split(/\r?\n/)[0] ?? '';
  return line.replace(/^[\s>*_`~#-]+/, '').trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first-line verdict of an answer, matched against the callee's own contract (the "Output shape:" line of its soul):
 * the answer's first token when it is one the soul names (BUILT/PARTIAL/BLOCKED, VERIFIED/NOT FIXED/QUESTIONABLE, ...),
 * else the literal `none`. Longest token first, so "NOT FOUND" wins over "FOUND". An unknown soul (no contract) is `none`.
 */
export function verdictOf(soulText: string, answer: string): string {
  const tokens = verdictTokens(soulText);
  if (!tokens.length) return 'none';
  const line = firstLineOf(answer);
  if (!line) return 'none';
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`^${escapeRe(token)}(?![A-Za-z])`, 'i').test(line)) return token;
  }
  return 'none';
}
