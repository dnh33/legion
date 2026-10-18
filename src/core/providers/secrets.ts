/**
 * Provider API keys. With a data key (Electron main wraps one with the OS keystore and hands it to the core at launch) they live
 * encrypted in <dataDir>/providers/keys.enc; without one they live in <dataDir>/providers/keys.json (owner read/write only, atomic
 * write). Never in config.json. Each key is stored with the origin it was saved for and is handed out only for that origin, so
 * repointing a provider at another host cannot send the key there.
 *
 * Encryption keeps keys unreadable to anyone who copies the Legion data folder or a backup, and to an agent that reads the file. A
 * program running as the same user can still ask the system key store for the data key.
 *
 * Rules (keys-plan.md): K1 migration seals keys.json, reads it back, and keeps keys.json for a rollback to 0.3.4 until the update is
 * committed AND a later start opened keys.enc. K2 no data key because the system has no usable key store (or Legion runs without the
 * app): exactly the old keys.json store. K3 a system that CAN encrypt but whose key store did not unlock (key.bin does not unwrap, or
 * keys.enc does not open with the key): keys read as not set, nothing is deleted, and SAVES ARE REFUSED (never a plain fallback on a
 * machine that can encrypt). `startOver()`, reached only through the app's confirmation, sets the unreadable keys.enc aside.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tightenConfigMode, writeConfigFile } from '../../shared/config.js';
import { openBlob, sealBlob } from '../connectors/store.js';
import { renameWithRetry } from '../../shared/rename-retry.js';
import { registerSecret } from '../log/redact.js';
import { KEYS_BLOCKED_MESSAGE, type KeyStoreState } from '../../shared/providers-view.js';

export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 500;
export const keyFileFor = (dataDir: string): string => join(dataDir, 'providers', 'keys.json');
/** The sealed file next to keys.json. A NEW name on purpose: 0.3.4 reads an unparseable keys.json as empty and overwrites it. */
export const sealedFileFor = (dataDir: string): string => join(dataDir, 'providers', 'keys.enc');
export { KEYS_BLOCKED_MESSAGE };

interface Stored { key: string; origin: string }
type Doc = Record<string, Stored>;

/** Why keys.json (not keys.enc) holds the keys on this system. */
export type PlainReason = 'unavailable' | 'headless' | 'unreadable' | 'sealing-failed';
export interface KeyStoreStatus {
  /** 'encrypted': a data key is in use, so keys live in keys.enc. 'plain': the owner-only keys.json is the store. */
  mode: 'encrypted' | 'plain';
  /** keys.enc exists and was not opened: the saved keys could not be unlocked (they read as not set). */
  locked: boolean;
  reason?: PlainReason;
  /** The key store did not unlock (key.bin or keys.enc unreadable): saves are refused until the owner restarts or starts over. Present only when true. */
  blocked?: true;
}
export interface ProviderKeysOptions {
  /** The 256-bit data key Electron main unwrapped (handed over on the launch pipe). With it keys live in keys.enc. */
  dataKey?: Buffer;
  /** No data key, and why, when Electron said so. With neither option the core was started without the app. */
  noKey?: 'unavailable' | 'unreadable' | 'headless';
  /** The core was started by the app (the admin pipe is there). With no key line that means "no key", not "no app". */
  launchedByApp?: boolean;
  /** Is the update that is running committed? Decides when keys.json may be retired. Default: yes (not started by the updater). */
  committed?: () => boolean;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function parseDoc(json: unknown): Doc | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const keys = (json as { keys?: unknown }).keys;
  if (keys !== undefined && (!keys || typeof keys !== 'object' || Array.isArray(keys))) return undefined;
  const out: Doc = {};
  for (const [id, v] of Object.entries((keys ?? {}) as Record<string, Partial<Stored>>)) if (v && typeof v.key === 'string' && typeof v.origin === 'string') out[id] = { key: v.key, origin: v.origin };
  return out;
}

export class ProviderKeys {
  private map = new Map<string, Stored>();
  private readonly dataKey: Buffer | undefined;
  private readonly sealedFile: string;
  private readonly keepState: string;
  private encrypted = false;
  private locked = false;
  private reason: PlainReason | undefined;
  /** keys.json is still written next to keys.enc (the keep window for a rollback to 0.3.4). */
  private keepCopy = false;
  /** The system can encrypt but its key store did not unlock: reads show nothing new and every save is refused. */
  private blocked = false;

