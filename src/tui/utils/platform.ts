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

// ── Pixel Art Metronome ──

// ── Braille Rendering ──

/**
 * Braille dot matrix bit positions.
 * Each character = 2 cols × 4 rows of dots.
 * Bit layout: col0=[0,1,2,6], col1=[3,4,5,7]
 */
const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS: [number, number][] = [
  [0, 0], // bit 0: row 0, col 0
  [1, 0], // bit 1: row 1, col 0
  [2, 0], // bit 2: row 2, col 0
  [0, 1], // bit 3: row 0, col 1
  [1, 1], // bit 4: row 1, col 1
  [2, 1], // bit 5: row 2, col 1
  [3, 0], // bit 6: row 3, col 0
  [3, 1], // bit 7: row 3, col 1
];

/** A colored text segment for braille rendering. */
export interface BrailleSegment {
  char: string;
  color: string;
}

/** A row of braille segments (may have mixed colors). */
export type BrailleLine = BrailleSegment[];

/**
 * Braille dot canvas — plot dots at high resolution, encode to braille characters.
 * Each character cell = 2 dots wide × 4 dots tall.
 */
class BrailleCanvas {
  /** Dot grid: dotRows × dotCols, each cell stores a color tag or 0 (empty). */
  private dots: number[][];
  /** Character grid dimensions. */
  readonly charCols: number;
  readonly charRows: number;
  /** Dot grid dimensions. */
  readonly dotCols: number;
  readonly dotRows: number;

  /** Color tags: 1 = triangle (cream), 2 = arm/pivot (terracotta). */
  static TRIANGLE = 1;
  static ARM = 2;

  constructor(charCols: number, charRows: number) {
    this.charCols = charCols;
    this.charRows = charRows;
    this.dotCols = charCols * 2;
    this.dotRows = charRows * 4;
    this.dots = Array.from({ length: this.dotRows }, () => Array(this.dotCols).fill(0));
  }

  /** Set a dot at (x, y) in dot coordinates. */
  set(x: number, y: number, color: number): void {
    if (x >= 0 && x < this.dotCols && y >= 0 && y < this.dotRows) {
      this.dots[y][x] = color;
    }
  }

  /** Draw a line using Bresenham's algorithm. */
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;

    while (true) {
      this.set(cx, cy, color);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
  }

  /** Draw a filled circle. */
  circle(cx: number, cy: number, r: number, color: number): void {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) {
          this.set(x, y, color);
        }
      }
    }
  }

  /**
   * Encode the canvas to braille character lines with color segments.
   * For cells with mixed colors (triangle + arm overlap), arm wins (accent).
   */
  render(): BrailleLine[] {
    const COLORS: Record<number, string> = {
      [BrailleCanvas.TRIANGLE]: '#FAF3EE',
      [BrailleCanvas.ARM]: '#E07A5F',
    };

    const lines: BrailleLine[] = [];

    for (let cr = 0; cr < this.charRows; cr++) {
      const segments: BrailleSegment[] = [];
      let buf = '';
      let bufColor = '';

      for (let cc = 0; cc < this.charCols; cc++) {
        let code = BRAILLE_BASE;
        let cellColor = 0; // dominant color in this cell

        for (let bit = 0; bit < 8; bit++) {
          const [dr, dc] = BRAILLE_DOTS[bit];
          const dotY = cr * 4 + dr;
          const dotX = cc * 2 + dc;
          const val = this.dots[dotY]?.[dotX] || 0;
          if (val) {
            code |= (1 << bit);
            // Arm/pivot wins over triangle for color priority
            if (val === BrailleCanvas.ARM || cellColor === 0) {
              cellColor = val;
            }
          }
        }

        const char = code === BRAILLE_BASE ? ' ' : String.fromCharCode(code);
        const color = cellColor ? (COLORS[cellColor] || '') : '';

        if (color === bufColor) {
          buf += char;
        } else {
          if (buf) segments.push({ char: buf, color: bufColor });
          buf = char;
          bufColor = color;
        }
      }
      if (buf) segments.push({ char: buf, color: bufColor });

      lines.push(segments);
    }

    return lines;
  }
}

/**
 * Braille metronome — 3 frames (left, center, right).
 * Renders at 60×48 dot resolution (30 cols × 12 rows of braille characters).
 * Thin hairline triangle outline with thin pendulum arm and small pivot dot.
 */
export function metronomeBrailleFrames(): BrailleLine[][] {
  const COLS = 30;
  const ROWS = 12;

  // SVG: viewport 64×64, triangle apex(32,8)→bl(14,54)→br(50,54), pivot(32,46)
  // Dot resolution: 60×48
  // Scale: x * 60/64 ≈ x * 0.9375, y * 48/64 = y * 0.75
  const apex = { x: 30, y: 6 };
  const bl = { x: 13, y: 40 };
  const br = { x: 47, y: 40 };
  const pivot = { x: 30, y: 34 };

  // Pendulum tips — extend above apex
  const tips = [
    { x: 18, y: 1 },  // left
    { x: 30, y: 1 },  // center
    { x: 42, y: 1 },  // right
  ];

  function buildFrame(tipIdx: number): BrailleLine[] {
    const canvas = new BrailleCanvas(COLS, ROWS);
    const T = BrailleCanvas.TRIANGLE;
    const A = BrailleCanvas.ARM;

    // Draw triangle outline (thin hairlines)
    canvas.line(apex.x, apex.y, bl.x, bl.y, T);
    canvas.line(apex.x, apex.y, br.x, br.y, T);
    canvas.line(bl.x, bl.y, br.x, br.y, T);

    // Draw pendulum arm (thin line, draws over triangle where they cross)
    const tip = tips[tipIdx];
    canvas.line(pivot.x, pivot.y, tip.x, tip.y, A);

    // Draw pivot dot
    canvas.circle(pivot.x, pivot.y, 2, A);

    return canvas.render();
  }

  return [
    buildFrame(0), // left
    buildFrame(1), // center
    buildFrame(2), // right
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
