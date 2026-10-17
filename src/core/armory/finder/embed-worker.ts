/**
 * The helper process of the skill finder's local model. local-model.ts starts it; nothing else does.
 *
 * It imports nothing from Legion, only Node's own modules, because it runs as a separate process. It loads the pinned files from
 * the model folder (argv[2]): an ONNX runtime built for WebAssembly, a tokenizer library and the multilingual-e5-small model.
 * About 1 GB of memory, which is why it is a process of its own and stops when it is idle.
 *
 * Integrity, at load time: argv[3] is the pin (name, size and sha256 of every file). The worker reads each file's bytes ONCE, checks
 * the size and the sha256, and uses those very bytes: the model goes to the runtime as bytes, the tokenizer files are parsed from
 * them, the .wasm is handed over as wasmBinary, and the two .mjs files marked below are imported from a data: address of the
 * verified bytes. Any mismatch ends the worker with { fatal, integrity: true } before anything runs.
 *
 * What is still not covered: the runtime's own loader (ort-wasm-simd-threaded.mjs) cannot be imported from a data: address (it calls
 * createRequire(import.meta.url), which needs a file address; tried under Node and Electron's Node). It is imported from the file
 * straight after the check, in the same step, so the gap is the time between reading it and Node reading it again. Someone who can
 * write into your Legion folder in that moment can already change the files Legion itself runs.
 *
 * Messages in:  { id, kind: 'query' | 'passage', texts: string[] }
 * Messages out: { id, vectors: number[][] } or { id, error: string }, and once { ready: true } after the model is loaded.
 *
 * A query is answered before the rest of a passage batch: texts are embedded in small chunks, and between chunks the next job is
 * the oldest query if there is one.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_TOKENS = 128;
const CHUNK = 2;
const MODEL_FILE = 'model_qint8_avx512_vnni.onnx';
const ORT_FILE = 'ort.wasm.min.mjs';
const GLUE_FILE = 'ort-wasm-simd-threaded.mjs';
const WASM_FILE = 'ort-wasm-simd-threaded.wasm';
const TOKENIZER_LIB = 'tokenizers.min.mjs';
const TOKENIZER_JSON = 'tokenizer.json';
const TOKENIZER_CONFIG = 'tokenizer_config.json';

type Kind = 'query' | 'passage';
interface Job { id: number; kind: Kind; texts: string[]; done: number[][]; }
interface Encoded { ids: number[] }
interface Tok { encode(text: string): Encoded }
interface Tensor { dims: number[]; data: Float32Array }
interface Session { inputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>> }
interface Ort {
  env: { wasm: { numThreads: number; wasmPaths: string | { mjs: string }; wasmBinary: Uint8Array; proxy: boolean } };
  InferenceSession: { create(bytes: Uint8Array, opts: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

const modelDir = process.argv[2] ?? '';
const send = (m: Record<string, unknown>): void => { try { process.send?.(m); } catch { /* the parent is gone */ } };

class IntegrityError extends Error {}
interface PinnedFile { name: string; bytes: number; sha256: string }

/** Reads every pinned file once and returns the bytes that matched. Throws IntegrityError on the first file that is missing, the wrong size or the wrong hash. */
function readVerified(): Map<string, Buffer> {
  let pin: PinnedFile[];
  try { pin = JSON.parse(process.argv[3] ?? '') as PinnedFile[]; } catch { throw new IntegrityError('No pin was given, so the model files cannot be checked.'); }
  if (!Array.isArray(pin) || pin.length === 0) throw new IntegrityError('No pin was given, so the model files cannot be checked.');
  const out = new Map<string, Buffer>();
  for (const f of pin) {
    if (typeof f?.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(f.name) || typeof f.sha256 !== 'string' || !Number.isFinite(f.bytes)) throw new IntegrityError('The pin is not valid.');
    let bytes: Buffer;
    try { bytes = readFileSync(join(modelDir, f.name)); } catch { throw new IntegrityError(`${f.name} is missing.`); }
    if (bytes.length !== f.bytes) throw new IntegrityError(`${f.name} has the wrong size.`);
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256.toLowerCase()) throw new IntegrityError(`${f.name} does not match its sha256.`);
    out.set(f.name, bytes);
  }
  for (const name of [ORT_FILE, GLUE_FILE, WASM_FILE, TOKENIZER_LIB, MODEL_FILE, TOKENIZER_JSON, TOKENIZER_CONFIG]) {
    if (!out.has(name)) throw new IntegrityError(`${name} is not in the pin.`);
  }
  return out;
}

/** A data: address of verified bytes, so Node runs exactly the bytes that were hashed. */
const dataUrl = (b: Buffer): string => `data:text/javascript;base64,${b.toString('base64')}`;

