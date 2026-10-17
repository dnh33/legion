/** Words the update panel shows that depend on the system or the install kind. Pure, so tests can read them. Mirrors src/core/updater (deps-change.ts, index.ts). */

/** A hand-made git clone: Legion runs none of these steps. */
export const CHECKOUT_TEXT = 'This is a git checkout. Update it yourself: git fetch --tags, check out the new tag, then npm ci and npm run build.';

const UNIX_DEPS = "This update changes Legion's dependencies. On Mac and Linux, close Legion, then run the installer again: curl -fsSL https://getlegion.xyz | sh (your data in ~/.legion stays).";
const WIN_DEPS = 'This release changes dependencies, so it cannot be installed from inside Legion. Download the source of the release and run setup.cmd, as for a first install.';
/** A release that changes dependencies and cannot be applied here. Mac and Linux re-run the installer; Windows keeps its setup.cmd line. */
/** `coreText` is the words the core sends in the status; it carries --dir when this install is not in the installer's default folder. */
export const depsNotifyText = (platform: string | undefined, coreText?: string): string => (platform === undefined || platform === 'win32' ? WIN_DEPS : coreText || UNIX_DEPS);

/** Off Windows there is no update window: the app just closes and reopens. Undefined on Windows, which shows its window. */
export const closeAndReopenText = (platform: string | undefined): string | undefined =>
  platform === undefined || platform === 'win32' ? undefined : 'Legion will close and reopen to finish the update. There is no update window on this system.';
