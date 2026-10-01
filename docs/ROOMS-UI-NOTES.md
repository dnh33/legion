# Rooms UI: notes and requested shared-file changes

Owned files: `ui/src/rooms/**` (RoomsView, RoomList, RoomPane, RoomHeader, Transcript, RoomComposer, RoomSettings, NewRoomDialog, Dialog, Stack, roomsStore, roomsUtil, rooms.css) and `ui/src/components/ApprovalCard.tsx` (origin line + "Open room").

Nothing below is required for the Rooms tab to work. Each is a small optional change in a shared file.

## 1. Track unread and paused rooms before the Rooms tab is first opened (App.tsx)

The rooms store subscribes to SSE and loads the list when `RoomsView` first mounts. To light unread dots from app start:

```diff
--- a/ui/src/App.tsx
+++ b/ui/src/App.tsx
@@
 import { RoomsView } from './rooms/RoomsView';
+import { initRooms } from './rooms/roomsStore';
@@
-  useEffect(() => { init(); }, []);
+  useEffect(() => { init(); initRooms(); }, []);
```

## 2. Attention badge on the Rooms tab (TitleBar.tsx), depends on 1

```diff
--- a/ui/src/components/TitleBar.tsx
+++ b/ui/src/components/TitleBar.tsx
@@
+import { isUnread, useRooms } from '../rooms/roomsStore';
@@
   const view = useStore((s) => s.view);
+  const roomAttn = useRooms((s) => s.rooms.filter((r) => r.paused || isUnread(s, r)).length);
@@
             {v === 'chat' ? 'Chat' : v === 'rooms' ? 'Rooms' : 'Lattice'}
+            {v === 'rooms' && view !== 'rooms' && roomAttn > 0 && <i className="tb-badge" aria-label={`${roomAttn} rooms need attention`}>{roomAttn}</i>}
```
`.tb-badge` is already defined in `rooms.css` (loaded by `roomsStore.ts`).

## 3. components/Modal.tsx has no Escape handling

`rooms/Dialog.tsx` adds Escape-to-close on top of Modal. Other dialogs rely on App.tsx's Escape handler for main-store overlays only. Suggested fix inside Modal (then Dialog can be dropped):

```diff
--- a/ui/src/components/Modal.tsx
+++ b/ui/src/components/Modal.tsx
@@
   useEffect(() => {
     const prev = document.activeElement as HTMLElement | null;
     const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button');
     first?.focus();
-    return () => prev?.focus?.();
-  }, []);
+    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
+    window.addEventListener('keydown', esc);
+    return () => { window.removeEventListener('keydown', esc); prev?.focus?.(); };
+  }, [onClose]);
```
(Modal's focus trap also counts disabled inputs as focusable; add `:not([disabled])` to its selector for `input, textarea, select`.)

## 4. Backend text aimed at bots shows API calls to the human

Guard messages posted by `src/core/comms/hub.ts` contain "Send POST /api/rooms/<id>/resume", "PATCH /api/rooms/<id>". The UI rewrites these (`cleanGuardText` in `roomsUtil.ts`). If the hub ever stores a UI-friendly `text` separately from the bot-facing text, drop that shim.

## 5. Behaviour notes for the integration lead

- Unread is client-side: `localStorage legion.rooms.seen` (room id -> last seen `updatedAt`). The hub only tracks per-bot read cursors.
- `comms.state` entries are cleared on reconnect and when a room becomes paused, so a dropped SSE link cannot leave a bot "speaking" forever.
- Each live `<Bust>` runs its own animation engine, so `Face` (`rooms/Stack.tsx`) mounts a Bust only while its frame is on screen (IntersectionObserver) and shows the agent emoji otherwise. A long transcript would otherwise create one engine per message.
- Export uses `fetch` with the bearer header and a Blob download (a plain link cannot send the token).
- `ApprovalCard` imports `rooms/roomsStore` to resolve the room name (it triggers a room-list load the first time an approval with `origin` renders) and offers "Open room" outside the Rooms view.
