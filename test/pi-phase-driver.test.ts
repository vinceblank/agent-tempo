/**
 * Unit tests for the Pi event → attachment-phase state machine (src/pi/phase-driver.ts).
 *
 * Pure tests — no Temporal, no Pi. They lock the architect's EXACT mapping and
 * the CRITICAL invariant that `turn_*` / `tool_execution_*` NEVER drive phase.
 */
import { expect } from 'chai';
import { PhaseDriver, type WorkflowAction } from '../src/pi/phase-driver';

const T0 = '2026-06-03T00:00:00.000Z';
const T1 = '2026-06-03T00:00:01.000Z';
const T2 = '2026-06-03T00:00:02.000Z';

describe('PhaseDriver — Pi event → attachment phase', () => {
  it('starts in booting with no activity stamp', () => {
    const d = new PhaseDriver();
    expect(d.phase).to.equal('booting');
    expect(d.lastActivityAt).to.equal(null);
  });

  it('session_start → claim action, phase attached', () => {
    const d = new PhaseDriver();
    const r = d.handle('session_start', {}, T0);
    expect(r.action).to.deep.equal({ kind: 'claim' } as WorkflowAction);
    expect(r.phase).to.equal('attached');
    expect(d.phase).to.equal('attached');
    // session_start does not itself stamp activity.
    expect(r.activityStamped).to.equal(false);
  });

  it('agent_start → processingStart action, phase processing, activity stamped', () => {
    const d = new PhaseDriver();
    d.handle('session_start', {}, T0);
    const r = d.handle('agent_start', { messageId: 'm1' }, T1);
    expect(r.action).to.deep.equal({ kind: 'processingStart', messageId: 'm1' });
    expect(r.phase).to.equal('processing');
    expect(r.activityStamped).to.equal(true);
    expect(d.lastActivityAt).to.equal(T1);
  });

  it('agent_end → processingEnd action, phase AWAITING (not detached)', () => {
    const d = new PhaseDriver();
    d.handle('session_start', {}, T0);
    d.handle('agent_start', { messageId: 'm1' }, T1);
    const r = d.handle('agent_end', {}, T2);
    expect(r.action).to.deep.equal({ kind: 'processingEnd', messageId: 'm1' });
    // The regression this guards: agent_end must NOT detach the session.
    expect(r.phase).to.equal('awaiting');
    expect(r.phase).to.not.equal('detached');
    expect(d.phase).to.equal('awaiting');
  });

  it('agent_end pairs with the agent_start messageId for idempotency', () => {
    const d = new PhaseDriver();
    d.handle('session_start', {}, T0);
    d.handle('agent_start', { messageId: 'msg-abc' }, T1);
    // agent_end with no explicit id should reuse the in-flight id.
    const r = d.handle('agent_end', {}, T2);
    expect(r.action).to.deep.equal({ kind: 'processingEnd', messageId: 'msg-abc' });
  });

  it('agent_start synthesizes a stable messageId when Pi omits one', () => {
    const d = new PhaseDriver();
    d.handle('session_start', {}, T0);
    const r = d.handle('agent_start', {}, T1);
    expect(r.action.kind).to.equal('processingStart');
    if (r.action.kind === 'processingStart') {
      expect(r.action.messageId).to.be.a('string').and.have.length.greaterThan(0);
    }
  });

  describe('CRITICAL: turn_* / tool_execution_* MUST NOT drive phase', () => {
    for (const event of [
      'turn_start',
      'turn_end',
      'tool_execution_start',
      'tool_execution_end',
    ]) {
      it(`${event} keeps phase 'processing', stamps activity, action none`, () => {
        const d = new PhaseDriver();
        d.handle('session_start', {}, T0);
        d.handle('agent_start', { messageId: 'm1' }, T1);
        expect(d.phase).to.equal('processing');

        const r = d.handle(event, {}, T2);
        expect(r.action).to.deep.equal({ kind: 'none' });
        // Phase must be UNCHANGED — these events fire many times mid-run.
        expect(r.phase).to.equal('processing');
        expect(d.phase).to.equal('processing');
        // ...but they DO stamp last-activity.
        expect(r.activityStamped).to.equal(true);
        expect(d.lastActivityAt).to.equal(T2);
      });
    }

    it('repeated turn_start/turn_end never oscillate the phase', () => {
      const d = new PhaseDriver();
      d.handle('session_start', {}, T0);
      d.handle('agent_start', { messageId: 'm1' }, T1);
      for (let i = 0; i < 5; i++) {
        d.handle('turn_start', {}, T2);
        d.handle('tool_execution_start', {}, T2);
        d.handle('tool_execution_end', {}, T2);
        d.handle('turn_end', {}, T2);
        expect(d.phase).to.equal('processing');
      }
    });
  });

  it('session_shutdown → detach action, phase draining', () => {
    const d = new PhaseDriver();
    d.handle('session_start', {}, T0);
    d.handle('agent_start', { messageId: 'm1' }, T1);
    d.handle('agent_end', {}, T2);
    const r = d.handle('session_shutdown', {}, T2);
    expect(r.action).to.deep.equal({ kind: 'detach' });
    // detached is confirmed workflow-side after adapterExited; local view rests at draining.
    expect(r.phase).to.equal('draining');
  });

  it('unknown events are inert (no phase change, no activity stamp)', () => {
    const d = new PhaseDriver();
    d.handle('session_start', {}, T0);
    const before = d.lastActivityAt;
    const r = d.handle('some_future_event', {}, T2);
    expect(r.action).to.deep.equal({ kind: 'none' });
    expect(r.phase).to.equal('attached');
    expect(r.activityStamped).to.equal(false);
    expect(d.lastActivityAt).to.equal(before);
  });
});
