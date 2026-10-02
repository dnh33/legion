/**
 * A FAKE BRC-100 wallet for the spend tests (a test helper, not product code): Node http on a random loopback port, a recording log, and
 * scripted behaviours. Default shapes are what the owner's real wallet was seen to answer by hand (V0, read-only): version
 * "wallet-brc100-1.0.0", network "mainnet", HTTP 200 with a JSON body labelled text/html. Tests pick `network` explicitly.
 * Everything else (the unsigned-transaction shape, the signed answer) is ASSUMED from the BRC-100 text (plan 14.2): createAction with
 * signAndProcess false answers { signableTransaction: { tx: AtomicBEEF, reference } } and nothing else; abortAction answers { aborted: true };
 * errors are { status: 'error', code, description }. Other shapes are hostile variants.
 *
 * It never opens port 3321 and `fakeTransport` refuses that port and any non-loopback host. No keys: test scripts are byte patterns,
 * the fake never validates a signature.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { httpTransport } from '../src/core/bsv/wallet-probe.js';
import type { Transport } from '../src/core/bsv/wallet-probe.js';

export const FORBIDDEN_WALLET_PORT = 3321; // the owner's real wallet: nothing in tests may use it
export const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();
export const sha256d = (b: Uint8Array): Buffer => sha256(sha256(b));

// ---------------------------------------------------------------- bytes, transactions, BEEF

export const varint = (n: number): Buffer => {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.from([0xfd, n & 0xff, n >> 8]);
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
};
export const p2pkhOf = (fill: number): Buffer => Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.alloc(20, fill), Buffer.from([0x88, 0xac])]);
export const dataScript = (): Buffer => Buffer.from([0x6a, 0x04, 0x74, 0x65, 0x73, 0x74]);
export const oddScript = (): Buffer => Buffer.from([0x51]);

export interface TxIn { prevTxid: string; vout: number; script?: Buffer }
export interface TxOut { sats: number; script: Buffer }
export function rawTx(ins: TxIn[], outs: TxOut[]): Buffer {
  const parts: Buffer[] = [Buffer.from([1, 0, 0, 0]), varint(ins.length)];
  for (const i of ins) {
    const prev = Buffer.from(i.prevTxid, 'hex').reverse();
    const s = i.script ?? Buffer.alloc(0);
    const vout = Buffer.alloc(4); vout.writeUInt32LE(i.vout);
    parts.push(prev, vout, varint(s.length), s, Buffer.from([0xff, 0xff, 0xff, 0xff]));
  }
  parts.push(varint(outs.length));
  for (const o of outs) { const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(o.sats)); parts.push(v, varint(o.script.length), o.script); }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}
export const txidOf = (raw: Buffer): string => Buffer.from(sha256d(raw)).reverse().toString('hex');

/** A BUMP with one level and one leaf (enough to prove the decoder skips merkle paths). */
export const bump = (): Buffer => Buffer.concat([varint(100), Buffer.from([1]), varint(1), varint(0), Buffer.from([2]), Buffer.alloc(32, 7)]);

export interface BeefTx { raw: Buffer; bumpIndex?: number; txidOnly?: boolean }
export function beef(txs: BeefTx[], o: { v2?: boolean; atomic?: boolean; bumps?: Buffer[]; atomicTxidReversed?: boolean } = {}): Buffer {
  const bumps = o.bumps ?? [];
  const parts: Buffer[] = [o.v2 ? Buffer.from([2, 0, 0xbe, 0xef]) : Buffer.from([1, 0, 0xbe, 0xef]), varint(bumps.length), ...bumps, varint(txs.length)];
  for (const t of txs) {
    if (o.v2) {
      if (t.txidOnly) { parts.push(Buffer.from([2]), Buffer.from(txidOf(t.raw), 'hex').reverse()); continue; }
      parts.push(Buffer.from([t.bumpIndex === undefined ? 0 : 1]), ...(t.bumpIndex === undefined ? [] : [varint(t.bumpIndex)]), t.raw); // BRC-96: format, BUMP index, then the raw transaction
    } else parts.push(t.raw, t.bumpIndex === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), varint(t.bumpIndex)]));
  }
  const body = Buffer.concat(parts);
  if (!o.atomic) return body;
  const id = Buffer.from(txidOf(txs[txs.length - 1]!.raw), 'hex');
  return Buffer.concat([Buffer.from([1, 1, 1, 1]), o.atomicTxidReversed ? id : Buffer.from(id).reverse(), body]);
}