  constructor(private readonly file: string, private readonly opts: ProviderKeysOptions = {}) {
    this.dataKey = opts.dataKey && opts.dataKey.length > 0 ? Buffer.from(opts.dataKey) : undefined;
    this.sealedFile = join(dirname(file), `${basename(file, '.json')}.enc`);
    this.keepState = join(dirname(file), 'keys-keep.json');
    this.load();
    // the log redactor knows every key the core holds from now on, in every common text encoding (keys of a shape no log rule knows included)
    for (const s of this.map.values()) registerSecret(s.key);
  }

  status(): KeyStoreStatus {
    return { mode: this.encrypted ? 'encrypted' : 'plain', locked: this.locked, ...(this.encrypted ? {} : { reason: this.reason ?? 'headless' }), ...(this.blocked ? { blocked: true as const } : {}) };
  }

  // ---- reading

  private readPlain(): { doc: Doc; text: string } | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const text = readFileSync(this.file, 'utf8');
      const doc = parseDoc(JSON.parse(text));
      return { doc: doc ?? {}, text };
    } catch { return { doc: {}, text: '' }; /* an unreadable file holds no keys; the next save replaces it */ }
  }

  /** 'none' = no keys.enc; 'bad' = it is there and does not open with this key; else its keys and the digest of the keys.json it was last written with. */
  private readSealed(): 'none' | 'bad' | { doc: Doc; digest?: string } {
    if (!this.dataKey || !existsSync(this.sealedFile)) return 'none';
    try {
      const plain = openBlob(this.dataKey, readFileSync(this.sealedFile));
      if (!plain) return 'bad';
      const j = JSON.parse(plain.toString('utf8')) as { keys?: unknown; jsonDigest?: unknown };
      const doc = parseDoc(j);
      if (!doc || !j.keys) return 'bad';
      return { doc, ...(typeof j.jsonDigest === 'string' ? { digest: j.jsonDigest } : {}) };
    } catch { return 'bad'; }
  }

  private setMap(doc: Doc): void { this.map.clear(); for (const [id, v] of Object.entries(doc)) this.map.set(id, v); }

  private load(): void {
    this.map.clear();
    this.encrypted = false; this.locked = false; this.reason = undefined; this.keepCopy = false; this.blocked = false;
    const plain = this.readPlain();
    if (!this.dataKey) { // K2: today's behaviour, keys.json. K3 for a wrapped key that does not open: reads as before, saves refused.
      if (plain) this.setMap(plain.doc);
      this.reason = this.opts.noKey ?? (this.opts.launchedByApp ? 'unavailable' : 'headless');
      this.locked = existsSync(this.sealedFile); // keys sealed earlier cannot be opened without the key; the file stays where it is
      // A machine that ever encrypted (key.bin or keys.enc is there) never turns into plain writes because the key store is down right now.
      // A core started without the app (no key line, no admin pipe) keeps today's plain behaviour.
      const fromApp = this.opts.noKey === 'unavailable' || (this.opts.noKey === undefined && !!this.opts.launchedByApp);
      const everEncrypted = this.locked || existsSync(join(dirname(this.file), 'key.bin'));
      this.blocked = this.opts.noKey === 'unreadable' || (fromApp && everEncrypted);
      return;
    }
    this.encrypted = true;
    const sealed = this.readSealed();
    const hasPlainKeys = !!plain && Object.keys(plain.doc).length > 0;
    if (sealed === 'none') {
      if (hasPlainKeys) this.migrate(plain!, false);
      else this.keepCopy = !!plain;
      return;
    }
    if (sealed === 'bad') {
      if (hasPlainKeys) { this.migrate(plain!, true); return; } // the keep copy still has everything: rebuild from it
      this.locked = true; this.blocked = true; this.keepCopy = !!plain;
      return;
    }
    this.setMap(sealed.doc);
    if (!plain) return;
    this.keepCopy = true;
    if (plain.text !== '' && sealed.digest === sha(plain.text)) { this.maybeRetire(); return; }
    // keys.json is not what we wrote last. A keys.json that cannot be read says nothing: keys.enc stands.
    if (plain.text === '') return;
    // keys.enc was written WITH a copy (it carries that copy's digest): 0.3.4 changed the copy, so while keys.json exists it is the truth,
    // and a key it no longer names was removed there and is removed here. keys.enc written without a copy: keys.json is a later file from
    // a downgrade that could not see keys.enc, so nothing in it can have been removed on purpose and both sets are kept.
    if (sealed.digest !== undefined) this.setMap(plain.doc);
    else for (const [id, v] of Object.entries(plain.doc)) this.map.set(id, v);
    try { this.persist(); this.writeKeepState(); } catch { /* keys.json keeps them; the next start tries again */ }
  }

  /** Seals the plain keys into keys.enc and reads the file back before anything relies on it (K1). */
  private migrate(plain: { doc: Doc; text: string }, setAside: boolean): void {
    const doc = plain.doc;
    this.setMap(doc);
    let created = false;
    try {
      if (setAside) this.setAside();
      created = !existsSync(this.sealedFile); // only a keys.enc made by THIS call may be removed again
      this.keepCopy = true;
      this.persist(plain.text); // keys.json is not rewritten: it is the copy a rollback relies on
      const back = this.readSealed();
      const ok = back !== 'none' && back !== 'bad' && Object.keys(back.doc).length === this.map.size
        && [...this.map].every(([id, v]) => back.doc[id]?.key === v.key && back.doc[id]?.origin === v.origin);
      if (!ok) throw new Error('read-back mismatch');
      this.writeKeepState();
    } catch {
      // keys.json stays the readable store for this run; a keys.enc made just now is ours and is removed (one that was already there never is).
      // A machine with a data key never writes plain (F3): saves are refused until the next start can seal. The next start tries again.
      try { if (created && existsSync(this.sealedFile)) unlinkSync(this.sealedFile); } catch { /* ignore */ }
      this.setMap(doc);
      this.encrypted = false; this.keepCopy = false; this.reason = 'sealing-failed'; this.blocked = true;
    }
  }

  private writeKeepState(): void {
    try { writeConfigFile(this.keepState, JSON.stringify({ version: 1, sealedAt: new Date().toISOString() })); } catch { /* the retirement just waits */ }
  }

  /**
   * K1 retirement: keys.json goes only when keys.enc opened and matched it on THIS start, an earlier start had already sealed it
   * (the keep-state file was there before this start), and the update that is running is committed.
   */
  private maybeRetire(): void {
    if (!existsSync(this.keepState)) { this.writeKeepState(); return; }
    if (!(this.opts.committed ? this.opts.committed() : true)) return;
    try {
      // keys.enc first, WITHOUT the digest: a later keys.json (a downgrade to 0.3.4, one key pasted) is then merged in, not taken as the truth
      this.writeSealed(undefined);
      const len = statSync(this.file).size;
      try { writeFileSync(this.file, Buffer.alloc(len)); } catch { /* best effort: an SSD or a sync client may keep older blocks anyway */ }
      unlinkSync(this.file);
      this.keepCopy = false;
      try { unlinkSync(this.keepState); } catch { /* ignore */ }
    } catch { /* stays; tried again at the next start */ }
  }

  // ---- writing

  /** Renames an unreadable keys.enc out of the way. Never deletes it. */
  private setAside(): void {
    if (!existsSync(this.sealedFile)) return;
    const day = new Date().toISOString().slice(0, 10);
    let to = `${this.sealedFile}.unreadable-${day}`;
    for (let i = 2; existsSync(to); i++) to = `${this.sealedFile}.unreadable-${day}-${i}`;
    renameSync(this.sealedFile, to);
  }

  private doc(): Doc { const keys: Doc = {}; for (const [id, v] of this.map) keys[id] = v; return keys; }

  private writeSealed(digest: string | undefined): void {
    mkdirSync(dirname(this.sealedFile), { recursive: true });
    const body = Buffer.from(JSON.stringify({ version: 1, keys: this.doc(), ...(digest ? { jsonDigest: digest } : {}) }), 'utf8');
    const blob = sealBlob(this.dataKey!, body);
    const tmp = `${this.sealedFile}.${process.pid}.tmp`;
    try { unlinkSync(tmp); } catch { /* none left over */ }
    writeFileSync(tmp, blob, { mode: 0o600, flag: 'wx' });
    try { renameWithRetry(tmp, this.sealedFile); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
    tightenConfigMode(this.sealedFile);
  }

  private save(): void {
    if (this.blocked) throw new Error(KEYS_BLOCKED_MESSAGE);
    if (!this.encrypted) { // the plain store: exactly as before
      writeConfigFile(this.file, JSON.stringify({ version: 1, keys: this.doc() }, null, 2));
      return;
    }
    this.persist();
  }

  private persist(existingJson?: string): void {
    let digest: string | undefined;
    if (existingJson !== undefined) digest = sha(existingJson);
    else if (this.keepCopy) { // keys.json first: if the second write fails the caller sees the error, and keys.enc still holds its older state
      const text = JSON.stringify({ version: 1, keys: this.doc() }, null, 2);
      writeConfigFile(this.file, text);
      digest = sha(text);
    }
    this.writeSealed(digest);
  }

  /** The key, only when it was saved for exactly this origin. */
  get(id: string, origin: string): string | undefined {
    const s = this.map.get(id);
    return s && s.origin === origin ? s.key : undefined;
  }
  has(id: string): boolean { return this.map.has(id); }
  originOf(id: string): string | undefined { return this.map.get(id)?.origin; }
  hint(id: string): string | undefined { const s = this.map.get(id); return s ? `…${s.key.slice(-4)}` : undefined; }
  /** Every stored key, for redaction of text Legion is about to store or show. */
  all(): string[] { return [...this.map.values()].map((s) => s.key); }

  set(id: string, key: unknown, origin: string): void {
    if (this.blocked) throw new Error(KEYS_BLOCKED_MESSAGE);
    if (typeof key !== 'string') throw new Error('The key must be text.');
    const k = key.trim();
    if (k.length < MIN_KEY_LENGTH || k.length > MAX_KEY_LENGTH || /\s/.test(k)) throw new Error(`A key is ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters without spaces.`);
    registerSecret(k); // before the save: a log line written by the save itself must not carry it
    this.map.set(id, { key: k, origin });
    this.save();
  }
  remove(id: string): boolean {
    if (this.blocked) { if (this.map.has(id)) throw new Error(KEYS_BLOCKED_MESSAGE); return false; }
    const had = this.map.delete(id);
    if (had) this.save();
    return had;
  }
  /**
   * The owner chose "Start over with new keys" (through the app's confirmation): the unreadable keys.enc is renamed aside, never deleted.
   * The data key is replaced by the app and the core restarted; this instance stays blocked until then. Only while blocked.
   */
  startOver(): boolean {
    if (!this.blocked) throw new Error('There is nothing to start over: the saved keys are not locked out.');
    this.setAside(); // no-op when keys.enc is not there (a retry after a half-finished start over)
    return true;
  }
  /** The provider's origin changed or the provider was deleted: a key saved for another origin is deleted, not kept. */
  dropIfOriginDiffers(id: string, origin: string): boolean {
    const s = this.map.get(id);
    if (this.blocked || !s || s.origin === origin) return false; // blocked: nothing can be saved; the key stays bound to its old origin
    return this.remove(id);
  }
}

