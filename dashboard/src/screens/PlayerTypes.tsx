/**
 * Player Types screen — PR-F2 of #389. Cards-grid showing every shipped
 * agent definition (subagent `.md` files under `examples/agents/`,
 * project `.claude/agents/`, user `~/.claude/agents/`).
 *
 * Source: `screens.jsx:PlayerTypes` (lines 386-432) + audit § PR-F.
 *
 * Wire-pending: the daemon doesn't yet expose `/v1/agent-types`. Until
 * it does, the catalog comes from `lib/static-catalog.SHIPPED_PLAYER_TYPES`
 * (the 8 types shipped under `examples/agents/`). Project/user override
 * tier and the `tools count` / `usedBy` numerics aren't surfaced —
 * they degrade to placeholder values per Q5 graceful-degrade pattern.
 *
 * Layout: `.types-grid` is `auto-fill / minmax(155px, 175px)` per
 * audit C5.5 / chat2.md fix — cards size to content (no `1fr` squish).
 *
 * Triggered from: Sidebar "Player types" Library nav item (PR-A1).
 *
 * Testability surface:
 *   - `data-testid="screen-player-types"` on the section
 *   - `data-testid="player-type-card-${name}"` on each card
 *   - `data-testid="player-type-card-${name}-source"` on the source label
 *   - `data-testid="player-type-card-${name}-edit"` / `-duplicate` on actions
 *   - `data-testid="player-types-rescan"` / `player-types-new` on header actions
 */
import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentTypeRow } from '../lib/client';
import { Btn } from '../components/Btn';
import { PageHeader } from '../components/PageHeader';
import { useScreenPageHeader } from '../components/AppShell';
import { TypeBadge } from '../components/tempo/TypeBadge';
import { glyphFor, hueForType } from '../lib/tempo-helpers';
import { useAgentTypes, AGENT_TYPES_QUERY_KEY } from '../lib/queries';
import { logEvent } from '../lib/log';
import { SHIPPED_PLAYER_TYPES } from '../lib/static-catalog';

export function PlayerTypes() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'player-types' });
  }, []);
  const agentTypesQuery = useAgentTypes();
  const qc = useQueryClient();

  // Live wire from `/v1/agent-types`; eagerly falls back to the
  // bundled SHIPPED_PLAYER_TYPES while the query loads (and on error)
  // so the catalog grid is always populated. Wire data swaps in
  // when it resolves and the user sees their project/user types too.
  const types: ReadonlyArray<AgentTypeRow> = agentTypesQuery.data
    ?? SHIPPED_PLAYER_TYPES;

  const onRescan = useCallback(() => {
    logEvent('player-types.rescan', {});
    // Daemon scans on every request (no cache yet — see #400 followup);
    // invalidating the cache + refetch gives the user a fresh read
    // covering filesystem changes (new `.md` under `~/.claude/agents/`).
    void qc.invalidateQueries({ queryKey: AGENT_TYPES_QUERY_KEY });
  }, [qc]);

  const onNewType = useCallback(() => {
    logEvent('player-types.new', {});
    // Wire-pending: would open a "create new player type" wizard +
    // write to ~/.claude/agents/. Out of scope.
  }, []);

  const renderHeader = useCallback(
    () => (
      <PageHeader
        title="Player types"
        subtitle={
          <>
            Agent definitions. <span className="mono">.md</span> with YAML frontmatter ·
            three-tier lookup: project → user → shipped.
          </>
        }
        actions={
          <>
            <Btn
              variant="ghost"
              size="sm"
              icon="⟳"
              data-testid="player-types-rescan"
              onClick={onRescan}
            >
              Re-scan
            </Btn>
            <Btn
              variant="primary"
              size="sm"
              icon="+"
              data-testid="player-types-new"
              onClick={onNewType}
            >
              New type
            </Btn>
          </>
        }
      />
    ),
    [onRescan, onNewType],
  );
  useScreenPageHeader(renderHeader);

  return (
    <section data-testid="screen-player-types">
      <div className="types-grid" data-testid="player-types-grid">
        {types.map((t) => (
          <PlayerTypeCard key={t.name} type={t} />
        ))}
      </div>
    </section>
  );
}

interface PlayerTypeCardProps {
  type: AgentTypeRow;
}
function PlayerTypeCard({ type }: PlayerTypeCardProps) {
  const hue = hueForType(type.name);
  const shortName = type.name.replace(/^tempo-/, '');
  const testRoot = `player-type-card-${type.name}`;
  return (
    <article
      data-testid={testRoot}
      className="panel"
      style={{
        padding: 16,
        gap: 10,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <TypeBadge type={type.name} />
        <span
          className="mono dim"
          data-testid={`${testRoot}-source`}
          style={{ fontSize: 10.5 }}
        >
          {type.source.toUpperCase()}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--ff-display)', fontSize: 20, lineHeight: 1.1 }}>
        <span
          aria-hidden="true"
          style={{
            color: `oklch(0.82 0.12 ${hue})`,
            fontFamily: 'var(--ff-mono)',
            fontSize: 22,
            marginRight: 8,
          }}
        >
          {glyphFor(type.name)}
        </span>
        {shortName}
      </div>
      <div
        style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}
        data-testid={`${testRoot}-summary`}
      >
        {type.description ?? '—'}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 'auto',
          gap: 8,
        }}
      >
        <span className="mono dim" style={{ fontSize: 11 }}>
          — tools
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Btn variant="ghost" size="sm" data-testid={`${testRoot}-edit`}>
            Edit
          </Btn>
          <Btn variant="ghost" size="sm" data-testid={`${testRoot}-duplicate`}>
            Duplicate
          </Btn>
        </div>
      </div>
    </article>
  );
}
