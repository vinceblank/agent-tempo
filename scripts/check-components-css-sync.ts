#!/usr/bin/env node
/**
 * Drift report for `dashboard/src/styles/components.css` — F-LEAD-1
 * follow-up (PR-B of #454).
 *
 * The dashboard's `components.css` is a SELECTIVE port of the canonical
 * hand-off bundle at `docs/design/dashboard-handoff/project/styles.css`.
 * The port is re-synced manually each minor release until shadcn lands
 * (see `docs/design/components-css-port-procedure.md`). This script
 * surfaces how stale the port is — reads the LAST-SYNC commit out of
 * the file's header and compares it against the most recent canonical
 * commit. The number you see is the *line count of canonical drift*,
 * not the number of impl-side edits required to absorb it.
 *
 * Output:
 *   - 0 added/deleted lines        → exit 0, "in sync"
 *   - 1..49 lines                  → exit 0, "minor drift"
 *   - 50..150 lines                → exit 0, prints WARN banner
 *                                    (CI may treat as warning)
 *   - 151+ lines                   → exit 1, prints FAIL banner
 *                                    (CI hard-fails, PR-B-style
 *                                    re-sync needed)
 *
 * Usage:
 *   npm run build:scripts
 *   node dist/scripts/check-components-css-sync.js
 *
 * Or one-shot via ts-node:
 *   npx ts-node scripts/check-components-css-sync.ts
 *
 * CI integration:
 *   The `dashboard-build` job in `.github/workflows/...` runs the
 *   compiled `dist/scripts/check-components-css-sync.js` after the
 *   dashboard build. Failure mode (>150 lines) blocks merge.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMPONENTS_CSS = path.join(REPO_ROOT, 'dashboard', 'src', 'styles', 'components.css');
const CANONICAL_CSS_REPO = path.join('docs', 'design', 'dashboard-handoff', 'project', 'styles.css');
const CANONICAL_CSS_FS = path.join(REPO_ROOT, CANONICAL_CSS_REPO);

const WARN_THRESHOLD = 50;
const FAIL_THRESHOLD = 150;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

function fail(msg: string): never {
  console.error(`[check-components-css-sync] ${msg}`);
  process.exit(EXIT_USAGE);
}

function readLastSyncCommit(): string {
  if (!fs.existsSync(COMPONENTS_CSS)) {
    fail(`components.css not found at ${COMPONENTS_CSS}`);
  }
  const head = fs.readFileSync(COMPONENTS_CSS, 'utf8').slice(0, 4000);
  const match = head.match(/LAST-SYNC COMMIT:\s+([0-9a-f]{7,40})/i);
  if (!match) {
    fail(
      'components.css header is missing the "LAST-SYNC COMMIT: <sha>" line. ' +
      'The drift detector cannot run without a baseline. Re-add the marker per ' +
      'docs/design/components-css-port-procedure.md.',
    );
  }
  return match[1];
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function commitExists(sha: string): boolean {
  try {
    git('cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * If the LAST-SYNC commit isn't in the local object DB (typical of
 * GitHub Actions' default shallow checkout), try to fetch it directly.
 * Belt-and-braces with the workflow-level `fetch-depth: 0` — if a future
 * job copies the script without copying that checkout option, the script
 * still self-heals instead of hard-failing.
 *
 * Returns true if the commit is reachable after the attempted fetch.
 * Stays silent on success; logs the fetch attempt on failure for diagnostics.
 */
function tryFetchCommit(sha: string): boolean {
  try {
    // `--no-tags --depth=1` is enough — we only need the commit object
    // for `git diff`, not its ancestry.
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', sha], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return commitExists(sha);
  } catch (err) {
    console.error(`[check-components-css-sync] git fetch origin ${sha.slice(0, 12)} failed:`);
    console.error('  ' + (err instanceof Error ? err.message : String(err)).split('\n').join('\n  '));
    return false;
  }
}

function latestCanonicalCommit(): string {
  const sha = git('log', '-1', '--format=%H', '--', CANONICAL_CSS_REPO);
  if (!sha) {
    fail(
      `git log returned no commits for ${CANONICAL_CSS_REPO}. ` +
      'Either the file path is wrong or the repo has no history yet.',
    );
  }
  return sha;
}

function diffLineCount(fromSha: string, toSha: string): number {
  if (fromSha === toSha) return 0;
  // `git diff --shortstat` gives "1 file changed, X insertions(+), Y deletions(-)".
  const out = git('diff', '--shortstat', `${fromSha}..${toSha}`, '--', CANONICAL_CSS_REPO);
  if (!out) return 0;
  const ins = /(\d+) insertion/.exec(out);
  const del = /(\d+) deletion/.exec(out);
  return (ins ? parseInt(ins[1], 10) : 0) + (del ? parseInt(del[1], 10) : 0);
}

function main(): number {
  if (!fs.existsSync(CANONICAL_CSS_FS)) {
    fail(`canonical CSS not found at ${CANONICAL_CSS_FS}`);
  }

  const lastSync = readLastSyncCommit();
  if (!commitExists(lastSync) && !tryFetchCommit(lastSync)) {
    fail(
      `LAST-SYNC commit ${lastSync} is not in the local git history and could ` +
      'not be fetched from origin. Run `git fetch --unshallow` locally, or — ' +
      'if the commit was rewritten/force-pushed away — update the LAST-SYNC ' +
      'marker to a reachable commit per ' +
      'docs/design/components-css-port-procedure.md.',
    );
  }

  const head = latestCanonicalCommit();
  const drift = diffLineCount(lastSync, head);

  console.log('────────────────────────────────────────────────────');
  console.log('  components.css canonical-port drift report');
  console.log('────────────────────────────────────────────────────');
  console.log(`  LAST-SYNC : ${lastSync}`);
  console.log(`  HEAD      : ${head}`);
  console.log(`  drift     : ${drift} lines (insertions + deletions)`);
  console.log(`  canonical : ${CANONICAL_CSS_REPO}`);
  console.log('────────────────────────────────────────────────────');

  if (drift === 0) {
    console.log('  status    : IN SYNC');
    return EXIT_OK;
  }
  if (drift < WARN_THRESHOLD) {
    console.log(`  status    : minor drift (<${WARN_THRESHOLD} lines)`);
    return EXIT_OK;
  }
  if (drift <= FAIL_THRESHOLD) {
    console.log(`  status    : WARN — ${drift} lines drift (>=${WARN_THRESHOLD})`);
    console.log('  action    : schedule a re-sync PR per');
    console.log('              docs/design/components-css-port-procedure.md');
    return EXIT_OK;
  }
  console.log(`  status    : FAIL — ${drift} lines drift (>${FAIL_THRESHOLD})`);
  console.log('  action    : re-sync REQUIRED before merge — see');
  console.log('              docs/design/components-css-port-procedure.md');
  return EXIT_FAIL;
}

process.exit(main());
