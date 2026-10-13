import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGitBash, pickAgentShell, floorShell, shellLaunch, shellRefusal, shellToolDescription, SHELL_COMMAND_VAR, type AgentShell } from '../src/core/exec/agent-shell.js';
import { DirectHostBackend } from '../src/core/exec/direct-host.js';

/** A Git for Windows install on a pretend disk: the files the agent shell needs. */
const gitAt = (root: string): string[] => ['usr\\bin\\bash.exe', 'usr\\bin\\ps.exe', 'usr\\bin\\kill.exe', 'bin\\bash.exe', 'cmd\\git.exe'].map((f) => `${root}\\${f}`.toLowerCase());
const probe = (env: Record<string, string>, files: string[]) => ({ env, isFile: (p: string) => files.includes(p.toLowerCase()) });

test('Git Bash is found from the owner\'s setting, then the git on PATH, then the standard folders; never the WSL launcher', () => {
  const pf = 'C:\\Program Files\\Git', mine = 'D:\\tools\\Git';
  const files = [...gitAt(pf), ...gitAt(mine), 'c:\\windows\\system32\\bash.exe'];
  // standard install folder
  assert.equal(findGitBash(probe({ ProgramFiles: 'C:\\Program Files' }, files)), pf);
  // the git on PATH wins over the standard folder (it is the one the owner runs)
  assert.equal(findGitBash(probe({ ProgramFiles: 'C:\\Program Files', Path: `C:\\Windows\\system32;${mine}\\cmd` }, files)), mine);
  assert.equal(findGitBash(probe({ PATH: `${mine}\\mingw64\\bin` }, [...files, `${mine}\\mingw64\\bin\\git.exe`.toLowerCase()])), mine);
  // the owner's settings win over both, either bash.exe form
  assert.equal(findGitBash(probe({ ProgramFiles: 'C:\\Program Files', CLAUDE_CODE_GIT_BASH_PATH: `${mine}\\bin\\bash.exe` }, files)), mine);
  assert.equal(findGitBash(probe({ ProgramFiles: 'C:\\Program Files', LEGION_GIT_BASH: `"${mine}\\usr\\bin\\bash.exe"` }, files)), mine);
  // "off" means cmd.exe
  assert.equal(findGitBash(probe({ ProgramFiles: 'C:\\Program Files', LEGION_GIT_BASH: 'off' }, files)), undefined);
  // System32's bash.exe starts WSL: never used, the next candidate is
  assert.equal(findGitBash(probe({ LEGION_GIT_BASH: 'C:\\Windows\\System32\\bash.exe', ProgramFiles: 'C:\\Program Files' }, files)), pf);
  assert.equal(findGitBash(probe({ LEGION_GIT_BASH: 'C:\\Windows\\System32\\bash.exe' }, files)), undefined);
  // not bash.exe, or a bash without the tools beside it: not used
  assert.equal(findGitBash(probe({ LEGION_GIT_BASH: `${mine}\\bin\\sh.exe` }, files)), undefined);
  assert.equal(findGitBash(probe({ ProgramFiles: 'C:\\Program Files' }, [`${pf}\\bin\\bash.exe`.toLowerCase()])), undefined);
  // nothing at all
  assert.equal(findGitBash(probe({}, [])), undefined);
});

