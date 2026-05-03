/**
 * Unit tests for the stream-json frame parser. Exercises the §11.1
 * spike-fixture corpus + synthesized edge cases against `applyFrame`
 * and `StreamJsonReader`.
 *
 * Issue #520 PR-3.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  applyFrame,
  newTurnAccumulator,
  StreamJsonReader,
  type StreamJsonFrame,
} from '../../../src/adapters/claude-code-headless/stream-json';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'claude-code-headless');

function readFixtureFrames(name: string): StreamJsonFrame[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as StreamJsonFrame);
}

describe('applyFrame — happy path (success-simple.jsonl)', () => {
  it('accumulates result.result as canonical assembled text', () => {
    const frames = readFixtureFrames('success-simple.jsonl');
    let state = newTurnAccumulator();
    for (const f of frames) state = applyFrame(state, f);
    // The fixture's result frame says "PINEAPPLE"
    expect(state.assembledText).toBe('PINEAPPLE');
    expect(state.resultFrameSeen).toBe(true);
    expect(state.resultIsError).toBe(false);
    expect(state.stopReason).toBe('end_turn');
  });

  it('captures total_cost_usd from result frame (subscription-billing also reports cost)', () => {
    const frames = readFixtureFrames('success-simple.jsonl');
    let state = newTurnAccumulator();
    for (const f of frames) state = applyFrame(state, f);
    expect(state.totalCostUsd).toBeGreaterThan(0);
  });

  it('captures init telemetry — apiKeySource + model', () => {
    const frames = readFixtureFrames('success-simple.jsonl');
    let state = newTurnAccumulator();
    for (const f of frames) state = applyFrame(state, f);
    expect(state.initApiKeySource).toBe('none');
    expect(state.initModel).toBeTruthy();
  });

  it('appends informational rate_limit_event for telemetry (NOT a classifier input)', () => {
    const frames = readFixtureFrames('success-simple.jsonl');
    let state = newTurnAccumulator();
    for (const f of frames) state = applyFrame(state, f);
    // success-simple has one informational rate_limit_event; the parser
    // collects it but the classifier ignores `status: 'allowed'` per
    // architect Constraint #1.
    expect(state.rateLimitEvents.length).toBeGreaterThan(0);
    expect(state.rateLimitEvents[0].rate_limit_info?.status).toBe('allowed');
  });
});

describe('applyFrame — tool-use round trip (tool-use-bash.jsonl)', () => {
  it('still resolves result.result as canonical text after a tool round-trip', () => {
    const frames = readFixtureFrames('tool-use-bash.jsonl');
    let state = newTurnAccumulator();
    for (const f of frames) state = applyFrame(state, f);
    // The captured fixture's final text mentions HELLO_FROM_BASH or similar.
    expect(state.assembledText.length).toBeGreaterThan(0);
    expect(state.resultFrameSeen).toBe(true);
    expect(state.resultIsError).toBe(false);
  });

  it('filters thinking + tool_use blocks from assistant-frame text fallback', () => {
    // Construct an assistant-only sequence (no result frame) to exercise
    // the fallback accumulator. Thinking + tool_use blocks must be
    // skipped — only text blocks contribute.
    let state = newTurnAccumulator();
    state = applyFrame(state, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'inner thoughts I should not see' },
          { type: 'text', text: 'visible reply ' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: 'continued.' },
        ],
      },
    });
    expect(state.assembledText).toBe('visible reply continued.');
  });
});

describe('applyFrame — hook + status frames are ignored (Delta #2)', () => {
  it('ignores synthetic hook + status frames without throwing', () => {
    const frames = readFixtureFrames('hook-frames.jsonl');
    let state = newTurnAccumulator();
    for (const f of frames) state = applyFrame(state, f);
    // No textual content; no classifier inputs touched.
    expect(state.assembledText).toBe('');
    expect(state.apiRetryEvents).toHaveLength(0);
    expect(state.rateLimitEvents).toHaveLength(0);
    expect(state.pluginErrors).toHaveLength(0);
  });
});

describe('applyFrame — api_retry frames feed the classifier accumulator', () => {
  it('appends synthesized api_retry event from fixture', () => {
    const frames = readFixtureFrames('api-retry-rate-limit.jsonl');
    let state = newTurnAccumulator();
    for (const f of frames) state = applyFrame(state, f);
    expect(state.apiRetryEvents.length).toBe(2);
    expect(state.apiRetryEvents[0].error).toBe('rate_limit');
  });
});

describe('applyFrame — unknown frame types pass through silently', () => {
  it('does not throw on a future frame type', () => {
    let state = newTurnAccumulator();
    expect(() => {
      state = applyFrame(state, { type: 'something_new_in_v3' } as StreamJsonFrame);
    }).not.toThrow();
    expect(state.assembledText).toBe('');
  });

  it('does not throw on system/<unknown subtype>', () => {
    let state = newTurnAccumulator();
    expect(() => {
      state = applyFrame(state, { type: 'system', subtype: 'tomorrows_subtype' } as StreamJsonFrame);
    }).not.toThrow();
  });
});

describe('StreamJsonReader — line-buffered reader', () => {
  it('parses one line per chunk', () => {
    const reader = new StreamJsonReader();
    const frames = readFixtureFrames('success-simple.jsonl');
    for (const f of frames) {
      reader.feed(JSON.stringify(f) + '\n');
    }
    const state = reader.snapshot();
    expect(state.assembledText).toBe('PINEAPPLE');
  });

  it('handles split chunks (line spread across multiple feed calls)', () => {
    const reader = new StreamJsonReader();
    const fullLine = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-7', apiKeySource: 'none' }) + '\n';
    const half = Math.floor(fullLine.length / 2);
    reader.feed(fullLine.slice(0, half));
    expect(reader.snapshot().initModel).toBeNull();  // not yet
    reader.feed(fullLine.slice(half));
    expect(reader.snapshot().initModel).toBe('claude-opus-4-7');
  });

  it('flush() processes a trailing partial line without newline', () => {
    const reader = new StreamJsonReader();
    const partial = JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' });
    reader.feed(partial);  // no trailing newline
    expect(reader.snapshot().initApiKeySource).toBeNull();
    reader.flush();
    expect(reader.snapshot().initApiKeySource).toBe('none');
  });

  it('skips malformed JSON via onParseError callback (does not throw)', () => {
    const errors: Array<{ line: string; msg: string }> = [];
    const reader = new StreamJsonReader({
      onParseError: (line, err) => errors.push({ line, msg: err.message }),
    });
    reader.feed('this is not json\n' + JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }) + '\n');
    expect(errors.length).toBe(1);
    expect(errors[0].line).toBe('this is not json');
    // Subsequent valid line still parses.
    expect(reader.snapshot().initApiKeySource).toBe('none');
  });

  it('rejects frames missing the required `type` field', () => {
    const errors: Array<{ line: string; msg: string }> = [];
    const reader = new StreamJsonReader({
      onParseError: (line, err) => errors.push({ line, msg: err.message }),
    });
    reader.feed('{"foo":"bar"}\n');
    expect(errors.length).toBe(1);
    expect(errors[0].msg).toMatch(/type/);
  });
});
