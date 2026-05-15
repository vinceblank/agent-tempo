/**
 * Unit tests for `agent-tempo recall <player>`'s argv → formatter glue.
 *
 * The shared formatter (`src/utils/recall-format.ts`) has its own coverage
 * at `test/recall.test.ts`. This file owns the CLI-specific wiring: that
 * the argv parser builds a `ParsedArgs` the `recall()` verb consumes
 * without loss, and that `--json` bypasses the text renderer in favor of
 * the raw shape.
 *
 * We exercise the formatter directly rather than invoking the verb via
 * the CLI (which would need a Temporal connection). The verb's job is
 * "fetch timeline + feed formatter + emit"; this test covers the second
 * half and a round-trip through JSON.stringify to catch format drift.
 */
import { expect } from 'chai';
import { spawnSync } from 'child_process';
import * as path from 'path';
import type { Message, SentMessage } from '../src/types';
import { buildTimeline, formatRecall } from '../src/utils/recall-format';

// `__dirname` at runtime is `<repo>/dist-test/test`. Repo root is two levels up,
// matching the pattern `test/wire-protocol.test.ts` and `test/cli-spawn-sentinel.test.ts`
// already use for source-path resolution.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');

describe('CLI recall formatter wiring (#128)', function () {
  const received: Message[] = [
    { id: '1', from: 'alice', text: 'first message', timestamp: '2026-04-19T12:00:00.000Z', delivered: true },
    { id: '2', from: 'alice', text: 'second message', timestamp: '2026-04-19T12:00:01.000Z', delivered: true },
    { id: '3', from: 'bob',   text: 'third message', timestamp: '2026-04-19T12:00:02.000Z', delivered: true },
  ];
  const sent: SentMessage[] = [
    { id: 's-1', to: 'alice', text: 'outbound',    timestamp: '2026-04-19T11:59:59.000Z' },
  ];

  it('default opts render the gh-style header + all three entries newest-first', function () {
    const timeline = buildTimeline(received, sent, false);
    const r = formatRecall(timeline, {});
    expect(r.text).to.include('Showing 1-3 of 3 messages.');
    expect(r.text).to.not.include('Use offset:'); // not more than one page
    // Newest first.
    const lines = r.text.split('\n');
    const first = lines.find((l) => l.startsWith('['));
    expect(first).to.include('2026-04-19T12:00:02.000Z');
  });

  it('--include-sent mirrors the CLI flag → feeds buildTimeline(..., true)', function () {
    const timelineSent = buildTimeline(received, sent, true);
    const r = formatRecall(timelineSent, {});
    expect(r.total).to.equal(4);
    expect(r.text).to.include('→ alice');
  });

  it('--preview 8 truncates bodies', function () {
    const timeline = buildTimeline(received, sent, false);
    const r = formatRecall(timeline, { previewLength: 8 });
    // "first message" → "first me…"
    expect(r.text).to.include('first me…');
  });

  it('--limit 2 --offset 1 yields the middle entry + correct pagination header', function () {
    const timeline = buildTimeline(received, [], false);
    const r = formatRecall(timeline, { limit: 2, offset: 1 });
    expect(r.shown).to.equal(2);
    expect(r.hasMore).to.equal(false);
    expect(r.text).to.include('Showing 2-3 of 3 messages.');
    // offset skipped the newest (third message); the output should include the
    // remaining two older entries.
    expect(r.text).to.include('second message');
    expect(r.text).to.include('first message');
    expect(r.text).to.not.include('third message');
  });

  // ── Parser-cap tests (#270) ────────────────────────────────────────
  // Exercise the real CLI argv parser as a subprocess so we get the
  // production `process.exit(1)` semantics. The rejection happens in
  // `parseArgs` before the command dispatch, so the subprocess exits
  // without touching Temporal — safe to run without a dev server.
  describe('--limit cap (#270)', function () {
    this.timeout(10_000);

    it('rejects --limit 101 with the shared max=100 error', function () {
      const result = spawnSync(process.execPath, [CLI_ENTRY, 'recall', 'alice', '--limit', '101'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(result.status).to.equal(1, `expected exit 1; got ${result.status}; stderr=${result.stderr}`);
      // Error message must match the TUI parser verbatim so operators see the
      // same suggestion regardless of entry point. (Exact string, not substring.)
      expect(result.stderr).to.include('--limit exceeds max (100). Use --offset N to page through more results.');
    });

    it('accepts --limit 100 (the exact boundary) without parser error', function () {
      // At 100 the parser must pass; the command will still fail downstream
      // because there's no Temporal connection in the test env — we assert
      // the error is NOT the parser's cap error.
      const result = spawnSync(process.execPath, [CLI_ENTRY, 'recall', 'alice', '--limit', '100'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8_000,
      });
      expect(result.stderr).to.not.include('--limit exceeds max');
    });
  });

  it('--json equivalent: serializing the formatter result round-trips cleanly', function () {
    const timeline = buildTimeline(received, sent, true);
    const r = formatRecall(timeline, { limit: 2 });
    const raw = {
      player: 'tempo-eng',
      ensemble: 'demo',
      received,
      sent,
      total: r.total,
      shown: r.shown,
      hasMore: r.hasMore,
      text: r.text,
    };
    const roundtrip = JSON.parse(JSON.stringify(raw));
    expect(roundtrip.total).to.equal(4);
    expect(roundtrip.shown).to.equal(2);
    expect(roundtrip.hasMore).to.equal(true);
    expect(roundtrip.text).to.include('Showing 1-2 of 4 messages.');
    expect(roundtrip.received).to.have.length(3);
    expect(roundtrip.sent).to.have.length(1);
  });
});
