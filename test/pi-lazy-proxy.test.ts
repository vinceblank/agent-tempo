/**
 * Unit tests for the D11 lazy-resolution proxy (src/pi/lazy-proxy.ts).
 *
 * The proxy lets the Pi extension register the full tool surface ONCE at load
 * while each tool handler resolves the CURRENT Temporal client / session handle
 * per call (re-acquired across continueAsNew / reconnect; cleanly absent before
 * a session attaches). Pure — no Temporal, no Pi.
 */
import { expect } from 'chai';
import { createLazyProxy } from '../src/pi/lazy-proxy';

describe('createLazyProxy (D11 lazy handle/client binding)', () => {
  it('forwards method calls to the live target, bound to it', () => {
    const target = {
      count: 0,
      bump(this: { count: number }, n: number) { this.count += n; return this.count; },
    };
    const proxy = createLazyProxy<typeof target>(() => target, 'thing');
    expect(proxy.bump(3)).to.equal(3);
    expect(proxy.bump(4)).to.equal(7);
    // `this` binding preserved — mutation landed on the real target.
    expect(target.count).to.equal(7);
  });

  it('forwards non-function property reads from the live target', () => {
    const target = { workflowId: 'wf-123', nested: { a: 1 } };
    const proxy = createLazyProxy<typeof target>(() => target, 'thing');
    expect(proxy.workflowId).to.equal('wf-123');
    expect(proxy.nested).to.deep.equal({ a: 1 });
  });

  it('throws a clear "no active session" error when the resolver returns null', () => {
    const proxy = createLazyProxy<{ go(): void }>(() => null, 'workflow handle');
    expect(() => proxy.go()).to.throw(/workflow handle unavailable.*no active session/i);
  });

  it('re-resolves the target on EVERY access (no caching across switches)', () => {
    let current: { id: string } | null = null;
    const proxy = createLazyProxy<{ id: string }>(() => current, 'handle');

    // Before any session — access throws.
    expect(() => proxy.id).to.throw(/no active session/i);

    // First session attaches.
    current = { id: 'session-A' };
    expect(proxy.id).to.equal('session-A');

    // Handle advances (continueAsNew / reconnect / session switch) — proxy follows.
    current = { id: 'session-B' };
    expect(proxy.id).to.equal('session-B');

    // Detached again — access throws once more.
    current = null;
    expect(() => proxy.id).to.throw(/no active session/i);
  });

  it('supports `in` checks against the live target', () => {
    let current: { foo: number } | null = null;
    const proxy = createLazyProxy<{ foo: number }>(() => current, 'handle');
    expect('foo' in proxy).to.equal(false); // no target yet
    current = { foo: 1 };
    expect('foo' in proxy).to.equal(true);
    expect('bar' in proxy).to.equal(false);
  });
});
