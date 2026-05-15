/**
 * Zustand prefs store — every mutation must:
 *   1. Update the in-memory store
 *   2. Mutate `documentElement.dataset.{theme,density,accent}` so CSS
 *      attribute selectors in `tokens.css` repaint without React
 *      re-renders
 *   3. Persist to `localStorage` under `agent-tempo:prefs`
 *
 * If any of those drifts apart from the others, the design-token
 * cascade silently breaks.
 */
import { describe, it, expect } from 'vitest';
import { usePrefs } from '../src/store/prefs';

describe('usePrefs store', () => {
  it('initial state — dark theme, density 6, terracotta accent', () => {
    const s = usePrefs.getState();
    expect(s.theme).toBe('dark');
    expect(s.density).toBe(6);
    expect(s.accent).toBe('terracotta');
  });

  it('initialises documentElement.dataset on store creation', () => {
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('6');
    expect(document.documentElement.dataset.accent).toBe('terracotta');
  });

  it('setTheme updates store + dataset + localStorage', () => {
    usePrefs.getState().setTheme('light');
    expect(usePrefs.getState().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    const persisted = JSON.parse(window.localStorage.getItem('agent-tempo:prefs') || '{}');
    expect(persisted.theme).toBe('light');
  });

  it('toggleTheme flips dark ↔ light', () => {
    expect(usePrefs.getState().theme).toBe('dark');
    usePrefs.getState().toggleTheme();
    expect(usePrefs.getState().theme).toBe('light');
    usePrefs.getState().toggleTheme();
    expect(usePrefs.getState().theme).toBe('dark');
  });

  it('setDensity updates dataset.density to the new value', () => {
    usePrefs.getState().setDensity(9);
    expect(document.documentElement.dataset.density).toBe('9');
    expect(usePrefs.getState().density).toBe(9);
  });

  it('setAccent updates store + dataset + localStorage', () => {
    usePrefs.getState().setAccent('sage');
    expect(usePrefs.getState().accent).toBe('sage');
    expect(document.documentElement.dataset.accent).toBe('sage');
    const persisted = JSON.parse(window.localStorage.getItem('agent-tempo:prefs') || '{}');
    expect(persisted.accent).toBe('sage');
  });

  it('persists every mutation as a single JSON snapshot', () => {
    usePrefs.getState().setTheme('light');
    usePrefs.getState().setDensity(8);
    usePrefs.getState().setAccent('plum');
    const persisted = JSON.parse(window.localStorage.getItem('agent-tempo:prefs') || '{}');
    expect(persisted).toEqual({ theme: 'light', density: 8, accent: 'plum' });
  });
});
