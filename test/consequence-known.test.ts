// test/consequence-known.test.ts: security fix 4. Smart stops asking about common harmless commands (sed as a viewer, jq, text filters, wrappers,
// git reads, build scripts), and every dangerous variant of each stays carded. Judged the way the engine does: classifySafe, then needsApproval('smart');
// the secret-read check is secretReadHit, the one the engine uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySafe } from '../src/shared/consequence.js';
import { unwrapAll, unwrapCommand } from '../src/shared/shell-wrappers.js';
import { needsApproval } from '../src/core/approvals.js';
import { secretReadHit } from '../src/core/secret-paths.js';

const FOLDERS = ['D:/work/shop'];
const HOME = 'C:/Users/me';
const judge = (command: string, tool = 'Bash') => classifySafe({ kind: 'approval', toolName: tool, input: { command }, projectFolders: FOLDERS, home: HOME });
const cards = (command: string, tool = 'Bash'): boolean => needsApproval('smart', tool, { consequence: judge(command, tool) });
const quiet = (list: string[], tool = 'Bash'): void => { for (const c of list) assert.equal(cards(c, tool), false, `should not card: ${c} (${JSON.stringify(judge(c, tool))})`); };
const carded = (list: string[], tool = 'Bash'): void => { for (const c of list) assert.equal(cards(c, tool), true, `must card: ${c} (${JSON.stringify(judge(c, tool))})`); };
const unknown = (list: string[], tool = 'Bash'): void => { for (const c of list) assert.ok(judge(c, tool).tags.includes('unknown'), `must be unknown: ${c} (${JSON.stringify(judge(c, tool))})`); };

/* ---------- sed ---------- */

