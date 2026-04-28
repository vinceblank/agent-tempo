/**
 * Workspace screen — the 90% surface. PR-C1 + PR-C2 of #389.
 *
 * Per audit rev 4 §6 PR-C1 (lines 966-976) + PR-C2 (lines 978-987) +
 * canonical workspace.jsx:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ensemble / @name   ●N active  M idle  ◐K detached  up Xh    │ page-header
 *   │ Lineup … · conducted by … on …            [+ Recruit] [≡] │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ tempo                                                  92 bpm│ page-tempo
 *   │ ▁▂▃▄▆▇▆▅▄▃▂▁▂▄▆▇▇▆▄▃                                          │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ ┌─────────────── chat panel ────────┐ ┌─── workspace-side ─┐ │
 *   │ │ MAESTRO CHAT       Pause  Pop out │ │ ┌── Roster ──────┐ │ │
 *   │ │  Conductor + ensemble feed        │ │ │ ♩ name ●idle   │ │ │
 *   │ │ ─────────────────────────────────  │ │ │ ♪ name ●proc.  │ │ │
 *   │ │ <ChatLog>                          │ │ └────────────────┘ │ │
 *   │ │ <Composer>                         │ │ ┌── Event log ──┐ │ │
 *   │ └────────────────────────────────────┘ │ │ 14:02 phase…  │ │ │
 *   │                                         │ └────────────────┘ │ │
 *   │                                         │ ┌── Schedules ──┐ │ │
 *   │                                         │ │ status-check…│ │ │
 *   │                                         │ └────────────────┘ │ │
 *   │                                         └────────────────────┘ │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Side toggle: the people-glyph button in `page-actions` flips
 * `showSide`; when collapsed, the workspace grid drops to 1fr and the
 * side panel hides. The CSS already handles the phone bottom-sheet
 * presentation via `@container artboard (max-width: 520px)` — that
 * mobile path is wired in PR-C3.
 *
 * PR-C2 polished the chat panel: ChatLog now adapts to the FeedMessage
 * 3-variant (in / out / route) via `rowToFeedMessage`, the legacy
 * MessageInput is replaced by `<Composer>` (auto-grow textarea + @ + /
 * toolbar buttons + ⌘↩ submit / Ctrl ↩ on non-Mac), and the disabled
 * "Pop out" stub now flips a `popped` state machine that swaps the
 * docked chat for `<ChatStub>` while a `<PopoutWindow>` mounts at the
 * artboard root with the same chat surface. The red traffic-light dot
 * docks the chat back; the scrim does too.
 *
 * Behaviour ported from the TUI's beta.3 sweep:
 *   - #357 broadcast collapse — handled in `lib/chat-format.ts`
 *   - #360 directed `→ @<player>` prefix — preserved through the
 *     `rowToFeedMessage` adapter (the FeedMessage body carries a
 *     `chat-message-${id}-recipient` shim span when set)
 *   - #358 conductor single-source-of-truth — derived in this screen
 *
 * Source: `workspace.jsx:200-493` (canonical EnsembleWorkspace) +
 *         `screens.jsx:32-62` (page-actions pattern) +
 *         components.css `.workspace*` / `.page-header` /
 *         `.page-tempo` / `.panel.chat` / `.panel-head` / `.event-row` /
 *         `.kv` / `.side-toggle` / `.composer*`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Outlet,
  Link,
  useParams,
  useNavigate,
  useLocation,
} from 'react-router-dom';
import { useEnsembleSnapshot } from '../lib/queries';
import { asExtended } from '../lib/wire-shape';
import { useSseSubscription } from '../lib/sse';
import { selectedPlayerIdFromPath } from '../router';
import { logEvent } from '../lib/log';
import {
  useCueMutation,
  usePauseMutation,
  usePlayMutation,
  useReleaseMutation,
} from '../lib/mutations';
import { ChatLog } from '../components/chat/ChatLog';
import { Composer } from '../components/chat/Composer';
import { ChatStub } from '../components/chat/ChatStub';
import { PopoutWindow } from '../components/chat/PopoutWindow';
import { RosterItem } from '../components/RosterItem';
import { TempoStrip } from '../components/tempo/TempoStrip';
import { PageHeader } from '../components/PageHeader';
import { useScreenPhoneAppBar, type PhoneAppBarOverride } from '../components/AppShell';

/**
 * Empty fallback for the TempoStrip when the snapshot hasn't yet
 * surfaced the maestro's `tempoSeries`. The 60-bucket window is filled
 * with zeros so the sparkline renders as a flat baseline rather than
 * a degenerate `viewBox=0 0 0 N` SVG that browsers refuse to draw.
 */
