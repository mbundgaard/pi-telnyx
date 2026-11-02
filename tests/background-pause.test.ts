import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createEventBus, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { requestBackgroundPause } from '../src/background-pause.js';

const request = 'pi-background:pause', response = 'pi-background:pause:result';
function fixture() {
  const emitter = new EventEmitter();
  const events: ExtensionAPI['events'] = {
    emit: (channel, value) => { emitter.emit(channel, value); },
    on: (channel, handler) => { emitter.on(channel, handler); return () => { emitter.off(channel, handler); }; },
  };
  return { emitter, events };
}

test('compatible background receives one session-targeted absolute 30-minute pause and confirms synchronously on real Pi bus', t => {
  const now = Date.parse('2030-01-01T12:00:00Z'); t.mock.method(Date, 'now', () => now);
  const events = createEventBus(); let count = 0;
  events.on(request, value => {
    const p = value as Record<string, unknown>; count++;
    assert.equal(p.sessionId, 'owner'); assert.equal(p.pausedUntil, '2030-01-01T12:30:00.000Z');
    assert.equal(typeof p.requestId, 'string'); assert.deepEqual(Object.keys(p).sort(), ['pausedUntil', 'requestId', 'sessionId']);
    events.emit(response, { ...p, ok: true });
  });
  assert.deepEqual(requestBackgroundPause(events, 'owner'), { state: 'confirmed', requestedUntil: '2030-01-01T12:30:00.000Z' });
  assert.equal(count, 1);
});

test('missing or older background is best effort: no wait/retry, no remaining listener', () => {
  const { events, emitter } = fixture(); let count = 0;
  emitter.on(request, () => count++); // Older extension never acknowledges this protocol.
  assert.equal(requestBackgroundPause(events, 'owner').state, 'unconfirmed');
  assert.equal(count, 1); assert.equal(emitter.listenerCount(response), 0);
  assert.equal(requestBackgroundPause(createEventBus(), 'owner').state, 'unconfirmed');
  assert.equal(requestBackgroundPause(undefined, 'owner').state, 'unavailable');
});

test('rejection, wrong IDs, malformed replies and wrong expiry never claim protection or expose response payloads', () => {
  for (const mode of ['rejected', 'requestId', 'sessionId', 'expiry', 'malformed']) {
    const { events, emitter } = fixture();
    emitter.on(request, p => {
      const reply = { ...p, ok: true, error: 'PRIVATE ERROR' };
      if (mode === 'rejected') reply.ok = false;
      if (mode === 'requestId') reply.requestId = 'wrong';
      if (mode === 'sessionId') reply.sessionId = 'wrong';
      if (mode === 'expiry') reply.pausedUntil = null;
      events.emit(response, mode === 'malformed' ? null : reply);
    });
    const result = requestBackgroundPause(events, 'owner');
    assert.equal(result.state, mode === 'rejected' ? 'rejected' : 'unconfirmed');
    assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(emitter.listenerCount(response), 0);
  }
});

test('late reply cannot mutate the returned status or retain a listener', async () => {
  const { events, emitter } = fixture();
  emitter.on(request, p => queueMicrotask(() => events.emit(response, { ...p, ok: true })));
  const result = requestBackgroundPause(events, 'owner');
  await Promise.resolve(); assert.equal(result.state, 'unconfirmed'); assert.equal(emitter.listenerCount(response), 0);
});

test('subscribe, emit and unsubscribe exceptions cannot escape optional integration', () => {
  for (const phase of ['subscribe', 'emit', 'unsubscribe']) {
    const { events, emitter } = fixture();
    const originalOn = events.on;
    events.on = (channel, handler) => {
      if (phase === 'subscribe') throw new Error('PRIVATE');
      const off = originalOn(channel, handler);
      return () => { off(); if (phase === 'unsubscribe') throw new Error('PRIVATE'); };
    };
    if (phase === 'emit') events.emit = () => { throw new Error('PRIVATE'); };
    const result = requestBackgroundPause(events, 'owner');
    assert.equal(result.state, phase === 'unsubscribe' ? 'unconfirmed' : 'error');
    assert.equal(emitter.listenerCount(response), 0); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
