import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenRelay, type RelayPeer, type RelayRequest } from '../src/relay-transport.ts';
import type { DiagnosticEvent, DiagnosticSink } from '../src/diagnostics.ts';

const token = 'test-only-token';
async function fixture(t: { after(fn: () => Promise<void>): void }, diagnostic?: DiagnosticSink) {
  let current = true;
  const peers: RelayPeer[] = [], requests: RelayRequest[] = [], disconnected: RelayPeer[] = [];
  const listener = await listenRelay({ host: '127.0.0.1', port: 0, token, diagnostic,
    isCurrent: () => current, onConnect: peer => { peers.push(peer); return true; },
    onRequest: (_peer, message) => requests.push(message), onDisconnect: peer => { disconnected.push(peer); },
  });
  const clients: WebSocket[] = [];
  t.after(async () => { for (const client of clients) client.terminate(); await listener.close(); });
  const connect = async (path = '/relay') => {
    const client = new WebSocket(`ws://127.0.0.1:${listener.port}${path}`);
    clients.push(client);
    client.on('error', () => {});
    await once(client, 'open');
    return client;
  };
  return { listener, connect, peers, requests, disconnected, stale: () => { current = false; } };
}
function setup(client: WebSocket, suppliedToken = token) {
  client.send(JSON.stringify({ type: 'setup', sessionId: 'call-123', customParameters: { relayToken: suppliedToken } }));
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++) await delay(10);
  assert.ok(check(), 'condition reached');
}
function send(client: WebSocket, frame: unknown) { client.send(JSON.stringify(frame)); }

test('relay setup authenticates; partial/final prompts and explicit output use exact protocol', async t => {
  const f = await fixture(t), client = await f.connect();
  const output: unknown[] = [];
  client.on('message', data => output.push(JSON.parse(data.toString())));
  setup(client);
  await until(() => f.peers.length === 1);
  assert.equal(f.peers[0]!.sessionId, 'call-123');
  assert.ok(f.peers[0]!.id);
  send(client, { type: 'prompt', voicePrompt: 'par', last: false });
  send(client, { type: 'prompt', voicePrompt: 'partial complete', last: true });
  await until(() => f.requests.length === 2);
  assert.deepEqual(f.requests, [ { type: 'prompt', text: 'par', last: false }, { type: 'prompt', text: 'partial complete', last: true } ]);
  assert.deepEqual(output, []);
  assert.equal(f.peers[0]!.sendText('Hello', false), true);
  assert.equal(f.peers[0]!.sendText('', true), true);
  await until(() => output.length === 2);
  assert.deepEqual(output, [{ type: 'text', token: 'Hello', last: false }, { type: 'text', token: '', last: true }]);
  const closed = once(client, 'close'); client.close(); await closed;
  await until(() => f.disconnected.length === 1);
  assert.equal(f.peers[0]!.sendText('late', true), false);
  assert.equal(f.disconnected.length, 1);
});

test('unauthenticated prompts and invalid setup cannot produce any callbacks', async t => {
  const f = await fixture(t);
  for (const frame of [
    { type: 'prompt', voicePrompt: 'attack', last: true },
    { type: 'interrupt' },
    { type: 'setup', sessionId: 'call-123', customParameters: { relayToken: 'wrong' } },
    { type: 'setup', sessionId: '', customParameters: { relayToken: token } },
    { type: 'setup', sessionId: 'call-123', customParameters: { relayToken: `Bearer ${token}` } },
  ]) {
    const client = await f.connect(), closed = once(client, 'close');
    send(client, frame); await closed;
  }
  assert.deepEqual(f.peers, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.disconnected, []);
});

test('interrupt and turn notifications cancel only; DTMF and unknown frames ignored', async t => {
  const f = await fixture(t), client = await f.connect(); setup(client);
  await until(() => f.peers.length === 1);
  for (const type of ['dtmf', 'unknown', 'interrupt', 'eagerEndOfTurn', 'turnResumed']) send(client, { type });
  await until(() => f.requests.length === 3);
  assert.deepEqual(f.requests, Array.from({ length: 3 }, () => ({ type: 'interrupt' })));
  const closed = once(client, 'close'); send(client, { type: 'error', description: 'private' }); await closed;
  assert.equal(f.disconnected.length, 1);
});

test('second peer is rejected, including another socket opened before setup', async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect();
  setup(first); await until(() => f.peers.length === 1);
  const closed = once(second, 'close'); setup(second); await closed;
  await assert.rejects(f.connect());
  assert.equal(f.peers.length, 1); assert.equal(f.disconnected.length, 0);
  send(first, { type: 'prompt', voicePrompt: 'still first', last: true });
  await until(() => f.requests.length === 1);
});

