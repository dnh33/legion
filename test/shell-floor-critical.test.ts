// test/shell-floor-critical.test.ts: deleting the run's project folder, or a folder above it, never passes without the owner
// (criticalDelete in the shell floor; the engine cards it, or refuses it in Full). Fake paths only: the reader is pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalDelete, criticalDeleteRead } from '../src/core/exec/shell-floor.js';
import type { ShellKind } from '../src/core/exec/shell-floor.js';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';

const HOME = 'C:\\Users\\Daniel';
const APP = 'D:\\work\\app';
const where = { cwd: APP, roots: [APP], home: HOME };
const hit = (cmd: string, shell: ShellKind = 'sh', w: Parameters<typeof criticalDelete>[2] = where) => criticalDelete(cmd, shell, w);

test('rm -rf . in the project folder is a critical delete', () => {
  assert.match(hit('rm -rf .') ?? '', /project folder D:\\work\\app/);
  assert.ok(hit('rm -rf ./'));
  assert.ok(hit('rm -rf *'));
  assert.ok(hit('sudo rm -rf .'));
  assert.ok(hit('cd src && rm -rf ..'));
  assert.ok(hit('Remove-Item . -Recurse -Force', 'pwsh'));
  assert.ok(hit('find . -delete'));
  assert.equal(hit('find . -name "*.tmp" -delete'), undefined, 'a filter narrows what find deletes');
  assert.ok(hit('bash -c "rm -rf ."'), 'the text of a shell -c is a command of its own');
});

test('rm -rf .. and rm -rf ../.. from the project folder are critical (parents)', () => {
  assert.match(hit('rm -rf ..') ?? '', /D:\\work\b.*holds the project/);
  assert.match(hit('rm -rf ../..') ?? '', /D:\\/);
  assert.ok(hit('rm -rf ../../'));
  assert.equal(hit('rm -rf ../sibling'), undefined, 'a sibling folder is not the project or above it');
});

test('rm -rf D:/work/app by its absolute path, any case and either slash, is critical', () => {
  for (const c of ['rm -rf D:/work/app', 'rm -rf d:/WORK/App/', 'rm -rf D:\\work\\app', 'rm -rf "D:/work/app"', 'rm -rf /d/work/app', 'rm -r -f D:/work/./app/../app']) assert.ok(hit(c), c);
  assert.equal(hit('rm -rf D:/work/app/build'), undefined);
  assert.equal(hit('rm -rf D:/work/app2'), undefined, 'a folder that only starts with the same letters');
});

test('Remove-Item -Recurse -Force D:\\work (a parent) is critical; cmd rd /s /q D:\\work too', () => {
  assert.match(hit('Remove-Item -Recurse -Force D:\\work', 'pwsh') ?? '', /D:\\work, a folder that holds the project|D:\\work\b.*holds the project/);
  assert.ok(hit('Remove-Item -Path D:\\work -Recurse', 'pwsh'));
  assert.ok(hit('rd /s /q D:\\work', 'cmd'));
  assert.ok(hit('rmdir /s /q "D:\\work\\app"', 'cmd'));
  assert.ok(hit('del /s /q D:\\work\\app\\*', 'cmd'));
  assert.equal(hit('rd /s /q D:\\work\\app\\dist', 'cmd'), undefined);
});

test('rm -rf <root>/* and <root>/.* are critical; rm -rf <extra root> itself is not (Claude Code rule)', () => {
  assert.ok(hit('rm -rf D:/work/app/*'));
  assert.ok(hit('rm -rf D:/work/app/.*'));
  assert.ok(hit('Remove-Item D:\\work\\app\\* -Recurse', 'pwsh'));
  const extra = { cwd: APP, roots: [], extras: ['E:\\shared\\lib'], home: HOME };
  assert.equal(hit('rm -rf E:/shared/lib', 'sh', extra), undefined, 'the extra folder itself');
  assert.ok(hit('rm -rf E:/shared/lib/*', 'sh', extra), 'a glob directly under it');
  assert.ok(hit('rm -rf E:/shared/lib/.*', 'sh', extra));
  assert.equal(hit('rm -rf E:/shared/lib/src', 'sh', extra), undefined);
});

