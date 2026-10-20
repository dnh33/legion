/**
 * Gate rules (src/core/gates.ts): precedence, compound-command splitting, deny-in-`full`, and the back-compat
 * invariant that rules=[] decides `baseline` for every input (so needsApproval stays byte-identical to today).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGate, GATE_TOOL_GROUPS, splitCommand } from '../src/core/gates.js';
import { needsApproval } from '../src/core/approvals.js';
import type { ApprovalMode, GateRule, GateVerdict, GateWhen } from '../src/shared/types.js';

let n = 0;
function rule(then: GateVerdict, when: GateWhen, over: Partial<GateRule> = {}): GateRule {
  return { id: `gr_t${++n}`, enabled: true, then, label: `${then} rule`, source: 'user', when, ...over };
}
const modes: ApprovalMode[] = ['ask', 'auto-edits', 'full'];

test('precedence: deny > ask > allow, and specificity never reorders the classes', () => {
  // A narrow allow and a broad deny both match: the deny wins (an allow never carves out of a deny).
  const allowGit = rule('allow', { commands: ['git push*'] });
  const denyPush = rule('deny', { commands: ['git push origin *'] });
  const ask = rule('ask', { tools: ['Bash'] });
  const call = { toolName: 'Bash', input: { command: 'git push origin main' }, agentId: 'zealot' };
  assert.equal(decideGate(call, [allowGit, denyPush], 'ask', false).verdict, 'deny');
  assert.equal(decideGate(call, [denyPush, allowGit], 'ask', false).verdict, 'deny');

  // A matching ask still prompts even when a (different) allow also matches: ask beats allow.
  const allowBash = rule('allow', { tools: ['shell'] });
  assert.equal(decideGate(call, [allowBash, ask], 'ask', false).verdict, 'ask');
  assert.equal(decideGate(call, [ask, allowBash], 'ask', false).verdict, 'ask');

  // The order of the list itself never changes any verdict — class decides, always.
  const rules = [allowGit, denyPush, ask, allowBash];
  const forwards = decideGate(call, rules, 'ask', false);
  const backwards = decideGate(call, [...rules].reverse(), 'ask', false);
  assert.equal(forwards.verdict, backwards.verdict);
  assert.deepEqual([...forwards.ruleIds].sort(), [...backwards.ruleIds].sort());
});

test('deny applies in `full` mode; ask is inert there (owner rule: in full a guard never shows a card)', () => {
  const deny = rule('deny', { commands: ['mkfs*'] });
  const ask = rule('ask', { tools: ['Bash'] });
  const call = { toolName: 'Bash', input: { command: 'mkfs.ext4 /dev/sda1' }, agentId: 'zealot' };
  for (const mode of modes) {
    assert.equal(decideGate(call, [deny], mode, false).verdict, 'deny', `deny in ${mode}`);
  }
  // ask alone: decides nothing in full (baseline), decides ask in the other two.
  assert.equal(decideGate(call, [ask], 'ask', false).verdict, 'ask');
  assert.equal(decideGate(call, [ask], 'auto-edits', false).verdict, 'ask');
  assert.equal(decideGate(call, [ask], 'full', false).verdict, 'baseline');
  // A rule may make `full` STRICTER (deny) but never card it (ask).
  assert.equal(decideGate(call, [deny, ask], 'full', false).verdict, 'deny');
});

test('allow never loosens a capped run (confused-deputy guard: a run from another bot only gets stricter)', () => {
  const allow = rule('allow', { commands: ['git push*'] });
  const ask = rule('ask', { tools: ['Bash'] });
  const call = { toolName: 'Bash', input: { command: 'git push origin main' }, agentId: 'zealot' };
  assert.equal(decideGate(call, [allow], 'ask', true).verdict, 'baseline', 'allow ignored when capped');
  assert.equal(decideGate(call, [allow], 'auto-edits', false).verdict, 'allow', 'allow applies when not capped');
  assert.equal(decideGate(call, [ask], 'ask', true).verdict, 'ask', 'ask still tightens a capped run');
  assert.equal(decideGate(call, [allow, ask], 'ask', true).verdict, 'ask');
  assert.equal(decideGate(call, [allow, ask], 'full', true).verdict, 'baseline', 'in full the ask rule is inert (owner rule) and the allow is capped away');
});

test('compound bash splits on && || ; | & and newlines: deny fires on any subcommand, allow needs every subcommand', () => {
  assert.deepEqual(splitCommand('git status && rm -rf /'), ['git status', 'rm -rf /']);
  assert.deepEqual(splitCommand('ls; echo a || echo b'), ['ls', 'echo a', 'echo b']);
  assert.deepEqual(splitCommand('cat x | grep y'), ['cat x', 'grep y']);
  assert.deepEqual(splitCommand('make & wait'), ['make', 'wait']);
  assert.deepEqual(splitCommand('echo one\necho two'), ['echo one', 'echo two']);
  assert.deepEqual(splitCommand('git push > out.txt'), ['git push'], 'a redirect is not a separator');

  const allowGit = rule('allow', { commands: ['git *'] });
  const denyRm = rule('deny', { commands: ['rm -rf *'] });
  const chained = { toolName: 'Bash', input: { command: 'git push && rm -rf /' }, agentId: 'zealot' };
  // The allow does NOT approve the whole line; the deny still fires on the second half.
  assert.equal(decideGate(chained, [allowGit], 'ask', false).verdict, 'baseline');
  assert.equal(decideGate(chained, [denyRm], 'ask', false).verdict, 'deny');
  assert.equal(decideGate({ toolName: 'Bash', input: { command: 'git push && git status' }, agentId: 'zealot' }, [allowGit], 'ask', false).verdict, 'allow');
});

test('normalization defeats quote/escape tricks before matching', () => {
  const deny = rule('deny', { commands: ['rm -rf *'] });
  for (const command of ['rm -rf /', 'r"m -rf /', 'rm" -rf /', 'Rm -RF /', 'rm  -rf  /']) {
    assert.equal(decideGate({ toolName: 'Bash', input: { command }, agentId: 'a' }, [deny], 'full', false).verdict, 'deny', command);
  }
  const allow = rule('allow', { commands: ['git st*'] });
  assert.equal(decideGate({ toolName: 'Bash', input: { command: 'git st"at"us' }, agentId: 'a' }, [allow], 'ask', false).verdict, 'allow');
  // an unclosed quote is not a command the shell would run as written: no allow holds on it (the card shows)
  assert.equal(decideGate({ toolName: 'Bash', input: { command: 'git st"atus' }, agentId: 'a' }, [allow], 'ask', false).verdict, 'baseline');
});

test('paths: gitignore-style matching, redirect targets as candidates, exceptPaths and the leading-! carve-out', () => {
  const cwd = 'D:/work/site';
  // Path scoping is applied inside decideGate (it is class-aware there), so the probe goes through it.
  const denies = (when: GateWhen, call: { toolName: string; input: Record<string, unknown>; cwd: string }) =>
    decideGate(call, [rule('deny', when)], 'ask', false).verdict === 'deny';
  const write = (file_path: string) => ({ toolName: 'Write', input: { file_path }, cwd });
  const w: GateWhen = { paths: ['**/*.env', '!**/.env.example'] };
  assert.equal(denies(w, write('D:/work/site/.env')), true);
  assert.equal(denies(w, write('D:/work/site/config/.env')), true, 'double star crosses folders');
  assert.equal(denies(w, write('D:/work/site/.env.example')), false, 'the ! entry carves it out');
  // `!` FIRST carves nothing: a list of only carve-outs names no paths at all.
  assert.equal(denies({ paths: ['!**/*.env'] }, write('D:/work/site/.env')), false, 'a leading ! lists no paths at all');
  assert.equal(denies({ paths: ['**/*.env'], exceptPaths: ['**/.env.example'] }, write('X/.env.example')), false);
  // A redirect target is a path candidate: `echo x > out/.env` matches a path-scoped rule.
  assert.equal(denies({ paths: ['**/*.env'] }, { toolName: 'Bash', input: { command: 'echo x > out/.env' }, cwd }), true);
  // A rule scoped to paths cannot match a call with no path at all.
  assert.equal(denies({ paths: ['**/*.env'] }, { toolName: 'Bash', input: { command: 'ls' }, cwd }), false);
  // Bare name matches at any level; a pattern with a slash is anchored to cwd-relative.
  assert.equal(denies({ paths: ['secrets.txt'] }, write('D:/work/site/a/b/secrets.txt')), true);
  assert.equal(denies({ paths: ['src/app.ts'] }, write('D:/work/site/lib/app.ts')), false);
});

