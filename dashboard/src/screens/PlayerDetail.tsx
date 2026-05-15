/**
 * PlayerDetail — drilldown sheet for a single player.
 *
 * F-A-1 (PR-C of #454, dashboard pixel-alignment audit v0.28.9): the
 * outer frame is a centered `.sheet.player-sheet` modal-on-backdrop
 * built on `@radix-ui/react-dialog`, matching canonical
 * `screens.jsx:PlayerDetail` (lines 97-167).
 *
 * Wire-fields not yet exposed on the snapshot (received/sent/outbox
 * counters, runId, lease.expiresAt, adapter version) render as `"—"`
 * placeholders. The wire extension lands post-beta.7.
 */
import { useMemo, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate, useParams } from 'react-router-dom';
import type { EnsembleChatMessage } from 'agent-tempo/types';
import type { PlayerSummaryV1 } from 'agent-tempo/http/event-types';
import { useEnsembleSnapshot, useHosts } from '../lib/queries';
import {
  useDestroyMutation,
  useDetachMutation,
  useRecallMutation,
  useRestartMutation,
} from '../lib/mutations';
import { SectionHead } from '../components/SectionHead';
import { Btn } from '../components/Btn';
import { ConfirmDialog } from '../components/wizard/ConfirmDialog';
import { PlayerAvatar } from '../components/tempo/PlayerAvatar';
import { PhaseDot } from '../components/tempo/PhaseDot';
import { TypeBadge } from '../components/tempo/TypeBadge';
import { FeedMessage } from '../components/chat/FeedMessage';
import type { FeedMessageData } from '../components/chat/FeedMessage';
import { MAESTRO_PLAYER_ID, LEGACY_CONDUCTOR_NAME } from '../lib/chat-format';
import {
  formatHHMM,
  formatRelativeAge,
  formatLeaseRemaining,
  formatRunId,
} from '../lib/time-format';

const TRANSCRIPT_LIMIT = 6;

