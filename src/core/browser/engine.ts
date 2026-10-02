/**
 * The small engine interface: an engine knows its id and label, how to find its program on this computer, and how to start it. Exactly one engine
 * ships (the Chromium family, chromium.ts + launcher.ts); the interface keeps a later engine from touching the session, the tools or the guards.
 */
import type { ChromiumFound, EngineInfo } from '../../shared/browser.js';
import type { LaunchPorts, RunningBrowser } from './launcher.js';

export interface LaunchOptions { allowLocal: boolean; startMs?: number; label?: string }

export interface BrowserEngineDef extends EngineInfo {
  /** Finds the program without running it. `tried` lists the places looked at. */
  detect(): { found: ChromiumFound | null; tried: string[] };
  /** Starts it; stopping goes through RunningBrowser.stop(). */
  launch(ports: LaunchPorts, found: ChromiumFound, opts: LaunchOptions): Promise<RunningBrowser>;
}
