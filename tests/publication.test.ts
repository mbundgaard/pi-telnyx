import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
// The release checker is executable JavaScript, deliberately without a build step.
// @ts-expect-error No declaration file for the standalone .mjs checker.
import { REQUIRED_FILES, checkManifest, checkFiles, parsePackMetadata, checkPackMetadata, checkArchive, npmPack } from '../scripts/check-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/check-package.mjs');
const files = REQUIRED_FILES as readonly string[];
const manifest = { name: '@comput/pi-telnyx', version: '1.2.3' };
const metadata = () => ({ ...manifest, files: files.map(name => ({ path: name, size: 1 })) });

test('publication metadata accepts npm arrays and package-keyed maps', () => {
  for (const result of [[metadata()], { '@comput/pi-telnyx@1.2.3': metadata() }]) {
    assert.deepEqual(checkPackMetadata(result, manifest), metadata());
    assert.deepEqual(checkPackMetadata(JSON.stringify(result), manifest), metadata());
  }
  for (const invalid of [null, [], {}, [metadata(), metadata()], { one: metadata(), two: metadata() }]) {
    assert.throws(() => parsePackMetadata(invalid), /exactly one/);
  }
  assert.throws(() => parsePackMetadata('not json'), SyntaxError);
  assert.throws(() => checkPackMetadata([{ ...manifest }], manifest), /file array/);
});

test('publication file policy requires every exact file and rejects extras and duplicates', () => {
  assert.deepEqual(checkFiles([...files]), files);
  assert.deepEqual(checkFiles(files.map(name => `package/${name}`), { archive: true }), files);
  for (const missing of files) {
    assert.throws(() => checkFiles(files.filter(name => name !== missing)), /Missing packaged files/);
  }
  for (const extra of ['tests/publication.test.ts', '.pi/session.json', '.env', 'credentials.json',
    'docs/nested/secret.md', 'src/nested/index.ts', 'dist/index.js', 'node_modules/ws/index.js',
    'scripts/check-package.mjs', 'package-lock.json']) {
    assert.throws(() => checkFiles([...files, extra]), /Unexpected packaged file/);
    assert.throws(() => checkFiles([...files.map(name => `package/${name}`), `package/${extra}`],
      { archive: true }), /Unexpected packaged file/);
  }
  assert.throws(() => checkFiles([...files, files[0]]), /Duplicate/);
});

test('publication paths reject traversal and noncanonical archive entries', () => {
  for (const bad of ['../package.json', 'src/../package.json', './package.json', '/package.json',
    'src//index.ts', 'src\\index.ts', 'C:/package.json', 'package.json\0', 'README.md\n',
    'package/', '', 'package/../package.json']) {
    assert.throws(() => checkFiles([...files, bad]), /Unsafe/);
    assert.throws(() => checkFiles([...files.map(name => `package/${name}`), `package/${bad}`],
      { archive: true }), /Unsafe|Unexpected/);
  }
  assert.throws(() => checkFiles([...files], { archive: true }), /must start with package/);
  assert.throws(() => checkFiles(['other/package.json'], { archive: true }), /must start with package/);
});

test('publication manifest and metadata guard identity, visibility and version', () => {
  assert.deepEqual(checkManifest(manifest), manifest);
  assert.doesNotThrow(() => checkManifest({ ...manifest, private: false }));
  for (const name of ['pi-telnyx', '@other/pi-telnyx', undefined]) {
    assert.throws(() => checkManifest({ ...manifest, name }), /Package name/);
    assert.throws(() => checkPackMetadata([{ ...metadata(), name }], manifest), /Package name/);
  }
  assert.throws(() => checkManifest({ ...manifest, private: true }), /private/);
  assert.throws(() => checkPackMetadata([metadata()], { ...manifest, private: true }), /private/);
  assert.throws(() => checkPackMetadata([{ ...metadata(), private: true }], manifest), /private/);
  assert.throws(() => checkManifest({ ...manifest, version: '' }), /version/);
  assert.throws(() => checkPackMetadata([{ ...metadata(), version: '9.9.9' }], manifest), /version/);
});

test('archive checks inspect the packaged manifest and reject hardlinks', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pi-telnyx-archive-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = path.join(temporary, 'package');
  for (const name of files) {
    await mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
    await writeFile(path.join(fixture, name), 'fixture');
  }
  const archive = path.join(temporary, 'fixture.tgz');
  const packFixture = () => execFileSync('tar', ['-czf', archive, '-C', temporary,
    ...files.map(name => `package/${name}`)]);
  for (const [changes, message] of [
    [{ name: 'pi-telnyx' }, /Package name/],
    [{ private: true }, /private/],
    [{ version: '9.9.9' }, /version/],
  ] as const) {
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ ...manifest, ...changes }));
    packFixture();
    assert.throws(() => checkArchive(archive, manifest), message);
  }
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify(manifest));
  packFixture();
  assert.equal(checkArchive(archive, manifest).length, files.length);
  await rm(path.join(fixture, 'README.md'));
  await link(path.join(fixture, 'package.json'), path.join(fixture, 'README.md'));
  packFixture();
  assert.throws(() => checkArchive(archive, manifest), /regular files only/);
});

test('real npm artifact passes CLI checks and loads all five tools from extracted source', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pi-telnyx-publication-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const packed = checkPackMetadata(npmPack({ cwd: root, dryRun: false, destination: temporary }), sourceManifest);
  assert.equal(typeof packed.filename, 'string');
  assert.equal(path.basename(packed.filename), packed.filename);
  const archive = path.join(temporary, packed.filename);
  const output = execFileSync(process.execPath, [script, archive], { cwd: temporary, encoding: 'utf8' });
  assert.match(output, /Package checked: @comput\/pi-telnyx@/);

  // Extract each already validated regular file as bytes into a fresh directory.
  // Never let tar choose output paths or create archive-provided links.
  const extracted = path.join(temporary, 'extracted');
  await mkdir(extracted);
  for (const name of files) {
    const destination = path.join(extracted, name);
    await mkdir(path.dirname(destination), { recursive: true });
    const contents = execFileSync('tar', ['-xOzf', archive, `package/${name}`], { maxBuffer: 16 * 1024 * 1024 });
    await writeFile(destination, contents, { flag: 'wx' });
  }
  await symlink(path.join(root, 'node_modules'), path.join(extracted, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const packagedManifest = JSON.parse(await readFile(path.join(extracted, 'package.json'), 'utf8'));
  assert.deepEqual(packagedManifest.pi.extensions, ['./src/index.ts']);
  const isolated = path.join(temporary, 'agent');
  await mkdir(isolated);
  const loader = new DefaultResourceLoader({
    cwd: isolated, agentDir: isolated, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [path.join(extracted, packagedManifest.pi.extensions[0])],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual(loaded.extensions.flatMap(extension => [...extension.tools.keys()]).sort(), [
    'telnyx_configure', 'telnyx_disable', 'telnyx_enable', 'telnyx_status', 'telnyx_token',
  ]);
});
