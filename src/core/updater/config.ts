/**
 * Constants of the update channel (plan: claude/plan-updater.md). Nothing here talks to the network; net.ts does, and only through
 * `validateUrl`. The source is fixed in code: no setting, environment variable or manifest field can point it elsewhere.
 * Tests build their own `UpdateSource` (loopback, http) and pass it to the module's constructor; production code never does.
 */
export interface NetPolicy {
  /** Hosts a request (and every redirect hop) may go to. */
  readonly hosts: readonly string[];
  /** Test-only: allow plain http, and any port, on a loopback host in `hosts`. The production policy is false. */
  readonly allowLoopbackHttp: boolean;
}
export interface UpdateSource { readonly base: string; readonly policy: NetPolicy }

export const UPDATE_REPO = Object.freeze({ owner: 'dnh33', repo: 'legion' });
/** github.com serves the release URL, then redirects to GitHub's release-asset hosts (objects.githubusercontent.com, and release-assets.githubusercontent.com since 2025). */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
export const PRODUCTION_SOURCE: UpdateSource = Object.freeze({
  base: `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`,
  policy: Object.freeze({ hosts: ALLOWED_HOSTS, allowLoopbackHttp: false }),
});

export const MANIFEST_NAME = 'legion-update-manifest.json';
export const SIG_NAME = 'legion-update-manifest.json.sig';
export const assetNameFor = (version: string): string => `legion-${version}-app.zip`;
export const manifestUrl = (s: UpdateSource): string => `${s.base}/releases/latest/download/${MANIFEST_NAME}`;
export const sigUrl = (s: UpdateSource): string => `${s.base}/releases/latest/download/${SIG_NAME}`;
/** `version` must already be a validated plain semver (manifest.ts); it is never taken from a redirect. */
export const assetUrl = (s: UpdateSource, version: string): string => `${s.base}/releases/download/v${version}/${assetNameFor(version)}`;

export const LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  sigBytes: 4 * 1024,
  packageBytes: 150 * 1024 * 1024,
  unpackedBytes: 400 * 1024 * 1024,
  entries: 20_000,
  relPathChars: 200,
  notesChars: 2000,
  maxRedirects: 3,
  requestTimeoutMs: 20_000,
  downloadTimeoutMs: 15 * 60_000,
});

export const DEFAULTS = Object.freeze({ checkEnabled: true, autoInstallWhenIdle: false, intervalHours: 12 });
/** How often the automatic poll runs, and the floor between two automatic attempts when no check has ever succeeded. */
export const POLL_MS = 60_000;
export const RETRY_MS = 15 * 60_000;

/** The core must be quiet this long, and must have been up this long, before an update is applied. */
export const QUIET_MS = 60_000;
export const BOOT_GRACE_MS = 60_000;
export const SAMPLE_MS = 5_000;
export const DRAIN_MS = 15_000;
export const FREEZE_MAX_MS = 60_000;
