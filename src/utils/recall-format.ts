/**
 * Shared recall formatter (#128).
 *
 * Single source of truth for how the MCP `recall` tool, TUI `/recall` slash
 * command, and CLI `agent-tempo recall` present a timeline. Pure — no
 * Temporal, no stdout, no I/O — so each surface can unit-test its rendering
 * with canned data.
 *
 * Execution order (established by the #128 design):
 *   query → filter (`since`, `from`) → sort desc by timestamp → compute
 *   total → slice [offset, offset+limit) → conditionally truncate bodies
 *   by `previewLength` → emit pagination header.
 *
 * `previewLength` is unset by default (no sane ceiling). Callers opt in to
 * truncation; the prior hardcoded 200-char cap at the MCP tool is retired
 * from the recall path (the shared constant stays elsewhere).
 */
import type { Message, SentMessage } from '../types';

export interface TimelineEntry {
  direction: 'received' | 'sent';
  /** Sender player name for received entries; undefined for sent. */
  from?: string;
  /** Recipient player name for sent entries; undefined for received. */
  to?: string;
  text: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Only set on received entries. */
  delivered?: boolean;
}

export interface RecallFormatOpts {
  /** Max entries per page. Defaults to 20; schema enforces 1-100 upstream. */
  limit?: number;
  /** Skip N entries for paging. Defaults to 0. */
  offset?: number;
  /**
   * Truncate each entry body to this many characters + `…`. Omitted =
   * unlimited (full body). Schema upstream enforces `min(1)`.
   */
  previewLength?: number;
  /** ISO timestamp — only entries at or after this are included. */
  since?: string;
  /** Sender filter — only applied to received entries. */
  from?: string;
}

/**
 * Build the flat, unfiltered, unsorted timeline from a session's raw query
 * results. Mirrors the shape the MCP tool used inline before #128.
 *
 * `includeSent === false` drops the sent-messages lane entirely rather than
 * tagging them `direction: 'sent'`, matching the existing MCP semantics.
 */
export function buildTimeline(
  received: Message[],
  sent: SentMessage[],
  includeSent: boolean,
): TimelineEntry[] {
  const timeline: TimelineEntry[] = received.map((m) => ({
    direction: 'received' as const,
    from: m.from,
    text: m.text,
    timestamp: m.timestamp,
    delivered: m.delivered,
  }));
  if (includeSent) {
    for (const s of sent) {
      timeline.push({
        direction: 'sent',
        to: s.to,
        text: s.text,
        timestamp: s.timestamp,
      });
    }
  }
  return timeline;
}

export interface RecallRenderResult {
  /** Final rendered lines (header + entries, joined with blank lines between entries). */
  text: string;
  /** Post-filter total (before offset/limit). Useful for callers needing raw counts. */
  total: number;
  /** Number of entries actually rendered (≤ limit). */
  shown: number;
  /** `true` iff pagination would continue past `offset + limit`. */
  hasMore: boolean;
}

/**
 * Filter → sort → slice → render pipeline per the #128 design. Returns a
 * single formatted string (plus counts for callers that want to branch on
 * pagination state without re-scanning the rendered text).
 *
 * Header convention (matches `gh pr list` / `gh issue list`):
 *   `Showing X-Y of Z messages.`
 * Append `Use offset: N for next page.` only when total > offset + limit.
 *
 * Edge cases:
 *   - empty (post-filter) → `No messages found matching the filter.`
 *   - offset ≥ total (non-empty) → `No messages at offset N. Total: Z. Use offset: 0 to start over.`
 *   - `previewLength > text.length` → full body, no ellipsis
 */
export function formatRecall(
  timeline: TimelineEntry[],
  opts: RecallFormatOpts = {},
): RecallRenderResult {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  // ── 1. Filter ──
  let filtered = timeline;
  if (opts.since !== undefined) {
    const sinceTs = Date.parse(opts.since);
    if (!Number.isNaN(sinceTs)) {
      filtered = filtered.filter((e) => Date.parse(e.timestamp) >= sinceTs);
    }
  }
  if (opts.from) {
    filtered = filtered.filter((e) => (e.direction === 'received' ? e.from === opts.from : true));
  }

  // ── 2. Sort desc by timestamp ──
  filtered = [...filtered].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  // ── 3. Compute total (post-filter) ──
  const total = filtered.length;

  // ── Early-return paths ──
  if (total === 0) {
    return {
      text: 'No messages found matching the filter.',
      total: 0,
      shown: 0,
      hasMore: false,
    };
  }
  if (offset >= total) {
    return {
      text: `No messages at offset ${offset}. Total: ${total}. Use offset: 0 to start over.`,
      total,
      shown: 0,
      hasMore: false,
    };
  }

  // ── 4. Slice [offset, offset+limit) ──
  const page = filtered.slice(offset, offset + limit);

  // ── 5. Render ──
  const renderedEntries = page.map((e) => renderEntry(e, opts.previewLength));
  const startIdx = offset + 1;
  const endIdx = offset + page.length;
  const hasMore = total > offset + limit;
  const headerLines = [`Showing ${startIdx}-${endIdx} of ${total} messages.`];
  if (hasMore) headerLines.push(`Use offset: ${offset + limit} for next page.`);

  return {
    text: [headerLines.join(' '), '', ...renderedEntries].join('\n'),
    total,
    shown: page.length,
    hasMore,
  };
}

function renderEntry(e: TimelineEntry, previewLength?: number): string {
  const dir = e.direction === 'sent' ? `→ ${e.to}` : `← ${e.from}`;
  const status = e.direction === 'received' && e.delivered === false ? ' (undelivered)' : '';
  const body = previewLength !== undefined && e.text.length > previewLength
    ? `${e.text.slice(0, previewLength)}…`
    : e.text;
  return `[${e.timestamp}] ${dir}${status}\n  ${body}`;
}
