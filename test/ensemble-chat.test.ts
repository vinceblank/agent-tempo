/**
 * Unit tests for ensemble chat logic — pagination, dedup, role assignment, truncation.
 *
 * Tests the pure logic extracted from the maestroEnsembleChat query handler
 * and fetchEnsembleChat activity, without requiring Temporal infrastructure.
 */
import { expect } from 'chai';
import type { EnsembleChatMessage, EnsembleChatResult, EnsembleChatQuery, ChatHighWater, Message, SentMessage } from '../src/types';

// ─────────────────────────────────────────────
// Pagination logic (mirrors maestroEnsembleChatQuery handler)
// ─────────────────────────────────────────────

function paginateChat(cachedChat: EnsembleChatMessage[], query: EnsembleChatQuery = {}, hasConductor = true): EnsembleChatResult {
  const { offset = 0, limit = 50 } = query;
  const clampedLimit = Math.min(limit, 200);
  const total = cachedChat.length;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - clampedLimit);
  return {
    messages: cachedChat.slice(start, end),
    total,
    hasMore: start > 0,
    hasConductor,
  };
}

function makeChat(count: number): EnsembleChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    from: `player-${i % 3}`,
    to: 'conductor',
    text: `Message ${i}`,
    timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
    role: 'maestro-in' as const,
  }));
}

describe('maestroEnsembleChat pagination', function () {

  it('returns last 50 messages by default', function () {
    const chat = makeChat(100);
    const result = paginateChat(chat);
    expect(result.messages).to.have.lengthOf(50);
    expect(result.messages[0].id).to.equal('msg-50');
    expect(result.messages[49].id).to.equal('msg-99');
    expect(result.total).to.equal(100);
    expect(result.hasMore).to.be.true;
  });

  it('returns all when fewer than limit', function () {
    const chat = makeChat(10);
    const result = paginateChat(chat);
    expect(result.messages).to.have.lengthOf(10);
    expect(result.hasMore).to.be.false;
  });

  it('returns empty for empty cache', function () {
    const result = paginateChat([]);
    expect(result.messages).to.have.lengthOf(0);
    expect(result.total).to.equal(0);
    expect(result.hasMore).to.be.false;
  });

  it('respects offset parameter', function () {
    const chat = makeChat(100);
    const result = paginateChat(chat, { offset: 20 });
    // end = 100 - 20 = 80, start = 80 - 50 = 30
    expect(result.messages).to.have.lengthOf(50);
    expect(result.messages[0].id).to.equal('msg-30');
    expect(result.messages[49].id).to.equal('msg-79');
    expect(result.hasMore).to.be.true;
  });

  it('returns empty when offset exceeds total', function () {
    const chat = makeChat(10);
    const result = paginateChat(chat, { offset: 20 });
    expect(result.messages).to.have.lengthOf(0);
    expect(result.hasMore).to.be.false;
  });

  it('clamps limit to 200', function () {
    const chat = makeChat(300);
    const result = paginateChat(chat, { limit: 500 });
    expect(result.messages).to.have.lengthOf(200);
  });

  it('hasMore is false when all messages returned', function () {
    const chat = makeChat(30);
    const result = paginateChat(chat, { limit: 50 });
    expect(result.messages).to.have.lengthOf(30);
    expect(result.hasMore).to.be.false;
  });

  it('hasMore is true when start > 0', function () {
    const chat = makeChat(100);
    const result = paginateChat(chat, { limit: 10 });
    expect(result.messages).to.have.lengthOf(10);
    expect(result.hasMore).to.be.true;
  });

  it('passes hasConductor through', function () {
    expect(paginateChat([], {}, true).hasConductor).to.be.true;
    expect(paginateChat([], {}, false).hasConductor).to.be.false;
  });

});

// ─────────────────────────────────────────────
// Role assignment + dedup + truncation logic
// (mirrors fetchEnsembleChat activity normalization)
// ─────────────────────────────────────────────

const TRUNC = 500;
const truncate = (t: string) => t.length > TRUNC ? t.slice(0, TRUNC - 1) + '...' : t;

interface NormalizeInput {
  maestroRecv: Message[];
  maestroSent: SentMessage[];
  condRecv: Message[];
  condSent: SentMessage[];
  conductorId: string;
  knownCounts: ChatHighWater;
}

