// test/consequence-attacks.test.ts: security fix 1. The 0.3.5 review attacks on the shell classifier (B-H1, C-H1) all card in Smart,
// and the plain forms the owner relies on still run. Judged by the same functions the engine uses: classifySafe, then needsApproval('smart').
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySafe } from '../src/shared/consequence.js';
import { needsApproval } from '../src/core/approvals.js';

const FOLDERS = ['D:/work/shop'];
const HOME = 'C:/Users/me';
const judge = (command: string, tool = 'Bash', folders: string[] = FOLDERS) => classifySafe({ kind: 'approval', toolName: tool, input: { command }, projectFolders: folders, home: HOME });
const smartCards = (command: string, tool = 'Bash', folders: string[] = FOLDERS): boolean => needsApproval('smart', tool, { consequence: judge(command, tool, folders) });

/* ---------- B-H1: a local build or test command cannot run code from outside the project or load a program by a flag ---------- */

const NODE_ATTACKS = [
  'node --test --import=data:text/javascript,console.log(1) a.test.js',
  'node --test --import "data:text/javascript,console.log(1)" a.test.js',
  'node --test --import data:text/javascript,console.log(1)',
  'node --test -r ./x.cjs',
  'node --test -r./x.cjs',
  'node --test --require /tmp/x.js',
  'node --test --require=/tmp/x.js',
  'node --test --experimental-loader data:abc',
  'node --test --experimental-loader=data:abc',
  'node --test --loader ./l.mjs',
  'node --test --env-file=.env',
  'node --test --env-file .env',
  'node --test --inspect',
  'node --test --inspect-brk=9229',
  'node --test -C dev',
  'node --test --conditions=x',
  'node --test -e 1',
  'node --test -p 1',
  'node --test --eval 1',
  'node --test --test-reporter=./evil.js',
  'node --test --test-reporter ./evil.js',
  'node --test --test-reporter-destination=/tmp/o',
  'node --test --test-timeout=abc',
  'node --test --test-concurrency',
  'node --test /tmp/evil.test.js',
  'node --test ../evil.test.js',
  'node --test ~/evil.test.js',
  'node --test C:/other/evil.test.js',
  'node --test --node-options=--require=/tmp/x.js',
  'node --test -- --import=x',
];
const PKG_ATTACKS = [
  'npm test --prefix=/tmp/evil', 'npm test --prefix /tmp/evil', 'pnpm test --dir /tmp/evil', 'pnpm test -C /tmp/evil', 'yarn test --cwd /tmp/evil',
  'npm test --workspace=a', 'npm test -w a', 'npm test -- --watch', 'npm test extra', 'yarn test --silent --cwd /tmp/evil', 'npm --prefix /tmp/evil test', 'yarn --cwd /tmp/evil test',
];
const TOOL_ATTACKS = [
  'cargo test --manifest-path /tmp/evil/Cargo.toml', 'cargo build --manifest-path=/tmp/evil/Cargo.toml', 'cargo check -Zunstable-options', 'cargo test -C /tmp/evil',
  'cargo test --config build.rustc=\'x\'', 'cargo test --target-dir /tmp/t', 'cargo build --target-dir=/tmp/t', 'cargo test /tmp/evil',
  'go test -C /tmp/evil ./...', 'go test -overlay=/tmp/o.json ./...', 'go build -modfile=/tmp/go.mod', 'go test -ldflags=-X', 'go build -gcflags=all=-N', 'go build -asmflags=-x',
  'go test -toolexec /tmp/x ./...', 'go test -exec /tmp/x ./...', 'go test /tmp/evil', 'go test -coverprofile=/tmp/c.out ./...', 'go build -o /tmp/app ./...',
  'pytest -o addopts="-p evil"', 'pytest -o addopts=-pevil', 'pytest --override-ini=addopts=-pevil', 'pytest -c /tmp/evil.ini', 'pytest --rootdir=/tmp/evil', 'pytest --rootdir /tmp/evil',
  'pytest --confcutdir=/tmp/evil', 'pytest -p evil', 'pytest --pyargs evil', 'pytest /tmp/evil/test_x.py', 'pytest ../evil', 'pytest --junitxml=/tmp/x.xml',
];
test('B-H1: every node, npm, pnpm, yarn, cargo, go and pytest attack is level 3 and cards in Smart', () => {
  for (const cmd of [...NODE_ATTACKS, ...PKG_ATTACKS, ...TOOL_ATTACKS]) {
    assert.equal(judge(cmd).level, 3, cmd);
    assert.equal(smartCards(cmd), true, cmd);
  }
});
test('B-H1: with no project folders known, a path word cannot be placed and cards', () => {
  assert.equal(smartCards('node --test dist/test/a.test.js', 'Bash', []), true);
  assert.equal(smartCards('pytest tests/', 'Bash', []), true);
  assert.equal(smartCards('node --test', 'Bash', []), false);
  assert.equal(smartCards('npm test', 'Bash', []), false);
});
test('B-H1: a build or test command after a cd away from the project cards; a cd inside it does not', () => {
  assert.equal(smartCards('cd /tmp/evil && npm test'), true);
  assert.equal(smartCards('cd ../evil && npm test'), true);
  assert.equal(smartCards('cd && npm test'), true);
  assert.equal(smartCards('cd D:/other && cargo build'), true);
  assert.equal(smartCards('cd src && npm test'), false);
  assert.equal(smartCards('cd D:/work/shop/web && npm run build'), false);
});
test('B-H1: the one-word and two-word spellings of a flag classify the same', () => {
  for (const [one, two] of [['node --test --import=x', 'node --test --import x'], ['node --test --require=x', 'node --test --require x'], ['node --test --test-reporter=spec', 'node --test --test-reporter spec'],
    ['pytest --rootdir=/x', 'pytest --rootdir /x'], ['go test -overlay=/o', 'go test -overlay /o'], ['cargo test --manifest-path=/m', 'cargo test --manifest-path /m']]) {
    assert.equal(judge(one).level, judge(two).level, `${one} / ${two}`);
  }
});

