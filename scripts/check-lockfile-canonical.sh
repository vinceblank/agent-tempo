#!/usr/bin/env bash
#
# CI lint — fail if a non-canonical (non-npm) lockfile is tracked in git.
#
# Project standard is npm; see CLAUDE.md and `package.json#packageManager`.
# `pnpm-lock.yaml` is gitignored at the repo root (see .gitignore) so it can
# legitimately exist on disk for contributors who personally use pnpm — but it
# must NEVER appear in the git index. Same goes for any future yarn lockfile,
# and for the same files inside the dashboard/ subworkspace.
#
# Why git-tracked vs filesystem: pnpm-lock.yaml is gitignored on purpose, so a
# plain `[ -f pnpm-lock.yaml ]` check would false-positive on a perfectly fine
# local-only file. The policy violation is the file appearing in the index, not
# its existence on disk. Hence `git ls-files` — sees only what's tracked.
#
# Keep the script Bash-portable — CI runs on GitHub-hosted Ubuntu, but the same
# script should work on macOS (bash 3.2) and Git Bash on Windows for local runs.
#
# See #533 for the policy-gap that motivated this lint.

set -euo pipefail

# `git ls-files` only emits paths that are tracked. `2>/dev/null || true`
# guards the (unlikely) edge case of running outside a git repo.
files=$(
  git ls-files \
    pnpm-lock.yaml \
    yarn.lock \
    'dashboard/pnpm-lock.yaml' \
    'dashboard/yarn.lock' \
    2>/dev/null || true
)

if [ -n "$files" ]; then
  echo "ERROR: non-canonical lockfile tracked in git:"
  printf '  %s\n' $files
  echo
  echo "Project standard is npm. See CLAUDE.md and package.json#packageManager."
  echo "Remove the offending lockfile(s) with: git rm <path>"
  exit 1
fi

echo "Lockfile-canonical OK: only npm lockfiles are tracked."