test('the project root of a run whose working folder is elsewhere counts, with its parents', () => {
  const w = { cwd: 'D:\\agents\\a1', roots: ['D:\\work\\app'], home: HOME };
  assert.match(hit('rm -rf D:/work/app', 'sh', w) ?? '', /project folder D:\\work\\app/);
  assert.ok(hit('rm -rf D:/work', 'sh', w));
  assert.ok(hit('rm -rf D:/agents/a1', 'sh', w), 'the working folder itself');
});

test('the home 8.3 short name C:\\Users\\DANIEL~1 is a home folder', () => {
  assert.ok(hit('rm -rf C:\\Users\\DANIEL~1', 'cmd'));
  assert.ok(hit('rm -rf C:/Users/DANIEL~1/', 'sh'));
  assert.ok(hit('rm -rf C:/Users/Daniel', 'sh'));
  assert.ok(hit('rm -rf ~', 'sh'));
  assert.ok(hit('rm -rf $HOME/*', 'sh'));
  assert.equal(hit('rm -rf C:/Users/Daniel/old-stuff', 'sh'), undefined, 'a folder inside the home is ordinary work');
  assert.equal(hit('rm -rf C:/Users/DANIEL~1/old', 'sh'), undefined);
});

test('ordinary deletes stay free: build, ./node_modules, dist, src/old/file.ts, a folder two levels down', () => {
  for (const c of ['rm -rf build', 'rm -rf ./node_modules', 'rm -f src/old/file.ts', 'rm -rf src/old/deep', 'rm -rf build/*', 'rm -rf ./dist/*', 'rm -rf node_modules .next', 'rm file.txt', 'rm -rf *.log', 'rm -rf ./out/.cache', 'git clean -fdx', 'ls ..', 'cd .. && ls', 'echo rm -rf .']) assert.equal(hit(c), undefined, c);
  for (const c of ['Remove-Item dist -Recurse', 'Remove-Item .\\build\\* -Recurse -Force', 'del src\\old\\file.ts']) assert.equal(hit(c, 'pwsh'), undefined, c);
  assert.equal(hit('rd /s /q build', 'cmd'), undefined);
});

test('after cd .. in an earlier call, rm -rf app (now the project folder by name) is critical', () => {
  const first = criticalDeleteRead('cd ..', 'sh', where);
  assert.equal(first.reason, undefined);
  assert.equal(first.cwd, 'd:/work');
  const second = criticalDeleteRead('rm -rf app', 'sh', { ...where, cwd: first.cwd! });
  assert.match(second.reason ?? '', /project folder D:\\work\\app/);
  // inside one line too, and a relative cd back down
  assert.ok(hit('cd .. && rm -rf app'));
  assert.equal(hit('cd .. && rm -rf app/build'), undefined);
  assert.ok(hit('cd .. ; cd app ; rm -rf .'));
  assert.equal(hit('cd src && rm -rf .'), undefined, 'src is a folder inside the project');
});

test('a cd the reader cannot follow leaves the folder unknown: then only the plain "here" spellings are asked about', () => {
  const lost = criticalDeleteRead('cd "$WHERE"', 'sh', where);
  assert.equal(lost.cwd, undefined);
  const w = { cwd: undefined, roots: [APP], home: HOME };
  assert.ok(hit('rm -rf .', 'sh', w));
  assert.ok(hit('rm -rf ..', 'sh', w));
  assert.equal(hit('rm -rf build', 'sh', w), undefined);
  assert.ok(hit('rm -rf D:/work/app', 'sh', w), 'an absolute path needs no folder');
});

test('a quoted path in a commit message or an rg pattern is data, not a delete', () => {
  for (const c of ['git commit -m "rm -rf ."', "rg 'rm -rf D:/work/app' src", 'echo "rm -rf .."', 'git log --grep="rm -rf \\."', 'cat notes-about-rm-rf-dot.txt']) assert.equal(hit(c), undefined, c);
});

