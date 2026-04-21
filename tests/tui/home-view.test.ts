import { describe, it, expect } from 'vitest';
import { partitionEnsembles } from '../../src/tui/components/HomeView';
import { tuiReducer, initialState, type TuiState } from '../../src/tui/store';
import type { EnsembleSummary } from '../../src/client';

const e = (name: string, state: 'running' | 'parked', playerCount = 2): EnsembleSummary => ({
  name,
  playerCount,
  hasConductor: true,
  state,
});

describe('partitionEnsembles', () => {
  it('splits running from parked and sorts each alphabetically', () => {
    const lists = partitionEnsembles(
      [e('zeta', 'running'), e('alpha', 'running'), e('yarn', 'parked'), e('beta', 'parked')],
      null,
    );
    expect(lists.running.map((x) => x.name)).toEqual(['alpha', 'zeta']);
    expect(lists.parked.map((x) => x.name)).toEqual(['beta', 'yarn']);
    expect(lists.cwdMatchCount).toBe(0);
    expect(lists.flat.map((r) => r.ensemble.name)).toEqual(['alpha', 'zeta', 'beta', 'yarn']);
  });

  it('pins cwd-match parked rows to the top of the parked list and flags them', () => {
    // Default matcher compares ensemble name to basename(gitRoot).
    const lists = partitionEnsembles(
      [e('alpha', 'parked'), e('my-project', 'parked'), e('beta', 'parked')],
      '/repos/my-project',
    );
    expect(lists.parked.map((x) => x.name)).toEqual(['my-project', 'alpha', 'beta']);
    expect(lists.cwdMatchCount).toBe(1);
    expect(lists.flat[0].isCwdMatch).toBe(true);
    expect(lists.flat[1].isCwdMatch).toBe(false);
  });

  it('ignores ensembles with neither running nor parked state', () => {
    const mystery = { name: 'mystery', playerCount: 1, hasConductor: false } as EnsembleSummary;
    const lists = partitionEnsembles([mystery, e('alpha', 'running')], null);
    expect(lists.running.map((x) => x.name)).toEqual(['alpha']);
    expect(lists.flat).toHaveLength(1);
  });
});

describe('home-modal reducer actions', () => {
  const s0 = (): TuiState => initialState();

  it('OPEN_HOME_MODAL / CLOSE_HOME_MODAL round-trip clears submitting + error', () => {
    const seeded: TuiState = { ...s0(), homeModalError: 'previous failure' };
    const opened = tuiReducer(seeded, { type: 'OPEN_HOME_MODAL', modal: { type: 'new' } });
    expect(opened.homeModal).toEqual({ type: 'new' });
    expect(opened.homeModalError).toBeUndefined();
    expect(opened.homeModalSubmitting).toBe(false);

    const closed = tuiReducer(opened, { type: 'CLOSE_HOME_MODAL' });
    expect(closed.homeModal).toBeUndefined();
  });

  it('SET_HOME_MODAL_STATUS toggles submitting and carries an error', () => {
    const s: TuiState = { ...s0(), homeModal: { type: 'new' } };
    const busy = tuiReducer(s, { type: 'SET_HOME_MODAL_STATUS', submitting: true });
    expect(busy.homeModalSubmitting).toBe(true);

    const failed = tuiReducer(busy, {
      type: 'SET_HOME_MODAL_STATUS',
      submitting: false,
      error: 'createEnsemble timed out',
    });
    expect(failed.homeModalSubmitting).toBe(false);
    expect(failed.homeModalError).toBe('createEnsemble timed out');
    // Modal survives the status update — closing is a separate action.
    expect(failed.homeModal).toEqual({ type: 'new' });
  });
});
