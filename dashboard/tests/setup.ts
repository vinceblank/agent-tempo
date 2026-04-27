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