test('duplicate setup, invalid typed prompts, binary and excessive transcript close admitted peer', async t => {
  const f = await fixture(t);
  for (const frame of [
    { type: 'setup', sessionId: 'again', customParameters: { relayToken: token } },
    { type: 'prompt', voicePrompt: 'x', last: 'true' },
    { type: 'prompt', voicePrompt: 'é'.repeat(16385), last: true },
    Buffer.from('{}'),
  ]) {
    const before = f.peers.length, client = await f.connect(); setup(client);
    await until(() => f.peers.length > before);
    const closed = once(client, 'close');
    if (Buffer.isBuffer(frame)) client.send(frame); else send(client, frame);
    await closed;
  }
  assert.equal(f.disconnected.length, 4); assert.deepEqual(f.requests, []);
});

test('64KiB frame bound and interrupt rate bound revoke promptly', async t => {
  const f = await fixture(t);
  let client = await f.connect(); setup(client); await until(() => f.peers.length === 1);
  let closed = once(client, 'close'); client.send('x'.repeat(65537)); await closed;
  assert.equal(f.disconnected.length, 1);
  client = await f.connect(); setup(client); await until(() => f.peers.length === 2);
  closed = once(client, 'close');
  for (let n = 0; n < 30; n++) send(client, { type: 'interrupt' });
  await closed;
  assert.ok(f.requests.length <= 8); assert.equal(f.disconnected.length, 2);
});

test('stale runtime fences input/output but still revokes the admitted peer; shutdown idempotent', async t => {
  const f = await fixture(t), client = await f.connect(); setup(client);
  await until(() => f.peers.length === 1);
  const closed = once(client, 'close'); f.stale();
  send(client, { type: 'prompt', voicePrompt: 'late', last: true });
  assert.equal(f.peers[0]!.sendText('late', true), false);
  await closed;
  assert.equal(f.listener.isReady(), false);
  assert.deepEqual(f.requests, []); assert.equal(f.disconnected.length, 1);
  const first = f.listener.close(); assert.equal(f.listener.close(), first); await first;
});

test('close disconnects admitted peer exactly once and destroys pending connections', async t => {
  const f = await fixture(t), pending = await f.connect(), client = await f.connect(); setup(client);
  await until(() => f.peers.length === 1);
  const ended = Promise.all([once(pending, 'close'), once(client, 'close')]);
  await f.listener.close(); await ended; await f.listener.close();
  assert.equal(f.disconnected.length, 1); assert.equal(f.listener.isReady(), false);
  assert.equal(f.peers[0]!.sendText('late', true), false);
});

test('HTTP POST, query tokens and wrong paths are rejected; no auth callbacks', async t => {
  const f = await fixture(t);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${f.listener.port}/relay`, { method: 'POST' }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('not a relay');
  });
  assert.equal(status, 404);
  await assert.rejects(f.connect(`/relay?relayToken=${token}`));
  await assert.rejects(f.connect('/'));
  assert.deepEqual(f.peers, []);
});

test('unauthenticated socket count and setup deadline are bounded', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const clients: WebSocket[] = [];
  for (let i = 0; i < 8; i++) clients.push(await f.connect());
  const closed = clients.map(client => once(client, 'close'));
  await assert.rejects(f.connect());
  await Promise.all(closed);
  assert.deepEqual(f.peers, []); assert.deepEqual(f.disconnected, []);
});

test('oversized outgoing text revokes immediately without leaking content', async t => {
  const f = await fixture(t), client = await f.connect(); setup(client);
  await until(() => f.peers.length === 1);
  const closed = once(client, 'close');
  assert.equal(f.peers[0]!.sendText('x'.repeat(32769), true), false);
  assert.equal(f.disconnected.length, 1);
  assert.equal(f.peers[0]!.sendText('late', true), false);
  await closed;
});

test('authenticated onConnect can send; request callback exceptions are sanitized', async t => {
  let disconnects = 0;
  const listener = await listenRelay({ host: '127.0.0.1', port: 0, token, isCurrent: () => true,
    onConnect: peer => { assert.equal(peer.sendText('greeting', true), true); return true; },
    onRequest: () => { throw new Error('private callback detail'); },
    onDisconnect: () => { disconnects++; throw new Error('private disconnect detail'); },
  });
  t.after(() => listener.close());
  const client = new WebSocket(`ws://127.0.0.1:${listener.port}/relay`);
  client.on('error', () => {});
  await once(client, 'open');
  const output = once(client, 'message'); setup(client);
  assert.deepEqual(JSON.parse(String((await output)[0])), { type: 'text', token: 'greeting', last: true });
  const closed = once(client, 'close'); send(client, { type: 'prompt', voicePrompt: 'hello', last: true });
  const [code, reason] = await closed;
  assert.equal(code, 1011); assert.equal(String(reason), 'Relay closed'); assert.equal(disconnects, 1);
});

