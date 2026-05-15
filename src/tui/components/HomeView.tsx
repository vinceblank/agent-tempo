/**
 * HomeView — three-list landing surface (Online / Paused / Offline). Polls
 * `listEnsembles` every 10s; `r` forces an immediate refresh.
 *
 * Offline rows whose ensemble name matches the cwd's git-root basename are
 * pinned to the top of the offline list with a `⬡` badge — the visual
 * affordance for "press Enter to restore the ensemble you created here".
 * Online and Paused rows are not cwd-pinned — entering them is a no-op
 * navigation, not a restore that needs a per-cwd hint.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import { statusIcons, supportsUnicode } from '../utils/platform';
import type { BootstrapBadges } from '../bootstrap-types';
import type { EnsembleSummary, TempoClient } from '../../client';

const REFRESH_INTERVAL_MS = 10_000;

/**
 * Initial snapshot — structurally a subset of `BootstrapResult` so callers
 * can pass the full bootstrap result directly.
 */
export interface HomeViewInitial {
  ensembles: EnsembleSummary[];
  cwdGitRoot: string | null;
  badges: BootstrapBadges;
}

export interface HomeViewProps {
  initial: HomeViewInitial;
  client: TempoClient;
  onEnterEnsemble: (name: string) => void;
  onCreateEnsemble: () => void;
  onLoadLineup: () => void;
  onRestoreEnsemble: (name: string) => void;
  onQuit: () => void;
}

interface SortedLists {
  online: EnsembleSummary[];
  paused: EnsembleSummary[];
  offline: EnsembleSummary[];
  /**
   * Flat sequence used for keyboard navigation. Order matches render
   * order: Online → Paused → Offline (cwd-match offline rows first).
   */
  flat: Array<{ ensemble: EnsembleSummary; isCwdMatch: boolean }>;
  /** Count of cwd-matched offline ensembles pinned at the top of the offline list. */
  cwdMatchCount: number;
}

/**
 * Split + sort ensembles into Online / Paused / Offline lists with
 * cwd-match rows pinned to the top of the Offline list. Pure function for
 * testability.
 */
export function partitionEnsembles(
  ensembles: readonly EnsembleSummary[],
  cwdGitRoot: string | null,
  cwdMatcher: (ensemble: EnsembleSummary, gitRoot: string) => boolean = defaultCwdMatcher,
): SortedLists {
  const online: EnsembleSummary[] = [];
  const paused: EnsembleSummary[] = [];
  const offlineMatch: EnsembleSummary[] = [];
  const offlineOther: EnsembleSummary[] = [];

  for (const e of ensembles) {
    if (e.state === 'online') {
      online.push(e);
    } else if (e.state === 'paused') {
      paused.push(e);
    } else if (e.state === 'offline') {
      if (cwdGitRoot && cwdMatcher(e, cwdGitRoot)) offlineMatch.push(e);
      else offlineOther.push(e);
    }
  }

  // Alphabetical — recency-desc will replace this once `lastActivityAt` is
  // threaded through `EnsembleSummary`.
  online.sort((a, b) => a.name.localeCompare(b.name));
  paused.sort((a, b) => a.name.localeCompare(b.name));
  offlineMatch.sort((a, b) => a.name.localeCompare(b.name));
  offlineOther.sort((a, b) => a.name.localeCompare(b.name));

  const offline = [...offlineMatch, ...offlineOther];
  const flat = [
    ...online.map((ensemble) => ({ ensemble, isCwdMatch: false })),
    ...paused.map((ensemble) => ({ ensemble, isCwdMatch: false })),
    ...offlineMatch.map((ensemble) => ({ ensemble, isCwdMatch: true })),
    ...offlineOther.map((ensemble) => ({ ensemble, isCwdMatch: false })),
  ];
  return { online, paused, offline, flat, cwdMatchCount: offlineMatch.length };
}

/**
 * Shallow equality over the fields HomeView renders. Keeps the 10s poll
 * from thrashing referential identity when the backend snapshot is
 * unchanged.
 */
function ensemblesEqual(a: readonly EnsembleSummary[], b: readonly EnsembleSummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.name !== y.name || x.state !== y.state
      || x.playerCount !== y.playerCount
      || x.hasConductor !== y.hasConductor
      || x.conductorStatus !== y.conductorStatus) return false;
  }
  return true;
}

/** Matches the `agent-tempo up` default: ensemble named after the repo root. */
function defaultCwdMatcher(ensemble: EnsembleSummary, gitRoot: string): boolean {
  const basename = gitRoot.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return basename.length > 0 && ensemble.name === basename;
}

