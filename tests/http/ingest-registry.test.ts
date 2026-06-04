/**
 * Unit tests for the ingest-token registry (src/http/ingest-registry.ts, 3c
 * Tier-2 ingest-auth). Pure — exercises mint/validate/revoke + the
 * cross-player-spoof guard. No HTTP.
 */
import { describe, it, expect } from 'vitest';
import { IngestTokenRegistry } from '../../src/http/ingest-registry';

describe('IngestTokenRegistry — mint/validate/revoke', () => {
  it('mints a token that validates for the same workflowId', () => {
    const reg = new IngestTokenRegistry();
    const token = reg.mint('wf1');
    expect(token).to.have.length.greaterThan(20);
    expect(reg.validate('wf1', token)).toBe(true);
    expect(reg.has('wf1')).toBe(true);
    expect(reg.size()).toBe(1);
  });

  it('rejects a wrong token for a known player', () => {
    const reg = new IngestTokenRegistry();
    reg.mint('wf1');
    expect(reg.validate('wf1', 'not-the-token')).toBe(false);
  });

  it('rejects any token for an unknown/unminted player', () => {
    const reg = new IngestTokenRegistry();
    expect(reg.validate('nobody', 'anything')).toBe(false);
  });

  it('CROSS-PLAYER SPOOF: player A token does not validate for player B URL', () => {
    const reg = new IngestTokenRegistry();
    const tokenA = reg.mint('wfA');
    reg.mint('wfB');
    // A presents its real token but targets B's workflowId → rejected.
    expect(reg.validate('wfB', tokenA)).toBe(false);
    // A still validates for its own.
    expect(reg.validate('wfA', tokenA)).toBe(true);
  });

  it('re-mint replaces the prior token (restart re-mints)', () => {
    const reg = new IngestTokenRegistry();
    const first = reg.mint('wf1');
    const second = reg.mint('wf1');
    expect(second).not.toBe(first);
    expect(reg.validate('wf1', first)).toBe(false);
    expect(reg.validate('wf1', second)).toBe(true);
  });

  it('mints distinct tokens per player', () => {
    const reg = new IngestTokenRegistry();
    expect(reg.mint('wf1')).not.toBe(reg.mint('wf2'));
  });

  it('revoke removes the token (detach/destroy); idempotent', () => {
    const reg = new IngestTokenRegistry();
    const token = reg.mint('wf1');
    reg.revoke('wf1');
    expect(reg.validate('wf1', token)).toBe(false);
    expect(reg.has('wf1')).toBe(false);
    expect(() => reg.revoke('wf1')).not.toThrow(); // idempotent
  });

  it('revokeAll clears every token (daemon shutdown)', () => {
    const reg = new IngestTokenRegistry();
    reg.mint('wf1');
    reg.mint('wf2');
    expect(reg.size()).toBe(2);
    reg.revokeAll();
    expect(reg.size()).toBe(0);
    expect(reg.has('wf1')).toBe(false);
  });
});
