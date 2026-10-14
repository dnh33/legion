/** What an answer in the digest does once it is allowed to go (after its hold, or at once for Deny and Reject). The only code on the page that talks to the cards' routes. */
import { AWAY_COPY } from '../../../../src/shared/away-copy';
import { api, ApiError } from '../../api';
import { settleApproval, setState } from '../../store';
import { acceptItem, rejectItem } from '../board/boardStore';
import type { SendResult } from '../hold';
import { DEFAULT_WAIT_MIN } from './askLogic';
import type { AskRow, RowButton } from './askLogic';

const reasonOf = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export async function sendAnswer(row: AskRow, b: RowButton, ctx: { projectId: string; suggestedAssignee?: string }): Promise<SendResult> {
  try {
    switch (b.act) {
      case 'allow': case 'deny': {
        const allow = b.act === 'allow';
        const r = await api.decide(row.ids[0]!, allow);
        if (!r.ok) return { ok: false, reason: allow ? AWAY_COPY.wait.holdRace(DEFAULT_WAIT_MIN) : 'This approval was already settled.' };
        settleApproval(row.ids[0]!, allow);
        return { ok: true };
      }
      case 'allow-all': {
        for (const id of row.ids) {
          const r = await api.decide(id, true);
          if (!r.ok) return { ok: false, reason: AWAY_COPY.wait.holdRace(DEFAULT_WAIT_MIN) };
          settleApproval(id, true);
        }
        return { ok: true };
      }
      case 'opt': {
        const r = await api.answerQuestion(row.ids[0]!, [{ labels: [b.option ?? b.label] }]);
        if (!r.ok) return { ok: false, reason: 'This question was already settled.' };
        setState((s) => ({ questions: s.questions.filter((q) => q.id !== row.ids[0]) }));
        return { ok: true };
      }
      case 'accept': {
        const item = await acceptItem(ctx.projectId, row.ids[0]!, ctx.suggestedAssignee ? { assignee: { kind: 'agent', id: ctx.suggestedAssignee } } : {});
        return item ? { ok: true } : { ok: false, reason: 'The item could not be accepted. It may have been changed.' };
      }
      case 'reject': {
        const r = await rejectItem(ctx.projectId, row.ids[0]!);
        return r ? { ok: true } : { ok: false, reason: 'The item could not be rejected. It may have been changed.' };
      }
      default: return { ok: false, reason: 'Nothing to send.' };
    }
  } catch (e) { return { ok: false, reason: reasonOf(e) }; }
}

/** Plain words once the answer is on its way. Present tense until sent is the hold's own text; these are the final lines. */
export function doneText(row: AskRow, b: RowButton): string {
  const who = row.agentName;
  switch (b.act) {
    case 'allow': return `Allowed. ${who} continues.`;
    case 'allow-all': return `Allowed all ${row.ids.length}. ${who} continues.`;
    case 'opt': return `You chose ${b.option ?? b.label}. ${who} continues.`;
    case 'accept': return 'Accepted. Still marked untrusted until you mark it reviewed.';
    case 'deny': return `Denied. ${who} was told no.`;
    case 'reject': return 'Rejected. Nothing was added to the board.';
    default: return 'Done.';
  }
}
