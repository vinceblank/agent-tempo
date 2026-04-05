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

export interface CreateWorktreeResult {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name used for the worktree. */
  branch: string;
  /** Whether the worktree was newly created (false if it already existed). */
  created: boolean;
}

/**
 * Create a git worktree for a player. If the worktree already exists
 * at the expected path, returns it without re-creating.
 *
 * Branch defaults to `{ensemble}/{playerName}` if not specified.
 */
export function createWorktree(opts: CreateWorktreeOpts): CreateWorktreeResult {
  const { gitRoot, ensemble, playerName } = opts;
  const branch = opts.branch || `${ensemble}/${playerName}`;
  const basePath = worktreeBasePath(gitRoot, ensemble);
  const wtPath = path.join(basePath, playerName);

  // If worktree already exists, reuse it
  if (existsSync(path.join(wtPath, '.git'))) {
    log(`Worktree already exists at "${wtPath}" — reusing`);
    return { path: wtPath, branch, created: false };
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
