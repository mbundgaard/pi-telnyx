import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('package and lockfile identify pi-telnyx consistently', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@comput/pi-telnyx'); assert.equal(lock.name, pkg.name); assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.repository.url, 'git+https://github.com/mbundgaard/pi-telnyx.git');
});

test('Pi file loader loads the distributable TypeScript entry and all five tools', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'telnyx-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
    settingsManager: SettingsManager.inMemory(), noExtensions: true, noContextFiles: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [entry] });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.deepEqual(tools.sort(), ['telnyx_configure', 'telnyx_disable', 'telnyx_enable',
    'telnyx_status', 'telnyx_token'].sort());
});
