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
import { Btn } from '../components/Btn';
import { PageHeader } from '../components/PageHeader';
import { useScreenPageHeader } from '../components/AppShell';
import { TypeBadge } from '../components/tempo/TypeBadge';
import { glyphFor, hueForType } from '../lib/tempo-helpers';
import { logEvent } from '../lib/log';

interface PlayerType {
  /** Stable id matching the markdown filename (sans `.md`). */
  name: string;
  /** One-line summary surfaced in the card body. */
  summary: string;
}

/**
 * Hardcoded fallback for the 8 player types shipped under
 * `examples/agents/`. PR-E (#403) introduces a shared
 * `lib/static-catalog.ts` with the same constant; when both PRs land,
 * this module switches to importing from there. Kept inline so PR-F2
 * stays independent of PR-E's merge order.
 *
 * Matches `examples/agents/*.md` `description:` frontmatter verbatim.
 */
const SHIPPED_PLAYER_TYPES: ReadonlyArray<PlayerType> = [
  {
    name: 'tempo-conductor',
    summary: 'Orchestrates the ensemble — breaks down tasks, delegates, synthesizes.',
  },
  {
    name: 'tempo-composer',
    summary: 'Software architect — designs system structure, defines interfaces.',
  },
  {
    name: 'tempo-critic',
    summary: 'Code reviewer — evaluates changes for correctness and quality.',
  },
  {
    name: 'tempo-improv',
    summary: 'Researcher and explorer — investigates unknowns, runs spikes.',
  },
  {
    name: 'tempo-liner',
    summary: 'Documentation specialist — README, CHANGELOG, PR descriptions.',
  },
  {
    name: 'tempo-roadie',
    summary: 'DevOps engineer — CI/CD, deployments, infrastructure.',
  },
  {
    name: 'tempo-soloist',
    summary: 'Senior engineer — implements features, fixes bugs, writes tests.',
  },
  {
    name: 'tempo-tuner',
    summary: 'QA engineer — designs test strategies, finds bugs, validates edges.',
  },
];

export function PlayerTypes() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'player-types' });
  }, []);

  const onRescan = useCallback(() => {
    logEvent('player-types.rescan', {});
    // Wire-pending: triggers daemon-side filesystem rescan once
    // /v1/agent-types ships. For now a no-op + log line lets the
    // conductor's autonomous validator confirm the click registered.
  }, []);

  const onNewType = useCallback(() => {
    logEvent('player-types.new', {});
    // Wire-pending: would open a "create new player type" wizard +
    // write to ~/.claude/agents/. Out of scope for PR-F2.
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
        {SHIPPED_PLAYER_TYPES.map((t) => (
          <PlayerTypeCard key={t.name} type={t} />
        ))}
      </div>
    </section>
  );
}

interface PlayerTypeCardProps {
  type: PlayerType;
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
          SHIPPED
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
        {type.summary}
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
