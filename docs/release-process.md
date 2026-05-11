# Release Process

## Correct order — never deviate

1. **Merge the feature PR into `main`** (squash merge). Never tag before the PR is merged.

2. **Bump version and update CHANGELOG on `main`**:
   - Increment `version` in `package.json`
   - Increment `version` in `dashboard/package.json` to the **same value** in the same commit.
     CI's `lint:lockstep-version` gate hard-fails if the two files diverge — missing this
     was the root cause of the beta.9 CI failure (#445).
   - Regenerate `dashboard/package-lock.json` to record the new version:
     ```bash
     npm install --prefix dashboard --package-lock-only
     ```
     > ⚠️ **CI does not validate `dashboard/package-lock.json`.** The lockstep gate only
     > compares the two `package.json` version fields. A stale lockfile compiles silently
     > but publishes the wrong dependency tree — the foot-gun that let a `beta.15` lockfile
     > ride through to `beta.17` undetected (#543). Always regenerate it in the bump commit.
   - Add a `## [x.y.z] - YYYY-MM-DD` entry in `CHANGELOG.md` with Added/Changed/Fixed sections
   - CHANGELOG entries should be user-facing — what changed, why it matters, what to do
     differently. Not internal refactoring details.

3. **Commit the bump**:
   ```bash
   # All three version files must be included in the same commit
   git add package.json dashboard/package.json dashboard/package-lock.json CHANGELOG.md
   git commit -m "chore: bump version to vX.Y.Z"
   ```

4. **Tag the bump commit and push the tag**:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   The GitHub Actions release workflow triggers on `v*` tag pushes and publishes to npm.

## Critical rules

> **Never tag before the version bump commit exists on `main`.** Tagging prematurely
> (e.g., before a feature PR merges, or before the bump commit) publishes the old version
> to npm and forces a recovery patch bump.

> **Never tag a commit that doesn't match the version in `package.json`.** The tag, the
> version file, and the published package must all agree.

## Beta / pre-release

For pre-release versions (e.g., `0.25.0-beta.1`), follow the same sequence. The `npm publish`
step uses the tag's pre-release suffix to avoid overwriting the `latest` dist-tag.

## Related

- [CHANGELOG.md](../CHANGELOG.md) — release notes
- `package.json` — version field
- `.github/workflows/release.yml` — release workflow
