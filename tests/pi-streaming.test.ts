import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

// Capability probe, not the Conversation Relay implementation. No WebSocket, Telnyx,
// microphone or hosted model is used. The real Pi runtime receives a controlled stream.
for (const incremental of [true, false]) {
  test(`Pi extension streaming hooks: ${incremental ? 'text arrives before completion' : 'buffered provider cannot produce live deltas'}`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'telnyx-pi-streaming-'));
    const agentDir = path.join(root, 'agent'); await mkdir(agentDir);
    const forwarded: string[] = [], events: string[] = [];
    let providerFinished = false, messageEnded = false, settled = false, runResolved = false;
    let release: (() => void) | undefined, sawFirst!: () => void;
    const firstDelta = new Promise<void>(resolve => { sawFirst = resolve; });
    const observer = (pi: ExtensionAPI) => {
      pi.on('message_update', event => {
        if (event.assistantMessageEvent.type !== 'text_delta') return;
        // A transport could write this delta now; no final message or tool is required.
        forwarded.push(event.assistantMessageEvent.delta);
        events.push('delta');
        if (forwarded.length === 1) {
          assert.equal(providerFinished, false, 'Pi must not wait for provider completion');
          assert.equal(messageEnded, false);
          assert.equal(settled, false);
          sawFirst();
        }
      });
      pi.on('message_end', event => { if (event.message.role === 'assistant') { messageEnded = true; events.push('message_end'); } });
      pi.on('agent_settled', () => { settled = true; events.push('settled'); });
    };
    const provider = (pi: ExtensionAPI) => pi.registerProvider('streaming-capability', {
      api: 'streaming-capability', baseUrl: 'http://127.0.0.1/never-used', apiKey: 'synthetic-local-test-key',
      models: [{ id: 'synthetic', name: 'Synthetic streaming capability test', reasoning: false, input: ['text'],
        contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [{ type: 'text', text: '' }], stopReason: 'pending',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const content = message.content[0]!; assert.equal(content.type, 'text');
        if (content.type !== 'text') throw new Error('Invalid fixture');
        const finish = () => {
          if (incremental) {
            content.text += 'answer.';
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'answer.', partial: message });
            stream.push({ type: 'text_end', contentIndex: 0, content: content.text, partial: message });
          } else content.text = 'First answer.';
          message.stopReason = 'stop'; providerFinished = true;
          stream.push({ type: 'done', reason: 'stop', message }); stream.end();
        };
        queueMicrotask(() => {
          stream.push({ type: 'start', partial: message });
          if (incremental) {
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            content.text = 'First ';
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'First ', partial: message });
            release = finish; // Withhold the rest until the real extension hook observes this delta.
          } else finish();
        });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [provider, observer] });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(agentDir, 'models'), refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, modelRuntime, settingsManager,
      sessionManager: SessionManager.create(root, path.join(root, 'sessions')), tools: [], thinkingLevel: 'off' });
    t.after(async () => {
      release?.(); release = undefined;
      await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose(); await rm(root, { recursive: true, force: true });
    });
    const errors: string[] = [];
    await session.bindExtensions({ mode: 'rpc', onError: event => errors.push(event.error) });
    const model = modelRuntime.getModel('streaming-capability', 'synthetic'); assert.ok(model);
    await session.setModel(model, { persist: false });
    const run = session.prompt('Synthetic test of incremental output.').then(() => { runResolved = true; });
    void run.catch(() => {});
    if (incremental) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([firstDelta, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No live text delta')), 5000); })]); }
      finally { clearTimeout(timer); }
      assert.deepEqual(forwarded, ['First ']);
      assert.equal(runResolved, false); assert.equal(providerFinished, false); assert.equal(session.isStreaming, true);
      release!(); release = undefined;
    }
    await run;
    assert.equal(providerFinished, true); assert.equal(messageEnded, true); assert.equal(settled, true);
    assert.equal(session.getLastAssistantText(), 'First answer.');
    assert.deepEqual(forwarded, incremental ? ['First ', 'answer.'] : []);
    if (incremental) assert.deepEqual(events, ['delta', 'delta', 'message_end', 'settled']);
    assert.deepEqual(errors, []);
  });
}
