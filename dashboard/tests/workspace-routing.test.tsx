/**
 * Workspace chat-input routing — submit-time @-cue + slash dispatch
 * (#471/#472).
 *
 * Bug from #471: vinceblank found that typing `@test-player how are
 * you?` from the dashboard chat ALWAYS routed to `conductorPlayerId`,
 * ignoring the @-prefix. The recipient saw only their `initialMessage`
 * from recruit because every directed cue silently misrouted to the
 * conductor.
 *
 * Tests below:
 *   1. `@<player> message` — routed to that player, NOT the conductor.
 *      (The fix.)
 *   2. Plain text — routed to the conductor (legacy behaviour, must
 *      still work).
 *   3. `@<unknown>` — surfaces an inline composer-status banner, never
 *      calls cue.
 *   4. `/clear` — wipes the local chat cache without calling any
 *      mutation.
 *   5. `/pause` — fires the pause mutation.
 *   6. `/<unknown>` — surfaces a composer-status error and does NOT
 *      cue the literal `/foo` string.
 *
 * Post-PR-2 (Sonner removal): assertions target `composer-status` with
 * `data-level="error" | "info"` filters instead of the old Sonner
 * `toast-error` / `toast-info` testids. The status banner lives
 * inline above the Composer rather than as a corner toast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import type { EnsembleStateV1 } from 'agent-tempo/http/event-types';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient } from './fixtures/mock-client';
import { makePlayer, makeSnapshot } from './fixtures/factories';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';
import { ensembleQueryKey } from '../src/lib/queries';

function newQc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWorkspace(client: MockDashboardClient, path = '/ensemble/demo') {
  __setDashboardClientForTests(client);
  const qc = newQc();
  const router = createDashboardMemoryRouter([path]);
  const utils = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

/**
 * Helper for the post-PR-2 inline status surface. Returns the
 * `<ComposerStatus>` element matching the requested level, or fails
 * the assertion if not present.
 */
async function findComposerStatus(level: 'error' | 'info'): Promise<HTMLElement> {
  // The status banner asserts `data-level="error"|"info"`; we filter
  // by the attribute so error-vs-info tests don't false-positive on
  // each other.
  return screen.findByTestId('composer-status').then((el) => {
    expect(el).toHaveAttribute('data-level', level);
    return el;
  });
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

function makeMock() {
  return new MockDashboardClient({
    snapshot: makeSnapshot({
      ensemble: 'demo',
      hasConductor: true,
      players: [
        makePlayer({
          playerId: 'tempo-conductor',
          isConductor: true,
          playerType: 'tempo-conductor',
        }),
        makePlayer({ playerId: 'tempo-eng', playerType: 'my-tempo-engineer' }),
        makePlayer({ playerId: 'tempo-qa', playerType: 'my-tempo-qa' }),
      ],
    }),
  });
}

async function getInput(): Promise<HTMLTextAreaElement> {
  // Wait for the data-loaded branch — the composer only mounts once
  // the snapshot resolves.
  return (await screen.findByTestId('composer-input')) as HTMLTextAreaElement;
}

function fillAndSubmit(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value } });
  // Modifier+Enter submits regardless of OS — the component checks
  // `metaKey` on Mac and `ctrlKey` elsewhere; we fire both so the
  // test passes on either branch.
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, metaKey: true });
}

describe('Workspace — directed cue routing (#471)', () => {
  it('"@tempo-eng hi" routes the cue to tempo-eng, not the conductor', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '@tempo-eng hi there');

    await waitFor(() => {
      const cues = mock.mutationCalls.filter((c) => c.method === 'cue');
      expect(cues).toHaveLength(1);
    });
    const cue = mock.mutationCalls.find((c) => c.method === 'cue');
    // mock.cue(ensemble, to, message) — args are positional.
    expect(cue?.args).toEqual(['demo', 'tempo-eng', 'hi there']);
  });

  it('plain text without @ still routes to the conductor (legacy behaviour preserved)', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, 'hello everyone');

    await waitFor(() => {
      const cues = mock.mutationCalls.filter((c) => c.method === 'cue');
      expect(cues).toHaveLength(1);
    });
    const cue = mock.mutationCalls.find((c) => c.method === 'cue');
    expect(cue?.args).toEqual(['demo', 'tempo-conductor', 'hello everyone']);
  });

  it('"@unknown hi" surfaces an inline composer-status error and does NOT call cue', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '@nonexistent-player ping');

    const status = await findComposerStatus('error');
    expect(status.textContent).toMatch(/No player named "nonexistent-player"/);
    // No cue mutation fired — the validation gate held.
    expect(mock.mutationCalls.filter((c) => c.method === 'cue')).toHaveLength(0);
  });

  it('"@tempo-eng" alone (no body) surfaces a composer-status error and does NOT cue', async () => {
    // Pinned by parse-chat-input — mention-without-body must not
    // silently fall through.
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '@tempo-eng');

    const status = await findComposerStatus('error');
    expect(status.textContent).toMatch(/No message after @tempo-eng/);
    expect(mock.mutationCalls.filter((c) => c.method === 'cue')).toHaveLength(0);
  });
});