function normalizeMessages(input: NormalizeInput): { newMessages: EnsembleChatMessage[]; currentCounts: ChatHighWater } {
  const { maestroRecv, maestroSent, condRecv, condSent, conductorId, knownCounts: hw } = input;

  const newMaestroRecv = maestroRecv.slice(hw.maestroRecv);
  const newMaestroSent = maestroSent.slice(hw.maestroSent);
  const newCondRecv = condRecv.slice(hw.conductorRecv);
  const newCondSent = condSent.slice(hw.conductorSent);

  const newMessages: EnsembleChatMessage[] = [];

  for (const m of newMaestroRecv) {
    newMessages.push({ id: m.id, from: m.from, to: 'maestro', text: truncate(m.text), timestamp: m.timestamp, role: 'maestro-in' });
  }
  for (const m of newMaestroSent) {
    newMessages.push({ id: m.id, from: 'maestro', to: m.to, text: truncate(m.text), timestamp: m.timestamp, role: 'maestro-out' });
  }
  for (const m of newCondRecv) {
    if (m.from === 'maestro' || m.isMaestro) continue;
    const isConductorSelfReport = m.from === conductorId;
    newMessages.push({
      id: `cond-${m.id}`,
      from: m.from,
      to: isConductorSelfReport ? 'maestro' : conductorId,
      text: truncate(m.text),
      timestamp: m.timestamp,
      role: isConductorSelfReport ? 'maestro-in' : 'conductor-in',
    });
  }
  for (const m of newCondSent) {
    if (m.to === 'maestro') continue;
    newMessages.push({ id: `cond-${m.id}`, from: conductorId, to: m.to, text: truncate(m.text), timestamp: m.timestamp, role: 'conductor-out' });
  }

  newMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    newMessages,
    currentCounts: {
      maestroRecv: maestroRecv.length,
      maestroSent: maestroSent.length,
      conductorRecv: condRecv.length,
      conductorSent: condSent.length,
    },
  };
}

function makeMsg(id: string, from: string, ts: string, text = 'hello'): Message {
  return { id, from, text, timestamp: ts, delivered: true };
}

function makeSent(id: string, to: string, ts: string, text = 'hello'): SentMessage {
  return { id, to, text, timestamp: ts };
}

