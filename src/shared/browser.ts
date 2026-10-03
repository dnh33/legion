/**
 * Browser tool: types and limits shared by the core and the Settings panel. The built-in browser is a headless Chromium-family browser that is
 * already on the computer (Microsoft Edge, Google Chrome, Brave) driven by Legion's own CDP client. Plan: claude/plan-browser.md.
 */
export const BROWSER_SERVER_NAME = 'legion_browser';
export const BROWSER_TOOLS = ['browser_open', 'browser_text', 'browser_links', 'browser_click', 'browser_type', 'browser_eval', 'browser_close', 'browser_status'] as const;

export const BROWSER_LIMITS = {
  urlChars: 2048,
  textChars: 20_000,
  links: 100,
  linkChars: 300,
  evalExprChars: 2000,
  evalResultChars: 8000,
  typeChars: 2000,
  selectorChars: 300,
  titleChars: 200,
  maxRedirectHops: 10,
  navigationMs: 30_000,
  cdpCommandMs: 15_000,
  idleMs: 5 * 60_000,
  wallMs: 30 * 60_000,
  maxProcesses: 3,
  startTimeoutMs: 15_000,
  cdpMessageBytes: 4 * 1024 * 1024,
  outputBytes: 256 * 1024,
} as const;

/** Headless mode of the Chromium family needs this major version or newer (Chrome and Edge). TODO OWNER PC: BR15 confirms on the installed Edge. */
export const CHROMIUM_MIN_MAJOR = 109;

export interface BrowserConfig {
  version: 1;
  /** Off by default: no tools, no process. */
  enabled: boolean;
  /** A Chromium-family executable the owner chose (Edge, Chrome, Brave, Chromium). Unset: Legion looks in the usual places. */
  chromiumPath?: string;
  /** When non-empty, navigations (and observed redirects) outside these domains are refused. */
  allowDomains: string[];
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = { version: 1, enabled: false, allowDomains: [] };

/** A browser program found on this computer. */
export interface ChromiumFound { name: string; path: string; version?: string; tooOld?: boolean }

/** One entry per engine Legion ships. There is exactly one in this version; the interface exists so another can be added later. */
export interface EngineInfo { id: string; label: string }

export interface BrowserCheckResult {
  ok: boolean;
  at: string;
  /** "Microsoft Edge 120.0.2210.91 (headless)" when a browser ran. */
  browser?: string;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}

export interface BrowserStatusView {
  enabled: boolean;
  engines: EngineInfo[];
  /** The browser the next run will use, or null. */
  browser: ChromiumFound | null;
  /** The places looked in when none was found (shown so the owner can set a path). */
  tried: string[];
  /** Set when the owner chose a path (as opposed to automatic detection). */
  chosenPath?: string;
  allowDomains: string[];
  allowLocal: boolean;
  running: number;
  platform: string;
  /** The last time the browser ran for a task or for the check page. */
  lastRun?: { at: string; ok: boolean; browser: string; note: string };
  /** One plain line for Settings. */
  note: string;
}
