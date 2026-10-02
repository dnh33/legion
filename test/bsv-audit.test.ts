/** The BSV audit log: append-only, hash-chained, tamper-evident, and never a key or a forged line. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, AUDIT_LIMITS, entryHash, GENESIS, redactFields, safeId, safeText, verifyText } from '../src/core/bsv/audit.js';

const dir = () => mkdtempSync(join(tmpdir(), 'legion-audit-'));
const mk = (d = dir(), o = {}) => ({ d, file: join(d, 'bsv', 'audit.jsonl'), log: new AuditLog(join(d, 'bsv', 'audit.jsonl'), { now: (() => { let t = 1_700_000_000_000; return () => (t += 1000); })(), ...o }) });
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const fill = (log: AuditLog, n = 5) => { for (let i = 0; i < n; i++) log.append({ agent: 'assayer', task: `t${i}`, tool: 'bsv_status', decision: 'allowed', reason: `call ${i}`, fields: { n: i } }); };

const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
const HEXKEY = 'a'.repeat(63) + 'b';

test('chain: entries are numbered, linked and verify clean', () => {
  const { log, file } = mk();
  fill(log, 6);
  const rep = log.verify();
  assert.equal(rep.ok, true);
  assert.equal(rep.entries, 6);
  assert.equal(rep.lastSeq, 5);
  const ls = lines(file).map((l) => JSON.parse(l));
  assert.equal(ls[0].prev, GENESIS);
  for (let i = 1; i < ls.length; i++) assert.equal(ls[i].prev, ls[i - 1].hash);
  assert.deepEqual(ls.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
});

test('chain: a log reopened by a new process continues the chain', () => {
  const { d, log, file } = mk();
  fill(log, 3);
  const again = new AuditLog(file);
  assert.equal(again.open().ok, true);
  again.append({ agent: 'owner', tool: 'policy', decision: 'armed' });
  const rep = new AuditLog(file).verify();
  assert.equal(rep.ok, true);
  assert.equal(rep.entries, 4);
  void d;
});

test('tamper: editing a field of any line is detected and located', () => {
  const { log, file } = mk();
  fill(log, 5);
  const ls = lines(file);
  const e = JSON.parse(ls[2]!); e.decision = 'allowed'; e.reason = 'edited'; ls[2] = JSON.stringify(e);
  writeFileSync(file, ls.join('\n') + '\n');
  const rep = new AuditLog(file).verify();
  assert.equal(rep.ok, false);
  assert.equal(rep.brokenAt, 2);
  assert.match(rep.reason!, /edited/);
});

test('tamper: editing a line AND recomputing its hash still breaks the next link', () => {
  const { log, file } = mk();
  fill(log, 5);
  const ls = lines(file).map((l) => JSON.parse(l));
  ls[1].reason = 'forged';
  // an attacker who knows the format recomputes this one hash...
  const { hash: _h, ...rest } = ls[1];
  ls[1].hash = entryHash(rest);
  writeFileSync(file, ls.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const rep = new AuditLog(file).verify();
  assert.equal(rep.ok, false);
  assert.equal(rep.brokenAt, 2, 'the next line no longer links to the forged one');
});

test('tamper: deleting a line from the middle, inserting a line, and reordering are all detected', () => {
  const { log, file } = mk();
  fill(log, 6);
  const ls = lines(file);
  const write = (a: string[]) => writeFileSync(file, a.join('\n') + '\n');
  write(ls.filter((_l, i) => i !== 3));
  assert.equal(verifyText(readFileSync(file, 'utf8')).ok, false, 'deletion');
  write([...ls.slice(0, 3), ls[1]!, ...ls.slice(3)]);
  assert.equal(verifyText(readFileSync(file, 'utf8')).ok, false, 'duplicate / insertion');
  const swapped = [...ls]; [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
  write(swapped);
  assert.equal(verifyText(readFileSync(file, 'utf8')).ok, false, 'reorder');
  write(ls);
  assert.equal(verifyText(readFileSync(file, 'utf8')).ok, true, 'the original is fine');
});

test('tamper: a forged extra line appended from outside is detected the next time the process looks', () => {
  const { log, file } = mk();
  fill(log, 3);
  const last = JSON.parse(lines(file).at(-1)!);
  const forged = { v: 1, seq: last.seq + 1, ts: 'x', prev: last.hash, agent: 'x', task: null, tool: 'x', decision: 'allowed', reason: null, fields: {}, hash: 'f'.repeat(64) };
  appendFileSync(file, JSON.stringify(forged) + '\n');
  assert.equal(log.verify().ok, false);
});

test('tamper: cutting lines off the END is caught while the process that wrote them is alive, and the START cannot be cut either', () => {
  const { log, file } = mk();
  fill(log, 6);
  const ls = lines(file);
  writeFileSync(file, ls.slice(0, 4).join('\n') + '\n');
  const t = log.verify();
  assert.equal(t.ok, false);
  assert.match(t.reason!, /end of the log/);
  writeFileSync(file, ls.slice(2).join('\n') + '\n');
  const h = log.verify();
  assert.equal(h.ok, false);
  writeFileSync(file, '');
  assert.equal(log.verify().ok, false, 'an emptied file is not a clean log');
});

test('crash: a torn last line is reported as torn, not as tampering, and the next entry starts on a fresh line', () => {
  const { log, file } = mk();
  fill(log, 3);
  const full = readFileSync(file, 'utf8');
  writeFileSync(file, full + '{"v":1,"seq":3,"ts":"2026');
  const rep = verifyText(readFileSync(file, 'utf8'));
  assert.equal(rep.ok, true);
  assert.equal(rep.torn, true);
  const again = new AuditLog(file);
  assert.equal(again.open().ok, true);
  again.append({ agent: 'legion', tool: 'audit', decision: 'resume' });
  assert.equal(new AuditLog(file).verify().ok, false, 'a torn line in the MIDDLE is now an unreadable line: it stays as evidence and is flagged');
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 5);
});

test('open: a broken chain is moved aside as evidence and a fresh log starts with a chain-restart entry', () => {
  const { d, log, file } = mk();
  fill(log, 4);
  const ls = lines(file); ls[1] = ls[1]!.replace('"allowed"', '"denied"');
  writeFileSync(file, ls.join('\n') + '\n');
  const next = new AuditLog(file);
  const r = next.open();
  assert.equal(r.ok, false);
  assert.ok(r.tamper && existsSync(r.tamper.movedTo), 'the evidence file is kept');
  assert.equal(readFileSync(r.tamper!.movedTo, 'utf8'), ls.join('\n') + '\n', 'untouched');
  assert.equal(next.verify().ok, true);
  const first = JSON.parse(lines(file)[0]!);
  assert.equal(first.decision, 'chain-restart');
  assert.equal(first.seq, 0);
  assert.ok(readdirSync(join(d, 'bsv')).some((f) => f.includes('.broken-')));
});

test('rotation: a big log is archived and the chain continues in the new file', () => {
  const { log, file } = mk(dir(), { rotateBytes: 600 });
  fill(log, 12);
  const files = readdirSync(join(file, '..'));
  assert.ok(files.some((f) => /^audit\.jsonl\.\d+$/.test(f)), files.join(','));
  assert.equal(log.verify().ok, true);
  const first = JSON.parse(lines(file)[0]!);
  assert.ok(first.seq > 0);
  assert.notEqual(first.prev, GENESIS);
  assert.equal(new AuditLog(file).verify().ok, true);
});

// -------------------------------------------------------------- what never goes in

test('secrets: a seed phrase, a WIF, a 64-hex key and a labelled key never reach the file; txids do', () => {
  const { log, file } = mk();
  log.append({
    agent: 'assayer', task: 't1', tool: 'bsv_status', decision: 'denied', reason: `the agent said: ${SEED}`,
    fields: { note: `wif ${WIF}`, privateKey: HEXKEY, seed: 'anything', password: 'hunter2', other: `private key: ${HEXKEY}`, txid: 'c'.repeat(64), memo: 'hello' },
  });
  const raw = readFileSync(file, 'utf8');
  for (const bad of [SEED, 'abandon ability', WIF, HEXKEY, 'hunter2', 'anything']) assert.ok(!raw.includes(bad), `log leaked ${bad.slice(0, 12)}`);
  const e = JSON.parse(lines(file)[0]!);
  assert.equal(e.fields.txid, 'c'.repeat(64), 'a transaction id is not a secret');
  assert.equal(e.fields.memo, 'hello');
  assert.equal(e.fields.privateKey, '[redacted]');
  assert.equal(e.fields.seed, '[redacted]');
  assert.equal(e.reason, '[redacted-secret]');
});

test('secrets: layout tricks around a seed phrase (numbering, hyphens, zero-width, NBSP) do not get it past the filter', () => {
  const words = SEED.split(' ');
  const variants = [words.map((w, i) => `${i + 1}. ${w}`).join('\n'), words.join('-'), words.join('\u200b '), words.join('\u00a0'), SEED.toUpperCase()];
  for (const v of variants) assert.equal(safeText(v), '[redacted-secret]', JSON.stringify(v.slice(0, 30)));
});

test('log injection: line breaks, control characters and fake fields in agent/task/tool/reason cannot forge a second line or a field', () => {
  const { log, file } = mk();
  const evil = 'x\n{"v":1,"seq":99,"decision":"allowed","hash":"' + 'a'.repeat(64) + '"}\r\n\u2028\u202e';
  log.append({ agent: evil, task: evil, tool: evil, decision: evil, reason: evil, fields: { a: evil, 'b\nc': 1, '__proto__': 'x', constructor: 'y' } });
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 1, 'still exactly one line');
  const e = JSON.parse(lines(file)[0]!);
  assert.equal(e.seq, 0);
  for (const v of [e.agent, e.task, e.tool, e.decision]) assert.match(v, /^[A-Za-z0-9._:/@#?-]*$/);
  assert.ok(!/[\u0000-\u001f\u2028\u202e]/.test(e.reason));
  assert.ok(e.fields.dropped >= 1, 'odd keys are dropped and counted');
  assert.equal(log.verify().ok, true);
});

test('fields: only primitives survive; nested objects and arrays are dropped; size is bounded', () => {
  const f = redactFields({ s: 'ok', n: 5, b: true, z: null, nan: Number.NaN, inf: Infinity, obj: { a: 1 }, arr: [1], fn: (() => 1) as unknown });
  assert.deepEqual(f, { s: 'ok', n: 5, b: true, z: null, nan: null, inf: null, dropped: 3 });
  const many: Record<string, unknown> = {}; for (let i = 0; i < 40; i++) many[`k${i}`] = i;
  assert.ok(Object.keys(redactFields(many)).length <= AUDIT_LIMITS.fields + 1);
  assert.deepEqual(redactFields(undefined), {});
  assert.deepEqual(redactFields([1, 2] as never), {});
  assert.ok(safeText('a'.repeat(5000)).length <= AUDIT_LIMITS.text);
  assert.equal(safeId('a b\nc;d'), 'a?b?c?d');
});

test('size: an entry with huge fields stays a small line and still verifies', () => {
  const { log, file } = mk();
  const f: Record<string, string> = {}; for (let i = 0; i < 16; i++) f[`k${i}`] = 'z'.repeat(5000);
  log.append({ agent: 'a', tool: 't', decision: 'allowed', reason: 'r'.repeat(5000), fields: f });
  assert.ok(lines(file)[0]!.length <= AUDIT_LIMITS.entryBytes + 200);
  assert.equal(log.verify().ok, true);
});

test('reader: newest first, paged by sequence number, with the chain check', () => {
  const { log } = mk();
  fill(log, 8);
  const r = log.read({ limit: 3 });
  assert.deepEqual(r.entries.map((e) => e.seq), [7, 6, 5]);
  assert.equal(r.verify.ok, true);
  assert.equal(r.total, 8);
  assert.deepEqual(log.read({ limit: 3, before: 5 }).entries.map((e) => e.seq), [4, 3, 2]);
  assert.equal(log.read({ limit: 100000 }).entries.length, 8);
  assert.equal(log.read({ limit: -4 }).entries.length, 1);
});

test('empty and missing logs verify as clean and empty', () => {
  const { log, file } = mk();
  assert.deepEqual(log.verify(), { ok: true, entries: 0, lastSeq: null, lastHash: null });
  assert.equal(existsSync(file), false);
  assert.equal(verifyText('').ok, true);
});

