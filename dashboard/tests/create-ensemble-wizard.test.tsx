/**
 * CreateEnsemble wizard — PR-E new screen. 3-step modal:
 *   1. lineup (name + lineup picker)
 *   2. customize (host + start mode + conductor instructions)
 *   3. review + submit
 *
 * Submit posts to `useEnsembleCreateMutation` which calls the
 * (wire-pending) POST `/v1/ensembles` endpoint. Until the daemon
 * exposes that, the mutation handles the 404 with a wire-gap toast.
 * Tests use the mock client which records the call without an HTTP
 * round-trip, so this suite passes without the daemon endpoint.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import type { ReactNode } from 'react';
import { CreateEnsemble } from '../src/screens/CreateEnsemble';
import { HttpError } from '../src/lib/client';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

interface RenderOpts {
  mock?: MockDashboardClient;
  /** When true, mounts a `<Toaster />` so toast assertions can resolve. */
  withToaster?: boolean;
}

function renderCreate({ mock, withToaster = false }: RenderOpts = {}) {
  const client = mock ?? new MockDashboardClient();
  __setDashboardClientForTests(client);
  const qc = newQc();
  return {
    mock: client,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/create-ensemble']}>
          <CreateEnsemble />
          {withToaster && <Toaster toastOptions={{ unstyled: true }} />}
        </MemoryRouter>
      </QueryClientProvider> as ReactNode,
    ),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('CreateEnsemble wizard (PR-E)', () => {
  it('renders the modal with the wizard dialog inside', () => {
    renderCreate();
    expect(screen.getByTestId('create-ensemble-modal')).toBeInTheDocument();
    expect(screen.getByTestId('screen-create-ensemble')).toBeInTheDocument();
    expect(screen.getByTestId('create-ensemble-input-name')).toBeInTheDocument();
  });

  it('disables Next on step 1 until the name validates', () => {
    renderCreate();
    expect(screen.getByTestId('create-ensemble-next')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'BadName' },
    });
    expect(screen.getByTestId('create-ensemble-input-name-error')).toBeInTheDocument();
    expect(screen.getByTestId('create-ensemble-next')).toHaveAttribute('aria-disabled', 'true');

    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'frontend-squad' },
    });
    expect(screen.queryByTestId('create-ensemble-input-name-error')).toBeNull();
    expect(screen.getByTestId('create-ensemble-next')).toHaveAttribute('aria-disabled', 'false');
  });

  it('progresses through all 3 steps', () => {
    renderCreate();
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'frontend-squad' },
    });
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    // step 2 — customize
    expect(screen.getByTestId('create-ensemble-start-mode')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    // step 3 — review
    expect(screen.getByTestId('create-ensemble-review')).toBeInTheDocument();
  });

  it('lineup picker defaults to the first shipped lineup and updates the summary', () => {
    renderCreate();
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'frontend-squad' },
    });
    // Default lineup row is `tempo-dev-team` (first in SHIPPED_LINEUPS).
    expect(
      screen.getByTestId('create-ensemble-lineup-option-tempo-dev-team'),
    ).toHaveAttribute('aria-checked', 'true');
    // Switch to blank ensemble.
    fireEvent.click(screen.getByTestId('create-ensemble-lineup-option-__blank__'));
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    expect(screen.getByTestId('create-ensemble-summary-lineup').textContent).toContain('blank');
  });

  // PR-E F-A-5: blank-ensemble option carries the accent treatment —
  // terracotta-tinted text + a `+` glyph in the marker. Mirrors canonical
  // screens.jsx:288-292's `<div className="picker-row"
  // style={{color:"var(--accent)"}}><span className="marker">+</span>…`.
  it('blank-ensemble row gets the accent treatment (terracotta + `+` marker) (F-A-5)', () => {
    renderCreate();
    const row = screen.getByTestId('create-ensemble-lineup-option-__blank__');
    // Terracotta tint applied to the row.
    expect((row as HTMLElement).style.color).toBe('var(--accent)');
    // Marker glyph is `+` even when the row isn't active. Find the
    // marker as the first `aria-hidden` span — that's PickerList's
    // `.marker` slot.
    const marker = row.querySelector('.marker');
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toBe('+');
  });

  it('start-mode chipset is single-select (hold ↔ release)', () => {
    renderCreate();
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'frontend-squad' },
    });
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    // Default: hold.
    expect(screen.getByTestId('create-ensemble-start-mode-chip-hold')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByTestId('create-ensemble-start-mode-chip-release-immediately'));
    expect(
      screen.getByTestId('create-ensemble-start-mode-chip-release-immediately'),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('create-ensemble-start-mode-chip-hold')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('submit calls client.createEnsemble with the form payload', async () => {
    const { mock } = renderCreate();
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'frontend-squad' },
    });
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.change(screen.getByTestId('create-ensemble-input-instructions'), {
      target: { value: 'Coordinate the dashboard rebuild.' },
    });
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-submit'));

    await waitFor(() => {
      expect(mock.mutationCalls.find((c) => c.method === 'createEnsemble')).toBeDefined();
    });
    const call = mock.mutationCalls.find((c) => c.method === 'createEnsemble')!;
    expect(call.args[0]).toMatchObject({
      name: 'frontend-squad',
      lineup: 'tempo-dev-team',
      startMode: 'hold',
      conductorInstructions: 'Coordinate the dashboard rebuild.',
    });
  });

  it('blank-ensemble selection omits the lineup arg from the mutation payload', async () => {
    const { mock } = renderCreate();
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'solo-effort' },
    });
    fireEvent.click(screen.getByTestId('create-ensemble-lineup-option-__blank__'));
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-submit'));

    await waitFor(() => {
      expect(mock.mutationCalls.find((c) => c.method === 'createEnsemble')).toBeDefined();
    });
    const call = mock.mutationCalls.find((c) => c.method === 'createEnsemble')!;
    expect(call.args[0]).not.toHaveProperty('lineup');
  });

  it('falls back to the local catalog hint when /v1/lineups errors', async () => {
    const mock = new MockDashboardClient({
      lineupsError: new Error('catalog unreachable'),
    });
    renderCreate({ mock });
    // Eager fallback means the picker is populated immediately; we
    // wait for the error-state hint to appear once the query settles.
    await waitFor(() => {
      const lineupField = screen.getByText(/showing local catalog/i);
      expect(lineupField).toBeInTheDocument();
    });
    // Picker still has the shipped rows (eager fallback) — sanity.
    expect(
      screen.getByTestId('create-ensemble-lineup-option-tempo-dev-team'),
    ).toBeInTheDocument();
  });

  it('shows 409 toast when ensemble already exists', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { createEnsemble: new HttpError(409, 'ensemble-exists', '/v1/ensembles') },
    });
    renderCreate({ mock, withToaster: true });
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'frontend-squad' },
    });
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('toast-error')).toBeInTheDocument();
    });
    const toast = screen.getByTestId('toast-error');
    expect(toast.textContent).toMatch(/already exists/i);
  });

  it('surfaces the underlying error message when createEnsemble fails', async () => {
    // The original wire-gap toast for 404s retired with #400 — the
    // POST /v1/ensembles endpoint exists now, so the dashboard maps
    // 409 and 400 to targeted copy and shows the underlying message
    // for everything else. Pin the generic-failure path; the 409 +
    // 400 branches are exercised separately in the daemon-side tests
    // that verify the HTTP shapes.
    const mock = new MockDashboardClient({
      mutationErrors: { createEnsemble: new Error('temporal unreachable') },
    });
    renderCreate({ mock, withToaster: true });
    fireEvent.change(screen.getByTestId('create-ensemble-input-name'), {
      target: { value: 'frontend-squad' },
    });
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-next'));
    fireEvent.click(screen.getByTestId('create-ensemble-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('toast-error')).toBeInTheDocument();
    });
    const toast = screen.getByTestId('toast-error');
    expect(toast.textContent).toMatch(/Failed to create frontend-squad/);
    expect(toast.textContent).toMatch(/temporal unreachable/);
  });
});
