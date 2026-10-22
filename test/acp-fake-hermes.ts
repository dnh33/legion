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
 * Switches for the failure tests: FAKE_HERMES_SHOW_ERROR (`profile show` fails the way a stale saved profile does), FAKE_HERMES_NOISE (a
 * notice line before the JSON of `config get`), FAKE_HERMES_LEAK (`config set` fails with a key-shaped value in its message).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const state = process.env.FAKE_HERMES_STATE ?? '';
const log = process.env.FAKE_HERMES_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);

let a = [...argv];
let profile: string | undefined;
if (a[0] === '-p') { profile = a[1]; a = a.slice(2); }
const dir = (name: string) => join(state, 'profiles', name);
const cfgFile = (name: string) => join(dir(name), 'config.json');
const die = (code: number, text: string): never => { process.stderr.write(`${text}\n`); process.exit(code); };

if (a[0] === 'profile' && a[1] === 'show') {
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
} else if (a[0] === 'config' && a[1] === 'get' && profile) {
  if (!existsSync(dir(profile))) die(1, `Error: Profile '${profile}' does not exist.`);
  const key = a[2] ?? '';
  const cfg = JSON.parse(readFileSync(cfgFile(profile), 'utf8')) as Record<string, unknown>;
  if (!(key in cfg)) die(1, `Config key not set: ${key}`);
  if (process.env.FAKE_HERMES_NOISE) process.stdout.write('Note: a newer Hermes is available.\n');
  process.stdout.write(`${JSON.stringify(cfg[key])}\n`);
} else if (a[0] === 'auth' && a[1] === 'list' && profile) {
  const cfg = JSON.parse(readFileSync(cfgFile(profile), 'utf8')) as Record<string, unknown>;
  const borrows = existsSync(join(dir(profile), 'borrowed')) && cfg['auth.adopt_external_logins'] !== false;
  if (existsSync(join(dir(profile), 'signed-in')) || borrows) process.stdout.write('provider-one (1 credentials):\n  #1  default  api_key  id=abc priority=0 env:KEY ←\n\n');
} else if (a[0] === 'acp' && profile) {
  // the agent itself: nothing to say here
} else {
  die(3, `fake hermes: unknown command ${JSON.stringify(argv)}`);
}