const EMPTY_TEMPO_SERIES = Array<number>(60).fill(0);

/** People / roster glyph used by the side-toggle button. Inline SVG to
 * stay design-faithful (audit Q7: no lucide-react dependency). */
function PeopleGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid-exempt="decorative-glyph"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 19c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5" />
      <circle cx="17" cy="7" r="2.4" />
      <path d="M15.5 13.2c2.4 0.5 5 2 5 5.3" />
    </svg>
  );
}

export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const ensemble = id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const snapshot = useEnsembleSnapshot(ensemble);
  // #399 W1 (Q5.6) — bpm + sparkline land on the snapshot via DB1a.
  // Fall back to neutral values until DB1a's projection ships.
  const extData = asExtended(snapshot.data);
  const bpm = extData?.currentBpm ?? 0;
  const tempoSeries = extData?.tempoSeries ?? [];
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
  const hasCompressedGap =
    !!snapshot.data && messages.length === 0 && snapshot.data.chat.hasMore;

  const flags = snapshot.data?.flags;
  const paused = flags?.paused ?? false;
  const held = flags?.held ?? false;

  // The selected player (if any) reads from the path. PlayerDetail is
  // a child route so React Router renders it via `<Outlet />`.
  const selectedPlayerId = selectedPlayerIdFromPath(location.pathname);

  // Side panel visibility. Default visible on desktop; the phone
  // breakpoint's CSS turns this into a bottom-sheet via `@container
  // artboard (max-width: 520px)` rules.
  const [showSide, setShowSide] = useState(true);
  // Pop-out state: when true, the chat surface moves to a floating
  // PopoutWindow + the docked panel renders a ChatStub placeholder. The
  // `.workspace-dimmed` class on the artboard wrapper desaturates the
  // workspace beneath via the components.css `.workspace-dimmed > .app-shell`
  // rule (line 1413-1416).
  const [popped, setPopped] = useState(false);

  // Cue mutation drives the Composer's onSubmit. The optimistic update
  // is owned by `useCueMutation` (PR-7b) — the Composer just hands off
  // the trimmed message; success / error rollback rides the existing
  // mutation surface.
  const cueM = useCueMutation(ensemble ?? '');
  const sendMessage = (text: string) => {
    if (!conductorPlayerId) {
      logEvent('chat.message.skipped', {
        ensemble,
        hasTarget: false,
        length: text.length,
      });
      return;
    }
    cueM.mutate({ to: conductorPlayerId, message: text });
  };

  // Status pill counts. Mapping mirrors the audit's PHASES bucket
  // categories — `attached`+`processing` count as "active", `awaiting`
  // counts as "idle", `draining`+`detached` count as "detached".
  const active = players.filter(
    (p) => p.phase === 'attached' || p.phase === 'processing',
  ).length;
  const idle = players.filter((p) => p.phase === 'awaiting').length;
  const detached = players.filter(
    (p) => p.phase === 'draining' || p.phase === 'detached',
  ).length;

  // ── Mobile shell (PR-C3 of #389) ──
  //
  // Push a PhoneAppBar override into AppShell's slot so the ≤520px bar
  // shows the workspace's lineup kicker + 4-pill status row, and routes
  // the right-button tap to the same `setShowSide` toggle the desktop
  // side-toggle uses. The action button mirrors the desktop people-glyph
  // visually and shares the `is-active` treatment, so the same React
  // state drives both surfaces in lockstep.
  //
  // Uptime is `'—'` until Task #15 lands per-ensemble msgs/minute
  // aggregation (matching the audit's "graceful-degrade" rule for
  // tempo/uptime/description). Once the wire ships, swap to a derived
  // value here.
  const toggleSide = useCallback(() => setShowSide((s) => !s), []);
  const phoneAppBarOverride = useMemo<PhoneAppBarOverride>(
    () => ({
      lineup: 'tempo-dev-team',
      status: { active, idle, detached, uptime: '—' },
      onAction: toggleSide,
      actionIcon: <PeopleGlyph />,
      actionLabel: showSide ? 'Hide roster' : 'Show roster, events, schedules',
      actionActive: showSide,
    }),
    [active, idle, detached, showSide, toggleSide],
  );
  useScreenPhoneAppBar(phoneAppBarOverride);

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
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        <PageHeader prefix="ensemble /" title="" accent={ensemble} />
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
      <section
        data-testid={`workspace-${ensemble}`}
        data-state="error"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        <PageHeader prefix="ensemble /" title="" accent={ensemble} />
        <div
          role="alert"
          data-testid={`error-workspace-${ensemble}`}
          style={{
            margin: 'var(--density-pad) calc(var(--density-pad) * 1.6)',
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

  const state = snapshot.data?.state ?? 'online';

  return (
    <section
      data-testid={`workspace-${ensemble}`}
      data-state={state}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      <PageHeader
        prefix="ensemble /"
        title=""
        accent={ensemble}
        pills={
          <>
            <span className="page-pill">
              <span className="pill-dot" />
              <span className="pill-num">{active}</span> active
            </span>
            <span className="page-pill">
              <span className="pill-num">{idle}</span> idle
            </span>
            {detached > 0 && (
              <span className="page-pill warn">◐ {detached} detached</span>
            )}
            <span className="page-pill">
              {paused ? 'paused' : held ? 'held' : 'live'}
            </span>
          </>
        }
        actions={
          <>
            <Link
              to={`/recruit?ensemble=${encodeURIComponent(ensemble)}`}
              data-testid="workspace-toolbar-recruit"
              title="Recruit a new player into this ensemble"
              className="btn btn-ghost btn-sm"
              style={{ textDecoration: 'none' }}
            >
              <span className="btn-icon">+</span>
              <span>Recruit</span>
            </Link>
            <button
              type="button"
              data-testid="workspace-side-toggle"
              className={'side-toggle' + (showSide ? ' is-active' : '')}
              onClick={() => setShowSide((s) => !s)}
              aria-pressed={showSide}
              aria-label={showSide ? 'Hide roster' : 'Show roster, events, schedules'}
              title={showSide ? 'Hide details' : 'Show roster, events, schedules'}
            >
              <span className="st-icon">
                <PeopleGlyph />
              </span>
              <span className="st-label">{showSide ? 'Hide details' : 'Details'}</span>
              <span className="st-badge mono">{players.length}</span>
            </button>
          </>
        }
        subtitle={
          <>
            Lineup <span className="mono">tempo-dev-team</span>
            {conductorPlayerId && (
              <>
                {' · conducted by '}
                <span className="mono accent">{conductorPlayerId}</span>
              </>
            )}
          </>
        }
      />

      <div className="page-tempo">
        <TempoStrip
          series={tempoSeries.length > 0 ? tempoSeries : EMPTY_TEMPO_SERIES}
          bpm={bpm}
        />
      </div>

      <div className={'workspace' + (showSide ? '' : ' workspace-collapsed')}>
        {/* Phone-only scrim behind the bottom-sheet variant of
          * `.workspace-side`. CSS hides this on desktop (`display: none`
          * in components.css line 389) and shows it on ≤520px (line 1111)
          * — the `onClick` is wired regardless so the scrim is dismissible
          * the moment the @container query flips it visible. */}
        {showSide && (
          <div
            className="ws-side-scrim"
            data-testid="workspace-side-scrim"
            onClick={() => setShowSide(false)}
            aria-hidden="true"
          />
        )}
        <section className="workspace-main">
          {popped ? (
            // Docked stub when the chat is floating in a PopoutWindow.
            // Click anywhere on the stub to dock the chat back.
            <ChatStub onClick={() => setPopped(false)} testId="workspace-chat-stub" />
          ) : (
            <div className="panel chat" style={{ flex: 1, minHeight: 0 }}>
              <div className="panel-head">
                <div className="panel-head-title">
                  <span className="h">Maestro chat</span>
                  <span className="subj display">Conductor + ensemble feed</span>
                </div>
                <div className="row">
                  <ChatPauseButton ensemble={ensemble} paused={paused} held={held} />
                  <ChatReleaseButton ensemble={ensemble} held={held} />
                  <button
                    type="button"
                    data-testid="workspace-popout"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setPopped(true)}
                    aria-pressed={popped}
                    title="Pop out the chat into a floating window"
                    aria-label="Pop out chat"
                  >
                    <span className="btn-icon">↗</span>
                    <span>Pop out</span>
                  </button>
                </div>
              </div>
              <ChatLog
                ensemble={ensemble}
                messages={messages}
                conductorPlayerId={conductorPlayerId}
                players={players}
                hasCompressedGap={hasCompressedGap}
              />
              <Composer
                placeholder={
                  conductorPlayerId
                    ? `Message ${conductorPlayerId}`
                    : 'Recruit a player to start chatting'
                }
                disabled={!conductorPlayerId || cueM.isPending}
                onSubmit={sendMessage}
                sendLabel={cueM.isPending ? 'Sending…' : 'Send'}
                testIdPrefix="composer"
              />
            </div>
          )}
        </section>

        {showSide && (
          <aside
            className="workspace-side"
            data-testid="workspace-side"
            aria-label="Roster, events, schedules"
          >
            <div className="ws-side-sheet-grip" aria-hidden="true" />
            <button
              type="button"
              data-testid="workspace-side-close"
              className="ws-side-sheet-close"
              onClick={() => setShowSide(false)}
              aria-label="Close details"
            >
              ×
            </button>
            <div className="panel">
              <div className="panel-head">
                <div className="panel-head-title">
                  <span className="h">Roster</span>
                  <span className="subj display">
                    {players.length} {players.length === 1 ? 'player' : 'players'}
                  </span>
                </div>
                <Link
                  to={`/recruit?ensemble=${encodeURIComponent(ensemble)}`}
                  data-testid="workspace-roster-recruit"
                  className="btn btn-ghost btn-sm"
                  style={{ textDecoration: 'none' }}
                  title="Recruit a new player"
                >
                  <span className="btn-icon">+</span>
                  <span>Recruit</span>
                </Link>
              </div>
              <div
                className="panel-body flush roster"
                data-testid="roster"
                aria-label="Player roster"
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
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <div className="panel-head-title">
                  <span className="h">Event log</span>
                  <span className="subj display">System audit trail</span>
                </div>
                <span className="mono dim" style={{ fontSize: 10 }}>
                  ring · max 200
                </span>
              </div>
              <div className="panel-body flush event-log" data-testid="workspace-event-log">
                {/* PR-C1 stub: phase changes derived from the snapshot are
                  * the only "events" available locally. Task #15 wires a
                  * proper `/v1/events?global=true` event-log subscription
                  * that PR-C2 will consume here. */}
                {players.length === 0 ? (
                  <div
                    className="dim"
                    style={{ padding: 'var(--density-pad)', fontSize: 11 }}
                  >
                    No events yet.
                  </div>
                ) : (
                  players.slice(0, 6).map((p) => (
                    <div key={p.playerId} className="event-row">
                      <span className="t">·</span>
                      <span className={`k ${eventKindForPhase(p.phase)}`}>
                        {phaseLabel(p.phase)}
                      </span>
                      <span>{p.playerId}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <div className="panel-head-title">
                  <span className="h">Schedules</span>
                  <span className="subj display">—</span>
                </div>
              </div>
              <div className="panel-body" style={{ paddingTop: 6 }}>
                {/* PR-C1 stub: schedules wire-up lands in PR-F. The panel
                  * shell + header sit here so the side-stack visually
                  * matches the canonical workspace layout. */}
                <div className="dim" style={{ fontSize: 11 }}>
                  Schedules wire-up lands in PR-F (#389).
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {popped && (
        <PopoutWindow
          titlePrefix="claude-tempo · maestro chat ·"
          titleAccent={`@${ensemble}`}
          onClose={() => setPopped(false)}
          testId="workspace-popout-window"
        >
          <ChatLog
            ensemble={ensemble}
            messages={messages}
            conductorPlayerId={conductorPlayerId}
            players={players}
            hasCompressedGap={hasCompressedGap}
          />
          <Composer
            placeholder={
              conductorPlayerId
                ? `Message ${conductorPlayerId}`
                : 'Recruit a player to start chatting'
            }
            disabled={!conductorPlayerId || cueM.isPending}
            onSubmit={sendMessage}
            sendLabel={cueM.isPending ? 'Sending…' : 'Send'}
            testIdPrefix="popout-composer"
          />
        </PopoutWindow>
      )}

      {/* PlayerDetail mounts here when the URL nests `/player/:playerId` */}
      <Outlet />
    </section>
  );
}

// ─── Chat panel head buttons ──────────────────────────────────────────
//
// The chat panel head's right slot houses Pause + Release per the design.
// Pause toggles the ensemble's paused flag (functionally identical to the
// previous WorkspaceToolbar behavior). Release fires `releaseHeld` on the
// ensemble. Pop out is stubbed for PR-C2.
//
// Testids preserved verbatim from the old WorkspaceToolbar so the existing
// mutation tests (`tests/mutations.test.tsx` and similar) keep passing
// without modification.

function ChatPauseButton({
  ensemble,
  paused,
  held,
}: {
  ensemble: string;
  paused: boolean;
  held: boolean;
}) {
  const pauseM = usePauseMutation(ensemble);
  const playM = usePlayMutation(ensemble);
  const pending = paused ? playM.isPending : pauseM.isPending;
  const handle = () => {
    if (paused) playM.mutate({ release: held });
    else pauseM.mutate();
  };
  return (
    <button
      type="button"
      data-testid="workspace-toolbar-pause"
      className="btn btn-ghost btn-sm"
      disabled={pending}
      onClick={handle}
      aria-pressed={paused}
      title={paused ? 'Unpause this ensemble' : 'Pause this ensemble'}
    >
      <span className="btn-icon">{paused ? '▶' : '⏸'}</span>
      <span>{pending ? '…' : paused ? 'Resume' : 'Pause'}</span>
    </button>
  );
}

function ChatReleaseButton({
  ensemble,
  held,
}: {
  ensemble: string;
  held: boolean;
}) {
  const releaseM = useReleaseMutation(ensemble);
  return (
    <button
      type="button"
      data-testid="workspace-toolbar-release"
      className="btn btn-ghost btn-sm"
      disabled={releaseM.isPending || !held}
      onClick={() => releaseM.mutate()}
      title={held ? 'Release held sessions' : 'No held sessions'}
    >
      <span>{releaseM.isPending ? 'Releasing…' : 'Release'}</span>
    </button>
  );
}

// ─── Phase → event-row helpers ────────────────────────────────────────

function eventKindForPhase(phase: string | undefined): string {
  switch (phase) {
    case 'attached':
    case 'processing':
      return 'ensemble';
    case 'draining':
    case 'detached':
      return 'phase';
    case 'booting':
      return 'heartbeat';
    default:
      return '';
  }
}

function phaseLabel(phase: string | undefined): string {
  return (phase ?? 'unknown').toUpperCase();
}
