/**
 * A stand-in `hermes` command for the Contained profile tests, run as `node dist/test/acp-fake-hermes.js <hermes arguments>`.
 * Never a real Hermes. Every call appends its argument list (one JSON line) to the file in FAKE_HERMES_LOG, and the "profiles" live as
 * folders under FAKE_HERMES_STATE. It knows only the commands the Contained setup uses and answers anything else with exit code 3:
 *   profile show <name>                       exit 0 when the folder exists, else 1 (the message Hermes prints)
 *   profile create <name> [--no-alias]        makes the folder; exit 1 when it exists; exit 2 for any --clone* flag (the test must never send one)
 *   -p <name> config set <key> <value>        a value starting with [ is read as a list; FAKE_HERMES_BREAK="key=value" makes that key keep the value
 *   -p <name> config get <key> --json         the value as JSON, or exit 1 "Config key not set"
 *   -p <name> auth list                       prints a credentials line when the profile folder holds a file named `signed-in`, or one named
 *                                             `borrowed` while auth.adopt_external_logins is not false (a login borrowed from another program)
 *   -p <name> acp                             logs and exits 0
 *   acp [--check]                             `--check` prints "Hermes ACP check OK" (FAKE_HERMES_CHECK_FAIL="text" makes it exit 1 with that text);
 *                                             `acp` alone, when FAKE_HERMES_HANDSHAKE is set (otherwise it is an unknown command, as before), answers one `initialize` on stdin with agentInfo.version FAKE_HERMES_VERSION (default
 *                                             0.22.3; empty: no version) and leaves when stdin closes. `--check` also works after `-p <name>`.
 *   config get <key> --json                   without -p: the owner's own home, kept as the folder `__home__`; a missing folder is an empty config
 *   --version (anywhere)                      exit 9: Legion must never send it (it checks for updates); the argument list is logged first
 * FAKE_HERMES_SEEN (a file) receives the HERMES_HOME the command saw, one line per call. FAKE_HERMES_GARBAGE replaces the value `config get` prints.
 * Switches for the failure tests: FAKE_HERMES_SHOW_ERROR (`profile show` fails the way a stale saved profile does), FAKE_HERMES_NOISE (a
 * notice line before the JSON of `config get`), FAKE_HERMES_LEAK (`config set` fails with a key-shaped value in its message).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const state = process.env.FAKE_HERMES_STATE ?? '';
const log = process.env.FAKE_HERMES_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);

if (process.env.FAKE_HERMES_SEEN) appendFileSync(process.env.FAKE_HERMES_SEEN, `${process.env.HERMES_HOME ?? ''}\n`);

let a = [...argv];
let profile: string | undefined;
if (a[0] === '-p') { profile = a[1]; a = a.slice(2); }
const dir = (name: string) => join(state, 'profiles', name);
const cfgFile = (name: string) => join(dir(name), 'config.json');
const die = (code: number, text: string): never => { process.stderr.write(`${text}\n`); process.exit(code); };

if (argv.includes('--version')) {
  die(9, 'fake hermes: --version must never be sent');
} else if (a[0] === 'acp' && a.includes('--check')) {
  if (process.env.FAKE_HERMES_CHECK_FAIL) die(1, process.env.FAKE_HERMES_CHECK_FAIL);
  process.stdout.write('Hermes ACP check OK\n');
} else if (a[0] === 'acp' && !profile && process.env.FAKE_HERMES_HANDSHAKE) {
  const version = process.env.FAKE_HERMES_VERSION ?? '0.22.3';
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d: string) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line) as { id?: number; method?: string };
      if (m.method === 'initialize') process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'hermes-agent', ...(version ? { version } : {}) }, agentCapabilities: {} } })}\n`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else if (a[0] === 'profile' && a[1] === 'show') {
  const name = a[2] ?? '';
  if (process.env.FAKE_HERMES_SHOW_ERROR) die(1, `Error: Saved profile '${name}' no longer exists. Switch back with: hermes profile use default`);
  if (!existsSync(dir(name))) die(1, `Error: Profile '${name}' does not exist.`);
  process.stdout.write(`\nProfile: ${name}\nPath:    ${dir(name)}\n\n`);
} else if (a[0] === 'profile' && a[1] === 'create') {
  const name = a[2] ?? '';
  if (a.some((x) => x.startsWith('--clone'))) die(2, 'fake hermes: a clone flag must never be sent');
  if (existsSync(dir(name))) die(1, `Error: Profile '${name}' already exists.`);
  mkdirSync(dir(name), { recursive: true });
  writeFileSync(cfgFile(name), '{}');
  process.stdout.write(`\nProfile '${name}' created at ${dir(name)}\n`);
} else if (a[0] === 'config' && a[1] === 'set' && profile) {
  if (!existsSync(dir(profile))) die(1, `Error: Profile '${profile}' does not exist.`);
  const [key, raw] = [a[2] ?? '', a[3] ?? ''];
  if (process.env.FAKE_HERMES_LEAK) die(1, `Error: PROVIDER_ONE_API_KEY=${process.env.FAKE_HERMES_LEAK} could not be written for ${key}`);
  const cfg = JSON.parse(readFileSync(cfgFile(profile), 'utf8')) as Record<string, unknown>;
  const list = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  cfg[key] = list ?? (raw === 'true' ? true : raw === 'false' ? false : raw);
  const brk = (process.env.FAKE_HERMES_BREAK ?? '').split('=');
  if (brk[0] === key) cfg[key] = brk.slice(1).join('=');
  writeFileSync(cfgFile(profile), JSON.stringify(cfg));
  process.stdout.write(`✓ Set ${key} = ${raw} in ${cfgFile(profile)}\n`);
} else if (a[0] === 'config' && a[1] === 'get') {
  const name = profile ?? '__home__';
  if (profile && !existsSync(dir(profile))) die(1, `Error: Profile '${profile}' does not exist.`);
  const key = a[2] ?? '';
  const cfg = existsSync(cfgFile(name)) ? JSON.parse(readFileSync(cfgFile(name), 'utf8')) as Record<string, unknown> : {};
  if (!(key in cfg)) die(1, `Config key not set: ${key}`);
  if (process.env.FAKE_HERMES_NOISE) process.stdout.write('Note: a newer Hermes is available.\n');
  process.stdout.write(`${process.env.FAKE_HERMES_GARBAGE ?? JSON.stringify(cfg[key])}\n`);
} else if (a[0] === 'auth' && a[1] === 'list' && profile) {
  const cfg = JSON.parse(readFileSync(cfgFile(profile), 'utf8')) as Record<string, unknown>;
  const borrows = existsSync(join(dir(profile), 'borrowed')) && cfg['auth.adopt_external_logins'] !== false;
  if (existsSync(join(dir(profile), 'signed-in')) || borrows) process.stdout.write('provider-one (1 credentials):\n  #1  default  api_key  id=abc priority=0 env:KEY ←\n\n');
} else if (a[0] === 'acp' && profile) {
  // the agent itself: nothing to say here
} else {
  die(3, `fake hermes: unknown command ${JSON.stringify(argv)}`);
}
