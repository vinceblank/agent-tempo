/**
 * AdapterRegistry unit tests — descriptor validation + lookup.
 *
 * Covers the registry surface introduced in PR-B (`src/adapters/base.ts`):
 * register / get / has / all / resolveFromAgentType. Also asserts that the
 * shipped descriptors (`claude-code`, `copilot`, `claude-api`) match the
 * fields designed in §4.2–4.3 — `adapterId`, `adapterClass`,
 * `blocksOnLLMTurn`, `heartbeatMs`.
 *
 * Addresses PR-B QA finding **C2** ("no registry unit tests"). The descriptor-
 * validation layer architect-2 named as the implicit +1 on §4.5 lives here.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §4.2, §4.3.
 * Sequencing memo: §3 PR-G.
 */
import { expect } from 'chai';
import { AdapterRegistry } from '../../src/adapters/base';
import { registry } from '../../src/adapters';
import type { AdapterDescriptor } from '../../src/types';

/** Build a valid descriptor for use in lookup tests. Override individual fields as needed. */
function makeDescriptor(overrides: Partial<AdapterDescriptor> = {}): AdapterDescriptor {
  return {
    adapterId: 'test-adapter',
    adapterClass: 'interactive',
    blocksOnLLMTurn: false,
    heartbeatMs: 60_000,
    ...overrides,
  };
}

describe('AdapterRegistry', function () {
  describe('register + get', function () {
    it('registers and retrieves a descriptor by id', function () {
      const r = new AdapterRegistry();
      const desc = makeDescriptor({ adapterId: 'a1' });
      r.register(desc);
      expect(r.get('a1')).to.equal(desc);
    });

    it('register() replaces an existing entry with the same id (last write wins)', function () {
      const r = new AdapterRegistry();
      const first = makeDescriptor({ adapterId: 'dup', heartbeatMs: 10_000 });
      const second = makeDescriptor({ adapterId: 'dup', heartbeatMs: 20_000 });
      r.register(first);
      r.register(second);
      expect(r.get('dup').heartbeatMs).to.equal(20_000);
    });

    it('get() throws on an unregistered id with a listing of known ids in the message', function () {
      const r = new AdapterRegistry();
      r.register(makeDescriptor({ adapterId: 'known-a' }));
      r.register(makeDescriptor({ adapterId: 'known-b' }));
      expect(() => r.get('ghost')).to.throw(/Unknown adapter "ghost"/);
      expect(() => r.get('ghost')).to.throw(/known-a/);
      expect(() => r.get('ghost')).to.throw(/known-b/);
    });

    it('get() error message explicitly says "(none registered)" when registry is empty', function () {
      const r = new AdapterRegistry();
      expect(() => r.get('anything')).to.throw(/none registered/);
    });
  });

  describe('has', function () {
    it('returns true for a registered id', function () {
      const r = new AdapterRegistry();
      r.register(makeDescriptor({ adapterId: 'present' }));
      expect(r.has('present')).to.equal(true);
    });

    it('returns false for an unregistered id', function () {
      const r = new AdapterRegistry();
      expect(r.has('absent')).to.equal(false);
    });
  });

  describe('all', function () {
    it('returns an empty array when nothing is registered', function () {
      const r = new AdapterRegistry();
      expect(r.all()).to.deep.equal([]);
    });

    it('returns every registered descriptor exactly once', function () {
      const r = new AdapterRegistry();
      const d1 = makeDescriptor({ adapterId: 'x' });
      const d2 = makeDescriptor({ adapterId: 'y' });
      r.register(d1);
      r.register(d2);
      const all = r.all();
      expect(all).to.have.lengthOf(2);
      expect(all).to.include(d1);
      expect(all).to.include(d2);
    });

    it('does not return duplicates when an id is re-registered', function () {
      const r = new AdapterRegistry();
      r.register(makeDescriptor({ adapterId: 'solo', heartbeatMs: 10_000 }));
      r.register(makeDescriptor({ adapterId: 'solo', heartbeatMs: 30_000 }));
      const all = r.all();
      expect(all).to.have.lengthOf(1);
      expect(all[0].heartbeatMs).to.equal(30_000);
    });
  });

  describe('resolveFromAgentType (legacy AgentType → adapterId mapping)', function () {
    it('maps "claude" → "claude-code"', function () {
      const r = new AdapterRegistry();
      expect(r.resolveFromAgentType('claude')).to.equal('claude-code');
    });

    it('maps "copilot" → "copilot"', function () {
      const r = new AdapterRegistry();
      expect(r.resolveFromAgentType('copilot')).to.equal('copilot');
    });

    it('defaults undefined → "claude-code" (pre-v0.25 sessions with no agentType)', function () {
      const r = new AdapterRegistry();
      expect(r.resolveFromAgentType(undefined)).to.equal('claude-code');
    });

    it('defaults unrecognized values → "claude-code" (safe fallback for open-set agents)', function () {
      // PR-D opens AgentType up to a string bounded by the registry; this safe fallback
      // prevents a broken recruit from crashing the dispatch path before PR-D's
      // registry-based validation lands.
      const r = new AdapterRegistry();
      expect(r.resolveFromAgentType('future-adapter')).to.equal('claude-code');
    });
  });
});

