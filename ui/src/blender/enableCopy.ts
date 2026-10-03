/** Text of the "Turn on Blender?" dialog (no imports, so the tests read it as it is). */
/** The confirmation before Blender is turned ON (chip and Settings use the same dialog). Turning it off asks nothing. */
export const ENABLE_TITLE = 'Turn on Blender?';
export const ENABLE_TEXT =
  'Blender scripts run on this computer with your Windows user’s rights, in a background Blender. Legion checks a script before it runs, but that check is a filter, not a sandbox, so read each script. Every script still needs your OK on its own card. A cloud VM is the isolated option.';
export const ENABLE_CONFIRM = 'Turn on Blender';
