/**
 * Formatting utilities for the TUI.
 * Timestamp formatting, text truncation, duration display,
 * attachment-phase → label/color/icon mapping (post-#177).
 */

import type { AttachmentPhase } from '../../types';
import { THEME } from './theme';

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

// ── Attachment-phase presentation mapping (post-#177) ──
//
// TUI consumers receive attachment-phase strings via `MaestroPlayerInfo.phase`
// (renamed from `.status` in #177 after the shim-removal epic). The helpers
// below collapse the seven attachment phases into five user-facing buckets:
// active / idle / disconnected / pending / gone.
//
// Performance: the per-phase maps are frozen at module scope (per
// docs/tui-performance.md — no per-frame object allocation). Callers just
// do a dictionary lookup.

/** User-facing phase labels shown in the TUI. */
export type PhaseLabel = 'active' | 'idle' | 'disconnected' | 'pending' | 'gone' | 'unknown';

/** Icon-bucket name used to key into `statusIcons()` (src/tui/utils/platform.ts). */
export type PhaseIconName = 'active' | 'stale' | 'pending' | 'blocked' | 'terminated';

const PHASE_TO_LABEL: Readonly<Record<AttachmentPhase, PhaseLabel>> = Object.freeze({
  attached:   'active',
  processing: 'active',
  awaiting:   'idle',
  draining:   'disconnected',
  detached:   'disconnected',
  booting:    'pending',
  gone:       'gone',
});

const LABEL_TO_COLOR: Readonly<Record<PhaseLabel, string>> = Object.freeze({
  active:       THEME.success,
  idle:         THEME.text,
  disconnected: THEME.warning,
  pending:      THEME.dim,
  gone:         THEME.dim,
  unknown:      THEME.text,
});

const LABEL_TO_ICON_NAME: Readonly<Record<PhaseLabel, PhaseIconName>> = Object.freeze({
  active:       'active',      // ● (filled)
  idle:         'stale',       // ○ (hollow, neutral)
  disconnected: 'blocked',     // ◐ (half, yellow)
  pending:      'pending',     // ◔ (quarter, dim)
  gone:         'terminated',  // ✕
  unknown:      'blocked',     // ? → cautionary
});

/** Collapse an attachment phase into its user-facing label. */
export function phaseToLabel(phase?: string): PhaseLabel {
  if (!phase) return 'unknown';
  return PHASE_TO_LABEL[phase as AttachmentPhase] ?? 'unknown';
}

/** Theme color (hex string or undefined under NO_COLOR) for a phase. */
export function phaseToColor(phase?: string): string {
  return LABEL_TO_COLOR[phaseToLabel(phase)];
}

/** Icon-bucket key for `statusIcons()` for a phase. */
export function phaseToIconName(phase?: string): PhaseIconName {
  return LABEL_TO_ICON_NAME[phaseToLabel(phase)];
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

/**
 * Format the "↑ N earlier message(s)" indicator shown above a truncated
 * message list. Returns null when no indicator should render.
 *
 * - count <= 0          → null (no indicator)
 * - count === 1         → "↑ 1 earlier message" (singular)
 * - count >= 2          → "↑ N earlier messages" (plural)
 */
export function formatEarlierIndicator(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const label = count === 1 ? 'earlier message' : 'earlier messages';
  return `\u2191 ${count} ${label}`;
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
