/**
 * Unit tests for the shared recall formatter (#128). Tests the pure
 * pipeline — filter → sort → slice → render — without booting Temporal.
 *
 * The MCP `recall` tool, TUI `/recall` slash command, and `claude-tempo
 * recall <name>` CLI all feed the same formatter; per-surface integration
 * tests live alongside their respective modules. This file covers the
 * core cases that apply to every surface:
 *   - pagination header (first page, middle page, last page)
 *   - `offset >= total` sentinel message
 *   - empty timeline sentinel message
 *   - `previewLength` omitted → full body
 *   - `previewLength` set → ellipsis truncation
 *   - `from` filter applies to received only (sent entries bypass it)
 *   - `since` filter applies universally
 *   - sort order (desc by timestamp)
 */
import { expect } from 'chai';
import type { Message, SentMessage } from '../src/types';
import {
  buildTimeline,
  formatRecall,
  type TimelineEntry,
} from '../src/utils/recall-format';

// Helper: build N received messages at increasing timestamps for
// predictable pagination. #0 is oldest, #N-1 is newest, so the sort-desc
// formatter emits #N-1 first.
function receivedFixture(n: number, from = 'alice'): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    from,
    text: `message body #${i}`,
    timestamp: new Date(Date.UTC(2026, 3, 19, 12, 0, i)).toISOString(),
    delivered: true,
  }));
}

function sentFixture(n: number, to = 'bob'): SentMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s-${i}`,
    to,
    text: `outbound #${i}`,
    timestamp: new Date(Date.UTC(2026, 3, 19, 11, 0, i)).toISOString(),
  }));
}

describe('buildTimeline (#128)', function () {
  it('maps received-only when includeSent is false', function () {
    const timeline = buildTimeline(receivedFixture(3), sentFixture(2), false);
    expect(timeline).to.have.length(3);
    expect(timeline.every((e) => e.direction === 'received')).to.equal(true);
  });

  it('includes sent entries when includeSent is true', function () {
    const timeline = buildTimeline(receivedFixture(3), sentFixture(2), true);
    expect(timeline).to.have.length(5);
    expect(timeline.filter((e) => e.direction === 'sent')).to.have.length(2);
  });

  it('preserves the `delivered` flag on received entries', function () {
    const received: Message[] = [
      { id: 'a', from: 'x', text: 't', timestamp: new Date().toISOString(), delivered: false },
    ];
    const timeline = buildTimeline(received, [], false);
    expect(timeline[0].delivered).to.equal(false);
  });
});

