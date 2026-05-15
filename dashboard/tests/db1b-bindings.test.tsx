/**
 * DB1b — dashboard bindings for the #399 W1/W2/W3 wire extensions.
 *
 * Each test pumps a snapshot mock that carries the W1/W2 projected
 * fields (description, startedAt, currentBpm, tempoSeries, runId,
 * messaging, lease) and asserts the corresponding dashboard surface
 * reads them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, RouterProvider } from 'react-router-dom';
import type { ReactNode } from 'react';
import { EnsembleCard } from '../src/components/EnsembleCard';
import { Hosts } from '../src/screens/Hosts';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import { makePlayer } from './fixtures/factories';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';
import {
  formatDuration,
  formatLeaseRemaining,
  formatRunId,
} from '../src/lib/time-format';
import type { EnsembleStateV1, PlayerSummaryV1 } from 'agent-tempo/http/event-types';
import type { HostInfo } from 'agent-tempo/types';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function extSnapshot(over: Partial<EnsembleStateV1>): EnsembleStateV1 {
  return { ...makeSnapshot({ ensemble: 'demo' }), ...over };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('formatDuration', () => {
  it('returns "—" for undefined / negative / non-finite inputs', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
    expect(formatDuration(Infinity)).toBe('—');
  });

  it.each([
    [0, '<1m'],
    [45_000, '<1m'],
    [60_000, '1m'],
    [90_000, '1m'],
    [60 * 60_000, '1h'],
    [(60 * 60 + 14 * 60) * 1000, '1h 14m'],
    [25 * 60 * 60_000, '1d 1h'],
  ])('formats %i ms as "%s"', (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });
});

describe('formatLeaseRemaining', () => {
  it('returns "—" for null / undefined / non-finite', () => {
    expect(formatLeaseRemaining(null)).toBe('—');
    expect(formatLeaseRemaining(undefined)).toBe('—');
    expect(formatLeaseRemaining(NaN)).toBe('—');
  });

  it('returns "expired" once the deadline has passed', () => {
    const now = 100_000;
    expect(formatLeaseRemaining(50_000, now)).toBe('expired');
    expect(formatLeaseRemaining(100_000, now)).toBe('expired');
  });

  it('returns "expires in Xs/Xm/Xh" for live leases', () => {
    const now = 0;
    expect(formatLeaseRemaining(45_000, now)).toBe('expires in 45s');
    expect(formatLeaseRemaining(90_000, now)).toBe('expires in 1m');
    expect(formatLeaseRemaining(60 * 60_000, now)).toBe('expires in 1h');
  });
});

describe('formatRunId', () => {
  it('returns "—" for missing or empty input', () => {
    expect(formatRunId(undefined)).toBe('—');
    expect(formatRunId('')).toBe('—');
    expect(formatRunId('   ')).toBe('—');
  });

  it('truncates UUID-style strings to first4·last4', () => {
    expect(formatRunId('a3f2b8e0-1234-5678-9abc-def012345678c881')).toBe('a3f2·c881');
    expect(formatRunId('abcdefghij')).toBe('abcd·ghij');
  });

  it('passes short strings through unchanged', () => {
    expect(formatRunId('short')).toBe('short');
    expect(formatRunId('12345678')).toBe('12345678');
  });
});

describe('EnsembleCard — DB1a binding', () => {
  function renderCard(snapshot: EnsembleStateV1) {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 0, hasConductor: true, state: 'online' }],
      snapshot,
    });
    __setDashboardClientForTests(mock);
    return render(
      <QueryClientProvider client={newQc()}>
        <MemoryRouter>
          <EnsembleCard
            ensemble={{ name: 'demo', playerCount: 0, hasConductor: true, state: 'online' }}
          />
        </MemoryRouter>
      </QueryClientProvider> as ReactNode,
    );
  }

  it('renders the description from the snapshot when present', async () => {
    renderCard(extSnapshot({ description: 'shipping the dashboard wire extensions' }));
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo-desc').textContent).toContain(
        'shipping the dashboard wire extensions',
      );
    });
  });

  it('renders empty .ec-desc when description is absent (Q5.1 — no fallback sentinel)', async () => {
    renderCard(extSnapshot({ description: '', hasConductor: true }));
    await waitFor(() => {
      // Q5.1: no fallback text — the .ec-desc div exists (preserves grid
      // min-height) but must be empty when no description has been set.
      expect(screen.getByTestId('ensemble-card-demo-desc').textContent).toBe('');
    });
  });

  it('renders BPM from the snapshot, "—" when undefined', async () => {
    renderCard(extSnapshot({ currentBpm: 92 }));
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo-bpm').textContent).toBe('92');
    });
  });

  it('falls back to "—" for the BPM when DB1a hasn\'t projected it', async () => {
    renderCard(extSnapshot({}));
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo-bpm').textContent).toBe('—');
    });
  });

  it('derives uptime from startedAt via formatDuration', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    renderCard(extSnapshot({ startedAt: fiveMinutesAgo }));
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo-uptime').textContent).toMatch(
        /^\d+m$/,
      );
    });
  });

  it('renders "—" for uptime when startedAt is missing or unparseable', async () => {
    renderCard(extSnapshot({ startedAt: 'not-an-iso-string' }));
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo-uptime').textContent).toBe('—');
    });
  });
});

describe('PlayerDetail — DB1a binding for KV rows', () => {
  function renderPlayerDetail(player: PlayerSummaryV1) {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: extSnapshot({
        ensemble: 'demo',
        players: [player],
      }),
    });
    __setDashboardClientForTests(mock);
    const router = createDashboardMemoryRouter([
      `/ensemble/demo/player/${player.playerId}`,
    ]);
    return render(
      <QueryClientProvider client={newQc()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it('binds runId via formatRunId', async () => {
    renderPlayerDetail({
      ...makePlayer({ playerId: 'tempo-eng' }),
      runId: 'a3f2b8e0-1234-5678-9abc-def012345678',
    } as PlayerSummaryV1);
    await waitFor(() => {
      expect(
        screen.getByTestId('player-detail-tempo-eng-kv-run-id').textContent,
      ).toContain('a3f2·5678');
    });
  });

  it('binds lease via formatLeaseRemaining', async () => {
    renderPlayerDetail({
      ...makePlayer({ playerId: 'tempo-eng' }),
      lease: { expiresAt: Date.now() + 45_000, leaseMs: 60_000 },
    } as PlayerSummaryV1);
    await waitFor(() => {
      expect(
        screen.getByTestId('player-detail-tempo-eng-kv-lease').textContent,
      ).toMatch(/expires in \d+s/);
    });
  });

  it('binds messaging counters + outbox status', async () => {
    renderPlayerDetail({
      ...makePlayer({ playerId: 'tempo-eng' }),
      messaging: { received: 7, sent: 4, outbox: '2 pending' },
    } as PlayerSummaryV1);
    await waitFor(() => {
      expect(
        screen.getByTestId('player-detail-tempo-eng-kv-received').textContent,
      ).toContain('7');
    });
    expect(
      screen.getByTestId('player-detail-tempo-eng-kv-sent').textContent,
    ).toContain('4');
    expect(
      screen.getByTestId('player-detail-tempo-eng-kv-outbox').textContent,
    ).toContain('2 pending');
  });

  it('falls back to "—" for messaging counters when DB1a hasn\'t projected', async () => {
    renderPlayerDetail({
      ...makePlayer({ playerId: 'tempo-eng' }),
    } as PlayerSummaryV1);
    await waitFor(() => {
      expect(
        screen.getByTestId('player-detail-tempo-eng-kv-received').textContent,
      ).toContain('—');
    });
    expect(
      screen.getByTestId('player-detail-tempo-eng-kv-outbox').textContent,
    ).toContain('—');
  });
});

describe('Hosts — uptime column binding', () => {
  function renderHosts(hostsList: HostInfo[]) {
    const mock = new MockDashboardClient({ hosts: hostsList });
    __setDashboardClientForTests(mock);
    return render(
      <QueryClientProvider client={newQc()}>
        <MemoryRouter><Hosts /></MemoryRouter>
      </QueryClientProvider> as ReactNode,
    );
  }

  it('renders uptime via formatDuration when daemonStartedAt is set on a live host', async () => {
    const startedAt = Date.now() - 3 * 60_000; // 3 minutes ago
    renderHosts([
      {
        hostname: 'studio',
        freshness: 'live',
        recruitReady: true,
        profileStaleness: 'fresh',
        instances: [{
          pid: 1,
          version: '0.28.0',
          identity: 'studio',
          lastAccessTime: new Date().toISOString(),
          hasWorkflowWorker: true,
          hasActivityWorker: true,
          hasHostQueueWorker: true,
        }],
        profile: { hostname: 'studio', daemonStartedAt: startedAt, version: '0.28.0' },
      },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('host-row-studio-uptime').textContent).toMatch(/^\d+m$/);
    });
  });

  it('falls back to "—" when daemonStartedAt is missing', async () => {
    renderHosts([
      {
        hostname: 'studio',
        freshness: 'live',
        recruitReady: true,
        profileStaleness: 'fresh',
        instances: [{
          pid: 1,
          version: '0.28.0',
          identity: 'studio',
          lastAccessTime: new Date().toISOString(),
          hasWorkflowWorker: true,
          hasActivityWorker: true,
          hasHostQueueWorker: true,
        }],
        profile: { hostname: 'studio', version: '0.28.0' },
      },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('host-row-studio-uptime').textContent).toBe('—');
    });
  });
});
