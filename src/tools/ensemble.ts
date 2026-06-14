import { z } from 'zod';
import { Client } from '@temporalio/client';
import * as os from 'os';
import { Config } from '../config';
import { SessionMetadata, AttachmentPhase } from '../types';
import { scanEnsembleSessionsWithStatus, type EnsembleSessionInfo } from '../activities/resolve';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { formatTimeAgo } from '../utils/duration';
import { checkSuspension, formatSuspensionBanner } from '../utils/suspension';
import { VISIBILITY_DEADLINES_MS } from '../utils/visibility-deadline';

/**
 * Default dormancy threshold (1 hour). Per #563: a `detached` player whose
 * last activity is older than this is considered dormant. `phase === 'gone'`
 * is dormant regardless of timestamp.
 */
export const DORMANT_THRESHOLD_MS = 60 * 60 * 1000;

/** Filter mode for the `dormant` arg on the `ensemble` MCP tool. */
export type DormantFilter = 'show' | 'hide' | 'show-only';

/**
 * Classify a session as `'active'` or `'dormant'` per the #563 rules.
 *
 * - `phase === 'gone'` → always dormant.
 * - `phase === 'detached'` AND `lastActivityAt` older than `thresholdMs`
 *   → dormant.
 * - `phase === 'detached'` AND `lastActivityAt` missing → dormant. (Pre-W2
 *   sessions don't carry the timestamp; operator intent is to declutter
 *   the active list, so we err toward grouping these with the cruft. The
 *   default `--dormant=show` still shows them, just in their own section.)
 * - Otherwise → active. Includes `awaiting` (live attachment), `processing`,
 *   `attached`, `booting`, `draining`, and the undefined-phase case (older
 *   workflows that predate the attachment lifecycle).
 *
 * Pure function — injectable `now` keeps it deterministic under test.
 *
 * Exported for unit testing.
 */
export function classifyDormancy(
  session: Pick<EnsembleSessionInfo, 'phase' | 'lastActivityAt'>,
  now: number,
  thresholdMs: number = DORMANT_THRESHOLD_MS,
): 'active' | 'dormant' {
  if (session.phase === 'gone') return 'dormant';
  if (session.phase === 'detached') {
    if (!session.lastActivityAt) return 'dormant';
    const lastMs = Date.parse(session.lastActivityAt);
    if (!Number.isFinite(lastMs)) return 'dormant';
    if (now - lastMs > thresholdMs) return 'dormant';
  }
  return 'active';
}

