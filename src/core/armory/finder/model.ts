/**
 * The skill finder's local model as the Armory sees it: its status, the download behind an approval card, removal, and the embedder
 * (a helper process, see local-model.ts) once the files are there. Nothing here starts on its own: a download needs the owner's
 * click and an approval, and an agent has no route to it.
 */
import { statSync } from 'node:fs';
import { createGetBlenderPorts } from '../../blender/system.js';
import type { ApprovalBroker } from '../../approvals.js';
import { FINDER_MODEL_ASKER, FINDER_MODEL_PIN, FINDER_MODEL_TAMPERED, FINDER_MODEL_TOOL } from '../../../shared/finder.js';
import type { FinderModelPin, FinderModelStatus } from '../../../shared/finder.js';
import type { Embedder } from './embed.js';
import { getModel, installedBytes, modelDirFor, readInstalled, removeModel } from './get-model.js';
import type { GetModelApproval, GetModelPorts, GetModelResult } from './get-model.js';
import { createLocalModel } from './local-model.js';
import type { LocalEmbedder, LocalModelOpts } from './local-model.js';

export interface FinderModelOpts {
  /** Tests pass fakes; the real ports are the Blender ones (https and public hosts only, size capped, hashed while streaming). */
  ports?: GetModelPorts;
  pin?: FinderModelPin;
  /** Replaces the approval card. Tests only. */
  approve?: (a: GetModelApproval) => Promise<boolean>;
  /** The helper process: tests pass a fake script and a short idle time. */
  worker?: Partial<Pick<LocalModelOpts, 'workerPath' | 'idleMs' | 'timeoutMs'>>;
  log?: (m: string) => void;
}

export interface FinderModel {
  status(): FinderModelStatus;
  /** True when the pinned files are installed. A short memo keeps the per-message check cheap. */
  ready(): boolean;
  /** Whether a download is waiting for approval or running. */
  busy(): boolean;
  get(): Promise<GetModelResult & { status: FinderModelStatus }>;
  remove(): FinderModelStatus;
  /** The local embedder, or undefined while the model is not installed. */
  embedder(): Embedder | undefined;
  /** The helper process, for tests and tooling. */
  helper(): LocalEmbedder | undefined;
  dispose(): void;
}

const READY_MEMO_MS = 10_000;

export function createFinderModel(deps: { dataDir: string; approvals?: Pick<ApprovalBroker, 'request'> }, o: FinderModelOpts = {}): FinderModel {
  const pin = o.pin ?? FINDER_MODEL_PIN;
  const ports: GetModelPorts = o.ports ?? { ...createGetBlenderPorts(), size: (p) => { try { return statSync(p).size; } catch { return undefined; } } };
  const log = o.log ?? (() => undefined);
  let getting = false;
  let progress = 0;
  let lastError: string | undefined;
  let memo: { at: number; ok: boolean } | undefined;
  let local: LocalEmbedder | undefined;
  // Set when the helper found a file that no longer matches its pin. The finder then uses keywords until the model is removed and fetched again.
  let tampered = false;

  const installed = () => readInstalled(ports, deps.dataDir, pin);
  const ready = (): boolean => {
    if (tampered) return false;
    const t = Date.now();
    if (memo && t - memo.at < READY_MEMO_MS) return memo.ok;
    const ok = installed() !== null;
    memo = { at: t, ok };
    return ok;
  };
  const status = (): FinderModelStatus => {
    if (getting) return { state: 'downloading', progress };
    if (tampered) return { state: 'error', error: FINDER_MODEL_TAMPERED };
    const rec = installed();
    if (rec) return { state: 'ready', bytes: installedBytes(rec) };
    return lastError ? { state: 'error', error: lastError } : { state: 'not-installed' };
  };
  const stopHelper = (): void => { local?.dispose(); local = undefined; };

  return {
    status, ready,
    busy: () => getting,
    async get() {
      getting = true; progress = 0; lastError = undefined; memo = undefined;
      try {
        const approve = o.approve ?? ((card: GetModelApproval) => {
          if (!deps.approvals) return Promise.resolve(false);
          return deps.approvals.request('skill-finder-model', FINDER_MODEL_ASKER, FINDER_MODEL_TOOL, { ...card }, undefined, { summary: card.summary });
        });
        const r = await getModel(ports, { dataDir: deps.dataDir, pin, approve, onProgress: (p) => { progress = p; } });
        if (!r.ok && !r.denied) lastError = r.steps.at(-1)?.detail ?? 'The download failed.';
        log(r.ok ? 'armory: the skill finder model is installed' : r.denied ? 'armory: the skill finder model download was not approved' : `armory: the skill finder model download failed: ${lastError}`);
        memo = undefined;
        getting = false;
        return { ...r, status: status() };
      } finally { getting = false; }
    },
    remove() {
      stopHelper();
      removeModel(ports, deps.dataDir);
      lastError = undefined; memo = undefined; tampered = false;
      log('armory: the skill finder model was removed');
      return status();
    },
    embedder() {
      if (!ready()) return undefined;
      local ??= createLocalModel({
        modelDir: modelDirFor(deps.dataDir, pin), id: pin.id,
        files: pin.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
        log,
        onIntegrity: (why) => { tampered = true; memo = undefined; log(`armory: the skill finder model was refused: ${why}`); },
        ...(o.worker ?? {}),
      });
      return local;
    },
    helper: () => local,
    dispose: stopHelper,
  };
}
