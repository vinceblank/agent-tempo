/**
 * Recruit wizard — PR-E rebuild. 4-step modal:
 *   1. identity (name + part)
 *   2. type (player-type picker + agent select)
 *   3. spawn (workdir + host + opening task + options)
 *   4. review + submit
 *
 * Modal preserves the `?ensemble=…` entry pattern from the old wizard;
 * Workspace's "+ Recruit" Link still resolves correctly.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Recruit } from '../src/screens/Recruit';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderRecruit(opts: { ensemble?: string; mock?: MockDashboardClient } = {}) {
  const ensemble = opts.ensemble ?? 'demo';
  const mock = opts.mock ?? new MockDashboardClient();
  __setDashboardClientForTests(mock);
  const qc = newQc();
  const initial = ensemble === '' ? '/recruit' : `/recruit?ensemble=${encodeURIComponent(ensemble)}`;
  return {
    mock,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initial]}>
          <Recruit />
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

function advanceStep1(name = 'tempo-soloist-1'): void {
  fireEvent.change(screen.getByTestId('recruit-input-name'), { target: { value: name } });
  fireEvent.click(screen.getByTestId('recruit-next'));
}
function advanceStep2(): void {
  // Default player type is the first SHIPPED_PLAYER_TYPES entry, so
  // step 2 is already valid on entry.
  fireEvent.click(screen.getByTestId('recruit-next'));
}
function advanceStep3(workDir = '/repo/path'): void {
  fireEvent.change(screen.getByTestId('recruit-input-workdir'), { target: { value: workDir } });
  fireEvent.click(screen.getByTestId('recruit-next'));
}

describe('Recruit wizard (PR-E)', () => {
  it('starts on step 1 with disabled Next until name is valid', () => {
    renderRecruit();
    expect(screen.getByTestId('recruit-wizard-step-1')).toBeInTheDocument();
    expect(screen.getByTestId('recruit-next')).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows a name validation error when input is non-empty but invalid', () => {
    renderRecruit();
    fireEvent.change(screen.getByTestId('recruit-input-name'), {
      target: { value: 'has spaces' },
    });
    expect(screen.getByTestId('recruit-input-name-error')).toBeInTheDocument();
  });

  it('progresses through all 4 steps with valid inputs', () => {
    renderRecruit();
    advanceStep1();
    expect(screen.getByTestId('recruit-wizard-step-2')).toBeInTheDocument();
    advanceStep2();
    expect(screen.getByTestId('recruit-wizard-step-3')).toBeInTheDocument();
    advanceStep3();
    expect(screen.getByTestId('recruit-wizard-step-4')).toBeInTheDocument();
  });

  it('Back button moves the user from step 2 back to step 1', () => {
    renderRecruit();
    advanceStep1();
    expect(screen.getByTestId('recruit-wizard-step-2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recruit-back'));
    expect(screen.getByTestId('recruit-wizard-step-1')).toBeInTheDocument();
  });

  // PR-E F-A-6: the player-type picker right-slot renders a color-coded
  // TypeBadge (one hue per type), not the gray source-tier label that
  // shipped pre-audit. The badge is `data-testid="type-badge-<name>"`.
  it('player-type picker right-slot renders a color-coded TypeBadge (F-A-6)', () => {
    renderRecruit();
    advanceStep1();
    // Each picker row carries a TypeBadge with a deterministic testid.
    expect(screen.getByTestId('type-badge-tempo-conductor')).toBeInTheDocument();
    expect(screen.getByTestId('type-badge-tempo-soloist')).toBeInTheDocument();
    // The pre-audit gray uppercase source label should no longer leak
    // out of the picker row.
    expect(screen.queryByText('SHIPPED', { selector: '.mono.dim' })).toBeNull();
  });

  it('player-type picker is single-select and updates the review summary', () => {
    renderRecruit();
    advanceStep1();
    // Default: tempo-conductor (first in SHIPPED_PLAYER_TYPES).
    expect(
      screen.getByTestId('recruit-input-player-type-option-tempo-conductor'),
    ).toHaveAttribute('aria-checked', 'true');
    // Pick a different type.
    fireEvent.click(screen.getByTestId('recruit-input-player-type-option-tempo-soloist'));
    expect(
      screen.getByTestId('recruit-input-player-type-option-tempo-soloist'),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByTestId('recruit-input-player-type-option-tempo-conductor'),
    ).toHaveAttribute('aria-checked', 'false');
    // Advance to review and check the summary.
    advanceStep2();
    advanceStep3();
    expect(screen.getByTestId('recruit-summary-player-type').textContent).toContain('tempo-soloist');
  });

  it('agent field is a separate select (claude default, switchable to copilot)', () => {
    renderRecruit();
    advanceStep1();
    const agent = screen.getByTestId('recruit-input-agent') as globalThis.HTMLSelectElement;
    expect(agent.value).toBe('claude');
    fireEvent.change(agent, { target: { value: 'copilot' } });
    expect(agent.value).toBe('copilot');
    advanceStep2();
    advanceStep3();
    expect(screen.getByTestId('recruit-summary-agent').textContent).toContain('copilot');
  });

  it('without ?ensemble= shows the missing-ensemble alert', () => {
    renderRecruit({ ensemble: '' });
    expect(screen.getByTestId('recruit-missing-ensemble')).toBeInTheDocument();
  });

  it('submit calls client.recruit with player-type + agent', async () => {
    const { mock } = renderRecruit({ ensemble: 'demo' });
    advanceStep1('frontend-eng');
    fireEvent.click(screen.getByTestId('recruit-input-player-type-option-tempo-soloist'));
    advanceStep2();
    advanceStep3('/repos/my-app');
    fireEvent.click(screen.getByTestId('recruit-submit'));

    await waitFor(() => {
      expect(mock.mutationCalls.find((c) => c.method === 'recruit')).toBeDefined();
    });
    const call = mock.mutationCalls.find((c) => c.method === 'recruit')!;
    expect(call.args[0]).toBe('demo');
    expect(call.args[1]).toMatchObject({
      name: 'frontend-eng',
      workDir: '/repos/my-app',
      agent: 'claude',
      playerType: 'tempo-soloist',
    });
  });

  it('submit honors the hold chipset (held: true when hold selected)', async () => {
    const { mock } = renderRecruit({ ensemble: 'demo' });
    advanceStep1('frontend-eng');
    advanceStep2();
    fireEvent.change(screen.getByTestId('recruit-input-workdir'), {
      target: { value: '/repos/my-app' },
    });
    fireEvent.click(screen.getByTestId('recruit-input-hold-chip-hold'));
    fireEvent.click(screen.getByTestId('recruit-next'));
    fireEvent.click(screen.getByTestId('recruit-submit'));
    await waitFor(() => {
      expect(mock.mutationCalls.find((c) => c.method === 'recruit')).toBeDefined();
    });
    const call = mock.mutationCalls.find((c) => c.method === 'recruit')!;
    expect((call.args[1] as { held?: boolean }).held).toBe(true);
  });
});
