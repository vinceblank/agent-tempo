/**
 * `useMediaQuery` — subscribe to a CSS media query and re-render when
 * it flips. Used by `ResponsivePanel` to choose Sheet vs Dialog at
 * runtime, and reusable by future per-breakpoint UX.
 */
import { useEffect, useState } from 'react';

function readInitial(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => readInitial(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(query);
    const handler = (ev: MediaQueryListEvent) => setMatches(ev.matches);
    mq.addEventListener('change', handler);
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
