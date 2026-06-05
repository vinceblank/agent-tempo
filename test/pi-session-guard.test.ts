/**
 * Unit test for the B1 runtime guard (src/pi/extension.ts,
 * `warnIfInteractiveSessionMissing`) — #645 H4.
 *
 * `PiEventPayload.session` is undeclared in Pi 0.78's `.d.ts`, so the pi-drift
 * TYPE gate cannot see it. This RUNTIME guard is its complement: it warns when an
 * INTERACTIVE `session_start` carries no session (cue/reset injection would be
 * silently inert — likely Pi API drift). Headless legitimately omits the session,
 * so the guard must stay quiet there.
 */
import { expect } from 'chai';
import { warnIfInteractiveSessionMissing } from '../src/pi/extension';

/** Collects warn() calls. */
function recorder(): { warned: string[]; warn: (m: string) => void } {
  const warned: string[] = [];
  return { warned, warn: (m: string) => warned.push(m) };
}

describe('warnIfInteractiveSessionMissing (B1 guard)', () => {
  it('WARNS when interactive session_start carries no session (null)', () => {
    const r = recorder();
    warnIfInteractiveSessionMissing('interactive', { session: null as unknown }, r.warn);
    expect(r.warned).to.have.length(1);
    expect(r.warned[0]).to.contain('interactive session_start carried no session');
    expect(r.warned[0]).to.contain('#645');
  });

  it('WARNS when interactive session_start omits session (undefined)', () => {
    const r = recorder();
    warnIfInteractiveSessionMissing('interactive', {}, r.warn);
    expect(r.warned).to.have.length(1);
  });

  it('stays QUIET when interactive session_start carries a session', () => {
    const r = recorder();
    warnIfInteractiveSessionMissing('interactive', { session: { id: 's1' } }, r.warn);
    expect(r.warned).to.have.length(0);
  });

  it('stays QUIET in headless mode even with no session (headless wires it separately)', () => {
    const r = recorder();
    warnIfInteractiveSessionMissing('headless', {}, r.warn);
    warnIfInteractiveSessionMissing('headless', { session: null as unknown }, r.warn);
    expect(r.warned).to.have.length(0);
  });
});
