import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideGuard, needsApproval } from '../src/core/approvals.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import type { ApprovalMode } from '../src/shared/types.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const fx = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'gate-parity-0.3.0.json'), 'utf8')) as { rows: Array<{ mode: ApprovalMode; ceiling: ApprovalMode | null; tool: string; capped: boolean; needsApproval: boolean; guardCards: boolean }> };

test('the fixture is the full grid', () => {
  assert.equal(fx.rows.length, 552);
});

test('no gate settings (Per agent projects, agents with their own mode) reproduce every 0.3.0 decision, for a project run and for a run with no project', () => {
  const core = createGatesCore({ dataDir: join(cleanupTemp('legion-parity-'), 'data') });
  for (const pid of ['proj_000000000abc', undefined]) {
    for (const r of fx.rows) {
      const eff = core.resolver.mode({ agentMode: r.mode, ...(pid ? { startProjectId: pid } : {}), ...(r.ceiling ? { ceiling: r.ceiling } : {}) });
      assert.equal(needsApproval(eff, r.tool, { capped: r.capped }), r.needsApproval, `needsApproval ${JSON.stringify(r)} project=${pid}`);
      assert.equal(decideGuard(eff).needsCard, r.guardCards, `guard ${JSON.stringify(r)} project=${pid}`);
    }
  }
});
