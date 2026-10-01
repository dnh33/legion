import type { Room, RoomPauseReason, RoomStrategy } from '../../../src/shared/comms';
import type { AgentProfile } from '../../../src/shared/types';

export const fmtCost = (n: number | undefined): string => (n == null ? '' : n === 0 ? '$0.00' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
export const fmtBudget = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

export const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
export const dayKey = (iso: string): string => new Date(iso).toDateString();
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((t0 - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export const agentName = (agents: AgentProfile[], id: string): string => agents.find((a) => a.id === id)?.name ?? id;

export const STRATEGY_INFO: Record<RoomStrategy, { label: string; desc: string }> = {
  mention: { label: 'Mention', desc: 'Only @mentioned bots wake. With no mention, the lead answers.' },
  manager: { label: 'Manager', desc: 'The lead gets every message and routes work by @mention.' },
  'round-robin': { label: 'Round robin', desc: 'Each plain message goes to the next member in turn.' },
  all: { label: 'Everyone answers', desc: 'Every member answers each message once. Replies do not re-trigger others.' },
};

/** One line: who answers a plain (no @mention) human message. */
export function whoAnswers(room: Room, name: (id: string) => string, short = false): string {
  if (short) {
    switch (room.strategy) {
      case 'mention': return `No @mention: ${name(room.lead)} answers`;
      case 'manager': return `${name(room.lead)} routes every message`;
      case 'round-robin': return 'Plain messages rotate through members';
      case 'all': return 'Every member answers each message';
    }
  }
  switch (room.strategy) {
    case 'mention': return `Plain messages go to ${name(room.lead)} (lead). @mention others to wake them.`;
    case 'manager': return `${name(room.lead)} (lead) receives every message and routes by @mention.`;
    case 'round-robin': return 'Plain messages go to the next member in turn.';
    case 'all': return 'Every member answers each plain message once.';
  }
}

export interface PauseCopy { title: string; body: string; sendResumes: boolean }
export function pauseCopy(room: Room): PauseCopy | null {
  const p = room.paused;
  if (!p) return null;
  const g = room.guards;
  const reason: RoomPauseReason = p.reason;
  switch (reason) {
    case 'frozen': return { title: 'Room frozen', body: 'Running bot tasks were cancelled and queued messages dropped. New messages are stored, but no bot wakes until you resume.', sendResumes: false };
    case 'max-hops': return { title: 'Hop limit reached', body: `Bots passed the conversation ${g.maxHops} times without a human message. Resume, or send a message to continue.`, sendResumes: true };
    case 'budget': return { title: 'Budget reached', body: `This room spent ${fmtCost(room.costUsd)} of its ${fmtBudget(g.budgetUsd)} limit. Raise the budget in room settings, then resume.`, sendResumes: false };
    case 'cycle': return { title: 'Loop detected', body: `Two bots repeated nearly the same message ${g.cycleRepeats} times. Resume, or send a message to break the loop.`, sendResumes: true };
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Splits text into plain strings and @mention tokens for the given names/ids (longest first, like the hub). */
export function splitMentions(text: string, tokens: string[]): Array<string | { mention: string }> {
  const all = [...new Set([...tokens, 'everyone'].filter((t) => t.trim()))].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\w@.-])@(${all.map(esc).join('|')})(?![\\w-])`, 'gi');
  const out: Array<string | { mention: string }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push({ mention: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Guard texts written for bots mention the resume endpoint; the UI has a Resume button instead. */
export const cleanGuardText = (t: string): string => t
  .replace(/\s*Send POST \/api\/rooms\/[\w-]+\/resume to continue\.?/gi, ' Use Resume to continue.')
  .replace(/guards\.budgetUsd with PATCH \/api\/rooms\/[\w-]+/gi, 'the budget in room settings')
  .replace(/POST \/api\/rooms\/[\w-]+\/resume/gi, 'press Resume')
  .trim();

export const snippet = (t: string, n = 90): string => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + '…' : one;
};
