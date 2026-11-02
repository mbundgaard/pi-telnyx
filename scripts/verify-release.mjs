import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyRelease(pkg, lock, env) {
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Publication requires a tag push');
  assert.equal(env.GITHUB_REF_TYPE, 'tag', 'Publication requires a tag');
  assert.equal(env.GITHUB_REPOSITORY, 'mbundgaard/pi-telnyx', 'Unexpected release repository');
  assert.equal(pkg.name, '@comput/pi-telnyx');
  assert.notEqual(pkg.private, true);
  assert.match(pkg.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/, 'Only stable x.y.z versions are supported');
  assert.equal(env.GITHUB_REF, `refs/tags/v${pkg.version}`, 'Tag must exactly match package version');
  assert.equal(lock.name, pkg.name); assert.equal(lock.packages?.['']?.name, pkg.name);
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages?.['']?.version, pkg.version);
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.publishConfig?.registry, 'https://registry.npmjs.org/');
  assert.equal(pkg.publishConfig?.provenance, true);
  return pkg.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  console.log(verifyRelease(pkg, lock, process.env));
}
