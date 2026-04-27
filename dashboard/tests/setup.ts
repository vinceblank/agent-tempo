import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { __resetPrefsForTests } from '../src/store/prefs';

// Vitest setup — runs before every test file.
// - `@testing-library/jest-dom` extends `expect` with DOM-specific matchers.
// - `cleanup()` unmounts components React Testing Library has rendered so
//   stale DOM doesn't leak across tests within the same file.
// - `__resetPrefsForTests()` wipes the Zustand prefs store + localStorage so
//   each test starts from defaults (`theme: 'dark'`, `density: 6`,
//   `accent: 'terracotta'`).
afterEach(() => {
  cleanup();
  __resetPrefsForTests();
});

/**
 * Silence the known-noisy `RequestInit: Expected signal ("AbortSignal {}")
 * to be an instance of AbortSignal` rejection that surfaces when
 * react-router-dom 7's `createClientSideRequest` constructs a Request
 * inside vitest's jsdom environment. It's a transport-level type-equality
 * check between undici's AbortSignal and jsdom's; neither side produces
 * a user-visible failure, but vitest counts it as an "unhandled error"
 * which clutters CI output. Filter only this specific message.
 */
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes('AbortSignal') && msg.includes('RequestInit')) {
    return;
  }
  // Re-emit unfiltered rejections so vitest still surfaces real bugs.
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});
