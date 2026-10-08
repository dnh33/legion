/**
 * Structured questions: an agent asks the owner with set choices (1-4 questions, each 2-4 options plus an Other
 * free-text field) instead of falling back to chat text. The owner answers a clickable card in the thread.
 *
 * This is the approval card's twin: the same broker shape (a pending map, one waiter per request, a 10-minute
 * auto-decline, events on the bus, cancelForTask when a run is cancelled), but the answer is a set of picks rather
 * than a boolean, and a question card is never answered by a key (the A-key safety rule; both the card and the
 * thread-wide shortcut read src/shared/approval-keys.ts for approvals, and a question card carries the `.approval`
 * class so the same "focus is on a card" guard in Thread.tsx skips it — see ui/src/components/QuestionCard.tsx).
 */
import { describeWait } from './approvals.js';
import type { EventBus } from './bus.js';
import type { PendingQuestion, QuestionPick, QuestionSpec, QuestionOption } from '../shared/types.js';
import { newId, nowIso } from '../shared/util.js';

/** The shape an agent may ask in. Claude Code's own AskUserQuestion uses the same bounds. */
export const QUESTION_LIMITS = { minQuestions: 1, maxQuestions: 4, minOptions: 2, maxOptions: 4 } as const;

export type QuestionValidation = { ok: true; questions: QuestionSpec[] } | { ok: false; error: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Validate and normalise an ask_user_question input. Bounds: 1-4 questions, each with 2-4 options, each option a
 * non-empty label, at most one option marked recommended. Normalises so the model cannot smuggle extra fields into
 * the card, and trims labels. Returns a plain error string a tool result can carry.
 */
export function validateQuestions(input: unknown): QuestionValidation {
  const raw = obj(input)?.['questions'];
  const arr = Array.isArray(raw) ? raw : null;
  if (!arr) return { ok: false, error: 'questions must be an array of 1-4 questions.' };
  if (arr.length < QUESTION_LIMITS.minQuestions || arr.length > QUESTION_LIMITS.maxQuestions) {
    return { ok: false, error: `Between ${QUESTION_LIMITS.minQuestions} and ${QUESTION_LIMITS.maxQuestions} questions are allowed (got ${arr.length}).` };
  }
  const out: QuestionSpec[] = [];
  for (let i = 0; i < arr.length; i++) {
    const q = obj(arr[i]);
    if (!q) return { ok: false, error: `Question ${i + 1} must be an object.` };
    const question = str(q['question']);
    if (!question) return { ok: false, error: `Question ${i + 1} needs a non-empty 'question'.` };
    const header = str(q['header']) ?? `Q${i + 1}`;
    const rawOpts = Array.isArray(q['options']) ? q['options'] : null;
    if (!rawOpts || rawOpts.length < QUESTION_LIMITS.minOptions || rawOpts.length > QUESTION_LIMITS.maxOptions) {
      return { ok: false, error: `Question ${i + 1} needs ${QUESTION_LIMITS.minOptions}-${QUESTION_LIMITS.maxOptions} options (got ${rawOpts ? rawOpts.length : 0}).` };
    }
    const options: QuestionOption[] = [];
    let recommended = 0;
    for (let j = 0; j < rawOpts.length; j++) {
      const o = obj(rawOpts[j]);
      const label = o ? str(o['label']) : null;
      if (!label) return { ok: false, error: `Question ${i + 1}, option ${j + 1} needs a non-empty 'label'.` };
      const description = o && typeof o['description'] === 'string' ? o['description'] : '';
      const preview = o && typeof o['preview'] === 'string' && o['preview'] ? o['preview'] : undefined;
      const rec = o && o['recommended'] === true ? true : undefined;
      if (rec) recommended++;
      options.push({ label, description, ...(preview ? { preview } : {}), ...(rec ? { recommended: true } : {}) });
    }
    if (recommended > 1) return { ok: false, error: `Question ${i + 1} marks more than one option Recommended; mark one at most.` };
    out.push({ question, header, options, multiSelect: q['multiSelect'] === true });
  }
  return { ok: true, questions: out };
}

/** The owner's answer to one question card: what they picked, or that nobody answered. */
export interface QuestionResult { answered: boolean; picks: QuestionPick[] | null }

interface Pending { req: PendingQuestion; resolve: (r: QuestionResult) => void; timer: ReturnType<typeof setTimeout> }

export class QuestionBroker {
  private readonly items = new Map<string, Pending>();
  private readonly timeoutMs: number;
  /** How long a card waits for an answer before it is declined, in words ("10 minutes"). For messages that explain a timeout. */
  get timeoutWait(): string { return describeWait(this.timeoutMs); }
  constructor(private readonly bus: EventBus, opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
  }

  request(taskId: string, agentId: string, questions: QuestionSpec[], origin?: PendingQuestion['origin']): Promise<QuestionResult> {
    const req: PendingQuestion = {
      id: newId('q'), taskId, agentId, questions, at: nowIso(),
      ...(origin ? { origin } : {}),
    };
    return new Promise<QuestionResult>((resolvePromise) => {
      const timer = setTimeout(() => this.settle(req.id, { answered: false, picks: null }), this.timeoutMs);
      this.items.set(req.id, { req, resolve: resolvePromise, timer });
      this.bus.emit({ type: 'question.requested', question: req });
    });
  }

  /** The owner submitted answers. Returns false when the id is unknown (already answered, cancelled or timed out). */
  resolve(id: string, picks: QuestionPick[]): boolean { return this.settle(id, { answered: true, picks }); }

  /** A cancelled run leaves no card behind: one pick per open question, answered = false. */
  cancelForTask(taskId: string): void {
    for (const [id, p] of [...this.items]) if (p.req.taskId === taskId) this.settle(id, { answered: false, picks: null });
  }

  pending(): PendingQuestion[] { return [...this.items.values()].map((p) => p.req); }

  private settle(id: string, result: QuestionResult): boolean {
    const p = this.items.get(id);
    if (!p) return false;
    this.items.delete(id);
    clearTimeout(p.timer);
    this.bus.emit({ type: 'question.resolved', questionId: id, answered: result.answered });
    p.resolve(result);
    return true;
  }
}