const SED_KNOWN = [
  'sed -n 1,5p src/a.ts', "sed -n '10,20p' src/a.ts", "sed -n '/foo/p' a.ts", "sed -n '$p' a.ts", "sed -n '2~3p' a.ts", "sed -n '1,+3p' a.ts", "sed -n '1,~4p' a.ts",
  "sed -n '/a/,/b/p' a.ts", "sed -n '/a/,/b/{p}' a.ts", "sed -n '1p;5p' a.ts", "sed -n -e '1p' -e '3p' a.ts", "sed -n --expression=1p a.ts", 'sed --quiet --expression 1p a.ts',
  "sed -E 's/a(b)/\\1/g' a.ts", "sed -E -n 's/x/y/gp' a.ts", "sed 's/a/b/' a.ts", "sed 's|a/b|c|g' a.ts", "sed 's,a,b,2' a.ts", "sed 's/a/b/I' a.ts", "sed 's/a/b/;s/c/d/' a.ts",
  "sed '1d' a.ts", "sed '/^$/d' a.ts", "sed '$!d' a.ts", "sed -n '1!p' a.ts", "sed -n '\\,a,p' a.ts", "sed -n '/a/I p' a.ts", 'sed 5q a.ts', 'sed -n 5q a.ts', "sed 'y/abc/xyz/' a.ts",
  "sed -n '=' a.ts", "sed -n 'l' a.ts", "sed 'n;d' a.ts", "sed -s -n 1p a.ts b.ts", "sed -n '/[0-9]/p' a.ts", "sed -n '/[[:alpha:]]x/p' a.ts", "sed 's/[a]x//' a.ts",
  "grep foo a.ts | sed -n 1,3p", "sed -n 1,5p a.ts | head -3", "sed -n 1,5p a.ts 2>&1", "sed -n 1,5p a.ts > out.txt",
];
const SED_DANGEROUS = [
  // edits in place, in every spelling
  "sed -i 's/a/b/' a.ts", "sed -i.bak 's/a/b/' a.ts", "sed -i'' 's/a/b/' a.ts", 'sed --in-place s/a/b/ a.ts', "sed --in-place=.bak 's/a/b/' a.ts", "sed -ni 's/a/b/p' a.ts", "sed -Ei 's/a/b/' a.ts", "sed -ie 's/a/b/' a.ts",
  // reads or writes another file, runs a program
  "sed -n 'w out.txt' a.ts", "sed -n '1w out.txt' a.ts", "sed -n 'W out.txt' a.ts", "sed 's/a/b/w out.txt' a.ts", "sed 's/a/b/gw out.txt' a.ts", "sed 's/a/b/;w out.txt' a.ts", "sed -n '/a/{w out.txt}' a.ts",
  "sed '$!{w out.txt}' a.ts", "sed -n 'w/tmp/x' a.ts", "sed 'r secret.txt' a.ts", "sed '1r ~/.ssh/id_rsa' a.ts", "sed 'R secret.txt' a.ts", "sed 'e' a.ts", "sed 'e id' a.ts", "sed '1e id' a.ts",
  "sed -e 'e id' a.ts", "sed 's/a/b/e' a.ts", "sed 's/a/b/ge' a.ts", "sed 's/.*/id/e' a.ts", "sed 'F' a.ts", "sed -n 'p;e id' a.ts", "sed -n 'p;w x' a.ts", "sed -n -e p -e 'w x' a.ts", "sed '/a/e id' a.ts",
  // script files, free text, labels, hold space, comments, anything not understood
  'sed -f script.sed a.ts', 'sed --file=script.sed a.ts', 'sed -nf script.sed a.ts', "sed 'a hello' a.ts", "sed '1i hello' a.ts", "sed 'c hello' a.ts", "sed ':a;N;$!ba;s/\\n/ /g' a.ts",
  "sed 'b end' a.ts", "sed 'x' a.ts", "sed 'G' a.ts", "sed '#n' a.ts", "sed 'z' a.ts", "sed 'v' a.ts", "sed" , "sed -n", "sed -n '1p' -e", "sed -n '{p' a.ts", "sed -n 'p}' a.ts", "sed -n 's/a/b' a.ts", "sed -n 's/a/b/x' a.ts",
  // a delimiter hidden in a bracket expression, where GNU and BSD sed end the part in different places
  "sed 's/[/]/x/;w out.txt' a.ts", "sed 's/[/]/x/' a.ts", "sed -n '/[/]/p' a.ts", "sed 's/a/[/' a.ts", "sed 'y/[/]/ab/' a.ts",
  // a variable or substitution the parser cannot read
  'sed -n "${N}p" a.ts', 'sed -n "$(echo 1)p" a.ts', 'sed -n `echo 1`p a.ts',
];
test('sed: a print-only or rewrite-only script is quiet in Smart, with the file read like cat does', () => {
  quiet(SED_KNOWN);
});
test('sed: in-place edits, w W e r R f a i c, labels, hold space and every other way to write, read a file or run a program stay unknown', () => {
  unknown(SED_DANGEROUS);
  carded(SED_DANGEROUS);
});
test('sed: a file read outside the project or a secret file is a level 2 read; a redirect target outside is level 3', () => {
  assert.equal(judge('sed -n 1,5p ~/.ssh/id_rsa').level, 2);
  assert.equal(judge('sed -n 1,5p .env').level, 2);
  assert.equal(judge('sed -n 1,5p /etc/hosts').level, 2);
  assert.equal(judge('sed -n 1,5p a.ts > /tmp/x').level, 3);
  carded(['sed -n 1,5p a.ts > /tmp/x', 'sed -n 1,5p a.ts > ../x']);
});
test('sed: the script is not mistaken for a file, and a file is not mistaken for the script', () => {
  // with -e the script words come from -e; the plain words are all files
  assert.equal(judge("sed -n -e 1p ~/.legion/providers/keys.json").level, 2);
  assert.equal(judge("sed 1p ~/.legion/providers/keys.json").level, 2);
});

/* ---------- jq ---------- */