test('scoping: agents, projects (with and without a projectId), contexts, tools and disabled rules', () => {
  const a = rule('deny', { agents: ['zealot'] });
  assert.equal(decideGate({ toolName: 'Bash', agentId: 'zealot' }, [a], 'full', false).verdict, 'deny');
  assert.equal(decideGate({ toolName: 'Bash', agentId: 'scout' }, [a], 'full', false).verdict, 'baseline');

  const p = rule('ask', { projects: ['website'] });
  assert.equal(decideGate({ toolName: 'Bash', projectId: 'website' }, [p], 'auto-edits', false).verdict, 'ask');
  assert.equal(decideGate({ toolName: 'Bash', projectId: 'legion' }, [p], 'auto-edits', false).verdict, 'baseline');
  assert.equal(decideGate({ toolName: 'Bash' }, [p], 'auto-edits', false).verdict, 'baseline', 'a task with no project matches only rules without a project scope');

  const ctxRule = rule('deny', { contexts: ['capped'] });
  assert.equal(decideGate({ toolName: 'Bash' }, [ctxRule], 'full', true).verdict, 'deny');
  assert.equal(decideGate({ toolName: 'Bash' }, [ctxRule], 'full', false).verdict, 'baseline');
  const hop = rule('ask', { contexts: ['room-hop'] });
  assert.equal(decideGate({ toolName: 'Bash', ctx: { roomHop: true } }, [hop], 'auto-edits', false).verdict, 'ask');

  const g = rule('deny', { tools: ['shell'] });
  assert.equal(decideGate({ toolName: 'Bash' }, [g], 'full', false).verdict, 'deny', 'group shell covers Bash');
  assert.equal(decideGate({ toolName: 'mcp__host__shell' }, [g], 'full', false).verdict, 'deny', 'group shell covers the agent shell');
  assert.equal(decideGate({ toolName: 'Write' }, [g], 'full', false).verdict, 'baseline');
  const hostGlob = rule('deny', { tools: ['mcp__host__*'] });
  assert.equal(decideGate({ toolName: 'mcp__host__write_file' }, [hostGlob], 'full', false).verdict, 'deny');
  const srv = rule('deny', { tools: ['mcp__github__'] });
  assert.equal(decideGate({ toolName: 'mcp__github__create_issue' }, [srv], 'full', false).verdict, 'deny', 'server prefix');
  assert.equal(decideGate({ toolName: 'mcp__githubish__x' }, [srv], 'full', false).verdict, 'baseline');

  const off = rule('deny', { tools: ['shell'] }, { enabled: false });
  assert.equal(decideGate({ toolName: 'Bash' }, [off], 'full', false).verdict, 'baseline', 'a disabled rule never decides');

  // A command-scoped rule never matches a call that carries no command.
  const cmdRule = rule('deny', { commands: ['npm run *'] });
  assert.equal(decideGate({ toolName: 'Write', input: { file_path: 'a.ts' } }, [cmdRule], 'full', false).verdict, 'baseline');
});

