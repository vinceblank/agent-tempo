// Self-exit when the parent process goes away.
//
// Stdio-MCP children (and the Copilot bridge subprocess) are spawned by
// hosts that often die without sending SIGTERM — Claude Code on Windows
// just closes the pipe, and an abruptly-killed daemon leaves bridge
// subprocesses orphaned. Without this watchdog, those children stay
// alive forever holding the Temporal core-bridge `.node` open, which
// (a) leaks processes across host restarts and (b) blocks
// `npm install -g` upgrades with EBUSY on Windows.
//
// Two complementary signals:
//   1. stdin 'end'/'close' — fires the instant the parent closes the
//      stdio pipe. Primary signal; immediate.
//   2. Parent-PID poll — fallback for when the pipe handle is inherited
//      by another process (or stdio was 'ignore'). 30s cadence is a
//      belt-and-braces interval — orphan dies within half a minute,
//      no measurable syscall cost. `process.kill(pid, 0)` is a
//      permission check, not a signal.
//
// PID reuse caveat: Windows recycles PIDs quickly. If the parent dies
// and an unrelated process inherits the same PID before our next poll,
// we falsely conclude the parent is alive. The stdin EOF path catches
// that case immediately, so this is purely a fallback.

import { ENV } from '../config';

const log = (...args: unknown[]) => console.error('[agent-tempo:watchdog]', ...args);

/**
 * Should the ppid-poll signal be installed? FALSE only when a TRANSIENT-CLI
 * spawner set {@link ENV.NO_PPID_WATCHDOG} on a process it intentionally detached
 * to OUTLIVE it (#672 — e.g. the short-lived `up` conductor: polling its dead pid
 * would self-kill the conductor seconds after launch). Pure + injectable.
 *
 * Skipping ppid-poll is propagation-SAFE: the flag inherits down the spawn tree,
 * but stdin-EOF (always installed) protects any child — its stdin IS this
 * process's pipe, so it fires the instant THIS process dies. Only the ppid-poll
 * (which keys on the SPAWNER, not the immediate parent) is the harmful signal.
 */
export function shouldInstallPpidPoll(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV.NO_PPID_WATCHDOG] !== '1';
}

export function installParentDeathWatchdog(): void {
  const exit = (reason: string) => {
    log('parent gone (', reason, ') — exiting');
    process.exit(0);
  };

  // stdin-EOF — UNIVERSALLY correct + ALWAYS installed: a closed stdin pipe means
  // the IMMEDIATE parent is gone. This is what reaps a detached process's OWN
  // children even when ppid-poll is skipped (the child's stdin is our pipe).
  process.stdin.on('end', () => exit('stdin end'));
  process.stdin.on('close', () => exit('stdin close'));

  // ppid-poll — keys on the SPAWNER's death. Correct for a long-lived daemon
  // spawner (#604 anti-leak), HARMFUL for a transient CLI that detached us to
  // outlive it (#672). Skipped when the spawner marked itself transient; the
  // Temporal lease TTL reaps a genuinely-orphaned detached process instead.
  if (!shouldInstallPpidPoll()) return;
  const parentPid = process.ppid;
  if (parentPid && parentPid > 1) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        exit(`ppid ${parentPid} dead`);
      }
    }, 30_000);
    timer.unref();
  }
}
