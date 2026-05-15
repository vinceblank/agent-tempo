/**
 * Zustand store for user-level dashboard preferences.
 *
 * Persistence is `localStorage`-backed (under key `agent-tempo:prefs`).
 * Theme / density / accent each map to a `dataset` attribute on
 * `documentElement` so the design tokens (CSS-first `@theme` blocks in
 * `src/styles/tokens.css`) can re-paint via attribute selectors without
 * triggering React re-renders for layout-irrelevant changes.
 *
 * **Why density isn't a number-typed Tailwind class**: the source design
 * uses a 6-step density slider (`4`–`9`) that mutates ~6 CSS variables
 * per step. Tailwind's arbitrary-class system would explode the bundle;
 * a single `dataset` flip is O(1) and the variables cascade.
 */
import { create } from 'zustand';
import { logEvent } from '../lib/log';

export type Theme = 'dark' | 'light';
export type Density = 4 | 5 | 6 | 7 | 8 | 9;
export type Accent = 'terracotta' | 'sage' | 'plum';

const STORAGE_KEY = 'agent-tempo:prefs';
/** Default values — exported so consumers (e.g. the Settings page's Reset button) reuse them. */
export const DEFAULT_THEME: Theme = 'dark';
export const DEFAULT_DENSITY: Density = 6;
export const DEFAULT_ACCENT: Accent = 'terracotta';

interface PrefsSnapshot {
  theme: Theme;
  density: Density;
  accent: Accent;
}

interface PrefsState extends PrefsSnapshot {
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setAccent: (accent: Accent) => void;
  toggleTheme: () => void;
}

function loadInitial(): PrefsSnapshot {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { theme: DEFAULT_THEME, density: DEFAULT_DENSITY, accent: DEFAULT_ACCENT };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PrefsSnapshot>;
      return {
        theme: parsed.theme === 'light' ? 'light' : 'dark',
        density: isValidDensity(parsed.density) ? parsed.density : DEFAULT_DENSITY,
        accent: isValidAccent(parsed.accent) ? parsed.accent : DEFAULT_ACCENT,
      };
    }
  } catch {
    /* localStorage may be disabled / quota-exceeded — fall through to defaults */
  }
  return { theme: DEFAULT_THEME, density: DEFAULT_DENSITY, accent: DEFAULT_ACCENT };
}

function isValidDensity(v: unknown): v is Density {
  return typeof v === 'number' && v >= 4 && v <= 9 && Number.isInteger(v);
}

function isValidAccent(v: unknown): v is Accent {
  return v === 'terracotta' || v === 'sage' || v === 'plum';
}

function persist(snapshot: PrefsSnapshot): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* localStorage may be disabled / quota-exceeded — silently drop */
  }
}

/**
 * Apply a prefs snapshot to `documentElement` so CSS attribute selectors
 * (in `src/styles/tokens.css`) repaint. Called on every mutation; cheap
 * because dataset writes are direct DOM property sets.
 */
function applyToDocument(snapshot: PrefsSnapshot): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = snapshot.theme;
  document.documentElement.dataset.density = String(snapshot.density);
  document.documentElement.dataset.accent = snapshot.accent;
}

export const usePrefs = create<PrefsState>()((set, get) => {
  const initial = loadInitial();

  // Apply once at store creation so the very first paint uses the persisted
  // values. (React would otherwise paint with HTML defaults for one frame.)
  applyToDocument(initial);

  const commit = (next: Partial<PrefsSnapshot>): void => {
    set(next);
    const snapshot: PrefsSnapshot = {
      theme: get().theme,
      density: get().density,
      accent: get().accent,
    };
    applyToDocument(snapshot);
    persist(snapshot);
  };

  return {
    ...initial,

    setTheme: (theme) => {
      commit({ theme });
      logEvent('prefs-theme-set', { theme });
    },

    setDensity: (density) => {
      commit({ density });
      logEvent('prefs-density-set', { density });
    },

    setAccent: (accent) => {
      commit({ accent });
      logEvent('prefs-accent-set', { accent });
    },

    toggleTheme: () => {
      const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
      commit({ theme: next });
      logEvent('prefs-theme-toggled', { theme: next });
    },
  };
});

/**
 * Test-only hook (#291 naming convention): wipe persistence + restore
 * the store + dataset to defaults so tests can start from a known
 * state without leaking into one another. Production code MUST NOT
 * call this.
 *
 * Re-applies (rather than just deletes) the dataset attrs because
 * `usePrefs` is a module-level singleton — the constructor's
 * `applyToDocument(initial)` runs only once, on first import.
 */
export function __resetPrefsForTests(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  const defaults: PrefsSnapshot = {
    theme: DEFAULT_THEME,
    density: DEFAULT_DENSITY,
    accent: DEFAULT_ACCENT,
  };
  usePrefs.setState(defaults);
  applyToDocument(defaults);
}
