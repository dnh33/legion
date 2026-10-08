/**
 * The structured question card's pure logic, kept out of the component so it can be asserted without a browser
 * (the same split ui/src/chat/* uses).
 *
 * The keyboard rule is the important part. Arrows move, Enter picks, 1-4 pick directly, Esc closes Other, and on
 * the review step Enter submits. `a`/`A` is deliberately NOT in that vocabulary: the A-key safety rule (a shared
 * module, src/shared/approval-keys.ts, governs the approval cards) says one key must never answer a question the
 * owner has not read. The card also carries the `.approval` class, so the thread-wide A/D shortcut in Thread.tsx
 * (which skips a keypress whose focus is inside `.approval`) does not reach it either.
 */
import type { PendingQuestion, QuestionOption, QuestionPick, QuestionSpec } from '../../../src/shared/types.js';

/** The recommended option first, then the rest in the order the agent gave. Stable when none is recommended. */
export function orderedOptions(options: QuestionOption[]): QuestionOption[] {
  const rec = options.filter((o) => o.recommended === true);
  if (rec.length === 0) return options;
  return [...rec, ...options.filter((o) => o.recommended !== true)];
}

/** Steps = one per question, then one review step. */
export const stepCount = (questions: QuestionSpec[]): number => questions.length + 1;
export const isReviewStep = (step: number, questionCount: number): boolean => step >= questionCount;

export type QuestionKeyAction =
  | { kind: 'move'; delta: number }
  | { kind: 'pick'; index: number }
  | { kind: 'closeOther' }
  | { kind: 'submit' }
  | { kind: 'none' };

/**
 * The card's single keyboard rule. While Other is open only Esc is recognised, so typing in the field never picks
 * an option; nothing else is handled while a text field holds focus.
 */
export function questionKey(input: { key: string; step: number; questionCount: number; optionCount: number; focus: number; otherOpen: boolean }): QuestionKeyAction {
  const { key, step, questionCount, optionCount, focus, otherOpen } = input;
  if (otherOpen) return key === 'Escape' ? { kind: 'closeOther' } : { kind: 'none' };
  if (isReviewStep(step, questionCount)) return key === 'Enter' ? { kind: 'submit' } : { kind: 'none' };
  if (key === 'ArrowDown' || key === 'ArrowRight') return { kind: 'move', delta: 1 };
  if (key === 'ArrowUp' || key === 'ArrowLeft') return { kind: 'move', delta: -1 };
  if (key === 'Enter') return { kind: 'pick', index: focus };
  const d = /^[1-4]$/.test(key) ? Number(key) - 1 : -1;
  if (d >= 0 && d < optionCount) return { kind: 'pick', index: d };
  return { kind: 'none' };
}

export function initialAnswers(questionCount: number): QuestionPick[] {
  return Array.from({ length: questionCount }, () => ({ labels: [] }));
}

/** Single-select replaces the pick; multi-select toggles it. Never touches the option order. */
export function applyPick(answers: QuestionPick[], i: number, label: string, multi: boolean): QuestionPick[] {
  const next = answers.map((a) => ({ ...a, labels: [...a.labels] }));
  const cur: QuestionPick = next[i] ?? { labels: [] };
  cur.labels = multi ? (cur.labels.includes(label) ? cur.labels.filter((l) => l !== label) : [...cur.labels, label]) : [label];
  next[i] = cur;
  return next;
}

/** The Other free-text field for one question. Empty text clears it. */
export function applyOther(answers: QuestionPick[], i: number, text: string): QuestionPick[] {
  const next = answers.map((a) => ({ ...a }));
  const trimmed = text.trim();
  const cur: QuestionPick = next[i] ?? { labels: [] };
  next[i] = trimmed ? { ...cur, other: trimmed } : { labels: [...cur.labels] };
  return next;
}

export const isAnswered = (answers: QuestionPick[], i: number): boolean => {
  const a = answers[i];
  return !!a && (a.labels.length > 0 || !!a.other);
};

/** The rows the review step shows: every question, the labels picked (and Other text when used). */
export function reviewRows(questions: QuestionSpec[], answers: QuestionPick[]): Array<{ header: string; question: string; answer: string }> {
  return questions.map((q, i) => {
    const a = answers[i];
    const parts: string[] = [...(a?.labels ?? [])];
    if (a?.other) parts.push(a.other);
    return { header: q.header, question: q.question, answer: parts.length ? parts.join(', ') : 'Not answered' };
  });
}

/** Convenience for the card: everything the review step needs, ready to render. */
export const reviewOf = (q: Pick<PendingQuestion, 'questions'>, answers: QuestionPick[]) => reviewRows(q.questions, answers);
