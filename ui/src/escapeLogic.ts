/** What Esc should close, topmost first. The palette sits above everything, so it closes alone: a dialog under it stays open. */
export interface EscapeFacts { palette: boolean; doctorOpen: boolean; settingsOpen: boolean; dialogOpen: boolean; inField: boolean }
export type EscapeAction = 'palette' | 'overlays' | 'settings' | null;

export function escapeAction(f: EscapeFacts): EscapeAction {
  if (f.palette) return 'palette';
  if (f.doctorOpen) return 'overlays';
  if (f.settingsOpen && !f.dialogOpen && !f.inField) return 'settings';
  return null;
}