let loaded: Promise<{ ort: Ort; tok: Tok; session: Session }> | undefined;
function load(): Promise<{ ort: Ort; tok: Tok; session: Session }> {
  loaded ??= (async () => {
    const files = readVerified();
    const get = (n: string): Buffer => files.get(n)!;
    const mod = (await import(dataUrl(get(ORT_FILE)))) as { default?: Ort } & Ort;
    const ort = mod.default ?? mod;
    ort.env.wasm.numThreads = 1; // more threads fail to load from a file address
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmBinary = new Uint8Array(get(WASM_FILE));
    // The runtime's loader: the one file that is imported from disk (see the top of this file). It is imported right after the check.
    ort.env.wasm.wasmPaths = { mjs: pathToFileURL(join(modelDir, GLUE_FILE)).href };
    const { Tokenizer } = (await import(dataUrl(get(TOKENIZER_LIB)))) as { Tokenizer: new (json: unknown, config: unknown) => Tok };
    const tok = new Tokenizer(JSON.parse(get(TOKENIZER_JSON).toString('utf8')), JSON.parse(get(TOKENIZER_CONFIG).toString('utf8')));
    const session = await ort.InferenceSession.create(new Uint8Array(get(MODEL_FILE)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return { ort, tok, session };
  })();
  return loaded;
}

/** At most MAX_TOKENS tokens; a longer text is cut but keeps its closing </s> (the last id). */
function cut(ids: number[]): number[] {
  if (ids.length <= MAX_TOKENS) return ids;
  return [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]!];
}

/** Mean-pool over the attention mask, then scale to unit length. */
async function embedChunk(texts: string[], kind: Kind): Promise<number[][]> {
  const { ort, tok, session } = await load();
  const prefix = kind === 'query' ? 'query: ' : 'passage: ';
  const encs = texts.map((t) => cut(tok.encode(prefix + t).ids));
  const B = texts.length;
  const L = Math.max(...encs.map((e) => e.length));
  const ids = new BigInt64Array(B * L);
  const mask = new BigInt64Array(B * L);
  encs.forEach((e, i) => { for (let j = 0; j < e.length; j++) { ids[i * L + j] = BigInt(e[j]!); mask[i * L + j] = 1n; } });
  const feeds: Record<string, unknown> = { input_ids: new ort.Tensor('int64', ids, [B, L]), attention_mask: new ort.Tensor('int64', mask, [B, L]) };
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(B * L), [B, L]);
  const out = await session.run(feeds);
  const h = out.last_hidden_state;
  if (!h) throw new Error('The model gave no last_hidden_state.');
  const D = h.dims[2]!;
  const res: number[][] = [];
  for (let i = 0; i < B; i++) {
    const v = new Float64Array(D);
    let n = 0;
    for (let j = 0; j < L; j++) {
      if (!mask[i * L + j]) continue;
      n++;
      for (let k = 0; k < D; k++) v[k]! += h.data[(i * L + j) * D + k]!;
    }
    let norm = 0;
    for (let k = 0; k < D; k++) { v[k] = v[k]! / n; norm += v[k]! * v[k]!; }
    norm = Math.sqrt(norm) || 1;
    res.push(Array.from(v, (x) => x / norm));
  }
  return res;
}

const queue: Job[] = [];
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // The oldest query first; else the oldest passage job.
      const at = queue.findIndex((j) => j.kind === 'query');
      const job = queue[at === -1 ? 0 : at]!;
      try {
        const from = job.done.length;
        job.done.push(...(await embedChunk(job.texts.slice(from, from + CHUNK), job.kind)));
        // The model runs synchronously, so without this the event loop never reads a query that arrives mid-batch.
        await new Promise<void>((r) => setImmediate(r));
        if (job.done.length >= job.texts.length) { queue.splice(queue.indexOf(job), 1); send({ id: job.id, vectors: job.done }); }
      } catch (e) {
        queue.splice(queue.indexOf(job), 1);
        send({ id: job.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally { running = false; }
}

process.on('message', (m: unknown) => {
  const r = m as { id?: unknown; kind?: unknown; texts?: unknown };
  if (typeof r?.id !== 'number') return;
  if ((r.kind !== 'query' && r.kind !== 'passage') || !Array.isArray(r.texts) || r.texts.some((t) => typeof t !== 'string')) { send({ id: r.id, error: 'Bad request.' }); return; }
  if (r.texts.length === 0) { send({ id: r.id, vectors: [] }); return; }
  queue.push({ id: r.id, kind: r.kind, texts: r.texts as string[], done: [] });
  void pump();
});
process.on('disconnect', () => process.exit(0));

load().then(() => send({ ready: true }), (e: unknown) => {
  const m = { fatal: e instanceof Error ? e.message : String(e), integrity: e instanceof IntegrityError };
  setTimeout(() => process.exit(1), 2000).unref(); // if the message never leaves
  try { process.send?.(m, () => process.exit(1)); } catch { process.exit(1); }
});
