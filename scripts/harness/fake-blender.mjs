#!/usr/bin/env node
/**
 * A FAKE `blender` executable (a Node script). It never runs Blender or bpy. It exists so detection and the future local headless mode
 * can be exercised without Blender. Behaviour:
 *   --version                       prints "Blender 5.1.0" (override with FAKE_BLENDER_VERSION)
 *   --background ... --python FILE  records the call in FAKE_BLENDER_LOG (a file path, if set) and prints a marker line; the script file is NOT executed
 *   anything else                   exit 2
 * PENDING: the local headless mode (branch merge/blender) is not on this base; see docs/TESTING-BLENDER.md.
 */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = (obj) => { if (process.env.FAKE_BLENDER_LOG) { try { appendFileSync(process.env.FAKE_BLENDER_LOG, JSON.stringify(obj) + '\n'); } catch { /* ignore */ } } };
if (args.includes('--version') || args.includes('-v')) {
  log({ args });
  process.stdout.write(`Blender ${process.env.FAKE_BLENDER_VERSION || '5.1.0'}\n\tbuild date: fake\n`);
  process.exit(0);
}
const py = args.indexOf('--python');
if (args.includes('--background') || args.includes('-b')) {
  log({ args, python: py >= 0 ? args[py + 1] : null });
  process.stdout.write('FAKE_BLENDER: script not executed\n');
  process.exit(0);
}
process.stderr.write('FAKE_BLENDER: unsupported arguments\n');
process.exit(2);