test('each platform names its shell, and the floor reads Git Bash as sh and cmd.exe as cmd', () => {
  const files = gitAt('C:\\Program Files\\Git');
  const bash = pickAgentShell('win32', probe({ ProgramFiles: 'C:\\Program Files' }, files));
  assert.deepEqual(bash, { kind: 'git-bash', root: 'C:\\Program Files\\Git', bash: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' });
  assert.deepEqual(pickAgentShell('win32', probe({}, [])), { kind: 'cmd' });
  assert.deepEqual(pickAgentShell('linux', probe({}, files)), { kind: 'sh' });
  assert.equal(floorShell(bash), 'sh');
  assert.equal(floorShell({ kind: 'cmd' }), 'cmd');
  assert.equal(floorShell({ kind: 'sh' }), 'sh');
  // the description says which shell and its syntax
  assert.match(shellToolDescription(bash), /Git Bash[\s\S]*bash syntax[\s\S]*C:\/Users/);
  assert.match(shellToolDescription({ kind: 'cmd' }), /cmd\.exe[\s\S]*Git for Windows is not installed[\s\S]*One line only/);
  assert.match(shellToolDescription({ kind: 'sh' }), /\/bin\/sh/);
  for (const s of [bash, { kind: 'cmd' } as const, { kind: 'sh' } as const]) assert.match(shellToolDescription(s), /fresh shell/);
});

test('cmd.exe refuses a multi-line command (it would run only the first line); bash and sh run it', () => {
  const two = 'echo one\necho two';
  assert.match(shellRefusal({ kind: 'cmd' }, two) ?? '', /cmd\.exe[\s\S]*only the first line[\s\S]*&/);
  assert.match(shellRefusal({ kind: 'cmd' }, 'echo one\r\necho two') ?? '', /first line/);
  assert.equal(shellRefusal({ kind: 'cmd' }, 'echo one & echo two\n'), undefined, 'a trailing line break is one line');
  assert.equal(shellRefusal({ kind: 'git-bash', root: 'C:\\G', bash: 'C:\\G\\usr\\bin\\bash.exe' }, two), undefined);
  assert.equal(shellRefusal({ kind: 'sh' }, two), undefined);
});

test('Git Bash gets the command in a variable (never on the command line), its own tools first on PATH, and the Git Bash path conversion left on', () => {
  const s: AgentShell = { kind: 'git-bash', root: 'C:\\G', bash: 'C:\\G\\usr\\bin\\bash.exe' };
  const l = shellLaunch(s, 'dir \\\\server\\share', { Path: 'C:\\Windows', HOME: 'x' });
  assert.equal(l.file, s.bash);
  assert.equal(l.shell, false);
  assert.ok(!l.args.join(' ').includes('server'), 'the command text is not an argument');
  assert.equal(l.env[SHELL_COMMAND_VAR], 'dir \\\\server\\share');
  assert.match(l.args[1]!, new RegExp(`unset ${SHELL_COMMAND_VAR}; eval`));
  assert.equal(l.env.Path, 'C:\\G\\mingw64\\bin;C:\\G\\usr\\bin;C:\\Windows', 'one PATH, under its own spelling');
  assert.equal(l.env.PATH, undefined);
  assert.equal(l.env.MSYS_NO_PATHCONV, undefined, 'as in Claude Code\'s Bash tool: /tmp and $(pwd) paths reach Windows programs');
  assert.equal(l.env.MSYS2_ARG_CONV_EXCL, undefined);
  assert.equal(l.env.MSYSTEM, 'MINGW64');
  // cmd.exe and sh: as before, through Node's shell
  assert.deepEqual(shellLaunch({ kind: 'cmd' }, 'echo hi', { A: '1' }), { file: 'echo hi', args: [], shell: true, env: { A: '1' } });
});

// On a Windows machine with Git for Windows (GitHub's Windows runners have it): the real thing.
const real = process.platform === 'win32' ? pickAgentShell('win32') : undefined;
const skipReal = real?.kind !== 'git-bash' ? 'needs Windows with Git for Windows' : false;

test('Git Bash runs the exact text the floor read: double backslashes, UNC paths, quotes, non-ASCII', { skip: skipReal }, async () => {
  const b = new DirectHostBackend({ shell: real });
  for (const t of ['C:\\\\x', '\\\\server\\share', 'a"b\\"c', "it's", 'æøå ✓', '%PATH%', 'end\\']) {
    const r = await b.execute({ cmd: `cat <<'EOF'\n${t}\nEOF`, timeoutMs: 20_000 });
    assert.equal(r.output.replace(/\r?\n$/, ''), t, JSON.stringify(t));
  }
  const env = await b.execute({ cmd: `echo "[$${SHELL_COMMAND_VAR}][$MSYSTEM]"; exit 3`, timeoutMs: 20_000 });
  assert.equal(env.exit_code, 3);
  assert.match(env.output, /^\[\]\[MINGW64\]/, 'the command variable is gone before the command runs');
  const multi = await b.execute({ cmd: 'for i in 1 2; do\n  echo n$i\ndone | tr "\\n" ,', timeoutMs: 20_000 });
  assert.equal(multi.output.trim(), 'n1,n2,');
});

test('Git Bash: a bash path reaches a Windows program as a Windows path, a doubled switch reaches cmd, and a long command arrives whole', { skip: skipReal }, async () => {
  const b = new DirectHostBackend({ shell: real });
  const p = await b.execute({ cmd: 'node -e "console.log(process.argv[1])" /tmp/x', timeoutMs: 20_000 });
  assert.match(p.output.trim(), /^[A-Za-z]:[\\/]/, p.output);
  assert.match((await b.execute({ cmd: 'cmd //c echo via-cmd', timeoutMs: 20_000 })).output, /via-cmd/);
  // the floor's reading limit is 10,000 characters; a longer command is carded, and once approved must still run whole
  const long = `echo ${'x'.repeat(30_000)} | wc -c`;
  assert.equal((await b.execute({ cmd: long, timeoutMs: 20_000 })).output.trim(), '30001');
});

test('Git Bash: a timeout ends the call promptly and kills what the command left in the background', { skip: skipReal }, async () => {
  const b = new DirectHostBackend({ shell: real });
  const dir = mkdtempSync(join(tmpdir(), 'legion-bg-'));
  const proof = join(dir, 'alive').replace(/\\/g, '/');
  const t0 = Date.now();
  // a background job leaves the Windows process tree: it must still be killed, and must not hold the call open
  const r = await b.execute({ cmd: `(sleep 4; echo alive > '${proof}') & sleep 60`, timeoutMs: 1500 });
  assert.equal(r.exit_code, 124);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 8000, `ended after ${Date.now() - t0} ms`);
  await new Promise((res) => setTimeout(res, 5000));
  assert.equal(existsSync(proof), false, 'the background job was killed before it could write');
  rmSync(dir, { recursive: true, force: true });
});

test('a cancel ends a Git Bash run the same way', { skip: skipReal }, async () => {
  const ac = new AbortController();
  const p = new DirectHostBackend({ shell: real }).execute({ cmd: 'sleep 30 & sleep 31', signal: ac.signal });
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 300);
  const r = await p;
  assert.equal(r.exit_code, 130);
  assert.ok(Date.now() - t0 < 8000, `ended after ${Date.now() - t0} ms`);
});

test('the floor reads a Git Bash doubled switch (cmd //c, robocopy //MIR, rd //s) as the switch it is', async () => {
  const { refuseCatastrophic } = await import('../src/core/exec/shell-floor.js');
  for (const c of ['cmd //c rd /s /q C:\\', 'cmd //c del /s /q C:\\Users', 'robocopy //MIR C:/empty C:/Users', 'cmd //c rd //s //q C:\\Windows', 'powershell //c "Remove-Item -Recurse -Force C:\\Windows"']) {
    assert.ok(refuseCatastrophic(c, 'sh'), c);
  }
  // a path written with two slashes is a path, not a switch; ordinary work still runs
  for (const c of ['ls //server/share', 'rm -rf ./build', 'cmd //c ver', 'tasklist //FO CSV']) assert.equal(refuseCatastrophic(c, 'sh'), undefined, c);
});
