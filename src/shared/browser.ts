/**
 * Browser tool (Lightpanda): types, limits and the download pin, shared by the core and the Settings panel.
 * Plan: claude/plan-browser.md. Lightpanda is a separate AGPL-3.0 program; Legion never bundles it.
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
  startTimeoutMs: 8000,
  cdpMessageBytes: 4 * 1024 * 1024,
  /** Passed to the browser as its own limits (plan section 1). */
  responseBytes: 8 * 1024 * 1024,
  v8HeapMb: 256,
  watchdogMs: 60_000,
  outputBytes: 256 * 1024,
} as const;

export interface BrowserConfig {
  version: 1;
  /** Off by default: no tools, no process. */
  enabled: boolean;
  /** An executable the owner chose (a path, or the launcher file such as wsl.exe). */
  binaryPath?: string;
  /** Leading arguments after `binaryPath`, e.g. ['-d','Ubuntu','-e','/home/me/lightpanda'] for WSL. */
  launcherArgs?: string[];
  /** When non-empty, navigations (and observed redirects) outside these domains are refused. */
  allowDomains: string[];
  /** Hash for the managed download when the pin in code has none (owner-recorded). */
  managedSha256?: string;
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = { version: 1, enabled: false, allowDomains: [] };

export interface BrowserPin {
  id: string;
  /** process.platform + arch the asset is for, e.g. 'linux-x64'. */
  platform: string;
  url: string;
  /** Empty until the owner records a hash: with no hash Legion downloads nothing. */
  sha256: string;
  approxBytes: number;
  maxBytes: number;
  exe: string;
  license: string;
  sourceUrl: string;
}

/** TODO OWNER PC: the only release found is the rolling `nightly` tag, which has no stable hash. The hash stays empty until the owner picks a build. */
export const BROWSER_PINS: BrowserPin[] = [
  { id: 'nightly-linux-x64', platform: 'linux-x64', url: 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux', sha256: '', approxBytes: 100 * 1024 * 1024, maxBytes: 200 * 1024 * 1024, exe: 'lightpanda', license: 'AGPL-3.0', sourceUrl: 'https://github.com/lightpanda-io/browser' },
  { id: 'nightly-linux-arm64', platform: 'linux-arm64', url: 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-linux', sha256: '', approxBytes: 100 * 1024 * 1024, maxBytes: 200 * 1024 * 1024, exe: 'lightpanda', license: 'AGPL-3.0', sourceUrl: 'https://github.com/lightpanda-io/browser' },
  { id: 'nightly-macos-arm64', platform: 'darwin-arm64', url: 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-macos', sha256: '', approxBytes: 100 * 1024 * 1024, maxBytes: 200 * 1024 * 1024, exe: 'lightpanda', license: 'AGPL-3.0', sourceUrl: 'https://github.com/lightpanda-io/browser' },
  { id: 'nightly-macos-x64', platform: 'darwin-x64', url: 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-macos', sha256: '', approxBytes: 100 * 1024 * 1024, maxBytes: 200 * 1024 * 1024, exe: 'lightpanda', license: 'AGPL-3.0', sourceUrl: 'https://github.com/lightpanda-io/browser' },
];

export interface BrowserStatusView {
  enabled: boolean;
  /** 'managed' | 'own' | 'none' */
  binary: 'managed' | 'own' | 'none';
  binaryPath?: string;
  platform: string;
  /** Windows: Lightpanda has no native build; it runs inside WSL through a launcher. */
  needsLauncher: boolean;
  allowDomains: string[];
  allowLocal: boolean;
  running: number;
  getting: boolean;
  pin: { id: string; url: string; sha256Known: boolean; license: string; approxMb: number } | null;
  note: string;
}
