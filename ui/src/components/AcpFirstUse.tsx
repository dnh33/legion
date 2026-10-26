import { useEffect, useRef } from 'react';
import { FIRST_USE, HERMES_NOTE, HERMES_READS } from '../../../src/shared/acp-copy';
import { loadSettings, saveSettings, useStore } from '../store';

/** The first time Hermes is picked: what it does, and a way out. Skippable; shown once. Focus lands on the first button, so a keyboard user is not left behind. */
export function AcpFirstUseView({ onUse, onNotNow }: { onUse: () => void; onNotNow: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <div className="acp-first" role="group" aria-label={FIRST_USE.title}>
      <b>{FIRST_USE.title}</b>
      <p>{HERMES_NOTE} {HERMES_READS}</p>
      <div className="acp-first-actions">
        <button ref={first} type="button" className="btn primary" onClick={onUse}>{FIRST_USE.use}</button>
        <button type="button" className="btn" onClick={onNotNow}>{FIRST_USE.notNow}</button>
      </div>
    </div>
  );
}

/** Whether the owner has met the card, and the way to record it. Settings are loaded on first use when the window has not read them yet. */
export function useFirstUse(): { seen: boolean; markSeen: () => Promise<void> } {
  const settings = useStore((s) => s.settings);
  useEffect(() => { if (!settings) void loadSettings(); }, [settings]);
  return {
    seen: settings?.acp.firstUseSeen === true,
    markSeen: async () => { try { await saveSettings({ acp: { firstUseSeen: true } }, true); } catch { /* the card may show once more: harmless */ } },
  };
}
