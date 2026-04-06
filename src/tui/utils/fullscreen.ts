/**
 * Fullscreen (alternate screen buffer) utilities for the TUI.
 *
 * Uses ANSI escape sequences to switch to the alternate buffer and hide the cursor,
 * restoring the original buffer on exit.
 */

/** Whether fullscreen mode is supported and enabled. */
export function fullscreenSupported(): boolean {
  // User opt-out
  if (process.env.CLAUDE_TEMPO_NO_FULLSCREEN === '1') return false;

  // Legacy cmd.exe on Windows doesn't support alternate buffer.
  // Windows Terminal sets WT_SESSION; if absent on win32, skip.
  if (process.platform === 'win32' && !process.env.WT_SESSION) return false;

  // Need a writable stdout
  if (!process.stdout.isTTY) return false;

  return true;
}

/**
 * Enter fullscreen mode — switches to the alternate screen buffer and hides the cursor.
 * No-op if fullscreen is not supported.
 * @returns true if fullscreen was entered, false if skipped.
 */
export function enterFullscreen(): boolean {
  if (!fullscreenSupported()) return false;

  // Switch to alternate screen buffer + hide cursor
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  return true;
}

/**
 * Exit fullscreen mode — shows the cursor and restores the original screen buffer.
 * Safe to call even if fullscreen was never entered.
 */
export function exitFullscreen(): void {
  // Show cursor + restore main screen buffer
  process.stdout.write('\x1b[?25h\x1b[?1049l');
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
