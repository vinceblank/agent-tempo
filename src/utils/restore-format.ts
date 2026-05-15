/**
 * Shared formatter for the #151 `restore --all-hosts` cluster-view listing.
 *
 * Pure: no Temporal, no I/O, no ANSI colors. Mirrors the
 * `format-hosts.ts` convention so unit tests can pin the rendering
 * without spinning up a Temporal client. Consumed by:
 *   - `src/cli/commands.ts` (`restore` verb's `--all-hosts` branch)
 *
 * Liveness annotation semantics (joined against `listHosts()`):
 *
 *   [live]    — host's daemon is polling now
 *               (`HOST_FRESHNESS_THRESHOLD_MS`, 60s default). Recovery is
 *               imminent on its next reconcile tick — no manual action
 *               needed in most cases.
 *   [stale]   — host has been registered but no poller seen in the last
 *               minute. Probably down; manual `/migrate` from the TUI if
 *               recovery can't wait.
 *   [missing] — host has no registered profile at all (never came back
 *               since boot, or maestro restarted and the profile expired).
 *               Almost certainly safe to deliberately steal.
 *
 * Action edge — for cross-host orphans (NOT for `(local)` ones), the
 * formatter prints the TUI `/migrate` command the operator would run to
 * deliberately steal the session to the local host. The architect's
 * §16.5-Option-B `--yes-steal=<host>` deliberate-action gate isn't on
 * the TUI slash-command yet (separate follow-up); we print the available
 * surface that actually parses today.
 */
import type { HostInfo } from '../types';
import type { RestoreOrphanDetail } from '../reconcile/orphans';

export interface FormatCrossHostOrphansOpts {
  /** Operator's local hostname — sorted first, gets the `(local)` tag. */
  localHost: string;
  /**
   * When set, the operator passed `--ensemble <name>` (narrowing the
   * cluster-view listing). Otherwise the formatter says "every ensemble".
   */
  ensemble?: string;
}

/**
 * Render the `--all-hosts` listing.
 *
 * Pre-condition: `details` are produced by
 * `restoreOrphansOnce(..., { mode: 'all-hosts-readonly' })`. Entries not
 * shaped as `{ kind: 'skipped', reason: 'crossHost' }` are silently
 * filtered out — defensive: the formatter is a final renderer, not a
 * data-shape gatekeeper.
 */
export function formatCrossHostOrphans(
  details: RestoreOrphanDetail[],
  hosts: HostInfo[],
  opts: FormatCrossHostOrphansOpts,
): string {
  const { localHost, ensemble } = opts;
  const scope = ensemble
    ? `ensemble "${ensemble}" across all hosts`
    : 'every ensemble across all hosts';

  // Group orphans by preferredHost (the `detail` field on each crossHost
  // skip — set by `restoreOrphansOnce` to `preferredHost ??
  // lastAdapter.hostname ?? '(unknown)'`).
  const groups = new Map<string, RestoreOrphanDetail[]>();
  for (const d of details) {
    if (d.outcome.kind !== 'skipped' || d.outcome.reason !== 'crossHost') continue;
    const key = d.outcome.detail ?? '(unknown)';
    const bucket = groups.get(key) ?? [];
    bucket.push(d);
    groups.set(key, bucket);
  }

  const totalOrphans = Array.from(groups.values()).reduce((n, g) => n + g.length, 0);
  if (totalOrphans === 0) {
    return `No orphans found (${scope}).`;
  }

  // Stable order: local-host first (its own dormant orphans are the most
  // actionable for the operator), then alphabetical, `(unknown)` last.
  const groupOrder = Array.from(groups.keys()).sort((a, b) => {
    if (a === localHost) return -1;
    if (b === localHost) return 1;
    if (a === '(unknown)') return 1;
    if (b === '(unknown)') return -1;
    return a.localeCompare(b);
  });

  // Build the host lookup once for the liveness join.
  const hostByName = new Map<string, HostInfo>();
  for (const h of hosts) hostByName.set(h.hostname, h);
  const liveness = (preferredHost: string): 'live' | 'stale' | 'missing' => {
    if (preferredHost === '(unknown)') return 'missing';
    const h = hostByName.get(preferredHost);
    if (!h) return 'missing';
    return h.freshness === 'live' ? 'live' : 'stale';
  };

  const lines: string[] = [];
  lines.push(`${totalOrphans} cross-host orphan${totalOrphans === 1 ? '' : 's'} found (${scope}).`);
  lines.push('');
  lines.push('These sessions are reattached automatically when their preferred host returns.');
  lines.push("Below are the manual-takeover commands if a host won't come back.");
  lines.push('');

  for (const host of groupOrder) {
    const orphans = groups.get(host)!;
    const label = liveness(host);
    const isLocal = host === localHost;
    const hostHeading = isLocal
      ? `**${host}** [${label}] (local)`
      : `**${host}** [${label}]`;
    lines.push(hostHeading);

    for (const d of orphans) {
      lines.push(`  - ${d.playerId}   (ensemble: ${d.ensemble})`);
      if (!isLocal && host !== '(unknown)') {
        // Action edge — TUI slash-command form. Architect confirmed (#151
        // dispatch thread) that `--yes-steal=<host>` deliberate-action is
        // a separate follow-up since the CLI `migrate` verb was removed
        // in #288 and the TUI `/migrate` doesn't accept the flag yet.
        lines.push(`      In TUI: /migrate ${d.playerId} ${localHost} --force`);
      } else if (isLocal) {
        lines.push(`      Use \`agent-tempo restore ${d.ensemble}\` (single-ensemble) to reattach.`);
      }
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
