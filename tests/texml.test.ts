import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_TELNYX_VOICE, listenTexml, texmlDocument, validateTexml } from '../src/texml.js';
import { configuredMapping } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
async function port() { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as net.AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return p; }
const profile = { enabled: true, port: 43181, publicRelayUrl: 'wss://example.com/relay', secretName: 'test_relay' };
test('TeXML profile contains only a secret reference and rejects injected names/credential URLs', () => {
  const xml = texmlDocument(profile); assert.ok(xml.includes(`voice="${DEFAULT_TELNYX_VOICE}"`)); assert.ok(!xml.includes('voice="Telnyx.Ultra.Callie"')); assert.ok(xml.includes('{{#secret}}test_relay{{/secret}}')); assert.ok(xml.includes('partialPrompts="true"')); assert.ok(xml.includes('speechModel="flux"'));
  assert.ok(xml.includes('<Parameter name="relayToken" value="{{#secret}}test_relay{{/secret}}"'));
  for (const secretName of ['a"/>', '../x', '{{raw}}', '']) assert.throws(() => validateTexml({ ...profile, secretName }));
  for (const publicRelayUrl of ['ws://example.com/relay', 'wss://user:pass@example.com/relay', 'wss://example.com/relay?token=x', 'wss://example.com/other']) assert.throws(() => validateTexml({ ...profile, publicRelayUrl }));
  assert.throws(() => configuredMapping({ port: 43181, texml: profile }), /ports must differ/);
  const voice = 'Telnyx.Ultra.00967b2f-88a6-4a31-8153-110a92134b9f';
  assert.ok(texmlDocument({ ...profile, voice }).includes(`voice="${voice}"`));
  assert.equal(configuredMapping({ port: 43180, texml: { ...profile, voice } }).texml?.voice, voice);
  for (const voice of ['Callie', 'https://example.com', 'Telnyx.Ultra.x" bad="yes', '']) assert.throws(() => validateTexml({ ...profile, voice }));
});
test('owned TeXML listener serves fixed routes, omits request bodies from diagnostics and closes on invalidation', async t => {
  const p = await port(); let current = true;
  const events: unknown[] = [];
  const listener = await listenTexml({ host: '127.0.0.1', config: { ...profile, port: p }, isCurrent: () => current, diagnostic: event => events.push(event) });
  t.after(() => listener.close());
  const origin = `http://127.0.0.1:${p}`;
  const response = await fetch(origin + '/telnyx/relay', { method: 'POST', body: 'PRIVATE CALLER PAYLOAD' });
  assert.equal(response.status, 200); assert.ok((await response.text()).includes('{{#secret}}test_relay{{/secret}}'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE')); assert.equal(events.length, 1);
  assert.ok((await (await fetch(origin + '/telnyx/decline')).text()).includes('<Hangup/>'));
  assert.equal((await fetch(origin + '/')).status, 404);
  assert.equal((await fetch(origin + '/telnyx/relay?token=x')).status, 404);
  current = false; assert.equal(listener.isReady(), false); assert.equal((await fetch(origin + '/telnyx/relay')).status, 404);
  await listener.close(); await listener.close(); await assert.rejects(fetch(origin + '/telnyx/relay'));
});
test('runtime owns both relay and TeXML lifecycles and never serves the relay credential in XML', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-texml-runtime-')); const relayPort = await port(), xmlPort = await port();
  const runtime = new Runtime({ sessionId: () => 'voice-owner', onConnect: () => true, onRequest() {}, onDisconnect() {} }, { projectDirectory: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const { token } = await runtime.configure({ port: relayPort, texml: { ...profile, port: xmlPort }, diagnostics: { enabled: true, captureText: false } });
  const status = await runtime.enable(); assert.equal(status.texml?.state, 'ready'); assert.equal(status.diagnostics?.enabled, true);
  const xml = await (await fetch(`http://127.0.0.1:${xmlPort}/telnyx/relay`)).text(); assert.ok(!xml.includes(token));
  await runtime.disable(); assert.equal(runtime.status().texml?.state, 'stopped');
  await assert.rejects(fetch(`http://127.0.0.1:${xmlPort}/telnyx/relay`));
});
