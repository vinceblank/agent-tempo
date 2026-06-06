/**
 * #700 P2 — SSE answer-wake: the aggregate's outstanding-ask poll + the
 * planner-wake message builder.
 *
 * - `buildAnswerWake` (pure): the injection a resolved `answer` event becomes.
 * - `AggregateRunner.trackAsk` + `pollOutstandingAnswers`: poll `getAnswer`
 *   per-outstanding, emit `answer` once on resolve + drop; TTL-expire stale asks.
 */
import { describe, it, expect } from 'vitest';
import type { EnsembleEventBus } from '../../src/http/event-bus';
import type { TempoClient } from '../../src/client/interface';
import type { AnswerEntry } from '../../src/types';
import { AggregateRunner } from '../../src/http/aggregate';
import { MAESTRO_ANSWER_TTL_MS } from '../../src/utils/validation';
import { buildAnswerWake } from '../../src/pi/mission-control/extension';

describe('buildAnswerWake (#700 P2)', () => {
  it('builds a triggerTurn answer injection carrying questionId + from', () => {
    const { message, options } = buildAnswerWake({ questionId: 'q-1', from: 'tempo-eng', ts: '2026-01-01T00:00:00.000Z' });
    expect(message.customType).toBe('answer');
    expect(message.content).toContain('q-1');
    expect(message.content).toContain('tempo-eng');
    expect(message.display).toBe(true);
    expect(options.triggerTurn).toBe(true);
  });
});

/** Records emitted events; satisfies the bits the runner calls on a bus. */
function makeFakeBus(emits: Array<{ type: string; payload: unknown }>): EnsembleEventBus {
  return {
    emit: (type: string, payload: unknown) => { emits.push({ type, payload }); },
    close: () => { /* no-op */ },
    subscriberCount: () => 0,
  } as unknown as EnsembleEventBus;
}

/** Fake client returning a scripted getAnswer result; records each call. */
function makeClient(result: () => AnswerEntry | null): { client: TempoClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    getAnswer: async (ensemble: string, questionId: string) => {
      calls.push(`${ensemble}/${questionId}`);
      return result();
    },
  } as unknown as TempoClient;
  return { client, calls };
}

describe('AggregateRunner outstanding-ask poll (#700 P2)', () => {
  const answer: AnswerEntry = { questionId: 'q-1', from: 'tempo-eng', text: 'done', answeredAt: '2026-01-01T00:00:00.000Z' };

  it('emits `answer` once on resolve and drops the ask', async () => {
    const emits: Array<{ type: string; payload: unknown }> = [];
    let now = 1_000;
    let resolved: AnswerEntry | null = null;
    const { client, calls } = makeClient(() => resolved);
    const runner = new AggregateRunner({
      client, bootEpoch: 1, pollIntervalMs: 60_000,
      now: () => now,
      busFactory: () => makeFakeBus(emits),
    });

    runner.trackAsk('demo', 'q-1');
    expect(runner._outstandingAskCount).toBe(1);

    // First poll — not answered yet → no emit, ask stays.
    await runner.pollOutstandingAnswers();
    expect(emits).toHaveLength(0);
    expect(runner._outstandingAskCount).toBe(1);

    // Player answers → next poll emits + drops.
    resolved = answer;
    await runner.pollOutstandingAnswers();
    expect(emits).toEqual([{ type: 'answer', payload: { questionId: 'q-1', from: 'tempo-eng', ts: answer.answeredAt } }]);
    expect(runner._outstandingAskCount).toBe(0);

    // Idempotent — a third poll does nothing (already dropped).
    await runner.pollOutstandingAnswers();
    expect(emits).toHaveLength(1);
    expect(calls.length).toBe(2); // not polled after drop
  });

  it('drops an unanswered ask past the mailbox TTL (no emit, no further polls)', async () => {
    const emits: Array<{ type: string; payload: unknown }> = [];
    let now = 1_000;
    const { client, calls } = makeClient(() => null);
    const runner = new AggregateRunner({
      client, bootEpoch: 1, pollIntervalMs: 60_000,
      now: () => now,
      busFactory: () => makeFakeBus(emits),
    });

    runner.trackAsk('demo', 'q-stale');
    now += MAESTRO_ANSWER_TTL_MS + 1; // age past TTL
    await runner.pollOutstandingAnswers();
    expect(emits).toHaveLength(0);
    expect(runner._outstandingAskCount).toBe(0);
    expect(calls).toHaveLength(0); // expired before any getAnswer call
  });
});
