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

const log = (...args: unknown[]) => console.error('[agent-tempo:watchdog]', ...args);

export function installParentDeathWatchdog(): void {
  const exit = (reason: string) => {
    log('parent gone (', reason, ') — exiting');
    process.exit(0);
  };

  process.stdin.on('end', () => exit('stdin end'));
  process.stdin.on('close', () => exit('stdin close'));

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
