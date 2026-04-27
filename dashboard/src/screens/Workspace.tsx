/**
 * Workspace screen (Screen A — primary surface). Direct analog of the
 * TUI's main view: roster on the left, chat in the centre, contextual
 * details on the right.
 *
 * - Subscribes to `/v1/events/:ensemble` via `useSseSubscription` so
 *   incremental events repaint the cache without polling.
 * - Conductor identity is derived from `players.find(p => p.isConductor)`
 *   — matches the TUI's #358 contract and feeds `conductorPlayerId` to
 *   the chat-formatting layer for #360's directed-prefix logic.
 * - PlayerDetail opens via React Router so the URL is deep-linkable
 *   for the conductor's `mcp__claude-in-chrome__navigate` validator.
 *
 * Behaviour ported from the TUI's beta.3 sweep:
 *   - #357 broadcast collapse — handled in `lib/chat-format.ts`
 *   - #360 directed `→ @<player>` prefix — handled in `ChatMessage`
 *   - #358 conductor single-source-of-truth — derived in this screen
 */
import { useEffect, useMemo } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useEnsembleSnapshot } from '../lib/queries';
import { useSseSubscription } from '../lib/sse';
import { selectedPlayerIdFromPath } from '../router';
import { logEvent } from '../lib/log';
import { ChatLog } from '../components/chat/ChatLog';
import { MessageInput } from '../components/chat/MessageInput';
import { RosterItem } from '../components/RosterItem';
import { TempoStrip } from '../components/tempo/TempoStrip';
import { WorkspaceToolbar } from '../components/WorkspaceToolbar';

/** Toy series for the TempoStrip — real bucketing lands in PR-6. */
const PLACEHOLDER_TEMPO_SERIES = [
  1, 0, 0, 2, 1, 3, 2, 4, 1, 0, 1, 2, 0, 3, 4, 5, 6, 4, 3, 2,
];

export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const ensemble = id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const snapshot = useEnsembleSnapshot(ensemble);
  useSseSubscription(ensemble);

  useEffect(() => {
    if (ensemble) logEvent('workspace.opened', { ensemble });
  }, [ensemble]);

  const players = useMemo(
    () => snapshot.data?.players ?? [],
    [snapshot.data?.players],
  );
  const conductorPlayerId = useMemo(
    () => players.find((p) => p.isConductor)?.playerId,
    [players],
  );
  const messages = snapshot.data?.chat?.messages ?? [];
  // chat.compressed empties the local window AND sets hasMore: true.
  // Surface that combination as the "compressed gap" banner.
  const hasCompressedGap =
    !!snapshot.data && messages.length === 0 && snapshot.data.chat.hasMore;

  // The selected player (if any) reads from the path. PlayerDetail is
  // a child route so React Router renders it via `<Outlet />`.
  const selectedPlayerId = selectedPlayerIdFromPath(location.pathname);

  if (!ensemble) {
    return (
      <section data-testid="workspace-missing-ensemble" role="alert" className="dim">
        No ensemble in the URL. Pick one from the Overview screen.
      </section>
    );
  }

  if (snapshot.isLoading && !snapshot.data) {
    return (
      <section
        data-testid={`workspace-${ensemble}`}
        data-state="loading"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 22 }}>
          {ensemble}
        </h1>
        <div
          data-testid="loading"
          data-resource={`workspace-${ensemble}`}
          className="dim"
          style={{ padding: 'var(--density-pad)' }}
        >
          Loading workspace…
        </div>
      </section>
    );
  }

  if (snapshot.isError) {
    return (
      <section data-testid={`workspace-${ensemble}`} data-state="error">
        <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 22 }}>
          {ensemble}
        </h1>
        <div
          role="alert"
          data-testid={`error-workspace-${ensemble}`}
          style={{
            padding: 'var(--density-pad)',
            background: 'var(--bg-1)',
            border: '1px solid var(--accent)',
            borderRadius: 8,
            color: 'var(--accent)',
          }}
        >
          {snapshot.error?.message ?? 'Snapshot unavailable'}
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid={`workspace-${ensemble}`}
      data-state={snapshot.data?.state ?? 'online'}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)',
        gridTemplateRows: 'auto 1fr',
        gap: 12,
        height: 'calc(100vh - 160px)',
        minHeight: 480,
      }}
    >
      <header
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
          {ensemble}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <WorkspaceToolbar
            ensemble={ensemble}
            paused={snapshot.data?.flags.paused ?? false}
            held={snapshot.data?.flags.held ?? false}
          />
          <TempoStrip
            series={PLACEHOLDER_TEMPO_SERIES}
            bpm={snapshot.data?.players.length ? 96 : 0}
          />
        </div>
      </header>

      <aside
        data-testid="roster"
        aria-label="Player roster"
        style={{
          background: 'var(--bg-1)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
          overflowY: 'auto',
          padding: 4,
        }}
      >
        {players.length === 0 ? (
          <div className="dim" style={{ padding: 'var(--density-pad)' }}>
            Empty ensemble — recruit a player to begin.
          </div>
        ) : (
          players.map((p) => (
            <RosterItem
              key={p.playerId}
              player={p}
              selected={p.playerId === selectedPlayerId}
              onSelect={(playerId) => {
                logEvent('player.selected', { ensemble, playerId });
                navigate(
                  `/ensemble/${encodeURIComponent(ensemble)}/player/${encodeURIComponent(playerId)}`,
                );
              }}
            />
          ))
        )}
      </aside>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--bg-1)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <ChatLog
          ensemble={ensemble}
          messages={messages}
          conductorPlayerId={conductorPlayerId}
          hasCompressedGap={hasCompressedGap}
        />
        <MessageInput ensemble={ensemble} target={conductorPlayerId} />
      </div>

      {/* PlayerDetail mounts here when the URL nests `/player/:playerId` */}
      <Outlet />
    </section>
  );
}