test('BACK-COMPAT FLOOR: with rules=[] decideGate returns baseline for every tool, mode and cap - today’s behaviour', () => {
  const tools = ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'mcp__legion__vm_exec', 'mcp__host__shell', 'mcp__x__y', 'Whatever'];
  const inputs = [{}, { command: 'rm -rf /' }, { command: 'git push origin main && echo hi' }, { file_path: '/etc/passwd' }];
  let checked = 0;
  for (const toolName of tools) for (const mode of modes) for (const capped of [false, true]) for (const input of inputs) {
    const d = decideGate({ toolName, input, agentId: 'zealot', projectId: 'p', cwd: 'C:/x' }, [], mode, capped);
    assert.equal(d.verdict, 'baseline', `${toolName}/${mode}/${capped}`);
    assert.deepEqual(d.ruleIds, []);
    // and the caller's floor is untouched: needsApproval is the exact same call it always was
    assert.equal(typeof needsApproval(mode, toolName, { capped }), 'boolean');
    checked++;
  }
  assert.ok(checked > 100, `grid actually ran (${checked} cells)`);
});

test('reads + tasks are exactly needsApproval’s read-only set (+ the agent shell read), so the two never drift', async () => {
  const mod = await import('../src/core/approvals.js') as { APPROVAL_READ_ONLY?: ReadonlySet<string> };
  assert.ok(mod.APPROVAL_READ_ONLY, 'approvals.ts exports its read-only set for this sync check');
  const reads = new Set(GATE_TOOL_GROUPS.reads!);
  const tasks = new Set(GATE_TOOL_GROUPS.tasks ?? []);
  for (const t of mod.APPROVAL_READ_ONLY) assert.ok(reads.has(t) || tasks.has(t), `reads or tasks must contain ${t}`);
  for (const t of [...reads, ...tasks]) {
    // the agent shell's read is carded on purpose; Legion's own todo_* tools are never carded (isLegionTool), so not in the set
    if (t === 'mcp__host__read_file' || t.startsWith('mcp__legion__')) continue;
    assert.ok(mod.APPROVAL_READ_ONLY.has(t), `${t} is in a group but not in needsApproval's read-only set`);
  }
  for (const t of tasks) assert.equal(reads.has(t), false, `${t} is in both reads and tasks`);
});

