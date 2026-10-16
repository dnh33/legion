import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySafe } from '../src/shared/consequence.js';
import { needsApproval } from '../src/core/approvals.js';

// [command, smart asks?]  Smart cards exactly level 3 (spec 4.3). 40 rows: the copy on the Gates page matches this table.
const ROWS: Array<[string, boolean]> = [
  ['npm test', false], ['npm run test', false], ['npm run build', false], ['npm run lint', false], ['npm run typecheck', false],
  ['npm run check', false], ['npm run format', false], ['pnpm test', false], ['pnpm run build', false], ['yarn test', false],
  ['yarn run lint', false], ['npx tsc --noEmit', false], ['node --test dist/test/a.test.js', false], ['pytest', false], ['pytest -q tests/', false],
  ['cargo test', false], ['cargo build', false], ['cargo check', false], ['go test ./...', false], ['go build ./...', false],
  ['go vet ./...', false], ['git status', false], ['git diff', false], ['git add -A', false], ['git commit -m x', false],
  ['ls -la', false], ['cat package.json', false], ['rg foo src', false], ['mkdir out', false], ['cp a b', false],
  ['npm install', true], ['npm publish', true], ['npm run deploy', true], ['npm run dev', true], ['npx tsc', true],
  ['npx rimraf dist', true], ['node script.js', true], ['rm -rf dist', true], ['git push', true], ['cargo publish', true],
];
test('the list has 40 rows', () => assert.equal(ROWS.length, 40));
for (const [command, asks] of ROWS) {
  test(`smart ${asks ? 'asks' : 'runs'}: ${command}`, () => {
    const c = classifySafe({ kind: 'approval', toolName: 'Bash', input: { command }, projectFolders: ['C:/p'] });
    assert.equal(needsApproval('smart', 'Bash', { consequence: c }), asks, `${command} -> level ${c.level}`);
  });
}
test('a program run twice in one line takes the worst level', () => {
  assert.equal(classifySafe({ kind: 'approval', toolName: 'Bash', input: { command: 'npm test && rm -rf dist' } }).level, 3);
});
test('npm run with a script not on the list stays level 3, with flags too', () => {
  for (const command of ['npm run test:e2e', 'npm run build --if-present --foo', 'npm run', 'npm run ../x']) {
    assert.equal(classifySafe({ kind: 'approval', toolName: 'Bash', input: { command } }).level, 3, command);
  }
});
test('the local-run commands carry the plain chip', () => {
  assert.equal(classifySafe({ kind: 'approval', toolName: 'Bash', input: { command: 'npm test' } }).chip, 'Runs a check on your computer');
});
test('flags that run another program make the call unknown (level 3), per tool family', () => {
  const cmds = [
    'go test -exec ./x ./...', 'go test -exec=./x ./...', 'go build -toolexec ./x ./...', 'go vet -vettool=./x ./...', 'go vet -vettool ./x ./...',
    'cargo test --config build.rustc-wrapper="x"', 'cargo build --config=x', 'cargo check -Zunstable-options',
    'npm test --script-shell ./x', 'npm run build --script-shell=./x', 'pnpm test --script-shell ./x', 'yarn test --script-shell=./x',
    'npm test --node-options=--require=./x', 'node --node-options=--require=./x --test a.js', 'NODE_OPTIONS=--require=./x npm test',
  ];
  for (const command of cmds) assert.equal(classifySafe({ kind: 'approval', toolName: 'Bash', input: { command } }).level, 3, command);
});
