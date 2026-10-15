import { useEffect, useMemo, useRef, useState } from 'react';
import type { PendingQuestion, QuestionPick } from '../../../src/shared/types';
import { answerQuestion, useStore } from '../store';
import {
  applyOther, applyPick, finalAnswers, initialAnswers, isAnswered, isReviewStep, orderedOptions, questionKey, reviewOf, stepCount,
} from '../chat/questionCard';
import { Icon } from './icons';
import { useArmUi, useCardArm } from '../a11y/keyClock';

/** "Asked by Marshal through the agent bridge, hop 2": shown when a bot woken elsewhere needs an answer. */
function Origin({ o }: { o: NonNullable<PendingQuestion['origin']> }) {
  const from = useStore((s) => s.agents.find((x) => x.id === o.fromAgentId)?.name ?? o.fromAgentId);
  const viaBridge = o.roomId === 'agent-bridge';
  const viaMcp = o.roomId === 'mcp';
  return (
    <div className="approval-origin">
      {viaMcp ? <span>Asked by <b>an MCP client</b> (Claude Code, Cowork or another tool using your access token)</span>
        : viaBridge ? <span>Asked by <b>{from}</b> through the agent bridge, hop {o.hop}</span>
        : <span>Asked by <b>{from}</b>, hop {o.hop}</span>}
    </div>
  );
}

/**
 * One structured question card. It reuses the approval card's shell (`.approval`, and with it the colours, border,
 * radius and the keyboard-only focus ring), and adds the Claude-Code-style flow: a step per question at the top, one
 * answered at a time, a review step before Submit, the recommended option first with a badge, and an option's preview
 * in a side panel while it is focused.
 *
 * Keys: arrows move, Enter picks, 1-4 pick directly, Esc closes Other. There is no A-key answer (see questionCard.ts).
 */
