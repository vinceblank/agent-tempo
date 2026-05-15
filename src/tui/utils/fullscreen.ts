/**
 * Fullscreen utilities for the TUI.
 *
 * Clears the screen and hides the cursor on entry, shows cursor on exit.
 * Stays on the primary screen buffer so <Static> items become native
 * terminal scrollback that persists after exit.
 */

/** Whether fullscreen mode is supported and enabled. */
export function fullscreenSupported(): boolean {
  // User opt-out
  if (process.env.AGENT_TEMPO_NO_FULLSCREEN === '1') return false;

  // Legacy cmd.exe on Windows doesn't support alternate buffer.
  // Windows Terminal sets WT_SESSION; if absent on win32, skip.
  if (process.platform === 'win32' && !process.env.WT_SESSION) return false;

  // Need a writable stdout
  if (!process.stdout.isTTY) return false;

  return true;
}

/**
 * Enter fullscreen mode — clears the screen and hides the cursor.
 * Stays on the primary buffer so Static items persist as scrollback.
 * No-op if fullscreen is not supported.
 * @returns true if fullscreen was entered, false if skipped.
 */
export function enterFullscreen(): boolean {
  if (!fullscreenSupported()) return false;

  // Clear screen + cursor home + hide cursor (no alternate buffer)
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
  return true;
}

/**
 * Exit fullscreen mode — shows the cursor.
 * No buffer restore needed since we stay on the primary buffer.
 * Safe to call even if fullscreen was never entered.
 */
export function exitFullscreen(): void {
  // Show cursor (no buffer restore — primary buffer preserved)
  process.stdout.write('\x1b[?25h');
}

/**
 * Register cleanup handlers to exit fullscreen on process termination.
 * Call once after enterFullscreen(). Idempotent — guards against double-registration.
 */
let cleanupRegistered = false;

export function registerFullscreenCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    exitFullscreen();
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
}
