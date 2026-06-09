/**
 * Unit tests for the #53 cue-delivery consolidation helper
 * (`src/utils/cue-format.ts`). Pure — no adapter / Pi SDK needed.
 *
 * NOTE (#53): the exact header punctuation + the `from` label are pending a
 * product confirm (vinceblank). These assertions encode the CURRENT proposed
 * format (`[Q <id> · from <from>]`); finalizing the label is a one-line change
 * in the helper + the matching expectations here.
 */
import { describe, it, expect } from 'vitest';
import { consolidateQuestionCue } from '../../src/utils/cue-format';
import { buildAskCue } from '../../src/http/qa';

describe('consolidateQuestionCue (#53)', () => {
  it('consolidates a real buildAskCue question into a SINGLE header (no doubled prefix)', () => {
    const body = buildAskCue('q-abc123', 'What is the deploy status?');
    const out = consolidateQuestionCue('maestro', body);
    expect(out).not.toBeNull();
    expect(out!.startsWith('[Q q-abc123 · from maestro]\n')).toBe(true);
    // The adapter "from" envelope is GONE — no doubled / back-to-back brackets.
    expect(out).not.toContain('[cue from');
    expect(out).not.toContain('] [Q ');
    // questionId stays for respond-correlation (header AND the respond instruction).
    expect(out).toContain('respond({ questionId: "q-abc123"');
    // The question text survives below the header.
    expect(out).toContain('What is the deploy status?');
  });

  it('returns null for a normal (non-question) cue → caller keeps its per-adapter envelope', () => {
    expect(consolidateQuestionCue('alice', 'hey can you check the build?')).toBeNull();
    expect(consolidateQuestionCue('alice', 'see the [Q] section of the doc')).toBeNull(); // not a LEADING marker
  });

  it('falls back to "planner" when `from` is missing/empty', () => {
    expect(consolidateQuestionCue(undefined, '[Q q1] hello')).toBe('[Q q1 · from planner]\nhello');
    expect(consolidateQuestionCue('', '[Q q1] hello')).toBe('[Q q1 · from planner]\nhello');
  });

  it('only consolidates a VALID questionId marker (rejects malformed / empty ids)', () => {
    expect(consolidateQuestionCue('m', '[Q good_id-1] body')).toBe('[Q good_id-1 · from m]\nbody');
    expect(consolidateQuestionCue('m', '[Q bad!id] body')).toBeNull(); // '!' fails QUESTION_ID_REGEX
    expect(consolidateQuestionCue('m', '[Q ] body')).toBeNull(); // empty id
  });

  it('preserves a multi-line body verbatim below the single header', () => {
    expect(consolidateQuestionCue('maestro', '[Q q1] line one\n\nline two\nline three')).toBe(
      '[Q q1 · from maestro]\nline one\n\nline two\nline three',
    );
  });
});
