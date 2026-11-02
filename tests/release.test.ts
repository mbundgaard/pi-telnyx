import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// @ts-expect-error Repository-only release scripts are native JavaScript.
import { verifyRelease } from '../scripts/verify-release.mjs';
// @ts-expect-error Repository-only release scripts are native JavaScript.
import { registryURL, verifyMetadata, verifyTarball, verifyProvenance, verifyPublished } from '../scripts/verify-published.mjs';

const pkg = { name: '@comput/pi-telnyx', version: '0.2.0', publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/', provenance: true } };
const lock = { name: pkg.name, version: pkg.version, packages: { '': { name: pkg.name, version: pkg.version } } };
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF: 'refs/tags/v0.2.0', GITHUB_REPOSITORY: 'mbundgaard/pi-telnyx' };
test('release requires exact stable identity/version and intended repository tag event', () => {
  assert.equal(verifyRelease(pkg, lock, env), '0.2.0');
  for (const change of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF_TYPE: 'branch' }, { GITHUB_REF: 'refs/tags/v0.3.0' }, { GITHUB_REPOSITORY: 'other/project' }])
    assert.throws(() => verifyRelease(pkg, lock, { ...env, ...change }));
  for (const change of [{ private: true }, { name: 'other' }, { version: '0.2.0-beta' }, { version: '0.2.0\n' }, { publishConfig: { access: 'restricted' } }])
    assert.throws(() => verifyRelease({ ...pkg, ...change }, lock, env));
  assert.throws(() => verifyRelease(pkg, { ...lock, version: '0.1.0' }, env));
});

test('workflow publishes exact artifact with job-scoped OIDC, no manual release trigger or ambient npm token', async () => {
  const text = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(text, /tags: \['v\*'\]/); assert.doesNotMatch(text, /workflow_dispatch:|pull_request_target:|\brelease:/);
  assert.match(text, /needs: validate/); assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.equal(text.match(/id-token: write/g)?.length, 1);
  assert.match(text, /npm publish "\$RELEASE_ARCHIVE"/); assert.match(text, /--provenance --ignore-scripts --fetch-retries=0/);
  assert.match(text, /env -u NODE_AUTH_TOKEN -u NPM_TOKEN/); assert.match(text, /verify-published\.mjs/);
  assert.match(text, /git cat-file -t/); assert.match(text, /check-package\.mjs "\$RELEASE_ARCHIVE"/);
});

const expected = { version: '0.2.0', commit: 'a'.repeat(40), repo: 'mbundgaard/pi-telnyx', workflow: '.github/workflows/publish.yml', runId: '123', runAttempt: '1' };
const bytes = Buffer.from('synthetic release artifact');
const sha512 = createHash('sha512').update(bytes).digest('hex');
const slsa = 'https://slsa.dev/provenance/v1';
function fixtures() {
  const metadata = { name: pkg.name, version: pkg.version, gitHead: expected.commit, dist: {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    tarball: 'https://registry.npmjs.org/@comput/pi-telnyx/-/pi-telnyx-0.2.0.tgz',
    attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/test', provenance: { predicateType: slsa } },
  } };
  const repository = `https://github.com/${expected.repo}`, ref = 'refs/tags/v0.2.0';
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicateType: slsa,
    subject: [{ name: 'pkg:npm/%40comput/pi-telnyx@0.2.0', digest: { sha512 } }],
    predicate: { buildDefinition: { buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: { workflow: { repository, ref, path: expected.workflow } },
      resolvedDependencies: [{ uri: `git+${repository}@${ref}`, digest: { gitCommit: expected.commit } }] },
    runDetails: { metadata: { invocationId: `${repository}/actions/runs/123/attempts/1` } } } };
  const attestations = { attestations: [{ predicateType: slsa, bundle: { dsseEnvelope: {
    payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  } } }] };
  return { metadata, attestations };
}
test('registry checks bind exact bytes and provenance linkage without claiming signature verification', () => {
  const { metadata, attestations } = fixtures(); const dist = verifyMetadata(metadata, expected);
  assert.equal(verifyTarball(bytes, bytes, dist), sha512);
  assert.equal(verifyProvenance(attestations, expected, sha512).signaturesVerified, false);
  assert.throws(() => verifyTarball(bytes, Buffer.from('different'), dist));
  assert.throws(() => verifyProvenance(attestations, { ...expected, commit: 'b'.repeat(40) }, sha512));
  assert.throws(() => verifyMetadata({ ...metadata, name: 'other' }, expected));
  for (const url of ['http://registry.npmjs.org/x', 'https://example.com/x', 'https://user:pass@registry.npmjs.org/x', 'https://registry.npmjs.org/x?token=a'])
    assert.throws(() => registryURL(url));
});
test('post-publication verification only reads fixed-origin registry data without credentials or redirects', async () => {
  const { metadata, attestations } = fixtures(); let reads = 0;
  const result = await verifyPublished(expected, bytes, { fetch: async (url: string, options: RequestInit) => {
    reads++; assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(new URL(url).hostname, 'registry.npmjs.org');
    if (url === metadata.dist.tarball) return new Response(bytes);
    if (url === metadata.dist.attestations.url) return Response.json(attestations);
    return Response.json(metadata);
  } });
  assert.equal(reads, 3); assert.equal(result.linkageChecked, true);
});
