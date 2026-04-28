/**
 * Loadouts screen — verifies the rebuilt table layout (PR-F1 of #389).
 *
 * Post-rev2 fidelity polish (#400 followup): the screen reads from
 * `useLineups()` (live wire) with eager fallback to `SHIPPED_LINEUPS`.
 * Tests render with a QueryClientProvider + MockDashboardClient so the
 * fallback path resolves cleanly without a daemon.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Loadouts } from '../src/screens/Loadouts';
import { SHIPPED_LINEUPS } from '../src/lib/lineups-catalog';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderLoadouts(client: MockDashboardClient = new MockDashboardClient()) {
  __setDashboardClientForTests(client);
  return render(
    <QueryClientProvider client={newQc()}>
      <Loadouts />
    </QueryClientProvider> as ReactNode,
  );
}

afterEach(() => __setDashboardClientForTests(null));

describe('Loadouts screen — header', () => {
  it('renders the PageHeader title + subtitle + two action CTAs', () => {
    renderLoadouts();
    expect(screen.getByTestId('screen-loadouts')).toBeInTheDocument();
    expect(screen.getByTestId('page-header').textContent).toContain('Loadouts');
    expect(screen.getByText(/Reusable ensemble lineups/)).toBeInTheDocument();
    expect(screen.getByTestId('loadouts-action-import')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('loadouts-action-new')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Loadouts screen — table', () => {
  it('renders one row per shipped lineup with stable testids', () => {
    renderLoadouts();
    expect(screen.getByTestId('loadouts-table')).toBeInTheDocument();
    for (const l of SHIPPED_LINEUPS) {
      expect(screen.getByTestId(`loadouts-row-${l.name}`)).toBeInTheDocument();
    }
  });

  it('every middle <td> carries data-label for the mobile-card collapse', () => {
    const { container } = renderLoadouts();
    const row = container.querySelector('[data-testid="loadouts-row-tempo-big-band"]') as HTMLTableRowElement;
    expect(row).toBeTruthy();
    const cells = row.querySelectorAll('td');
    // First cell (name) and last cell (actions) intentionally have no
    // data-label; every middle cell must, so the mobile collapse
    // renders correct labels.
    const labels = Array.from(cells)
      .slice(1, cells.length - 1)
      .map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['Summary', 'Players', 'Source', 'Last used']);
  });

  it('row populates Summary / Players / Source from the catalog entry', () => {
    renderLoadouts();
    const row = screen.getByTestId('loadouts-row-tempo-dev-team');
    expect(row.textContent).toContain('tempo-dev-team');
    expect(row.textContent).toContain('Development team');
    expect(row.textContent).toContain('5'); // player count
    expect(row.textContent).toContain('shipped');
    expect(row.textContent).toContain('—'); // last used unknown
  });

  it('each row exposes Edit + Load disabled-with-tooltip CTAs', () => {
    renderLoadouts();
    for (const l of SHIPPED_LINEUPS) {
      const edit = screen.getByTestId(`loadouts-row-${l.name}-edit`);
      const load = screen.getByTestId(`loadouts-row-${l.name}-load`);
      expect(edit).toHaveAttribute('aria-disabled', 'true');
      expect(load).toHaveAttribute('aria-disabled', 'true');
      expect(edit.getAttribute('title')).toMatch(/daemon endpoint/);
    }
  });
});
