/**
 * Player Types screen — Screen G of the dashboard design (PR-6 of #340).
 *
 * **Status**: placeholder — same situation as Loadouts. Player types
 * (subagent definitions) live as Markdown files under
 * `examples/agents/` plus project/user `~/.claude/agents/` overrides;
 * the daemon doesn't yet expose a `/v1/player-types` listing endpoint.
 * Scope discipline (PR-6 brief): render a placeholder + log the gap.
 *
 * Tracking: filed as a follow-up issue when this PR opens.
 */
import { useEffect } from 'react';
import { logEvent } from '../lib/log';

export function PlayerTypes() {
  useEffect(() => { logEvent('screen.opened', { screen: 'player-types' }); }, []);
  return (
    <section
      data-testid="screen-player-types"
      style={{
        padding: 'var(--density-pad)',
        background: 'var(--bg-1)',
        border: '1px solid var(--rule)',
        borderRadius: 8,
      }}
    >
      <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
        Player Types
      </h1>
      <p
        data-testid="player-types-endpoint-missing"
        className="dim"
        style={{ marginBottom: 0 }}
      >
        Endpoint not yet implemented. Player types (subagent
        definitions) live as Markdown under <code>examples/agents/</code>
        plus project/user <code>~/.claude/agents/</code> dirs. A future
        PR adds a daemon-side <code>/v1/player-types</code> listing
        endpoint to surface them here.
      </p>
    </section>
  );
}
