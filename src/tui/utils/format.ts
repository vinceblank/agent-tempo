/**
 * Formatting utilities for the TUI.
 * Timestamp formatting, text truncation, duration display.
 */

/** Format an ISO timestamp as a short time string (HH:MM:SS). */
export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return iso;
  }
}

/** Format an ISO timestamp as relative time (e.g., "2m ago"). */
export function formatRelativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'just now';
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  } catch {
    return iso;
  }
}

/** Truncate text to maxLen, appending ellipsis if truncated. */
export function truncate(text: string, maxLen: number, ellipsis = '...'): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - ellipsis.length) + ellipsis;
}

/** Format a player status for display. */
export function formatStatus(status?: string): string {
  switch (status) {
    case 'active': return 'active';
    case 'stale': return 'stale';
    case 'pending': return 'pending';
    case 'blocked': return 'blocked';
    case 'terminated': return 'terminated';
    default: return status || 'unknown';
  }
}

/**
 * Word-wrap text to fit within maxWidth, breaking at word boundaries.
 * Each original newline starts a new line. Returns at least one line.
 */
export function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth < 1) return [text];
  const result: string[] = [];
  for (const raw of text.split('\n')) {
    const words = raw.split(' ');
    let current = '';
    for (const word of words) {
      if (current && current.length + 1 + word.length > maxWidth) {
        result.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    result.push(current);
  }
  return result.length > 0 ? result : [''];
}

/** Format an event type for display. */
export function formatEventType(type: string): string {
  switch (type) {
    case 'player_joined': return 'joined';
    case 'player_left': return 'left';
    case 'status_changed': return 'status';
    case 'part_changed': return 'part';
    default: return type;
  }
}
