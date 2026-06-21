/**
 * Bare-command home (E.8, #789) — what `agent-tempo` with no verb does now
 * that the Ink TUI is gone: run the #289 six-step auto-provisioning
 * bootstrap, then print a STATUS snapshot + contextual next-step hints and
 * exit. No alternate screen, no event loop — the live operator surfaces are
 * mission-control (`agent-tempo command-center`, when the Pi seat is
 * available) and the zero-dependency web dashboard.
 *
 * `renderHome` is PURE (BootstrapResult + flags → lines) so the hint logic
 * unit-tests without a daemon, npm, or Pi install.
 */
import * as os from 'os';
import * as out from './output';
import { PI_NODE_FLOOR, PI_PACKAGE } from '../pi/probe';
import type { BootstrapResult, StepName, StepOutcome } from './startup';

/** Friendly labels for the six bootstrap steps (+ migration pre-step). */
const STEP_LABELS: Record<StepName, string> = {
  legacyHomeMigration: 'legacy home migration',
  preflight: 'preflight',
  mcpConfig: 'MCP registration',
  temporalReach: 'Temporal reachability',
  searchAttrs: 'search attributes',
  daemonBoot: 'daemon',
  badgeCollection: 'badges',
};

const STEP_GLYPH: Record<StepOutcome['status'], string> = {
  ok: '✓',
  skipped: '·',
  'action-taken': '＋',
  failed: '✗',
};

export interface RenderHomeOpts {
  /** Whether the Pi operator seat is installed (drives the command-center hint). */
  piAvailable: boolean;
  /** This binary's version (header line). */
  version: string;
  /** Hostname for the header (injectable for tests). */
  hostname?: string;
}

/**
 * Pure renderer: BootstrapResult → status lines + next-step hints. `result`
 * may be undefined when bootstrap threw outside its step boundaries — the
 * home still renders with a degraded note (mirrors the old TUI's tolerance).
 */
export function renderHome(result: BootstrapResult | undefined, opts: RenderHomeOpts): string[] {
  const lines: string[] = [];
  const host = opts.hostname ?? os.hostname();
  lines.push(`agent-tempo v${opts.version} — ${host}`);
  lines.push('');

  // ── Bootstrap status (one line per non-quiet step) ──
  if (result) {
    const parts: string[] = [];
    for (const [step, outcome] of Object.entries(result.steps) as [StepName, StepOutcome][]) {
      if (outcome.status === 'skipped' || outcome.status === 'ok') continue; // quiet steady state
      parts.push(`${STEP_GLYPH[outcome.status]} ${STEP_LABELS[step]}${outcome.detail ? ` (${outcome.detail})` : ''}`);
    }
    lines.push(parts.length === 0
      ? `bootstrap ✓ all steps healthy (${result.durationMs}ms)`
      : `bootstrap: ${parts.join(' · ')}`);

    // ── Badges ──
    const b = result.badges;
    if (b.orphanCount > 0) {
      lines.push(`⚠ ${b.orphanCount} orphaned session${b.orphanCount === 1 ? '' : 's'} on this host — \`agent-tempo restore\` to re-attach`);
    }
    if (b.daemonLogErrors) {
      lines.push(`⚠ ${b.daemonLogErrors.count} recent daemon-log error${b.daemonLogErrors.count === 1 ? '' : 's'} — see ${b.daemonLogErrors.logPath}`);
    }
    if (b.outdatedVersion) {
      lines.push(`↑ v${b.outdatedVersion.latest} available (${b.outdatedVersion.severity}) — \`agent-tempo upgrade\``);
    }

    // ── Ensembles ──
    lines.push('');
    if (result.ensembles.length === 0) {
      lines.push('No ensembles running.');
    } else {
      lines.push(`Ensembles (${result.ensembles.length}):`);
      for (const e of result.ensembles) {
        const state = e.state ? ` — ${e.state}` : '';
        lines.push(`  ${e.name}: ${e.playerCount} player${e.playerCount === 1 ? '' : 's'}${e.hasConductor ? '' : ', no conductor'}${state}`);
      }
    }
  } else {
    lines.push('bootstrap unavailable — run `agent-tempo daemon status` to diagnose.');
    lines.push('');
  }

  // ── Next steps (contextual) ──
  lines.push('');
  lines.push('Next steps:');
  const hasEnsembles = (result?.ensembles.length ?? 0) > 0;
  if (!hasEnsembles) {
    lines.push('  agent-tempo up                  start an ensemble here (--lineup <name> for a preset)');
  }
  if (opts.piAvailable) {
    const desc = hasEnsembles
      ? 'live board + operator seat (Pi)'
      : 'operator seat once an ensemble is up (Pi)';
    lines.push(`  agent-tempo command-center      ${desc}`);
  }
  lines.push('  agent-tempo dashboard           web dashboard (zero-dependency fallback)');
  if (hasEnsembles) {
    lines.push('  agent-tempo status <ensemble>   one-shot ensemble detail');
  }
  if (!opts.piAvailable) {
    lines.push(`  npm install -g ${PI_PACKAGE}   unlock the command-center seat (Node ≥ ${PI_NODE_FLOOR})`);
  }
  return lines;
}

/**
 * The `home` (bare-command) handler: bootstrap → render → exit. Bootstrap is
 * best-effort exactly as the TUI treated it — a throw outside step
 * boundaries degrades to the no-result rendering, never a crash.
 */
export async function runHome(opts: {
  /** `null` = bootstrap skipped (`--skip-preflight`) — render the degraded home. */
  bootstrap: (() => Promise<BootstrapResult>) | null;
  piAvailable: boolean;
  version: string;
}): Promise<void> {
  let result: BootstrapResult | undefined;
  if (opts.bootstrap) {
    try {
      result = await opts.bootstrap();
    } catch (err) {
      out.warn(`Bootstrap hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const line of renderHome(result, { piAvailable: opts.piAvailable, version: opts.version })) {
    out.log(line);
  }
}
