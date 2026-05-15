# Release Process: v1.0 and Beyond

The v1.0 rebrand from `claude-tempo` to `agent-tempo` is a one-time sequence;
subsequent releases follow the standard 4-step flow below.

## v1.0.0 Cutover Sequence (one-time, post-PR-4-merge)

Run these steps **in order** on the same day PR-4 merges. The merge commit's
`package.json` already points at the new repo path — GitHub auto-redirects
until step 2 completes.

### Step 1 — PR-4 merges

Normal merge to `main` via the standard PR workflow. The merge commit contains:

- `package.json#name`: `agent-tempo`
- `package.json` URL fields pointing at `vinceblank/agent-tempo`
- `bin` map: only `agent-tempo` + `agent-tempo-server` (the `claude-tempo*` aliases are dropped)
- CHANGELOG block `[1.0.0] - <merge-date>`

### Step 2 — Rename the GitHub repo

In GitHub UI, navigate to **Settings → General → Repository name** and rename
`claude-tempo` → `agent-tempo`. GitHub:

- Auto-redirects old URLs (HTTPS clones, web links, API calls, PR/issue links)
  indefinitely.
- Preserves all PR/issue numbers, stars, watchers, releases, contributors.
- Updates the canonical URL throughout the UI immediately.

After rename, every local clone needs a one-time `git remote set-url`:

```sh
git remote set-url origin https://github.com/vinceblank/agent-tempo.git
```

Old `origin` URLs continue to work via redirect, but updating is cleaner.

### Step 3 — Push the v1.0.0 git tag

From a clean checkout of the merged commit:

```sh
git tag -a v1.0.0 -m "agent-tempo v1.0.0 — rebrand release"
git push origin v1.0.0
```

### Step 4 — Publish to npm

From the tagged checkout:

```sh
git checkout v1.0.0
npm install                  # verify clean install
npm run build                # produce dist/
npm run check:all            # gate
npm publish                  # publishes agent-tempo@1.0.0 with the default 'latest' dist-tag
```

Verify with `npm view agent-tempo` — should show `version: 1.0.0`, `latest: 1.0.0`.

> **Publish is manual for v1.0.** The previous `.github/workflows/release.yml`
> auto-publish workflow was deleted in PR-4 because the NPM_TOKEN secret is
> scoped to `claude-tempo` and would need to be re-issued for `agent-tempo`
> anyway. Once the dust settles on the rebrand we can add a publish workflow
> back (issue tracking optional).

### Step 5 — Deprecate the `claude-tempo` package

```sh
npm deprecate "claude-tempo@>=0.29.1" "claude-tempo has been renamed to agent-tempo. Run: npm install agent-tempo. See https://github.com/vinceblank/agent-tempo/blob/main/docs/ops/v1.0-migration.md"
```

This applies the deprecation to v0.29.1+ versions on npm. Anyone running
`npm install claude-tempo` from this point on sees a prominent yellow warning.
Existing installs are unaffected — npm does not auto-uninstall deprecated packages.

To reverse (if needed): `npm deprecate claude-tempo@<version-range> ""` clears
the message.

### Step 6 — Draft GitHub release notes

From the v1.0.0 tag's GitHub UI ("Create release from tag"), populate the
release body from `CHANGELOG.md`'s `[1.0.0]` block.

- **Title**: `v1.0.0 — agent-tempo`
- **Body**: paste the `[1.0.0]` CHANGELOG content
- **Attach**: a link to `docs/ops/v1.0-migration.md`
- **Not pre-release**: leave the pre-release checkbox unchecked

## Standard Release Flow (v1.0.1+)

For all subsequent releases (patch, minor, major):

1. Bump `package.json` + `dashboard/package.json` version in lockstep via a PR.
   (`lint:lockstep-version` enforces parity.)
2. Update CHANGELOG `[Unreleased]` → `[<version>] - <date>` in the same PR.
3. Merge PR. Push tag `v<version>` from the merged commit.
4. `git checkout v<version> && npm publish` from a clean checkout. Then draft
   the GitHub release from the tag.

The `npm deprecate` step never repeats — once applied, the message stays.
Future `claude-tempo` patch releases (if any) automatically inherit the
deprecation if they fall in the deprecated version range.