test('the task list is its own group: a File reads rule leaves it alone, a Task list rule reaches it (and the provider todo_* tools)', () => {
  const tools = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'mcp__legion__todo_create', 'mcp__legion__todo_update', 'mcp__legion__todo_list', 'mcp__legion__todo_get'];
  const v = (group: string, toolName: string) => decideGate({ toolName, input: {}, agentId: 'a' }, [rule('deny', { tools: [group] })], 'full', false).verdict;
  for (const t of tools) {
    assert.equal(v('reads', t), 'baseline', `reads must not reach ${t}`);
    assert.equal(v('tasks', t), 'deny', `tasks must reach ${t}`);
  }
  assert.equal(v('tasks', 'Read'), 'baseline');
});

test('ruleIds lists every matching rule (for the "why" popover), including the ones that lost the class vote', () => {
  const allow = rule('allow', { tools: ['shell'] });
  const deny = rule('deny', { commands: ['rm *'] });
  const noMatch = rule('ask', { agents: ['scout'] });
  const d = decideGate({ toolName: 'Bash', input: { command: 'rm -rf /' }, agentId: 'zealot' }, [allow, deny, noMatch], 'ask', false);
  assert.equal(d.verdict, 'deny');
  assert.deepEqual(d.ruleIds, [allow.id, deny.id], 'the allow matched the tool but lost to the deny; the agent-scoped ask did not match');
});
test('a command deny rule sees through flag order, long flags, wrappers, shell -c and escapes', () => {
  const deny = rule('deny', { tools: ['shell'], commands: ['rm -rf *'] });
  const v = (command: string) => decideGate({ toolName: 'mcp__host__shell', input: { command }, agentId: 'a' }, [deny], 'full', false).verdict;
  for (const c of [
    'rm -rf build', 'rm -fr build', 'rm -r -f build', 'rm -Rf build', 'rm --recursive --force build', 'rm -rf -- build',
    '/bin/rm -rf build', 'sudo rm -rf build', 'sudo -u root rm -rf build', 'command rm -rf build', 'env FOO=1 rm -rf build', 'nohup rm -rf build',
    'bash -c "rm -rf build"', 'sh -c \'ls; rm -rf build\'', 'cmd /c "rm -rf build"', 'powershell -Command "rm -rf build"',
    'r^m -rf build', 'r\\m -rf build', 'ls && sudo rm -fr build',
  ]) assert.equal(v(c), 'deny', c);
  for (const c of ['rm build', 'rm -f build', 'ls -rf', 'echo rm', 'git rm -r --cached x']) assert.equal(v(c), 'baseline', c);
});

test('those forms never widen an allow: a wrapped or reshaped command still needs the card', () => {
  const allow = rule('allow', { tools: ['shell'], commands: ['rm -rf build'] });
  const v = (command: string) => decideGate({ toolName: 'Bash', input: { command }, agentId: 'a' }, [allow], 'ask', false).verdict;
  assert.equal(v('rm -rf build'), 'allow');
  for (const c of ['sudo rm -rf build', 'bash -c "rm -rf build"', '/bin/rm -rf build', 'rm -fr build', 'env X=1 rm -rf build']) assert.equal(v(c), 'baseline', c);
});

