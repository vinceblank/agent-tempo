/**
 * StatusBar — persistent one-line status summary.
 * Renders as a SINGLE Text element (1 Yoga node). Nested Text = ink-virtual-text (0 nodes).
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { MaestroPlayerInfo } from '../../types';
import { phaseToLabel, filterRealPlayers } from '../utils/format';

export interface StatusBarProps {
  ensemble: string | null;
  players: MaestroPlayerInfo[];
  /** True after the first player poll completes. False = still loading. */
  playersLoaded: boolean;
  scheduleCount: number;
  connected: boolean;
  conductorName?: string;
  /**
   * Bug B: Whether the active ensemble's maestro hub is paused. Drives a
   * yellow "paused" segment so users see why a conductor is silently
   * swallowing typed messages (the session-level `paused` flag gates the
   * outbox dispatcher).
   */
  ensemblePaused?: boolean;
  /**
   * #306 follow-up: Whether at least one session in the active ensemble
   * has its outbox locked (`held`). Drives a yellow "held" segment.
   * Independent of `ensemblePaused` because `/load_lineup` flips both
   * flags at once but `/play` only clears pause — users would otherwise
   * see "no paused indicator" and assume the ensemble is fully resumed
   * when held players were still frozen behind the locked outbox.
   */
  ensembleHeld?: boolean;
}

/**
 * One rendered text segment of the status bar. Returned by
 * {@link buildStatusBarSegments} so tests can inspect the bar's contents
 * without spinning up Ink. Each segment becomes a nested ink-virtual-text
 * inside the single outer Text element.
 */
export interface StatusBarSegment {
  key: string;
  color: string;
  text: string;
}

/**
 * Pure helper: compute the StatusBar's segment list from props. Keeps the
 * render-path logic testable without an Ink context. The component below
 * just maps each segment to a `<Text>` element.
 */
export function buildStatusBarSegments(props: StatusBarProps): StatusBarSegment[] {
  const { ensemble, players, playersLoaded, scheduleCount, connected, conductorName, ensemblePaused, ensembleHeld } = props;

  const healthColor = connected ? THEME.success : THEME.error;
  const healthDot = connected ? '●' : '○';
  const healthLabel = connected ? 'Connected' : 'Disconnected';

  const ensembleLabel = ensemble || 'no ensemble';

  const segments: StatusBarSegment[] = [
    { key: 'lead', color: THEME.dim, text: ' ' },
    { key: 'ens', color: ensemble ? THEME.accent : THEME.dim, text: ensembleLabel },
    { key: 's1', color: THEME.dim, text: ' · ' },
  ];

  if (ensemble && !playersLoaded) {
    // Still loading — don't show incorrect counts
    segments.push({ key: 'pl', color: THEME.dim, text: 'Loading...' });
  } else {
    // Exclude the maestro session from headline counts — it is the TUI's own
    // dashboard attachment, not a peer agent. The full list (including the
    // maestro) is still surfaced in `/players` and the status overlay so the
    // user can see internal state honestly.
    const realPlayers = filterRealPlayers(players);

    // Player breakdown by phase label (Option-B five buckets collapsed to four
    // meaningful ones for the bar — `gone` players are terminal and not
    // shown in the ensemble list).
    let active = 0;
    let idle = 0;
    let disconnected = 0;
    let pending = 0;
    for (const p of realPlayers) {
      switch (phaseToLabel(p.phase)) {
        case 'active':       active++; break;
        case 'idle':         idle++; break;
        case 'disconnected': disconnected++; break;
        case 'pending':      pending++; break;
        // 'gone' / 'unknown' intentionally not counted in the summary line.
      }
    }

    const parts: string[] = [];
    if (active > 0)       parts.push(`${active} active`);
    if (idle > 0)         parts.push(`${idle} idle`);
    if (disconnected > 0) parts.push(`${disconnected} disconnected`);
    if (pending > 0)      parts.push(`${pending} pending`);
    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    const playerLabel = `${realPlayers.length} player${realPlayers.length !== 1 ? 's' : ''}${breakdown}`;

    segments.push({ key: 'pl', color: THEME.dim, text: playerLabel });

    if (scheduleCount > 0) {
      segments.push(
        { key: 's2', color: THEME.dim, text: ' · ' },
        { key: 'sc', color: THEME.dim, text: `${scheduleCount} schedule${scheduleCount !== 1 ? 's' : ''}` },
      );
    }

    // Bug B + #306 follow-up: yellow `paused`/`held`/`paused + held` segment
    // when the maestro hub is paused or any session has its outbox locked
    // (or both — `/load_lineup` flips both flags at once). Placed before
    // the "No conductor" warning so the most actionable state reads first
    // when both apply. The same guard (`ensemble && …`) keeps the segment
    // off the home view.
    //
    // Combined-glyph variant for paused + held picks `⏸⊕ paused + held`
    // over two separate segments — scans cleaner at terminal density and
    // lets the matching tip below the input ("Tip: type /play to unpause
    // + /go to release held players.") read as one instruction.
    if (ensemble && (ensemblePaused || ensembleHeld)) {
      let label: string;
      if (ensemblePaused && ensembleHeld) {
        label = '⏸⊕ paused + held';
      } else if (ensemblePaused) {
        // U+23F8 PAUSE SYMBOL — single glyph, mirrors the U+26A0 warning below.
        label = '⏸ paused';
      } else {
        // U+2295 CIRCLED PLUS — distinct from pause, suggests "more buffered".
        label = '⊕ held';
      }
      segments.push(
        { key: 'sp', color: THEME.dim, text: ' · ' },
        { key: 'pa', color: THEME.warning, text: label },
      );
    }

    if (ensemble && !conductorName) {
      segments.push(
        { key: 's3', color: THEME.dim, text: ' · ' },
        { key: 'nc', color: THEME.warning, text: '⚠ No conductor' },
      );
    }
  }

  segments.push(
    { key: 's4', color: THEME.dim, text: ' · ' },
    { key: 'hd', color: healthColor, text: healthDot },
    { key: 'hl', color: THEME.dim, text: ` ${healthLabel}` },
  );

  return segments;
}

export function StatusBar(props: StatusBarProps) {
  const { Text } = useInk();
  const segments = buildStatusBarSegments(props);
  // Single Text element — all children are ink-virtual-text (0 Yoga nodes)
  const children = segments.map((s) =>
    s.key === 'lead'
      ? s.text
      : React.createElement(Text, { key: s.key, color: s.color }, s.text),
  );
  return React.createElement(Text, null, ...children);
}
