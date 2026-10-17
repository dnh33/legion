// The pure part of changing gate settings from a window: one change through the app's bridge, and the visible result of it. No store, no api:
// tests run it as it is.

export type GatesChangeRequest =
  | { kind: 'app'; patch: Record<string, unknown> }
  | { kind: 'project'; id: string; patch: Record<string, unknown> }
  | { kind: 'accept'; name: string }
  | { kind: 'keep'; name: string };

export type GatesOutcome = { state: 'ok' } | { state: 'cancelled' } | { state: 'error'; message: string };
export interface GatesNote { tone: 'ok' | 'info' | 'error'; text: string }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One change through the app window's bridge. No bridge (a plain browser) is an error that says to open the app. */
export async function applyViaBridge(bridge: ((c: unknown) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>) | undefined, change: GatesChangeRequest, reload: () => Promise<void>): Promise<GatesOutcome> {
  if (!bridge) return { state: 'error', message: 'Changing gate settings needs the Legion app window, which shows a confirmation. Open the app to do this.' };
  try {
    const r = await bridge(change);
    if (r.cancelled) return { state: 'cancelled' };
    if (!r.ok) return { state: 'error', message: r.error ?? 'The change was not made.' };
    await reload();
    return { state: 'ok' };
  } catch (e) { return { state: 'error', message: msg(e) }; }
}

export const CANCELLED_NOTE = 'Cancelled. Nothing changed.';
/** One change and the visible result of it: saved (the `done` words), cancelled, or the reason it failed. */
export async function runAction(apply: (c: GatesChangeRequest) => Promise<GatesOutcome>, change: GatesChangeRequest, done: string): Promise<{ ok: boolean; note: GatesNote }> {
  const r = await apply(change);
  if (r.state === 'ok') return { ok: true, note: { tone: 'ok', text: done } };
  if (r.state === 'cancelled') return { ok: false, note: { tone: 'info', text: CANCELLED_NOTE } };
  return { ok: false, note: { tone: 'error', text: r.message } };
}
