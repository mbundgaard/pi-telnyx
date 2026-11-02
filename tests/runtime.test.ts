import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, configuredMapping, validateMapping } from '../src/config.js';
import { Runtime, type Host } from '../src/runtime.js';

const host: Host = { sessionId: () => 'session-a', onConnect: () => true, onRequest() {}, onDisconnect() {} };
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'telnyx-relay-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('unmapped startup creates nothing; explicit configuration preserves tokens and enables idempotently', async t => {
  const root = await fixture(t), store = new ConfigStore(root);
  let starts = 0;
  const runtime = new Runtime(host, { projectDirectory: root, store, listen: async o => {
    starts++; return { host: o.host, port: o.port, isReady: () => true, close: async () => {} };
  } });
  t.after(() => runtime.close());
  assert.equal((await runtime.start()).configured, false); assert.equal(starts, 0);
  await assert.rejects(stat(store.directory), { code: 'ENOENT' });
  await assert.rejects(runtime.enable(), /No mapping/); assert.equal(starts, 0);
  assert.equal(store.directory, path.join(root, '.pi', 'telnyx'));
  const original = await runtime.configure({ port: 43180 });
  const saved = await runtime.configure({ port: 43180 });
  assert.equal(saved.token, original.token); assert.equal(saved.status.configured, true);
  assert.deepEqual(Object.keys(saved.status.mapping!).sort(), ['enabled', 'host', 'port']);
  assert.equal(saved.status.mapping?.enabled, false);
  await runtime.enable(); await runtime.enable(); assert.equal(starts, 1);
  assert.ok(!JSON.stringify(runtime.status()).includes(original.token));
  assert.equal((await runtime.token()).token, original.token);
  const rotated = await runtime.configure({ port: 43180, rotateToken: true }); assert.notEqual(rotated.token, original.token);
  assert.equal(runtime.status().listener, 'stopped');
});
test('only the explicit Telnyx configuration directory is read', async t => {
  const root = await fixture(t), store = new ConfigStore(root);
  const other = path.join(root, '.pi', 'unrelated'); await mkdir(other, { recursive: true, mode: 0o700 });
  await writeFile(path.join(other, 'config.json'), JSON.stringify({ version: 1, sessions: {
    'session-a': { ...configuredMapping({ port: 43180 }), enabled: true },
  } }), { mode: 0o600 });
  const runtime = new Runtime(host, { projectDirectory: root, listen: async () => { throw new Error('Must not listen'); } });
  t.after(() => runtime.close());
  assert.equal((await runtime.start()).configured, false);
  await assert.rejects(stat(store.directory), { code: 'ENOENT' });
});

test('Telnyx mappings reject unexpected fields', () => {
  const mapping = configuredMapping({ port: 43180 });
  assert.deepEqual(Object.keys(mapping).sort(), ['enabled', 'host', 'port', 'token']);
  assert.throws(() => validateMapping({ ...mapping, unexpected: 'value' }), /Unknown Telnyx mapping field/);
});

test('generation change closes late listener before a tunnel can start', async t => {
  const root = await fixture(t); let release!: () => void, began!: () => void, closed = 0;
  const starting = new Promise<void>(r => { began = r; }), gate = new Promise<void>(r => { release = r; });
  const runtime = new Runtime(host, { projectDirectory: root,
    listen: async o => { began(); await gate; return { host: o.host, port: o.port, isReady: () => true, close: async () => { closed++; } }; },
    startTunnel: async () => { throw new Error('must not start'); },
  });
  await runtime.configure({ port: 43180, tunnel: { enabled: true, tokenFile: '/protected/fixture.token' } });
  const enable = assert.rejects(runtime.enable(), /lifecycle/); await starting;
  const closing = runtime.close(); release(); await enable; await closing; assert.equal(closed, 1);
});
test('unconfirmed owned tunnel termination fences replacement resources', async t => {
  const root = await fixture(t); let starts = 0;
  const runtime = new Runtime(host, { projectDirectory: root,
    listen: async o => { starts++; return { host: o.host, port: o.port, isReady: () => true, close: async () => {} }; },
    startTunnel: async () => ({ status: () => ({ state: 'spawned', publicReachabilityVerified: false }), close: async () => { throw new Error('Unconfirmed shutdown'); } }),
  });
  await runtime.configure({ port: 43180, tunnel: { enabled: true, tokenFile: '/protected/fixture.token' } });
  await runtime.enable(); await assert.rejects(runtime.close(), /Unconfirmed/);
  await assert.rejects(runtime.start(), /Unconfirmed/); assert.equal(starts, 1);
});
test('configuration updates from separate stores serialize without losing mappings', async t => {
  const root = await fixture(t); const a = new ConfigStore(root), b = new ConfigStore(root);
  await Promise.all([a.update(c => { c.sessions.a = configuredMapping({ port: 43180 }); }), b.update(c => { c.sessions.b = configuredMapping({ port: 43181 }); })]);
  assert.deepEqual(Object.keys((await a.read()).sessions).sort(), ['a', 'b']);
  if (process.platform !== 'win32') assert.equal((await stat(a.file)).mode & 0o777, 0o600);
});
