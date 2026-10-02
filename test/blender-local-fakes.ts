/** A fake LocalPort for the routing and guard tests (the real runner is local.ts; these tests never start a process). */
import type { AgentProfile } from '../src/shared/types.js';
import type { BackendResult } from '../src/core/blender/backend.js';
import type { LocalPort, LocalRunResult } from '../src/core/blender/ports.js';

export class FakeLocal implements LocalPort {
  ready = { ready: true, note: 'Blender 5.1.0 found on this computer' };
  runs: Array<{ taskId: string; script: string; hash: string; timeoutMs: number }> = [];
  inspects = 0;
  previews = 0;
  /** Called at the start of run(), before `result` is returned (tests read the audit file here, or hold the run open). */
  onRun: () => Promise<void> | void = () => undefined;
  result: LocalRunResult = { ok: true, text: 'local ran', files: [] };
  throws?: string;
  inFlight = 0;
  maxInFlight = 0;
  readiness(_a?: AgentProfile) { return this.ready; }
  async run(r: { taskId: string; script: string; hash: string; timeoutMs: number }): Promise<LocalRunResult> {
    this.runs.push({ taskId: r.taskId, script: r.script, hash: r.hash, timeoutMs: r.timeoutMs });
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.onRun();
      if (this.throws) throw new Error(this.throws);
      return this.result;
    } finally { this.inFlight--; }
  }
  async inspect(): Promise<BackendResult> { this.inspects++; return { ok: true, text: 'local scene', images: [] }; }
  async preview(): Promise<BackendResult> { this.previews++; return { ok: true, text: 'local preview', images: [{ mime: 'image/png', data: 'CCCC' }] }; }
}
