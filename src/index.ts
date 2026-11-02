import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Runtime } from './runtime.js';
import { Conversation, registerVoiceContext } from './conversation.js';
import { retire, drainRetired } from './ownership.js';

/** Telnyx Conversation Relay for one explicitly mapped Pi session. */
export default function telnyx(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;
  let conversation: Conversation | undefined;
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let generation = 0;
  registerVoiceContext(pi);
  const current = (ctx: ExtensionContext) => {
    if (!runtime || !context || context.sessionManager !== ctx.sessionManager || sessionId !== ctx.sessionManager.getSessionId())
      throw new Error('Conversation Relay requires an active persistent Pi session and confirmed resource cleanup');
    return runtime;
  };
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: undefined });
  const status = (ctx: ExtensionContext) => ({ ...current(ctx).status(), path: '/relay', conversation: conversation?.status() });

  pi.on('session_start', async (_event, ctx) => {
    const expected = ++generation;
    conversation?.close(); conversation = undefined;
    const previous = runtime; runtime = undefined; context = undefined; sessionId = undefined;
    if (previous) await retire(previous);
    await drainRetired();
    if (expected !== generation || !ctx.sessionManager.getSessionFile()) return;
    context = ctx; sessionId = ctx.sessionManager.getSessionId();
    const relay = new Conversation(pi, ctx, event => runtime?.diagnostic(event)); conversation = relay;
    const created = new Runtime({ sessionId: () => ctx.sessionManager.getSessionId(),
      onConnect: peer => expected === generation && relay.connect(peer),
      onRequest: (peer, request) => { if (expected === generation) relay.request(peer, request); },
      onDisconnect: peer => relay.disconnect(peer),
    }, { projectDirectory: ctx.cwd });
    runtime = created;
    try { await created.start(); }
    catch { if (expected === generation) ctx.ui.notify('Conversation Relay did not start. Check status and local configuration.', 'warning'); }
  });
  pi.on('session_shutdown', async () => {
    ++generation;
    conversation?.close(); conversation = undefined;
    const previous = runtime; runtime = undefined; context = undefined; sessionId = undefined;
    if (previous) await retire(previous);
  });
  pi.on('before_agent_start', event => conversation?.beforeStart(event));
  pi.on('message_start', event => conversation?.messageStart(event.message));
  pi.on('message_update', event => {
    if (event.assistantMessageEvent.type === 'text_delta') conversation?.text(event.assistantMessageEvent.delta);
  });
  pi.on('message_end', event => conversation?.messageEnd(event.message));
  pi.on('agent_settled', () => conversation?.settled());

  pi.registerTool({ name: 'telnyx_status', label: 'Conversation Relay status',
    description: 'Read this persistent session’s Telnyx WebSocket mapping, listener/tunnel state and call/operation state. Never returns credentials.',
    parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _update, ctx) => result(!ctx.sessionManager.getSessionFile()
      ? { configured: false, listener: 'stopped', reason: 'Persistent session required' } : status(ctx)),
  });
  pi.registerTool({ name: 'telnyx_token', label: 'Read Conversation Relay token',
    description: 'On the owner’s explicit request, return the saved relay authentication token for secure setup of Telnyx custom_parameters.relayToken. Intentionally includes the credential in this result/conversation. Does not rotate or restart anything. This is separate from the Cloudflare connector token.',
    parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => result(await current(ctx).token()),
  });
  pi.registerTool({ name: 'telnyx_configure', label: 'Configure Conversation Relay',
    description: 'Configure Telnyx Conversation Relay for this exact persistent session. Stops old resources and leaves disabled. Returns the relay token; Telnyx must send it in the first setup frame’s customParameters.relayToken. One call owns this session; public assistant text streams automatically, and incoming caller messages cancel its ongoing operation. No tunnel provisioning or account changes.',
    parameters: Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }),
      host: Type.Optional(Type.String({ description: 'Literal bind IP; default 127.0.0.1. Other exposure must be explicitly authorized.' })),
      rotateToken: Type.Optional(Type.Boolean()),
      diagnostics: Type.Optional(Type.Object({ enabled: Type.Boolean(), captureText: Type.Optional(Type.Boolean({ description: 'Explicitly capture bounded caller/public-assistant text in protected local debug logs. Off by default; may contain sensitive conversation content.' })) })),
      texml: Type.Optional(Type.Object({ enabled: Type.Boolean(), port: Type.Integer({ minimum: 1, maximum: 65535 }),
        publicRelayUrl: Type.String({ description: 'Public wss:// hostname with exact /relay path, no credentials/query.' }),
        secretName: Type.String({ description: 'Name of an existing Telnyx TeXML secret containing this relay token, NOT the token value. Serves /telnyx/relay and /telnyx/decline on the separate port.' }),
        voice: Type.Optional(Type.String({ description: 'Exact Telnyx-prefixed voice ID from the live /text-to-speech/voices catalog, not a display name. Defaults to the catalog-listed English Callie voice.' })) })),
      tunnel: Type.Optional(Type.Object({ enabled: Type.Boolean(),
        configFile: Type.Optional(Type.String({ description: 'Existing absolute local cloudflared config. Exactly one of configFile/tokenFile.' })),
        tokenFile: Type.Optional(Type.String({ description: 'Absolute protected connector-token file for a remotely managed tunnel. Never supply secret contents.' })),
      })),
    }),
    execute: async (_id, args, _signal, _update, ctx) => result(await current(ctx).configure(args)),
  });
  pi.registerTool({ name: 'telnyx_enable', label: 'Enable Conversation Relay',
    description: 'Enable this session’s explicitly saved Conversation Relay mapping. Opens WebSocket /relay and optionally its configured tunnel. No saved relay mapping means no exposure. Use only with owner authorization; a valid connected call can interrupt its operation and hear public assistant text.',
    parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => result(await current(ctx).enable()),
  });
  pi.registerTool({ name: 'telnyx_disable', label: 'Disable Conversation Relay',
    description: 'Disable this session’s relay and stop its owned listener/tunnel. Disconnect the call, discard waiting transcripts and request cancellation of its owned operation; no rollback of completed tool effects or guaranteed prompt termination. Preserve configuration and credentials. Never stop an independent tunnel.',
    parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => result(await current(ctx).disable()),
  });
}