// ---------------------------------------------------------------- the wallet

export interface Call { n: number; method: string; body: any; headers: Record<string, string | string[] | undefined> }
export type Encoding = 'bytes' | 'hex' | 'base64';
export interface FakeBehaviour {
  /** What getNetwork says. Default "mainnet" (the real wallet's answer). */
  network: string;
  version: string;
  authenticated: boolean;
  height: number;
  /** After this many getNetwork answers, answer `flipTo` instead (0 = never). */
  flipAtProbe: number;
  flipTo: string;
  /** After this method has been served once, the claimed network becomes `flipTo`. */
  flipAfter: '' | 'createAction' | 'signAction';
  // createAction
  create: 'ok' | 'hang' | 'garbage' | 'http500' | 'oversize' | 'no-reference' | 'early-signed' | 'refuse-before' | 'error-json' | 'close';
  fundSats: number; feeSats: number;
  change: 'p2pkh' | 'none' | 'two' | 'data' | 'nonstandard' | 'to-recipient';
  changeFill: number;
  payDelta: number;            // wallet builds a different payment amount
  payFill: number | null;      // wallet builds a payment to another script
  omitParent: boolean; parentTxidOnly: boolean;
  txEncoding: Encoding; v2: boolean; atomic: boolean; withBump: boolean;
  // signAction
  sign: 'ok' | 'hang' | 'close' | 'http500' | 'garbage' | 'error-json' | 'refuse-conn' | 'different-amount' | 'different-recipient' | 'no-tx' | 'bad-txid' | 'txid-mismatch' | 'more-fee';
  abort: 'ok' | 'fail' | 'http500';
  /** Text an attacker-controlled wallet puts in every string field it can. */
  injection: string;
  /** Content-Type of every answer (the real wallet says text/html). */
  contentType: string;
}
export const defaults = (): FakeBehaviour => ({
  network: 'mainnet', version: 'wallet-brc100-1.0.0', authenticated: true, height: 969369, flipAtProbe: 0, flipTo: 'mainnet', flipAfter: '',
  create: 'ok', fundSats: 10_000, feeSats: 20, change: 'p2pkh', changeFill: 0x77, payDelta: 0, payFill: null, omitParent: false, parentTxidOnly: false,
  txEncoding: 'bytes', v2: false, atomic: true, withBump: false,
  sign: 'ok', abort: 'ok', injection: '', contentType: 'text/html; charset=utf-8',
});

export interface FakeWallet {
  url: string; port: number;
  b: FakeBehaviour;
  calls: Call[];
  /** Calls of one method, in order. */
  of(method: string): Call[];
  /** The references handed out by createAction and not yet aborted or signed. */
  open: Set<string>;
  aborted: string[]; signed: string[];
  /** Releases a hanging signAction with its normal (ok) answer. */
  releaseSign(): void;
  /** Releases a hanging createAction. */
  releaseCreate(): void;
  stop(): Promise<void>;
}

