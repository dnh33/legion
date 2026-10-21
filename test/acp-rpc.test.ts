import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcClosed, RpcError, RpcPeer, RpcTimeout, lineSplitter, type RpcIo } from '../src/core/acp/rpc.js';

/** An in-memory RpcIo: `sent` holds what the peer wrote, `feed` plays what the far side says. */
function fakeIo() {
  const sent: string[] = [];
  let lineCb: (line: string) => void = () => undefined;
  let closeCb: () => void = () => undefined;
  const io: RpcIo = {
    write: (line) => { sent.push(line); },
    onLine: (cb) => { lineCb = cb; },
    onClose: (cb) => { closeCb = cb; },
  };
  return {
    io,
    sent,
    feed: (msg: unknown) => lineCb(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    eof: () => closeCb(),
    sentJson: () => sent.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

test('lineSplitter: one JSON line split over 3 chunks is one message', () => {
  const lines: string[] = [];
  const feed = lineSplitter((l) => lines.push(l));
  feed('{"a":');
  feed('1,"b"');
  assert.deepEqual(lines, []);
  feed(':2}\n');
  assert.deepEqual(lines, ['{"a":1,"b":2}']);
});

test('lineSplitter: two messages in one chunk are two lines, a partial tail waits, CRLF and blank lines are dropped', () => {
  const lines: string[] = [];
  const feed = lineSplitter((l) => lines.push(l));
  feed('{"a":1}\n\n{"b":2}\r\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  feed(':3}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('lineSplitter: a multi-byte character split across two byte chunks survives', () => {
  const lines: string[] = [];
  const feed = lineSplitter((l) => lines.push(l));
  const bytes = Buffer.from('{"t":"æøå €"}\n', 'utf8');
  const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte euro sign
  feed(bytes.subarray(0, cut));
  feed(bytes.subarray(cut));
  assert.deepEqual(lines, ['{"t":"æøå €"}']);
});

test('request writes one JSON-RPC 2.0 line and resolves from the matching response', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  const p = peer.request<{ ok: boolean }>('session/new', { cwd: 'x' });
  assert.equal(f.sent.length, 1);
  const req = f.sentJson()[0]!;
  assert.equal(req['jsonrpc'], '2.0');
  assert.equal(req['method'], 'session/new');
  assert.deepEqual(req['params'], { cwd: 'x' });
  f.feed({ jsonrpc: '2.0', id: req['id'], result: { ok: true } });
  assert.deepEqual(await p, { ok: true });
});

test('responses match by id when they arrive out of order', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  const a = peer.request<string>('a', {});
  const b = peer.request<string>('b', {});
  const c = peer.request<string>('c', {});
  const [ra, rb, rc] = f.sentJson();
  f.feed({ jsonrpc: '2.0', id: rc!['id'], result: 'C' });
  f.feed({ jsonrpc: '2.0', id: ra!['id'], result: 'A' });
  f.feed({ jsonrpc: '2.0', id: rb!['id'], result: 'B' });
  assert.deepEqual(await Promise.all([a, b, c]), ['A', 'B', 'C']);
});

test('an error response rejects with RpcError carrying code, message and data', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  const p = peer.request('x', {});
  f.feed({ jsonrpc: '2.0', id: f.sentJson()[0]!['id'], error: { code: -32602, message: 'bad params', data: { field: 'cwd' } } });
  await assert.rejects(p, (e: unknown) => e instanceof RpcError && e.code === -32602 && e.message === 'bad params' && (e.data as { field: string }).field === 'cwd');
});

test('an outgoing message is always one line, even with newlines inside strings', () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  void peer.request('prompt', { text: 'line one\nline two\r\nline three ' }).catch(() => undefined);
  peer.notify('note', { text: 'a\nb' });
  assert.equal(f.sent.length, 2);
  for (const line of f.sent) {
    assert.ok(!/[\r\n]/.test(line), 'no raw newline inside a written message');
    assert.ok(!line.endsWith('\n'), 'the peer does not add the terminator, the io does');
  }
  assert.equal((f.sentJson()[0]!['params'] as { text: string }).text, 'line one\nline two\r\nline three ');
  assert.equal(f.sentJson()[1]!['id'], undefined, 'a notification has no id');
  peer.close('test over');
});

test('an incoming request gets its handler result as a response with the same id', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  peer.onRequest('fs/read', async (params) => ({ echoed: params }));
  f.feed({ jsonrpc: '2.0', id: 'agent-7', method: 'fs/read', params: { path: 'a' } });
  await tick();
  assert.deepEqual(f.sentJson(), [{ jsonrpc: '2.0', id: 'agent-7', result: { echoed: { path: 'a' } } }]);
});

test('a handler that returns nothing answers with a null result', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  peer.onRequest('noop', async () => undefined);
  f.feed({ jsonrpc: '2.0', id: 1, method: 'noop' });
  await tick();
  assert.deepEqual(f.sentJson(), [{ jsonrpc: '2.0', id: 1, result: null }]);
});

