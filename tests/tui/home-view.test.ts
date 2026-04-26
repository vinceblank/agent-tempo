import { describe, it, expect } from 'vitest';
import { partitionEnsembles } from '../../src/tui/components/HomeView';
import { tuiReducer, initialState, type TuiState } from '../../src/tui/store';
import type { EnsembleSummary } from '../../src/client';

const e = (
  name: string,
  state: 'online' | 'paused' | 'offline',
  playerCount = 2,
): EnsembleSummary => ({
  name,
  playerCount,
  hasConductor: true,
  state,
});

describe('partitionEnsembles', () => {
  it('splits online / paused / offline and sorts each alphabetically', () => {
    const lists = partitionEnsembles(
      [
        e('zeta', 'online'), e('alpha', 'online'),
        e('mango', 'paused'), e('apple', 'paused'),
        e('yarn', 'offline'), e('beta', 'offline'),
      ],
      null,
    );
    expect(lists.online.map((x) => x.name)).toEqual(['alpha', 'zeta']);
    expect(lists.paused.map((x) => x.name)).toEqual(['apple', 'mango']);
    expect(lists.offline.map((x) => x.name)).toEqual(['beta', 'yarn']);
    expect(lists.cwdMatchCount).toBe(0);
    // Flat sequence mirrors render order: online → paused → offline.
    expect(lists.flat.map((r) => r.ensemble.name)).toEqual([
      'alpha', 'zeta', 'apple', 'mango', 'beta', 'yarn',
    ]);
  });

  it('pins cwd-match offline rows to the top of the offline list and flags them', () => {
    // Default matcher compares ensemble name to basename(gitRoot).
    const lists = partitionEnsembles(
      [e('alpha', 'offline'), e('my-project', 'offline'), e('beta', 'offline')],
      '/repos/my-project',
    );
    expect(lists.offline.map((x) => x.name)).toEqual(['my-project', 'alpha', 'beta']);
    expect(lists.cwdMatchCount).toBe(1);
    expect(lists.flat[0].isCwdMatch).toBe(true);
    expect(lists.flat[1].isCwdMatch).toBe(false);
  });

  it('does NOT pin cwd-match online or paused rows', () => {
    // The cwd badge is the "press Enter to restore the ensemble you
    // created here" affordance — only the offline restore flow needs it.
    const lists = partitionEnsembles(
      [
        e('my-project', 'online'),
        e('my-project-paused', 'paused'),
      ],
      '/repos/my-project',
    );
    // No offline rows means nothing is pinned, even though one online row
    // matches the cwd basename exactly.
    expect(lists.cwdMatchCount).toBe(0);
    expect(lists.flat.every((r) => r.isCwdMatch === false)).toBe(true);
  });

  it('ignores ensembles with no recognised state', () => {
    const mystery = { name: 'mystery', playerCount: 1, hasConductor: false } as EnsembleSummary;
    const lists = partitionEnsembles([mystery, e('alpha', 'online')], null);
    expect(lists.online.map((x) => x.name)).toEqual(['alpha']);
    expect(lists.paused).toHaveLength(0);
    expect(lists.offline).toHaveLength(0);
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
