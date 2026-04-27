/**
 * Loadouts screen — Screen F of the dashboard design (PR-6 of #340).
 *
 * **Status**: placeholder — the daemon doesn't yet expose a `/v1/loadouts`
 * (or equivalent) endpoint that the browser can hit. Loadouts are
 * currently authored as YAML files under `examples/ensembles/` plus
 * project/user-scoped overrides; a wire-friendly listing is its own
 * design discussion. Scope discipline (PR-6 brief): render a
 * placeholder + log the gap; PR-7+ wires the real endpoint.
 *
 * Tracking: filed as a follow-up issue when this PR opens; the
 * `/v1/loadouts` design will be folded into the post-v1 backlog.
 */
import { useEffect } from 'react';
import { logEvent } from '../lib/log';

export function Loadouts() {
  useEffect(() => { logEvent('screen.opened', { screen: 'loadouts' }); }, []);
  return (
    <section
      data-testid="screen-loadouts"
      style={{
        padding: 'var(--density-pad)',
        background: 'var(--bg-1)',
        border: '1px solid var(--rule)',
        borderRadius: 8,
      }}
    >
      <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
        Loadouts
      </h1>
      <p
        data-testid="loadouts-endpoint-missing"
        className="dim"
        style={{ marginBottom: 0 }}
      >
        Endpoint not yet implemented. Loadouts (lineup YAML) are currently
        authored as files under <code>examples/ensembles/</code> and
        project/user dirs. A future PR adds a daemon-side
        <code> /v1/loadouts</code> listing endpoint to surface them here.
      </p>
    </section>
  );
}
