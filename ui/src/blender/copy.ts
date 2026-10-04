/**
 * Plain-language texts of the Blender screens (Settings and the approval card), kept in one place so test/blender-hedge.test.ts reads exactly
 * what a person reads. Wording is scoped on purpose (plan section 4): a local script runs with your Windows user's rights, Legion's check is a
 * filter and not a sandbox, and what Legion's own runner stops is stated with its limit.
 */
import type { BlenderMode, BlenderStatusView } from '../../../src/shared/blender';
import { BLENDER_SOCKET_NOTICE } from '../../../src/shared/blender';

export const MODE_CHOICES: ReadonlyArray<{ mode: BlenderMode; title: string; text: string }> = [
  { mode: 'auto', title: 'Automatic (recommended)', text: 'On this computer when Blender is found, otherwise in the cloud VM. Your open Blender is used only when the Sculptor asks for it and you approve a LIVE card.' },
  { mode: 'local', title: 'This computer, in the background', text: 'Legion starts Blender without a window on this PC and runs the script in a scene kept per task. The script runs with your Windows user’s rights. The control is your OK on the full script, the scene backup and the audit log. Legion’s own runner also stops the script’s Python code from writing files outside the task folder or opening network connections, which narrows accidents; Legion’s check is a filter, not a sandbox.' },
  { mode: 'vm', title: 'Cloud VM (boat.dev)', text: 'Runs in the Sculptor’s VM, away from this computer’s files and accounts. Needs a boat.dev key and VM time. Only exported files come back.' },
  { mode: 'live', title: 'My open Blender', text: 'Runs in your open Blender, with your files around it, and each script is shown as a LIVE card. Legion’s check is a filter, not a sandbox: read every line. The add-on’s socket has no password (see the notice below).' },
];

/** The cloud VM end-to-end run has not been recorded in claude/tracker-pc-checks.md, so that one note stays. */
export const NOT_TRIED_VM = 'Cloud VM: not yet tried on a real VM (Blender in the VM, rendering, file return).';
/**
 * Local mode is exercised end to end by test/blender-local.test.ts (the exact Blender argument list, the script
 * reaching Blender as the approved UTF-8 bytes, the allowlisted environment, the timeout killing the process tree
 * by PID, and the write guard). Say what it does, in the same register as the rest of the app.
 */
export const LOCAL_MODE_NOTE = 'Local mode: runs scripts with your installed Blender on this computer.';

export const LOCAL_SAFETY_NOTE =
  'Every script is checked, shown to you in full and needs your OK; there is no one-key Allow. On this computer a script runs with your Windows user’s rights: Legion’s check is a filter, not a sandbox, so read the script before you approve it. The scene is backed up before each local run, and every decision is written to a hash-chained audit log. The Cloud VM keeps scripts away from this computer; your open Blender (LIVE) has an add-on socket with no password.';

export const LOCAL_CARD_WARN = 'Runs headless Blender on this computer as you. Read every line: Legion’s check is a filter, not a sandbox.';
export const localCardExports = (exportDir: string, workspaceHint = ''): string =>
  exportDir ? ` Exports are written to ${exportDir}${workspaceHint ? ` and then copied into ${workspaceHint}` : ' and then copied into your workspace under blender-exports'}.` : '';

/** The add-on socket notice is about the live path only. */
export const showSocketNotice = (st: Pick<BlenderStatusView, 'mode' | 'sandbox' | 'socketOpen' | 'connected'>): boolean => {
  const mode = st.mode ?? (st.sandbox === 'off' ? 'live' : st.sandbox === 'vm' ? 'vm' : 'auto');
  return mode === 'live' || (mode === 'auto' && (st.socketOpen || st.connected));
};
/** st.notices without the socket notice when it does not apply. */
export const visibleNotices = (st: BlenderStatusView): string[] => (st.notices ?? []).filter((n) => n !== BLENDER_SOCKET_NOTICE || showSocketNotice(st));

/** "Get Blender for Legion" (Settings): what the button does and does not do. */
export const GET_BLENDER_TEXT =
  'Legion can fetch one pinned official portable Blender for its own background runs. It is downloaded only after you press the button and approve the card, is checked against a pinned sha256 before anything is unpacked, and is kept in Legion’s own folder. A Blender you installed yourself is not touched.';
export const FULL_BLENDER_TEXT = 'Want the full Blender app for yourself? Get it from the official download page. Legion downloads nothing from there.';
export const GET_BLENDER_NOT_PINNED = 'The hash for this Blender build has not been recorded in this version, so Legion will not download it yet.';

/** The one-time question on the first Blender card (the click is saved through the admin settings route; an agent cannot answer it). */
export const CHOOSER_TITLE = 'Where should Blender scripts run? Asked once.';
export const CHOOSER_TEXT = 'You can change this later in Settings, Blender. Every script still needs your OK on its own card.';
export const CHOOSER_OPTIONS: ReadonlyArray<{ mode: BlenderMode; label: string }> = [
  { mode: 'local', label: 'This computer' },
  { mode: 'vm', label: 'Cloud VM' },
  { mode: 'live', label: 'My open Blender' },
  { mode: 'auto', label: 'Decide each time (Automatic)' },
];
/** The choice to highlight: this computer when Blender is found, else the cloud VM when it is ready, else Automatic. */
export const chooserDefault = (st: Pick<BlenderStatusView, 'localReady' | 'sandboxReady'>): BlenderMode => (st.localReady ? 'local' : st.sandboxReady ? 'vm' : 'auto');

/** "Use both backends at once" (Settings, Blender). Off until switched on; it says what it adds and what it does not protect. */
export const BOTH_TITLE = 'Use both backends at once';
export const BOTH_TEXT =
  'The official Blender Lab server is the main backend and runs your scripts; the community add-on is added as a second source of read-only extras. Each add-on gets its own port, Legion checks which one answers where, and the Sculptor sees one merged tool list. Both add-on sockets have no password, so any program on this computer can reach either port. Off by default.';
export const ASSETS_TITLE = 'Asset downloads (outside content)';
export const ASSETS_TEXT = 'Legion fetches the asset itself, shows a card (what, from where, how big) for every download, keeps the files in a per-task folder outside your workspace, checks them against Poly Haven’s md5 and counts the run as outside content afterwards. Every source is off until you switch it on. No downloaded script is run. Powered by Poly Haven (polyhaven.com; the assets are CC0).';