test('the same readers: a delete behind a pipe or a runner is read, a verb used as an argument is not', () => {
  assert.ok(hit('true && (rm -rf .)'));
  assert.ok(hit('FOO=1 rm -rf D:/work/app'));
  assert.ok(hit('robocopy C:\\empty D:\\work\\app /MIR', 'cmd'));
  assert.equal(hit('git rm -r --cached .'), undefined, 'git rm only changes the index');
  assert.equal(hit('rg -n del D:/work/app'), undefined);
});

test('Linux and macOS folders: a delete inside the project stays free, the project and the folders above it are critical', () => {
  const PX = '/home/runner/work/app';
  const pw = { cwd: PX, roots: [PX], home: '/home/runner' };
  const ph = (cmd: string, shell: ShellKind = 'sh') => criticalDelete(cmd, shell, pw);
  for (const c of ['rm -rf build', 'rm -rf ./node_modules', 'rm -rf build/*', 'cd build && rm -rf *', 'rm -rf ../app/build', `rm -rf ${PX}/dist`, 'cd /tmp && rm -rf x', 'rm -f src/old/file.ts']) assert.equal(ph(c), undefined, c);
  assert.equal(ph('Remove-Item build -Recurse', 'pwsh'), undefined);
  assert.match(ph('rm -rf .') ?? '', /project folder \/home\/runner\/work\/app/);
  assert.match(ph('rm -rf ..') ?? '', /\/home\/runner\/work, a folder that holds the project/);
  assert.match(ph('rm -rf *') ?? '', /everything in \/home\/runner\/work\/app/);
  for (const c of ['rm -rf ../..', 'cd src && rm -rf ..', 'rm -rf /home/runner', 'cd /home/runner/work && rm -rf app', 'rm -rf /', 'rm -rf ~', 'rm -rf ../../../../..']) assert.ok(ph(c), c);
  assert.ok(ph('Remove-Item .. -Recurse', 'pwsh'));
  assert.deepEqual(criticalDeleteRead('cd /tmp/x && ls', 'sh', pw).cwds, [PX, '/tmp/x'], 'a plain cd to a POSIX folder is followed');
  assert.equal(criticalDeleteRead('cd /tmp/x && ls', 'sh', where).cwds, undefined, 'Git Bash on Windows: /tmp is inside the Git install, so the folder is not known');
  assert.ok(hit('cd /usr && rm -rf ../d/work/app'), 'Git Bash: back to / and down into a drive');
});

/* ---------- the engine ---------- */

const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const fwd = (r: GatesRig) => r.projectDir().replace(/\\/g, '/');

test('Smart and Accept edits: the card is shown with no Remember; Bypass: refused with the plain reason, no card', async () => {
  for (const preset of ['accept-edits', 'smart'] as const) {
    await using({ preset, follow: true }, async (r) => {
      const x = await r.run('Bash', { command: `rm -rf ${fwd(r)}` });
      assert.equal(x.card, true, `${preset}: carded`);
      assert.equal(x.noRemember, true, `${preset}: no Remember`);
      assert.match(x.summary ?? '', /^This command deletes .*, which holds your project\.\nrm -rf .*\nYou are asked in every approval mode\. Allow it only if you mean to delete it\.$/s);
      assert.equal(x.allow, false, 'a "no" stops it');
    });
  }
  await using({ preset: 'ask', follow: true }, async (r) => {
    const x = await r.run('Bash', { command: 'rm -rf ..' });
    assert.equal(x.card, true);
    assert.equal(x.noRemember, true, 'Ask too: the card cannot be remembered');
  });
  await using({ preset: 'bypass', follow: true }, async (r) => {
    const x = await r.run('Bash', { command: `rm -rf ${fwd(r)}` });
    assert.equal(x.card, false, 'no card in Bypass');
    assert.equal(x.allow, false);
    assert.match(x.message ?? '', /^Not run: this command deletes .*, which holds the project\. With full access such a command is refused rather than asked about\. If it really must go, tell the user and let them delete it\.$/);
    assert.ok(!/—/.test(x.message ?? ''), 'no em dash');
    const ok = await r.run('Bash', { command: `rm -rf ${fwd(r)}/build` });
    assert.deepEqual([ok.card, ok.allow], [false, true], 'a folder inside the project is free in Bypass');
  });
});