test('jq: a filter that only reshapes JSON is quiet, in a pipe or on a file in the project', () => {
  quiet(['jq . package.json', "jq -r '.a.b' package.json", "jq -c '.[]' data.json", "jq '.name' package.json | head -3", "cat data.json | jq '.a'", "jq --arg x 1 '.[$x]' data.json",
    "jq -n '1+1'", "jq -r '.scripts | keys[]' package.json", "jq -S . a.json", "jq --indent 2 . a.json", "jq -s 'length' a.json b.json", "jq '.a | map(.b)' a.json 2>&1",
    "jq -r --argjson n 3 '.[] | select(.id == 1)' a.json"]);
});
test('jq: file options, modules, the environment and anything not understood are unknown', () => {
  const bad = ['jq --rawfile a ~/.ssh/id_rsa . x.json', 'jq --slurpfile a ~/.ssh/id_rsa . x.json', 'jq --argfile a b.json . x.json', 'jq -f prog.jq x.json', 'jq --from-file prog.jq x.json', 'jq -L lib . x.json',
    'jq --args . a b', 'jq --jsonargs . 1 2', "jq 'env' x.json", "jq -n 'env.PATH'", "jq -n '$ENV.HOME'", "jq -n '$ENV'", "jq 'input_filename' x.json", "jq 'import \"a\" as a; .' x.json", "jq 'include \"a\"; .' x.json",
    "jq 'modulemeta' x.json", 'jq -n \'$__loc__\'', 'jq', 'jq -r', 'jq --unknown-flag . x.json', 'jq --indent x . a.json'];
  unknown(bad);
  carded(bad);
});
test('jq: a file it reads is checked like cat does', () => {
  assert.equal(judge('jq . ~/.aws/credentials').level, 2);
  assert.equal(judge('jq . /etc/passwd').level, 2);
});

/* ---------- text filters and viewers ---------- */

test('tr, nl, column, cmp, diff, readlink, od, tac, rev, sleep, true, false are quiet; their dangerous options are not', () => {
  quiet(["echo abc | tr a-z A-Z", "cat a.ts | tr -d '\\r'", "tr '/' '-'", 'nl a.ts', 'nl -ba a.ts', "column -t a.ts", "column -s , -t a.csv", 'cmp a.ts b.ts', 'diff a.ts b.ts', 'diff -u a.ts b.ts', 'diff -r src dist',
    'readlink -f a.ts', 'od -c a.bin', 'hexdump -C a.bin', 'strings a.bin', 'tac a.ts', 'rev a.ts', 'sha256sum a.ts', 'md5sum a.ts', 'sleep 5', 'sleep 1.5', 'sleep 2m', 'sleep infinity', 'true', 'false', 'sleep 3 && echo hi',
    'ps', 'netstat -ano']);
  carded(['tasklist /s otherhost']);
  const bad = ['diff --output=x.txt a.ts b.ts', 'diff a.ts b.ts > /tmp/x', 'nl a.ts > /tmp/x', 'sleep', 'sleep abc', 'sleep 5; rm -rf build', 'sleep -5x', 'sleep 5 6 x', 'column -t < a.ts'];
  carded(bad);
  assert.equal(judge('diff --output=x.txt a.ts b.ts').level, 3);
  assert.equal(judge('od -c ~/.ssh/id_rsa').level, 2);
  assert.equal(judge('nl .env').level, 2);
});

/* ---------- wrappers ---------- */