describe('fetchEnsembleChat normalization', function () {

  it('assigns maestro-in role for received messages', function () {
    const result = normalizeMessages({
      maestroRecv: [makeMsg('1', 'player-a', '2026-01-01T00:00:00Z')],
      maestroSent: [],
      condRecv: [],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].role).to.equal('maestro-in');
    expect(result.newMessages[0].from).to.equal('player-a');
    expect(result.newMessages[0].to).to.equal('maestro');
  });

  it('assigns maestro-out role for sent messages', function () {
    const result = normalizeMessages({
      maestroRecv: [],
      maestroSent: [makeSent('1', 'player-b', '2026-01-01T00:00:00Z')],
      condRecv: [],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].role).to.equal('maestro-out');
    expect(result.newMessages[0].from).to.equal('maestro');
  });

  it('assigns conductor-in for conductor received from non-maestro', function () {
    const result = normalizeMessages({
      maestroRecv: [],
      maestroSent: [],
      condRecv: [makeMsg('1', 'player-c', '2026-01-01T00:00:00Z')],
      condSent: [],
      conductorId: 'my-conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].role).to.equal('conductor-in');
    expect(result.newMessages[0].to).to.equal('my-conductor');
  });

  it('re-targets conductor self-reports as maestro-in (tempo-conductor → maestro)', function () {
    // When the conductor itself calls `report`, the message lands in its own
    // `messages` array with from === conductorId. Without re-targeting it would
    // render as a confusing self-loop (conductor → conductor). Re-route it so the
    // chat shows the real audience: the maestro/operator.
    const result = normalizeMessages({
      maestroRecv: [],
      maestroSent: [],
      condRecv: [makeMsg('1', 'my-conductor', '2026-01-01T00:00:00Z', 'task done')],
      condSent: [],
      conductorId: 'my-conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].from).to.equal('my-conductor');
    expect(result.newMessages[0].to).to.equal('maestro');
    expect(result.newMessages[0].role).to.equal('maestro-in');
    expect(result.newMessages[0].id).to.equal('cond-1'); // id-prefixing preserved
  });

  it('does NOT re-target condRecv from non-conductor players (discriminator lock)', function () {
    // Negative case: the self-report discriminator must only fire for messages
    // where m.from === conductorId. A regular player → conductor message must
    // keep role: 'conductor-in' and to: conductorId, even when conductorId is set.
    const result = normalizeMessages({
      maestroRecv: [],
      maestroSent: [],
      condRecv: [makeMsg('1', 'tempo-soloist', '2026-01-01T00:00:00Z', 'progress update')],
      condSent: [],
      conductorId: 'my-conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].from).to.equal('tempo-soloist');
    expect(result.newMessages[0].to).to.equal('my-conductor');
    expect(result.newMessages[0].role).to.equal('conductor-in');
  });

  it('assigns conductor-out for conductor sent to non-maestro', function () {
    const result = normalizeMessages({
      maestroRecv: [],
      maestroSent: [],
      condRecv: [],
      condSent: [makeSent('1', 'player-d', '2026-01-01T00:00:00Z')],
      conductorId: 'my-conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].role).to.equal('conductor-out');
    expect(result.newMessages[0].from).to.equal('my-conductor');
  });

  it('deduplicates: skips conductor received from maestro', function () {
    const result = normalizeMessages({
      maestroRecv: [],
      maestroSent: [],
      condRecv: [
        makeMsg('1', 'maestro', '2026-01-01T00:00:00Z'),
        { ...makeMsg('2', 'dashboard', '2026-01-01T00:01:00Z'), isMaestro: true },
        makeMsg('3', 'player-a', '2026-01-01T00:02:00Z'),
      ],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    // Only player-a should pass through (maestro and isMaestro skipped)
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].from).to.equal('player-a');
  });

  it('deduplicates: skips conductor sent to maestro', function () {
    const result = normalizeMessages({
      maestroRecv: [],
      maestroSent: [],
      condRecv: [],
      condSent: [
        makeSent('1', 'maestro', '2026-01-01T00:00:00Z'),
        makeSent('2', 'player-a', '2026-01-01T00:01:00Z'),
      ],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(1);
    expect(result.newMessages[0].to).to.equal('player-a');
  });

  it('truncates text longer than 500 chars', function () {
    const longText = 'a'.repeat(600);
    const result = normalizeMessages({
      maestroRecv: [makeMsg('1', 'player', '2026-01-01T00:00:00Z', longText)],
      maestroSent: [],
      condRecv: [],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages[0].text).to.have.lengthOf(502); // 499 + '...'
    expect(result.newMessages[0].text).to.match(/\.\.\.$/);
  });

  it('does not truncate text at exactly 500 chars', function () {
    const exactText = 'b'.repeat(500);
    const result = normalizeMessages({
      maestroRecv: [makeMsg('1', 'player', '2026-01-01T00:00:00Z', exactText)],
      maestroSent: [],
      condRecv: [],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages[0].text).to.have.lengthOf(500);
    expect(result.newMessages[0].text).to.not.match(/\.\.\.$/);
  });

  it('delta filtering: returns only messages beyond high-water marks', function () {
    const result = normalizeMessages({
      maestroRecv: [
        makeMsg('1', 'a', '2026-01-01T00:00:00Z'),
        makeMsg('2', 'b', '2026-01-01T00:01:00Z'),
        makeMsg('3', 'c', '2026-01-01T00:02:00Z'),
      ],
      maestroSent: [
        makeSent('4', 'x', '2026-01-01T00:03:00Z'),
      ],
      condRecv: [],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 2, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    // maestroRecv: skip first 2, get msg-3. maestroSent: all new (1).
    expect(result.newMessages).to.have.lengthOf(2);
    expect(result.newMessages[0].from).to.equal('c'); // maestro-in
    expect(result.newMessages[1].from).to.equal('maestro'); // maestro-out
  });

  it('delta: returns empty when no new messages', function () {
    const result = normalizeMessages({
      maestroRecv: [makeMsg('1', 'a', '2026-01-01T00:00:00Z')],
      maestroSent: [makeSent('2', 'b', '2026-01-01T00:01:00Z')],
      condRecv: [],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 1, maestroSent: 1, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages).to.have.lengthOf(0);
  });

  it('updates currentCounts to total lengths', function () {
    const result = normalizeMessages({
      maestroRecv: [makeMsg('1', 'a', ''), makeMsg('2', 'b', '')],
      maestroSent: [makeSent('3', 'c', '')],
      condRecv: [makeMsg('4', 'x', '')],
      condSent: [],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.currentCounts).to.deep.equal({
      maestroRecv: 2,
      maestroSent: 1,
      conductorRecv: 1,
      conductorSent: 0,
    });
  });

  it('sorts new messages by timestamp', function () {
    const result = normalizeMessages({
      maestroRecv: [makeMsg('1', 'late', '2026-01-01T00:05:00Z')],
      maestroSent: [makeSent('2', 'early', '2026-01-01T00:01:00Z')],
      condRecv: [],
      condSent: [makeSent('3', 'middle', '2026-01-01T00:03:00Z')],
      conductorId: 'conductor',
      knownCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
    });
    expect(result.newMessages[0].timestamp).to.equal('2026-01-01T00:01:00Z');
    expect(result.newMessages[1].timestamp).to.equal('2026-01-01T00:03:00Z');
    expect(result.newMessages[2].timestamp).to.equal('2026-01-01T00:05:00Z');
  });

});
