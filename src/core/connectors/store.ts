/**
 * Encrypted connector token store: `<dataDir>/connectors/oauth.json`.
 *
 * File layout (binary): version byte | 12-byte IV | 16-byte GCM tag | ciphertext. AES-256-GCM, a fresh random IV for every write, and the
 * version byte is bound as AAD, so a downgraded or altered version byte fails authentication. The plaintext is one JSON document
 * (`{ v, connectors: { <id>: <record> } }`); nothing about it (no issuer, no names) is readable in the file.
 *
 * - One in-process queue serialises every read-modify-write, so two refreshes cannot overwrite each other (a rotated refresh token is
 *   persisted before it is used; the caller does that inside `update`).
 * - A wrong key, a flipped byte or an unknown version reads as empty and `status()` says `sign-in-again`. The file is left untouched
 *   until the next successful write.
 * - Without a key (headless core, no keyring, before the first Connect) the store is memory-only and writes nothing.
 *
 * Scope (design 4.4): this keeps a copied or offline file unreadable. It is no defence against code running as the same user.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tightenConfigMode } from '../../shared/config.js';
import { DATA_KEY_BYTES } from './keyring.js';

export const BLOB_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = 1 + IV_BYTES + TAG_BYTES;
export const BLOB_FILE = 'oauth.json';

export type StoreStatus = 'ok' | 'empty' | 'sign-in-again' | 'memory-only';
interface Doc { v: number; connectors: Record<string, unknown> }
export interface KeySource { get(): Buffer | undefined }

/** Encrypts a document. `version` is the AAD; exported for the tests that build foreign blobs. */
export function sealBlob(key: Buffer, plaintext: Buffer, version = BLOB_VERSION): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from([version]));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([Buffer.from([version]), iv, c.getAuthTag(), ct]);
}

/** The plaintext, or undefined for any failure (short file, unknown version, wrong key, tampering). Never throws. */
export function openBlob(key: Buffer, blob: Buffer): Buffer | undefined {
  try {
    if (key.length !== DATA_KEY_BYTES || blob.length < HEADER) return undefined;
    const version = blob[0]!;
    if (version !== BLOB_VERSION) return undefined;
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 1 + IV_BYTES));
    d.setAAD(Buffer.from([version]));
    d.setAuthTag(blob.subarray(1 + IV_BYTES, HEADER));
    return Buffer.concat([d.update(blob.subarray(HEADER)), d.final()]);
  } catch { return undefined; }
}

let seq = 0;
/** Atomic, owner-only write of bytes: a unique temp file in the same folder, then a rename. */
async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
  try {
    try { await rename(tmp, file); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') throw e;
      await unlink(file).catch(() => undefined);
      await rename(tmp, file);
    }
  } catch (e) { await unlink(tmp).catch(() => undefined); throw e; }
  tightenConfigMode(file);
}

export class TokenStore {
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private mem = new Map<string, unknown>();
  private last: StoreStatus = 'empty';

  /** `dir` is `<dataDir>/connectors`. */
  constructor(dir: string, private readonly keys: KeySource) { this.file = join(dir, BLOB_FILE); }

  /** Runs `fn` after every earlier operation has finished. A failure of one operation does not block the next. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async load(key: Buffer): Promise<Doc> {
    let blob: Buffer;
    try { blob = await readFile(this.file); } catch { this.last = 'empty'; return { v: BLOB_VERSION, connectors: {} }; }
    const plain = openBlob(key, blob);
    if (plain) {
      try {
        const j = JSON.parse(plain.toString('utf8')) as Partial<Doc>;
        if (j && typeof j === 'object' && j.connectors && typeof j.connectors === 'object') { this.last = 'ok'; return { v: BLOB_VERSION, connectors: { ...j.connectors } }; }
      } catch { /* falls through: authentic but unreadable counts as empty */ }
    }
    this.last = 'sign-in-again';
    return { v: BLOB_VERSION, connectors: {} };
  }

  private async save(key: Buffer, doc: Doc): Promise<void> {
    await writeAtomic(this.file, sealBlob(key, Buffer.from(JSON.stringify(doc), 'utf8')));
    this.last = 'ok';
  }

  /** The record for a connector, or undefined (none stored, no key and nothing in memory, or the file did not authenticate). */
  get<T = unknown>(id: string): Promise<T | undefined> {
    return this.run(async () => {
      const key = this.keys.get();
      if (!key) { this.last = 'memory-only'; return this.mem.get(id) as T | undefined; }
      return (await this.load(key)).connectors[id] as T | undefined;
    });
  }

  /**
   * Read-modify-write of one record, serialised with every other operation. `fn` gets the current record (undefined when none) and returns
   * the new one, or undefined to delete it. Returns what was stored.
   */
  update<T>(id: string, fn: (current: T | undefined) => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    return this.run(async () => {
      const key = this.keys.get();
      if (!key) {
        this.last = 'memory-only';
        const next = await fn(this.mem.get(id) as T | undefined);
        if (next === undefined) this.mem.delete(id); else this.mem.set(id, next);
        return next;
      }
      const doc = await this.load(key);
      const next = await fn(doc.connectors[id] as T | undefined);
      if (next === undefined) delete doc.connectors[id]; else doc.connectors[id] = next;
      await this.save(key, doc);
      return next;
    });
  }

  set<T>(id: string, value: T): Promise<void> { return this.update<T>(id, () => value).then(() => undefined); }
  remove(id: string): Promise<void> { return this.update(id, () => undefined).then(() => undefined); }

  /** What the owner should be told: ok, empty, sign-in-again (the file did not authenticate), memory-only (no key). */
  status(): Promise<StoreStatus> {
    return this.run(async () => {
      const key = this.keys.get();
      if (!key) return (this.last = 'memory-only');
      await this.load(key);
      return this.last;
    });
  }
}
