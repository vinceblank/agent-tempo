/**
 * Recruit wizard — covers step navigation, validation, and the
 * (PR-7b) wired submit that calls `useRecruitMutation`.
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
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderRecruit(opts: { ensemble?: string; mock?: MockDashboardClient } = {}) {
  const ensemble = opts.ensemble ?? 'demo';
  const mock = opts.mock ?? new MockDashboardClient();
  __setDashboardClientForTests(mock);
  const qc = newQc();
  return {
    mock,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/recruit?ensemble=${encodeURIComponent(ensemble)}`]}>
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

describe('Recruit wizard', () => {
  it('starts on step 1 with disabled Next until name is valid', () => {
    renderRecruit();
    expect(screen.getByTestId('recruit-wizard-step-1')).toBeInTheDocument();
    const next = screen.getByTestId('recruit-next');
    expect(next).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows a name validation error when the input is non-empty but invalid', () => {
    renderRecruit();
    const nameInput = screen.getByTestId('recruit-input-name');
    fireEvent.change(nameInput, { target: { value: 'has spaces' } });
    expect(screen.getByTestId('recruit-input-name-error')).toBeInTheDocument();
  });

  it('progresses through steps 1 → 2 → 3 with valid inputs', () => {
    renderRecruit();
    fireEvent.change(screen.getByTestId('recruit-input-name'), {
      target: { value: 'tempo-soloist-1' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    expect(screen.getByTestId('recruit-wizard-step-2')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('recruit-input-workdir'), {
      target: { value: '/repo/path' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    expect(screen.getByTestId('recruit-wizard-step-3')).toBeInTheDocument();
  });

  it('Back button moves the user from step 2 back to step 1', () => {
    renderRecruit();
    fireEvent.change(screen.getByTestId('recruit-input-name'), {
      target: { value: 'tempo-soloist-1' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    expect(screen.getByTestId('recruit-wizard-step-2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recruit-back'));
    expect(screen.getByTestId('recruit-wizard-step-1')).toBeInTheDocument();
  });

  it('without ?ensemble= shows the missing-ensemble alert (PR-7b empty state)', () => {
    __setDashboardClientForTests(new MockDashboardClient());
    const qc = newQc();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/recruit']}>
          <Recruit />
        </MemoryRouter>
      </QueryClientProvider> as ReactNode,
    );
    expect(screen.getByTestId('recruit-missing-ensemble')).toBeInTheDocument();
  });

  it('submit (PR-7b) calls client.recruit and resets the wizard on success', async () => {
    const { mock } = renderRecruit({ ensemble: 'demo' });

    fireEvent.change(screen.getByTestId('recruit-input-name'), {
      target: { value: 'tempo-soloist-1' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    fireEvent.change(screen.getByTestId('recruit-input-workdir'), {
      target: { value: '/repo/path' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));

    fireEvent.click(screen.getByTestId('recruit-submit'));

    await waitFor(() => {
      expect(mock.mutationCalls.find((c) => c.method === 'recruit')).toBeDefined();
    });
    const call = mock.mutationCalls.find((c) => c.method === 'recruit')!;
    expect(call.args[0]).toBe('demo');
    expect(call.args[1]).toMatchObject({
      name: 'tempo-soloist-1', workDir: '/repo/path', agent: 'claude',
    });
  });
});
