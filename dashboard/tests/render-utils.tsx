/**
 * Shared rendering helpers for vitest component tests.
 *
 * Filed under #389 PR-A1m. Future tests with the same router-shape needs
 * should reach for these helpers rather than re-rolling MemoryRouter +
 * Routes scaffolding per file.
 */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Render `element` inside a `MemoryRouter` at `initialEntry`. The wildcard
 * route plus an explicit `/ensemble/:id` route mirror the production
 * router so `useParams<{ id }>()` resolves the ensemble param when tests
 * want to exercise ensemble-scoped behaviour.
 *
 * Pass `wrapper` to layer additional providers (e.g. QueryClientProvider)
 * outside the router — useful for components that depend on TanStack
 * Query data the way EnsembleSwitcher does.
 */
export function renderInRouter(
  initialEntry: string,
  element: ReactNode,
  opts: { wrapper?: (children: ReactNode) => ReactNode } = {},
) {
  const tree = (
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/ensemble/:id" element={element} />
        <Route path="*" element={element} />
      </Routes>
    </MemoryRouter>
  );
  return render(<>{opts.wrapper ? opts.wrapper(tree) : tree}</>);
}
