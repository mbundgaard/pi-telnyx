#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@comput/pi-telnyx';
export const REQUIRED_FILES = Object.freeze([
  'package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md',
  'docs/user-guide.md', 'docs/development.md', 'docs/deployment.md',
  'docs/conversation-relay-spec.md', 'docs/releasing.md',
  'src/background-pause.ts', 'src/config.ts', 'src/conversation.ts',
  'src/diagnostics.ts', 'src/index.ts', 'src/ownership.ts',
  'src/relay-transport.ts', 'src/runtime.ts', 'src/texml.ts', 'src/tunnel.ts',
]);

export function checkManifest(manifest, expectedVersion) {
  if (!manifest || manifest.name !== PACKAGE_NAME) {
    throw new Error(`Package name must be ${PACKAGE_NAME}`);
  }
  if (manifest.private === true) throw new Error('Package must not be private');
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Package must have a version');
  }
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw new Error(`Package version must be ${expectedVersion}`);
  }
  return manifest;
}

// Never normalize first: that would hide traversal, doubled separators or aliases.
export function checkFiles(files, { archive = false } = {}) {
  if (!Array.isArray(files)) throw new Error('Expected a file array');
  const allowed = new Set(REQUIRED_FILES);
  const seen = new Set();
  for (const entry of files) {
    if (typeof entry !== 'string' || !entry || /[\\\x00-\x1f\x7f]/.test(entry)
      || entry.startsWith('/') || /^[a-z]:/i.test(entry)
      || entry.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe package path: ${JSON.stringify(entry)}`);
    }
    if (archive && !entry.startsWith('package/')) {
      throw new Error(`Archive path must start with package/: ${entry}`);
    }
    const name = archive ? entry.slice('package/'.length) : entry;
    if (!allowed.has(name)) throw new Error(`Unexpected packaged file: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate packaged file: ${name}`);
    seen.add(name);
  }
  const missing = REQUIRED_FILES.filter(name => !seen.has(name));
  if (missing.length) throw new Error(`Missing packaged files: ${missing.join(', ')}`);
  return [...seen];
}

export function parsePackMetadata(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  const entries = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === 'object' ? Object.values(parsed) : [];
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object') {
    throw new Error('Expected exactly one npm pack result');
  }
  return entries[0];
}

export function checkPackMetadata(input, manifest) {
  checkManifest(manifest);
  const metadata = parsePackMetadata(input);
  checkManifest(metadata, manifest.version);
  if (!Array.isArray(metadata.files)) throw new Error('npm pack result has no file array');
  checkFiles(metadata.files.map(file => file?.path));
  return metadata;
}

// Windows requires cmd for npm.cmd. The command contains fixed arguments only;
// destinations go through the environment, never shell interpolation.
export function npmPack({ cwd, dryRun = true, destination } = {}) {
  const args = ['pack', '--ignore-scripts', '--json', ...(dryRun ? ['--dry-run'] : [])];
  const options = {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(destination ? { npm_config_pack_destination: destination } : {}) },
  };
  return process.platform === 'win32'
    ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], options)
    : execFileSync('npm', args, options);
}

export function checkArchive(archivePath, manifest) {
  checkManifest(manifest);
  const archive = path.resolve(archivePath);
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const listing = execFileSync('tar', ['-tzf', archive], options);
  const entries = listing.replace(/\r?\n$/, '').split(/\r?\n/);
  checkFiles(entries, { archive: true });
  // A matching pathname alone must not admit symlinks, hardlinks or devices.
  const verbose = execFileSync('tar', ['-tvzf', archive], options);
  const records = verbose.replace(/\r?\n$/, '').split(/\r?\n/);
  if (records.length !== entries.length || records.some(line => !line.startsWith('-'))) {
    throw new Error('Archive must contain regular files only');
  }
  const packagedManifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], options));
  checkManifest(packagedManifest, manifest.version);
  return entries;
}

function main(args) {
  if (args.length > 1) throw new Error('Usage: node scripts/check-package.mjs [archive-path]');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = checkManifest(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')));
  if (args.length) checkArchive(args[0], manifest);
  else checkPackMetadata(npmPack({ cwd: root }), manifest);
  console.log(`Package checked: ${manifest.name}@${manifest.version} (${REQUIRED_FILES.length} files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Package check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