test('a run with an outside Ask ceiling in a Bypass project is carded, not refused', async () => {
  await using({ preset: 'bypass', follow: true, ceiling: 'ask' }, async (r) => {
    const x = await r.run('Bash', { command: `rm -rf ${fwd(r)}` });
    assert.equal(x.card, true);
    assert.equal(x.noRemember, true);
  });
});

test('Claude Bash keeps its folder between calls: cd into the project folder, then rm -rf . is caught in the next call; the host shell takes a cwd per call', async () => {
  await using({ preset: 'accept-edits', follow: true }, async (r) => {
    const first = await r.run('Bash', { command: `cd ${fwd(r)}` });
    assert.equal(first.card === true && /deletes/.test(first.summary ?? ''), false, 'a cd is not a delete');
    const second = await r.run('Bash', { command: 'rm -rf .' });
    assert.match(second.summary ?? '', /This command deletes/);
    const host = await r.run('mcp__host__shell', { command: 'rm -rf .', cwd: fwd(r) });
    assert.match(host.summary ?? '', /This command deletes/);
  });
});

/* ---------- fix round 1: default deny (review findings I-1 to I-9, and the minor ones the ruling kept) ---------- */

const name = (r: GatesRig) => fwd(r).split('/').pop()!;
const parentOf = (r: GatesRig) => fwd(r).split('/').slice(0, -1).join('/');
const refused = (x: { card: boolean; allow: boolean; message?: string }) => !x.card && !x.allow && /^Not run: this command deletes /.test(x.message ?? '');

test('I-1: a call that was refused does not move the carried folder (cd src && eval, refused in Bypass, then rm -rf ../<project>)', async () => {
  await using({ preset: 'bypass', follow: true }, async (r) => {
    await r.run('Bash', { command: `cd ${fwd(r)}` });
    const ev = await r.run('Bash', { command: 'cd src && eval "$X"' });
    assert.equal(ev.allow, false, 'the eval call is refused, so the shell never went into src');
    const x = await r.run('Bash', { command: `rm -rf ../${name(r)}` });
    assert.ok(refused(x), `refused: ${JSON.stringify(x)}`);
  });
  // Ask: the owner says no to the card of a cd; the next relative delete is still read from where the shell may be
  await using({ preset: 'ask', follow: true }, async (r) => {
    await r.run('Bash', { command: `cd ${fwd(r)}` });
    await r.run('Bash', { command: 'cd src' });
    const x = await r.run('Bash', { command: `rm -rf ../${name(r)}` });
    assert.match(x.summary ?? '', /^This command deletes /);
  });
});

test('I-2: cd - goes back to the folder before (not home): cd <parent>, cd <project>, cd -, rm -rf <project> is refused in Bypass', async () => {
  assert.ok(hit('cd .. && cd app && cd - && rm -rf app'), 'in one line');
  assert.ok(hit('cd /d/work && cd - && rm -rf ..'));
  await using({ preset: 'bypass', follow: true }, async (r) => {
    await r.run('Bash', { command: `cd ${parentOf(r)}` });
    await r.run('Bash', { command: `cd ${name(r)}` });
    await r.run('Bash', { command: 'cd -' });
    assert.ok(refused(await r.run('Bash', { command: `rm -rf ${name(r)}` })));
  });
});

test('I-3: -Path:<x> and -LiteralPath:<x> are read (Remove-Item and Set-Location)', async () => {
  for (const c of ['Remove-Item -Path:. -Recurse', 'Remove-Item -Path:.. -Recurse', 'Remove-Item -LiteralPath:D:\\work -Recurse', 'Remove-Item -Path:"D:\\work" -Recurse', 'Set-Location -Path:..; Remove-Item app -Recurse']) assert.ok(hit(c, 'pwsh'), c);
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('PowerShell', { command: `Set-Location ${fwd(r)}; Remove-Item -Path:. -Recurse -Force` })));
  });
});