test('timeout, nice and time are judged by the command they wrap', () => {
  quiet(['timeout 5 cat a.ts', 'timeout 30 npm test', 'timeout 60s git status', 'timeout -k 5 10 ls', 'timeout --kill-after=5 10 ls', 'timeout -s KILL 10 ls', 'timeout --preserve-status 10 ls', 'nice -n 5 npm test', 'nice -5 npm test',
    'nice ls', 'time ls', 'time -p ls', 'timeout 5 nice cat a.ts', 'timeout 10 sed -n 1,5p a.ts', 'timeout 5 npm run build', 'timeout 5 node --test test/a.test.js 2>&1 | tail -5']);
  const bad = [
    'timeout 5 rm -rf build', 'timeout 5 curl https://example.com', 'timeout 5 python x.py', 'timeout 5 node x.js', 'timeout 5 tee /tmp/x', 'timeout 5 cp a.ts /tmp/b', 'timeout 5 mv a.ts ../b', 'timeout 5 touch ../x',
    'timeout 5 sed -i s/a/b/ a.ts', 'timeout 5 git push', 'timeout 5 node --test /tmp/evil.test.js', 'timeout 5 npm test --prefix /tmp/evil', 'time git push', 'nice -n 5 rm -rf build', 'timeout 5 timeout 5 rm -rf x',
    // options or shapes the wrapper reader does not understand
    'timeout', 'timeout 5', 'timeout cat a.ts', 'timeout abc cat a.ts', 'timeout --foo 5 cat a.ts', 'timeout -x 5 cat a.ts', 'timeout -k 5', 'timeout 5 -v cat a.ts', 'nice', 'nice -n', 'nice -n x ls', 'nice --foo ls', 'time', 'time -x ls',
    // a build or test run after a cd away from the project is still a run outside it
    'cd /tmp && timeout 60 npm test', 'cd ../other && timeout 60 npm run build',
  ];
  carded(bad);
});
test('timeout: a wrapped write is judged by its target, and the wrapped reader goes through the secret check', () => {
  assert.equal(judge('timeout 5 tee /tmp/x').level, 3);
  assert.equal(judge('timeout 5 mkdir out').level, 2);
  assert.equal(judge('timeout 5 cat ~/.ssh/id_rsa').level, 2);
  assert.equal(judge('timeout 5 cat a.ts').level, 1);
  assert.equal(judge('nice cat a.ts > /tmp/x').level, 3);
});
test('shell-wrappers: unwrapCommand and unwrapAll read the wrapper options exactly', () => {
  assert.deepEqual(unwrapCommand(['timeout', '5', 'cat', 'a']), ['cat', 'a']);
  assert.deepEqual(unwrapCommand(['timeout.exe', '-k', '1', '5', 'cat']), ['cat']);
  assert.deepEqual(unwrapCommand(['nice', '-n', '3', 'ls']), ['ls']);
  assert.deepEqual(unwrapCommand(['time', 'ls']), ['ls']);
  assert.equal(unwrapCommand(['ls']), null);
  assert.equal(unwrapCommand(['timeout', 'x', 'ls']), null);
  assert.deepEqual(unwrapAll(['timeout', '5', 'nice', 'time', 'cat', 'a']), ['cat', 'a']);
  assert.equal(unwrapAll(['cat', 'a']), null);
  // a chain deeper than the reader follows is unknown, and a write behind it is not missed
  const deep = `${'timeout 5 '.repeat(9)}tee /tmp/x`;
  assert.ok(judge(deep).tags.includes('unknown'));
  carded([deep, `${'nice '.repeat(12)}rm -rf build`]);
});

/* ---------- git reads ---------- */