const SAFE_LOCAL = [
  'npm test', 'npm test --silent', 'npm test --quiet', 'pnpm test', 'yarn test', 'npm run test', 'npm run build', 'npm run lint', 'npm run typecheck', 'npm run check', 'npm run format',
  'node --test dist/test/a.test.js', 'node --test', 'node --test dist/test/a.test.js dist/test/b.test.js', 'node --test --test-name-pattern=login dist/test/a.test.js',
  'node --test --test-name-pattern "login ok" dist/test/a.test.js', 'node --test --test-reporter=spec', 'node --test --test-reporter dot dist/test/a.test.js', 'node --test --test-only',
  'node --test --test-concurrency=2 --test-timeout=30000 dist/test', 'node --test D:/work/shop/dist/test/a.test.js', 'node --test "dist/test/*.test.js"',
  'pytest', 'pytest -q tests/', 'pytest -x -k "a or b" tests/test_a.py::TestX::test_y', 'cargo test', 'cargo build', 'cargo check', 'cargo test -p core --release', 'cargo test --target-dir target',
  'go test ./...', 'go test -count=1 -run TestX ./pkg/...', 'go build ./...', 'go build -o bin/app ./cmd', 'go vet ./...', 'npx tsc --noEmit',
];
test('B-H1: the plain local build and test forms stay level 1 runs-code and do not card in Smart', () => {
  for (const cmd of SAFE_LOCAL) {
    const c = judge(cmd);
    assert.equal(c.level, 1, `${cmd} -> level ${c.level}`);
    assert.ok(c.tags.includes('runs-code'), cmd);
    assert.equal(smartCards(cmd), false, cmd);
  }
});

/* ---------- C-H1: a write by redirect or by a writing program is judged by where it lands ---------- */