test('I-4: bash -lc, -ic, -xc are read as -c', async () => {
  for (const c of ['bash -lc "rm -rf .."', 'bash -lc "rm -rf ."', 'sh -ic "rm -rf ."', 'bash -xc \'rm -rf ..\'', 'bash -elc "rm -rf ."']) assert.ok(hit(c), c);
  assert.ok(hit('bash -lc "rm -rf ."', 'pwsh'));
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('mcp__host__shell', { command: 'bash -lc "rm -rf ."', cwd: fwd(r) })));
  });
});

test('I-5: a drive-relative path (\\work) in cmd and PowerShell is on the drive of the working folder', () => {
  for (const c of ['rd /s /q \\work\\app', 'rd /s /q \\work', 'cd \\work && rd /s /q app', 'D: && cd \\work && rd /s /q app', 'rd /s /q "\\"', 'rd /s /q D:work']) assert.ok(hit(c, 'cmd'), c);
  for (const c of ['Remove-Item \\work\\app -Recurse', 'cd \\work; Remove-Item app -Recurse']) assert.ok(hit(c, 'pwsh'), c);
  assert.equal(hit('rd /s /q \\work\\app\\dist', 'cmd'), undefined, 'a folder inside the project, written drive-relative');
});

test('I-6: admin-share and UNC spellings of the project or a parent', () => {
  for (const c of ['rm -rf \'\\\\localhost\\D$\\work\\app\'', 'rm -rf //localhost/D$/work/app', 'rm -rf \'\\\\127.0.0.1\\d$\\work\'']) assert.ok(hit(c), c);
  for (const c of ['Remove-Item \\\\localhost\\D$\\work\\app -Recurse', 'Remove-Item \\\\127.0.0.1\\d$\\work -Recurse', 'Remove-Item \\\\?\\UNC\\localhost\\D$\\work -Recurse', 'Remove-Item \\\\?\\Volume{1234}\\work -Recurse']) assert.ok(hit(c, 'pwsh'), c);
  assert.ok(hit('rd /s /q \\\\localhost\\D$\\work\\app', 'cmd'));
});

test('I-7: PowerShell forms of the working folder ($pwd.Path, $PWD\\.., "$PWD/..") are the working folder', () => {
  for (const c of ['Remove-Item $pwd.Path -Recurse', 'Remove-Item $PWD\\.. -Recurse', 'Remove-Item "$PWD/.." -Recurse', 'Remove-Item (Get-Location) -Recurse', 'Remove-Item $PWD -Recurse']) assert.ok(hit(c, 'pwsh'), c);
  assert.ok(hit('rd /s /q %CD%', 'cmd'));
  assert.ok(hit('rm -rf "$(pwd)"'));
  assert.ok(hit('rm -rf "$PWD"/..'));
});

test('I-8: any glob at or above the project root, and a wide glob directly under it', async () => {
  for (const c of ['rm -rf ?*', 'rm -rf **', 'rm -rf ./**', 'rm -rf .??*', 'rm -rf .[!.]*', 'rm -rf ./{*,.*}', 'rm -rf D:/work/app/**', 'rm -rf D:/work/a*', 'rm -rf D:/work/ap?', 'rm -rf D:/work/[a]pp', 'rm -rf D:/work/*/', 'rm -rf D:/work/app/*/', 'rm -rf ../*']) assert.ok(hit(c), c);
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('mcp__host__shell', { command: 'rm -rf ?*', cwd: fwd(r) })));
  });
});

test('I-9: a pipeline into Remove-Item deletes what the lister lists', async () => {
  for (const c of ['Get-ChildItem | Remove-Item -Recurse', 'Get-ChildItem . | Remove-Item -Recurse -Force', 'gci -Recurse | ri -Force', 'ls | rm -r', 'Get-ChildItem -Force | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }', 'Get-Item .. | Remove-Item -Recurse']) assert.ok(hit(c, 'pwsh'), c);
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('PowerShell', { command: `Set-Location ${fwd(r)}; Get-ChildItem -Force | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }` })));
  });
});

