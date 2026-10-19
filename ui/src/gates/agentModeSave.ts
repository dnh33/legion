// Saving an agent when its approval fields are in the save. Raising how little an agent asks needs the app's native confirm, so the approval
// fields never travel with the rest: they go through the window's bridge (window.legion.agentModeChange), which asks the core what the change does,
// shows the dialog only for a loosening, and sends it with the secret this window never holds. Everything else saves as it always did.
// A saved agent changes its mode FIRST, so a cancel leaves everything as it was. A new agent is created asking first (the safe default), then the mode is set.
import type { AgentProfile } from '../../../src/shared/types.js';

export type ModeBridge = (c: { agentId: string; approval?: string; approvalSource?: string }) => Promise<{ ok: boolean; error?: string; cancelled?: boolean; view?: unknown }>;
export type AgentBody = Omit<Partial<AgentProfile>, 'taskList'> & { name: string; taskList?: 'on' | 'off' | null };
export interface SaveDeps {
  bridge?: ModeBridge | undefined;
  patch(id: string, body: AgentBody): Promise<AgentProfile>;
  create(body: AgentBody): Promise<AgentProfile>;
}
export type SaveResult =
  | { state: 'saved'; agent: AgentProfile }
  | { state: 'cancelled'; text: string; created?: AgentProfile }
  | { state: 'error'; text: string; created?: AgentProfile };

export const CANCELLED_TEXT = 'Cancelled. Nothing changed.';
export const CANCELLED_NEW_TEXT = 'Cancelled. The agent was created and asks before it acts.';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isAgent = (v: unknown): v is AgentProfile => !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';

export async function saveWithMode(id: string | null, body: AgentBody, deps: SaveDeps): Promise<SaveResult> {
  const { approval, approvalSource, ...rest } = body;
  const hasMode = approval !== undefined || approvalSource !== undefined;
  const bridge = hasMode ? deps.bridge : undefined;
  try {
    // No bridge (a plain browser, or nothing to change): one request as before. The core refuses a raise that has no confirmation, and says so.
    if (!bridge) return { state: 'saved', agent: id ? await deps.patch(id, body) : await deps.create(body) };
    const change = { ...(approval !== undefined ? { approval } : {}), ...(approvalSource !== undefined ? { approvalSource } : {}) };
    if (id) {
      const r = await bridge({ agentId: id, ...change });
      if (r.cancelled) return { state: 'cancelled', text: CANCELLED_TEXT };
      if (!r.ok) return { state: 'error', text: r.error ?? 'The change was not made.' };
      return { state: 'saved', agent: await deps.patch(id, rest) };
    }
    const created = await deps.create(rest);
    // a new agent that already asks first (own mode Ask) has nothing more to set
    if (approval === 'ask' && approvalSource === 'own') return { state: 'saved', agent: created };
    const r = await bridge({ agentId: created.id, ...change });
    if (r.cancelled) return { state: 'cancelled', text: CANCELLED_NEW_TEXT, created };
    if (!r.ok) return { state: 'error', text: `The agent was created, but its approvals were not set: ${r.error ?? 'the change was not made.'}`, created };
    return { state: 'saved', agent: isAgent(r.view) ? r.view : created };
  } catch (e) { return { state: 'error', text: msg(e) }; }
}
