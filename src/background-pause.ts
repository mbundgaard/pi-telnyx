import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const REQUEST = 'pi-background:pause';
const RESULT = 'pi-background:pause:result';
const CALL_PAUSE_MS = 30 * 60 * 1000;
export interface BackgroundPauseResult {
  state: 'confirmed' | 'unconfirmed' | 'rejected' | 'unavailable' | 'error';
  /** Requested expiry, not proof that a background extension applied it. */
  requestedUntil: string;
}

/** Optional cooperative integration. Never waits, prompts the agent, retries or blocks a call.
 * The background pause contract acknowledges synchronously on the in-process event bus.
 * Missing/older extensions (or late/malformed replies) leave protection unconfirmed.
 */
export function requestBackgroundPause(events: ExtensionAPI['events'] | undefined, sessionId: string): BackgroundPauseResult {
  const requestedUntil = new Date(Date.now() + CALL_PAUSE_MS).toISOString();
  const result: BackgroundPauseResult = { state: 'unconfirmed', requestedUntil };
  let off: (() => void) | undefined;
  try {
    if (!events || typeof events.on !== 'function' || typeof events.emit !== 'function') {
      result.state = 'unavailable'; return result;
    }
    const requestId = randomUUID();
    off = events.on(RESULT, (value: unknown) => {
      if (!value || typeof value !== 'object' || result.state !== 'unconfirmed') return;
      const reply = value as Record<string, unknown>;
      if (reply.requestId !== requestId || reply.sessionId !== sessionId) return;
      if (reply.ok === true && reply.pausedUntil === requestedUntil) result.state = 'confirmed';
      else if (reply.ok === false) result.state = 'rejected';
    });
    events.emit(REQUEST, { requestId, sessionId, pausedUntil: requestedUntil });
  } catch {
    // Do not expose another extension's exception or change call admission.
    if (result.state !== 'confirmed') result.state = 'error';
  } finally {
    try { off?.(); } catch { /* Optional integration cleanup must not break the call. */ }
  }
  return result;
}