test('a throwing handler gets JSON-RPC error -32603', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  peer.onRequest('boom', async () => { throw new Error('it broke'); });
  f.feed({ jsonrpc: '2.0', id: 3, method: 'boom', params: {} });
  await tick();
  assert.deepEqual(f.sentJson(), [{ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'it broke' } }]);
});

test('a handler may reject with an RpcError to choose the code', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  peer.onRequest('pick', async () => { throw new RpcError(-32602, 'need a path', { field: 'path' }); });
  f.feed({ jsonrpc: '2.0', id: 4, method: 'pick' });
  await tick();
  assert.deepEqual(f.sentJson(), [{ jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'need a path', data: { field: 'path' } } }]);
});

test('an unknown method gets -32601', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  f.feed({ jsonrpc: '2.0', id: 9, method: 'terminal/create', params: {} });
  await tick();
  const [res] = f.sentJson();
  assert.equal(res!['id'], 9);
  assert.equal((res!['error'] as { code: number }).code, -32601);
});

test('notifications reach their handler, get no reply, and unknown ones are ignored', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  const seen: unknown[] = [];
  peer.onNotification('session/update', (p) => seen.push(p));
  f.feed({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } });
  f.feed({ jsonrpc: '2.0', method: 'who/knows', params: {} });
  await tick();
  assert.deepEqual(seen, [{ n: 1 }]);
  assert.deepEqual(f.sent, []);
});

test('a request times out with RpcTimeout, and a late response is ignored', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io, { requestTimeoutMs: 20 });
  const p = peer.request('slow', {});
  const id = f.sentJson()[0]!['id'];
  await assert.rejects(p, (e: unknown) => e instanceof RpcTimeout && /slow/.test(e.message));
  f.feed({ jsonrpc: '2.0', id, result: 'too late' });
  await tick();
  assert.equal(f.sent.length, 1, 'nothing else was written');
});

test('the per-request timeout overrides the default, and 0 means no timeout', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io, { requestTimeoutMs: 5 });
  const unlimited = peer.request<string>('long', {}, 0);
  const short = peer.request('short', {}, 10);
  await assert.rejects(short, RpcTimeout);
  await new Promise((r) => setTimeout(r, 30));
  f.feed({ jsonrpc: '2.0', id: f.sentJson()[0]!['id'], result: 'still here' });
  assert.equal(await unlimited, 'still here');
});

test('stdout EOF rejects every pending request with RpcClosed, and later requests too', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  const a = peer.request('a', {});
  const b = peer.request('b', {});
  f.eof();
  await assert.rejects(a, RpcClosed);
  await assert.rejects(b, RpcClosed);
  await assert.rejects(peer.request('c', {}), RpcClosed);
  assert.equal(f.sent.length, 2, 'nothing is written after close');
  peer.notify('d', {});
  assert.equal(f.sent.length, 2);
});

test('close(reason) rejects pending requests with that reason and is safe to call twice', async () => {
  const f = fakeIo();
  const peer = new RpcPeer(f.io);
  const p = peer.request('a', {});
  peer.close('agent exited with code 1');
  await assert.rejects(p, (e: unknown) => e instanceof RpcClosed && /agent exited with code 1/.test(e.message));
  peer.close('again');
  f.eof();
});

test('a non-JSON line goes to onNoise and the next valid line still parses', async () => {
  const f = fakeIo();
  const noise: string[] = [];
  const peer = new RpcPeer(f.io, { onNoise: (l) => noise.push(l) });
  const p = peer.request<string>('x', {});
  const id = f.sentJson()[0]!['id'];
  f.feed('Warning: something printed to stdout');
  f.feed('{"half":');
  f.feed('42');
  f.feed({ hello: 'not an envelope' });
  f.feed({ jsonrpc: '2.0', id, result: 'fine' });
  assert.equal(await p, 'fine');
  assert.deepEqual(noise, ['Warning: something printed to stdout', '{"half":', '42', '{"hello":"not an envelope"}']);
});

test('noise split across chunks through lineSplitter does not break the stream', async () => {
  const f = fakeIo();
  const noise: string[] = [];
  const peer = new RpcPeer(f.io, { onNoise: (l) => noise.push(l) });
  const p = peer.request<number>('x', {});
  const id = f.sentJson()[0]!['id'];
  const feed = lineSplitter((l) => f.feed(l));
  const good = JSON.stringify({ jsonrpc: '2.0', id, result: 7 });
  feed('banner text with no braces\nnot json at ');
  feed('all\n' + good.slice(0, 10));
  feed(good.slice(10) + '\n');
  assert.equal(await p, 7);
  assert.deepEqual(noise, ['banner text with no braces', 'not json at all']);
});
