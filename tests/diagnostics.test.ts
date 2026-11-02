import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Diagnostics, type DiagnosticEvent } from '../src/diagnostics.ts';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'relay-diag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'private'), path: join(root, 'private', 'diagnostics.jsonl') };
}
function records(path: string): Record<string, any>[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
test('disabled diagnostics create nothing; close and writes are harmless', t => {
  const f = fixture(t), logger = new Diagnostics(f.directory, { enabled: false, captureText: true });
  logger.write({ event: 'ignored', text: 'secret' }); logger.close();
  assert.deepEqual(readdirSync(f.root), []);
  assert.deepEqual(logger.status(), { enabled: false, captureText: true });
});
test('metadata is whitelisted, text opt-in, all strings redact known secrets, permissions private', t => {
  const f = fixture(t), logger = new Diagnostics(f.directory, { enabled: true }, ['credential', 'long-credential']);
  t.after(() => logger.close());
  logger.write({ event: 'credential', connectionId: 'long-credential', operationId: 'credential',
    sessionId: 'credential', reason: 'credential', text: 'private speech', bytes: 10, code: 1000,
    last: false, customParameters: { relayToken: 'credential' }, extra: 'not logged' } as DiagnosticEvent);
  const [row] = records(f.path);
  assert.equal(row!.seq, 1); assert.ok(!Number.isNaN(Date.parse(row!.timestamp)));
  for (const key of ['event', 'connectionId', 'operationId', 'sessionId', 'reason']) assert.equal(row![key], '[REDACTED]');
  assert.equal(row!.text, undefined); assert.equal(row!.extra, undefined); assert.equal(row!.customParameters, undefined);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});
test('captured text is redacted before UTF-8 truncation and annotated', t => {
  const f = fixture(t), logger = new Diagnostics(f.directory, { enabled: true, captureText: true }, ['SECRET']);
  t.after(() => logger.close());
  logger.write({ event: 'speech', text: 'SECRET' + '😀'.repeat(9000) });
  logger.write({ event: 'speech', text: 'small' });
  const [first, second] = records(f.path);
  assert.ok(first!.text.startsWith('[REDACTED]'));
  assert.ok(Buffer.byteLength(first!.text) <= 8192);
  assert.equal(first!.textTruncated, true); assert.ok(first!.textBytes > 8192);
  assert.equal(second!.seq, 2); assert.equal(second!.text, 'small'); assert.equal(second!.textTruncated, undefined);
});
test('rotation keeps only bounded current plus one previous file', t => {
  const f = fixture(t), logger = new Diagnostics(f.directory, { enabled: true, captureText: true });
  t.after(() => logger.close());
  for (let i = 0; i < 400; i++) logger.write({ event: 'speech', text: 'x'.repeat(8192) });
  assert.equal(logger.status().error, undefined);
  assert.deepEqual(readdirSync(f.directory).sort(), ['diagnostics.jsonl', 'diagnostics.jsonl.1']);
  for (const file of [f.path, f.path + '.1']) {
    assert.ok(statSync(file).size <= 1024 * 1024); assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(records(f.path).at(-1)!.seq, 400);
});
test('symlink ancestors, current/previous symlinks and hardlinks fail closed without touching targets', t => {
  const f = fixture(t), target = join(f.root, 'target');
  mkdirSync(f.directory, { mode: 0o700 }); writeFileSync(target, 'untouched');
  for (const name of ['diagnostics.jsonl', 'diagnostics.jsonl.1']) {
    const bad = join(f.directory, name); symlinkSync(target, bad);
    const logger = new Diagnostics(f.directory, { enabled: true });
    assert.equal(logger.status().error, 'Diagnostic logging unavailable');
    assert.doesNotThrow(() => logger.write({ event: 'test' })); logger.close();
    assert.equal(readFileSync(target, 'utf8'), 'untouched'); rmSync(bad);
  }
  rmSync(f.path, { force: true }); linkSync(target, f.path);
  const hard = new Diagnostics(f.directory, { enabled: true }); assert.ok(hard.status().error); hard.close();
  const alias = join(f.root, 'alias'); symlinkSync(f.directory, alias);
  const parent = new Diagnostics(join(alias, 'nested'), { enabled: true });
  assert.ok(parent.status().error); parent.close();
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});
test('nonregular file rejected, later filesystem failure is sanitized and nonthrowing', t => {
  const f = fixture(t); mkdirSync(f.path, { recursive: true, mode: 0o700 });
  const invalid = new Diagnostics(f.directory, { enabled: true }); assert.ok(invalid.status().error); invalid.close();
  rmSync(f.path, { recursive: true });
  const logger = new Diagnostics(f.directory, { enabled: true });
  rmSync(f.path); symlinkSync('/no-such-private-credential', f.path);
  assert.doesNotThrow(() => logger.write({ event: 'safe' }));
  assert.equal(logger.status().error, 'Diagnostic logging unavailable'); logger.close();
});
