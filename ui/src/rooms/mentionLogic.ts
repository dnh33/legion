import type { Room } from '../../../src/shared/comms.js';

export interface MentionCand { key: string; insert: string; label: string; sub: string; agentId?: string }

/**
 * The room composer's @ menu for the text typed after "@". Members come first and @everyone last: Enter takes the first
 * row, and a bare "@" must not wake every bot in the room. Rows that start with the query rank above rows that contain it.
 */
export function mentionCandidates(
  room: Pick<Room, 'members' | 'kind' | 'lead'>,
  agents: ReadonlyArray<{ id: string; name: string; description?: string }>,
  query: string,
): MentionCand[] {
  const q = query.toLowerCase();
  const all: MentionCand[] = [];
  for (const id of room.members) {
    const a = agents.find((x) => x.id === id);
    all.push({ key: id, insert: `@${a?.name ?? id}`, label: `@${a?.name ?? id}`, sub: id === room.lead ? 'Lead' : (a?.description ?? ''), agentId: id });
  }
  if (room.members.length > 1 && room.kind === 'group') all.push({ key: 'everyone', insert: '@everyone', label: '@everyone', sub: 'Wake every member once' });
  const score = (c: MentionCand) => { const l = c.label.slice(1).toLowerCase(); const id = (c.agentId ?? c.key).toLowerCase(); return l.startsWith(q) || id.startsWith(q) ? 0 : l.includes(q) || id.includes(q) ? 1 : 2; };
  return all.filter((c) => score(c) < 2).sort((a, b) => score(a) - score(b));
}