const OUTSIDE_WRITES = [
  // the review's Smart list: Legion's program, launcher, login-start places, notes outside the project
  "echo x >> '/home/me/.local/share/legion/dist/src/electron/main.js'",
  'echo x >> /home/me/.local/share/legion/dist/src/electron/main.js',
  'echo x > /home/me/.local/share/legion/dist/src/electron/main.js',
  "echo 'node evil.js' >> ~/.local/bin/legion",
  'echo x > "C:/Users/me/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.cmd"',
  'echo x > C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd',
  'echo x > ~/Library/LaunchAgents/x.plist',
  'echo x > ~/.config/autostart/x.desktop',
  'echo x > ~/.config/systemd/user/x.service',
  'echo x > /home/me/.local/share/legion/node_modules/electron/index.js',
  'echo x > /home/me/.local/share/legion/.update/journal.json',
  'echo x >> ~/Documents/notes.txt',
  'printf x | tee -a /home/me/.local/share/legion/dist/src/electron/main.js',
  'printf x | tee -a ~/Documents/notes.txt',
  'cp a.js /home/me/.local/share/legion/dist/src/electron/main.js',
  // redirect spellings and targets the check cannot read
  'echo x >/tmp/a', 'echo x>/tmp/a', 'echo x 1>/tmp/a', 'echo x >| /tmp/a', 'echo x > ../a', 'echo x > sub/../../a', 'echo x > *.js', 'echo x > a?', 'echo x > ~other/a', 'echo x > ~', 'echo x > %TEMP%\\a', 'echo x > C:a', 'echo x > ""',
  'echo x > a.txt && echo y > /tmp/b', 'cat a > out.txt; cat b > /tmp/c', 'ls 2>/tmp/err', 'echo x > /dev/tty',
  // programs that write a file
  'tee /tmp/a', 'tee out.txt /tmp/a', 'cp a /tmp/b', 'cp -f a /tmp/b', 'cp -t /tmp a b', 'cp -rt /tmp a', 'cp --target-directory=/tmp a', 'cp --target-directory /tmp a', 'cp --target-dir /tmp a',
  'mv a /tmp/b', 'mv /tmp/a b', 'mv -t /tmp a', 'sort -o /tmp/x in', 'sort --output=/tmp/x in', 'sort -ro /tmp/x in', 'tree -o /tmp/x', 'git diff --output=/tmp/x', 'git log --output /tmp/x',
  'uniq in /tmp/out', 'find . -fprint /tmp/x', 'find . -fls /tmp/x', 'mkdir /tmp/x', 'touch /tmp/x', 'touch a /tmp/b', 'chmod +x /tmp/x',
  // cd away, then a plain relative target is not in the project
  'cd /tmp && echo x > a', 'cd .. && echo x > a', 'cd && echo x > a', 'cd ~ && touch a', 'pushd /tmp && echo x > a', 'cd D:/other && cp a b',
];
const OUTSIDE_PWSH = [
  'Set-Content -Path C:\\Users\\me\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1 -Value x',
  'Set-Content C:\\Users\\me\\Documents\\WindowsPowerShell\\profile.ps1 x',
  'Set-Content -Value x C:\\evil\\p.ps1', 'Add-Content -Value x -Path C:\\evil\\p.ps1', 'Add-Content -LiteralPath:C:\\evil\\p.ps1 -Value x', 'Out-File -FilePath C:\\evil\\p.ps1', 'Out-File C:\\evil\\p.ps1 -Append',
  'Copy-Item a.js C:\\evil\\b.js -Force', 'Copy-Item -Path a.js -Destination C:\\evil\\b.js', 'Copy-Item -Path a.js -Destination:C:\\evil\\b.js', 'Copy-Item a.js C:\\evil -Filter x',
  'Move-Item a.js C:\\evil', 'Move-Item -Path a.js -Destination C:\\evil', 'copy a.js C:\\evil\\b.js', 'cp a.js C:\\evil\\b.js', 'move a.js C:\\evil', 'New-Item -ItemType File -Path C:\\evil\\x',
  'Rename-Item C:\\evil\\a b', 'ren C:\\evil\\a b', 'echo x > C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd',
];
test('C-H1: a write outside the project, or to a place that cannot be read, is level 3 editsOutside and cards in Smart', () => {
  for (const cmd of OUTSIDE_WRITES) {
    const c = judge(cmd);
    assert.equal(c.level, 3, cmd);
    assert.ok(c.tags.includes('edits'), cmd);
    assert.equal(smartCards(cmd), true, cmd);
  }
  for (const cmd of OUTSIDE_PWSH) {
    assert.equal(judge(cmd, 'PowerShell').level, 3, cmd);
    assert.equal(smartCards(cmd, 'PowerShell'), true, cmd);
  }
});
test('C-H1: the chip for an outside write is the one the Write tool shows, and it is not certain', () => {
  const w = classifySafe({ kind: 'approval', toolName: 'Write', input: { file_path: '/tmp/x', content: 'x' }, projectFolders: FOLDERS });
  const c = judge('echo x > /tmp/a');
  assert.equal(c.chip, w.chip);
  assert.equal(c.certain, false);
});
test('C-H1: with no project folders known a write cannot be placed: level 3, as the Write tool', () => {
  for (const cmd of ['echo x > out.txt', 'tee out.txt', 'cp a b', 'mkdir out', 'touch a']) assert.equal(judge(cmd, 'Bash', []).level, 3, cmd);
  assert.equal(judge('echo x > /dev/null', 'Bash', []).level, 1);
});
test('C-H1: without a home folder a ~ target counts as outside; with one it is placed', () => {
  const noHome = classifySafe({ kind: 'approval', toolName: 'Bash', input: { command: 'echo x > ~/shop/a.txt' }, projectFolders: ['C:/Users/me/shop'] });
  assert.equal(noHome.level, 3);
  const withHome = classifySafe({ kind: 'approval', toolName: 'Bash', input: { command: 'echo x > ~/shop/a.txt' }, projectFolders: ['C:/Users/me/shop'], home: HOME });
  assert.equal(withHome.level, 2);
});

