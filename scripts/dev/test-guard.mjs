// Guard for `npm test` and `npm run test:run`: the full suite runs on GitHub CI, not on a dev PC.
// Exit 0 when CI is truthy or LEGION_LOCAL_GATE=1. ci.yml calls `node --test` directly and sets CI, so it is unaffected.
// Single files are never guarded: node --test dist/test/<name>.test.js

const env = process.env;
const ci = env.CI !== undefined && env.CI.trim() !== '' && !/^(0|false|no|off)$/i.test(env.CI.trim());
if (ci || env.LEGION_LOCAL_GATE === '1') process.exit(0);

console.error([
  'The full test suite runs on GitHub CI: push your branch and open a PR.',
  'Run single files with: node --test dist/test/<name>.test.js',
  'To run the full suite here anyway, set LEGION_LOCAL_GATE=1:',
  '  sh:         LEGION_LOCAL_GATE=1 npm test',
  '  PowerShell: $env:LEGION_LOCAL_GATE=1; npm test',
].join('\n'));
process.exit(1);