test('rejected onConnect is never considered an admitted peer', async t => {
  let disconnects = 0, requests = 0;
  const listener = await listenRelay({ host: '127.0.0.1', port: 0, token, isCurrent: () => true,
    onConnect: () => false, onRequest: () => { requests++; }, onDisconnect: () => { disconnects++; },
  });
  t.after(() => listener.close());
  const client = new WebSocket(`ws://127.0.0.1:${listener.port}/relay`);
  client.on('error', () => {}); await once(client, 'open');
  const closed = once(client, 'close'); setup(client); send(client, { type: 'prompt', voicePrompt: 'late', last: true });
  await closed;
  assert.equal(requests, 0); assert.equal(disconnects, 0);
});

test('fixed occupied port fails with sanitized error', async t => {
  const f = await fixture(t);
  await assert.rejects(listenRelay({ host: '127.0.0.1', port: f.listener.port, token,
    isCurrent: () => true, onConnect: () => true, onRequest: () => {}, onDisconnect: () => {},
  }), { message: 'Relay port is already in use' });
});


test('diagnostics correlate auth, input, queued speech, interrupt and fixed close without setup payloads', async t => {
  const events: DiagnosticEvent[] = [];
  const f = await fixture(t, event => events.push(event));
  const client = await f.connect(); setup(client);
  await until(() => f.peers.length === 1);
  send(client, { type: 'prompt', voicePrompt: 'hello', last: true });
  send(client, { type: 'interrupt', utteranceUntilInterrupt: 'private provider payload' });
  await until(() => f.requests.length === 2);
  assert.equal(f.peers[0]!.sendText('speech', true), true);
  const closed = once(client, 'close'); client.close(1000, 'private remote reason'); await closed;
  await until(() => f.disconnected.length === 1);
  assert.deepEqual(events.map(event => event.event), [
    'relay.upgrade', 'relay.connection', 'relay.auth.accepted', 'relay.prompt',
    'relay.interrupt', 'relay.text.enqueued', 'relay.close',
  ]);
  assert.ok(events.every(event => event.connectionId === f.peers[0]!.id));
  assert.ok(events.slice(2).every(event => event.sessionId === 'call-123'));
  assert.equal(events.at(-1)!.reason, 'remote_closed'); assert.equal(events.at(-1)!.code, 1000);
  const serialized = JSON.stringify(events);
  for (const privateValue of [token, 'customParameters', 'relayToken', 'private remote reason', 'private provider payload']) {
    assert.ok(!serialized.includes(privateValue));
  }
});

test('rejection diagnostics have pre-auth identity and never include supplied setup fields', async t => {
  const events: DiagnosticEvent[] = [], f = await fixture(t, event => events.push(event));
  const client = await f.connect(), closed = once(client, 'close');
  send(client, { type: 'setup', sessionId: 'untrusted-session', customParameters: { relayToken: 'body-secret' }, other: 'private-field' });
  await closed;
  assert.deepEqual(events.map(event => event.event), ['relay.upgrade', 'relay.connection', 'relay.auth.rejected', 'relay.close']);
  assert.ok(events[0]!.connectionId);
  assert.ok(events.every(event => event.connectionId === events[0]!.connectionId));
  assert.ok(!/untrusted-session|body-secret|private-field|customParameters/.test(JSON.stringify(events)));
});

test('throwing diagnostic sink cannot change input/output/disconnect behavior', async t => {
  const f = await fixture(t, () => { throw new Error('private diagnostic failure'); });
  const client = await f.connect(); setup(client); await until(() => f.peers.length === 1);
  send(client, { type: 'prompt', voicePrompt: 'hello', last: true }); await until(() => f.requests.length === 1);
  const message = once(client, 'message'); assert.equal(f.peers[0]!.sendText('ok', true), true); await message;
  const closed = once(client, 'close'); f.peers[0]!.close(); await closed;
  assert.equal(f.disconnected.length, 1);
});