const INSIDE_WRITES = [
  'echo x > notes.txt', 'echo x > out.txt', 'echo x >> log/out.txt', 'echo x > ./out.txt', 'echo hi > D:/work/shop/out.txt', 'echo hi > D:\\work\\shop\\out.txt', 'printf x | tee out.txt', 'tee -a out.txt',
  'cp a b', 'cp -r src dist', 'cp -t out a b', 'cp --target-directory=out a', 'mv a b', 'mkdir out', 'mkdir -p a/b', 'touch a', 'chmod +x run.sh', 'sort -o out in', 'git diff --output=d.patch',
  'cat a > out.txt 2>&1', 'cat a 2>/dev/null > out.txt', 'cd src && echo x > a', 'cd D:/work/shop/web && touch a', 'echo x > a.txt && echo y > b.txt',
];
test('C-H1: a write inside the project stays level 2 edits and does not card in Smart', () => {
  for (const cmd of INSIDE_WRITES) {
    const c = judge(cmd);
    assert.equal(c.level, 2, `${cmd} -> ${c.level}`);
    assert.equal(smartCards(cmd), false, cmd);
  }
  for (const cmd of ['Set-Content out.txt -Value hi', 'Add-Content log.txt x', 'Out-File out.txt', 'Copy-Item a.js b.js', 'Move-Item a.js b.js', 'copy a.js b.js', 'New-Item -ItemType Directory -Path out']) {
    assert.equal(judge(cmd, 'PowerShell').level, 2, cmd);
    assert.equal(smartCards(cmd, 'PowerShell'), false, cmd);
  }
});
test('C-H1: null sinks and stream redirects add nothing', () => {
  for (const cmd of ['ls > /dev/null', 'ls >/dev/null', 'ls 2>/dev/null', 'ls > NUL', 'ls > nul', 'ls 2>&1', 'ls >/dev/null 2>&1', 'ls &>/dev/null', 'echo x > /dev/stderr', 'echo x 1>&2']) {
    const c = judge(cmd);
    assert.equal(c.level, 1, cmd);
    assert.equal(c.certain, true, cmd);
    assert.equal(smartCards(cmd), false, cmd);
  }
  assert.equal(judge('ls', 'Bash', []).level, 1);
});
test('C-H1: a stream number before > is not a word of the command', () => {
  assert.equal(judge('cp a b 2>&1').level, 2);
  assert.equal(judge('cp a /tmp/b 2>/dev/null').level, 3);
  assert.equal(judge('cp a b 2>/dev/null').level, 2);
});