test('a bare-name or **/ deny rule still holds when the agent folder is a POSIX path (macOS, Linux, WSL)', () => {
  const v = (paths: string[], p: string, cwd?: string) => decideGate({ toolName: 'Read', input: { file_path: p }, agentId: 'a', ...(cwd ? { cwd } : {}) }, [rule('deny', { paths })], 'full', false).verdict;
  for (const cwd of [undefined, '/proj', 'C:/proj']) {
    assert.equal(v(['secrets.txt'], 'src/secrets.txt', cwd), 'deny', `bare name, cwd ${cwd}`);
    assert.equal(v(['**/secrets/**'], '../sib/secrets/k', cwd), 'deny', `**/ form, cwd ${cwd}`);
  }
  assert.equal(v(['secrets.txt'], '/proj/a/secrets.txt', '/proj'), 'deny', 'an absolute POSIX path too');
  assert.equal(v(['.env'], '/home/me/app/.env', '/'), 'deny');
  assert.equal(v(['secrets.txt'], '/proj/a/public.txt', '/proj'), 'baseline');
});

test('the root-stripped path form is for deny and ask only: it never widens a path allow', () => {
  const allow = rule('allow', { tools: ['edits'], paths: ['notes.txt'] });
  const v = (p: string, cwd: string) => decideGate({ toolName: 'Write', input: { file_path: p }, agentId: 'a', cwd }, [allow], 'ask', false).verdict;
  // inside the agent folder the relative form names the file: that is the rule's meaning
  assert.equal(v('/proj/notes.txt', '/proj'), 'allow');
  // outside it, only the root-stripped form would match: an allow must not get it
  assert.equal(v('/other/notes.txt', '/proj'), 'baseline');
});

test('a path with . and .. segments is matched as the path it names: x/../secrets is secrets, and .. never climbs above the root', () => {
  const deny = rule('deny', { paths: ['D:/proj/secrets/**'] });
  const call = (p: string) => decideGate({ toolName: 'Read', input: { file_path: p }, agentId: 'a', cwd: 'D:/proj' }, [deny], 'full', false).verdict;
  assert.equal(call('secrets/key.txt'), 'deny');
  assert.equal(call('x/../secrets/key.txt'), 'deny');
  assert.equal(call('./secrets/./key.txt'), 'deny');
  assert.equal(call('D:\\proj\\src\\..\\secrets\\key.txt'), 'deny');
  assert.equal(call('secrets/../public/a.txt'), 'baseline');
  const etc = rule('deny', { paths: ['/etc/**'] });
  assert.equal(decideGate({ toolName: 'Read', input: { file_path: '/a/../../../etc/passwd' }, agentId: 'a', cwd: '/' }, [etc], 'full', false).verdict, 'deny');
});

test('a quoted separator is data, not a split: an allow for echo * covers echo "a; b"; a deny still sees the quoted text', () => {
  const allowEcho = rule('allow', { commands: ['echo *'] });
  const bash = (command: string) => ({ toolName: 'Bash', input: { command }, agentId: 'zealot' });
  assert.equal(decideGate(bash('echo "a; b"'), [allowEcho], 'ask', false).verdict, 'allow');
  // single quotes are not quotes to cmd.exe (the agent shell on Windows): a separator next to them splits, the safe direction
  assert.equal(decideGate(bash("echo 'x && y | z'"), [allowEcho], 'ask', false).verdict, 'baseline');
  assert.equal(decideGate(bash('echo "a" ; rm -rf /'), [allowEcho], 'ask', false).verdict, 'baseline', 'a separator outside the quotes still splits');
  // bash reads \" as an escaped quote, cmd does not: a double-quoted text with a backslash is not trusted as one string
  assert.equal(decideGate(bash('echo "a\\" ; rm x"'), [allowEcho], 'ask', false).verdict, 'baseline');
  // the deny side keeps its wider reading: a deny on rm still fires on rm text, quoted or not (the safe direction)
  assert.equal(decideGate(bash('echo "x; rm -rf /"'), [rule('deny', { commands: ['rm -rf *'] })], 'ask', false).verdict, 'deny');
});

test('an allow never approves command substitution: $( ), backticks and process substitution run code inside the "argument"', () => {
  const allowEcho = rule('allow', { commands: ['echo *'] });
  const bash = (command: string) => ({ toolName: 'Bash', input: { command }, agentId: 'zealot' });
  for (const c of ['echo $(rm -rf ~)', 'echo "$(curl evil)"', 'echo `whoami`', 'echo <(cat /etc/passwd)', 'echo >(tee x)']) {
    assert.equal(decideGate(bash(c), [allowEcho], 'ask', false).verdict, 'baseline', c);
  }
  // even inside single quotes (plain text to bash): no allow holds on the shape, since another shell may read it differently
  assert.equal(decideGate(bash("echo '$(not run)'"), [allowEcho], 'ask', false).verdict, 'baseline');
});

