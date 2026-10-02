/**
 * Pure view-model of the title-bar Blender chip: store state in, label / tone / title text out. No React, no store, no clock, so the table
 * test (test/blender-chip.test.ts) runs it as it is. Every word comes from real status; anything the core did not say is "Blender: unknown".
 */
import type { BlenderLight, BlenderStatusView } from '../../../src/shared/blender.js';

/** Label and tone for the status light (shared by the Ops card, Settings and the title-bar chip so they always say the same). */
export function lightLabel(l: BlenderStatusView['light']): { label: string; tone: 'on' | 'bad' | 'off' | 'warn' } {
  switch (l) {
    case 'connected': return { label: 'Connected', tone: 'on' };
    case 'sandbox': return { label: 'VM ready', tone: 'on' };
    case 'local': return { label: 'Local ready', tone: 'on' };
    case 'busy': return { label: 'Running a script', tone: 'warn' };
    case 'disconnected': return { label: 'Not listening', tone: 'warn' };
    case 'needs-setup': return { label: 'Needs setup', tone: 'warn' };
    case 'not-found': return { label: 'Not found', tone: 'bad' };
    case 'error': return { label: 'Problem', tone: 'bad' };
    default: return { label: 'Off', tone: 'off' };
  }
}

export const BLENDER_CHIP_TIP = 'Blender scripts run on this computer with your rights; every script needs your OK';
export const BLENDER_UNKNOWN = 'Blender: unknown';

export type ChipTone = 'off' | 'on' | 'warn' | 'bad' | 'unknown';
export interface ChipInput {
  status: Pick<BlenderStatusView, 'enabled' | 'light' | 'selected'> | null;
  /** The first answer has arrived. */
  loaded: boolean;
  /** The last status request failed. */
  failed: boolean;
  /** The core answered 404: it has no Blender module (an older core). */
  absent: boolean;
  /** An action (config, setup, ...) is running. */
  busy: boolean;
}
export interface ChipModel {
  /** False: render nothing (older core without the Blender module). */
  visible: boolean;
  tone: ChipTone;
  /** What the switch says: the saved enabled flag, or false while unknown. */
  enabled: boolean;
  /** The full status sentence (tooltip and screen readers). */
  label: string;
  /** The button in the popover; it only opens Settings at the Blender section (it never downloads). */
  settingsText: string;
  /** What that button is for. */
  action: 'settings' | 'get' | 'setup';
  /** The pill's accessible name. */
  actionLabel: string;
  title: string;
  switchDisabled: boolean;
  /** True when a change of this state is worth saying out loud (not a script starting, not "unknown"). */
  announce: boolean;
}

const KNOWN: ReadonlySet<string> = new Set<BlenderLight>(['off', 'not-found', 'needs-setup', 'disconnected', 'connected', 'sandbox', 'local', 'busy', 'error']);

export function chipModel(i: ChipInput): ChipModel {
  const unknown = (): ChipModel => ({
    visible: true, tone: 'unknown', enabled: false, label: BLENDER_UNKNOWN, settingsText: 'Open Blender settings', action: 'settings',
    actionLabel: `${BLENDER_UNKNOWN}. Blender menu`, title: `${BLENDER_UNKNOWN}. ${BLENDER_CHIP_TIP}`, switchDisabled: true, announce: false,
  });
  if (i.absent) return { ...unknown(), visible: false };
  const st = i.status;
  if (!st || i.failed || typeof st.enabled !== 'boolean' || !KNOWN.has(st.light)) return unknown();
  // an off bridge says Off whatever the light says
  const light: BlenderLight = st.enabled ? st.light : 'off';
  const ver = st.selected?.version ? `, Blender ${st.selected.version}` : '';
  let label: string; let action: ChipModel['action'] = 'settings';
  switch (light) {
    case 'off': label = 'Blender: Off'; break;
    case 'not-found': label = 'Blender not found'; action = 'get'; break;
    case 'local': label = `Ready: this computer${ver}`; break;
    case 'sandbox': label = 'Ready: cloud VM'; break;
    case 'connected': label = 'Live Blender connected'; break;
    case 'needs-setup': label = 'Blender needs setup'; action = 'setup'; break;
    case 'busy': label = 'Blender is running a script'; break;
    case 'disconnected': label = 'Blender is not listening'; break;
    default: label = 'Blender has a problem'; break;
  }
  const tone: ChipTone = light === 'off' ? 'off' : lightLabel(light).tone === 'on' ? 'on' : lightLabel(light).tone === 'bad' ? 'bad' : 'warn';
  return {
    visible: true, tone, enabled: st.enabled, label, settingsText: action === 'get' ? 'Get Blender' : action === 'setup' ? 'Set up in Settings' : 'Open Blender settings', action, actionLabel: `${label}. Blender menu`, title: `${label}. ${BLENDER_CHIP_TIP}`,
    switchDisabled: i.busy || !i.loaded, announce: light !== 'busy',
  };
}
