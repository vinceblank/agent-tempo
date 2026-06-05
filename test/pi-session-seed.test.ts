/**
 * Unit + regression tests for the Pi session-seed chokepoint
 * (src/pi/session-seed.ts, H1 / #645).
 *
 * THE LOAD-BEARING GUARD: Pi's `SessionManager.appendMessage` never validates
 * `content` — every malformed shape appends "ok"; the throw ("content is not
 * iterable") fires only at CONSUMPTION (Pi 0.78 `agent-session.js:2486` context
 * build / `:2493` `getLastAssistantText` — `for (const c of msg.content)`). So
 * seed-time sanitization is the only lever agent-tempo controls.
 *
 * The 6-shape fixture matrix below is a PERMANENT regression set, empirically
 * confirmed against real Pi 0.78.0 by tempo-researcher's hermetic PoC and
 * comment-linked to the crash sites — a future Pi SDK bump that changes the
 * content contract should trip THIS test instead of silently drifting.
 *
 * Pure module → no Pi SDK needed; `seedSessionManager` is exercised with a fake
 * recording SessionManager (mirrors buildPiResourceLoaderOptions' SDK-free test).
 */
import { expect } from 'chai';
import {
  sanitizeTranscriptEntry,
  seedSessionManager,
  type SeedableSessionManager,
  type TranscriptEntry,
} from '../src/pi/session-seed';

/** An assistant entry carrying arbitrary `content` (the crash-bearing field). */
const asst = (content: unknown): Record<string, unknown> => ({
  role: 'assistant',
  content,
  provider: 'anthropic',
  model: 'm',
  stopReason: 'end_turn',
  timestamp: 2000,
});

/** Pi 0.78 fixture matrix — content shape → KEEP/DROP (comment-linked to the crash). */
const KEEP: ReadonlyArray<readonly [string, unknown]> = [
  ['string', 'hello'],
  ['array(text)', [{ type: 'text', text: 'hi' }]],
];
const DROP: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['object', {}],
  ['number', 42],
];

describe('session-seed — sanitizeTranscriptEntry (Pi 0.78 content-shape guard)', () => {
  for (const [label, content] of KEEP) {
    it(`KEEPS well-shaped content: ${label}`, () => {
      const out = sanitizeTranscriptEntry(asst(content));
      expect(out, label).to.not.equal(null);
      expect((out as TranscriptEntry).content).to.equal(content); // unchanged (no coerce)
    });
  }

  for (const [label, content] of DROP) {
    it(`DROPS malformed content: ${label}`, () => {
      // DROP is the architect's ruled default; non-iterable content throws at
      // consumption (agent-session.js:2493), so it must never reach the session.
      expect(sanitizeTranscriptEntry(asst(content)), label).to.equal(null);
    });
  }

  it('predicate boundary is exactly {string, array}', () => {
    const isWellShaped = (c: unknown): boolean => typeof c === 'string' || Array.isArray(c);
    for (const [label, c] of KEEP) expect(isWellShaped(c), label).to.equal(true);
    for (const [label, c] of DROP) expect(isWellShaped(c), label).to.equal(false);
  });

  it('accepts every appendMessage role (Message | CustomMessage | BashExecutionMessage)', () => {
    for (const role of ['user', 'assistant', 'toolResult', 'bashExecution', 'custom']) {
      expect(sanitizeTranscriptEntry({ role, content: 'ok' }), role).to.not.equal(null);
    }
  });

  it('DROPS entries with an unrecognized or missing role', () => {
    expect(sanitizeTranscriptEntry({ role: 'wat', content: 'ok' }), 'unknown role').to.equal(null);
    expect(sanitizeTranscriptEntry({ content: 'ok' }), 'no role').to.equal(null);
    expect(sanitizeTranscriptEntry({ role: 42, content: 'ok' }), 'non-string role').to.equal(null);
  });

  it('DROPS non-object inputs', () => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      expect(sanitizeTranscriptEntry(bad as unknown), String(bad)).to.equal(null);
    }
  });
});

describe('session-seed — seedSessionManager (single appendMessage chokepoint)', () => {
  /** Fake SessionManager that records every appended message. */
  const recordingSm = (): SeedableSessionManager & { appended: TranscriptEntry[] } => {
    const appended: TranscriptEntry[] = [];
    return {
      appended,
      appendMessage(message: TranscriptEntry): unknown {
        appended.push(message);
        return 'id';
      },
    };
  };

  it('is a no-op for an empty/undefined/null transcript (fresh recruit — H1 case)', () => {
    for (const empty of [undefined, null, []]) {
      const sm = recordingSm();
      expect(seedSessionManager(sm, empty as readonly unknown[] | null | undefined)).to.equal(0);
      expect(sm.appended).to.have.length(0);
    }
  });

  it('appends only survivors, in order, and never touches appendMessage for dropped entries', () => {
    const sm = recordingSm();
    const transcript = [
      asst('keep-1'),
      asst(null), // DROP
      { role: 'user', content: 'keep-2' },
      asst(42), // DROP
      { role: 'assistant', content: [{ type: 'text', text: 'keep-3' }] },
    ];
    const appended = seedSessionManager(sm, transcript);
    expect(appended).to.equal(3);
    expect(sm.appended.map((m) => m.content)).to.deep.equal([
      'keep-1',
      'keep-2',
      [{ type: 'text', text: 'keep-3' }],
    ]);
  });

  it('drops the whole transcript when every entry is malformed (crash-proof by construction)', () => {
    const sm = recordingSm();
    const appended = seedSessionManager(sm, DROP.map(([, c]) => asst(c)));
    expect(appended).to.equal(0);
    expect(sm.appended).to.have.length(0);
  });
});
