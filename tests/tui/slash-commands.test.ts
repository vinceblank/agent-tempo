/**
 * Unit tests for #291 slash-command surface changes — registry alignment,
 * migration hints, and the typed-name `/destroy <ensemble>` reducer path.
 */
import { describe, it, expect, vi } from 'vitest';
import { COMMANDS, getCommandNames, type CommandContext } from '../../src/tui/commands';
import { REMOVED_SLASH_COMMANDS, removedSlashCommandHelp } from '../../src/tui/removed-commands';
import { tuiReducer, initialState, type TuiAction, type TuiState } from '../../src/tui/store';
import type { TempoClient } from '../../src/client';

describe('slash-command registry (#291)', () => {
  it('registers the new ensemble-scope verbs', () => {
    const names = getCommandNames();
    for (const name of ['pause', 'play', 'shutdown', 'restore', 'home', 'destroy']) {
      expect(names, `missing /${name}`).toContain(name);
    }
  });

  it('drops the removed verbs from the registry', () => {
    const names = getCommandNames();
    for (const name of ['pause_ensemble', 'resume_ensemble', 'resume', 'detach', 'disband']) {
      expect(names, `/${name} should no longer be registered`).not.toContain(name);
    }
  });

  it('uses /play usage copy (renamed from /resume)', () => {
    expect(COMMANDS.play.usage).toMatch(/\/play/);
    expect(COMMANDS.play.usage).not.toMatch(/\/resume/);
  });

  it('/home has a handler that takes no args', () => {
    expect(COMMANDS.home.handler).toBeTypeOf('function');
    expect(COMMANDS.home.usage).toBe('/home');
  });

  it('/destroy usage advertises both player and ensemble scopes', () => {
    expect(COMMANDS.destroy.usage).toMatch(/player.*ensemble|ensemble.*player/);
  });
});

describe('removed-slash-command migration hints', () => {
  it('maps every removed verb to a rename/removal pointer', () => {
    for (const key of Object.keys(REMOVED_SLASH_COMMANDS)) {
      const msg = removedSlashCommandHelp(key);
      expect(msg, `hint missing for ${key}`).toBeTruthy();
      expect(msg).toMatch(/\/help/);
    }
  });

  it('points resume_ensemble at /play, not /resume', () => {
    const msg = removedSlashCommandHelp('resume_ensemble')!;
    expect(msg).toContain('/play');
    expect(msg).not.toMatch(/resume\b/i);
  });

  it('returns null for unknown command names (falls through to generic error)', () => {
    expect(removedSlashCommandHelp('totally-unknown-verb')).toBeNull();
  });
});

describe('/destroy <ensemble> typed-name reducer actions', () => {
  const s0 = (): TuiState => initialState('myband');

  it('CONFIRM_ENSEMBLE_DESTROY seeds empty input', () => {
    const out = tuiReducer(s0(), { type: 'CONFIRM_ENSEMBLE_DESTROY', ensemble: 'myband' });
    expect(out.confirmingEnsembleDestroy).toEqual({ ensemble: 'myband', input: '' });
  });

  it('ENSEMBLE_DESTROY_INPUT updates input + clears any prior error', () => {
    const seeded: TuiState = {
      ...s0(),
      confirmingEnsembleDestroy: { ensemble: 'myband', input: 'myba', error: 'mismatch' },
    };
    const out = tuiReducer(seeded, { type: 'ENSEMBLE_DESTROY_INPUT', input: 'mybande' });
    expect(out.confirmingEnsembleDestroy?.input).toBe('mybande');
    expect(out.confirmingEnsembleDestroy?.error).toBeUndefined();
  });

  it('ENSEMBLE_DESTROY_MISMATCH surfaces inline error + preserves input', () => {
    const seeded: TuiState = {
      ...s0(),
      confirmingEnsembleDestroy: { ensemble: 'myband', input: 'foo' },
    };
    const out = tuiReducer(seeded, { type: 'ENSEMBLE_DESTROY_MISMATCH' });
    expect(out.confirmingEnsembleDestroy?.input).toBe('foo');
    expect(out.confirmingEnsembleDestroy?.error).toMatch(/"foo" \u2260 "myband"/);
    expect(out.confirmingEnsembleDestroy?.submitting).toBe(false);
  });

  it('ENSEMBLE_DESTROY_SUBMIT_BUSY toggles submitting + clears error', () => {
    const seeded: TuiState = {
      ...s0(),
      confirmingEnsembleDestroy: { ensemble: 'myband', input: 'myband', error: 'prior' },
    };
    const out = tuiReducer(seeded, { type: 'ENSEMBLE_DESTROY_SUBMIT_BUSY' });
    expect(out.confirmingEnsembleDestroy?.submitting).toBe(true);
    expect(out.confirmingEnsembleDestroy?.error).toBeUndefined();
  });

  it('CANCEL_ENSEMBLE_DESTROY clears the confirmation state', () => {
    const seeded: TuiState = {
      ...s0(),
      confirmingEnsembleDestroy: { ensemble: 'myband', input: 'my' },
    };
    const out = tuiReducer(seeded, { type: 'CANCEL_ENSEMBLE_DESTROY' });
    expect(out.confirmingEnsembleDestroy).toBeUndefined();
  });

  it('input actions no-op when no confirmation is in progress', () => {
    const s = s0();
    expect(s.confirmingEnsembleDestroy).toBeUndefined();
    const out = tuiReducer(s, { type: 'ENSEMBLE_DESTROY_INPUT', input: 'x' });
    expect(out).toBe(s);
  });
});

