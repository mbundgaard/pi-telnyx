import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import extension from '../src/index.js';
import { MESSAGE_TYPE } from '../src/conversation.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(predicate: () => boolean | Promise<boolean>, label = 'condition') {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await sleep(10); }
}
async function freePort() {
  const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return port;
}
interface Plan { hold?: boolean; holdAbort?: boolean; tool?: boolean; text?: string }
interface Control { aborted: boolean; text(text: string): void; finish(): void; finishAbort(): void }

test('real Pi + WebSocket relay: incremental output, every-message interruption, finals, tools, disconnect and reload', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'telnyx-relay-sdk-'));
  const agentDir = path.join(root, 'agent'); await mkdir(agentDir);
  const plans: Plan[] = [], controls: Control[] = [], errors: string[] = [];
  let holdTool = false, toolStarted = false, toolCancelled = false, toolExecutions = 0;
  let pauseReply: 'none' | 'confirm' | 'reject' = 'none';
  const pauseRequests: Array<{ requestId: string; sessionId: string; pausedUntil: string }> = [];
  const provider = (pi: ExtensionAPI) => {
    pi.events.on('pi-background:pause', value => {
      const request = value as typeof pauseRequests[number]; pauseRequests.push(request);
      if (pauseReply !== 'none') pi.events.emit('pi-background:pause:result', { ...request, ok: pauseReply === 'confirm' });
    });
    pi.registerTool({ name: 'synthetic_read', label: 'Synthetic read', description: 'Test fixture only.', parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        toolExecutions++; toolStarted = true;
        if (holdTool) await new Promise<void>(resolve => {
          const abort = () => { toolCancelled = true; resolve(); };
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
        });
        return { content: [{ type: 'text', text: 'PRIVATE TOOL RESULT' }], details: undefined };
      } });
    pi.registerProvider('relay-test', { api: 'relay-test', baseUrl: 'http://127.0.0.1/unused', apiKey: 'synthetic-test-key',
      models: [{ id: 'test', name: 'Synthetic relay model', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, _context, options) {
        const plan = plans.shift() ?? { text: 'Default answer.' };
        const toolId = `synthetic-tool-${controls.length}`;
        const stream = createAssistantMessageEventStream();
        const response: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '' }], stopReason: 'pending',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const textPart = response.content[1]!; if (textPart.type !== 'text') throw new Error();
        let finished = false;
        const control: Control = { aborted: false,
          text(delta) { if (finished) return; textPart.text += delta; stream.push({ type: 'text_delta', contentIndex: 1, delta, partial: response }); },
          finish() {
            if (finished) return; finished = true;
            stream.push({ type: 'text_end', contentIndex: 1, content: textPart.text, partial: response });
            if (plan.tool) {
              response.content.push({ type: 'toolCall', id: toolId, name: 'synthetic_read', arguments: {} });
              stream.push({ type: 'toolcall_start', contentIndex: 2, partial: response });
              stream.push({ type: 'toolcall_delta', contentIndex: 2, delta: '{}', partial: response });
              stream.push({ type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: toolId, name: 'synthetic_read', arguments: {} }, partial: response });
            }
            response.stopReason = plan.tool ? 'toolUse' : 'stop';
            stream.push({ type: 'done', reason: plan.tool ? 'toolUse' : 'stop', message: response }); stream.end();
          },
          finishAbort() {
            if (finished) return;
            control.text('STALE OUTPUT MUST NOT SPEAK'); finished = true;
            response.stopReason = 'aborted'; response.errorMessage = 'Synthetic cancellation';
            stream.push({ type: 'error', reason: 'aborted', error: response }); stream.end();
          },
        };
        controls.push(control);
        options?.signal?.addEventListener('abort', () => { control.aborted = true; if (!plan.holdAbort) control.finishAbort(); }, { once: true });
        queueMicrotask(() => {
          stream.push({ type: 'start', partial: response });
          stream.push({ type: 'thinking_start', contentIndex: 0, partial: response });
          stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'PRIVATE THINKING FIXTURE', partial: response });
          stream.push({ type: 'thinking_end', contentIndex: 0, content: 'PRIVATE THINKING FIXTURE', partial: response });
          stream.push({ type: 'text_start', contentIndex: 1, partial: response });
          if (plan.text) control.text(plan.text);
          if (!plan.hold) control.finish();
        });
        return stream;
      },
    });
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [provider, extension] });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(agentDir, 'models'), refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(root, path.join(root, 'sessions')), tools: ['synthetic_read'], thinkingLevel: 'off' });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const control of controls) control.finishAbort();
    for (const socket of sockets) socket.terminate();
    await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose(); await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: 'rpc', onError: e => errors.push(e.error) });
  await session.setModel(modelRuntime.getModel('relay-test', 'test')!, { persist: false });
  session.setActiveToolsByName(['synthetic_read']);
  const call = async (name: string, args = {}) => {
    const runner = session.extensionRunner, tool = runner.getToolDefinition(name)!;
    const result = await tool.execute('test', args, new AbortController().signal, undefined, runner.createToolContext('test', undefined));
    const text = result.content.find(part => part.type === 'text'); assert.ok(text?.type === 'text'); return JSON.parse(text.text);
  };
  const port = await freePort();
  await assert.rejects(call('telnyx_enable'), /No mapping/);
  const { token } = await call('telnyx_configure', { port, diagnostics: { enabled: true, captureText: true } });
  await call('telnyx_enable');
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'unsupported HTTP input' })).status, 404);
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`); sockets.push(ws); await once(ws, 'open');
    const frames: Array<{ type: string; token: string; last: boolean }> = [];
    ws.on('message', data => frames.push(JSON.parse(data.toString())));
    ws.send(JSON.stringify({ type: 'setup', sessionId: 'test-call', customParameters: { relayToken: token } }));
    await until(async () => (await call('telnyx_status')).conversation.connected, 'setup');
    return { ws, frames, prompt: (text: string, last: boolean) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt: text, last })) };
  };
  const first = await connect();
  assert.equal((await call('telnyx_status')).conversation.backgroundPause.state, 'unconfirmed');
  assert.equal(pauseRequests.length, 1, 'missing/older background must not prevent connection or cause retries');
  first.prompt('partial not submitted', false); await sleep(80); assert.equal(controls.length, 0);
  plans.push({ hold: true, text: 'Hello 📨 ' }); first.prompt('Complete utterance.', true);
  await until(() => first.frames.length > 0, 'live first delta');
  assert.equal(session.isStreaming, true); assert.equal(first.frames[0]!.last, false);
  assert.equal(first.frames.map(f => f.token).join(''), 'Hello 📨');
  controls[0]!.text('world.'); controls[0]!.finish();
  await until(() => first.frames.some(f => f.last) && !session.isStreaming, 'first completion');
  assert.equal(first.frames.map(f => f.token).join(''), 'Hello 📨 world.');
  assert.equal(first.ws.readyState, WebSocket.OPEN);

  // An announcement followed by a real tool call is spoken; tool payload/result/thinking are not.
  const beforeTool = first.frames.length;
  plans.push({ tool: true, text: 'Checking now. ' }, { text: 'Found the answer.' }); first.prompt('Use the synthetic tool.', true);
  await until(() => first.frames.slice(beforeTool).filter(f => f.last).length === 2 && !session.isStreaming, 'tool continuation');
  assert.equal(first.frames.slice(beforeTool).map(f => f.token).join(''), 'Checking now. Found the answer.');
  assert.ok(!JSON.stringify(first.frames).includes('PRIVATE'));
  assert.ok(!JSON.stringify(first.frames).includes('synthetic_read'));
  assert.equal(toolExecutions, 1, 'the fixture tool must actually execute');

  // Every partial/final message checks current work; final waits for slow abort to settle.
  plans.push({ hold: true, holdAbort: true, text: 'Old response still running. ' }); first.prompt('Original request.', true);
  await until(() => controls.length === 4 && first.frames.at(-1)?.last === false, 'old active response');
  const old = controls[3]!;
  first.prompt('New partial', false); await until(() => old.aborted, 'first partial abort');
  const frameBoundary = first.frames.length;
  old.text('LATE PRIVATE TEXT'); await sleep(50); assert.equal(first.frames.length, frameBoundary);
  first.prompt('Newer partial', false); first.prompt('New final request.', true);
  await sleep(50); assert.equal(controls.length, 4, 'no overlapping run while abort pending');
  plans.push({ text: 'Replacement answer.' }); old.finishAbort();
  await until(() => controls.length === 5 && !session.isStreaming && first.frames.at(-1)?.last === true, 'replacement');
  assert.equal(first.frames.slice(frameBoundary).map(f => f.token).join(''), 'Replacement answer.');
  const transcripts = session.messages.flatMap(m => m.role === 'custom' && m.customType === MESSAGE_TYPE ? [m.content] : []);
  assert.ok(transcripts.includes('Original request.')); assert.ok(transcripts.includes('New final request.'));
  assert.ok(!transcripts.includes('New partial')); assert.ok(!transcripts.includes('Newer partial'));

  // Final-only input must also interrupt; disconnect must not redirect late deltas to the next call.
  plans.push({ hold: true, text: 'Running before final-only interrupt. ' }); first.prompt('Another operation.', true);
  await until(() => controls.length === 6, 'final-only fixture');
  plans.push({ text: 'Final-only replacement.' }); first.prompt('A complete interrupting request.', true);
  await until(() => controls[5]!.aborted && controls.length === 7 && !session.isStreaming, 'final-only interruption');
  const closed = once(first.ws, 'close'); await call('telnyx_disable'); await closed;
  assert.equal((await call('telnyx_status')).conversation.connected, false);
  assert.equal(pauseRequests.length, 1, 'disconnect does not issue an early resume');
  pauseReply = 'confirm';
  await call('telnyx_enable'); const second = await connect();
  const pauseStatus = (await call('telnyx_status')).conversation.backgroundPause;
  assert.equal(pauseStatus.state, 'confirmed'); assert.equal(pauseRequests.length, 2);
  assert.equal(pauseStatus.requestedUntil, pauseRequests[1]!.pausedUntil);
  controls[5]!.text('VERY LATE OLD CALL TEXT'); await sleep(50); assert.equal(second.frames.length, 0);
  plans.push({ text: 'New call reply.' }); second.prompt('New call input.', true);
  await until(() => second.frames.some(f => f.last) && !session.isStreaming, 'new call');
  assert.equal(second.frames.map(f => f.token).join(''), 'New call reply.');
  holdTool = true; toolStarted = false;
  plans.push({ tool: true, text: 'Starting a cancellable tool. ' }); second.prompt('Run cancellable work.', true);
  await until(() => toolStarted, 'tool execution');
  second.prompt('Stop that tool', false);
  await until(() => toolCancelled && !session.isStreaming, 'tool cancellation');
  assert.equal(toolExecutions, 2, 'cancel must not replay the tool');
  holdTool = false; plans.push({ text: 'Tool stopped; new request received.' }); second.prompt('A new task after stopping the tool.', true);
  await until(() => second.frames.some(f => f.token.includes('Tool stopped')) && !session.isStreaming, 'post-tool replacement');
  assert.ok(!JSON.stringify(second.frames).includes('PRIVATE TOOL RESULT'));
  // A queued console follow-up joins the same host run without before_agent_start.
  // It must revoke call output authority, but must NOT be aborted or spoken to the caller.
  const beforeForeign = controls.length;
  plans.push({ hold: true, text: 'Call-owned response. ' }); second.prompt('Call-owned work before console input.', true);
  await until(() => controls.length === beforeForeign + 1, 'foreign-follow-up fixture');
  const foreignClose = once(second.ws, 'close');
  await session.sendUserMessage('PRIVATE CONSOLE INPUT', { deliverAs: 'followUp' });
  plans.push({ text: 'PRIVATE CONSOLE ANSWER' }); controls[beforeForeign]!.finish();
  await foreignClose; await until(() => !session.isStreaming, 'console continuation');
  assert.ok(!JSON.stringify(second.frames).includes('PRIVATE CONSOLE'));
  assert.equal(controls.at(-1)!.aborted, false, 'unrelated continuation must not be cancelled');
  pauseReply = 'reject';
  const third = await connect();
  assert.equal((await call('telnyx_status')).conversation.backgroundPause.state, 'rejected');
  assert.equal(pauseRequests.length, 3, 'rejection remains best effort');
  const reloadClose = once(third.ws, 'close'); await session.reload(); await reloadClose;
  assert.equal((await call('telnyx_status')).listener, 'ready');
  assert.equal((await call('telnyx_status')).conversation.connected, false);
  assert.deepEqual(errors, []);
  const diagnosticText = await readFile(path.join(root, '.pi/telnyx/diagnostics.jsonl'), 'utf8');
  assert.ok(!diagnosticText.includes(token)); assert.ok(!diagnosticText.includes('PRIVATE'));
  const diagnostics = diagnosticText.trim().split('\n').map(line => JSON.parse(line));
  for (const event of ['relay.auth.accepted', 'relay.prompt', 'relay.text.enqueued', 'operation.abort-requested', 'operation.settled', 'call.authority-revoked', 'relay.close'])
    assert.ok(diagnostics.some(row => row.event === event), event);
  assert.ok(diagnostics.some(row => row.text === 'Complete utterance.'));
  for (const reason of ['unconfirmed', 'confirmed', 'rejected'])
    assert.ok(diagnostics.some(row => row.event === 'background.pause' && row.reason === reason));
});
