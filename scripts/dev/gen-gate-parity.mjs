// scripts/dev/gen-gate-parity.mjs
// Writes test/fixtures/gate-parity-0.3.0.json from the compiled 0.3.0 decision functions (run `npm run build:ts` first).
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { needsApproval, decideGuard, stricterMode } = await import(pathToFileURL(join(root, 'dist', 'src', 'core', 'approvals.js')).href);

const MODES = ['ask', 'auto-edits', 'full'];
const CEILINGS = [null, 'ask', 'auto-edits', 'full'];
const TOOLS = [
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Bash', 'PowerShell', 'Monitor', 'mcp__host__shell',
  'mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop', 'mcp__legion__vm_status',
  'mcp__legion_board__board_delete', 'mcp__legion_connectors__github_issue_create',
  'mcp__someone__tool', 'UnknownTool',
];
const rows = [];
for (const mode of MODES) for (const ceiling of CEILINGS) for (const tool of TOOLS) for (const capped of [false, true]) {
  const eff = ceiling ? stricterMode(mode, ceiling) : mode;
  rows.push({ mode, ceiling, tool, capped, effective: eff, needsApproval: needsApproval(eff, tool, { capped }), guardCards: decideGuard(eff).needsCard });
}
// Provenance: the source commit this table was generated from (best effort; null outside a git checkout).
let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
const out = join(root, 'test', 'fixtures', 'gate-parity-0.3.0.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generatedFrom: '0.3.0 approvals.ts', generatedAt: new Date().toISOString(), commit, inputs: { MODES, CEILINGS, TOOLS }, rows }, null, 1) + '\n');
console.log(`wrote ${rows.length} rows to ${out}`);
