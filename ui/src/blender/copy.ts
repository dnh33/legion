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

/** The two honest "not yet tried" notes. Keep them until the real-VM and real-Blender runs are recorded in claude/tracker-pc-checks.md. */
export const NOT_TRIED_VM = 'Cloud VM: not yet tried on a real VM (Blender in the VM, rendering, file return).';
export const NOT_TRIED_LOCAL = 'Local mode: not yet tried with a real Blender on Windows.';

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
