import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { DiagnosticSink } from './diagnostics.js';

/** A public document contains only a Telnyx secret reference, never the relay token. */
export const DEFAULT_TELNYX_VOICE = 'Telnyx.Ultra.00a77add-48d5-4ef6-8157-71e5437b282d';
export interface TexmlConfig { enabled: boolean; port: number; publicRelayUrl: string; secretName: string; voice?: string }
export function validateTexml(value: TexmlConfig): TexmlConfig {
  if (!value || typeof value.enabled !== 'boolean' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.secretName !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.secretName)) throw new Error('Invalid TeXML configuration');
  if (value.voice !== undefined && (typeof value.voice !== 'string' || value.voice.length > 256 || !/^Telnyx\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.voice))) throw new Error('Invalid Telnyx voice identifier');
  const url = new URL(value.publicRelayUrl);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/relay') throw new Error('Invalid public relay URL');
  return { enabled: value.enabled, port: value.port, publicRelayUrl: url.href, secretName: value.secretName, ...(value.voice ? { voice: value.voice } : {}) };
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export function texmlDocument(input: TexmlConfig): string {
  const config = validateTexml(input);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><ConversationRelay url="${escape(config.publicRelayUrl)}" voice="${escape(config.voice ?? DEFAULT_TELNYX_VOICE)}" language="en" transcriptionProvider="deepgram" speechModel="flux" partialPrompts="true" interruptible="speech" welcomeGreeting="You are connected to Pi. How can I help?" welcomeGreetingInterruptible="speech" dtmfDetection="false"><Parameter name="relayToken" value="{{#secret}}${config.secretName}{{/secret}}" /></ConversationRelay></Connect><Hangup/></Response>\n`;
}
export interface TexmlListener { isReady(): boolean; close(): Promise<void> }
export async function listenTexml(options: { host: string; config: TexmlConfig; isCurrent(): boolean; diagnostic?: DiagnosticSink }): Promise<TexmlListener> {
  const document = texmlDocument(options.config);
  const sockets = new Set<Socket>(); let closing = false;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => {
    const current = !closing && options.isCurrent();
    const allowed = req.method === 'GET' || req.method === 'POST';
    const relay = req.url === '/telnyx/relay', decline = req.url === '/telnyx/decline';
    const ok = current && allowed && (relay || decline);
    options.diagnostic?.({ event: 'texml.request', reason: !current ? 'stale' : !ok ? 'not-found' : relay ? 'relay-template' : 'decline-template' });
    // Do not retain request bodies, caller identities or arbitrary request headers/URLs.
    res.writeHead(ok ? 200 : 404, { 'Content-Type': ok ? 'application/xml' : 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(ok ? relay ? document : '<?xml version="1.0"?><Response><Hangup/></Response>' : 'Not found');
  });
  server.maxConnections = 32;
  server.setTimeout(5000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  let stop: Promise<void> | undefined;
  const close = () => {
    if (stop) return stop; closing = true;
    stop = new Promise<void>(resolve => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); });
    return stop;
  };
  await new Promise<void>((resolve, reject) => {
    const fail = () => { void close(); reject(new Error('TeXML listener could not start')); };
    server.once('error', fail);
    server.listen({ host: options.host, port: options.config.port, exclusive: true }, () => {
      server.off('error', fail); server.on('error', () => { void close(); }); resolve();
    });
  });
  return { isReady: () => !closing && server.listening && options.isCurrent(), close };
}