describe('Workspace — slash dispatch (#472)', () => {
  it('"/clear" wipes the local chat cache without firing any mutation', async () => {
    const mock = makeMock();
    const { qc } = renderWorkspace(mock);
    const input = await getInput();

    // Seed the cache with chat messages so we can observe the wipe.
    qc.setQueryData<EnsembleStateV1 | undefined>(
      ensembleQueryKey('demo'),
      (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          chat: {
            ...prev.chat,
            messages: [
              {
                id: 'm-1',
                from: 'maestro',
                to: 'tempo-conductor',
                text: 'old line',
                timestamp: '2026-04-29T05:00:00.000Z',
                role: 'maestro-out',
              },
            ],
            total: 1,
          },
        };
      },
    );

    fillAndSubmit(input, '/clear');

    await waitFor(() => {
      const cached = qc.getQueryData<EnsembleStateV1>(ensembleQueryKey('demo'));
      expect(cached?.chat.messages).toEqual([]);
      expect(cached?.chat.total).toBe(0);
    });

    // /clear is a local-only verb — no wire calls fired.
    expect(mock.mutationCalls).toHaveLength(0);
  });

  it('"/pause" fires the pause mutation', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/pause');

    await waitFor(() => {
      expect(mock.mutationCalls.find((c) => c.method === 'pause')).toBeTruthy();
    });
    expect(mock.mutationCalls.filter((c) => c.method === 'cue')).toHaveLength(0);
  });

  it('"/play" fires the play mutation', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/play');

    await waitFor(() => {
      expect(mock.mutationCalls.find((c) => c.method === 'play')).toBeTruthy();
    });
  });

  it('"/release" fires the release mutation with no playerId', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/release');

    await waitFor(() => {
      const release = mock.mutationCalls.find((c) => c.method === 'release');
      expect(release).toBeTruthy();
      // release(ensemble, playerId?) — undefined for the bare /release form.
      expect(release?.args).toEqual(['demo', undefined]);
    });
  });

  it('"/release tempo-eng" fires release scoped to that player', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/release tempo-eng');

    await waitFor(() => {
      const release = mock.mutationCalls.find((c) => c.method === 'release');
      expect(release?.args).toEqual(['demo', 'tempo-eng']);
    });
  });

  it('"/recall <player>" fires the recall mutation', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/recall tempo-eng');

    await waitFor(() => {
      const recall = mock.mutationCalls.find((c) => c.method === 'recall');
      expect(recall).toBeTruthy();
    });
  });

  it('"/recall" (no arg) surfaces a usage error and does NOT call recall', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/recall');

    const status = await findComposerStatus('error');
    expect(status.textContent).toMatch(/Usage: \/recall <player>/);
    expect(mock.mutationCalls.find((c) => c.method === 'recall')).toBeUndefined();
  });

  it('"/unknownverb" surfaces a composer-status error and does NOT cue the literal text', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/unknownverb foo');

    const status = await findComposerStatus('error');
    expect(status.textContent).toMatch(/not supported in the dashboard/i);
    // Critical: the literal `/unknownverb foo` must NOT have been sent
    // as a chat message to the conductor — that would defeat the slash
    // semantics entirely.
    expect(mock.mutationCalls.filter((c) => c.method === 'cue')).toHaveLength(0);
  });

  it('"/help" surfaces an info banner with the verb list (no wire calls)', async () => {
    const mock = makeMock();
    renderWorkspace(mock);
    const input = await getInput();

    fillAndSubmit(input, '/help');

    const status = await findComposerStatus('info');
    expect(status.textContent).toMatch(/Slash commands/);
    // The verb list lives in the description — verify a couple of
    // representative entries surface so a future refactor can't quietly
    // drop them.
    expect(status.textContent).toMatch(/\/help/);
    expect(status.textContent).toMatch(/\/clear/);
    expect(mock.mutationCalls).toHaveLength(0);
  });
});