test('git: reads that cannot write or run a program are quiet, inside the project or with -C to it', () => {
  quiet(['git status', 'git -C D:/work/shop log --oneline', 'git -C D:/work/shop status', 'git log --oneline -5', 'git branch', 'git branch -a', 'git branch -vv', 'git branch --list \'feat/*\'', 'git branch --show-current',
    'git branch --contains abc123', 'git branch -r --merged main', 'git tag', 'git tag -l \'v*\'', 'git tag --list', 'git tag -n5 -l', 'git tag --contains abc123', 'git remote -v', 'git remote', 'git worktree list', 'git worktree list --porcelain',
    'git stash list', 'git stash show', 'git reflog', 'git reflog show HEAD', 'git rev-list --count HEAD', 'git ls-tree -r HEAD', 'git cat-file -p HEAD', 'git cat-file -t HEAD', 'git for-each-ref refs/heads', 'git grep foo', 'git grep -n foo -- src',
    'git merge-base main HEAD', 'git show-ref', 'git diff-tree --name-only HEAD', 'git name-rev HEAD', 'git count-objects -v']);
});
test('git: creating, deleting or renaming a branch or tag, a remote or worktree change, stash writes, reflog expiry and every program-running flag stay carded', () => {
  carded(['git branch newname', 'git branch -D old', 'git branch -d old', 'git branch -m a b', 'git branch -c a b', 'git branch --set-upstream-to=origin/main', 'git branch -a newname', 'git branch --delete x', 'git branch -f x HEAD',
    'git tag v1', 'git tag -d v1', 'git tag -a v1 -m x', 'git tag -f v1', 'git tag v2',
    'git remote add x https://example.com/r.git', 'git remote remove x', 'git remote set-url origin https://example.com/r.git', 'git remote update', 'git remote show origin', 'git remote -v add x y',
    'git worktree add ../x', 'git worktree remove x', 'git worktree prune', 'git worktree', 'git worktree list --unknown',
    'git stash', 'git stash pop', 'git stash drop', 'git stash push', 'git stash clear', 'git stash apply', 'git stash branch x', 'git stash',
    'git reflog expire --all', 'git reflog delete HEAD@{1}', 'git reflog expire',
    'git cat-file --textconv HEAD:a.ts', 'git cat-file --filters HEAD:a.ts', 'git grep -O vim foo', 'git grep -Ovim foo', 'git grep --open-files-in-pager=vim foo', 'git grep --open-files-in-pager vim foo', 'git grep --open-files=vim foo', 'git grep --open=vim foo',
    'git rev-list --output=x HEAD', 'git ls-tree --output=x HEAD', 'git for-each-ref --ext-diff', 'git grep --textconv foo', 'git -c core.pager=x log', 'git -c alias.log=x log', 'git ls-remote origin']);
  assert.equal(judge('git grep -O vim foo').level, 3);
  assert.equal(judge('git branch newname').level, 3);
});
test('git: a read of another folder through -C keeps its level 2 (outside) and is not made quieter', () => {
  assert.equal(judge('git -C /tmp/other log').level, 2);
  assert.equal(judge('git -C D:/work/shop log').level, 1);
});

/* ---------- build scripts ---------- */

test('npm run: build, test, lint and similar scripts with a :suffix are local runs; any other word or extra argument is not', () => {
  quiet(['npm run build:ts', 'npm run typecheck:ui', 'npm run test:run', 'npm run lint:fix', 'pnpm run build:ui', 'yarn run test:unit', 'npm run build:ts --silent', 'npm run build:ts 2>&1 | tail -20']);
  carded(['npm run test:e2e', 'npm run build:docs', 'npm run build:evil', 'npm run test:map', 'npm run evil', 'npm run buildx', 'npm run build:', 'npm run build::x', 'npm run build:TS', 'npm run build:ts -- --x', 'npm run build:ts --prefix /tmp/x', 'npm run build:ts extra', 'npm run deploy:prod', 'npm run publish:npm',
    'npm run build:ts && npm run evil', 'npm --prefix /tmp/x run build:ts', 'npm run build:ts --script-shell=/tmp/x', 'npm run', 'npm install', 'npm ci', 'npx playwright test', 'npx vite build']);
});

test('npx tsc: only a type check that writes nothing is a local run', () => {
  quiet(['npx tsc --noEmit', 'npx tsc --noEmit -p tsconfig.json', 'npx tsc -p ui/tsconfig.json --noEmit', 'npx tsc --noEmit --pretty false', 'npx tsc --noEmit --skipLibCheck 2>&1 | head -20', 'cd D:/work/shop && npx tsc -p tsconfig.json --noEmit']);
  carded(['npx tsc', 'npx tsc -p tsconfig.json', 'npx tsc --noEmit --outDir /tmp/x', 'npx tsc --noEmit --outDir out', 'npx tsc -b', 'npx tsc --build --noEmit', 'npx tsc --noEmit -p /tmp/evil/tsconfig.json', 'npx tsc --noEmit -p ../evil/tsconfig.json',
    'npx tsc --noEmit -p', 'npx tsc --noEmit --declaration', 'npx tsc --noEmit --incremental', 'npx tsc --noEmit --generateTrace /tmp/x', 'npx tsc --noEmit --listEmittedFiles', 'npx tsc --noEmit x.ts', 'npx tsc --noEmit --init',
    'npx tsc --noEmit --node-options=--require=/tmp/x.js', 'npx --yes tsc --noEmit', 'npx evil --noEmit', 'npx tsc-evil --noEmit', 'cd /tmp && npx tsc --noEmit']);
});

/* ---------- sd ---------- */