test('the ruling\'s minor items: package runners (M-3), cd.. (M-4), comma lists, a trailing space or dot, the folder shown as written (M-2)', () => {
  for (const c of ['pnpm dlx rimraf ..', 'yarn dlx rimraf ..', 'npm exec rimraf ..', 'npm exec -- rimraf .', 'npx del-cli .', 'rm -rf "D:/work/app "', 'rm -rf "D:/work/app."']) assert.ok(hit(c), c);
  for (const c of ['cd..; Remove-Item app -Recurse', 'Remove-Item build,. -Recurse']) assert.ok(hit(c, 'pwsh'), c);
  for (const c of ['cd.. && rd /s /q app', 'rd /s /q build,.']) assert.ok(hit(c, 'cmd'), c);
  const r = criticalDeleteRead('cd .. && rm -rf app', 'sh', { cwd: 'D:\\Work\\App', roots: ['D:\\Work\\App'], home: HOME });
  assert.match(r.reason ?? '', /D:\\Work\\App/, 'the project folder as the owner wrote it');
});

test('fix round 1 review: expressions, -Name:value forms, folder variables set on the line, a redefined cd, cmd cd to another drive', () => {
  for (const c of ['Remove-Item (Get-Item .).Parent -Recurse', 'Remove-Item @(gci) -Recurse -Force', 'Remove-Item (gci) -Recurse', 'Remove-Item -Pa:. -Recurse', 'Remove-Item -LP:.. -Recurse', 'Remove-Item -PSPath:.. -Recurse', 'Set-Location -Pa:..; Remove-Item app -Recurse']) assert.ok(hit(c, 'pwsh'), c);
  for (const c of ['PWD=D:/work; rm -rf "$PWD/app"', 'HOME=D:/work; cd && rm -rf app', 'cd() { :; }; cd .. && rm -rf ../app']) assert.ok(hit(c), c);
  assert.ok(criticalDelete('OLDPWD=D:/work; cd - && rm -rf app', 'sh', { ...where, cwds: ['d:/work/app'] }));
  assert.ok(hit('cd C:\\a\\b && rd /s /q ..\\..\\work\\app', 'cmd'), 'cmd does not change drive without /d');
  assert.equal(hit('(cd build && rm -rf *)'), undefined, 'a closing bracket alone is not an expression');
  assert.equal(hit('Remove-Item .\\dist -Recurse:$true -ErrorAction:SilentlyContinue', 'pwsh'), undefined);
});

test('ordinary deletes stay free in Bypass (false-positive suite)', async () => {
  await using({ preset: 'bypass', follow: true }, async (r) => {
    const sub = `${fwd(r)}/build`;
    const free = [
      'rm -rf build', 'rm -rf ./node_modules', 'rm -rf dist .next coverage', 'rm -f src/old/file.ts', 'rm -rf src/old/deep', 'rm -rf build/*',
      'rm -rf ./dist/*', 'rm -rf logs/*.log', 'rm -rf *.log', 'rm -rf ./out/.cache', `rm -rf ${sub}`, `rm -rf "${sub}/cache"`, 'rm -rf -- tmp',
      'find . -name "*.tmp" -delete', 'find build -delete', 'cd build && rm -rf *', 'rimraf dist', 'npx rimraf dist coverage', 'rm -rf ../' + name(r) + '/build',
    ];
    for (const c of free) {
      const x = await r.run('mcp__host__shell', { command: c, cwd: fwd(r) });
      assert.deepEqual([x.card, x.allow], [false, true], `${c}: ${x.message ?? ''}`);
    }
  });
  for (const c of ['Remove-Item .\\dist -Recurse', 'Remove-Item dist\\* -Recurse -Force', 'Remove-Item -Path .\\build -Recurse', `Remove-Item ${APP}\\out -Recurse`, 'Get-ChildItem build | Remove-Item -Recurse', 'Get-ChildItem -Filter *.tmp | Remove-Item']) assert.equal(hit(c, 'pwsh'), undefined, c);
  for (const c of ['rd /s /q dist', 'del /q dist\\*', 'del /s /q *.log']) assert.equal(hit(c, 'cmd'), undefined, c);
});

/* ---------- fix round 2: narrow the proof (re-review 1: C-1, I-10 .. I-14, M-11, M-12) ---------- */

