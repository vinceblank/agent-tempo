/**
 * Platform detection utilities for the TUI.
 * Determines Unicode support, SSH sessions, and terminal capabilities.
 */

/** Whether the terminal supports Unicode box-drawing and status icons. */
export function supportsUnicode(): boolean {
  // Windows Terminal and modern terminals support Unicode
  if (process.env.WT_SESSION) return true;
  // SSH sessions may have limited support
  if (isSSH()) return false;
  // Check LANG/LC_ALL for UTF-8
  const lang = process.env.LANG || process.env.LC_ALL || '';
  if (/utf-?8/i.test(lang)) return true;
  // macOS default terminal supports Unicode
  if (process.platform === 'darwin') return true;
  // Default: assume Unicode on modern systems
  return process.platform !== 'win32' || !!process.env.WT_SESSION;
}

/** Whether we're running inside an SSH session. */
export function isSSH(): boolean {
  return !!(process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

/** Get terminal dimensions, with minimum fallback. */
export function getTerminalSize(): { columns: number; rows: number } {
  const columns = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return { columns, rows };
}

/** Minimum terminal size for the TUI. */
export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;

/** Check if terminal meets minimum size requirements. */
export function isTerminalLargeEnough(): boolean {
  const { columns, rows } = getTerminalSize();
  return columns >= MIN_COLUMNS && rows >= MIN_ROWS;
}

/** Status icons — Unicode by default, ASCII fallback. */
export function statusIcons(unicode = supportsUnicode()) {
  if (unicode) {
    return {
      active: '\u25CF',     // ●
      stale: '\u25CB',      // ○
      pending: '\u25D4',    // ◔
      blocked: '\u25D0',    // ◐
      terminated: '\u2715', // ✕
      conductor: '\u2605',  // ★
      player: '\u2022',     // •
      arrow: '\u2192',      // →
      check: '\u2714',      // ✔
      cross: '\u2718',      // ✘
      ellipsis: '\u2026',   // …
    };
  }
  return {
    active: '*',
    stale: 'o',
    pending: '~',
    blocked: '!',
    terminated: 'x',
    conductor: '#',
    player: '-',
    arrow: '->',
    check: '+',
    cross: 'x',
    ellipsis: '...',
  };
}

/** Metronome animation frames (single-character). */
export function metronomeFrames(unicode = supportsUnicode()): string[] {
  if (unicode) {
    return ['\u2572', '|', '\u2571', '|']; // ╲ | ╱ |
  }
  return ['\\', '|', '/', '|'];
}

/**
 * Multi-line metronome ASCII art — 3 frames (left, center, right).
 * Each frame is an array of lines, ~11 lines tall.
 *
 * Color guide for consumers:
 * - Body lines (base, sides): cyan
 * - Pendulum arm + pivot (o): #E07A5F (terracotta)
 */
export function metronomeArt(unicode = supportsUnicode()): string[][] {
  if (unicode) {
    return [
      // Frame 0: pendulum left
      [
        '       o       ',
        '      ╱        ',
        '     ╱         ',
        '    ╱          ',
        '   ╱           ',
        '  ╱            ',
        '  ┌───────────┐',
        '  │           │',
        '  │           │',
        '  │           │',
        '  └───────────┘',
      ],
      // Frame 1: pendulum center
      [
        '       o       ',
        '       │       ',
        '       │       ',
        '       │       ',
        '       │       ',
        '       │       ',
        '  ┌───────────┐',
        '  │           │',
        '  │           │',
        '  │           │',
        '  └───────────┘',
      ],
      // Frame 2: pendulum right
      [
        '       o       ',
        '        ╲      ',
        '         ╲     ',
        '          ╲    ',
        '           ╲   ',
        '            ╲  ',
        '  ┌───────────┐',
        '  │           │',
        '  │           │',
        '  │           │',
        '  └───────────┘',
      ],
    ];
  }

  // ASCII fallback
  return [
    // Frame 0: pendulum left
    [
      '       o       ',
      '      /        ',
      '     /         ',
      '    /          ',
      '   /           ',
      '  /            ',
      '  +-----------+',
      '  |           |',
      '  |           |',
      '  |           |',
      '  +-----------+',
    ],
    // Frame 1: pendulum center
    [
      '       o       ',
      '       |       ',
      '       |       ',
      '       |       ',
      '       |       ',
      '       |       ',
      '  +-----------+',
      '  |           |',
      '  |           |',
      '  |           |',
      '  +-----------+',
    ],
    // Frame 2: pendulum right
    [
      '       o       ',
      '        \\      ',
      '         \\     ',
      '          \\    ',
      '           \\   ',
      '            \\  ',
      '  +-----------+',
      '  |           |',
      '  |           |',
      '  |           |',
      '  +-----------+',
    ],
  ];
}

/**
 * Block-letter "claude-tempo" title art (figlet "small" style).
 * 5 lines tall, ~62 characters wide.
 *
 * Color guide for consumers: cyan bold
 */
export function titleArt(unicode = supportsUnicode()): string[] {
  if (unicode) {
    return [
      ' ┌─┐┬  ┌─┐┬ ┬┌┬┐┌─┐  ─┬─┌─┐┌┬┐┌─┐┌─┐',
      ' │  │  ├─┤│ │ ││├┤    │ ├┤ │││├─┘│ │',
      ' └─┘┴─┘┴ ┴└─┘─┴┘└─┘   ┴ └─┘┴ ┴┴  └─┘',
    ];
  }

  return [
    ' __  _    __   _  _  ___  ___    ___ ___  __  __ ___  ___',
    '/ _|| |  / _| | || ||   \\| __|  |_ _| __|/  \\/  | _ \\/ _ \\',
    '| (_|| |_| (_| | || || |) | _|    | || _|| |\\/| |  _/ (_) |',
    ' \\__||___|\\__| \\_,_||___/|___|   |_||___|_|  |_|_|  \\___/',
  ];
}

/** Minimum terminal width for the title art to display without wrapping. */
const TITLE_ART_MIN_WIDTH = 70;

/** Whether the title art fits in the given terminal width. */
export function titleArtFits(columns: number): boolean {
  return columns >= TITLE_ART_MIN_WIDTH;
}
