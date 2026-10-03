// Prints the sha256 (CRLF normalised to LF) of the two pinned BSV files, for test/bsv-scan.ts SPEND_PINS. Reads two local files, does nothing else:
// no network, no writes. An update of a pin needs the reviewer's sign-off in the PR (claude/plan-bsv-rung3.md section 5).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const f of ['src/core/bsv/spend.ts', 'src/core/bsv/networks.ts']) {
  const text = readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
  console.log(`${f} ${createHash('sha256').update(text).digest('hex')}`);
}
