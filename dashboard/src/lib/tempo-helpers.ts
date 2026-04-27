/**
 * Shared visual helpers for the tempo motifs (PR-5 of #340).
 *
 * Ported verbatim from `docs/design/dashboard-handoff/project/shared.jsx`
 * so the rendered dashboard matches the canonical Claude Design bundle.
 * `PHASES` is the single source of truth for `AttachmentPhase` → icon /
 * color / pulse mapping; the TUI's `phaseToLabel` produces the same
 * bucketing on a different surface.
 */

/** Deterministic musical glyphs assigned to player names. */
const GLYPHS = ['♩', '♪', '♫', '♬', '♭', '♮', '♯', '𝅘𝅥'];

/**
 * Pick a stable musical glyph for a player name. Uses a simple
 * djb2-flavoured rolling hash so the same name always lands on the
 * same glyph across renders and reloads.
 */
export function glyphFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return GLYPHS[h % GLYPHS.length];
}

/** Deterministic hue assignment per player-type. */
export const TYPE_HUES: Record<string, number> = {
  'tempo-conductor': 32, // gold
  'tempo-composer': 210, // steel blue
  'tempo-soloist': 18, // terracotta-ish
  'tempo-tuner': 150, // mint
  'tempo-critic': 340, // rose
  'tempo-roadie': 260, // violet
  'tempo-improv': 48, // amber
  'tempo-liner': 190, // teal
};

/** Hue for a player type. Unknown types fall back to a neutral steel. */
export function hueForType(type: string | undefined): number {
  if (!type) return 200;
  return TYPE_HUES[type] ?? 200;
}

export interface PhaseSpec {
  icon: string;
  label: string;
  color: string;
  bucket: 'active' | 'idle' | 'disconnected' | 'pending' | 'gone';
  pulse?: boolean;
}

/**
 * `AttachmentPhase` → visual spec. Mirrors the TUI's phase-bucket map;
 * the `bucket` field aligns with `phaseToLabel` from the parent repo
 * so the dashboard's sidebar counts match the TUI's headline.
 */
export const PHASES: Record<string, PhaseSpec> = {
  attached: { icon: '●', label: 'active', color: 'var(--ok)', bucket: 'active' },
  processing: { icon: '●', label: 'processing', color: 'var(--ok)', bucket: 'active', pulse: true },
  awaiting: { icon: '○', label: 'idle', color: 'var(--text)', bucket: 'idle' },
  draining: { icon: '◐', label: 'draining', color: 'var(--warn)', bucket: 'disconnected' },
  detached: { icon: '◐', label: 'detached', color: 'var(--warn)', bucket: 'disconnected' },
  booting: { icon: '◔', label: 'booting', color: 'var(--dim)', bucket: 'pending' },
  gone: { icon: '✕', label: 'gone', color: 'var(--dim)', bucket: 'gone' },
};

/** Look up a phase spec, falling back to `booting` for unknown / undefined. */
export function specForPhase(phase: string | undefined): PhaseSpec {
  return PHASES[phase ?? 'booting'] ?? PHASES.booting;
}
