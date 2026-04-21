/**
 * Unit tests for #291 slash-command surface changes — registry alignment,
 * migration hints, and the typed-name `/destroy <ensemble>` reducer path.
 */
import { describe, it, expect } from 'vitest';
import { COMMANDS, getCommandNames } from '../../src/tui/commands';
import { REMOVED_SLASH_COMMANDS, removedSlashCommandHelp } from '../../src/tui/removed-commands';
import { tuiReducer, initialState, type TuiState } from '../../src/tui/store';

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
