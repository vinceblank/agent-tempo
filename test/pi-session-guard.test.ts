/**
 * Unit test for the interactive-session breadcrumb
 * (src/pi/extension.ts `noteInteractiveSessionAbsent`) — #645 H4, reworded for #677.
 *
 * Pi 0.78.1's `SessionStartEvent` carries NO `session` field, so interactive
 * `session_start` legitimately has `payload.session == null`. Post-#677 injection
 * routes through `pi.sendMessage` (not `payload.session`), so this is the EXPECTED
 * path — emitted as a ONE-TIME, non-alarming INFO breadcrumb (NOT a warning). The
 * build-time H4 drift gate (`_passSendMsg`/`_sendSurfaceCallShape`) owns the
 * "is pi.sendMessage wired?" correctness signal; this is just a bring-up breadcrumb.
 */
import { expect } from 'chai';
import {
  noteInteractiveSessionAbsent,
  __resetInteractiveSessionNoteForTests,
} from '../src/pi/extension';

/** Collects note() calls. */
function recorder(): { noted: string[]; note: (m: string) => void } {
  const noted: string[] = [];
  return { noted, note: (m: string) => noted.push(m) };
}

describe('noteInteractiveSessionAbsent (#677 interactive breadcrumb)', () => {
  // The one-time flag is module-scope — reset before each case.
  beforeEach(() => __resetInteractiveSessionNoteForTests());

  it('emits an INFO breadcrumb when interactive session_start has no session (null)', () => {
    const r = recorder();
    noteInteractiveSessionAbsent('interactive', { session: null as unknown }, r.note);
    expect(r.noted).to.have.length(1);
    // Reworded for #677: confirms the EXPECTED 0.78.1 path, mentions pi.sendMessage.
    expect(r.noted[0]).to.contain('expected on Pi ≥0.78.1');
    expect(r.noted[0]).to.contain('pi.sendMessage');
  });

  it('emits the same breadcrumb when interactive session_start omits session (undefined)', () => {
    const r = recorder();
    noteInteractiveSessionAbsent('interactive', {}, r.note);
    expect(r.noted).to.have.length(1);
  });

  it('is NOT a warning — no "WARNING" / "inert" / "drift" language (would mislead a cue test)', () => {
    const r = recorder();
    noteInteractiveSessionAbsent('interactive', {}, r.note);
    const msg = r.noted[0];
    expect(msg).to.not.contain('WARNING');
    expect(msg).to.not.contain('inert');
    expect(msg).to.not.contain('drift');
  });

  it('fires AT MOST ONCE across repeated interactive session_start (one-time per process)', () => {
    const r = recorder();
    noteInteractiveSessionAbsent('interactive', {}, r.note);
    noteInteractiveSessionAbsent('interactive', { session: null as unknown }, r.note);
    noteInteractiveSessionAbsent('interactive', {}, r.note);
    expect(r.noted, 'breadcrumb is one-time, not per-switch/per-tick').to.have.length(1);
  });

  it('stays QUIET when interactive session_start carries a session', () => {
    const r = recorder();
    noteInteractiveSessionAbsent('interactive', { session: { id: 's1' } }, r.note);
    expect(r.noted).to.have.length(0);
  });

  it('stays QUIET in headless mode even with no session (headless wires it separately)', () => {
    const r = recorder();
    noteInteractiveSessionAbsent('headless', {}, r.note);
    noteInteractiveSessionAbsent('headless', { session: null as unknown }, r.note);
    expect(r.noted).to.have.length(0);
  });
});