describe('formatRecall (#128)', function () {
  describe('pagination header', function () {
    it('first page (offset 0) — shows X-Y of Z + hint only if more remain', function () {
      const timeline = buildTimeline(receivedFixture(5), [], false);
      const r = formatRecall(timeline, { limit: 3 });
      expect(r.total).to.equal(5);
      expect(r.shown).to.equal(3);
      expect(r.hasMore).to.equal(true);
      expect(r.text).to.include('Showing 1-3 of 5 messages.');
      expect(r.text).to.include('Use offset: 3 for next page.');
    });

    it('middle page — still offers next hint', function () {
      const timeline = buildTimeline(receivedFixture(10), [], false);
      const r = formatRecall(timeline, { limit: 3, offset: 3 });
      expect(r.shown).to.equal(3);
      expect(r.hasMore).to.equal(true);
      expect(r.text).to.include('Showing 4-6 of 10 messages.');
      expect(r.text).to.include('Use offset: 6 for next page.');
    });

    it('last page — omits the next-page hint', function () {
      const timeline = buildTimeline(receivedFixture(5), [], false);
      const r = formatRecall(timeline, { limit: 3, offset: 3 });
      expect(r.shown).to.equal(2);
      expect(r.hasMore).to.equal(false);
      expect(r.text).to.include('Showing 4-5 of 5 messages.');
      expect(r.text).to.not.include('Use offset:');
    });

    it('exactly full last page — still no next-page hint', function () {
      const timeline = buildTimeline(receivedFixture(6), [], false);
      const r = formatRecall(timeline, { limit: 3, offset: 3 });
      expect(r.shown).to.equal(3);
      expect(r.hasMore).to.equal(false);
      expect(r.text).to.include('Showing 4-6 of 6 messages.');
      expect(r.text).to.not.include('Use offset:');
    });
  });

  describe('edge cases', function () {
    it('empty (post-filter) timeline renders the no-match sentinel', function () {
      const r = formatRecall([], { limit: 10 });
      expect(r.total).to.equal(0);
      expect(r.shown).to.equal(0);
      expect(r.hasMore).to.equal(false);
      expect(r.text).to.equal('No messages found matching the filter.');
    });

    it('offset >= total renders the "nothing at offset" sentinel', function () {
      const timeline = buildTimeline(receivedFixture(3), [], false);
      const r = formatRecall(timeline, { limit: 10, offset: 5 });
      expect(r.total).to.equal(3);
      expect(r.shown).to.equal(0);
      expect(r.hasMore).to.equal(false);
      expect(r.text).to.include('No messages at offset 5. Total: 3. Use offset: 0 to start over.');
    });

    it('offset exactly at total boundary also renders the sentinel', function () {
      const timeline = buildTimeline(receivedFixture(3), [], false);
      const r = formatRecall(timeline, { limit: 10, offset: 3 });
      expect(r.shown).to.equal(0);
      expect(r.text).to.include('No messages at offset 3. Total: 3.');
    });
  });

  describe('previewLength', function () {
    it('omitted — full body rendered, no ellipsis', function () {
      const longBody = 'x'.repeat(500);
      const timeline: TimelineEntry[] = [
        {
          direction: 'received',
          from: 'a',
          text: longBody,
          timestamp: '2026-04-19T12:00:00.000Z',
          delivered: true,
        },
      ];
      const r = formatRecall(timeline);
      expect(r.text).to.include(longBody);
      expect(r.text).to.not.include('…');
    });

    it('set — truncates body with ellipsis', function () {
      const timeline: TimelineEntry[] = [
        {
          direction: 'received',
          from: 'a',
          text: 'abcdefghij',
          timestamp: '2026-04-19T12:00:00.000Z',
          delivered: true,
        },
      ];
      const r = formatRecall(timeline, { previewLength: 5 });
      expect(r.text).to.include('abcde…');
      expect(r.text).to.not.include('abcdef');
    });

    it('previewLength >= body length — no ellipsis added', function () {
      const timeline: TimelineEntry[] = [
        {
          direction: 'received',
          from: 'a',
          text: 'short',
          timestamp: '2026-04-19T12:00:00.000Z',
          delivered: true,
        },
      ];
      const r = formatRecall(timeline, { previewLength: 100 });
      expect(r.text).to.include('short');
      expect(r.text).to.not.include('…');
    });
  });

  describe('filters', function () {
    it('`from` filter applies to received only; sent entries bypass it', function () {
      const timeline = buildTimeline(
        [
          { id: '1', from: 'alice', text: 'hi', timestamp: '2026-04-19T12:00:00Z', delivered: true },
          { id: '2', from: 'carol', text: 'hey', timestamp: '2026-04-19T12:00:01Z', delivered: true },
        ],
        [
          { id: 's-1', to: 'anyone', text: 'sent msg', timestamp: '2026-04-19T12:00:02Z' },
        ],
        true,
      );
      const r = formatRecall(timeline, { from: 'alice' });
      // After filter: alice (received) + sent; carol's message was dropped.
      expect(r.total).to.equal(2);
      expect(r.text).to.include('hi');
      expect(r.text).to.not.include('hey');
      expect(r.text).to.include('sent msg');
    });

    it('`since` filter applies universally', function () {
      const timeline = buildTimeline(
        [
          { id: '1', from: 'a', text: 'old', timestamp: '2026-04-19T10:00:00Z', delivered: true },
          { id: '2', from: 'a', text: 'new', timestamp: '2026-04-19T13:00:00Z', delivered: true },
        ],
        [],
        false,
      );
      const r = formatRecall(timeline, { since: '2026-04-19T12:00:00Z' });
      expect(r.total).to.equal(1);
      expect(r.text).to.include('new');
      expect(r.text).to.not.include('old');
    });

    it('sort order is desc by timestamp (newest first)', function () {
      const timeline = buildTimeline(receivedFixture(3), [], false);
      const r = formatRecall(timeline, { limit: 10 });
      // Fixture #2 is newest; first line of rendered entries should mention #2.
      const lines = r.text.split('\n');
      const firstEntryIdx = lines.findIndex((l) => l.startsWith('['));
      expect(lines[firstEntryIdx]).to.include('2026-04-19T12:00:02.000Z');
      const secondEntryIdx = lines.findIndex((l, i) => i > firstEntryIdx && l.startsWith('['));
      expect(lines[secondEntryIdx]).to.include('2026-04-19T12:00:01.000Z');
    });
  });

  describe('render details', function () {
    it('received entry renders `← <from>` with delivered=true = no undelivered tag', function () {
      const timeline = buildTimeline(
        [{ id: '1', from: 'alice', text: 'hi', timestamp: '2026-04-19T12:00:00Z', delivered: true }],
        [],
        false,
      );
      const r = formatRecall(timeline);
      expect(r.text).to.include('← alice');
      expect(r.text).to.not.include('(undelivered)');
    });

    it('received entry with delivered=false appends `(undelivered)`', function () {
      const timeline = buildTimeline(
        [{ id: '1', from: 'alice', text: 'hi', timestamp: '2026-04-19T12:00:00Z', delivered: false }],
        [],
        false,
      );
      const r = formatRecall(timeline);
      expect(r.text).to.include('← alice (undelivered)');
    });

    it('sent entry renders `→ <to>`, never undelivered tag', function () {
      const timeline = buildTimeline([], [{ id: 's-1', to: 'bob', text: 'out', timestamp: '2026-04-19T12:00:00Z' }], true);
      const r = formatRecall(timeline);
      expect(r.text).to.include('→ bob');
      expect(r.text).to.not.include('(undelivered)');
    });
  });
});
