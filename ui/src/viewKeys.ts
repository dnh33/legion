/**
 * F1 / F2 / F3 switch the main views: Chat, Rooms, Lattice.
 *
 * ## Why this is a renderer key handler and not `globalShortcut`
 *
 * `globalShortcut` is an OS-level registration. Registering F1 there would take that key away from every other
 * program on the machine for as long as Legion is running, so a user in their editor or their browser would find
 * F1 dead until Legion closed. That is a rude thing to do to a key you do not own, and it is why these are handled
 * here instead: the binding is real only while Legion has focus.
 *
 * ## Why the modifier guard
 *
 * Ctrl+F1 through F12 are claimed by plenty of things, and a bare keydown cannot tell F1 from Ctrl+F1. A navigation
 * binding that fires on Ctrl+F1 would yank the user out of the view they were in while some other shortcut was
 * running. So any modifier present means "not ours".
 */
/**
 * The view union is declared here rather than imported from `./store` on purpose. The renderer is built by Vite,
 * which resolves extensionless relative imports; the root tsconfig runs under NodeNext resolution and rejects them.
 * Importing the type from `store` therefore pulled the entire UI tree into the root type-check and lit up a dozen
 * errors in files this change never touched. One local type, and the two build systems stay separate.
 */
export type ViewName = 'chat' | 'rooms' | 'graph';

/** The three views reachable from the keyboard. `project` is deliberately absent: it is a drill-down, not a peer. */
export const VIEW_KEYS = { F1: 'chat', F2: 'rooms', F3: 'graph' } as const satisfies Record<string, ViewName>;

/** The hint shown in the view buttons, so the binding is discoverable without a manual. */
export const VIEW_KEY_LABELS = { chat: 'F1', rooms: 'F2', graph: 'F3' } as const;

/**
 * Which view a key event asks for, or `null` for "not a view key".
 *
 * Split out from the DOM entirely so the rule can be tested directly — the alternative is a test that renders the app
 * and synthesises events, which proves less and breaks more.
 */
export function viewForKey(key: string, opts: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}): ViewName | null {
  if (opts.ctrlKey || opts.metaKey || opts.altKey) return null;
  const hit = (VIEW_KEYS as Record<string, ViewName>)[key];
  return hit ?? null;
}