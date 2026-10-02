// A fake Codex / OpenCode for the CLI tests. Run as: node fake-cli.mjs <recordFile> <cli args...>. It never does anything real.
// It records what it was given (argv, cwd, the NAMES and a few values of its environment, stdin) to <recordFile>, then acts by prompt keyword:
// SLEEP (hang with a grandchild; pids in <recordFile>.pids), FLOOD (3 MB of output), FAIL (stderr with a key shape, exit 2),
// ANSI (escape sequences), anything else prints "answer: <prompt>".
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [, , record, ...argv] = process.argv;
let stdin = '';
if (argv[argv.length - 1] === '-') { for await (const c of process.stdin) stdin += c; }
const prompt = stdin || argv[argv.length - 1] || '';
writeFileSync(record, JSON.stringify({ argv, cwd: process.cwd(), envNames: Object.keys(process.env).sort(), env: { OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION, CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME }, stdin }));
if (prompt.includes('SLEEP')) {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  appendFileSync(record + '.pids', `main ${process.pid}\ngrandchild ${gc.pid}\n`);
  setInterval(() => {}, 1000);
} else if (prompt.includes('FLOOD')) {
  const chunk = 'x'.repeat(65536);
  const t = setInterval(() => { for (let i = 0; i < 16; i++) process.stdout.write(chunk); }, 5);
  appendFileSync(record + '.pids', `main ${process.pid}\n`);
  void t;
} else if (prompt.includes('FAIL')) {
  process.stderr.write('boom ' + 'sk-' + 'proj-FAKEKEY0123456789abcdef' + ' bad\n');
  process.exit(2);
} else if (prompt.includes('ANSI')) {
  process.stdout.write('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\u0000end');
} else {
  process.stdout.write('answer: ' + prompt.slice(0, 60));
}
