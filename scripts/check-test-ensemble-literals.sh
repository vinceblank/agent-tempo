#!/usr/bin/env bash
#
# CI lint — fail if the literal `'test-ensemble'` shows up in a test file.
#
# Under the shared `TestWorkflowEnvironment` rollout (#210), test files must
# derive their ensemble namespace from the per-file random prefix seeded by
# `setupTestEnv()` (exposed as `getTestEnsemble()` / the `playerMetadata()`
# default). Literal `'test-ensemble'` re-introduces the cross-file workflow-ID
# collisions the shared env was designed to avoid — e.g. two files both
# starting `claude-session-test-ensemble-conductor`.
#
# Allowed locations:
#   - test/helpers.ts — owns the fallback default; one literal kept as safety
#     net for tests that import helpers without calling setupTestEnv().
#   - test/root-hooks.ts — imports helpers, no literal of its own, allowed.
#   - scripts/ — this script and any peers can reference the literal in help text.
#   - docs/ — design docs and migration guides can reference the literal.
#
# Anywhere else inside `test/` is a lint failure.
#
# Keep the grep Bash-portable — CI runs on GitHub-hosted Ubuntu, but the same
# script should work on macOS (bash 3.2) and Git Bash on Windows for local runs.

set -euo pipefail

# Find literal occurrences in test/ except helpers.ts and root-hooks.ts.
# `|| true` prevents set -e from aborting when grep finds zero matches.
matches=$(
  grep -rn --include='*.ts' --include='*.js' \
    -e "'test-ensemble'" \
    -e '"test-ensemble"' \
    test/ 2>/dev/null \
    | grep -v '^test/helpers\.ts:' \
    | grep -v '^test/root-hooks\.ts:' \
    || true
)

if [[ -n "$matches" ]]; then
  echo 'FAIL: literal `test-ensemble` found in test/ outside helpers.ts / root-hooks.ts'
  echo ''
  echo "$matches"
  echo ''
  echo 'Under shared TestWorkflowEnvironment (#210), tests must derive the ensemble'
  echo 'from playerMetadata() / getTestEnsemble() — not the literal string.'
  echo 'Replace the literal with the helper-provided default (see test/helpers.ts).'
  exit 1
fi

echo 'OK: no stray `test-ensemble` literals in test/'