const R = String.raw;
const drivePosix = (p: string) => `/${p[0]!.toLowerCase()}${p.slice(2)}`;

test('C-1: a cd that may fail, then ; & or a newline, leaves the folder unknown (the later part runs from the folder before)', async () => {
  for (const c of ['cd nosuch && true; rm -rf ../app', 'cd nosuch && echo x; rm -rf ../app', 'cd nosuch && true\nrm -rf ../app']) assert.ok(hit(c), c);
  assert.ok(hit(R`cd nosuch && echo & rd /s /q ..\app`, 'cmd'));
  assert.ok(hit(R`cd nosuch && echo x; Remove-Item ..\app -Recurse`, 'pwsh'));
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('mcp__host__shell', { command: `cd nosuch && true; rm -rf ../${name(r)}`, cwd: fwd(r) })));
  });
});

test('I-10: in sh, .. folds on the POSIX form before /x/ is read as a drive (Git Bash climbs out of a drive)', async () => {
  for (const c of [
    'rm -rf /tmp/../d/work', 'rm -rf /c/../d/work/app', 'rm -rf /usr/../d/work/app', 'rm -rf ~/../../../d/work/app', 'rm -rf $HOME/../../../d/work',
    'rm -rf /mnt/c/../d/work/app', 'rm -rf /cygdrive/c/../d/work', 'cd / && rm -rf d/work/app', 'cd /c/.. && rm -rf d/work/app', 'cd ~/../../.. && rm -rf d/work',
    'cd /tmp && rm -rf ../d/work',
  ]) assert.ok(hit(c), c);
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('mcp__host__shell', { command: `rm -rf /tmp/..${drivePosix(fwd(r))}`, cwd: fwd(r) })));
  });
});

test('I-11: sh escapes and ANSI-C quotes are not placed', async () => {
  for (const c of [R`rm -rf D:/work/a\pp`, R`rm -rf ../ap\p`, R`rm -rf /d/wo\rk/app`, R`rm -rf $'\x2e\x2e'`, R`rm -rf $'\056'`]) assert.ok(hit(c), c);
  await using({ preset: 'bypass', follow: true }, async (r) => {
    const p = fwd(r);
    assert.ok(refused(await r.run('mcp__host__shell', { command: `rm -rf ${p.slice(0, -1)}\\${p.slice(-1)}`, cwd: p })));
  });
});

test('I-12: a last segment Windows trims (..., ". ", ".. ", a trailing space) is not placed', async () => {
  for (const c of [
    'Remove-Item ... -Recurse', R`Set-Location D:\work\app; Remove-Item ... -Recurse -Force`, "Remove-Item '. ' -Recurse", "Remove-Item '.. ' -Recurse",
    R`Remove-Item 'src\..\...' -Recurse`, R`Remove-Item 'D:\work\app\ ' -Recurse`, R`Remove-Item D:\work\app\... -Recurse`, R`Remove-Item '..\...' -Recurse`,
  ]) assert.ok(hit(c, 'pwsh'), c);
  for (const c of ['rd /s /q ...', R`rd /s /q "D:\work\app\ "`, R`rd /s /q "..\ "`]) assert.ok(hit(c, 'cmd'), c);
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('PowerShell', { command: `Set-Location ${fwd(r)}; Remove-Item ... -Recurse -Force` })));
  });
});

test('I-13: PowerShell provider paths (FileSystem::) are not placed', async () => {
  for (const c of [R`Remove-Item FileSystem::D:\work\app -Recurse`, R`Remove-Item Microsoft.PowerShell.Core\FileSystem::D:\work -Recurse`, R`Remove-Item -LiteralPath FileSystem::D:\work -Recurse`, R`cd FileSystem::D:\work; Remove-Item app -Recurse`]) assert.ok(hit(c, 'pwsh'), c);
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.ok(refused(await r.run('PowerShell', { command: `Remove-Item FileSystem::${fwd(r)} -Recurse` })));
  });
});