describe('shipped descriptors (registry singleton)', function () {
  it('claude-code is registered and matches the §4.3 interactive shape', function () {
    expect(registry.has('claude-code')).to.equal(true);
    const desc = registry.get('claude-code');
    expect(desc.adapterId).to.equal('claude-code');
    expect(desc.adapterClass).to.equal('interactive');
    expect(desc.blocksOnLLMTurn).to.equal(false);
    // Interactive class — 60s cadence per design §4.3.
    expect(desc.heartbeatMs).to.equal(60_000);
  });

  it('copilot is registered and matches the §4.3 sdk shape', function () {
    expect(registry.has('copilot')).to.equal(true);
    const desc = registry.get('copilot');
    expect(desc.adapterId).to.equal('copilot');
    expect(desc.adapterClass).to.equal('sdk');
    expect(desc.blocksOnLLMTurn).to.equal(true);
    // SDK class — 30s cadence per design §4.3.
    expect(desc.heartbeatMs).to.equal(30_000);
  });

  it('claude-api is registered and matches the §4.3 sdk shape (#131 Phase C)', function () {
    expect(registry.has('claude-api')).to.equal(true);
    const desc = registry.get('claude-api');
    expect(desc.adapterId).to.equal('claude-api');
    expect(desc.adapterClass).to.equal('sdk');
    expect(desc.blocksOnLLMTurn).to.equal(true);
    // SDK class — 30s cadence per design §4.3.
    expect(desc.heartbeatMs).to.equal(30_000);
  });

  it('registry.all() contains exactly the three shipped descriptors', function () {
    // Will break deliberately when a fourth production adapter ships — forces
    // a conscious acknowledgment in the same commit that registers it.
    // (Mock adapter is dev-mode-only and prepack-stripped; not in this list.)
    // #131 Phase C added `claude-api` as the third production adapter.
    const ids = registry.all().map((d) => d.adapterId).sort();
    expect(ids).to.deep.equal(['claude-api', 'claude-code', 'copilot']);
  });

  it('every shipped descriptor has a plausible heartbeatMs in range [10s, 300s]', function () {
    for (const desc of registry.all()) {
      expect(desc.heartbeatMs).to.be.gte(10_000,
        `${desc.adapterId}: heartbeatMs too aggressive — workflow lease is 90s by default, heartbeats below 10s spam the history`);
      expect(desc.heartbeatMs).to.be.lte(300_000,
        `${desc.adapterId}: heartbeatMs too lax — workflow expires the lease at 3× heartbeatMs (§4.3), values above 5min leave sessions unreachable too long`);
    }
  });

  it('SDK-class adapters must have blocksOnLLMTurn=true; interactive must have false', function () {
    // Captures the §4.4 invariant: push/deliver doesn't block on LLM turn;
    // pull/sendAndWait does. In PR-G the invariant is only strict for these two
    // shipped classes — future descriptor schema versions may loosen it (e.g.
    // interactive SDK hybrids); revisit here rather than silently accepting drift.
    for (const desc of registry.all()) {
      if (desc.adapterClass === 'sdk') {
        expect(desc.blocksOnLLMTurn).to.equal(true,
          `${desc.adapterId}: sdk-class adapters block on LLM turn by definition`);
      } else if (desc.adapterClass === 'interactive') {
        expect(desc.blocksOnLLMTurn).to.equal(false,
          `${desc.adapterId}: interactive-class adapters deliver push (MCP notification), no LLM-turn block`);
      }
    }
  });
});