test('sd: it rewrites files, so it is a level 2 edit inside the project and level 3 anywhere else', () => {
  quiet(["sd 'old' 'new' src/a.ts", "sd -F 'old' 'new' src/a.ts src/b.ts", "echo hi | sd a b", "sd -p a b src/a.ts"]);
  assert.equal(judge("sd 'old' 'new' src/a.ts").level, 2);
  carded(["sd a b /tmp/x", "sd a b ../x", "sd a b ~/x.txt", "sd a b src/a.ts /tmp/x", "sd a b *.ts", "sd a b %USERPROFILE%/x", "sd a b C:/other/x.ts", "sd a b > /tmp/x"]);
});

/* ---------- PowerShell ---------- */

test('PowerShell: listing, selecting, sorting and formatting cmdlets are quiet; script blocks, provider drives and parameters it cannot read are not', () => {
  quiet(['Get-ChildItem | Select-Object -First 5', 'Get-ChildItem -Recurse | Sort-Object Length | Format-Table Name, Length', 'Get-Item package.json', 'Resolve-Path src', 'Get-Process | Sort-Object CPU | Format-List',
    'Get-Process node | Select-Object Id, ProcessName', 'Get-NetTCPConnection -LocalPort 3000 -State Listen', 'Start-Sleep -Seconds 2', 'Start-Sleep 2', 'Start-Sleep -Milliseconds 500', 'Get-Date', 'Get-Content a.ts | Select-Object -First 3',
    'Get-ChildItem C:/work/shop/src', 'Select-String -Pattern env: a.ts', 'gi package.json'], 'PowerShell');
  const bad = ['Get-ChildItem | ForEach-Object { $_.Name }', 'Get-ChildItem | Where-Object { $_.Length -gt 1 }', 'Start-Sleep $x', 'Start-Sleep -Seconds', 'Start-Sleep -Foo 2', 'Get-Process | Select-Object -Property @{n="a";e={1}}',
    'Get-ChildItem Env:', 'Get-ChildItem env:', 'gci Env:', 'ls env:', 'Get-Content Env:PATH', 'gc env:SECRET', 'Get-Item Env:HOME', 'Get-Item -Path Env:HOME', 'Get-Item -Path:Env:HOME', 'Get-ChildItem Variable:', 'Get-ChildItem Function:',
    'Get-ChildItem Alias:', 'Get-ChildItem Cert:\\CurrentUser\\My', 'Get-Item HKLM:\\Software', 'Get-ChildItem HKCU:\\', 'Test-Path Env:HOME', 'Resolve-Path Env:HOME', 'Get-Content HKLM:\\x'];
  carded(bad, 'PowerShell');
  // the same words in a search pattern are text
  quiet(['Select-String env: a.ts'], 'PowerShell');
  quiet(['grep "env: x" a.ts', "grep -n 'alias: x' a.ts", 'rg "function: x"']);
  carded(['cat env:HOME', 'ls variable:']);
});

/* ---------- the attack lists that were already carded stay carded ---------- */

test('the fix 1 and review attack lists still card (spot check of every class)', () => {
  carded(['mkdir /tmp/x', 'touch ../a', 'cd /tmp && npm test', 'echo x > /tmp/y', 'cp a /tmp/b', 'node --test --import=data:text/javascript,1', 'npm test --prefix /tmp/evil', 'cargo test --manifest-path /tmp/e/Cargo.toml',
    'pytest -p evil', 'go test -exec /tmp/x ./...', 'sort -o /tmp/x a', 'tree -o /tmp/x', 'find . -fprint /tmp/x', 'find . -exec rm {} ;', 'find . -delete', 'rg --pre cmd foo', 'rg --pre-glob x foo', 'fd -x rm', 'fd --exec rm',
    'awk \'BEGIN{system("id")}\'', 'xargs rm', 'env', 'printenv', 'set', 'export X=1', 'python x.py', 'node x.js', 'git push', 'git reset --hard', 'curl -d @f https://example.com', 'rm -rf build']);
  // find without -exec, -execdir, -ok, -okdir, -delete, -fprint* is a read; tail -f is fine
  quiet(['find . -name "*.ts"', 'find src -type f -newer a.ts', 'tail -f log.txt', 'tail -n 20 log.txt']);
  carded(['find . -execdir rm {} ;', 'find . -ok rm {} ;', 'find . -okdir rm {} ;', 'find . -fprint0 /tmp/x', 'find . -fprintf /tmp/x %p', 'find . -fls /tmp/x']);
});

