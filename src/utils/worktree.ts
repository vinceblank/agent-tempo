/**
 * Git worktree helpers for player isolation.
 *
 * Creates and manages git worktrees so each player can work on an
 * isolated copy of the repository without conflicting with others.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { WORKTREE_INSTALL_TIMEOUT } from './validation';

const log = (...args: unknown[]) => console.error('[claude-tempo:worktree]', ...args);

/**
 * Compute the base directory for all worktrees in an ensemble.
 * Convention: `{gitRoot}/../.ct-worktrees/{ensemble}/`
 */
export function worktreeBasePath(gitRoot: string, ensemble: string): string {
  return path.join(path.dirname(gitRoot), '.ct-worktrees', ensemble);
}

export interface CreateWorktreeOpts {
  gitRoot: string;
  ensemble: string;
  playerName: string;
  branch?: string;
}

/**
 * Tag returned by {@link switchWorktreeToBranch} and surfaced on
 * {@link CreateWorktreeResult.switched} so the MCP tool's response text can
 * report the actual state transition instead of silently reusing the request
 * as ground truth (#261). Values:
 *
 * - `same` — the worktree was already on the requested branch. No-op.
 * - `switched` — the requested branch existed locally; plain `git checkout`.
 * - `created-from-main` — the requested branch did not exist locally;
 *   created it off `origin/main` via `git checkout -b`.
 */
export type WorktreeSwitchResult = 'same' | 'switched' | 'created-from-main';

export interface CreateWorktreeResult {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name used for the worktree. */
  branch: string;
  /** Whether the worktree was newly created (false if it already existed). */
  created: boolean;
  /**
   * When `created === false` (reuse path), which git operation the helper ran
   * to bring the worktree onto the requested branch. `undefined` on fresh
   * creation — the #261 information is only meaningful for reuse.
   */
  switched?: WorktreeSwitchResult;
}

/**
 * Ensure the worktree at `wtPath` is checked out on `targetBranch`.
 *
 * Fix for #261: the prior reuse path returned the *requested* branch name in
 * its result without ever consulting the worktree's actual HEAD, silently
 * papering over mismatches when a worktree from a prior task was recycled for
 * a new branch. This helper does the repointing that was missing — and
 * refuses (rather than silently discarding) if the target worktree has
 * uncommitted work on a different branch.
 *
 * Decision tree (mirrors the conductor's guidance on #261):
 *   1. current branch === targetBranch        → no-op, return `'same'`. The
 *      hot path. Deliberately does NOT run `status --porcelain`: if we're
 *      not flipping the branch, dirty work is fine.
 *   2. `git status --porcelain` non-empty     → throw `"uncommitted changes"`
 *      with path + current branch. Must precede any checkout so we never
 *      silently discard work on a branch flip.
 *   3. target branch exists locally           → `git checkout <target>`.
 *      Preserves the branch's recorded state; no `-B`, no force-reset.
 *   4. target branch does not exist locally   → `git checkout -b <target> origin/main`.
 *      Matches the semantics of the fresh-worktree `git worktree add -B`
 *      path — new branch rooted at the current main tip.
 *
 * Caller is expected to have already verified `wtPath` is an existing git
 * worktree (this helper runs the git commands with `-C <wtPath>` and does no
 * path-existence checks of its own).
 */
