import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { DiagnosticEvent, DiagnosticSink } from './diagnostics.ts';

export interface RelayPeer {
  readonly id: string;
  readonly sessionId: string;
  sendText(text: string, last: boolean): boolean;
  close(code?: number, reason?: string): void;
}
export type RelayRequest = { type: 'prompt'; text: string; last: boolean } | { type: 'interrupt' };
export interface RelayListener { host: string; port: number; isReady(): boolean; close(): Promise<void> }

const MAX_FRAME = 64 * 1024;
const MAX_TEXT = 32 * 1024;
const MAX_PENDING = 8;
const SETUP_TIMEOUT = 5000;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bucket(capacity: number, perSecond: number): () => boolean {
  let tokens = capacity, previous = performance.now();
  return () => {
    const now = performance.now();
    tokens = Math.min(capacity, tokens + (now - previous) * perSecond / 1000);
    previous = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/** Only setup authenticates. No application frames are sent implicitly.
 * DTMF/unknown frames are ignored; provider error closes the call. Turn-boundary
 * notifications cancel only, never promote a partial transcript to model input.
 */
export async function listenRelay(options: {
  host: string; port: number; token: string; isCurrent(): boolean;
  diagnostic?: DiagnosticSink;
  onConnect(peer: RelayPeer): boolean;
  onRequest(peer: RelayPeer, request: RelayRequest): void;
  onDisconnect(peer: RelayPeer): void;
}): Promise<RelayListener> {
  if (typeof options.token !== 'string' || !options.token) throw new Error('Invalid relay credentials');
  const diagnostic = (event: DiagnosticEvent) => { try { options.diagnostic?.(event); } catch { /* Logging cannot affect transport. */ } };
  const expected = createHash('sha256').update(options.token).digest();
  let closing = false;
  const current = () => { try { return options.isCurrent(); } catch { return false; } };
  const sockets = new Set<Socket>();
  type Connection = { ws: WebSocket; peer?: RelayPeer; admitted: boolean; ended: boolean;
    finish(code?: number, reason?: string): void; alive: boolean };
  const connections = new Set<Connection>();
  let active: Connection | undefined;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (_req, res) => {
    res.writeHead(404, { Connection: 'close', 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Request rejected\n');
  });
  server.maxConnections = 32;
  server.setTimeout(10_000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (req, socket, head) => {
    const connectionId = randomUUID();
    diagnostic({ event: 'relay.upgrade', connectionId });
    // Only the Telnyx relay path accepts upgrades; credentials never belong in the URL.
    if (closing || !current() || req.method !== 'GET' || req.url !== '/relay'
      || active || connections.size >= MAX_PENDING) {
      diagnostic({ event: 'relay.upgrade.rejected', connectionId, reason: 'unavailable_or_invalid_route' });
      socket.destroy(); return;
    }
    try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, connectionId)); }
    catch { diagnostic({ event: 'relay.upgrade.rejected', connectionId, reason: 'upgrade_failed' }); socket.destroy(); }
  });
  wss.on('connection', (ws: WebSocket, connectionId: string) => {
    let authenticated = false;
    const emit = (event: DiagnosticEvent) => diagnostic({ ...event, connectionId,
      ...(connection.peer ? { sessionId: connection.peer.sessionId } : {}) });
    let setupTimer: ReturnType<typeof setTimeout>;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const rate = bucket(40, 20);
    const interruptRate = bucket(8, 4);
    const connection: Connection = { ws, admitted: false, ended: false, alive: true, finish(code = 1008, reason = 'protocol_rejected') {
      if (connection.ended) return;
      connection.ended = true;
      clearTimeout(setupTimer);
      if (active === connection) active = undefined;
      if (!authenticated) emit({ event: 'relay.auth.rejected', reason });
      emit({ event: 'relay.close', code, reason });
      // Revoke before callbacks and before the asynchronous close handshake.
      if (connection.admitted && connection.peer) {
        connection.admitted = false;
        try { options.onDisconnect(connection.peer); } catch { /* Never surface callback errors. */ }
      }
      connection.admitted = false;
      if (ws.readyState === WebSocket.CLOSED) return;
      try { ws.close(code, 'Relay closed'); } catch { ws.terminate(); }
      forceTimer = setTimeout(() => ws.terminate(), 250);
      forceTimer.unref();
    } };
    connections.add(connection);
    emit({ event: 'relay.connection' });
    setupTimer = setTimeout(() => connection.finish(1008, 'setup_timeout'), SETUP_TIMEOUT);
    setupTimer.unref();
    ws.on('error', () => connection.finish(1008, 'socket_error'));
    ws.on('close', (code: number) => {
      connection.finish(code, 'remote_closed');
      clearTimeout(forceTimer);
      connections.delete(connection);
    });
    ws.on('pong', () => { connection.alive = true; });
    ws.on('message', (data, binary) => {
      if (connection.ended) return;
      if (closing || !current()) { connection.finish(1008, 'runtime_inactive'); return; }
      if (binary || !rate()) { connection.finish(1008, 'frame_or_rate_rejected'); return; }
      let frame: unknown;
      try { frame = JSON.parse(data.toString()); } catch { connection.finish(); return; }
      if (!object(frame) || typeof frame.type !== 'string') { connection.finish(); return; }
      if (!connection.admitted) {
        if (frame.type !== 'setup' || typeof frame.sessionId !== 'string'
          || !frame.sessionId.trim() || Buffer.byteLength(frame.sessionId) > 1024
          || !object(frame.customParameters) || typeof frame.customParameters.relayToken !== 'string'
          || !timingSafeEqual(expected, createHash('sha256').update(frame.customParameters.relayToken).digest())
          || active) { connection.finish(1008, 'invalid_setup'); return; }
        const sessionId = frame.sessionId;
        authenticated = true;
        diagnostic({ event: 'relay.auth.accepted', connectionId, sessionId });
        const peer: RelayPeer = Object.freeze({ id: connectionId, sessionId,
          sendText(text: string, last: boolean): boolean {
            if (connection.ended || active !== connection || closing || !current()) {
              connection.finish(1008, 'runtime_inactive'); return false;
            }
            if (typeof text !== 'string' || typeof last !== 'boolean' || Buffer.byteLength(text) > MAX_TEXT) {
              connection.finish(1008, 'invalid_output'); return false;
            }
            const output = JSON.stringify({ type: 'text', token: text, last });
            if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + Buffer.byteLength(output) > MAX_FRAME) {
              connection.finish(1011, 'output_unavailable'); return false;
            }
            try {
              ws.send(output, error => { if (error) connection.finish(1011, 'send_failed'); });
              if (!connection.ended) emit({ event: 'relay.text.enqueued', text, last, bytes: Buffer.byteLength(text) });
              return !connection.ended;
            } catch { connection.finish(1011, 'send_failed'); return false; }
          },
          // Caller-supplied reasons are deliberately never echoed to the remote peer.
          close(code?: number, _reason?: string) {
            connection.finish(code === 1000 || code === 1001 || code === 1008 || code === 1011 ? code : 1000, 'local_close');
          },
        });
        connection.peer = peer;
        active = connection;
        clearTimeout(setupTimer);
        let accepted = false;
        try { accepted = options.onConnect(peer) === true; } catch { /* Fail closed. */ }
        if (!accepted) { connection.finish(1008, 'admission_rejected'); return; }
        connection.admitted = true;
        if (connection.ended) {
          connection.admitted = false;
          try { options.onDisconnect(peer); } catch { /* Cleanup belongs to this admitted peer even after invalidation. */ }
          return;
        }
        if (closing || !current()) connection.finish(1008, 'runtime_inactive');
        return;
      }
      if (frame.type === 'setup') { connection.finish(); return; }
      let request: RelayRequest;
      if (frame.type === 'prompt') {
        if (typeof frame.voicePrompt !== 'string' || typeof frame.last !== 'boolean'
          || Buffer.byteLength(frame.voicePrompt) > MAX_TEXT) { connection.finish(); return; }
        request = { type: 'prompt', text: frame.voicePrompt, last: frame.last };
      } else if (frame.type === 'interrupt' || frame.type === 'eagerEndOfTurn' || frame.type === 'turnResumed') {
        if (!interruptRate()) { connection.finish(1008, 'interrupt_rate_rejected'); return; }
        request = { type: 'interrupt' };
      } else {
        if (frame.type === 'error') connection.finish(1011, 'provider_error');
        return;
      }
      emit(request.type === 'prompt'
        ? { event: 'relay.prompt', text: request.text, last: request.last, bytes: Buffer.byteLength(request.text) }
        : { event: 'relay.interrupt' });
      try { options.onRequest(connection.peer!, request); } catch { connection.finish(1011, 'request_callback_failed'); }
    });
  });
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    for (const connection of connections) {
      if (closing || !current()) { connection.finish(1008, 'runtime_inactive'); continue; }
      if (connection.ended || !connection.admitted || ticks % 15 !== 0) continue;
      if (!connection.alive) { connection.finish(1008, 'heartbeat_timeout'); continue; }
      connection.alive = false;
      try { connection.ws.ping(); } catch { connection.finish(1008, 'heartbeat_failed'); }
    }
  }, 1000);
  heartbeat.unref();
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(heartbeat);
    // Publish the idempotent promise before any user disconnect callback can reenter.
    let resolveClose!: () => void;
    closePromise = new Promise<void>(resolve => { resolveClose = resolve; });
    for (const connection of connections) connection.finish(1001, 'listener_closed');
    server.close(() => resolveClose());
    for (const connection of connections) connection.ws.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close();
    return closePromise;
  }
  wss.on('error', () => { void close(); });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      void close();
      reject(new Error(error.code === 'EADDRINUSE' ? 'Relay port is already in use' : 'Relay could not start'));
    };
    server.once('error', failed);
    try {
      server.listen({ host: options.host, port: options.port, exclusive: true }, () => {
        server.off('error', failed);
        server.on('error', () => { void close(); });
        resolve();
      });
    } catch { server.off('error', failed); failed({} as NodeJS.ErrnoException); }
  });
  const address = server.address();
  return { host: options.host, port: typeof address === 'object' && address ? address.port : options.port,
    isReady: () => !closing && server.listening && current(), close };
}