// ── #306: /destroy handler guards + visible prompt ──
//
// Three regression tests for the pre-merge smoke-test bugs:
//  1. `/destroy conductor` must refuse — #294 established "conductor required"
//     as an ensemble invariant. Before this fix it silently dispatched
//     CONFIRM_STOP and the UI never rendered the prompt, wedging input.
//  2. `/destroy <peer>` must emit a visible scrollback prompt alongside the
//     CONFIRM_STOP dispatch. Before this fix the user saw input freeze with
//     no feedback.
//  3. The existing ensemble-typed-name path must still work (no regression).

function makeNoopApi(): TempoClient {
  const unused = vi.fn(() => {
    throw new Error('TempoClient method not expected during /destroy handler');
  });
  return new Proxy({} as TempoClient, { get: () => unused });
}

describe('/destroy handler guards (#306)', () => {
  const CTX: CommandContext = { activeEnsemble: 'myband' };

  it('refuses /destroy conductor with an error + redirect (does NOT dispatch CONFIRM_STOP)', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS.destroy.handler!;
    await handler(['conductor'], dispatch, makeNoopApi(), CTX);

    // No confirmation dispatched — the whole point of the guard.
    const confirmCalls = dispatch.mock.calls.filter(
      ([a]) => (a as { type: string }).type === 'CONFIRM_STOP',
    );
    expect(confirmCalls.length).toBe(0);

    // Exactly one bottom-pinned notification (#306 — errors moved off
    // scroll-back so users can't miss guard-rail refusals).
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0] as {
      type: string;
      notification: { kind: string; content: string };
    };
    expect(action.type).toBe('ADD_NOTIFICATION');
    expect(action.notification.kind).toBe('error');
    expect(action.notification.content).toMatch(/Cannot destroy the conductor/);
    // Redirects point at the real alternatives.
    expect(action.notification.content).toMatch(/\/shutdown/);
    expect(action.notification.content).toMatch(/\/restart conductor/);
    // Active-ensemble name gets inlined for the whole-ensemble destroy hint.
    expect(action.notification.content).toMatch(/\/destroy myband/);
  });

  it('refuses /destroy conductor even when activeEnsemble is null (falls back to <ensemble>)', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS.destroy.handler!;
    await handler(['conductor'], dispatch, makeNoopApi(), { activeEnsemble: null });

    const action = dispatch.mock.calls[0][0] as {
      type: string;
      notification: { kind: string; content: string };
    };
    expect(action.notification.content).toMatch(/\/destroy <ensemble>/);
  });

  it('/destroy <peer> dispatches only CONFIRM_STOP — the y/n prompt is a pinned render, not scrollback', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS.destroy.handler!;
    await handler(['alice'], dispatch, makeNoopApi(), CTX);

    // Exactly one dispatch: the confirmation state update. The visible
    // prompt is rendered from `state.confirmingStop` by App.tsx's
    // `renderPinnedConfirmations` (pinned below the input), so it can't
    // scroll off-screen as new messages arrive — which is why we no
    // longer emit a `COMMIT_STATIC` prompt line here.
    expect(dispatch).toHaveBeenCalledTimes(1);

    const action = dispatch.mock.calls[0][0] as {
      type: string;
      player: string;
      reason?: string;
    };
    expect(action.type).toBe('CONFIRM_STOP');
    expect(action.player).toBe('alice');
    expect(action.reason).toBeUndefined();
  });

  it('/destroy <peer> <reason …> forwards the reason only on the CONFIRM_STOP action (rendered by the pinned prompt)', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS.destroy.handler!;
    await handler(['alice', 'stuck', 'in', 'a', 'loop'], dispatch, makeNoopApi(), CTX);

    // Still exactly one dispatch — reason lives on the state field and
    // surfaces via the pinned render, not via scrollback.
    expect(dispatch).toHaveBeenCalledTimes(1);

    const confirm = dispatch.mock.calls[0][0] as {
      type: string;
      player: string;
      reason?: string;
    };
    expect(confirm.type).toBe('CONFIRM_STOP');
    expect(confirm.player).toBe('alice');
    expect(confirm.reason).toBe('stuck in a loop');
  });

  it('ensemble-scope (/destroy matches activeEnsemble) still routes to typed-name confirmation', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS.destroy.handler!;
    await handler(['myband'], dispatch, makeNoopApi(), CTX);

    // Exactly one dispatch: the typed-name confirmation. No CONFIRM_STOP,
    // no prompt line (the typed-name UI renders its own copy).
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0] as { type: string; ensemble: string };
    expect(action.type).toBe('CONFIRM_ENSEMBLE_DESTROY');
    expect(action.ensemble).toBe('myband');
  });

  it('usage error when no target provided (no dispatches beyond the usage line)', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS.destroy.handler!;
    await handler([], dispatch, makeNoopApi(), CTX);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0] as {
      type: string;
      notification: { kind: string; content: string };
    };
    expect(action.type).toBe('ADD_NOTIFICATION');
    expect(action.notification.kind).toBe('error');
    expect(action.notification.content).toMatch(/Usage:/);
  });
});
