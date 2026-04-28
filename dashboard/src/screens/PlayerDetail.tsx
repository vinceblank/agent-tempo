/**
 * PlayerDetail — drilldown sheet for a single player (PR-D of #389).
 *
 * Mounts inside a {@link ResponsivePanel} so mobile gets a bottom-sheet
 * automatically; on desktop the inner `.player-sheet` structure mirrors
 * the canonical `screens.jsx:PlayerDetail` (lines 97-167).
 *
 * Action buttons render disabled-with-tooltip until PR-7 wires the
 * destructive-write paths. Close (`✕`) navigates back to the parent
 * Workspace route.
 *
 * Phase rendering (rev 4 C3): `PhaseDot` consumes the real codebase
 * phase vocabulary — never generic playing/paused/error.
 *
 * Wire-fields not yet exposed on the snapshot (received/sent/outbox
 * counters, runId, lease.expiresAt, adapter version) render as `"—"`
 * placeholders. The wire extension lands post-beta.7.
 */
import { useMemo, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import { useEnsembleSnapshot } from '../lib/queries';
import { ResponsivePanel } from '../components/ResponsivePanel';
import { SectionHead } from '../components/SectionHead';
import { DisabledWithTooltip } from '../components/DisabledWithTooltip';
import { PlayerAvatar } from '../components/tempo/PlayerAvatar';
import { PhaseDot } from '../components/tempo/PhaseDot';
import { TypeBadge } from '../components/tempo/TypeBadge';
import { FeedMessage } from '../components/chat/FeedMessage';
import type { FeedMessageData } from '../components/chat/FeedMessage';
import { MAESTRO_PLAYER_ID, LEGACY_CONDUCTOR_NAME } from '../lib/chat-format';
import { formatHHMM, formatRelativeAge } from '../lib/time-format';

const TRANSCRIPT_LIMIT = 6;

interface ActionSpec {
  /** testid suffix; full id is `player-detail-${playerId}-action-${key}`. */
  key: 'dm' | 'recall' | 'restart' | 'detach' | 'destroy';
  label: string;
  reason: string;
}

const ACTIONS: readonly ActionSpec[] = [
  { key: 'dm',       label: '@DM',     reason: 'Direct message wires up in PR-7 of #389.' },
  { key: 'recall',   label: 'Recall',  reason: 'Recall wires up in PR-7 of #389.' },
  { key: 'restart',  label: 'Restart', reason: 'Restart wires up in PR-7 of #389.' },
  { key: 'detach',   label: 'Detach',  reason: 'Detach wires up in PR-7 of #389.' },
  { key: 'destroy',  label: 'Destroy', reason: 'Destroy wires up in PR-7 of #389.' },
];

export function PlayerDetail() {
  const { id, playerId } = useParams<{ id: string; playerId: string }>();
  const navigate = useNavigate();
  const snapshot = useEnsembleSnapshot(id ?? null);
  const player = snapshot.data?.players.find((p) => p.playerId === playerId);

  const transcript = useMemo(
    () => buildTranscript(snapshot.data?.chat?.messages, playerId),
    [snapshot.data?.chat?.messages, playerId],
  );

  const close = () => {
    if (id) navigate(`/ensemble/${encodeURIComponent(id)}`);
    else navigate('/');
  };

  const baseTestId = `player-detail-${playerId}`;

  return (
    <ResponsivePanel
      open={true}
      onClose={close}
      testId={baseTestId}
      ariaLabel={`Player ${playerId}`}
    >
      {!player ? (
        <NotFound testId={baseTestId} loading={snapshot.isLoading} ensemble={id} playerId={playerId} onClose={close} />
      ) : (
        <>
          <SheetHead player={player} testIdPrefix={baseTestId} onClose={close} />
          <div className="player-sheet-body">
            <SheetMain player={player} transcript={transcript} testIdPrefix={baseTestId} />
            <SheetSide player={player} testIdPrefix={baseTestId} />
          </div>
        </>
      )}
    </ResponsivePanel>
  );
}

function SheetHead({
  player,
  testIdPrefix,
  onClose,
}: {
  player: PlayerSummaryV1;
  testIdPrefix: string;
  onClose: () => void;
}) {
  const branch = player.gitBranch ?? '—';
  return (
    <div className="panel-head player-sheet-head">
      <div className="panel-head-title" style={{ alignItems: 'center', gap: 12 }}>
        <PlayerAvatar
          playerId={player.playerId}
          playerType={player.playerType}
          isConductor={player.isConductor}
          size={40}
        />
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <div className="row">
            <span
              className="subj display"
              style={{ fontSize: 22 }}
              data-testid={`${testIdPrefix}-name`}
            >
              {player.playerId}
            </span>
            <PhaseDot phase={player.phase} playerId={player.playerId} showLabel />
          </div>
          <div className="row">
            {player.playerType && <TypeBadge type={player.playerType} />}
            <span className="mono dim" style={{ fontSize: 11 }}>
              on {player.hostname} · {branch}
            </span>
          </div>
        </div>
      </div>
      <div className="row" data-testid={`${testIdPrefix}-actions`}>
        {ACTIONS.map((a) => (
          <DisabledWithTooltip
            key={a.key}
            testId={`${testIdPrefix}-action-${a.key}`}
            action={`player-detail.${a.key}`}
            reason={a.reason}
          >
            {a.label}
          </DisabledWithTooltip>
        ))}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Close player detail"
          data-testid={`${testIdPrefix}-close`}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function SheetMain({
  player,
  transcript,
  testIdPrefix,
}: {
  player: PlayerSummaryV1;
  transcript: FeedMessageData[];
  testIdPrefix: string;
}) {
  return (
    <div className="player-sheet-main">
      <SectionHead kicker="transcript" title="Recent messages" tight />
      <div
        className="col"
        style={{ gap: 12 }}
        data-testid={`${testIdPrefix}-transcript`}
        data-count={transcript.length}
      >
        {transcript.length === 0 ? (
          <p
            className="dim"
            data-testid={`${testIdPrefix}-transcript-empty`}
            style={{ fontSize: 'var(--density-fs-sm)' }}
          >
            No recent messages with {player.playerId}.
          </p>
        ) : (
          transcript.map((m) => <FeedMessage key={m.id} m={m} />)
        )}
      </div>
    </div>
  );
}

function SheetSide({
  player,
  testIdPrefix,
}: {
  player: PlayerSummaryV1;
  testIdPrefix: string;
}) {
  const phaseValue = (
    <PhaseDot phase={player.phase} playerId={player.playerId} showLabel />
  );
  return (
    <div className="player-sheet-side" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <KvSection
        kicker="attachment"
        title="Phase & lease"
        sectionTestId={`${testIdPrefix}-section-phase-lease`}
      >
        <KvRow testId={`${testIdPrefix}-kv-phase`}     k="phase"     v={phaseValue} mono={false} />
        <KvRow testId={`${testIdPrefix}-kv-adapter`}   k="adapter"   v="—" />
        <KvRow testId={`${testIdPrefix}-kv-host`}      k="host"      v={player.hostname} />
        <KvRow testId={`${testIdPrefix}-kv-heartbeat`} k="heartbeat" v={formatRelativeAge(player.lastHeartbeatAt)} />
        <KvRow testId={`${testIdPrefix}-kv-lease`}     k="lease"     v="—" />
        <KvRow testId={`${testIdPrefix}-kv-run-id`}    k="run id"    v="—" />
      </KvSection>

      <KvSection
        kicker="workdir"
        title="Work"
        sectionTestId={`${testIdPrefix}-section-work`}
      >
        <KvRow testId={`${testIdPrefix}-kv-dir`}      k="dir"      v={player.workDir || '—'} />
        <KvRow testId={`${testIdPrefix}-kv-branch`}   k="branch"   v={player.gitBranch ?? '—'} />
        <KvRow testId={`${testIdPrefix}-kv-worktree`} k="worktree" v="—" />
        <KvRow testId={`${testIdPrefix}-kv-part`}     k="part"     v={player.part || '—'} mono={false} />
      </KvSection>

      <KvSection
        kicker="traffic"
        title="Messages"
        sectionTestId={`${testIdPrefix}-section-messages`}
      >
        <KvRow testId={`${testIdPrefix}-kv-received`} k="received" v="—" />
        <KvRow testId={`${testIdPrefix}-kv-sent`}     k="sent"     v="—" />
        <KvRow testId={`${testIdPrefix}-kv-outbox`}   k="outbox"   v="—" />
      </KvSection>

      {/* Compatibility shim for v0.27 testid surface (`-id`/`-type`/`-phase`).
          Remove once dependent suites migrate to the new testids. */}
      <span hidden data-testid={`${testIdPrefix}-id`}>{player.playerId}</span>
      {player.playerType && (
        <span hidden data-testid={`${testIdPrefix}-type`}>{player.playerType}</span>
      )}
      <span hidden data-testid={`${testIdPrefix}-phase`}>{player.phase ?? 'unknown'}</span>
    </div>
  );
}

function NotFound({
  testId,
  loading,
  ensemble,
  playerId,
  onClose,
}: {
  testId: string;
  loading: boolean;
  ensemble?: string;
  playerId?: string;
  onClose: () => void;
}) {
  return (
    <>
      <div className="panel-head player-sheet-head">
        <div className="panel-head-title">
          <span className="subj display" style={{ fontSize: 18 }}>
            {playerId ?? 'Unknown player'}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Close player detail"
          data-testid={`${testId}-close`}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="player-sheet-body" style={{ gridTemplateColumns: '1fr' }}>
        <div className="player-sheet-main">
          <p
            data-testid={`${testId}-not-found`}
            role="status"
            className="dim"
          >
            {loading
              ? 'Loading player…'
              : `${playerId} is not in the snapshot for ${ensemble ?? 'unknown ensemble'}.`}
          </p>
        </div>
      </div>
    </>
  );
}

function KvSection({
  kicker,
  title,
  sectionTestId,
  children,
}: {
  kicker: string;
  title: string;
  sectionTestId: string;
  children: ReactNode;
}) {
  return (
    <div>
      <SectionHead kicker={kicker} title={title} tight />
      <div data-testid={sectionTestId}>{children}</div>
    </div>
  );
}

function KvRow({
  testId,
  k,
  v,
  mono = true,
}: {
  testId: string;
  k: string;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="kv" data-testid={testId}>
      <span className="kv-k mono">{k}</span>
      <span className={`kv-v${mono ? ' mono' : ''}`}>{v}</span>
    </div>
  );
}

/**
 * Filter the ensemble's chat ring to messages where the given player is
 * either sender or recipient, then keep the most recent
 * `TRANSCRIPT_LIMIT`. The snapshot's `chat.messages` is most-recent-first
 * (per the maestro hub query); we slice then reverse so the transcript
 * displays oldest-on-top, matching the ChatLog scroll-to-bottom convention.
 */
function buildTranscript(
  messages: EnsembleChatMessage[] | undefined,
  playerId: string | undefined,
): FeedMessageData[] {
  if (!messages || !playerId) return [];
  return messages
    .filter((m) => m.from === playerId || m.to === playerId)
    .slice(0, TRANSCRIPT_LIMIT)
    .map((m) => toFeedMessage(m, playerId))
    .reverse();
}

/** Map an `EnsembleChatMessage` to the `FeedMessageData` shape. */
function toFeedMessage(m: EnsembleChatMessage, _playerId: string): FeedMessageData {
  const fromMaestro = m.from === MAESTRO_PLAYER_ID;
  const toMaestro = m.to === MAESTRO_PLAYER_ID;
  // From the player's transcript perspective: maestro-routed messages
  // become in/out (the sheet is a maestro view); conductor-side routes
  // (player → conductor with no maestro touch) are overheard → `route`.
  const kind: FeedMessageData['kind'] = fromMaestro ? 'out' : toMaestro ? 'in' : 'route';
  return {
    id: m.id,
    kind,
    from: m.from === LEGACY_CONDUCTOR_NAME ? 'conductor' : m.from,
    to: m.to === LEGACY_CONDUCTOR_NAME ? 'conductor' : m.to,
    time: formatHHMM(m.timestamp),
    body: m.text,
    fromIsConductor: !fromMaestro && !toMaestro && m.role === 'conductor-out',
  } satisfies FeedMessageData;
}
