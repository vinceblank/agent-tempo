/**
 * Vitest coverage for the TUI `/recall` surface (#128).
 *
 * Two layers:
 *  - `parseRecallFlags` — the pure argv parser exported from
 *    `src/tui/commands.ts`. Drives the handler, easy to test directly.
 *  - Handler integration via the public `COMMANDS['recall']` registry,
 *    with a mocked `TempoClient.recall` returning a canned timeline.
 *    Ensures the handler dispatches a `SHOW_COMMAND_OVERLAY` whose
 *    content came from the shared formatter (pagination header +
 *    entries).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  COMMANDS,
  parseRecallFlags,
  type CommandContext,
} from '../../src/tui/commands';
import type { Message, SentMessage } from '../../src/types';
import type { TempoClient } from '../../src/client';
import type { TuiAction } from '../../src/tui/store';

describe('parseRecallFlags', () => {
  it('bare /recall → maestro default (no player on the returned struct)', () => {
    expect(parseRecallFlags([])).toEqual({});
  });

  it('leading non-flag positional → player override', () => {
    expect(parseRecallFlags(['alice'])).toEqual({ player: 'alice' });
  });

  it('player + numeric + string flags all parse', () => {
    expect(
      parseRecallFlags(['alice', '--limit', '5', '--offset', '10', '--preview', '80', '--from', 'bob', '--since', '2026-04-19T00:00:00Z']),
    ).toEqual({
      player: 'alice',
      limit: 5,
      offset: 10,
      previewLength: 80,
      from: 'bob',
      since: '2026-04-19T00:00:00Z',
    });
  });

  it('--include-sent is boolean, no value consumed', () => {
    expect(parseRecallFlags(['--include-sent', '--limit', '3'])).toEqual({ includeSent: true, limit: 3 });
  });

  it('flags-only (no player) leaves player undefined', () => {
    expect(parseRecallFlags(['--limit', '5'])).toEqual({ limit: 5 });
  });

  it('unknown flag surfaces a usage error', () => {
    const r = parseRecallFlags(['--nope']);
    expect(r.error).toMatch(/Unknown flag.*--nope/);
  });

  it('missing value on --limit is a usage error', () => {
    const r = parseRecallFlags(['--limit']);
    expect(r.error).toMatch(/Missing value for --limit/);
  });

  it('non-numeric --limit is a usage error', () => {
    const r = parseRecallFlags(['--limit', 'abc']);
    expect(r.error).toMatch(/Invalid --limit/);
  });

  it('negative --offset is rejected (< 0)', () => {
    const r = parseRecallFlags(['--offset', '-1']);
    expect(r.error).toMatch(/Invalid --offset/);
  });

  it('--preview 0 rejected (min 1)', () => {
    const r = parseRecallFlags(['--preview', '0']);
    expect(r.error).toMatch(/Invalid --preview/);
  });

  it('--limit 101 rejected with max=100 hint (#270)', () => {
    const r = parseRecallFlags(['--limit', '101']);
    // Exact message is shared with the CLI parser — tested for substring to
    // catch both "exceeds max (100)" and the "--offset" workaround hint.
    expect(r.error).toBe('--limit exceeds max (100). Use --offset N to page through more results.');
  });

  it('--limit 100 is still accepted (boundary)', () => {
    expect(parseRecallFlags(['--limit', '100'])).toEqual({ limit: 100 });
  });
});

// ── Handler integration ────────────────────────────────────────────────

function makeApi(received: Message[], sent: SentMessage[]): TempoClient {
  const reject = () => Promise.reject(new Error('Unexpected TempoClient method call during /recall test'));
  return new Proxy({} as TempoClient, {
    get(_target, prop: string) {
      if (prop === 'recall') return vi.fn(async () => ({ received, sent }));
      return vi.fn(reject);
    },
  });
}

const CTX: CommandContext = { activeEnsemble: 'demo' };
const received: Message[] = [
  { id: '1', from: 'alice', text: 'hello', timestamp: '2026-04-19T12:00:00.000Z', delivered: true },
  { id: '2', from: 'alice', text: 'world', timestamp: '2026-04-19T12:00:01.000Z', delivered: true },
];

describe('/recall TUI handler (#128)', () => {
  it('renders the formatter output into a SHOW_COMMAND_OVERLAY', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS['recall'].handler!;
    await handler([], dispatch, makeApi(received, []), CTX);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0] as { type: string; title: string; content: string };
    expect(action.type).toBe('SHOW_COMMAND_OVERLAY');
    // Default targets maestro.
    expect(action.title).toBe('Recall \u00B7 maestro');
    expect(action.content).toContain('Showing 1-2 of 2 messages.');
    // Newest first: line 2 ("world") should precede "hello".
    const worldIdx = action.content.indexOf('world');
    const helloIdx = action.content.indexOf('hello');
    expect(worldIdx).toBeGreaterThan(-1);
    expect(helloIdx).toBeGreaterThan(-1);
    expect(worldIdx).toBeLessThan(helloIdx);
  });

  it('with a player positional, titles the overlay with that player', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS['recall'].handler!;
    await handler(['alice'], dispatch, makeApi(received, []), CTX);

    const action = dispatch.mock.calls[0][0] as { type: string; title: string };
    expect(action.title).toBe('Recall \u00B7 alice');
  });

  it('flag parse error dispatches a COMMIT_STATIC error, not an overlay', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS['recall'].handler!;
    await handler(['--nope'], dispatch, makeApi(received, []), CTX);

    // No overlay on the error path.
    const overlays = dispatch.mock.calls.filter(
      ([a]) => (a as { type: string }).type === 'SHOW_COMMAND_OVERLAY',
    );
    expect(overlays.length).toBe(0);
    const errors = dispatch.mock.calls.filter(
      ([a]) => (a as { type: string }).type === 'COMMIT_STATIC',
    );
    expect(errors.length).toBe(1);
  });
});
