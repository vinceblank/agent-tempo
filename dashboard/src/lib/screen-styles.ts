/**
 * Shared screen-level style primitives — used by list/error/empty cards
 * across the read-only screens (Hosts, Schedules, etc.). Centralised so
 * a token tweak (border colour, radius, padding) ripples consistently.
 *
 * Per-screen overrides remain the norm for layout-specific bits
 * (gap, max-width); these constants cover the *card-shaped* surfaces
 * that all screens reuse.
 */

/** Card with the accent border + alert text — used for query-error states. */
export const errorCardStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--bg-1)',
  border: '1px solid var(--accent)',
  borderRadius: 6,
  color: 'var(--accent)',
  fontSize: 13,
};

/** Larger error card variant — used at screen-root level for empty/loading state errors. */
export const errorPanelStyle: React.CSSProperties = {
  padding: 'var(--density-pad)',
  background: 'var(--bg-1)',
  border: '1px solid var(--accent)',
  borderRadius: 8,
  color: 'var(--accent)',
};

/** Dashed-border empty state card. */
export const emptyCardStyle: React.CSSProperties = {
  padding: 'var(--density-pad)',
  background: 'var(--bg-1)',
  border: '1px dashed var(--rule)',
  borderRadius: 8,
};

/** Solid-border list-row card. */
export const rowCardStyle: React.CSSProperties = {
  background: 'var(--bg-1)',
  border: '1px solid var(--rule)',
  borderRadius: 8,
  padding: 'var(--density-pad)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

/** Compact version of `rowCardStyle` — for nested rows inside a group. */
export const compactRowStyle: React.CSSProperties = {
  background: 'var(--bg-1)',
  border: '1px solid var(--rule)',
  borderRadius: 6,
  padding: '8px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const monoStyle: React.CSSProperties = { fontFamily: 'var(--ff-mono)' };
