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

  it('shows the wire-gap toast when POST /v1/ensembles 404s', async () => {
    // Mutation hook detects "404" or "not found" in the error message
    // and swaps the generic failure toast for the wire-gap copy that
    // points users at the CLI fallback (`claude-tempo up <name>`).
    // This test pins that path — the toast wording is the one bit of
    // user-facing UX the headline feature promised.
    const mock = new MockDashboardClient({
      mutationErrors: { createEnsemble: new Error('not found') },
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
    expect(toast.textContent).toMatch(/not yet available/i);
    expect(toast.textContent).toMatch(/claude-tempo up/);
  });
});
