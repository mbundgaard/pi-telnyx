import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventBus, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Conversation, MESSAGE_TYPE } from '../src/conversation.js';
import type { RelayPeer } from '../src/relay-transport.js';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) { if (check()) return; await sleep(10); } throw new Error('Condition did not settle'); }
function fixture(t: { after(fn: () => void): void }, record = true, events?: ExtensionAPI['events']) {
  let busy = false, aborts = 0;
  const sent: Array<{ customType: string; content: unknown; details: unknown }> = [];
  const frames: Array<{ text: string; last: boolean }> = [], closes: number[] = [];
  const peer: RelayPeer = { id: 'connection-a', sessionId: 'call-a', sendText(text, last) { frames.push({ text, last }); return true; }, close(code) { closes.push(code ?? 1000); } };
  let conversation!: Conversation;
  const pi = { events, sendMessage(message: typeof sent[number]) {
    sent.push(message); busy = true;
    conversation.beforeStart({ messageType: 'custom', message });
    if (record) conversation.messageStart({ role: 'custom', ...message });
  } } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => 'session-a' }, isIdle: () => !busy, hasPendingMessages: () => false, abort: () => { aborts++; } } as unknown as ExtensionContext;
  conversation = new Conversation(pi, ctx); t.after(() => conversation.close());
  assert.equal(conversation.connect(peer), true);
  return { conversation, peer, frames, closes, sent, aborts: () => aborts, idle: () => { busy = false; } };
}
test('every incoming message rechecks cancellation; completed pending utterances survive newer partials', async t => {
  const f = fixture(t);
  f.conversation.request(f.peer, { type: 'prompt', text: 'Original.', last: true }); await until(() => f.sent.length === 1);
  f.conversation.text('Hello😀'); assert.deepEqual(f.frames, [{ text: 'Hello', last: false }]);
  f.conversation.request(f.peer, { type: 'prompt', text: 'partial', last: false });
  f.conversation.request(f.peer, { type: 'prompt', text: 'Completed request one.', last: true });
  f.conversation.request(f.peer, { type: 'prompt', text: 'new partial', last: false });
  f.conversation.request(f.peer, { type: 'prompt', text: 'Completed request two.', last: true });
  assert.equal(f.aborts(), 4);
  f.conversation.text('Never transmit'); f.conversation.messageEnd({ role: 'assistant', stopReason: 'stop' }); assert.equal(f.frames.length, 1);
  await sleep(40); assert.equal(f.sent.length, 1);
  f.idle(); f.conversation.settled(); await until(() => f.sent.length === 2);
  assert.deepEqual(f.sent[1]!.content, [{ type: 'text', text: 'Completed request one.' }, { type: 'text', text: 'Completed request two.' }]);
  assert.equal(f.sent[1]!.customType, MESSAGE_TYPE);
});
test('cancellation timeout still observes idle after async preparation failure without agent_settled', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, false);
  f.conversation.request(f.peer, { type: 'prompt', text: 'Preparing.', last: true }); await until(() => f.sent.length === 1);
  f.conversation.request(f.peer, { type: 'prompt', text: 'Interrupt.', last: false }); now += 10001;
  await until(() => f.closes.length === 1); assert.equal(f.conversation.status().connected, false);
  // Let the already-scheduled post-disconnect poll also pass the timeout, then fail
  // preparation. No agent_settled is emitted for that asynchronous preparation failure.
  await sleep(80);
  f.idle(); await until(() => !f.conversation.status().operation);
  assert.equal(f.conversation.connect({ ...f.peer, id: 'connection-b' }), true);
});
test('unrelated custom input revokes output without aborting it', async t => {
  const f = fixture(t);
  f.conversation.request(f.peer, { type: 'prompt', text: 'Voice input.', last: true }); await until(() => f.sent.length === 1);
  f.conversation.messageStart({ role: 'custom', customType: 'other-extension', details: { operationId: 'unrelated' } });
  f.conversation.text('Private other-extension response');
  assert.equal(f.frames.length, 0); assert.equal(f.aborts(), 0); assert.equal(f.closes.length, 1);
  assert.equal(f.conversation.status().connected, false);
});
test('unadmitted final is retained after cancellation before preparation completed', async t => {
  const f = fixture(t, false);
  f.conversation.request(f.peer, { type: 'prompt', text: 'First complete utterance.', last: true }); await until(() => f.sent.length === 1);
  f.conversation.request(f.peer, { type: 'prompt', text: 'Second complete utterance.', last: true });
  f.idle(); f.conversation.settled(); await until(() => f.sent.length === 2);
  assert.deepEqual(f.sent[1]!.content, [{ type: 'text', text: 'First complete utterance.' }, { type: 'text', text: 'Second complete utterance.' }]);
});

test('pause is requested once per admitted call, never on rejected connection or disconnect', t => {
  const events = createEventBus(); let requests = 0;
  events.on('pi-background:pause', value => {
    requests++; events.emit('pi-background:pause:result', { ...(value as object), ok: true });
  });
  const f = fixture(t, true, events);
  assert.equal(requests, 1); assert.equal(f.conversation.status().backgroundPause?.state, 'confirmed');
  assert.equal(f.sent.length, 0, 'pause must not inject an agent message');
  assert.equal(f.conversation.connect({ ...f.peer, id: 'other' }), false); assert.equal(requests, 1);
  f.conversation.disconnect(f.peer); assert.equal(requests, 1, 'do not clear or replace the pause on disconnect');
  assert.equal(f.conversation.connect(f.peer), true); assert.equal(requests, 2);
  f.conversation.close(); assert.equal(requests, 2);
});

test('optional pause bus failure does not reject a call or prevent ordinary transcript processing', async t => {
  const events = createEventBus(); events.emit = () => { throw new Error('PRIVATE background failure'); };
  const f = fixture(t, true, events);
  assert.equal(f.conversation.status().backgroundPause?.state, 'error'); assert.equal(f.closes.length, 0);
  f.conversation.request(f.peer, { type: 'prompt', text: 'Still works.', last: true });
  await until(() => f.sent.length === 1);
  f.conversation.text('Public reply.'); f.conversation.messageEnd({ role: 'assistant', stopReason: 'stop' });
  assert.equal(f.frames.map(frame => frame.text).join(''), 'Public reply.'); assert.equal(f.closes.length, 0);
});
