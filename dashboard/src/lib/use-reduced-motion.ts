/**
 * `prefers-reduced-motion` hook — used by every animated tempo motif
 * to honour the OS-level accessibility setting. Returns `true` when
 * animations should be suppressed.
 *
 * Ported as a hook (not a constant) because the user can flip the
 * preference mid-session and we want the next render to pick it up.
 *
 * jsdom (vitest's default env) returns `matches: false` from
 * `matchMedia` and doesn't fire change events, so tests can stub
 * `window.matchMedia` directly to drive both branches.
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function readInitial(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(QUERY);
    const handler = (ev: MediaQueryListEvent) => setReduced(ev.matches);
    // Modern browsers ship `addEventListener('change', …)`; Safari < 14
    // (out of our support floor anyway) used `addListener`. Use the
    // modern API only.
    mq.addEventListener('change', handler);
    // Re-read on mount in case `matchMedia` returned a different value
    // than the SSR-time check.
    setReduced(mq.matches);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return reduced;
}
