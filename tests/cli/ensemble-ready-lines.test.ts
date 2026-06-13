/**
 * Vitest coverage for `formatEnsembleReadyLines` (#832).
 *
 * Bug history: `up` / `conduct` printed `Ensemble <lineup-name> is ready` using
 * the lineup's `name:` field. The actual ensemble name is RESOLVED separately
 * (`--ensemble` flag > positional > env > `default`), so whenever any of those
 * overrode the lineup name the closing line named a thing the operator could not
 * `connect` to. This suite pins the formatter to the resolved ensemble name and
 * the surfaced connect command.
 */
import { describe, it, expect } from 'vitest';
import { formatEnsembleReadyLines } from '../../src/cli/commands';

describe('formatEnsembleReadyLines (#832)', () => {
  it('names the RESOLVED ensemble, not the lineup name', () => {
    const [ready, connect] = formatEnsembleReadyLines('default', 'tempo-dev-team', 3);
    expect(ready).to.contain('Ensemble "default" is ready');
    expect(ready).to.contain('from lineup tempo-dev-team');
    // The lineup name must NOT be presented as the ensemble.
    expect(ready).to.not.contain('Ensemble "tempo-dev-team"');
    expect(connect).to.equal('Connect: agent-tempo command-center default');
  });

  it('surfaces the connect command keyed on the resolved ensemble', () => {
    const [, connect] = formatEnsembleReadyLines('prod-squad', 'tempo-big-band', 5);
    expect(connect).to.equal('Connect: agent-tempo command-center prod-squad');
  });

  it('pluralizes the player count correctly', () => {
    expect(formatEnsembleReadyLines('e', 'l', 1)[0]).to.contain('1 player on standby');
    expect(formatEnsembleReadyLines('e', 'l', 0)[0]).to.contain('0 players on standby');
    expect(formatEnsembleReadyLines('e', 'l', 4)[0]).to.contain('4 players on standby');
  });

  it('handles the common case where ensemble === lineup name', () => {
    const [ready] = formatEnsembleReadyLines('tempo-dev-team', 'tempo-dev-team', 3);
    expect(ready).to.contain('Ensemble "tempo-dev-team" is ready');
    expect(ready).to.contain('from lineup tempo-dev-team');
  });
});
