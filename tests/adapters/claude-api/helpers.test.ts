/**
 * Pure-helper unit tests for the claude-api adapter (#131 PR-5).
 *
 * `buildAnthropicMessages` and `handleStreamEvent` are the two no-side-effect
 * functions inside `DirectApiAttachment` that benefit most from unit
 * coverage: they encode the verification-addendum landmines (chronological
 * ordering, role folding, deferred input_json_delta parse, thinking-block
 * signature accumulation) that are easy to regress accidentally and hard
 * to debug live against the Anthropic API.
 *
 * The full lifecycle test (spawn → claim → turn → detach against a mocked
 * @anthropic-ai/sdk) is the next-tier coverage; tracked as a follow-up
 * because it requires TestWorkflowEnvironment + an SDK mock harness that
 * the existing test/ adapter suites don't yet share.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAnthropicMessages,
  handleStreamEvent,
} from '../../../src/adapters/claude-api/adapter';
import type { Message as TempoMessage, SentMessage } from '../../../src/types';

function msg(over: Partial<TempoMessage> & { id: string; from: string; text: string; timestamp: string }): TempoMessage {
  return { delivered: true, ...over } as TempoMessage;
}
function sent(over: { id: string; to: string; text: string; timestamp: string }): SentMessage {
  return over;
}

describe('buildAnthropicMessages — conversation rebuild', () => {
  it('returns empty array for empty input', () => {
    expect(buildAnthropicMessages([], [])).toEqual([]);
  });

  it('tags received as user, sent as assistant, sorts chronologically', () => {
    const out = buildAnthropicMessages(
      [msg({ id: 'r1', from: 'alice', text: 'hello', timestamp: '2026-04-28T12:00:00Z' })],
      [sent({ id: 's1', to: 'alice', text: 'hi back', timestamp: '2026-04-28T12:01:00Z' })],
    );
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toContain('alice');
    expect(out[0].content).toContain('hello');
    expect(out[1].role).toBe('assistant');
    expect(out[1].content).toBe('hi back');
  });

  it('folds consecutive same-role rows into one message (alternation invariant)', () => {
    // Two cues stack into the player's queue before they respond — must
    // collapse to a single user turn or Anthropic's API rejects the
    // alternation-violation.
    const out = buildAnthropicMessages(
      [
        msg({ id: 'r1', from: 'alice', text: 'one', timestamp: '2026-04-28T12:00:00Z' }),
        msg({ id: 'r2', from: 'bob', text: 'two', timestamp: '2026-04-28T12:00:01Z' }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toContain('alice');
    expect(out[0].content).toContain('bob');
    expect(out[0].content).toContain('one');
    expect(out[0].content).toContain('two');
  });

  it('interleaves sent + received chronologically by timestamp', () => {
    const out = buildAnthropicMessages(
      [
        msg({ id: 'r1', from: 'alice', text: 'q1', timestamp: '2026-04-28T12:00:00Z' }),
        msg({ id: 'r2', from: 'alice', text: 'q2', timestamp: '2026-04-28T12:02:00Z' }),
      ],
      [
        sent({ id: 's1', to: 'alice', text: 'a1', timestamp: '2026-04-28T12:01:00Z' }),
      ],
    );
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('tags each user-side row with [from <name>] for multi-player disambiguation', () => {
    const out = buildAnthropicMessages(
      [msg({ id: 'r1', from: 'tempo-eng', text: 'status?', timestamp: '2026-04-28T12:00:00Z' })],
      [],
    );
    expect(out[0].content).toMatch(/\[from tempo-eng\]/);
  });
});

describe('handleStreamEvent — Anthropic stream consumer', () => {
  it('initializes a text block on content_block_start type=text', () => {
    const blocks: any[] = [];
    handleStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, blocks);
    expect(blocks[0]).toEqual({ type: 'text', text: '' });
  });

  it('accumulates text_delta chunks onto the current text block', () => {
    const blocks: any[] = [];
    handleStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }, blocks);
    expect(blocks[0].text).toBe('hello world');
  });

  it('initializes a tool_use block with empty input string (verification §2.4)', () => {
    const blocks: any[] = [];
    handleStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'cue' } }, blocks);
    expect(blocks[0]).toEqual({ type: 'tool_use', id: 't1', name: 'cue', input: '' });
  });

  it('accumulates input_json_delta as a STRING — does not parse mid-stream (verification §2.4)', () => {
    const blocks: any[] = [];
    handleStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'cue' } }, blocks);
    // Three fragmentary chunks — none is parseable JSON on its own.
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"playerId":"' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'tempo-' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'eng","message":"hi"}' } }, blocks);
    expect(typeof blocks[0].input).toBe('string');
    expect(blocks[0].input).toBe('{"playerId":"tempo-eng","message":"hi"}');
    // Caller (the dispatch loop) is the one that JSON.parses — the helper
    // must not.
    expect(() => JSON.parse(blocks[0].input)).not.toThrow();
  });

  it('preserves thinking blocks + accumulates signature deltas (verification §2.1)', () => {
    const blocks: any[] = [];
    handleStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning step 1' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-pa' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'rt-2' } }, blocks);
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'reasoning step 1', signature: 'sig-part-2' });
  });

  it('handles interleaved blocks at different indices (thinking → tool_use)', () => {
    const blocks: any[] = [];
    handleStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }, blocks);
    handleStreamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'cue' } }, blocks);
    handleStreamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }, blocks);
    expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'plan' });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', name: 'cue', input: '{}' });
  });

  it('silently ignores delta with no matching block (defensive — out-of-order events)', () => {
    const blocks: any[] = [];
    // No start event for index 0 — the delta should be a no-op, not a crash.
    expect(() =>
      handleStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } }, blocks),
    ).not.toThrow();
    expect(blocks.length).toBe(0);
  });
});