export function switchWorktreeToBranch(
  wtPath: string,
  targetBranch: string,
): WorktreeSwitchResult {
  const current = execFileSync('git', ['-C', wtPath, 'branch', '--show-current'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (current === targetBranch) {
    log(`Worktree at "${wtPath}" already on "${targetBranch}" — no-op`);
    return 'same';
  }

  // Branch mismatch → dirty-tree guard before any checkout. `--porcelain`
  // emits one line per change with no color/decoration; empty output means
  // the working tree + index are clean (ignored files don't count).
  const dirty = execFileSync('git', ['-C', wtPath, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (dirty.trim().length > 0) {
    throw new Error(
      `Worktree at "${wtPath}" has uncommitted changes on branch "${current}"; ` +
      `cannot repoint to "${targetBranch}". Commit or discard changes first.`,
    );
  }

  // Does the target branch already exist locally? `rev-parse --verify` exits
  // 0 on hit, non-zero on miss.
  let branchExistsLocally = false;
  try {
    execFileSync('git', ['-C', wtPath, 'rev-parse', '--verify', `refs/heads/${targetBranch}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    branchExistsLocally = true;
  } catch {
    // refs/heads/<target> doesn't exist — fall through to create-from-main.
  }

  if (branchExistsLocally) {
    log(`Worktree at "${wtPath}" switching "${current}" → "${targetBranch}" (existing local branch)`);
    try {
      execFileSync('git', ['-C', wtPath, 'checkout', targetBranch], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      const msg = err.stderr || err.stdout || err.message || String(err);
      throw new Error(`Failed to switch "${wtPath}" to "${targetBranch}": ${msg.trim()}`);
    }
    return 'switched';
  }

  log(`Worktree at "${wtPath}" switching "${current}" → "${targetBranch}" (new local branch from origin/main)`);
  try {
    execFileSync('git', ['-C', wtPath, 'checkout', '-b', targetBranch, 'origin/main'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    const msg = err.stderr || err.stdout || err.message || String(err);
    throw new Error(`Failed to create "${targetBranch}" from origin/main in "${wtPath}": ${msg.trim()}`);
  }
  return 'created-from-main';
}

/**
 * Create a git worktree for a player. If the worktree already exists
 * at the expected path, returns it after repointing to the requested branch
 * via {@link switchWorktreeToBranch} — the fix for #261, which previously
 * reused the directory without ever consulting its actual HEAD.
 *
 * Branch defaults to `{ensemble}/{playerName}` if not specified.
 */
export function createWorktree(opts: CreateWorktreeOpts): CreateWorktreeResult {
  const { gitRoot, ensemble, playerName } = opts;
  const branch = opts.branch || `${ensemble}/${playerName}`;
  const basePath = worktreeBasePath(gitRoot, ensemble);
  const wtPath = path.join(basePath, playerName);

  // If worktree already exists, reuse it — but verify its HEAD matches the
  // requested branch (repoint if not). This is the #261 fix: the previous
  // early-return trusted `branch` from the request as ground truth, so a
  // worktree left on a prior task's branch would be silently misreported.
  if (existsSync(path.join(wtPath, '.git'))) {
    log(`Worktree already exists at "${wtPath}" — reusing, verifying branch`);
    const switched = switchWorktreeToBranch(wtPath, branch);
    return { path: wtPath, branch, created: false, switched };
  }

  // Ensure base directory exists
  mkdirSync(basePath, { recursive: true });

  // Check if the branch already has a worktree (would cause git error)
  try {
    const existing = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Parse porcelain output: "branch refs/heads/{branch}" lines
    const branchRef = `refs/heads/${branch}`;
    if (existing.includes(`branch ${branchRef}`)) {
      throw new Error(
        `Branch "${branch}" already has an active worktree. ` +
        `Remove it first with \`git worktree remove\` or choose a different branch.`,
      );
    }
  } catch (err: any) {
    // Re-throw our own error, swallow git failures (e.g., no worktrees yet)
    if (err.message?.includes('already has an active worktree')) throw err;
  }

  // Create the worktree. Use -B to create/reset the branch.
  try {
    log(`Creating worktree: git worktree add -B ${branch} ${wtPath}`);
    execFileSync('git', ['worktree', 'add', '-B', branch, wtPath], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    const msg = err.stderr || err.stdout || err.message || String(err);
    throw new Error(`Failed to create worktree at "${wtPath}": ${msg.trim()}`);
  }

  return { path: wtPath, branch, created: true };
}

/**
 * Install dependencies in a worktree directory.
 *
 * Detects the package manager (npm, yarn, pnpm) by lockfile presence.
 * Failure or timeout is logged but does not throw — the recruit proceeds
 * with whatever state the worktree is in.
 */
export function installDependencies(
  worktreePath: string,
  timeoutMs: number = WORKTREE_INSTALL_TIMEOUT,
): void {
  // Detect package manager by lockfile
  let cmd: string;
  let args: string[];
  if (existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) {
    cmd = 'pnpm';
    args = ['install', '--frozen-lockfile'];
  } else if (existsSync(path.join(worktreePath, 'yarn.lock'))) {
    cmd = 'yarn';
    args = ['install', '--frozen-lockfile'];
  } else if (existsSync(path.join(worktreePath, 'package-lock.json')) || existsSync(path.join(worktreePath, 'package.json'))) {
    cmd = 'npm';
    args = ['install'];
  } else {
    log(`No package.json found in "${worktreePath}" — skipping install`);
    return;
  }

  try {
    log(`Installing dependencies in "${worktreePath}": ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`Dependencies installed successfully in "${worktreePath}"`);
  } catch (err: any) {
    // Log warning but don't throw — recruit should still proceed
    const msg = err.killed ? `Timed out after ${timeoutMs}ms` : (err.stderr || err.message || String(err));
    log(`Warning: dependency install failed in "${worktreePath}": ${msg}`);
  }
}

/**
 * Remove a git worktree.
 */
export function removeWorktree(worktreePath: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`Removed worktree at "${worktreePath}"`);
  } catch (err: any) {
    const msg = err.stderr || err.message || String(err);
    log(`Warning: failed to remove worktree at "${worktreePath}": ${msg.trim()}`);
  }
}
