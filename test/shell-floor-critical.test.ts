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