export function PlayerDetail() {
  const { id, playerId } = useParams<{ id: string; playerId: string }>();
  const navigate = useNavigate();
  const snapshot = useEnsembleSnapshot(id ?? null);
  const player = snapshot.data?.players.find((p) => p.playerId === playerId);
  const hosts = useHosts();

  const transcript = useMemo(
    () => buildTranscript(snapshot.data?.chat?.messages, playerId),
    [snapshot.data?.chat?.messages, playerId],
  );

  const close = () => {
    if (id) navigate(`/ensemble/${encodeURIComponent(id)}`);
    else navigate('/');
  };

  const baseTestId = `player-detail-${playerId}`;

  // The route owns visibility (`open={true}` while PlayerDetail is
  // mounted); ESC + overlay-click + Dialog.Close all funnel through
  // `onOpenChange(false)` → `close()` → nav-back. We intentionally do
  // NOT use `Dialog.Portal`: Radix's portal defaults to `document.body`,
  // which escapes `.artboard-body`'s `@container artboard` context and
  // stops the phone-breakpoint collapse from firing. Rendering inline
  // keeps the dialog a descendant of the artboard.
  return (
    <Dialog.Root
      open={true}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Overlay
        className="sheet-overlay"
        data-testid={`${baseTestId}-backdrop`}
      />
      <Dialog.Content
        className="sheet player-sheet"
        data-testid={baseTestId}
        // Radix 1.1.x stopped emitting `aria-modal` automatically; we
        // re-add it for assistive-tech that still keys off the attribute.
        aria-modal="true"
        aria-describedby={undefined}
      >
        {!player ? (
          <NotFound
            testId={baseTestId}
            loading={snapshot.isLoading}
            ensemble={id}
            playerId={playerId}
          />
        ) : (
          <>
            <SheetHead
              ensemble={id ?? ''}
              player={player}
              testIdPrefix={baseTestId}
              onClose={close}
            />
            <div className="player-sheet-body">
              <SheetMain player={player} transcript={transcript} testIdPrefix={baseTestId} />
              <SheetSide
                player={player}
                testIdPrefix={baseTestId}
                adapterVersion={resolveAdapterVersion(player, hosts.data)}
              />
            </div>
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SheetHead({
  ensemble,
  player,
  testIdPrefix,
  onClose,
}: {
  ensemble: string;
  player: PlayerSummaryV1;
  testIdPrefix: string;
  onClose: () => void;
}) {
  const branch = player.gitBranch ?? '—';
  const recall = useRecallMutation(ensemble);
  const restart = useRestartMutation(ensemble);
  const detach = useDetachMutation(ensemble);
  const destroy = useDestroyMutation(ensemble);
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);

  const onDestroyConfirmed = () => {
    destroy.mutate(
      { playerId: player.playerId },
      {
        onSettled: () => setConfirmingDestroy(false),
      },
    );
  };

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
            <Dialog.Title asChild>
              <span
                className="subj display"
                style={{ fontSize: 22 }}
                data-testid={`${testIdPrefix}-name`}
              >
                {player.playerId}
              </span>
            </Dialog.Title>
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
        {/* @DM — closes the sheet to return the operator to the
            workspace where they can compose. The workspace's composer
            already routes by player target; pre-fill is a follow-up. */}
        <Btn
          variant="ghost"
          size="sm"
          data-testid={`${testIdPrefix}-action-dm`}
          onClick={onClose}
        >
          @DM
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          data-testid={`${testIdPrefix}-action-recall`}
          disabled={recall.isPending}
          onClick={() => recall.mutate({ playerId: player.playerId })}
        >
          Recall
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          data-testid={`${testIdPrefix}-action-restart`}
          disabled={restart.isPending}
          onClick={() => restart.mutate({ playerId: player.playerId })}
        >
          Restart
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          data-testid={`${testIdPrefix}-action-detach`}
          disabled={detach.isPending}
          onClick={() => detach.mutate({ playerId: player.playerId })}
        >
          Detach
        </Btn>
        <Btn
          variant="danger"
          size="sm"
          data-testid={`${testIdPrefix}-action-destroy`}
          disabled={destroy.isPending}
          onClick={() => setConfirmingDestroy(true)}
        >
          Destroy
        </Btn>
        <Dialog.Close asChild>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Close player detail"
            data-testid={`${testIdPrefix}-close`}
          >
            ✕
          </button>
        </Dialog.Close>
      </div>
      {confirmingDestroy && (
        <ConfirmDialog
          title={`Destroy ${player.playerId}?`}
          confirmLabel="Destroy"
          pending={destroy.isPending}
          onCancel={() => setConfirmingDestroy(false)}
          onConfirm={onDestroyConfirmed}
          testIdPrefix={`${testIdPrefix}-destroy-confirm`}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0 }}>
              This terminates the player workflow. The session enters{' '}
              <code className="mono">gone</code> phase and cannot be revived.
            </p>
            <p style={{ margin: 0, color: 'var(--dim)', fontSize: 12.5 }}>
              Use <code className="mono">Detach</code> instead if you intend to
              restart the player later.
            </p>
          </div>
        </ConfirmDialog>
      )}
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
  adapterVersion,
}: {
  player: PlayerSummaryV1;
  testIdPrefix: string;
  adapterVersion: string;
}) {
  const phaseValue = (
    <PhaseDot phase={player.phase} playerId={player.playerId} showLabel />
  );
  const messaging = player.messaging;
  const lease = player.lease;
  return (
    <div className="player-sheet-side" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <KvSection
        kicker="attachment"
        title="Phase & lease"
        sectionTestId={`${testIdPrefix}-section-phase-lease`}
      >
        <KvRow testId={`${testIdPrefix}-kv-phase`}     k="phase"     v={phaseValue} mono={false} />
        <KvRow testId={`${testIdPrefix}-kv-adapter`}   k="adapter"   v={adapterVersion} />
        <KvRow testId={`${testIdPrefix}-kv-host`}      k="host"      v={player.hostname} />
        <KvRow testId={`${testIdPrefix}-kv-heartbeat`} k="heartbeat" v={formatRelativeAge(player.lastHeartbeatAt)} />
        <KvRow testId={`${testIdPrefix}-kv-lease`}     k="lease"     v={formatLeaseRemaining(lease?.expiresAt)} />
        <KvRow testId={`${testIdPrefix}-kv-run-id`}    k="run id"    v={formatRunId(player.runId)} />
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
        {/* Q5.5 — three counters from the session's getMessagingState
            query. `outbox` arrives pre-formatted ("empty" / "N pending" /
            "N pending (oldest 2m)") so the dashboard renders it verbatim. */}
        <KvRow testId={`${testIdPrefix}-kv-received`} k="received" v={formatCount(messaging?.received)} />
        <KvRow testId={`${testIdPrefix}-kv-sent`}     k="sent"     v={formatCount(messaging?.sent)} />
        <KvRow testId={`${testIdPrefix}-kv-outbox`}   k="outbox"   v={messaging?.outbox ?? '—'} />
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
}: {
  testId: string;
  loading: boolean;
  ensemble?: string;
  playerId?: string;
}) {
  return (
    <>
      <div className="panel-head player-sheet-head">
        <div className="panel-head-title">
          <Dialog.Title asChild>
            <span className="subj display" style={{ fontSize: 18 }}>
              {playerId ?? 'Unknown player'}
            </span>
          </Dialog.Title>
        </div>
        <Dialog.Close asChild>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Close player detail"
            data-testid={`${testId}-close`}
          >
            ✕
          </button>
        </Dialog.Close>
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

/** "—" when undefined; numeric value otherwise. Used by the Messages KV. */
function formatCount(n: number | undefined): string {
  return n === undefined ? '—' : String(n);
}

/**
 * `agentType` (wire) → adapter key (host's `adapterVersions` map).
 * The wire surface uses the short agent name; the daemon's
 * `HostProfile.adapterVersions` is keyed by upstream tool name. Only
 * `'claude'` needs translation — `'copilot'` and `'mock'` already match
 * their adapter keys.
 */
function adapterKeyForAgent(agent: PlayerSummaryV1['agentType']): string {
  return agent === 'claude' ? 'claude-code' : agent;
}

/**
 * Resolve the adapter row's display string (Q5.4 W3). Renders
 * `"<adapter> · v<version>"` when both the host profile and the
 * adapterVersions probe succeeded; the adapter name alone when the
 * version is unknown; `"—"` when the player has no agent type.
 */
function resolveAdapterVersion(
  player: PlayerSummaryV1,
  hosts: ReturnType<typeof useHosts>['data'],
): string {
  const agent = player.agentType;
  if (!agent) return '—';
  const adapterKey = adapterKeyForAgent(agent);
  const hostInfo = hosts?.find((h) => h.hostname === player.hostname);
  const version = hostInfo?.profile?.adapterVersions?.[adapterKey];
  return version ? `${adapterKey} · v${version}` : adapterKey;
}