export async function startFakeWallet(patch: Partial<FakeBehaviour> = {}): Promise<FakeWallet> {
  const b = { ...defaults(), ...patch };
  const calls: Call[] = [];
  const open = new Set<string>();
  const aborted: string[] = []; const signed: string[] = [];
  const built = new Map<string, { target: Buffer; parent: Buffer; payHex: string; paySats: number; outs: TxOut[]; fund: number }>();
  const hangs: Array<() => void> = [];
  let netAnswers = 0; let flipped = false; let refSeq = 0;
  const wire = new Set<import('node:net').Socket>();

  const buildUnsigned = (body: any): { tx: Buffer; ref: string } | null => {
    const o0 = body?.outputs?.[0];
    if (!o0 || typeof o0.lockingScript !== 'string' || !Number.isInteger(o0.satoshis)) return null;
    const paySats = o0.satoshis + b.payDelta;
    const payScript = b.payFill === null ? Buffer.from(o0.lockingScript, 'hex') : p2pkhOf(b.payFill);
    const outs: TxOut[] = [{ sats: paySats, script: payScript }];
    const changeSats = b.fundSats - paySats - b.feeSats;
    const addChange = (script: Buffer, sats: number) => outs.push({ sats, script });
    if (b.change === 'p2pkh') addChange(p2pkhOf(b.changeFill), changeSats);
    else if (b.change === 'two') { addChange(p2pkhOf(b.changeFill), Math.floor(changeSats / 2)); addChange(p2pkhOf(b.changeFill + 1), changeSats - Math.floor(changeSats / 2)); }
    else if (b.change === 'data') { addChange(p2pkhOf(b.changeFill), changeSats - 1); addChange(Buffer.concat([dataScript()]), 1); }
    else if (b.change === 'nonstandard') addChange(oddScript(), changeSats);
    else if (b.change === 'to-recipient') addChange(payScript, changeSats);
    const parent = rawTx([{ prevTxid: 'aa'.repeat(32), vout: 0, script: Buffer.from([0x51]) }], [{ sats: b.fundSats, script: p2pkhOf(0x55) }]);
    const target = rawTx([{ prevTxid: txidOf(parent), vout: 0 }], outs);
    const ref = `ref${String(++refSeq).padStart(4, '0')}${'A'.repeat(8)}==`;
    built.set(ref, { target, parent, payHex: payScript.toString('hex'), paySats, outs, fund: b.fundSats });
    const parts: BeefTx[] = b.omitParent ? [{ raw: target }] : [{ raw: parent, bumpIndex: b.withBump ? 0 : undefined, txidOnly: b.parentTxidOnly }, { raw: target }];
    return { tx: beef(parts, { v2: b.v2, atomic: b.atomic, bumps: b.withBump ? [bump()] : [] }), ref };
  };
  const encode = (t: Buffer): unknown => (b.txEncoding === 'bytes' ? [...t] : b.txEncoding === 'hex' ? t.toString('hex') : t.toString('base64'));

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = (req.url ?? '/').slice(1);
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = { _unparsable: true }; }
      calls.push({ n: calls.length, method, body, headers: req.headers });
      const send = (status: number, obj: unknown, raw?: string) => { res.writeHead(status, { 'content-type': b.contentType }); res.end(raw ?? JSON.stringify(obj)); };
      const inj = b.injection;

      if (method === 'getVersion') return send(200, { version: inj || b.version });
      if (method === 'getNetwork') {
        netAnswers++;
        const flip = flipped || (b.flipAtProbe > 0 && netAnswers >= b.flipAtProbe);
        return send(200, { network: flip ? b.flipTo : b.network });
      }
      if (method === 'isAuthenticated') return send(200, { authenticated: b.authenticated });
      if (method === 'getHeight') return send(200, { height: b.height });

      if (method === 'createAction') {
        if (b.flipAfter === 'createAction') flipped = true;
        const answer = () => {
          if (b.create === 'garbage') return send(200, null, 'not json at all');
          if (b.create === 'http500') return send(500, { status: 'error', code: 'ERR_INTERNAL', description: inj || 'boom' });
          if (b.create === 'error-json') return send(200, { status: 'error', code: 'ERR_X', description: inj || 'nope' });
          if (b.create === 'oversize') return send(200, null, JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
          if (b.create === 'close') { req.socket.destroy(); return undefined; }
          const u = buildUnsigned(body);
          if (!u) return send(400, { status: 'error', code: 'ERR_BAD' });
          if (b.create === 'early-signed') return send(200, { txid: txidOf(built.get(u.ref)!.target), tx: encode(u.tx) });
          if (b.create === 'no-reference') return send(200, { signableTransaction: { tx: encode(u.tx) } });
          open.add(u.ref);
          return send(200, { signableTransaction: { tx: encode(u.tx), reference: u.ref } });
        };
        if (b.create === 'hang') { hangs.push(() => { b.create = 'ok'; answer(); }); return; }
        return answer();
      }

      if (method === 'signAction') {
        if (b.flipAfter === 'signAction') flipped = true;
        const ref: string = body?.reference;
        const bt = built.get(ref);
        const okAnswer = () => {
          if (!bt) return send(400, { status: 'error', code: 'ERR_NO_REF' });
          open.delete(ref); signed.push(ref);
          let outs = bt.outs.map((o) => ({ ...o }));
          if (b.sign === 'different-amount') outs[0]!.sats -= 1;
          if (b.sign === 'different-recipient') outs[0]!.script = p2pkhOf(0x99);
          const fee = b.sign === 'more-fee' ? 90 : bt.fund - outs.reduce((a, o) => a + o.sats, 0);
          if (b.sign === 'more-fee') outs[outs.length - 1]!.sats = bt.fund - outs.slice(0, -1).reduce((a, o) => a + o.sats, 0) - fee;
          const signedTx = rawTx([{ prevTxid: txidOf(bt.parent), vout: 0, script: Buffer.alloc(107, 0x30) }], outs);
          const id = txidOf(signedTx);
          const tx = beef([{ raw: bt.parent }, { raw: signedTx }], { atomic: true });
          if (b.sign === 'no-tx') return send(200, { txid: id });
          if (b.sign === 'bad-txid') return send(200, { txid: inj || 'not-a-txid', tx: [...tx] });
          if (b.sign === 'txid-mismatch') return send(200, { txid: 'ab'.repeat(32), tx: [...tx] });
          return send(200, { txid: id, tx: [...tx] });
        };
        if (b.sign === 'hang') { hangs.push(() => { b.sign = 'ok'; okAnswer(); }); return; }
        if (b.sign === 'close') { req.socket.destroy(); return; }
        if (b.sign === 'http500') return send(500, { status: 'error', code: 'ERR_USER_DENIED', description: inj || 'The user denied the request' });
        if (b.sign === 'garbage') return send(200, null, '<html>' + inj + '</html>');
        if (b.sign === 'error-json') return send(200, { status: 'error', code: 'ERR_REVIEW_ACTIONS', description: inj || 'declined' });
        return okAnswer();
      }

      if (method === 'abortAction') {
        const ref: string = body?.reference;
        if (b.abort === 'http500') return send(500, { status: 'error', code: 'ERR_X' });
        if (b.abort === 'fail') return send(200, { status: 'error', code: 'ERR_ABORT', description: inj });
        open.delete(ref); aborted.push(ref);
        return send(200, { aborted: true });
      }
      return send(404, { status: 'error', code: 'ERR_NOT_IMPLEMENTED' });
    });
  });
  server.on('connection', (s) => { wire.add(s); s.on('close', () => wire.delete(s)); });
  await new Promise<void>((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const port = (server.address() as { port: number }).port;
  if (port === FORBIDDEN_WALLET_PORT) { server.close(); throw new Error('the fake wallet refuses the real wallet port'); }
  return {
    url: `http://127.0.0.1:${port}`, port, b, calls, of: (m) => calls.filter((c) => c.method === m), open, aborted, signed,
    releaseSign: () => { const h = hangs.splice(0); h.forEach((f) => f()); },
    releaseCreate: () => { const h = hangs.splice(0); h.forEach((f) => f()); },
    async stop() { for (const s of wire) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

/** The module's Transport, wrapped: it throws for the real wallet's port and for any host that is not a loopback literal. Real sockets, so timeouts and resets are real. */
export function fakeTransport(): Transport {
  return (req) => {
    if (req.port === FORBIDDEN_WALLET_PORT) throw new Error('tests may never contact the real wallet port');
    if (req.host !== '127.0.0.1' && req.host !== '::1') throw new Error('tests may only contact loopback');
    return httpTransport(req);
  };
}