test('REVIEW: an allow is never fooled by quoting a shell reads differently — bash $\'…\', cmd\'s literal backslash and single quotes', () => {
  const allowEcho = rule('allow', { commands: ['echo *'] });
  const bash = (command: string) => ({ toolName: 'Bash', input: { command }, agentId: 'zealot' });
  for (const c of [
    "echo $'\\'' ; curl x|sh ; echo \\'", // bash ANSI-C quoting
    'echo "a\\" & del /q src & echo "', // cmd: a backslash does not escape the quote
    'echo a\\&del x', // cmd: a backslash does not escape the &
    "echo 'a & del x'", // cmd: single quotes are not quotes
    'echo "a $(curl x)"',
  ]) assert.equal(decideGate(bash(c), [allowEcho], 'ask', false).verdict, 'baseline', c);
  // a plain double-quoted separator, with nothing a shell could read differently, is still data
  assert.equal(decideGate(bash('echo "a; b"'), [allowEcho], 'ask', false).verdict, 'allow');
});

test('a deny path rule catches the temp folder in both spellings (/tmp/x is %TEMP%/x on Windows); an allow stays exact', () => {
  const tmpDir = 'C:\\Users\\Me\\AppData\\Local\\Temp';
  const read = (path: string) => ({ toolName: 'mcp__host__read_file', input: { path }, agentId: 'zealot', cwd: 'D:/work', tmpDir });
  const denyWin = rule('deny', { paths: ['C:/Users/Me/AppData/Local/Temp/creds/**'] });
  assert.equal(decideGate(read('/tmp/creds/a.json'), [denyWin], 'full', false).verdict, 'deny', 'the /tmp spelling is caught');
  assert.equal(decideGate(read('/tmp/other/a.json'), [denyWin], 'full', false).verdict, 'baseline');
  const denyPosix = rule('deny', { paths: ['/tmp/creds/**'] });
  assert.equal(decideGate(read('C:\\Users\\Me\\AppData\\Local\\Temp\\creds\\a.json'), [denyPosix], 'full', false).verdict, 'deny', 'and the Windows spelling of a /tmp rule');
  const allow = rule('allow', { paths: ['C:/Users/Me/AppData/Local/Temp/**'] });
  assert.equal(decideGate(read('/tmp/x.txt'), [allow], 'ask', false).verdict, 'baseline', 'the wider reading never widens an allow');
  assert.equal(decideGate({ ...read('/tmp/creds/a.json'), tmpDir: undefined }, [denyWin], 'full', false).verdict, 'baseline', 'no temp folder known (not Windows): nothing is mapped');
});

test('a deny path rule also catches the Git Bash form of the same path (/d/secrets/x is D:/secrets/x); an allow stays exact', () => {
  const read = (path: string) => ({ toolName: 'mcp__host__read_file', input: { path }, agentId: 'zealot', cwd: 'D:/work' });
  const deny = rule('deny', { paths: ['D:/secrets/**'] });
  assert.equal(decideGate(read('/d/secrets/key.txt'), [deny], 'full', false).verdict, 'deny');
  assert.equal(decideGate(read('/d/work/a.txt'), [deny], 'full', false).verdict, 'baseline');
  const allow = rule('allow', { paths: ['D:/work/**'] });
  assert.equal(decideGate(read('/d/work/a.txt'), [allow], 'ask', false).verdict, 'baseline', 'the wider reading never widens an allow');
});

test('a run that lost its project mid-way still meets that project\'s deny and ask rules, but never its allow rules', () => {
  const deny = rule('deny', { projects: ['proj_aaaaaaaaaaaa'], tools: ['Bash'] });
  const ask = rule('ask', { projects: ['proj_aaaaaaaaaaaa'] });
  const allow = rule('allow', { projects: ['proj_aaaaaaaaaaaa'] });
  const lost = { toolName: 'Bash', input: { command: 'ls' }, startProjectId: 'proj_aaaaaaaaaaaa' };
  assert.equal(decideGate(lost, [deny], 'full', false).verdict, 'deny');
  assert.equal(decideGate(lost, [ask], 'auto-edits', false).verdict, 'ask');
  assert.equal(decideGate(lost, [allow], 'auto-edits', false).verdict, 'baseline', 'an allow rule needs the project now');
  assert.equal(decideGate({ toolName: 'Bash', input: { command: 'ls' } }, [deny], 'full', false).verdict, 'baseline', 'a run never in the project is untouched');
});