export function buildEnsembleTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
  ownWorkflowId: string,
): TempoToolDescriptor {
  return {
    name: 'ensemble',
    description: `Discover active Claude Code sessions in the "${config.ensemble}" ensemble. Returns player IDs, descriptions, and metadata. NOTE: returns tempo-registered players only — does NOT include Claude Code Agent-tool sub-agents (spawned via the Agent tool / subagent_type). Those are ephemeral and process-local; call TaskList separately to enumerate them. Tempo players are addressable via cue; Agent-tool sub-agents are not.`,
    params: {
      scope: z.string().optional().describe('Filter scope: "machine" (same hostname), "repo" (same git root), "all" (default). All scopes are within the current ensemble.'),
      // #563: dormancy filter. Default `show` preserves the pre-#563 listing
      // (everything visible) but groups gone/long-detached players into a
      // separate "Dormant" section. `hide` suppresses dormant entries
      // entirely; `show-only` is the inverse, useful for cleanup workflows.
      dormant: z.enum(['show', 'hide', 'show-only']).optional().describe('Dormancy filter: "show" (default — group dormant in a separate section), "hide" (suppress dormant entries), "show-only" (only show dormant). A player is dormant when phase=gone, or phase=detached with no activity in the last hour.'),
    },
    handler: async (args) => {
      const scope = (args.scope ?? 'all') as 'machine' | 'repo' | 'all';
      const dormantFilter = (args.dormant ?? 'show') as DormantFilter;

      // #752: suspension banner pre-flight (ensemble paused + own
      // paused/held), concurrent with the session scan. Soft-fails to
      // "not suspended" — the listing never breaks on a missing maestro hub.
      const suspensionPromise = checkSuspension(client, config.ensemble, {
        self: client.workflow.getHandle(ownWorkflowId),
      });

      let sessions: EnsembleSessionInfo[];
      let truncated = false;
      try {
        const scan = await scanEnsembleSessionsWithStatus(client, config.ensemble);
        sessions = scan.sessions;
        truncated = scan.truncated;
      } catch (err) {
        return fail(`Error listing workflows: ${formatError(err)}`);
      }

      // #845 Mode A — when the visibility scan hit its wall-clock deadline,
      // `sessions` is a PARTIAL roster. Surface that explicitly so an
      // operator never mistakes a mid-scan snapshot for the full ensemble
      // (the incident: a 3/8 roster read as "5 players vanished").
      const partialBanner = truncated
        ? `⚠ partial roster — ${sessions.length} shown; visibility scan hit its ` +
          `${Math.round(VISIBILITY_DEADLINES_MS.scanEnsembleSessions / 1000)}s deadline ` +
          `(likely worker warmup) — re-run to refresh.`
        : undefined;

      // Apply scope filters
      let ownGitRoot: string | undefined;
      if (scope === 'repo') {
        try {
          const ownHandle = client.workflow.getHandle(ownWorkflowId);
          const ownMeta: SessionMetadata = await ownHandle.query('getMetadata');
          ownGitRoot = ownMeta.gitRoot;
        } catch {
          // Can't determine own git root — skip repo filtering
        }
      }

      const scoped = sessions.filter((s) => {
        if (scope === 'machine' && s.hostname !== os.hostname()) return false;
        if (scope === 'repo' && ownGitRoot && s.gitRoot !== ownGitRoot) return false;
        return true;
      });

      const now = Date.now();
      const enriched = scoped.map((s) => ({
        ...s,
        isYou: s.playerId === getPlayerId(),
        dormancy: classifyDormancy(s, now),
      }));

      const active = enriched.filter((p) => p.dormancy === 'active');
      const dormant = enriched.filter((p) => p.dormancy === 'dormant');

      // #752: PAUSED/HELD banner leads the output so it can't be missed.
      const banner = formatSuspensionBanner(await suspensionPromise, config.ensemble);

      if (active.length === 0 && dormant.length === 0) {
        // #845 CRITICAL: check truncation FIRST. A truncated scan that
        // yielded zero rows must NOT render as "No active sessions found" —
        // false-empty is the most dangerous case (an operator concludes the
        // whole ensemble died and takes destructive action). Surface the
        // partial banner instead.
        if (partialBanner) {
          return ok([banner, partialBanner].filter(Boolean).join('\n\n'));
        }
        return ok(banner ? `${banner}\n\nNo active sessions found.` : 'No active sessions found.');
      }

      // #563 summary line — surface both counts so operators can see what's
      // being hidden behind the dormant filter without re-running.
      const summary = `**${config.ensemble}**: ${active.length} active, ${dormant.length} dormant`;
      // Lead banners (suspension #752 + partial-roster #845) precede the
      // summary so neither can be missed above the roster.
      const sections: string[] = [
        ...[banner, partialBanner].filter(Boolean) as string[],
        summary,
      ];

      const showActive = dormantFilter !== 'show-only';
      const showDormant = dormantFilter !== 'hide';

      if (showActive) {
        if (active.length > 0) {
          sections.push(`\n=== Active (${active.length}) ===\n`);
          sections.push(active.map((p) => renderPlayerLine(p, now, false)).join('\n\n'));
        } else {
          sections.push('\n=== Active (0) ===\n(none)');
        }
      }

      if (showDormant && dormant.length > 0) {
        sections.push(`\n=== Dormant (${dormant.length}) — last seen >1h ago or gone ===\n`);
        sections.push(dormant.map((p) => renderPlayerLine(p, now, true)).join('\n\n'));
      }

      return ok(sections.join('\n'));
    },
  };
}

/**
 * Render one player as the multi-line block historically emitted by
 * `ensemble`. Dormant entries append a "last seen X ago" line so operators
 * can gauge staleness without a second tool call.
 *
 * Kept private — the renderer's exact text is the tool's UI surface, not a
 * stable API; the test exercises classification + the structural split, not
 * line-by-line formatting.
 */
function renderPlayerLine(
  p: EnsembleSessionInfo & { isYou: boolean; dormancy: 'active' | 'dormant' },
  now: number,
  isDormant: boolean,
): string {
  const tags = [
    p.isYou ? '(you)' : '',
    p.isConductor ? '(conductor)' : '',
    p.agentType === 'copilot' ? '[copilot]' : '',
    phaseTag(p.phase),
  ].filter(Boolean).join(' ');

  const nameDisplay = p.playerType
    ? `**${p.playerId}** (${p.playerType})`
    : `**${p.playerId}**`;

  const lines = [
    `${nameDisplay} ${tags}`.trim(),
    `  Part: ${p.part}`,
    `  Dir: ${p.workDir}`,
    p.gitBranch ? `  Branch: ${p.gitBranch}` : '',
    `  Host: ${p.hostname}`,
  ];

  if (isDormant && p.lastActivityAt) {
    lines.push(`  Last seen: ${formatTimeAgo(p.lastActivityAt, now)}`);
  }

  return lines.filter(Boolean).join('\n');
}

/**
 * Option-B phase → tag mapping (see #176 PR):
 *   booting → (pending); attached/processing/awaiting → no tag;
 *   draining/detached → (disconnected); gone → (gone).
 * #203: typed as AttachmentPhase (callers always have the typed phase
 * in hand via EnsembleSessionInfo.phase); `string` lost enum discipline.
 */
function phaseTag(phase: AttachmentPhase | undefined): string {
  if (phase === 'booting') return '(pending)';
  if (phase === 'draining' || phase === 'detached') return '(disconnected)';
  if (phase === 'gone') return '(gone)';
  return '';
}
