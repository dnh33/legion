import { useEffect } from 'react';
import { loadSettings, useStore } from '../store';

/**
 * Settings, Agent hosts, "Match Legion's mode". `undefined` until the settings are read: a screen that talks about it shows nothing for Hermes then, not a guess.
 * The settings load once at start (store.ts init); a screen that finds them missing (the core was away at start) asks again.
 */
export function useModeMap(): boolean | undefined {
  const known = useStore((s) => s.settings !== null && s.settings !== undefined);
  const on = useStore((s) => s.settings?.acp?.switches?.modeMap === true);
  useEffect(() => { if (!known) void loadSettings(true); }, [known]);
  return known ? on : undefined;
}