export function HomeView(props: HomeViewProps): React.ReactElement {
  const {
    initial, client,
    onEnterEnsemble, onCreateEnsemble, onLoadLineup, onRestoreEnsemble, onQuit,
  } = props;
  const { Box, Text, useInput } = useInk();
  const [ensembles, setEnsembles] = useState<EnsembleSummary[]>(initial.ensembles);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #306: Track whether the first refresh has completed so the empty state
  // doesn't flash "No ensembles yet" before the discovery query returns.
  // Bootstrap may pass a stale or empty `initial.ensembles`; only after the
  // mount-time refresh do we trust an empty list as "really empty."
  const [firstRefreshDone, setFirstRefreshDone] = useState(initial.ensembles.length > 0);

  const lists = useMemo(
    () => partitionEnsembles(ensembles, initial.cwdGitRoot),
    [ensembles, initial.cwdGitRoot],
  );

  // Clamp selection whenever the list shrinks underneath the cursor.
  useEffect(() => {
    if (selectedIdx >= lists.flat.length) {
      setSelectedIdx(Math.max(0, lists.flat.length - 1));
    }
  }, [lists.flat.length, selectedIdx]);

  // Debounced refresh: setInterval fires every 10s; `r` key calls refresh()
  // immediately. In-flight refreshes short-circuit via `refreshing` flag so
  // a slow query doesn't stack behind a fast one.
  const refreshingRef = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const next = await client.listEnsembles();
      // Identity-stable: skip the setState when the 10s poll returns an
      // equivalent snapshot (common case on an idle host), so HomeView's
      // memoized `partitionEnsembles` result doesn't re-compute.
      setEnsembles((prev) => ensemblesEqual(prev, next) ? prev : next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      setFirstRefreshDone(true);
    }
  }, [client]);

  useEffect(() => {
    // #306: Kick an immediate refresh on mount so the user doesn't see
    // "No ensembles yet" while waiting for the 10s polling timer's first
    // tick. The timer continues polling at the regular cadence after.
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useInput(useCallback((input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    const total = lists.flat.length;
    if (key.upArrow && total > 0) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow && total > 0) {
      setSelectedIdx((i) => Math.min(total - 1, i + 1));
      return;
    }
    if (key.return && total > 0) {
      const row = lists.flat[selectedIdx];
      if (!row) return;
      // Online + Paused both navigate into the ensemble — paused ensembles
      // are signal-paused but their workflows are alive and the user can
      // run `/play` from inside. Offline requires the full restore path.
      if (row.ensemble.state === 'online' || row.ensemble.state === 'paused') {
        onEnterEnsemble(row.ensemble.name);
      } else if (row.ensemble.state === 'offline') {
        onRestoreEnsemble(row.ensemble.name);
      }
      return;
    }
    if (input === 'n' || input === 'N') { onCreateEnsemble(); return; }
    if (input === 'l' || input === 'L') { onLoadLineup(); return; }
    if (input === 'r' || input === 'R') { void refresh(); return; }
    if (input === 'q' || input === 'Q') { onQuit(); return; }
  }, [lists.flat, selectedIdx, onEnterEnsemble, onRestoreEnsemble, onCreateEnsemble, onLoadLineup, onQuit, refresh]));

  return renderBody({
    Box, Text,
    lists, selectedIdx,
    refreshing, error,
    badges: initial.badges,
    firstRefreshDone,
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────

interface RenderBodyProps {
  Box: React.ComponentType<any>;
  Text: React.ComponentType<any>;
  lists: SortedLists;
  selectedIdx: number;
  refreshing: boolean;
  error: string | null;
  badges: BootstrapBadges;
  firstRefreshDone: boolean;
}

function renderBody(props: RenderBodyProps): React.ReactElement {
  const { Box, Text, lists, selectedIdx, refreshing, error, badges, firstRefreshDone } = props;
  const icons = statusIcons(supportsUnicode());

  const isEmpty = lists.flat.length === 0;
  const header = React.createElement(
    Text,
    { bold: true, color: THEME.accent, key: 'home-header' },
    ' agent-tempo',
  );

  const statusLine = React.createElement(
    Text,
    { key: 'home-status', color: THEME.dim },
    `  N new · L lineup · ↵ enter/restore · r refresh${refreshing ? ' …' : ''} · Q quit`,
  );

  const children: React.ReactElement[] = [header, statusLine, ...renderBadges(Text, badges)];
  if (error) {
    children.push(
      React.createElement(Text, { key: 'home-err', color: THEME.error }, `  refresh failed: ${error}`),
    );
  }

  if (isEmpty) {
    // #306: Until the first refresh completes, show a loading state instead
    // of "No ensembles yet" — bootstrap may pass an empty initial list while
    // discovery is in flight, and flashing the "no ensembles" copy is jarring.
    children.push(
      React.createElement(Box, { key: 'home-empty', marginTop: 1 },
        firstRefreshDone
          ? React.createElement(Text, { color: THEME.dim },
              '  No ensembles yet. Press ',
              React.createElement(Text, { bold: true, color: THEME.text }, 'N'),
              ' to create one, or ',
              React.createElement(Text, { bold: true, color: THEME.text }, 'L'),
              ' to load a lineup.',
            )
          : React.createElement(Text, { color: THEME.dim },
              '  Loading ensembles …',
            ),
      ),
    );
  } else {
    // Three sections in priority order: Online → Paused → Offline.
    // Each section's header is skipped when the section is empty so the
    // landing page stays compact on a fresh ensemble (no "Paused (none)"
    // / "Offline (none)" noise). Cursor offsets must mirror the flat
    // sequence built by `partitionEnsembles`.
    let cursorOffset = 0;

    if (lists.online.length > 0) {
      const start = cursorOffset;
      children.push(
        React.createElement(Box, { key: 'home-online', marginTop: 1, flexDirection: 'column' },
          React.createElement(Text, { bold: true, color: THEME.text }, ' Online'),
          ...lists.online.map((e, i) => renderRow({
            Text, key: `online-${e.name}`, icons,
            ensemble: e,
            selected: (start + i) === selectedIdx,
            isCwdMatch: false,
          })),
        ),
      );
      cursorOffset += lists.online.length;
    }

    if (lists.paused.length > 0) {
      const start = cursorOffset;
      children.push(
        React.createElement(Box, { key: 'home-paused', marginTop: 1, flexDirection: 'column' },
          React.createElement(Text, { bold: true, color: THEME.text }, ' Paused'),
          ...lists.paused.map((e, i) => renderRow({
            Text, key: `paused-${e.name}`, icons,
            ensemble: e,
            selected: (start + i) === selectedIdx,
            isCwdMatch: false,
          })),
        ),
      );
      cursorOffset += lists.paused.length;
    }

    if (lists.offline.length > 0) {
      const start = cursorOffset;
      children.push(
        React.createElement(Box, { key: 'home-offline', marginTop: 1, flexDirection: 'column' },
          React.createElement(Text, { bold: true, color: THEME.text }, ' Offline'),
          ...lists.offline.map((e, i) => renderRow({
            Text, key: `offline-${e.name}`, icons,
            ensemble: e,
            selected: (start + i) === selectedIdx,
            isCwdMatch: i < lists.cwdMatchCount,
          })),
        ),
      );
    }
  }

  return React.createElement(Box, { flexDirection: 'column' }, ...children);
}

interface RenderRowProps {
  Text: React.ComponentType<any>;
  key: string;
  icons: ReturnType<typeof statusIcons>;
  ensemble: EnsembleSummary;
  selected: boolean;
  isCwdMatch: boolean;
}

function renderRow({ Text, key, icons, ensemble, selected, isCwdMatch }: RenderRowProps): React.ReactElement {
  const cursor = selected ? '\u276F' : ' ';
  // Online uses the active glyph; paused + offline both use the stale
  // glyph (no live attachment activity). Color disambiguates: warning
  // for paused (transient, fast resume via /play) vs dim for offline
  // (needs /restore to come back).
  const glyph = ensemble.state === 'online' ? icons.active : icons.stale;
  const glyphColor =
    ensemble.state === 'online' ? THEME.success
    : ensemble.state === 'paused' ? THEME.warning
    : THEME.dim;
  const cwdBadge = isCwdMatch ? '\u2B21 ' : '';
  const playerSuffix = ` (${ensemble.playerCount} player${ensemble.playerCount === 1 ? '' : 's'})`;

  return React.createElement(
    Text,
    { key, color: selected ? THEME.text : THEME.textMuted },
    ` ${cursor} `,
    React.createElement(Text, { color: glyphColor }, `${glyph} `),
    isCwdMatch
      ? React.createElement(Text, { color: THEME.accent, bold: true }, cwdBadge)
      : null,
    React.createElement(Text, { bold: selected, color: selected ? THEME.text : THEME.textMuted }, ensemble.name),
    React.createElement(Text, { color: THEME.dim }, playerSuffix),
  );
}

function renderBadges(Text: React.ComponentType<any>, badges: BootstrapBadges): React.ReactElement[] {
  const parts: React.ReactElement[] = [];
  if (badges.orphanCount > 0) {
    parts.push(React.createElement(Text, { key: 'b-orph', color: THEME.warning },
      `  ${badges.orphanCount} orphan${badges.orphanCount === 1 ? '' : 's'} on this host`));
  }
  if (badges.daemonLogErrors && badges.daemonLogErrors.count > 0) {
    parts.push(React.createElement(Text, { key: 'b-log', color: THEME.error },
      `  daemon log: ${badges.daemonLogErrors.count} recent error${badges.daemonLogErrors.count === 1 ? '' : 's'}`));
  }
  if (badges.outdatedVersion) {
    parts.push(React.createElement(Text, { key: 'b-ver', color: THEME.warning },
      `  upgrade available: v${badges.outdatedVersion.latest} (${badges.outdatedVersion.severity})`));
  }
  return parts;
}
