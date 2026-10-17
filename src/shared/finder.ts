/**
 * The one local embedding model the skill finder can download, pinned: every file has an address, a size and a sha256 that
 * live in code. Legion fetches nothing until you approve a card that names them, and a file whose hash differs is never used.
 *
 * The runtime (an ONNX engine built for WebAssembly) and the tokenizer library are plain files that a small helper
 * process loads from the model folder. Nothing is installed with npm.
 */

/** The tool name on the approval card. */
export const FINDER_MODEL_TOOL = 'get_skill_finder_model';
/** The id the card is raised under (it is not an agent). */
export const FINDER_MODEL_ASKER = 'skill-finder';

export type FinderModelRole = 'runtime' | 'tokenizer-lib' | 'model' | 'tokenizer' | 'tokenizer-config';

export interface FinderModelFile {
  /** The file name inside the model folder. */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  role: FinderModelRole;
}

export interface FinderModelPin {
  id: string;
  /** The model repository revision. It names the folder, so a new pin never mixes with old files. */
  revision: string;
  license: string;
  approxBytes: number;
  /** Where the sources live, for the card. */
  sources: string[];
  /**
   * The hosts a download may touch: the pinned addresses and every redirect they really lead to. An entry matches that host and
   * its subdomains. A download that is sent anywhere else is refused before a byte is read.
   */
  allowedHosts: string[];
  files: FinderModelFile[];
}

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist';
const HF = 'https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx';

export const FINDER_MODEL_PIN: FinderModelPin = {
  id: 'multilingual-e5-small-int8',
  revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
  license: 'MIT (model), MIT (runtime), Apache-2.0 (tokenizer)',
  approxBytes: 14239897 + 50126 + 24381 + 36601 + 118346824 + 17082730 + 443,
  sources: [
    'https://huggingface.co/intfloat/multilingual-e5-small',
    'https://github.com/microsoft/onnxruntime',
    'https://github.com/huggingface/tokenizers.js',
  ],
  // Found with one HEAD request per pinned address, redirects followed by hand: jsdelivr answers itself; huggingface.co sends the
  // big files to its CDN (seen: us.aws.cdn.hf.co, a region name in front of cdn.hf.co, so the whole cdn.hf.co domain is allowed)
  // and answers tokenizer_config.json with a redirect to another path on huggingface.co. Other regions were not observed.
  allowedHosts: ['cdn.jsdelivr.net', 'huggingface.co', 'cdn.hf.co'],
  files: [
    { name: 'ort.wasm.min.mjs', url: `${ORT}/ort.wasm.min.mjs`, bytes: 50126, sha256: '219e6a1fc8a9938268d18efca3c91d310bd2f4a59bbd13744df5b2b7fc6cee3b', role: 'runtime' },
    { name: 'ort-wasm-simd-threaded.mjs', url: `${ORT}/ort-wasm-simd-threaded.mjs`, bytes: 24381, sha256: 'e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b', role: 'runtime' },
    { name: 'ort-wasm-simd-threaded.wasm', url: `${ORT}/ort-wasm-simd-threaded.wasm`, bytes: 14239897, sha256: '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2', role: 'runtime' },
    { name: 'tokenizers.min.mjs', url: 'https://cdn.jsdelivr.net/npm/@huggingface/tokenizers@0.2.0/dist/tokenizers.min.mjs', bytes: 36601, sha256: '258e46332101335ce8d95aed7745b19ac3b46d37f3e159a89cf894c2ea9b1d3a', role: 'tokenizer-lib' },
    { name: 'model_qint8_avx512_vnni.onnx', url: `${HF}/model_qint8_avx512_vnni.onnx`, bytes: 118346824, sha256: 'dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88', role: 'model' },
    { name: 'tokenizer.json', url: `${HF}/tokenizer.json`, bytes: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39', role: 'tokenizer' },
    { name: 'tokenizer_config.json', url: `${HF}/tokenizer_config.json`, bytes: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b', role: 'tokenizer-config' },
  ],
};

/** Whether a download address is https and on one of the pin's allowed hosts (the host itself or a subdomain of it). */
export function finderHostOk(url: string, pin: Pick<FinderModelPin, 'allowedHosts'> = FINDER_MODEL_PIN): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return pin.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The text shown when a model file no longer matches its pin. */
export const FINDER_MODEL_TAMPERED = 'The model files changed on your computer. Remove the model and get it again.';

/** The state the model routes report. */
export interface FinderModelStatus {
  state: 'not-installed' | 'downloading' | 'ready' | 'error';
  /** 0..1 while downloading: whole files done over all files. */
  progress?: number;
  error?: string;
  /** Bytes on disk when ready. */
  bytes?: number;
}
