# Publishing @comput/pi-telnyx

The public GitHub repository is **mbundgaard/pi-telnyx**. The npm identity is **@comput/pi-telnyx**, with public access and provenance. Source is shipped as TypeScript and loaded by Pi; there is no build output or bundled copy of Pi.

## Release policy

- Ordinary branch pushes and pull requests run CI, not publication.
- Only an explicitly authorized, annotated stable `vX.Y.Z` tag triggers `.github/workflows/publish.yml`.
- The tag must match `package.json` and both lockfile version fields exactly. All three package names must match.
- Publication validates the exact tagged commit on Linux with Node 22 and 24, checks production dependencies, and enforces a strict artifact allowlist.
- The publish job alone receives `id-token: write`. It uses npm Trusted Publishing (OIDC), not a stored npm token.
- The exact packed tarball is checked, hashed, retained as a workflow artifact and published once with provenance. A read-only check compares registry bytes/hashes and decoded provenance repository, tag, commit, workflow and run linkage.
- The verifier checks linkage, not independent DSSE signatures or certificate chains. Do not describe it as complete cryptographic provenance verification.
- Publication does not install the extension or change any running Telnyx session.

## One-time owner setup

1. Verify npm ownership/access to the `@comput` scope and that the proposed package/version are available. Registry errors other than an authenticated/expected not-found result are not proof of availability.
2. In npm Trusted Publisher settings, select GitHub Actions with owner `mbundgaard`, repository `pi-telnyx`, workflow `publish.yml`, and no GitHub environment.
3. If npm requires an initial package to exist before this configuration can be saved, arrange a separately approved first-publication bootstrap using npm's supported owner authentication/2FA flow. Do not invent a token secret, disable account security, or assume that preparing this workflow registers a Trusted Publisher automatically.
4. Verify GitHub Actions is enabled and the repository is public. Enable private vulnerability reporting for the security-policy link.

No npm publication or external Trusted Publisher registration is implied by committing these files. Arrange first-publication authentication before pushing a release tag.

## Preparing a release

1. Review source and release notes. Keep private session files, configuration, diagnostics, tunnel credentials and deployment-specific scripts outside Git.
2. Choose an unused stable version and update package/lockfile versions together. Do not reuse a version after an uncertain publish.
3. Run:

   ```bash
   npm ci
   npm run validate
   npm run pack:check
   npm audit --omit=dev --audit-level=moderate
   npm audit --audit-level=moderate
   git diff --check
   ```

   The enforced dependency gate covers production dependencies. Review the full development audit separately: the pinned Pi 1.4.0 development host currently brings moderate transitive minimatch advisories. Host peers use `*` as required by Pi's package convention; supported behavior is tested against Pi 1.4.0, not arbitrary host versions. Repository overrides do not upgrade consumers' Pi installations.

4. Inspect the archive contents. Only the explicit source modules, selected public docs, manifest and license may ship. Tests, scripts, workflows, session data and credentials are excluded.
5. With authorization, push the reviewed commit to `main`, and verify CI passes for that exact commit.
6. Check npm and local/remote tags again. With separate publication authorization, create an annotated tag pointing to the reviewed commit and push only that tag:

   ```bash
   git tag -a vX.Y.Z <reviewed-commit> -m "Release vX.Y.Z"
   git push origin refs/tags/vX.Y.Z
   ```

## Verification and uncertainty

The workflow retains the archive and npm pack metadata. The post-publication verifier performs bounded read-only polling for registry visibility; it never publishes, mutates tags or retries a publish.

If publication or verification is uncertain, inspect the run and registry first. **Do not rerun the publish job, move the tag or reuse the version blindly.** A failed verification step can follow a successful publication.

Verify the version/dist-tag, compare the downloaded archive with the retained artifact, inspect npm provenance, and test installation in a clean Pi project. Separate publication success from runtime deployment and owner-observed call success.
