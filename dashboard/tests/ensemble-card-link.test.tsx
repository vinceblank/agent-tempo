/**
 * Regression lock for #376 — `EnsembleCard` link href under the dashboard's
 * `/dashboard/` basename.
 *
 * The bug: an absolute `<Link to="/dashboard/ensemble/<id>">` combined with
 * the React Router `basename: '/dashboard'` produced a double-prefixed
 * `/dashboard/dashboard/ensemble/<id>` href, which 404'd the primary
 * Overview → Workspace navigation flow.
 *
 * The fix (already on main as of commit 389edbd28): the `to` prop uses the
 * basename-relative form `/ensemble/<id>` so React Router prepends `/dashboard`
 * exactly once.
 *
 * This test mirrors prod by mounting the component under
 * `<MemoryRouter basename="/dashboard">` and asserts the rendered `<a>`
 * carries the single-prefix href. It would fail if the `to` prop is
 * regressed to the absolute form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { EnsembleCard } from '../src/components/EnsembleCard';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('EnsembleCard — link href under /dashboard basename (#376)', () => {
  function renderUnderBasename(name: string) {
    const mock = new MockDashboardClient({
      ensembles: [{ name, playerCount: 0, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({ ensemble: name }),
    });
    __setDashboardClientForTests(mock);
    return render(
      <QueryClientProvider client={newQc()}>
        {/*
          Mirror the production router shape: prod calls
          `createBrowserRouter(..., { basename: '/dashboard' })` (see
          src/router.tsx:97). The bug only manifests when the basename is
          present; without it, an absolute `to="/dashboard/..."` happens to
          match the bare browser URL and the regression slips through.
        */}
        <MemoryRouter basename="/dashboard" initialEntries={['/dashboard']}>
          <EnsembleCard
            ensemble={{ name, playerCount: 0, hasConductor: true, state: 'online' }}
          />
        </MemoryRouter>
      </QueryClientProvider> as ReactNode,
    );
  }

  it('href is /dashboard/ensemble/<name> — exactly one /dashboard prefix', async () => {
    renderUnderBasename('demo');
    const link = await waitFor(() => screen.getByTestId('ensemble-card-demo-link'));
    expect(link.getAttribute('href')).toBe('/dashboard/ensemble/demo');
    // Defensive — the bug was a literal duplicate; pin the negative case.
    expect(link.getAttribute('href')).not.toMatch(/\/dashboard\/dashboard\//);
  });

  it('encodes ensemble names that contain URI-reserved characters', async () => {
    renderUnderBasename('tempo-impl');
    const link = await waitFor(() => screen.getByTestId('ensemble-card-tempo-impl-link'));
    expect(link.getAttribute('href')).toBe('/dashboard/ensemble/tempo-impl');
  });
});