test('I-14: a cd in a loop or a function, a sourced script, a script call or SetLocation leaves the folder unknown, for the rest of the run too', async () => {
  for (const c of ['for i in 1 2; do cd ..; done; rm -rf work', 'while [ ! -d work ]; do cd ..; done; rm -rf work', 'up() { cd ..; }; up; up; rm -rf work', '. ./x.sh && rm -rf work', 'source ./x.sh && rm -rf work']) assert.ok(hit(c), c);
  for (const c of [
    '1..2 | % { cd .. }; Remove-Item work -Recurse', 'foreach ($i in 1..2) { Set-Location .. }; Remove-Item work -Recurse', 'function up { Set-Location .. }; up; up; Remove-Item work -Recurse',
    R`.\x.ps1; Remove-Item work -Recurse`, R`& .\x.ps1; Remove-Item work -Recurse`, "$ExecutionContext.SessionState.Path.SetLocation('..'); Remove-Item app -Recurse",
  ]) assert.ok(hit(c, 'pwsh'), c);
  for (const c of ['for /l %i in (1,1,2) do @cd .. & rd /s /q work', 'call x.bat && rd /s /q work']) assert.ok(hit(c, 'cmd'), c);
  assert.equal(criticalDeleteRead('up() { cd ..; }', 'sh', where).cwds, undefined, 'a function that moves the shell: not known after it');
  await using({ preset: 'bypass', follow: true }, async (r) => {
    const parent = parentOf(r).split('/').pop()!;
    assert.ok(refused(await r.run('mcp__host__shell', { command: `for i in 1 2; do cd ..; done; rm -rf ${parent}`, cwd: fwd(r) })));
  });
});

test('M-11 and M-12: pushd +N, and a drive or link alias made on the line', () => {
  assert.ok(hit('pushd +1 && rm -rf app'));
  assert.equal(criticalDeleteRead('pushd -2', 'sh', where).cwds, undefined);
  for (const c of [R`subst W: D:\work; Remove-Item W:\app -Recurse`, R`New-PSDrive -Name W -PSProvider FileSystem -Root D:\work; Remove-Item W:\app -Recurse`]) assert.ok(hit(c, 'pwsh'), c);
  assert.ok(hit(R`net use W: \localhost\d$\work && rd /s /q W:\app`, 'cmd'));
  for (const c of [R`cmd //c mklink /j x D:\work && rm -rf x/`, 'ln -s D:/work x && rm -rf x/', 'rm -rf /proc/self/cwd']) assert.ok(hit(c), c);
});

test('fix round 2: ordinary deletes stay free, a project path with spaces and a single plain cd included', () => {
  const sp = { cwd: R`D:\my work\app`, roots: [R`D:\my work\app`], home: HOME };
  for (const c of ['rm -rf build', 'rm -rf "D:/my work/app/build"', 'cd sub && rm -rf build', 'rm -rf logs/*.log', 'rm -rf dist/*']) assert.equal(hit(c, 'sh', sp), undefined, c);
  for (const c of [R`Remove-Item "D:\my work\app\dist" -Recurse`, R`Remove-Item .\dist -Recurse`, 'Set-Location src && Remove-Item build -Recurse']) assert.equal(hit(c, 'pwsh', sp), undefined, c);
  assert.equal(hit('cd sub && rm -rf build'), undefined);
  assert.equal(hit(R`cd /d D:\work\app\src && rd /s /q build`, 'cmd'), undefined);
  assert.ok(hit('rm -rf "D:/my work/app"', 'sh', sp));
});

test('fix round 2 self-review: a quoted, escaped or module-qualified cd counts as a move; find -exec rm {} + is read by the find rule', () => {
  for (const c of [String.raw`c\d ..; rm -rf app`, String.raw`\cd ..; rm -rf app`, "'cd' .. ; rm -rf app", 'c""d .. && c""d .. && rm -rf work']) assert.ok(hit(c), c);
  assert.ok(hit(String.raw`Microsoft.PowerShell.Management\Set-Location ..; Remove-Item app -Recurse`, 'pwsh'));
  assert.equal(hit('find . -name node_modules -prune -exec rm -rf {} +'), undefined);
  assert.ok(hit('find .. -name app -exec rm -rf {} +'));
});