export function QuestionCard({ q }: { q: PendingQuestion }) {
  const n = q.questions.length;
  const steps = stepCount(q.questions);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<QuestionPick[]>(() => initialAnswers(n));
  const [focus, setFocus] = useState(0);
  const [otherOpen, setOtherOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const arm = useCardArm(`question:${q.id}`);
  const { armed, refresh } = useArmUi(arm);
  // an ignored pick or submit says so: the note while not armed, and the same words once for a screen reader
  const [ignored, setIgnored] = useState(false);
  const [said, setSaid] = useState('');
  useEffect(() => { if (armed) setIgnored(false); }, [armed]);
  const notReady = (): void => { setIgnored(true); setSaid('Ready in a moment'); refresh(); };
  const optRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const otherRef = useRef<HTMLInputElement>(null);

  const cur = step < n ? q.questions[step]! : null;
  const opts = useMemo(() => (cur ? orderedOptions(cur.options) : []), [cur]);
  const preview = focus < opts.length ? opts[focus]?.preview : undefined;

  useEffect(() => { setFocus(0); setOtherOpen(false); }, [step]);
  useEffect(() => { if (otherOpen) otherRef.current?.focus(); }, [otherOpen]);

  const pick = (label: string) => {
    if (!cur) return;
    setAnswers((a) => applyPick(a, step, label, cur.multiSelect));
    if (!cur.multiSelect) setStep((s) => Math.min(s + 1, steps - 1));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ok = arm.key(e.nativeEvent, e.key, e.repeat, performance.now());
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const act = questionKey({ key: e.key, step, questionCount: n, optionCount: opts.length, focus, otherOpen });
    if (act.kind === 'none') return;
    // picking and submitting answer the question, so they wait for the arm (the window shortcut's rule); moving the highlight does not
    if (!ok && (act.kind === 'pick' || act.kind === 'submit')) { if (!e.repeat) notReady(); return; }
    e.preventDefault();
    if (act.kind === 'move') {
      const ni = Math.min(Math.max(0, focus + act.delta), Math.max(0, opts.length - 1));
      if (ni !== focus) { setFocus(ni); optRefs.current[ni]?.focus(); }
    } else if (act.kind === 'pick') {
      const o = opts[act.index];
      if (o) pick(o.label);
    } else if (act.kind === 'closeOther') setOtherOpen(false);
    else if (act.kind === 'submit') submit();
  };

  const submit = () => {
    setBusy(true);
    void answerQuestion(q.id, finalAnswers(answers));
  };

  const allAnswered = q.questions.every((_, i) => isAnswered(answers, i));

  return (
    <div className="approval question" tabIndex={0} data-armed={armed ? 'true' : 'false'} role="group" aria-label={`Question from the agent: ${q.questions[0]?.header ?? 'question'}`} onFocus={(e) => arm.enterFrom(e.currentTarget, e.relatedTarget, performance.now())} onKeyDown={onKeyDown}>
      <div className="approval-head">
        <Icon name="help" size={14} />
        <span>Needs your answer</span>
        <b className="approval-tool">question{n > 1 ? `s (${n})` : ''}</b>
      </div>
      {q.origin && <Origin o={q.origin} />}

      <div className="question-steps" role="tablist" aria-label="Questions">
        {q.questions.map((qq, i) => (
          <button key={i} type="button" role="tab" aria-selected={step === i} tabIndex={-1}
            className={`qstep${step === i ? ' on' : ''}${isAnswered(answers, i) ? ' done' : ''}`}
            onClick={() => setStep(i)}>
            {isAnswered(answers, i) && <Icon name="check" size={11} />} {qq.header}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={isReviewStep(step, n)} tabIndex={-1}
          className={`qstep review${isReviewStep(step, n) ? ' on' : ''}`} onClick={() => setStep(n)}>Review</button>
      </div>

      {cur ? (
        <div className="question-body">
          <div className="question-text">{cur.question}{cur.multiSelect && <span className="question-multi"> · pick any</span>}</div>
          <div className={`question-main${preview ? ' has-preview' : ''}`}>
            <div className="question-opts" role="listbox" aria-label={cur.header} aria-multiselectable={cur.multiSelect}>
              {opts.map((o, i) => {
                const picked = answers[step]?.labels.includes(o.label) === true;
                return (
                  <button key={o.label} type="button" role="option" aria-selected={picked}
                    ref={(el) => { optRefs.current[i] = el; }}
                    className={`qopt${picked ? ' on' : ''}`}
                    onMouseEnter={() => setFocus(i)} onFocus={() => setFocus(i)} onClick={(e) => { if (!arm.click(e.detail, performance.now())) { notReady(); return; } pick(o.label); }}>
                    <span className="qopt-label">{o.label}{o.recommended && <span className="qrec">Recommended</span>}</span>
                    {o.description && <span className="qopt-desc">{o.description}</span>}
                  </button>
                );
              })}
              <button type="button" className="qopt other" onClick={() => { setFocus(opts.length); setOtherOpen(true); }}>
                <span className="qopt-label">Other</span>
                <span className="qopt-desc">Type your own answer</span>
              </button>
            </div>
            {preview && <pre className="question-preview" aria-label="Preview">{preview}</pre>}
          </div>
          {otherOpen && (
            <div className="question-other">
              <input ref={otherRef} className="qother-input" placeholder="Type your answer, then Esc to close"
                value={answers[step]?.other ?? ''}
                onChange={(e) => setAnswers((a) => applyOther(a, step, e.target.value))}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOtherOpen(false); } }} />
              <button type="button" className="btn sm" onClick={() => setOtherOpen(false)}>Done</button>
            </div>
          )}
        </div>
      ) : (
        <div className="question-body">
          <div className="question-text">Review your answers</div>
          <div className="question-review">
            {reviewOf(q, answers).map((r, i) => (
              <div key={i} className="qrow"><span className="qrow-h">{r.header}</span><span className="qrow-a">{r.answer}</span></div>
            ))}
          </div>
        </div>
      )}

      <div className="approval-actions">
        <button type="button" className="btn" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</button>
        {cur
          ? <button type="button" className="btn primary" disabled={!isAnswered(answers, step)} onClick={() => setStep((s) => Math.min(s + 1, n))}>Next</button>
          : <button type="button" className="btn primary" disabled={busy || !allAnswered} onClick={(e) => { if (!arm.click(e.detail, performance.now())) { notReady(); return; } submit(); }}>Submit</button>}
        {ignored && !armed && <span className="approval-note">Ready in a moment</span>}
        <span className="sr-only" role="status" aria-live="polite">{said}</span>
        <span className="approval-note">arrows move · Enter picks · 1-4 pick · Esc closes Other</span>
      </div>
    </div>
  );
}