// ---- the words for Settings (K4) and Doctor (K5). Names only, never a value.

const PLAIN_WHY: Record<PlainReason, string> = {
  unavailable: 'this system has no secure key store Legion can use',
  headless: 'Legion was started without the app, so it has no key to lock them with',
  unreadable: 'the system key store could not open the key that locks them',
  'sealing-failed': 'Legion could not lock the keys file on this start and will try again at the next one',
};
const UNLOCK_LINE = 'Your saved keys could not be unlocked on this system. Paste them again.';
const THREAT = 'Encrypted keys stay unreadable to anyone who copies your Legion data folder or a backup, and to an agent\'s file tools. A command running as you on your computer can still ask the system key store for them.';

/** The one line Settings shows under Providers and Web search. */
export function keyStoreLine(s: KeyStoreStatus): string {
  if (s.blocked) return KEYS_BLOCKED_MESSAGE;
  if (s.locked) return UNLOCK_LINE;
  if (s.mode === 'encrypted') return THREAT;
  return `Your keys are stored in a file only you can read, not encrypted: ${PLAIN_WHY[s.reason ?? 'headless']}.`;
}

/** The state the app's main process and the Settings screens act on. */
export function keyStoreState(s: KeyStoreStatus): KeyStoreState {
  return s.blocked ? 'blocked' : s.mode === 'encrypted' && !s.locked ? 'encrypted' : 'plain';
}

/** The Doctor check `provider-keys`. */
export function keyStoreDoctor(s: KeyStoreStatus): { ok: boolean; detail: string; fix?: string } {
  if (s.blocked) return { ok: false, detail: 'The system key store did not unlock, so keys cannot be saved', fix: 'Restart Legion. If it keeps happening, open Settings, Providers and start over with new keys' };
  if (s.locked) return { ok: false, detail: 'Could not be unlocked: paste them again', fix: 'Open Settings, Providers (and Web search) and paste the keys again' };
  if (s.mode === 'encrypted') return { ok: true, detail: 'Encrypted with your system key store' };
  return { ok: true, detail: `Stored unencrypted on this system: ${PLAIN_WHY[s.reason ?? 'headless']}` };
}
