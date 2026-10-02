/**
 * The environment the harness gives the core process: an ALLOWLIST, not "everything except known secrets". Whatever else is in the caller's
 * environment (cloud tokens, CI secrets, API keys) never reaches the core. Windows needs its standard variables or Node and child lookups break.
 */
const ALLOWED = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS',
  // Windows standard variables the OS injects
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'CommonProgramW6432', 'ALLUSERSPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
];

/** @param {Record<string,string|undefined>} source @param {Record<string,string>} extra  LEGION_* values the harness sets itself */
export function coreEnv(source, extra) {
  const env = {};
  const upper = new Set(ALLOWED.map((k) => k.toUpperCase()));
  for (const [k, v] of Object.entries(source)) if (v !== undefined && upper.has(k.toUpperCase())) env[k] = v;
  return { ...env, ...extra };
}