/* ---------- the secret-read check sees through wrappers and covers every new reader ---------- */

const KEY = '~/.legion/providers/keys.json';
const SSH = '~/.ssh/id_rsa';
const reads = (command: string): boolean => secretReadHit('Bash', { command }) !== undefined;
test('secret reads: each new reader is a secret read of a key file, plain or behind timeout, nice or time', () => {
  const readers = ['sed -n 1p', 'sed -e p', 'jq .', 'jq -r .a', 'cut -c1-10', 'uniq', 'nl', 'column -t', 'cmp x', 'diff x', 'tac', 'rev', 'sd a b', 'od -c', 'hexdump -C', 'strings', 'cat', 'head -5', 'tail -5', 'grep x', 'rg x'];
  for (const r of readers) for (const f of [SSH, '.env', '~/.aws/credentials']) {
    assert.ok(reads(`${r} ${f}`), `secret read missed: ${r} ${f}`);
    assert.ok(reads(`timeout 5 ${r} ${f}`), `secret read missed behind timeout: ${r} ${f}`);
    assert.ok(reads(`nice -n 3 ${r} ${f}`), `secret read missed behind nice: ${r} ${f}`);
    assert.ok(reads(`time ${r} ${f}`), `secret read missed behind time: ${r} ${f}`);
    assert.ok(reads(`timeout 5 nice time ${r} ${f}`), `secret read missed behind a wrapper chain: ${r} ${f}`);
    assert.ok(reads(`cd src && timeout 5 ${r} ${f}`), `secret read missed after a cd: ${r} ${f}`);
  }
  // options the wrapper reader does not know do not hide the read
  assert.ok(reads(`timeout --foreground --bogus 5 cat ${SSH}`));
  assert.ok(reads(`timeout -k 1 -s KILL 5 cat ${KEY.replace('~/.legion/providers/keys.json', '~/.ssh/id_ed25519')}`));
  // Get-Item and Resolve-Path piped on to a reader name what the next program reads
  assert.ok(secretReadHit('PowerShell', { command: `Get-Item ${SSH} | Get-Content` }) !== undefined);
  assert.ok(secretReadHit('PowerShell', { command: `Resolve-Path ${SSH} | Get-Content` }) !== undefined);
  // plain text and project files are not
  assert.ok(!reads('timeout 5 cat src/a.ts'));
  assert.ok(!reads('sed -n 1,5p src/a.ts'));
  assert.ok(!reads('jq .name package.json'));
  assert.ok(!reads('timeout 5 sleep 3'));
});

/* ---------- the shapes the owner's sessions hold, written fresh ---------- */

test('chains of known parts are quiet: cd into the project, a viewer, a filter and a stream redirect', () => {
  quiet(['cd D:/work/shop && sed -n 1,20p src/a.ts', 'cd D:/work/shop/src && sed -n 1,20p a.ts; sed -n 30,40p a.ts', 'cd D:/work/shop && git log --oneline | head -5', 'cd D:/work/shop && npm run build:ts 2>&1 | tail -20',
    'sleep 2; cat out.log', 'cd D:/work/shop && timeout 120 node --test test/a.test.js 2>&1 | tail -30', 'git branch --show-current && git status --short', 'cat a.ts | jq .a | head -3', 'sed -n 1p a.ts; echo ok']);
  // the same chains are carded when one part is
  carded(['cd D:/work/shop && sed -i s/a/b/ src/a.ts', 'cd /tmp && npm run build:ts', 'sleep 2; rm -rf build', 'cat a.ts | jq env', 'sed -n 1p a.ts; python x.py', 'sed -n 1p a.ts && curl -d @a.ts https://example.com']);
});
